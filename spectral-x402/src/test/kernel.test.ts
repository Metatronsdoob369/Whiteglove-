/**
 * kernel.test.ts — CHARACTERIZATION tests.
 *
 * These pin the behavior the kernel ships TODAY, by calling `kernel.handle()`
 * directly with no HTTP anywhere. That distinction is the whole point: the
 * existing evidence suite drives every assertion through `fetch()`, so it
 * cannot tell whether an invariant lives in the kernel or in `http.ts`. If the
 * upcoming refactor moves policy and these tests still pass, the policy moved
 * intact. If it silently changed, they fail.
 *
 * Written BEFORE the refactor on purpose. Written after, a refactor grades its
 * own homework — the tests would encode whatever the new code happens to do.
 *
 * Read as documentation of current contract, not of desired contract. Where
 * today's behavior is arguably wrong, the test records it as-is and says so in
 * a comment; changing it is a later, deliberate act with its own commit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { boot, type Booted } from "../server.js";
import { StubFacilitator, type StubMode, type PaymentPayload } from "../facilitator.js";
import type { KernelOutcome } from "../kernel.js";

const MANIFESTS = path.resolve(__dirname, "../../../manifests");
const PACKS = path.resolve(__dirname, "../../packs");
const PAY_TO = "0x0000000000000000000000000000000000000dev";
const MOUNT = "roblox-luau";
/** Fixed rate-limit identity: these tests exercise policy, not the limiter. */
const CLIENT_KEY = "char-test";

let seq = 0;
/** Clears PAYMENT_ID_MIN_LENGTH (16) regardless of clock or counter width. */
const paymentId = () => `pay-k-${Date.now()}-${String(seq++).padStart(4, "0")}`;

function payment(nonce: string, over: Partial<PaymentPayload> = {}): PaymentPayload {
  return {
    scheme: "exact",
    network: "eip155:84532",
    payer: "0xBUYER",
    nonce,
    amountAtomic: "500",
    asset: "USDC",
    payTo: PAY_TO,
    ...over,
  };
}

/**
 * Boot the kernel and ledger WITHOUT ever calling `server.listen()`. The HTTP
 * server object is constructed (boot() does that unconditionally today — a fact
 * Task 3 changes) but no socket is opened and no request crosses it.
 */
