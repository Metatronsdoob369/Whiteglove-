/**
 * make-pack-raw.ts — proof that the kernel is payload-agnostic.
 *
 * Builds a pack whose payloads are RAW BINARY (little-endian f32 vectors),
 * not JSON. Nothing in the kernel changes: it addresses opaque bytes by
 * content hash, serves them verbatim, and reports the media type the sealed
 * manifest declares. Any producer that can emit bytes + a content type can
 * feed this server.
 *
 * Usage: node dist/make-pack-raw.js <outDir> <edition> [count] [dims]
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { cidOf, merkleRoot } from "./substrate.js";

function b2_256(b: Buffer): Buffer {
  return Buffer.from(createHash("blake2b512").update(b).digest().subarray(0, 32));
}

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
}

const outDir = process.argv[2] ?? "./packs";
const edition = process.argv[3] ?? "heatmap-raw-2026-08";
const count = Number(process.argv[4] ?? 32);
const dims = Number(process.argv[5] ?? 3072);

mkdirSync(outDir, { recursive: true });
const base = path.join(outDir, edition);
const trustPath = path.join(outDir, "terrain-keys.json");
const keyPath = path.join(outDir, ".signing-key.pem");
const signerId = "nodeout-terrain-2026a";

let privateKeyPem: string;
if (existsSync(trustPath) && existsSync(keyPath)) {
  privateKeyPem = readFileSync(keyPath, "utf8");
} else {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
  writeFileSync(
    trustPath,
    JSON.stringify(
      {
        [signerId]: {
          public_key_b64: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
          valid_from: "2026-08-01T00:00:00Z",
          valid_until: null,
          status: "active",
          scopes: ["tile", "pack", "status"],
        },
      },
      null,
      2
    ) + "\n"
  );
}

// Payloads: pure binary. A 16-byte header then dims × f32le. No JSON anywhere.
const items: Array<{ cid: string; bytes: Buffer }> = [];
for (let i = 0; i < count; i++) {
  const r = prng(0xbeef + i);
  const buf = Buffer.alloc(16 + dims * 4);
  buf.write("SPCT", 0, "ascii");
  buf.writeUInt32LE(1, 4);
  buf.writeUInt32LE(dims, 8);
  buf.writeUInt32LE(i, 12);
  for (let d = 0; d < dims; d++) buf.writeFloatLE(Math.fround((r() - 0.5) * 2), 16 + d * 4);
  items.push({ cid: `b2-256:${b2_256(buf).toString("hex")}`, bytes: buf });
}
items.sort((a, b) => (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));

const REC = 44;
const idx = Buffer.alloc(4 + items.length * REC);
idx.writeUInt32LE(items.length, 0);
let offset = 0;
const parts: Buffer[] = [];
items.forEach((t, i) => {
  Buffer.from(t.cid.slice(7), "hex").copy(idx, 4 + i * REC);
  idx.writeBigUInt64LE(BigInt(offset), 4 + i * REC + 32);
  idx.writeUInt32LE(t.bytes.length, 4 + i * REC + 40);
  parts.push(t.bytes);
  offset += t.bytes.length;
});
const dat = Buffer.concat(parts);
const root = merkleRoot(items.map((t) => Buffer.from(t.cid.slice(7), "hex")));

const manifestBody = {
  schema: "terrain-pack-v1",
  canon_version: 1,
  pack_exclusions: ["/seal"],
  domain: "heatmap-raw",
  edition,
  snapshot: { cut_at: "2026-08-05T00:00:00Z", window_from: "2026-08-01T00:00:00Z", window_to: "2026-08-05T00:00:00Z" },
  prev_pack_cid: null,
  tiles: items.map((t) => t.cid),
  tile_count: items.length,
  merkle_root: root.toString("hex"),
  // The payload is binary and the manifest says so. That single declaration
  // is the ENTIRE contract between a producer and this server.
  payload_content_type: "application/octet-stream",
  payload_note: `SPCT v1 header (16B) + ${dims} × f32le`,
  geometry: {
    profile: "raw-vector",
    embed_model: "mxbai-embed-large",
    dim_per_third: dims / 3,
    concat_dim: dims,
    norm_convention: "per-third-unit-kahan",
    shatter_scale: "concat-sqrt3-l2",
  },
  centroid: { centroid_cid: cidOf({ schema: "terrain-centroid-v1", domain: "heatmap-raw" }), corpus_size: count, stability: null, stability_target: "0.008" },
  silence: { gate: "exact-match", signal: "content-address" },
  confidence_model: null,
  knn: null,
  license_summary: { spdx_counts: { "CC-BY-4.0": items.length }, derivative_release: "geometry-only" },
  redaction_totals: { source_text_withheld: items.length },
  status_list_ref: "heatmap-raw-status",
  carrier_note: "Raw spectral vectors. Payload is binary; the kernel never parses it.",
};

const manifestCid = cidOf(manifestBody);
const sig = edSign(
  null,
  Buffer.concat([Buffer.from("terrain-seal-v1", "utf8"), Buffer.from([0]), Buffer.from(manifestCid.slice(7), "hex")]),
  privateKeyPem
);

writeFileSync(base + ".idx", idx);
writeFileSync(base + ".dat", dat);
writeFileSync(base + ".manifest.json", JSON.stringify(manifestBody, null, 2) + "\n");
writeFileSync(
  base + ".seal.json",
  JSON.stringify(
    { seal_schema: "terrain-seal-v1", cid: manifestCid, canon_version: 1, signer: signerId, sig: sig.toString("base64"), signed_at: "2026-08-05T00:00:00Z", sig_scope: "pack" },
    null,
    2
  ) + "\n"
);

console.log(`Sealed ${edition} — BINARY payloads`);
console.log(`  items       ${items.length} × ${dims}-D f32`);
console.log(`  dat         ${(dat.length / 1024).toFixed(1)} KB (${16 + dims * 4} B each)`);
console.log(`  media type  application/octet-stream`);
console.log(`  first cid   ${items[0].cid}`);
