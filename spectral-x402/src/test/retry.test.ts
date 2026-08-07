/**
 * retry.test.ts — the retry edge out of `execution_failed`, made falsifiable.
 *
 * `kernel.handle()` documents a retry ("Retry permitted: the payment was
 * cancelled, not settled") and implements it as a ledger transition
 * `execution_failed → payment_present`. The ledger's TRANSITIONS table did not
 * declare that edge, so `assertTransitionAllowed` threw `ILLEGAL_TRANSITION`
 * out of the middle of `handle()` and every transport rendered it as an opaque
 * internal error — permanently, for that paymentId, on every subsequent call.
 *
 * These tests drive the retry through the kernel, with no transport in the
 * way, in the two shapes a real client produces it:
 *
 *   (1) verify failed  — the facilitator rejected the payment; nothing was
 *                        executed and nothing was settled. Two variants:
 *                        the same authorization re-presented once the
 *                        facilitator agrees it is good, and a re-signed
 *                        authorization replacing an expired one.
 *   (2) adapter failed — the capability missed; the payment was verified but
 *                        deliberately never settled. Two variants: a
 *                        transient miss that succeeds on the retry, and the
 *                        permanent miss that must keep refusing CLEANLY
 *                        rather than throwing.
 *
 * Every one of them asserts the money side as well as the outcome: a retried
 * call settles exactly ONCE across both attempts, and a call that never
 * reaches a result never settles at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { bootKernelOnly, type BootedKernel } from "../server.js";
import { BUILTIN_ADAPTERS } from "../kernel.js";
import { defineAdapter, AdapterMiss, type Adapter, type AdapterContext } from "../index.js";
import { StubFacilitator, type StubMode, type PaymentPayload } from "../facilitator.js";
import type { KernelOutcome } from "../kernel.js";

const MANIFESTS = path.resolve(__dirname, "../../../manifests");
const PACKS = path.resolve(__dirname, "../../packs");
const PAY_TO = "0x0000000000000000000000000000000000000dev";
const MOUNT = "roblox-luau";
const CLIENT_KEY = "retry-test";
const MISSING_CID = `b2-256:${"f".repeat(64)}`;

let seq = 0;
const paymentId = () => `pay-r-${Date.now()}-${String(seq++).padStart(4, "0")}`;

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

async function withKernel(
  mode: StubMode,
  fn: (ctx: {
    b: BootedKernel;
    stub: StubFacilitator;
    call: (args: Record<string, string>, pid: string, pay?: PaymentPayload) => Promise<KernelOutcome>;
    count: (table: string, where?: string) => number;
    cid: (i: number) => string;
  }) => Promise<void>,
  adapters?: readonly Adapter[]
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "x402-retry-"));
  const stub = new StubFacilitator(mode);
  const b = await bootKernelOnly({
    manifestsDir: MANIFESTS,
    packsDir: PACKS,
    ledgerPath: path.join(dir, "ledger.db"),
    facilitator: stub,
    payToOverride: PAY_TO,
    ...(adapters ? { adapters } : {}),
  });
  const tiles = b.mounts.get(MOUNT)!.substrate.getManifest().tiles as string[];

  const call = (args: Record<string, string>, pid: string, pay?: PaymentPayload): Promise<KernelOutcome> =>
    b.kernel.handle({
      mountId: MOUNT,
      operationId: "tile_fetch",
      args,
      paymentId: pid,
      payment: pay,
      transport: "http",
      clientKey: CLIENT_KEY,
      resource: `/${MOUNT}/tile_fetch`,
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

/**
 * The built-in tile_fetch, with one seam: an external flag the test flips to
 * make the NEXT execution miss. Deliberately not an invocation counter — boot
 * never dispatches a handler today, but a counter would silently mis-fire if
 * that ever changed. Everything else is copied from the built-in so the
 * maxResultBytes admission check and the argument schema stay identical.
 *
 * The miss code is `tile_not_found`, a code the real tile_fetch already emits
 * and refusals.json already declares — a test must not invent a refusal code
 * the published table does not carry.
 */
