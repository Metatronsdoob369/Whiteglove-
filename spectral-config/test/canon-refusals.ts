/**
 * canon-refusals.ts — adversarial fixtures for canon_version 1 and
 * terrain-tile-v1 admission. Exit-code style, matching refusal-check.ts:
 * every hostile input MUST refuse, every clean input MUST pass, and a
 * refusal that stops happening is a test failure.
 */
import {
  canonicalize,
  cidOf,
  CanonRefusal,
  isDecimalString,
  encodeVecref,
  decodeVecref,
} from "../src/canon.js";
import { admitSealedTile, findForbiddenKeys } from "../src/tile.schema.js";

let failures = 0;

function mustRefuse(name: string, fn: () => void, expectCode?: string): void {
  try {
    fn();
    console.error(`FAIL ${name}: expected refusal, got acceptance`);
    failures++;
  } catch (e) {
    if (e instanceof CanonRefusal && (!expectCode || e.code === expectCode)) {
      console.log(`ok   ${name} → ${e.code}`);
    } else if (!expectCode) {
      console.log(`ok   ${name} → refused`);
    } else {
      console.error(`FAIL ${name}: wrong refusal ${(e as Error).message}`);
      failures++;
    }
  }
}

function mustPass(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}: unexpected refusal: ${(e as Error).message}`);
    failures++;
  }
}

function assert(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`ok   ${name}`);
  else {
    console.error(`FAIL ${name} ${detail}`);
    failures++;
  }
}

// ─── canon refusals ──────────────────────────────────────────────────────────

mustRefuse("float", () => canonicalize({ x: 1.5 }), "CANON_FLOAT_REFUSED");
mustRefuse("NaN", () => canonicalize({ x: NaN }), "CANON_FLOAT_REFUSED");
mustRefuse("Infinity", () => canonicalize({ x: Infinity }), "CANON_FLOAT_REFUSED");
mustRefuse("negative-zero", () => canonicalize({ x: -0 }), "CANON_NEG_ZERO");
mustRefuse("int-overflow", () => canonicalize({ x: 2 ** 53 }), "CANON_INT_RANGE");
mustRefuse("non-nfc-string", () => canonicalize({ x: "cafe\u0301" }), "CANON_NON_NFC");
mustRefuse("lone-surrogate", () => canonicalize({ x: "\uD800" }), "CANON_UNPAIRED_SURROGATE");
mustRefuse("bidi-override", () => canonicalize({ x: "a\u202Eb" }), "CANON_FORBIDDEN_CODEPOINT");
mustRefuse("zero-width-joiner", () => canonicalize({ x: "a\u200Db" }), "CANON_FORBIDDEN_CODEPOINT");
mustRefuse("bom-in-string", () => canonicalize({ x: "\uFEFFhello" }), "CANON_FORBIDDEN_CODEPOINT");
mustRefuse("bell-control", () => canonicalize({ x: "a\u0007b" }), "CANON_FORBIDDEN_CODEPOINT");
mustRefuse("c1-control", () => canonicalize({ x: "a\u0085b" }), "CANON_FORBIDDEN_CODEPOINT");
mustRefuse("soft-hyphen-cf", () => canonicalize({ x: "a\u00ADb" }), "CANON_FORBIDDEN_CODEPOINT");
mustRefuse("date-object", () => canonicalize({ x: new Date(0) }), "CANON_INVALID_TYPE");
mustRefuse("undefined-value", () => canonicalize({ x: undefined }), "CANON_INVALID_TYPE");
mustRefuse("forbidden-key-content", () => canonicalize({ k: "a\u200Bb" }), "CANON_FORBIDDEN_CODEPOINT");

mustPass("tab-and-newline-allowed", () => canonicalize({ x: "a\tb\nc" }));
mustPass("safe-int-bounds", () => canonicalize({ x: 9007199254740991, y: -9007199254740991 }));
mustPass("nfc-accents", () => canonicalize({ x: "caf\u00E9" }));
mustPass("paired-emoji", () => canonicalize({ x: "🎮" }));

assert("determinism", cidOf({ a: 1, b: [true, null] }) === cidOf({ b: [true, null], a: 1 }));
assert(
  "one-byte-sensitivity",
  cidOf({ a: 1 }) !== cidOf({ a: 2 })
);

// ─── decimal strings ─────────────────────────────────────────────────────────

assert("dec: plain", isDecimalString("1.2681"));
assert("dec: negative", isDecimalString("-0.0431"));
assert("dec: exponent", isDecimalString("1.7320508075688772e0"));
assert("dec: integerish", isDecimalString("42"));
assert("dec: refuse -0", !isDecimalString("-0"));
assert("dec: refuse -0.000", !isDecimalString("-0.000"));
assert("dec: refuse leading zeros", !isDecimalString("01.5"));
assert("dec: refuse trailing dot", !isDecimalString("1."));
assert("dec: refuse NaN", !isDecimalString("NaN"));
assert("dec: refuse empty", !isDecimalString(""));

// ─── vecref ──────────────────────────────────────────────────────────────────

{
  const src = [1.0, 2.0, -0.5, 1 / 3];
  const ref = encodeVecref(src, "f64le");
  const back = decodeVecref(ref);
  assert(
    "vecref f64 roundtrip exact",
    src.every((v, i) => Object.is(v, back[i]))
  );
  mustRefuse("vecref non-finite", () => encodeVecref([NaN], "f64le"));
  mustRefuse("vecref length mismatch", () =>
    decodeVecref({ dtype: "f64le", count: 3, b64: ref.b64 })
  );
}

// ─── forbidden keys ──────────────────────────────────────────────────────────

const forbiddenCases: Array<[string, unknown]> = [
  ["top-level source", { source: "local x = 1" }],
  ["nested source", { a: { b: [{ source: "x" }] } }],
  ["camelCase sourceText", { sourceText: "x" }],
  ["kebab repo-url", { "repo-url": "https://github.com/x" }],
  ["snake script_name", { script_name: "Main.server.luau" }],
  ["signature field", { signature: "ed25519:..." }],
  ["embedded cid", { cid: "b2-256:00" }],
  ["updated_at", { updated_at: "2026-08-05T00:00:00Z" }],
  ["pack_id in tile", { pack_id: "p1" }],
  ["neighbors in tile", { neighbors: [] }],
  ["alg field", { alg: "EdDSA" }],
  ["public_key_ref", { public_key_ref: "s3://keys/x.pub" }],
  ["redaction_summary", { redaction_summary: "removed patient identifiers" }],
  ["confidence scalar", { confidence: 92 }],
];
for (const [name, obj] of forbiddenCases) {
  assert(`forbidden: ${name}`, findForbiddenKeys(obj).length > 0);
}
assert("allowed: prev_cid is not cid", findForbiddenKeys({ prev_cid: null }).length === 0);
assert("allowed: source_class is not source", findForbiddenKeys({ source_class: "public-repo" }).length === 0);
assert("allowed: script_count is not scripts", findForbiddenKeys({ script_count: 3 }).length === 0);
assert(
  "allowed: source_mac flat commitments",
  findForbiddenKeys({ source_mac: "ab", source_mac_key_id: "k1", locator_mac: "cd" }).length === 0
);

// ─── sealed tile admission ───────────────────────────────────────────────────

const CID0 = `b2-256:${"0".repeat(64)}`;
const HEX64 = "a".repeat(64);

function validObservation() {
  return {
    tick: "12345.671875",
    epoch_ms: 1754380800000,
    state_digest: HEX64,
    constraint_classes: ["weld"],
    script_count: 3,
  };
}

function validTile(): Record<string, unknown> {
  const residual = encodeVecref(new Array(1024).fill(0.001), "f32le");
  return {
    schema: "terrain-tile-v1",
    canon_version: 1,
    domain: "roblox-luau",
    lineage_id: "6c0eff34-2f3a-4b0a-9c3d-8f6a1e2b4d5c",
    prev_cid: null,
    geometry_profile: "transition-only",
    norm_convention: "per-third-unit-kahan",
    embed: {
      model: "mxbai-embed-large",
      dim_per_third: 1024,
      concat_dim: 3072,
      concat_norm: "1.7320508075688772",
    },
    window: {
      t_minus1: validObservation(),
      t_now: validObservation(),
      t_plus1: validObservation(),
    },
    physics: {
      method: "physics-deterministic",
      engine_version: "0.634.0.6340420",
      delta_ms: "16.666666666666668",
      determinism_class: "engine-exact",
    },
    transition: {
      residual_now_prev: residual,
      residual_next_now: residual,
      cframe_delta: null,
      velocity_delta: null,
      memory_delta_kb: "1.25",
      curvature: "0.0042",
    },
    scores: {
      shatter: "1.2681",
      shatter_scale: "concat-sqrt3-l2",
      heat: "0.0431",
      knn_margin: "0.0812",
      corpus_support: 12,
      centroid_cid: CID0,
    },
    admission: {
      contract_version: "roblox-luau.domain@1",
      disallowed_globals_hit: [],
      high_risk_patterns_hit: [],
      memory_safe: true,
    },
    novelty: { vs_prev_cid: null, metric: "l2-concat", value: null },
    license: {
      spdx: "MIT",
      source_class: "public-repo",
      derivative_release: "geometry-only",
    },
    commitments: {
      source_mac_key_id: "nodeout-prov-2026a",
      source_mac: HEX64,
      locator_mac_key_id: "nodeout-prov-2026a",
      locator_mac: HEX64,
    },
    redaction: { source_text_withheld: 1, source_locator_withheld: 3 },
  };
}

{
  const r = admitSealedTile(validTile());
  assert("sealed: valid tile admits", r.ok, r.ok ? "" : JSON.stringify(r.refusals));
  if (r.ok) {
    mustPass("sealed: valid tile canonicalizes", () => cidOf(validTile()));
  }
}
{
  const t = validTile();
  (t as Record<string, unknown>)["source"] = "local x = 1";
  const r = admitSealedTile(t);
  assert("sealed: smuggled source refused as FORBIDDEN_KEY", !r.ok && r.refusals[0].code === "FORBIDDEN_KEY");
}
{
  const t = validTile();
  (t.novelty as Record<string, unknown>)["vs_prev_cid"] = CID0; // ≠ prev_cid (null)
  const r = admitSealedTile(t);
  assert("sealed: novelty/prev mismatch refused", !r.ok);
}
{
  const t = validTile();
  (t.window as Record<string, Record<string, unknown>>)["t_now"]["vec"] =
    encodeVecref(new Array(1024).fill(0.01), "f32le");
  const r = admitSealedTile(t);
  assert("sealed: raw embedding on transition-only refused", !r.ok);
}
{
  const t = validTile();
  (t.license as Record<string, unknown>)["spdx"] = "NOASSERTION";
  const r = admitSealedTile(t);
  assert("sealed: NOASSERTION license refused", !r.ok && r.refusals.some((x) => x.code === "LICENSE_DENIED"));
}
{
  const t = validTile();
  (t as Record<string, unknown>)["extra_field"] = 1;
  const r = admitSealedTile(t);
  assert("sealed: unknown key refused (strict)", !r.ok);
}
{
  const t = validTile();
  (t.physics as Record<string, unknown>)["method"] = "placeholder";
  const r = admitSealedTile(t);
  assert("sealed: placeholder t+1 refused", !r.ok);
}
{
  const t = validTile();
  (t.scores as Record<string, unknown>)["shatter"] = 1.2681; // float, not decimal string
  const r = admitSealedTile(t);
  assert("sealed: float score refused by schema", !r.ok);
}

// ─── verdict ─────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} adversarial fixture(s) FAILED`);
  process.exit(1);
}
console.log("\nall adversarial fixtures passed — refusals hold");
