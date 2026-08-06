/**
 * transport-seam.test.ts — the invariants the transport seam exists to hold.
 *
 * kernel.test.ts pins what the kernel DECIDES. These pin the seam itself: that
 * one limiter serves every spoke, that a kernel can be booted with no listener,
 * that delivery provenance follows the invocation, and that the status mapping
 * is fully covered by the generated table. All four were verified by hand
 * during the refactor and by nothing that runs on its own — which is the same
 * as unverified the next time someone edits this code.
 *
 * No HTTP server is constructed anywhere in this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { boot, bootKernelOnly, type BootedKernel } from "../server.js";
import { statusFor, type RefusalTable } from "../http.js";
import { StubFacilitator, type PaymentPayload } from "../facilitator.js";
import type { PaidInvocation, Transport } from "../kernel.js";

const MANIFESTS = path.resolve(__dirname, "../../../manifests");
const PACKS = path.resolve(__dirname, "../../packs");
const KERNEL_SRC = path.resolve(__dirname, "../../src/kernel.ts");
const PAY_TO = "0x0000000000000000000000000000000000000dev";
const MOUNT = "roblox-luau";

const refusals = JSON.parse(readFileSync(path.join(MANIFESTS, "refusals.json"), "utf8")) as {
  codes: Record<string, { http: number }>;
};
/** The declared ceiling this suite asserts against, straight from the manifest. */
const policy = JSON.parse(readFileSync(path.join(MANIFESTS, "runtime-policy.json"), "utf8")) as {
  paid: { rateLimit: { anonymous402MaxRequests: number } };
};

let seq = 0;
const paymentId = () => `pay-seam-${Date.now()}-${String(seq++).padStart(4, "0")}`;

function payment(nonce: string): PaymentPayload {
  return {
    scheme: "exact",
    network: "eip155:84532",
    payer: "0xBUYER",
    nonce,
    amountAtomic: "500",
    asset: "USDC",
    payTo: PAY_TO,
  };
}