function flakyTileFetch(state: { failNext: boolean }): readonly Adapter[] {
  const flaky = defineAdapter({
    operationId: "tile_fetch",
    argSchema: z.object({ cid: z.string().regex(/^b2-256:[0-9a-f]{64}$/) }).strict(),
    maxResultBytes: 65536,
    declaredReplaySafe: true,
    handler: (args: { cid: string }, ctx: AdapterContext) => {
      if (state.failNext) {
        state.failNext = false;
        throw new AdapterMiss("tile_not_found");
      }
      const bytes = ctx.substrate.getTile(args.cid);
      if (!bytes) throw new AdapterMiss("tile_not_found");
      return { bytes: Buffer.from(bytes), contentType: ctx.substrate.payloadContentType };
    },
  });
  return [flaky, ...BUILTIN_ADAPTERS.filter((a) => a.operationId !== "tile_fetch")];
}

// ─── (1) verify failed, then the payment is good ─────────────────────────────

test("retry: a payment the facilitator rejected, re-presented once it verifies, delivers and settles once", async () => {
  await withKernel("invalid", async ({ b, stub, call, count, cid }) => {
    const pid = paymentId();
    const args = { cid: cid(0) };
    const pay = payment("retry-verify-1");

    const first = await call(args, pid, pay);
    assert.equal(first.kind, "refused");
    if (first.kind !== "refused") return;
    assert.equal(first.code, "payment_invalid");
    assert.equal(count("calls", "state='execution_failed'"), 1);
    assert.equal(count("receipts"), 0);
    assert.equal(stub.settleCalls, 0, "a rejected verification must never settle");

    // The client fixes nothing about the request — the facilitator is simply
    // willing now. Same paymentId, same args, same authorization.
    stub.mode = "valid";
    const second = await call(args, pid, pay);
    assert.equal(second.kind, "delivered", "the documented retry path must not throw");
    if (second.kind !== "delivered") return;
    assert.equal(second.replayed, false);
    assert.ok(second.bytes.length > 0);
    assert.equal(second.callId, first.callId, "the retry reuses the bound call, not a new one");

    assert.equal(stub.settleCalls, 1, "settled exactly once across both attempts");
    assert.equal(count("receipts"), 1);
    assert.equal(count("calls"), 1, "one paymentId, one call");
    assert.equal(count("calls", "state='execution_failed'"), 0, "the wedged state is gone");
    // `handle()` rests at `settled`; `settled → delivered` is the TRANSPORT's
    // write, after the bytes are actually on the wire (http.ts / mcp.ts call
    // `kernel.recordDelivery`). Driving it here proves the retried call
    // completes the whole chain, not just the paid part.
    assert.equal(count("calls", "state='settled'"), 1);
    b.kernel.recordDelivery(second.callId, second.bytes.length, "http");
    assert.equal(count("calls", "state='delivered'"), 1);
  });
});

test("retry: an expired authorization replaced by a re-signed one on the same paymentId delivers and settles once", async () => {
  // The stub stays in "valid" mode throughout: the FIRST payload is genuinely
  // expired and the stub's own protocol check rejects it, exactly as a real
  // facilitator would. The retry carries a new nonce and a live expiry — a
  // different authorization fingerprint on the same call, which is the shape
  // "client re-signs with the same paymentId" actually produces.
  await withKernel("valid", async ({ stub, call, count, cid }) => {
    const pid = paymentId();
    const args = { cid: cid(1) };
    const nowSec = Math.floor(Date.now() / 1000);

    const first = await call(args, pid, payment("retry-expired", { expiresAt: nowSec - 60 }));
    assert.equal(first.kind, "refused");
    if (first.kind !== "refused") return;
    assert.equal(first.code, "payment_expired");
    assert.equal(count("calls", "state='execution_failed'"), 1);
    assert.equal(stub.settleCalls, 0);

    const second = await call(args, pid, payment("retry-resigned", { expiresAt: nowSec + 600 }));
    assert.equal(second.kind, "delivered");
    if (second.kind !== "delivered") return;
    assert.equal(second.callId, first.callId);
    assert.equal(stub.settleCalls, 1, "settled exactly once across both attempts");
    assert.equal(count("receipts"), 1);
    // Both authorizations are recorded against the one call — the ledger keeps
    // the audit trail of WHICH authorization paid, and only one did.
    assert.equal(count("authorizations", `call_id='${second.callId}'`), 2);
  });
});

