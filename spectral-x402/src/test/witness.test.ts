/**
 * witness.test.ts — the trust record, made falsifiable.
 *
 * The witness chain is the evidence layer the token gate reads, so these
 * tests pin the properties that make it evidence: totals that match the
 * ledger, seals that verify against the local trust store, links that break
 * loudly under tampering, counters that cannot shrink, and an HONEST breach
 * count when the ledger itself is corrupted. Real kernel, real sealed packs,
 * real SQLite — the stub replaces only the money boundary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { bootKernelOnly, StubFacilitator, type BootedKernel } from "../index.js";
import { cutWitness, verifyWitnessChain, WitnessRefusal, type WitnessFile, type TrustEntry } from "../index.js";

const MANIFESTS = path.resolve(__dirname, "../../../manifests");
const PACKS = path.resolve(__dirname, "../../packs");
const PAY_TO = "0x0000000000000000000000000000000000000dev";
const NETWORK = "eip155:84532";
const TRUST = JSON.parse(readFileSync(path.join(PACKS, "terrain-keys.json"), "utf8")) as Record<string, TrustEntry>;

let seq = 0;
const paymentId = (): string => `pay-wit-${Date.now()}-${String(seq++).padStart(4, "0")}`;

function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "x402-witness-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** One fully settled + delivered pack_manifest purchase against the live manifests. */
async function buyOnce(core: BootedKernel, transport: "http" | "mcp"): Promise<void> {
  const out = await core.kernel.handle({
    mountId: "roblox-luau",
    operationId: "pack_manifest",
    args: {},
    paymentId: paymentId(),
    payment: {
      scheme: "exact",
      network: NETWORK,
      payer: "0xBUYER",
      nonce: `wit-${seq}`,
      amountAtomic: "1000",
      asset: "USDC",
      payTo: PAY_TO,
    },
    transport,
    clientKey: `wit-${transport}`,
    resource: "/roblox-luau/manifest",
  });
  assert.equal(out.kind, "delivered", `expected delivery, got ${JSON.stringify(out)}`);
  if (out.kind === "delivered") core.kernel.recordDelivery(out.callId, out.bytes.length, transport);
}

async function bootWith(dir: string): Promise<BootedKernel> {
  return bootKernelOnly({
    manifestsDir: MANIFESTS,
    packsDir: PACKS,
    ledgerPath: path.join(dir, "ledger.db"),
    facilitator: new StubFacilitator("valid"),
    payToOverride: PAY_TO,
  });
}

test("witness: genesis attestation matches the ledger and its seal verifies", async () => {
  await withTmpDir(async (dir) => {
    const core = await bootWith(dir);
    try {
      await buyOnce(core, "http");
    } finally {
      core.close();
    }

    const witnessDir = path.join(dir, "witness");
    const file = cutWitness({ ledgerPath: path.join(dir, "ledger.db"), witnessDir, keysDir: PACKS });
    const w = file.witness;

    assert.equal(w.index, 1);
    assert.equal(w.prev_cid, null);
    assert.equal(w.ledger.calls_total, 1);
    assert.equal(w.ledger.calls_by_state.delivered, 1);
    assert.equal(w.ledger.receipts_success_total, 1);
    assert.equal(w.ledger.unique_payers, 1);
    assert.deepEqual(w.ledger.deliveries_by_transport, { http: 1 });
    assert.deepEqual(w.ledger.settled_volume, [
      { mount_id: "roblox-luau", asset: "USDC", network: NETWORK, amount_atomic_total: "1000" },
    ]);
    assert.equal(w.invariants.breaches, 0, JSON.stringify(w.invariants.checks));

    const { verified, totalBreaches } = verifyWitnessChain(witnessDir, TRUST);
    assert.equal(verified, 1);
    assert.equal(totalBreaches, 0);
  });
});

test("witness: the chain links, counters accumulate, and both doors are witnessed", async () => {
  await withTmpDir(async (dir) => {
    const ledgerPath = path.join(dir, "ledger.db");
    const witnessDir = path.join(dir, "witness");

    const core = await bootWith(dir);
    try {
      await buyOnce(core, "http");
    } finally {
      core.close();
    }
    const first = cutWitness({ ledgerPath, witnessDir, keysDir: PACKS });

    const core2 = await bootWith(dir);
    try {
      await buyOnce(core2, "mcp");
    } finally {
      core2.close();
    }
    const second = cutWitness({ ledgerPath, witnessDir, keysDir: PACKS });

    assert.equal(second.witness.index, 2);
    assert.equal(second.witness.prev_cid, first.seal.cid, "witness 2 must name witness 1 by content address");
    assert.equal(second.witness.ledger.calls_total, 2);
    assert.deepEqual(second.witness.ledger.deliveries_by_transport, { http: 1, mcp: 1 });

    const { verified, totalBreaches } = verifyWitnessChain(witnessDir, TRUST);
    assert.equal(verified, 2);
    assert.equal(totalBreaches, 0);
  });
});

test("witness: a tampered body breaks verification AND refuses further chaining", async () => {
  await withTmpDir(async (dir) => {
    const ledgerPath = path.join(dir, "ledger.db");
    const witnessDir = path.join(dir, "witness");
    const core = await bootWith(dir);
    try {
      await buyOnce(core, "http");
    } finally {
      core.close();
    }
    cutWitness({ ledgerPath, witnessDir, keysDir: PACKS });

    const p = path.join(witnessDir, "witness-000001.json");
    const tampered = JSON.parse(readFileSync(p, "utf8")) as WitnessFile;
    tampered.witness.ledger.calls_total = 999; // history says otherwise
    writeFileSync(p, JSON.stringify(tampered, null, 2) + "\n");

    assert.throws(
      () => verifyWitnessChain(witnessDir, TRUST),
      (e: unknown) => e instanceof WitnessRefusal && e.code === "CHAIN_TAMPERED"
    );
    assert.throws(
      () => cutWitness({ ledgerPath, witnessDir, keysDir: PACKS }),
      (e: unknown) => e instanceof WitnessRefusal && e.code === "CHAIN_TAMPERED",
      "appending onto tampered history would launder the tampering"
    );
  });
});

test("witness: a corrupted ledger is witnessed HONESTLY — breaches counted, seal still valid", async () => {
  await withTmpDir(async (dir) => {
    const ledgerPath = path.join(dir, "ledger.db");
    const witnessDir = path.join(dir, "witness");
    const core = await bootWith(dir);
    try {
      await buyOnce(core, "http");
    } finally {
      core.close();
    }

    // A success receipt for a call that never existed — two invariants die.
    const db = new Database(ledgerPath);
    db.prepare(
      `INSERT INTO receipts (receipt_id,call_id,request_fingerprint,authorization_fingerprint,
         attempt_no,success,facilitator_id,receipt_json,receipt_json_digest,recorded_at)
       VALUES ('ghost-receipt','ghost-call','fp','afp',1,1,'stub','{}','digest',0)`
    ).run();
    db.close();

    const file = cutWitness({ ledgerPath, witnessDir, keysDir: PACKS });
    const inv = file.witness.invariants;
    assert.ok(inv.breaches >= 2, `expected the ghost receipt to breach at least two checks: ${JSON.stringify(inv.checks)}`);
    assert.ok(inv.checks.success_receipt_without_result >= 1);
    assert.ok(inv.checks.receipt_without_call >= 1);

    // The chain still verifies — the witness records the truth, the gate judges it.
    const { verified, totalBreaches } = verifyWitnessChain(witnessDir, TRUST);
    assert.equal(verified, 1);
    assert.equal(totalBreaches, inv.breaches);
  });
});