async function withKernel(
  mode: StubMode,
  fn: (ctx: {
    b: Booted;
    stub: StubFacilitator;
    call: (args: Record<string, string>, pid?: string, pay?: PaymentPayload, op?: string) => Promise<KernelOutcome>;
    count: (table: string, where?: string) => number;
    cid: (i: number) => string;
  }) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "x402-char-"));
  const stub = new StubFacilitator(mode);
  const b = await boot({
    manifestsDir: MANIFESTS,
    packsDir: PACKS,
    ledgerPath: path.join(dir, "ledger.db"),
    port: 0,
    facilitator: stub,
    requireTls: false,
    payToOverride: PAY_TO,
  });
  const mount = b.mounts.get(MOUNT)!;
  const tiles = mount.substrate.getManifest().tiles as string[];

  const call = (
    args: Record<string, string>,
    pid?: string,
    pay?: PaymentPayload,
    op = "tile_fetch"
  ): Promise<KernelOutcome> =>
    b.kernel.handle({
      mountId: MOUNT,
      operationId: op,
      args,
      paymentId: pid,
      payment: pay,
      transport: "http",
      clientKey: CLIENT_KEY,
      resource: `/${MOUNT}/${op}`,
    });

  const count = (table: string, where = "1=1"): number =>
    (b.ledger.db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get() as { c: number }).c;

  try {
    await fn({ b, stub, call, count, cid: (i) => tiles[i] });
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── challenge ───────────────────────────────────────────────────────────────

test("char: no paymentId yields a challenge and writes nothing durable", async () => {
  await withKernel("valid", async ({ call, count, cid }) => {
    const out = await call({ cid: cid(0) });
    assert.equal(out.kind, "challenge");
    if (out.kind !== "challenge") return;
    assert.equal(out.code, "payment_id_missing");
    assert.equal(out.requirements.scheme, "exact");
    assert.equal(out.requirements.payTo, PAY_TO);
    assert.equal(out.requirements.amountAtomic, "500");
    assert.equal(count("calls"), 0, "a challenge must not open a call");
    assert.equal(count("payment_bindings"), 0);
  });
});

test("char: paymentId present but no payment still challenges, no call opened", async () => {
  await withKernel("valid", async ({ call, count, cid }) => {
    const out = await call({ cid: cid(0) }, paymentId());
    assert.equal(out.kind, "challenge");
    // Current behavior: the binding is NOT created until a payment arrives.
    assert.equal(count("calls"), 0);
  });
});

// ─── happy path ──────────────────────────────────────────────────────────────

test("char: one valid payment → one execution, one settlement, one receipt", async () => {
  await withKernel("valid", async ({ call, count, stub, cid }) => {
    const out = await call({ cid: cid(0) }, paymentId(), payment("n1"));
    assert.equal(out.kind, "delivered");
    if (out.kind !== "delivered") return;
    assert.equal(out.replayed, false);
    assert.ok(out.bytes.length > 0);
    assert.equal(count("results"), 1);
    assert.equal(count("settlement_attempts"), 1);
    assert.equal(count("receipts", "success=1"), 1);
    assert.equal(stub.verifyCalls, 1);
    assert.equal(stub.settleCalls, 1);
    // Kernel does NOT record delivery — the transport does, after its send.
    assert.equal(count("delivery_log"), 0, "delivery is the transport's to record");
    assert.equal(count("calls", "state='settled'"), 1, "settled, not yet delivered");
  });
});

test("char: delivered bytes hash to the requested cid", async () => {
  await withKernel("valid", async ({ call, cid }) => {
    const want = cid(0);
    const out = await call({ cid: want }, paymentId(), payment("n2"));
    assert.equal(out.kind, "delivered");
    if (out.kind !== "delivered") return;
    const { createHash } = await import("node:crypto");
    const d = createHash("blake2b512").update(out.bytes).digest().subarray(0, 32).toString("hex");
    assert.equal(`b2-256:${d}`, want);
  });
});

// ─── replay ──────────────────────────────────────────────────────────────────

test("char: replay with no payment returns identical bytes and never re-settles", async () => {
  await withKernel("valid", async ({ call, count, stub, cid }) => {
    const pid = paymentId();
    const first = await call({ cid: cid(0) }, pid, payment("n3"));
    assert.equal(first.kind, "delivered");
    if (first.kind !== "delivered") return;
    const settlesAfter = stub.settleCalls;

    const again = await call({ cid: cid(0) }, pid); // no payment at all
    assert.equal(again.kind, "delivered");
    if (again.kind !== "delivered") return;
    assert.equal(again.replayed, true);
    assert.deepEqual(again.bytes, first.bytes);
    assert.equal(stub.settleCalls, settlesAfter, "replay must not re-settle");
    assert.equal(count("settlement_attempts"), 1);
    assert.equal(count("receipts", "success=1"), 1);
  });
});

// ─── 409 binding conflict ────────────────────────────────────────────────────

test("char: same paymentId with different args → 409, nothing executed or settled", async () => {
  await withKernel("valid", async ({ call, count, stub, cid }) => {
    const pid = paymentId();
    await call({ cid: cid(0) }, pid, payment("n4"));
    const before = { results: count("results"), settles: stub.settleCalls };

    const out = await call({ cid: cid(1) }, pid, payment("n4"));
    assert.equal(out.kind, "refused");
    if (out.kind !== "refused") return;
    assert.equal(out.code, "payment_id_fingerprint_conflict");
    assert.ok(out.callId, "409 names the call the id is already bound to");
    assert.equal(count("results"), before.results, "409 must not execute");
    assert.equal(stub.settleCalls, before.settles, "409 must not settle");
  });
});

test("char: same paymentId with a different OPERATION also conflicts", async () => {
  await withKernel("valid", async ({ call, count, cid }) => {
    const pid = paymentId();
    await call({ cid: cid(0) }, pid, payment("n5"));
    const out = await call({ cid: cid(0) }, pid, payment("n5"), "pack_inclusion_proof");
    assert.equal(out.kind, "refused");
    if (out.kind !== "refused") return;
    // operationId is a fingerprint input, so a different op is a different purchase.
    assert.equal(out.code, "payment_id_fingerprint_conflict");
    assert.equal(count("results"), 1);
  });
});

// ─── payment faults ──────────────────────────────────────────────────────────

for (const [mode, code] of [
  ["invalid", "payment_invalid"],
  ["expired", "payment_expired"],
  ["underpaid", "payment_underpaid"],
  ["wrong-asset", "payment_wrong_asset"],
  ["wrong-network", "payment_wrong_network"],
  ["wrong-recipient", "payment_wrong_recipient"],
] as Array<[StubMode, string]>) {
  test(`char: ${mode} fails closed as ${code} with no execution and no settlement`, async () => {
    await withKernel(mode, async ({ call, count, stub, cid }) => {
      const out = await call({ cid: cid(0) }, paymentId(), payment("n6"));
      assert.equal(out.kind, "refused");
      if (out.kind !== "refused") return;
      assert.equal(out.code, code);
      assert.equal(count("results"), 0, "must not execute");
      assert.equal(count("receipts"), 0, "must not settle");
      assert.equal(stub.settleCalls, 0);
      // A failed verification records the terminal state on the call.
      assert.equal(count("calls", "state='execution_failed'"), 1);
    });
  });
}

test("char: malformed paymentId refused before any binding or facilitator call", async () => {
  await withKernel("valid", async ({ call, count, stub, cid }) => {
    const out = await call({ cid: cid(0) }, "short", payment("n7"));
    assert.equal(out.kind, "refused");
    if (out.kind !== "refused") return;
    assert.equal(out.code, "args_invalid");
    assert.equal(count("calls"), 0, "no call opened");
    assert.equal(stub.verifyCalls, 0, "no facilitator contact");
  });
});

// ─── adapter miss ────────────────────────────────────────────────────────────

test("char: unknown cid never settles and lands execution_failed", async () => {
  await withKernel("valid", async ({ call, count, stub }) => {
    const out = await call({ cid: `b2-256:${"f".repeat(64)}` }, paymentId(), payment("n8"));
    assert.equal(out.kind, "refused");
    if (out.kind !== "refused") return;
    assert.equal(out.code, "tile_not_found");
    assert.equal(count("receipts"), 0, "adapter failure must never settle");
    assert.equal(stub.settleCalls, 0);
    assert.equal(count("calls", "state='execution_failed'"), 1);
    // Verification DID happen — the payment was good, the capability missed.
    assert.equal(stub.verifyCalls, 1);
  });
});

test("char: unknown mount and unknown operation are refused as args_invalid", async () => {
  await withKernel("valid", async ({ b, cid }) => {
    const bad = await b.kernel.handle({
      mountId: "nope",
      operationId: "tile_fetch",
      args: { cid: cid(0) },
      paymentId: paymentId(),
      transport: "http",
      clientKey: CLIENT_KEY,
      resource: "/nope/tile_fetch",
    });
    assert.equal(bad.kind, "refused");
    if (bad.kind === "refused") assert.equal(bad.code, "args_invalid");

    const badOp = await b.kernel.handle({
      mountId: MOUNT,
      operationId: "not_an_op",
      args: {},
      paymentId: paymentId(),
      transport: "http",
      clientKey: CLIENT_KEY,
      resource: `/${MOUNT}/not_an_op`,
    });
    assert.equal(badOp.kind, "refused");
    if (badOp.kind === "refused") assert.equal(badOp.code, "args_invalid");
  });
});

// ─── settlement outcomes ─────────────────────────────────────────────────────

test("char: definitive rejection locks output — result exists, receipt does not", async () => {
  await withKernel("settle-reject", async ({ call, count, cid }) => {
    const out = await call({ cid: cid(0) }, paymentId(), payment("n9"));
    assert.equal(out.kind, "refused");
    if (out.kind !== "refused") return;
    assert.equal(out.code, "settlement_rejected");
    assert.equal(count("results"), 1, "the result was produced");
    assert.equal(count("receipts"), 0, "but no receipt, so it stays locked");
    assert.equal(count("calls", "state='settlement_rejected'"), 1);
  });
});

test("char: indeterminate settlement quarantines and never resubmits", async () => {
  await withKernel("succeed-then-drop-response", async ({ call, count, stub, cid }) => {
    const pid = paymentId();
    const out = await call({ cid: cid(0) }, pid, payment("n10"));
    assert.equal(out.kind, "refused");
    if (out.kind !== "refused") return;
    assert.equal(out.code, "settlement_pending_review");
    assert.equal(count("quarantine"), 1);
    assert.equal(count("calls", "state='settlement_unknown'"), 1);
    assert.equal(count("receipts"), 0);

    // Retrying must NOT resubmit — the money may already have moved.
    const settlesBefore = stub.settleCalls;
    const again = await call({ cid: cid(0) }, pid, payment("n10"));
    assert.equal(again.kind, "refused");
    if (again.kind === "refused") assert.equal(again.code, "settlement_pending_review");
    assert.equal(stub.settleCalls, settlesBefore, "never blindly resubmit");
    assert.equal(count("settlement_attempts"), 1);
  });
});

// ─── concurrency ─────────────────────────────────────────────────────────────

test("char: 8 concurrent identical calls → one execution, one settlement, one receipt", async () => {
  await withKernel("valid", async ({ call, count, stub, cid }) => {
    const pid = paymentId();
    const outs = await Promise.all(
      Array.from({ length: 8 }, () => call({ cid: cid(0) }, pid, payment("n11")))
    );
    assert.equal(count("results"), 1, "exactly one execution");
    assert.equal(count("settlement_attempts"), 1, "exactly one settlement attempt");
    assert.equal(count("receipts", "success=1"), 1, "exactly one receipt");
    assert.equal(stub.settleCalls, 1);
    assert.ok(outs.some((o) => o.kind === "delivered"), "at least one caller got bytes");
    assert.ok(
      outs.every((o) => o.kind === "delivered" || o.kind === "accepted"),
      `unexpected kinds: ${outs.map((o) => o.kind).join(",")}`
    );
  });
});

// ─── ceiling ─────────────────────────────────────────────────────────────────

test("char: daily settled-value ceiling refuses before any new money moves", async () => {
  await withKernel("valid", async ({ b, call, count, stub, cid }) => {
    const day = new Date().toISOString().slice(0, 10);
    const mount = b.mounts.get(MOUNT)!;
    b.ledger.db.prepare("INSERT OR REPLACE INTO value_ledger (day, settled_atomic, call_count) VALUES (?,?,?)")
      .run(day, mount.limits.dailySettledValueCeilingAtomic.toString(), 1);

    const out = await call({ cid: cid(0) }, paymentId(), payment("n12"));
    assert.equal(out.kind, "refused");
    if (out.kind !== "refused") return;
    assert.equal(out.code, "daily_ceiling_reached");
    assert.equal(count("calls"), 0, "ceiling is checked before a call is opened");
    assert.equal(stub.verifyCalls, 0, "and before the facilitator is contacted");
  });
});

// ─── fingerprint properties ──────────────────────────────────────────────────

test("char: requestFingerprint is nonce-free so re-signing does not conflict", async () => {
  await withKernel("valid", async ({ b, call, count, cid }) => {
    const mount = b.mounts.get(MOUNT)!;
    const op = mount.operations.get("tile_fetch")!;
    const a = b.kernel.requestFingerprint(mount, op, { cid: cid(0) });
    const c = b.kernel.requestFingerprint(mount, op, { cid: cid(0) });
    assert.equal(a, c, "same purchase, same fingerprint");
    assert.notEqual(a, b.kernel.requestFingerprint(mount, op, { cid: cid(1) }), "different args differ");

    // The property that matters: a client whose authorization expired and
    // re-signed with a FRESH NONCE must still be the same purchase.
    const pid = paymentId();
    await call({ cid: cid(0) }, pid, payment("nonce-one"));
    const resigned = await call({ cid: cid(0) }, pid, payment("nonce-two-fresh"));
    assert.notEqual(resigned.kind, "refused", "re-signing must not 409");
    assert.equal(count("settlement_attempts"), 1, "and must not re-settle");
  });
});

test("char: authorizationFingerprint DOES vary with nonce and payer", async () => {
  await withKernel("valid", async ({ b, cid }) => {
    const mount = b.mounts.get(MOUNT)!;
    const op = mount.operations.get("tile_fetch")!;
    const fp = b.kernel.requestFingerprint(mount, op, { cid: cid(0) });
    const base = b.kernel.authorizationFingerprint(fp, payment("nonce-a"));
    assert.notEqual(base, b.kernel.authorizationFingerprint(fp, payment("nonce-b")), "nonce matters");
    assert.notEqual(
      base,
      b.kernel.authorizationFingerprint(fp, payment("nonce-a", { payer: "0xOTHER" })),
      "payer matters"
    );
  });
});
