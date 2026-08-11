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

async function withServer(fn: (ctx: { url: string; b: Booted }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "x402-routing-"));
  const b = await boot({
    manifestsDir: MANIFESTS,
    packsDir: PACKS,
    ledgerPath: path.join(dir, "ledger.db"),
    port: 0,
    facilitator: new StubFacilitator("valid"),
    requireTls: false,
    payToOverride: PAY_TO,
  });
  await new Promise<void>((r) => b.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(b.server.address() as AddressInfo).port}`;
  try {
    await fn({ url, b });
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── discovery: resource strings come straight from pathTemplate ───────────

test("routing: discovery publishes the exact resource shapes for every mount, unchanged", async () => {
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

    assert.equal(byOp("fintel-paper-arena", "tile_fetch")?.resource, "/fintel-paper-arena/tile/{cid}");
    assert.equal(byOp("fintel-paper-arena", "pack_inclusion_proof")?.resource, "/fintel-paper-arena/proof/{cid}");
    assert.equal(byOp("fintel-paper-arena", "pack_manifest")?.resource, "/fintel-paper-arena/manifest");

    assert.equal(body.resources.length, 9, "exactly three operations per mount, three mounts");
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

// ─── non-GET stays a blanket 405, independent of path shape ────────────────

test("routing: a non-GET method is still 405 regardless of path shape", async () => {
  await withServer(async ({ url }) => {
    const res = await fetch(`${url}/roblox-luau/tile/whatever`, { method: "POST" });
    assert.equal(res.status, 405);
    assert.equal(((await res.json()) as { code: string }).code, "args_invalid");
  });
});
