/**
 * agnostic.test.ts — the kernel is payload-agnostic.
 *
 * Serves a pack whose payloads are RAW BINARY (not JSON) through the exact
 * same kernel, ledger, and transport, and proves the bytes arrive verbatim
 * with the media type the sealed manifest declared. Nothing about the
 * payment path knows or cares what is inside a payload.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { boot } from "../server.js";
import { StubFacilitator } from "../facilitator.js";
import { canonicalize, cidOf } from "../substrate.js";
import type { AddressInfo } from "node:net";

const MANIFESTS = path.resolve(__dirname, "../../../manifests");
const PACKS = path.resolve(__dirname, "../../packs");
const PAY_TO = "0x0000000000000000000000000000000000000dev";
const RAW_EDITION = "heatmap-raw-2026-08";

/** Build a manifests dir whose single mount points at the binary pack. */
function manifestsForRawPack(dir: string): string {
  const md = path.join(dir, "manifests");
  mkdirSync(md, { recursive: true });
  cpSync(MANIFESTS, md, { recursive: true });

  const routes = JSON.parse(readFileSync(path.join(md, "x402-routes.json"), "utf8"));
  const m = routes.mounts[0];
  m.mountId = "heatmap-raw";
  m.edition = RAW_EDITION;
  m.substrate.packRef = RAW_EDITION;
  for (const r of m.routes) r.pathTemplate = r.pathTemplate.replace("/roblox-luau/", "/heatmap-raw/");
  writeFileSync(path.join(md, "x402-routes.json"), JSON.stringify(routes, null, 2) + "\n");

  // Re-seal the lock over the edited artifact — the ONLY legitimate way to
  // change what the kernel will boot. (The refusal path is covered by
  // evidence.test.ts, which tampers without re-sealing.)
  const lock = JSON.parse(readFileSync(path.join(md, "generated.lock"), "utf8"));
  lock.artifacts["x402-routes.json"] = cidOf(routes);
  writeFileSync(path.join(md, "generated.lock"), JSON.stringify(lock, null, 2) + "\n");
  return md;
}

test("serves raw binary payloads verbatim with the declared media type", async (t) => {
  if (!existsSync(path.join(PACKS, `${RAW_EDITION}.dat`))) {
    t.skip(`binary pack absent — run: node dist/make-pack-raw.js ./packs ${RAW_EDITION} 32 3072`);
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "x402-agnostic-"));
  try {
    const md = manifestsForRawPack(dir);
    const b = await boot({
      manifestsDir: md,
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
      const mount = b.mounts.get("heatmap-raw")!;
      assert.equal(mount.substrate.payloadContentType, "application/octet-stream");
      const cid = (mount.substrate.getManifest().tiles as string[])[0];

      const payment = Buffer.from(
        JSON.stringify({
          scheme: "exact",
          network: "eip155:84532",
          payer: "0xBUYER",
          nonce: "raw-1",
          amountAtomic: "500",
          asset: "USDC",
          payTo: PAY_TO,
        })
      ).toString("base64");

      const res = await fetch(`${url}/heatmap-raw/tile/${cid}`, {
        headers: { "x-payment-id": "pay-raw-000000001", "x-payment": payment },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/octet-stream");

      const bytes = Buffer.from(await res.arrayBuffer());

      // Verbatim: the delivered bytes hash to the cid that named them.
      const digest = createHash("blake2b512").update(bytes).digest().subarray(0, 32).toString("hex");
      assert.equal(`b2-256:${digest}`, cid, "delivered bytes must hash to the requested cid");

      // And they are genuinely binary — a real f32 vector, not JSON.
      assert.equal(bytes.subarray(0, 4).toString("ascii"), "SPCT", "binary header survived transit");
      assert.equal(bytes.readUInt32LE(8), 3072, "declared dimensionality survived transit");
      assert.equal(bytes.length, 16 + 3072 * 4);
      assert.throws(() => JSON.parse(bytes.toString("utf8")), "payload is NOT json — proving the kernel never parsed it");

      const first = bytes.readFloatLE(16);
      assert.ok(Number.isFinite(first) && Math.abs(first) <= 1, `first component ${first} is a real f32`);

      // Replay works identically for binary.
      const again = await fetch(`${url}/heatmap-raw/tile/${cid}`, { headers: { "x-payment-id": "pay-raw-000000001" } });
      assert.equal(again.status, 200);
      assert.equal(again.headers.get("x-replayed"), "true");
      assert.deepEqual(Buffer.from(await again.arrayBuffer()), bytes);
    } finally {
      b.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canonicalize refuses a float, so a producer cannot silently break cids", () => {
  assert.throws(
    () => canonicalize({ heat: 0.5 }),
    (e: unknown) => (e as { code?: string }).code === "CANON_FLOAT"
  );
  assert.doesNotThrow(() => canonicalize({ heat: "0.5" }));
});
