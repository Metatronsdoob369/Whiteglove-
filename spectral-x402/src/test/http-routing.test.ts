/**
 * http-routing.test.ts — HTTP routing and discovery are manifest-derived, not
 * a hardcoded second source.
 *
 * http.ts used to hardcode a verb→operationId ternary ("tile"→tile_fetch,
 * "proof"→pack_inclusion_proof, "manifest"→pack_manifest) and rebuild the
 * same three resource shapes by hand for `/.well-known/x402`. Both now come
 * from each mount operation's own `method` / `pathTemplate` — fields the
 * manifest already publishes. These tests pin the byte-identical behavior
 * that migration is required to preserve: discovery output for the existing
 * three operations across both real mounts, and every edge-local vs.
 * kernel-decided refusal boundary the old hardcoded ternary drew.
 *
 * evidence.test.ts and kernel.test.ts already prove the PAID path is
 * untouched; this file is specifically about what decides which operationId
 * a request resolves to, and where.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { boot, type Booted } from "../server.js";
import { StubFacilitator } from "../facilitator.js";
import type { AddressInfo } from "node:net";

const MANIFESTS = path.resolve(__dirname, "../../../manifests");
const PACKS = path.resolve(__dirname, "../../packs");
const PAY_TO = "0x0000000000000000000000000000000000000dev";

async function withServer(
  fn: (ctx: { url: string; b: Booted; facilitator: StubFacilitator }) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "x402-routing-"));
  // Held rather than inlined so a test can read its call counters — "the
  // facilitator was never asked" is how a refusal proves it happened before
  // the kernel's verify step, not after.
  const facilitator = new StubFacilitator("valid");
  const b = await boot({
    manifestsDir: MANIFESTS,
    packsDir: PACKS,
    ledgerPath: path.join(dir, "ledger.db"),
    port: 0,
    facilitator,
    requireTls: false,
    payToOverride: PAY_TO,
  });
  await new Promise<void>((r) => b.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(b.server.address() as AddressInfo).port}`;
  try {
    await fn({ url, b, facilitator });
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── discovery: resource strings come straight from pathTemplate ───────────

test("routing: discovery publishes the exact resource shapes for both mounts, unchanged", async () => {
  await withServer(async ({ url }) => {
    const res = await fetch(`${url}/.well-known/x402`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { x402Version: number; resources: Array<{ resource: string; operationId: string }> };
    assert.equal(body.x402Version, 2);
    const byOp = (mountId: string, opId: string) =>
      body.resources.find((r) => r.operationId === opId && r.resource.startsWith(`/${mountId}/`));

    assert.equal(byOp("roblox-luau", "tile_fetch")?.resource, "/roblox-luau/tile/{cid}");
    assert.equal(byOp("roblox-luau", "pack_inclusion_proof")?.resource, "/roblox-luau/proof/{cid}");
    assert.equal(byOp("roblox-luau", "pack_manifest")?.resource, "/roblox-luau/manifest");

    assert.equal(byOp("medical-medlineplus", "tile_fetch")?.resource, "/medical-medlineplus/tile/{cid}");
    assert.equal(byOp("medical-medlineplus", "pack_inclusion_proof")?.resource, "/medical-medlineplus/proof/{cid}");
    assert.equal(byOp("medical-medlineplus", "pack_manifest")?.resource, "/medical-medlineplus/manifest");

    assert.equal(body.resources.length, 6, "exactly three operations per mount, two mounts");
  });
});

// ─── an unrecognized shape 404s at the edge — no mount/operation to refuse ──

test("routing: an unrecognized verb on a KNOWN mount still 404s at the edge, not the kernel", async () => {
  await withServer(async ({ url }) => {
    const res = await fetch(`${url}/roblox-luau/not-a-real-verb`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { code: string; detail?: string };
    assert.equal(body.code, "args_invalid");
    assert.equal(body.detail, undefined, "edge-local 404 never carries a kernel detail");
  });
});

test("routing: a path with only a mount segment (no verb) 404s at the edge", async () => {
  await withServer(async ({ url }) => {
    const res = await fetch(`${url}/roblox-luau`);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, "args_invalid");
  });
});

// ─── a recognized shape on an UNKNOWN mount still reaches the kernel ───────

test("routing: a recognized verb shape on an UNKNOWN mount reaches the kernel as an unknown-mount refusal, not an edge 404", async () => {
  await withServer(async ({ url }) => {
    const res = await fetch(`${url}/no-such-mount/tile/b2-256:${"a".repeat(64)}`);
    // args_invalid is declared 400 in refusals.json — a KERNEL-decided
    // status, distinct from this edge's own 404s.
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string; detail?: string };
    assert.equal(body.code, "args_invalid");
    assert.equal(body.detail, "unknown mount");
  });
});

// ─── a placeholder segment omitted still resolves the operation ────────────

test("routing: a tile request with the {cid} segment omitted still resolves tile_fetch and lets the kernel refuse the missing arg", async () => {
  await withServer(async ({ url }) => {
    const res = await fetch(`${url}/roblox-luau/tile`);
    // NOT the edge's 404 — this reaches the kernel's own argSchema, which
    // refuses a missing required "cid" as args_invalid (400), same as before.
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "args_invalid");
  });
});

// ─── segments beyond what the template names are ignored, same as before ───

test("routing: a trailing extra segment past the template is ignored, same as the old parts[2]-only read", async () => {
  await withServer(async ({ url }) => {
    const res = await fetch(`${url}/roblox-luau/manifest/unexpected-extra-segment`);
    // No payment sent: this must still reach the kernel and get the ordinary
    // 402 challenge for pack_manifest, not an edge-local 404.
    assert.equal(res.status, 402);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "payment_id_missing");
  });
});

// ─── a malformed X-Payment is a payment fault at the edge, never a 500 ──────
//
// The MCP edge already refuses a payload with no nonce as `payment_invalid`,
// before the kernel sees it. This edge did not: the ledger digests the nonce
// unconditionally, so the throw landed mid-`handle()` — past admission, with
// no outcome to render — and fell out of the catch-all as an unmetered 500.
// The same payload was therefore a clean 402 on one door and an internal
// error on the other.

/** base64 of an arbitrary JSON payload, the way a client sends X-Payment. */
const xPayment = (payload: unknown): string => Buffer.from(JSON.stringify(payload)).toString("base64");

