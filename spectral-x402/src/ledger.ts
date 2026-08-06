/**
 * ledger.ts — durable payment ledger. The only source of truth about money.
 *
 * Invariants enforced in SQL, not by convention:
 *   - one paymentId binds to exactly one requestFingerprint (409 source)
 *   - at most one live lease per (call, kind)
 *   - the result is committed BEFORE the call may enter `settling`
 *   - a successful receipt is committed BEFORE the call may enter `settled`
 *   - delivery requires the stored result AND a matching receipt
 *   - state transitions are monotonic except explicitly-recorded recovery edges
 *
 * synchronous=FULL because the commit that must never be lost is the receipt
 * commit: settled money with no receipt is the one unrecoverable state.
 */
import Database from "better-sqlite3";
import { chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";

export type CallState =
  | "challenged"
  | "payment_present"
  | "verified"
  | "executing"
  | "execution_unknown"
  | "executed"
  | "settling"
  | "settlement_unknown"
  | "settled"
  | "delivered"
  | "execution_failed"
  | "settlement_rejected";

/** from → to, and whether the edge is a recovery transition (audited as such). */
const TRANSITIONS: Array<[CallState, CallState, boolean]> = [
  ["challenged", "payment_present", false],
  ["payment_present", "verified", false],
  ["payment_present", "execution_failed", false],
  ["verified", "executing", false],
  ["executing", "executed", false],
  ["executing", "execution_failed", false],
  ["executing", "execution_unknown", true],
  ["execution_unknown", "executing", true],
  ["executed", "settling", false],
  ["settling", "settled", false],
  ["settling", "settlement_rejected", false],
  ["settling", "settlement_unknown", true],
  ["settlement_unknown", "settled", true],
  ["settlement_unknown", "settlement_rejected", true],
  ["settled", "delivered", false],
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS runtime_boot (
  boot_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, pid INTEGER NOT NULL,
  kernel_version TEXT NOT NULL, generated_lock_digest TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mounts (
  mount_id TEXT PRIMARY KEY, capability_version TEXT NOT NULL,
  adapter_version TEXT NOT NULL, substrate_pack_id TEXT NOT NULL,
  substrate_merkle_root TEXT NOT NULL, fingerprint_version TEXT NOT NULL,
  admitted_at INTEGER NOT NULL, boot_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY,
  mount_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  fingerprint_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'challenged','payment_present','verified','executing','execution_unknown',
    'executed','settling','settlement_unknown','settled','delivered',
    'execution_failed','settlement_rejected')),
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  result_purged_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_calls_payment ON calls(payment_id);
CREATE INDEX IF NOT EXISTS idx_calls_state ON calls(state, created_at);
CREATE INDEX IF NOT EXISTS idx_calls_fp ON calls(request_fingerprint);

-- The 409 source and the concurrency primitive. One paymentId, one purchase.
CREATE TABLE IF NOT EXISTS payment_bindings (
  payment_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL,
  fingerprint_version TEXT NOT NULL,
  call_id TEXT NOT NULL UNIQUE,
  bound_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS authorizations (
  call_id TEXT NOT NULL, authorization_fingerprint TEXT NOT NULL,
  payer TEXT, nonce_digest TEXT NOT NULL, expires_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (call_id, authorization_fingerprint)
);

CREATE TABLE IF NOT EXISTS state_transitions_allowed (
  from_state TEXT NOT NULL, to_state TEXT NOT NULL,
  requires_recovery INTEGER NOT NULL, PRIMARY KEY (from_state, to_state)
);

-- Append-only. Never purged, even when result bytes are.
CREATE TABLE IF NOT EXISTS call_states (
  call_id TEXT NOT NULL, seq INTEGER NOT NULL,
  from_state TEXT, to_state TEXT NOT NULL, at INTEGER NOT NULL,
  actor TEXT NOT NULL, reason_code TEXT, recovery INTEGER NOT NULL DEFAULT 0,
  boot_id TEXT NOT NULL, PRIMARY KEY (call_id, seq)
);

CREATE TABLE IF NOT EXISTS leases (
  call_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('execute','settle')),
  lease_id TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  holder_pid INTEGER NOT NULL, holder_boot_id TEXT NOT NULL,
  PRIMARY KEY (call_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_leases_exp ON leases(expires_at);

CREATE TABLE IF NOT EXISTS results (
  call_id TEXT PRIMARY KEY, request_fingerprint TEXT NOT NULL,
  fingerprint_version TEXT NOT NULL, result_digest TEXT NOT NULL,
  result_bytes BLOB, byte_len INTEGER NOT NULL, produced_at INTEGER NOT NULL,
  adapter_version TEXT NOT NULL, substrate_pack_id TEXT NOT NULL,
  substrate_merkle_root TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/json',
  UNIQUE (call_id, request_fingerprint)
);

CREATE TABLE IF NOT EXISTS settlement_attempts (
  call_id TEXT NOT NULL, attempt_no INTEGER NOT NULL,
  authorization_fingerprint TEXT NOT NULL, facilitator_id TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','rejected','unknown')),
  PRIMARY KEY (call_id, attempt_no)
);

-- Never purged. A receipt is the proof money moved.
CREATE TABLE IF NOT EXISTS receipts (
  receipt_id TEXT PRIMARY KEY, call_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL, authorization_fingerprint TEXT NOT NULL,
  attempt_no INTEGER NOT NULL, success INTEGER NOT NULL,
  txn TEXT, network TEXT, asset TEXT, amount_atomic TEXT,
  payer TEXT, pay_to TEXT, facilitator_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL, receipt_json_digest TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipt_success ON receipts(call_id) WHERE success = 1;
CREATE INDEX IF NOT EXISTS idx_receipt_txn ON receipts(txn);

CREATE TABLE IF NOT EXISTS quarantine (
  call_id TEXT PRIMARY KEY, opened_at INTEGER NOT NULL, reason_code TEXT NOT NULL,
  resolved_at INTEGER, resolution TEXT
);

CREATE TABLE IF NOT EXISTS evidence (
  evidence_id TEXT PRIMARY KEY, call_id TEXT NOT NULL, kind TEXT NOT NULL,
  source TEXT NOT NULL, payload_digest TEXT NOT NULL, payload TEXT NOT NULL,
  attached_at INTEGER NOT NULL, actor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entitlements (
  call_id TEXT PRIMARY KEY, base_expires_at INTEGER NOT NULL,
  extended_expires_at INTEGER, stopped_seconds INTEGER NOT NULL DEFAULT 0,
  reason TEXT, actor TEXT
);

CREATE TABLE IF NOT EXISTS make_good (
  grant_id TEXT PRIMARY KEY, subject_kind TEXT NOT NULL, subject TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL, expires_at INTEGER NOT NULL,
  burned_at INTEGER, burned_call_id TEXT, actor TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_makegood_live ON make_good(subject, request_fingerprint)
  WHERE burned_at IS NULL;

CREATE TABLE IF NOT EXISTS delivery_log (
  call_id TEXT NOT NULL, seq INTEGER NOT NULL, delivered_at INTEGER NOT NULL,
  byte_len INTEGER NOT NULL, transport TEXT NOT NULL, PRIMARY KEY (call_id, seq)
);

CREATE TABLE IF NOT EXISTS ops_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, request_digest TEXT NOT NULL, outcome TEXT,
  signature_digest TEXT
);

CREATE TABLE IF NOT EXISTS challenge_counters (
  mount_id TEXT NOT NULL, day TEXT NOT NULL, bucket TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (mount_id, day, bucket)
);

CREATE TABLE IF NOT EXISTS value_ledger (
  day TEXT PRIMARY KEY, settled_atomic TEXT NOT NULL DEFAULT '0',
  call_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS revocation_cache (
  list_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, next_update INTEGER NOT NULL,
  signature_digest TEXT NOT NULL, fetched_at INTEGER NOT NULL, body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS denied_payers (
  payer TEXT PRIMARY KEY, added_at INTEGER NOT NULL, actor TEXT NOT NULL, reason_code TEXT NOT NULL
);
`;

export class LedgerRefusal extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "LedgerRefusal";
  }
}

export interface CallRow {
  call_id: string;
  mount_id: string;
  operation_id: string;
  payment_id: string;
  request_fingerprint: string;
  fingerprint_version: string;
  state: CallState;
  created_at: number;
  settled_at: number | null;
  attempt_count: number;
}

export interface ReceiptInput {
  authorizationFingerprint: string;
  attemptNo: number;
  txn: string | null;
  network: string;
  asset: string;
  amountAtomic: string;
  payer: string | null;
  payTo: string;
  facilitatorId: string;
  receiptJson: string;
  receiptJsonDigest: string;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class Ledger {
  readonly db: Database.Database;
  readonly bootId: string;
  private now: () => number;

  constructor(pathOrMemory: string, opts: { kernelVersion: string; lockDigest: string; now?: () => number }) {
    this.db = new Database(pathOrMemory);
    // The ledger holds protected result bytes, settlement receipts and payer
    // addresses. Default 0644 makes all of that world-readable on a shared
    // machine; 0600 is the only defensible mode for it.
    if (pathOrMemory !== ":memory:") {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          chmodSync(pathOrMemory + suffix, 0o600);
        } catch {
          /* -wal/-shm may not exist yet; the main file is what matters */
        }
      }
    }
    this.now = opts.now ?? (() => Date.now());
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("trusted_schema = OFF");
    this.db.exec(SCHEMA);

    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO state_transitions_allowed (from_state,to_state,requires_recovery) VALUES (?,?,?)"
    );
    this.db.transaction(() => {
      for (const [f, t, rec] of TRANSITIONS) ins.run(f, t, rec ? 1 : 0);
      if (!this.db.prepare("SELECT 1 FROM schema_meta").get()) {
        this.db.prepare("INSERT INTO schema_meta (version) VALUES (1)").run();
      }
    })();

    this.bootId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO runtime_boot (boot_id,started_at,pid,kernel_version,generated_lock_digest) VALUES (?,?,?,?,?)"
      )
      .run(this.bootId, this.now(), process.pid, opts.kernelVersion, opts.lockDigest);
  }

  close(): void {
    this.db.close();
  }

  private assertTransitionAllowed(from: CallState, to: CallState): boolean {
    const row = this.db
      .prepare("SELECT requires_recovery FROM state_transitions_allowed WHERE from_state=? AND to_state=?")
      .get(from, to) as { requires_recovery: number } | undefined;
    if (!row) {
      throw new LedgerRefusal("ILLEGAL_TRANSITION", `${from} → ${to} is not a permitted transition`);
    }
    return row.requires_recovery === 1;
  }

  private recordTransition(
    callId: string,
    from: CallState | null,
    to: CallState,
    actor: string,
    reasonCode: string | null,
    recovery: boolean
  ): void {
    const seq =
      ((this.db.prepare("SELECT MAX(seq) m FROM call_states WHERE call_id=?").get(callId) as { m: number | null }).m ??
        0) + 1;
    this.db
      .prepare(
        "INSERT INTO call_states (call_id,seq,from_state,to_state,at,actor,reason_code,recovery,boot_id) VALUES (?,?,?,?,?,?,?,?,?)"
      )
      .run(callId, seq, from, to, this.now(), actor, reasonCode, recovery ? 1 : 0, this.bootId);
  }

  getCall(callId: string): CallRow | undefined {
    return this.db.prepare("SELECT * FROM calls WHERE call_id=?").get(callId) as CallRow | undefined;
  }

  /** Binding lookup — the pre-payment admission decision. */
  findBinding(paymentId: string): { call: CallRow; requestFingerprint: string } | undefined {
    const b = this.db.prepare("SELECT * FROM payment_bindings WHERE payment_id=?").get(paymentId) as
      | { call_id: string; request_fingerprint: string }
      | undefined;
    if (!b) return undefined;
    const call = this.getCall(b.call_id);
    if (!call) return undefined;
    return { call, requestFingerprint: b.request_fingerprint };
  }

  registerMount(m: {
    mountId: string;
    capabilityVersion: string;
    adapterVersion: string;
    packId: string;
    merkleRoot: string;
    fingerprintVersion: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO mounts (mount_id,capability_version,adapter_version,substrate_pack_id,
         substrate_merkle_root,fingerprint_version,admitted_at,boot_id)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(mount_id) DO UPDATE SET capability_version=excluded.capability_version,
           adapter_version=excluded.adapter_version, substrate_pack_id=excluded.substrate_pack_id,
           substrate_merkle_root=excluded.substrate_merkle_root,
           fingerprint_version=excluded.fingerprint_version, admitted_at=excluded.admitted_at,
           boot_id=excluded.boot_id`
      )
      .run(
        m.mountId,
        m.capabilityVersion,
        m.adapterVersion,
        m.packId,
        m.merkleRoot,
        m.fingerprintVersion,
        this.now(),
        this.bootId
      );
  }

  /**
   * Bind a paymentId to a request fingerprint, creating the call.
   * The PRIMARY KEY on payment_id is what makes concurrent duplicate
   * requests resolve to exactly one call — the race is decided by SQLite,
   * not by application logic.
   */
  openCall(args: {
    mountId: string;
    operationId: string;
    paymentId: string;
    requestFingerprint: string;
    fingerprintVersion: string;
    initialState: Extract<CallState, "challenged" | "payment_present">;
  }): { call: CallRow; created: boolean; conflict: boolean } {
    const existing = this.findBinding(args.paymentId);
    if (existing) {
      return {
        call: existing.call,
        created: false,
        conflict: existing.requestFingerprint !== args.requestFingerprint,
      };
    }
    const callId = randomUUID();
    const t = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO calls (call_id,mount_id,operation_id,payment_id,request_fingerprint,
           fingerprint_version,state,created_at) VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(
          callId,
          args.mountId,
          args.operationId,
          args.paymentId,
          args.requestFingerprint,
          args.fingerprintVersion,
          args.initialState,
          this.now()
        );
      this.db
        .prepare(
          "INSERT INTO payment_bindings (payment_id,request_fingerprint,fingerprint_version,call_id,bound_at) VALUES (?,?,?,?,?)"
        )
        .run(args.paymentId, args.requestFingerprint, args.fingerprintVersion, callId, this.now());
      this.recordTransition(callId, null, args.initialState, "kernel", null, false);
    });
    try {
      t.immediate();
    } catch (e) {
      // Lost the race — another request bound this paymentId first.
      const raced = this.findBinding(args.paymentId);
      if (raced) {
        return { call: raced.call, created: false, conflict: raced.requestFingerprint !== args.requestFingerprint };
      }
      throw e;
    }
    return { call: this.getCall(callId)!, created: true, conflict: false };
  }

  /** Guarded state move. Returns false if the call was not in `from`. */
  transition(
    callId: string,
    from: CallState,
    to: CallState,
    actor = "kernel",
    reasonCode: string | null = null
  ): boolean {
    const recovery = this.assertTransitionAllowed(from, to);
    const t = this.db.transaction(() => {
      const info = this.db.prepare("UPDATE calls SET state=? WHERE call_id=? AND state=?").run(to, callId, from);
      if (info.changes !== 1) return false;
      this.recordTransition(callId, from, to, actor, reasonCode, recovery);
      return true;
    });
    return t.immediate() as boolean;
  }

  recordAuthorization(callId: string, a: { fingerprint: string; payer: string | null; nonceDigest: string; expiresAt: number | null }): number {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO authorizations (call_id,authorization_fingerprint,payer,nonce_digest,expires_at,first_seen_at)
         VALUES (?,?,?,?,?,?)`
      )
      .run(callId, a.fingerprint, a.payer, a.nonceDigest, a.expiresAt, this.now());
    return (
      this.db.prepare("SELECT COUNT(*) c FROM authorizations WHERE call_id=?").get(callId) as { c: number }
    ).c;
  }

  /** Acquire a lease. Returns null when a live lease is already held (→ 202). */
  acquireLease(callId: string, kind: "execute" | "settle", ttlMs: number): string | null {
    const leaseId = randomUUID();
    const t = this.db.transaction(() => {
      this.db.prepare("DELETE FROM leases WHERE call_id=? AND kind=? AND expires_at<=?").run(callId, kind, this.now());
      try {
        this.db
          .prepare(
            "INSERT INTO leases (call_id,kind,lease_id,acquired_at,expires_at,holder_pid,holder_boot_id) VALUES (?,?,?,?,?,?,?)"
          )
          .run(callId, kind, leaseId, this.now(), this.now() + ttlMs, process.pid, this.bootId);
        return leaseId;
      } catch {
        return null;
      }
    });
    return t.immediate() as string | null;
  }

  releaseLease(callId: string, kind: "execute" | "settle"): void {
    this.db.prepare("DELETE FROM leases WHERE call_id=? AND kind=?").run(callId, kind);
  }

  /**
   * T1 — commit the protected result and move executing → executed.
   * One transaction: the result exists the instant the state says it does.
   */
  commitResult(
    callId: string,
    r: {
      requestFingerprint: string;
      fingerprintVersion: string;
      digest: string;
      bytes: Buffer;
      adapterVersion: string;
      packId: string;
      merkleRoot: string;
      contentType: string;
    }
  ): void {
    const t = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO results (call_id,request_fingerprint,fingerprint_version,result_digest,result_bytes,
           byte_len,produced_at,adapter_version,substrate_pack_id,substrate_merkle_root,content_type)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          callId,
          r.requestFingerprint,
          r.fingerprintVersion,
          r.digest,
          r.bytes,
          r.bytes.length,
          this.now(),
          r.adapterVersion,
          r.packId,
          r.merkleRoot,
          r.contentType
        );
      const info = this.db.prepare("UPDATE calls SET state='executed' WHERE call_id=? AND state='executing'").run(callId);
      if (info.changes !== 1) throw new LedgerRefusal("STATE_RACE", "call left `executing` before the result committed");
      this.recordTransition(callId, "executing", "executed", "kernel", null, false);
      this.db.prepare("DELETE FROM leases WHERE call_id=? AND kind='execute'").run(callId);
    });
    t.immediate();
  }

  /**
   * T2 — enter `settling`. The EXISTS clause is the invariant: a call cannot
   * reach settlement without its result already durable. Nothing calls the
   * facilitator before this commits.
   */
  beginSettlement(callId: string, authorizationFingerprint: string, facilitatorId: string): number | null {
    const t = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `UPDATE calls SET state='settling' WHERE call_id=? AND state='executed'
           AND EXISTS (SELECT 1 FROM results r WHERE r.call_id=calls.call_id
                       AND r.request_fingerprint=calls.request_fingerprint)`
        )
        .run(callId);
      if (info.changes !== 1) return null;
      const attemptNo =
        ((this.db.prepare("SELECT MAX(attempt_no) m FROM settlement_attempts WHERE call_id=?").get(callId) as {
          m: number | null;
        }).m ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO settlement_attempts (call_id,attempt_no,authorization_fingerprint,facilitator_id,started_at,outcome)
           VALUES (?,?,?,?,?, 'unknown')`
        )
        .run(callId, attemptNo, authorizationFingerprint, facilitatorId, this.now());
      this.recordTransition(callId, "executed", "settling", "kernel", null, false);
      return attemptNo;
    });
    return t.immediate() as number | null;
  }

  /**
   * Receipt commit — the receipt row and `settled` land together, guarded by
   * EXISTS. Entitlement and the daily value ledger move in the same commit.
   */
  commitReceipt(callId: string, r: ReceiptInput, retryEntitlementSeconds: number): string {
    const receiptId = randomUUID();
    const t = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO receipts (receipt_id,call_id,request_fingerprint,authorization_fingerprint,attempt_no,
           success,txn,network,asset,amount_atomic,payer,pay_to,facilitator_id,receipt_json,receipt_json_digest,recorded_at)
           SELECT ?,?,c.request_fingerprint,?,?,1,?,?,?,?,?,?,?,?,?,? FROM calls c WHERE c.call_id=?`
        )
        .run(
          receiptId,
          callId,
          r.authorizationFingerprint,
          r.attemptNo,
          r.txn,
          r.network,
          r.asset,
          r.amountAtomic,
          r.payer,
          r.payTo,
          r.facilitatorId,
          r.receiptJson,
          r.receiptJsonDigest,
          this.now(),
          callId
        );
      this.db
        .prepare("UPDATE settlement_attempts SET outcome='success', finished_at=? WHERE call_id=? AND attempt_no=?")
        .run(this.now(), callId, r.attemptNo);
      const info = this.db
        .prepare(
          `UPDATE calls SET state='settled', settled_at=? WHERE call_id=? AND state='settling'
           AND EXISTS (SELECT 1 FROM receipts x WHERE x.call_id=calls.call_id
                       AND x.request_fingerprint=calls.request_fingerprint AND x.success=1)`
        )
        .run(this.now(), callId);
      if (info.changes !== 1) throw new LedgerRefusal("STATE_RACE", "call left `settling` before the receipt committed");
      this.recordTransition(callId, "settling", "settled", "kernel", null, false);
      this.db
        .prepare("INSERT OR REPLACE INTO entitlements (call_id,base_expires_at) VALUES (?,?)")
        .run(callId, this.now() + retryEntitlementSeconds * 1000);
      const d = day(this.now());
      this.db.prepare("INSERT OR IGNORE INTO value_ledger (day) VALUES (?)").run(d);
      const cur = this.db.prepare("SELECT settled_atomic FROM value_ledger WHERE day=?").get(d) as {
        settled_atomic: string;
      };
      this.db
        .prepare("UPDATE value_ledger SET settled_atomic=?, call_count=call_count+1 WHERE day=?")
        .run((BigInt(cur.settled_atomic) + BigInt(r.amountAtomic)).toString(), d);
      this.db.prepare("DELETE FROM leases WHERE call_id=? AND kind='settle'").run(callId);
    });
    t.immediate();
    return receiptId;
  }

  failSettlement(callId: string, attemptNo: number, definitive: boolean, reasonCode: string): void {
    const to: CallState = definitive ? "settlement_rejected" : "settlement_unknown";
    const t = this.db.transaction(() => {
      this.db
        .prepare("UPDATE settlement_attempts SET outcome=?, finished_at=? WHERE call_id=? AND attempt_no=?")
        .run(definitive ? "rejected" : "unknown", this.now(), callId, attemptNo);
      const info = this.db.prepare("UPDATE calls SET state=? WHERE call_id=? AND state='settling'").run(to, callId);
      if (info.changes === 1) {
        this.recordTransition(callId, "settling", to, "kernel", reasonCode, !definitive);
        if (!definitive) {
          this.db
            .prepare("INSERT OR IGNORE INTO quarantine (call_id,opened_at,reason_code) VALUES (?,?,?)")
            .run(callId, this.now(), reasonCode);
        }
      }
      this.db.prepare("DELETE FROM leases WHERE call_id=? AND kind='settle'").run(callId);
    });
    t.immediate();
  }

  /**
   * Delivery gate. Requires BOTH the stored result AND a matching successful
   * receipt for the same fingerprint, plus a live entitlement.
   */
  fetchDeliverable(
    callId: string
  ): { bytes: Buffer; contentType: string; receipt: Record<string, unknown>; entitlementExpiresAt: number } | null {
    const row = this.db
      .prepare(
        `SELECT r.result_bytes bytes, r.content_type ct, rc.receipt_json rj, rc.txn, rc.network, rc.asset,
                rc.amount_atomic, rc.payer, rc.pay_to,
                COALESCE(e.extended_expires_at, e.base_expires_at) exp
         FROM calls c
         JOIN results r ON r.call_id=c.call_id AND r.request_fingerprint=c.request_fingerprint
         JOIN receipts rc ON rc.call_id=c.call_id AND rc.request_fingerprint=c.request_fingerprint AND rc.success=1
         JOIN entitlements e ON e.call_id=c.call_id
         WHERE c.call_id=? AND c.state IN ('settled','delivered') AND r.result_bytes IS NOT NULL`
      )
      .get(callId) as
      | {
          bytes: Buffer;
          ct: string;
          rj: string;
          txn: string | null;
          network: string;
          asset: string;
          amount_atomic: string;
          payer: string | null;
          pay_to: string;
          exp: number;
        }
      | undefined;
    if (!row) return null;
    // Half-open interval: the entitlement is live UP TO `exp` and spent AT it.
    // This was `>`, which delivered on the expiry millisecond itself — one
    // free replay past the window the receipt advertises, and a boundary that
    // disagreed with the `entitlementExpiresAt` we publish to the client.
    // Deliberately tightened; no test pinned the old reading.
    if (this.now() >= row.exp) return null; // entitlement lapsed → 410
    return {
      bytes: row.bytes,
      contentType: row.ct,
      receipt: {
        transaction: row.txn,
        network: row.network,
        asset: row.asset,
        amountAtomic: row.amount_atomic,
        payer: row.payer,
        payTo: row.pay_to,
      },
      entitlementExpiresAt: row.exp,
    };
  }

  /**
   * Record delivery AFTER the transport's send has completed.
   *
   * Read this row for exactly what it is: a SUCCESSFUL WRITE on `transport`,
   * NOT client consumption. We know the bytes left us; we cannot know they
   * arrived, were parsed, or were used. Any dispute, credit, or compensation
   * decision that treats this as proof of receipt is reading it wrong.
   */
  recordDelivery(callId: string, byteLen: number, transport: string): void {
    const t = this.db.transaction(() => {
      const seq =
        ((this.db.prepare("SELECT MAX(seq) m FROM delivery_log WHERE call_id=?").get(callId) as { m: number | null }).m ??
          0) + 1;
      this.db
        .prepare("INSERT INTO delivery_log (call_id,seq,delivered_at,byte_len,transport) VALUES (?,?,?,?,?)")
        .run(callId, seq, this.now(), byteLen, transport);
      const info = this.db.prepare("UPDATE calls SET state='delivered' WHERE call_id=? AND state='settled'").run(callId);
      if (info.changes === 1) this.recordTransition(callId, "settled", "delivered", "kernel", null, false);
    });
    t.immediate();
  }

  dailySettled(): bigint {
    const r = this.db.prepare("SELECT settled_atomic FROM value_ledger WHERE day=?").get(day(this.now())) as
      | { settled_atomic: string }
      | undefined;
    return r ? BigInt(r.settled_atomic) : 0n;
  }

  /**
   * Crash reconciliation. A lease held by a DIFFERENT boot means the holder
   * died. `executing` becomes execution_unknown (replay-safe: rerunnable under
   * a new lease). `settling` becomes settlement_unknown and is QUARANTINED —
   * a facilitator timeout is not a failure, and we never blindly resubmit.
   */
  reconcileOnBoot(): { executionUnknown: string[]; settlementUnknown: string[] } {
    const executionUnknown: string[] = [];
    const settlementUnknown: string[] = [];
    const t = this.db.transaction(() => {
      this.db.prepare("DELETE FROM leases WHERE holder_boot_id != ?").run(this.bootId);
      for (const r of this.db.prepare("SELECT call_id FROM calls WHERE state='executing'").all() as Array<{
        call_id: string;
      }>) {
        if (this.transition(r.call_id, "executing", "execution_unknown", "boot-reconcile", "holder_boot_died")) {
          executionUnknown.push(r.call_id);
        }
      }
      for (const r of this.db.prepare("SELECT call_id FROM calls WHERE state='settling'").all() as Array<{
        call_id: string;
      }>) {
        if (this.transition(r.call_id, "settling", "settlement_unknown", "boot-reconcile", "restart_during_settling")) {
          this.db
            .prepare("INSERT OR IGNORE INTO quarantine (call_id,opened_at,reason_code) VALUES (?,?,?)")
            .run(r.call_id, this.now(), "restart_during_settling");
          settlementUnknown.push(r.call_id);
        }
      }
    });
    t.immediate();
    return { executionUnknown, settlementUnknown };
  }
}
