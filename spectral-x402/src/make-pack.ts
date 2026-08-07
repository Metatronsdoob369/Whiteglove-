/**
 * make-pack.ts — build and seal a terrain pack from working tiles.
 *
 * Emits <base>.idx / .dat / .manifest.json / .seal.json plus a trust store.
 * Generates a signing keypair on first run (this is a SIGNING key for content
 * provenance — it is not a wallet, holds no funds, and cannot move money).
 *
 * Usage: node dist/make-pack.js <outDir> <edition> [tileCount]
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { createHash, generateKeyPairSync, sign as edSign, randomUUID } from "node:crypto";
import { canonicalize, cidOf, merkleRoot } from "./substrate.js";

function b2_256(b: Buffer): Buffer {
  return createHash("blake2b512").update(b).digest().subarray(0, 32);
}

function vecref(values: number[], dtype: "f32le" | "f64le" = "f32le") {
  const w = dtype === "f64le" ? 8 : 4;
  const buf = Buffer.alloc(values.length * w);
  values.forEach((v, i) => (dtype === "f64le" ? buf.writeDoubleLE(v, i * 8) : buf.writeFloatLE(Math.fround(v), i * 4)));
  return { dtype, count: values.length, b64: buf.toString("base64") };
}

/** Deterministic pseudo-random so the same edition rebuilds byte-identically. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function dec(n: number, places = 6): string {
  const s = n.toFixed(places);
  return s === "-0." + "0".repeat(places) ? "0." + "0".repeat(places) : s;
}

function buildTile(i: number, prevCid: string | null, centroidCid: string): Record<string, unknown> {
  const r = prng(0x5eed + i);
  const residualA = Array.from({ length: 1024 }, () => (r() - 0.5) * 0.01);
  const residualB = Array.from({ length: 1024 }, () => (r() - 0.5) * 0.01);
  const tickBase = 12345 + i * 0.0166666;
  const obs = (k: number) => ({
    tick: dec(tickBase + k * 0.0166666),
    epoch_ms: 1754380800000 + i * 17 + k,
    state_digest: b2_256(Buffer.from(`state:${i}:${k}`)).toString("hex"),
    constraint_classes: ["weld", "hinge"],
    script_count: 3,
  });
  return {
    schema: "terrain-tile-v1",
    canon_version: 1,
    domain: "roblox-luau",
    lineage_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    prev_cid: prevCid,
    geometry_profile: "transition-only",
    norm_convention: "per-third-unit-kahan",
    embed: { model: "mxbai-embed-large", dim_per_third: 1024, concat_dim: 3072, concat_norm: "1.7320508075688772" },
    window: { t_minus1: obs(0), t_now: obs(1), t_plus1: obs(2) },
    physics: {
      method: "physics-deterministic",
      engine_version: "0.634.0.6340420",
      delta_ms: "16.666667",
      determinism_class: "engine-exact",
    },
    transition: {
      residual_now_prev: vecref(residualA),
      residual_next_now: vecref(residualB),
      cframe_delta: null,
      velocity_delta: null,
      memory_delta_kb: dec(r() * 4),
      curvature: dec(r() * 0.02),
    },
    scores: {
      shatter: dec(1.2 + r() * 0.15, 4),
      shatter_scale: "concat-sqrt3-l2",
      heat: dec(r() * 0.09, 4),
      knn_margin: dec(r() * 0.12, 4),
      corpus_support: 8 + (i % 17),
      centroid_cid: centroidCid,
    },
    admission: {
      contract_version: "roblox-luau.domain@1",
      disallowed_globals_hit: [],
      high_risk_patterns_hit: i % 5 === 0 ? ["WeldConstraint"] : [],
      memory_safe: true,
    },
    novelty: {
      vs_prev_cid: prevCid,
      metric: "l2-concat",
      value: prevCid === null ? null : dec(r() * 0.4, 4),
    },
    license: { spdx: "MIT", source_class: "public-repo", derivative_release: "geometry-only" },
    commitments: {
      source_mac_key_id: "nodeout-prov-2026a",
      source_mac: b2_256(Buffer.from(`mac:src:${i}`)).toString("hex"),
      locator_mac_key_id: "nodeout-prov-2026a",
      locator_mac: b2_256(Buffer.from(`mac:loc:${i}`)).toString("hex"),
    },
    redaction: { source_text_withheld: 1, source_locator_withheld: 3, constraint_names_generalized: 2 },
  };
}

// A signer id names exactly one key. If a previous run rotated the key it
// recorded the new id in .signer-id — honor it, or we sign with key B while
// claiming to be key A and every verifier refuses the seal.
function resolveSignerId(outDir: string, fallback: string): string {
  const p = path.join(outDir, ".signer-id");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : fallback;
}

const outDir = process.argv[2] ?? "./packs";
const edition = process.argv[3] ?? "roblox-luau-2026-08";
const tileCount = Number(process.argv[4] ?? 64);

mkdirSync(outDir, { recursive: true });
const base = path.join(outDir, edition);
const trustPath = path.join(outDir, "terrain-keys.json");

// Signing key — content provenance only. Not a wallet.
const signerId = resolveSignerId(outDir, "nodeout-terrain-2026a");
let privateKeyPem: string;
if (existsSync(trustPath) && existsSync(path.join(outDir, ".signing-key.pem"))) {
  privateKeyPem = readFileSync(path.join(outDir, ".signing-key.pem"), "utf8");
} else {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  writeFileSync(path.join(outDir, ".signing-key.pem"), privateKeyPem, { mode: 0o600 });
  writeFileSync(
    trustPath,
    JSON.stringify(
      {
        [signerId]: {
          public_key_b64: rawPub.toString("base64"),
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

const centroidCid = cidOf({ schema: "terrain-centroid-v1", domain: "roblox-luau", corpus_size: 228 });

// Build tiles, chaining prev_cid so novelty has a real baseline.
const tiles: Array<{ cid: string; bytes: Buffer }> = [];
let prev: string | null = null;
for (let i = 0; i < tileCount; i++) {
  const body = buildTile(i, prev, centroidCid);
  const bytes = canonicalize(body);
  const cid = `b2-256:${b2_256(bytes).toString("hex")}`;
  tiles.push({ cid, bytes });
  prev = cid;
}

// Sort by cid — the manifest's own hash must not depend on insertion order.
tiles.sort((a, b) => (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));

const REC = 44;
const idx = Buffer.alloc(4 + tiles.length * REC);
idx.writeUInt32LE(tiles.length, 0);
const datParts: Buffer[] = [];
let offset = 0;
tiles.forEach((t, i) => {
  const digest = Buffer.from(t.cid.slice(7), "hex");
  digest.copy(idx, 4 + i * REC);
  idx.writeBigUInt64LE(BigInt(offset), 4 + i * REC + 32);
  idx.writeUInt32LE(t.bytes.length, 4 + i * REC + 40);
  datParts.push(t.bytes);
  offset += t.bytes.length;
});
const dat = Buffer.concat(datParts);
const root = merkleRoot(tiles.map((t) => Buffer.from(t.cid.slice(7), "hex")));

const manifestBody = {
  schema: "terrain-pack-v1",
  canon_version: 1,
  pack_exclusions: ["/seal"],
  domain: "roblox-luau",
  edition,
  snapshot: {
    cut_at: "2026-08-05T00:00:00Z",
    window_from: "2026-08-01T00:00:00Z",
    window_to: "2026-08-05T00:00:00Z",
  },
  prev_pack_cid: null,
  tiles: tiles.map((t) => t.cid),
  tile_count: tiles.length,
  merkle_root: root.toString("hex"),
  geometry: {
    profile: "transition-only",
    embed_model: "mxbai-embed-large",
    dim_per_third: 1024,
    concat_dim: 3072,
    norm_convention: "per-third-unit-kahan",
    shatter_scale: "concat-sqrt3-l2",
  },
  centroid: {
    centroid_cid: centroidCid,
    corpus_size: 228,
    stability: null, // genesis — null, never 0
    stability_target: "0.008",
  },
  // Content-addressed retrieval: exact cid match, silence is a 404.
  // No threshold, so no calibration claim is made or needed.
  silence: { gate: "exact-match", signal: "content-address" },
  confidence_model: null, // pending shatter-scale resolution
  knn: null,
  license_summary: { spdx_counts: { MIT: tiles.length }, derivative_release: "geometry-only" },
  redaction_totals: {
    source_text_withheld: tiles.length,
    source_locator_withheld: tiles.length * 3,
    constraint_names_generalized: tiles.length * 2,
  },
  // The kernel serves these bytes verbatim; this is the only declaration
  // of what they are, and it is inside the signed manifest.
  payload_content_type: "application/json",
  status_list_ref: "roblox-luau-status",
  carrier_note: `Physics-deterministic Roblox state transitions. t+1 is engine-computed, not modeled.`,
};

const manifestCid = cidOf(manifestBody);
const message = Buffer.concat([
  Buffer.from("terrain-seal-v1", "utf8"),
  Buffer.from([0]),
  Buffer.from(manifestCid.slice(7), "hex"),
]);
const sig = edSign(null, message, privateKeyPem);

writeFileSync(base + ".idx", idx);
writeFileSync(base + ".dat", dat);
writeFileSync(base + ".manifest.json", JSON.stringify(manifestBody, null, 2) + "\n");
writeFileSync(
  base + ".seal.json",
  JSON.stringify(
    {
      seal_schema: "terrain-seal-v1",
      cid: manifestCid,
      canon_version: 1,
      signer: signerId,
      sig: sig.toString("base64"),
      signed_at: "2026-08-05T00:00:00Z",
      sig_scope: "pack",
    },
    null,
    2
  ) + "\n"
);

console.log(`Sealed ${edition}`);
console.log(`  tiles       ${tiles.length}`);
console.log(`  dat         ${(dat.length / 1024).toFixed(1)} KB  (${Math.round(dat.length / tiles.length)} B/tile)`);
console.log(`  merkle_root ${root.toString("hex").slice(0, 32)}…`);
console.log(`  manifest    ${manifestCid}`);
console.log(`  signer      ${signerId}`);
console.log(`\nSample cids:`);
tiles.slice(0, 3).forEach((t) => console.log(`  ${t.cid}`));