const NONCE_LESS: Array<{ name: string; payload: unknown }> = [
  { name: "no nonce key at all", payload: { scheme: "exact", network: "eip155:84532" } },
  { name: "a non-string nonce", payload: { scheme: "exact", network: "eip155:84532", nonce: 12345 } },
  { name: "a null nonce", payload: { scheme: "exact", network: "eip155:84532", nonce: null } },
  { name: "a JSON null payload", payload: null },
  { name: "a JSON array payload", payload: [{ nonce: "n1" }] },
];

for (const c of NONCE_LESS) {
  test(`routing: an X-Payment with ${c.name} is refused payment_invalid at the edge, not a 500`, async () => {
    await withServer(async ({ url, facilitator }) => {
      const res = await fetch(`${url}/roblox-luau/manifest`, {
        headers: {
          "x-payment-id": "pay-nonceless-000001",
          "x-payment": xPayment(c.payload),
        },
      });
      assert.equal(res.status, 402, "a broken payment is a payment fault");
      const body = (await res.json()) as { code: string; detail?: string };
      assert.equal(body.code, "payment_invalid");
      assert.notEqual(body.code, "capability_unavailable", "the catch-all 500's code must not appear");
      // Refused at DECODE: the kernel was never entered, so nothing was
      // verified and nothing was settled for a payload it could not complete.
      assert.equal(facilitator.verifyCalls, 0, "a payload refused at the edge never reaches the facilitator");
      assert.equal(facilitator.settleCalls, 0);
    });
  });
}

test("routing: a well-formed X-Payment still reaches the kernel — the nonce guard refuses only what is broken", async () => {
  await withServer(async ({ url }) => {
    const res = await fetch(`${url}/roblox-luau/manifest`, {
      headers: {
        "x-payment-id": "pay-wellformed-00001",
        // A real nonce, but terms the facilitator will judge — the point is
        // only that the edge passed it THROUGH rather than refusing it here.
        "x-payment": xPayment({ scheme: "exact", network: "eip155:84532", nonce: "n-abc", payer: "0xabc" }),
      },
    });
    assert.notEqual(res.status, 500, "a decodable payment must never reach the catch-all");
    const body = (await res.json()) as { code?: string; detail?: string };
    assert.notEqual(body.detail, "payment payload carries no nonce", "the guard must not have fired");
  });
});

// ─── non-GET stays a blanket 405, independent of path shape ────────────────

test("routing: a non-GET method is still 405 regardless of path shape", async () => {
  await withServer(async ({ url }) => {
    const res = await fetch(`${url}/roblox-luau/tile/whatever`, { method: "POST" });
    assert.equal(res.status, 405);
    assert.equal(((await res.json()) as { code: string }).code, "args_invalid");
  });
});