// ─── (2) the adapter failed, then it does not ────────────────────────────────

test("retry: a transient capability miss retried with the same args and paymentId delivers and settles once", async () => {
  const state = { failNext: false };
  await withKernel(
    "valid",
    async ({ stub, call, count, cid }) => {
      const pid = paymentId();
      const args = { cid: cid(0) };
      const pay = payment("retry-adapter");

      state.failNext = true;
      const first = await call(args, pid, pay);
      assert.equal(first.kind, "refused");
      if (first.kind !== "refused") return;
      assert.equal(first.code, "tile_not_found");
      assert.equal(count("calls", "state='execution_failed'"), 1);
      assert.equal(count("results"), 0);
      assert.equal(stub.settleCalls, 0, "an adapter failure is an official cancellation — no money moves");
      assert.equal(stub.verifyCalls, 1, "the payment was good; the capability missed");

      // Identical request, identical paymentId — the fingerprint binding is
      // untouched, which is precisely why this retry is legal.
      const second = await call(args, pid, pay);
      assert.equal(second.kind, "delivered");
      if (second.kind !== "delivered") return;
      assert.equal(second.callId, first.callId);
      assert.equal(second.replayed, false);
      assert.equal(stub.settleCalls, 1, "settled exactly once across both attempts");
      assert.equal(count("receipts"), 1);
      assert.equal(count("results"), 1, "the retry produced the result the first attempt could not");
      assert.equal(count("calls", "state='settled'"), 1);
      assert.equal(count("calls", "state='execution_failed'"), 0);
    },
    flakyTileFetch(state)
  );
});

test("retry: a permanent capability miss keeps refusing cleanly and never wedges the paymentId", async () => {
  // The reviewer's second empirical repro. The retry cannot succeed — the tile
  // does not exist — but it must come back as the SAME honest refusal, not as
  // an ILLEGAL_TRANSITION escaping handle(). Three attempts, because "wedged
  // forever" is the failure mode being denied.
  await withKernel("valid", async ({ stub, call, count }) => {
    const pid = paymentId();
    const args = { cid: MISSING_CID };
    const pay = payment("retry-permanent-miss");

    for (let attempt = 1; attempt <= 3; attempt++) {
      const out = await call(args, pid, pay);
      assert.equal(out.kind, "refused", `attempt ${attempt} must refuse, not throw`);
      if (out.kind !== "refused") return;
      assert.equal(out.code, "tile_not_found", `attempt ${attempt}`);
      assert.equal(count("calls", "state='execution_failed'"), 1);
      assert.equal(count("receipts"), 0);
      assert.equal(count("results"), 0);
      assert.equal(stub.settleCalls, 0, "a call that never produced a result must never settle");
    }
    assert.equal(count("calls"), 1, "one paymentId, one call, across every attempt");
  });
});

// ─── the fingerprint binding is not what the retry edge relaxes ──────────────

test("retry: a retry that changes the args still conflicts — one paymentId binds one fingerprint", async () => {
  await withKernel("valid", async ({ stub, call, count, cid }) => {
    const pid = paymentId();
    const pay = payment("retry-fp-conflict");

    const first = await call({ cid: MISSING_CID }, pid, pay);
    assert.equal(first.kind, "refused");
    if (first.kind !== "refused") return;
    assert.equal(first.code, "tile_not_found");

    // Same paymentId, DIFFERENT args. The retry edge must not become a way to
    // re-aim a paid call at a different request.
    const second = await call({ cid: cid(0) }, pid, pay);
    assert.equal(second.kind, "refused");
    if (second.kind !== "refused") return;
    assert.equal(second.code, "payment_id_fingerprint_conflict");
    assert.equal(stub.settleCalls, 0);
    assert.equal(count("receipts"), 0);
  });
});