async function withCore(fn: (ctx: { core: BootedKernel; cid: (i: number) => string }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "x402-seam-"));
  const core = await bootKernelOnly({
    manifestsDir: MANIFESTS,
    packsDir: PACKS,
    ledgerPath: path.join(dir, "ledger.db"),
    facilitator: new StubFacilitator("valid"),
    payToOverride: PAY_TO,
  });
  const tiles = core.mounts.get(MOUNT)!.substrate.getManifest().tiles as string[];
  try {
    await fn({ core, cid: (i) => tiles[i] });
  } finally {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function invocation(over: Partial<PaidInvocation> & { clientKey: string }): PaidInvocation {
  return {
    mountId: MOUNT,
    operationId: "tile_fetch",
    args: {},
    transport: "http",
    resource: `/${MOUNT}/tile_fetch`,
    ...over,
  };
}

// ─── (a) ONE limiter, not one per transport ──────────────────────────────────

test("seam: the anonymous ceiling is shared across transports under one clientKey", async () => {
  await withCore(async ({ core, cid }) => {
    const ceiling = policy.paid.rateLimit.anonymous402MaxRequests;
    const transports: Transport[] = ["http", "mcp"];
    const kinds: string[] = [];

    // Alternating spokes must draw on the SAME bucket. Two per-transport
    // limiters would let this caller spend 2× the declared ceiling.
    for (let i = 0; i < ceiling; i++) {
      const out = await core.kernel.handle(
        invocation({ clientKey: "one-client", transport: transports[i % 2], args: { cid: cid(0) } })
      );
      kinds.push(out.kind);
    }
    assert.ok(
      kinds.every((k) => k === "challenge"),
      `every invocation up to the ceiling must pass: ${[...new Set(kinds)].join(",")}`
    );

    const over = await core.kernel.handle(
      invocation({ clientKey: "one-client", transport: "mcp", args: { cid: cid(0) } })
    );
    assert.equal(over.kind, "refused");
    if (over.kind !== "refused") return;
    assert.equal(over.code, "rate_limited", `${ceiling} anonymous invocations is the whole budget, whatever spoke they used`);

    // Keying is per clientKey: a different caller is untouched by that flood.
    const other = await core.kernel.handle(
      invocation({ clientKey: "other-client", transport: "http", args: { cid: cid(0) } })
    );
    assert.equal(other.kind, "challenge");
  });
});

// ─── (b) a kernel with no listener ───────────────────────────────────────────

test("seam: bootKernelOnly constructs no HTTP server, boot still does", async () => {
  await withCore(async ({ core }) => {
    assert.ok(!("server" in core), "a kernel-only boot must not carry an HTTP server object");
    assert.ok(core.kernel && core.ledger && core.mounts.size > 0, "but it is a complete, admitted kernel");
  });

  const dir = mkdtempSync(path.join(tmpdir(), "x402-seam-http-"));
  const b = await boot({
    manifestsDir: MANIFESTS,
    packsDir: PACKS,
    ledgerPath: path.join(dir, "ledger.db"),
    port: 0,
    facilitator: new StubFacilitator("valid"),
    requireTls: false,
    payToOverride: PAY_TO,
  });
  try {
    assert.ok("server" in b, "boot() composes the same core plus a listener");
    assert.equal(typeof b.server.listen, "function");
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── (c) delivery provenance follows the invocation ──────────────────────────

test("seam: delivery_log records the invocation's transport, not a hardcoded 'http'", async () => {
  await withCore(async ({ core, cid }) => {
    const out = await core.kernel.handle(
      invocation({
        clientKey: "mcp-session-1",
        transport: "mcp",
        args: { cid: cid(0) },
        paymentId: paymentId(),
        payment: payment("seam-n1"),
        resource: "mcp:roblox_luau__tile_fetch",
      })
    );
    assert.equal(out.kind, "delivered");
    if (out.kind !== "delivered") return;

    core.kernel.recordDelivery(out.callId, out.bytes.length, "mcp");
    const row = core.ledger.db
      .prepare("SELECT transport, byte_len FROM delivery_log WHERE call_id=?")
      .get(out.callId) as { transport: string; byte_len: number };
    assert.equal(row.transport, "mcp", "a hardcoded transport label would read 'http' here");
    assert.equal(row.byte_len, out.bytes.length);
    assert.equal(core.ledger.getCall(out.callId)!.state, "delivered");
  });
});

// ─── (d) the status table covers every code the kernel can emit ──────────────

/**
 * Every wire code the kernel can produce, read out of its own source.
 *
 * Static rather than exercised on purpose: a test that only checks the codes it
 * thought to trigger cannot tell you a NEW code is undeclared, which is exactly
 * the drift that would make statusFor's 402 fallback reachable.
 */
function kernelEmittedCodes(): Set<string> {
  const src = readFileSync(KERNEL_SRC, "utf8");
  const found = new Set<string>();
  for (const re of [
    /\bcode:\s*"([a-z0-9_]+)"/g, // code: "x"
    /\bcode:\s*[^",\n]*\?\?\s*"([a-z0-9_]+)"/g, // code: v.reasonCode ?? "x"
    /AdapterMiss\("([a-z0-9_]+)"\)/g, // thrown, then returned as `code`
  ]) {
    for (const m of src.matchAll(re)) found.add(m[1]);
  }
  return found;
}

test("seam: every code the kernel emits is declared in refusals.json", () => {
  const emitted = kernelEmittedCodes();
  // Guard the guard: if the extraction silently stops matching, this test would
  // pass vacuously and prove nothing.
  assert.ok(emitted.size >= 10, `expected the kernel's code vocabulary, got ${[...emitted].join(",") || "nothing"}`);
  for (const code of ["args_invalid", "rate_limited", "tile_not_found", "payment_invalid", "settlement_rejected"]) {
    assert.ok(emitted.has(code), `extraction missed a known code: ${code}`);
  }

  const undeclared = [...emitted].filter((c) => !(c in refusals.codes));
  assert.deepEqual(undeclared, [], "an undeclared code would fall back to 402 at the HTTP edge");

  // The only sub-400 entries the kernel may emit are the protocol kinds, whose
  // status statusFor decides by `kind`. Anything else would be a refusal
  // rendered as success.
  const protocolCodes = new Set(["payment_id_missing", "payment_required", "call_in_progress"]);
  for (const code of emitted) {
    if (refusals.codes[code].http < 400) {
      assert.ok(protocolCodes.has(code), `${code} is declared ${refusals.codes[code].http} but is not a protocol kind`);
    }
  }
});

test("seam: statusFor renders kinds by protocol and refusals by table", () => {
  const table = refusals.codes as RefusalTable;
  assert.equal(statusFor({ kind: "challenge", requirements: {} as never, challengeEpoch: "e", code: "payment_required" }, table), 402);
  assert.equal(statusFor({ kind: "accepted", code: "call_in_progress", callId: "c" }, table), 202);
  assert.equal(
    statusFor(
      {
        kind: "delivered",
        callId: "c",
        bytes: Buffer.alloc(0),
        contentType: "application/json",
        receipt: {},
        entitlementExpiresAt: 0,
        replayed: false,
      },
      table
    ),
    200
  );

  for (const [code, decl] of Object.entries(refusals.codes)) {
    if (decl.http < 400) continue; // protocol kinds are decided by kind, above
    assert.equal(statusFor({ kind: "refused", code }, table), decl.http, `refusal ${code} must render as declared`);
  }

  // A facilitator reason we never declared is still a payment fault.
  assert.equal(statusFor({ kind: "refused", code: "some_unknown_facilitator_reason" }, table), 402);
  // And a table that called a refusal successful may not make one.
  assert.equal(statusFor({ kind: "refused", code: "x" }, { x: { http: 200 } }), 500);
});
