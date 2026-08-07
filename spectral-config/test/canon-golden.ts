/**
 * canon-golden.ts — golden-vector generator/validator for canon_version 1.
 *
 * Default: recompute every vector's cid and compare against golden/vectors.json.
 * `--write`: regenerate the file (do this only on a deliberate canon change,
 * which is a new canon_version, not an edit to this one).
 *
 * The Python reference (golden/canon_ref.py) reads the same file and must
 * produce identical cids — that differential is the actual test.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, cidOf } from "../src/canon.js";

const here = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = join(here, "golden", "vectors.json");

// Case 3 is the load-bearing one: U+1D11E (𝄞, surrogate pair D834 DD1E) vs
// U+FF01 (！). UTF-16 code-unit order puts 𝄞 FIRST; naive Python code-point
// sort puts it LAST. A Python twin that sorts naively fails exactly here.
const CASES: Array<{ name: string; body: unknown }> = [
  { name: "empty-object", body: {} },
  {
    name: "key-sort-bmp",
    body: { b: 1, a: 2, Z: 3, "~": 4, "é": 5, "0": 6, " ": 7 },
  },
  {
    name: "key-sort-astral-vs-bmp",
    body: { "\u{1D11E}": 1, "！": 2 },
  },
  {
    name: "nesting-and-primitives",
    body: {
      nul: null,
      t: true,
      f: false,
      ints: [0, 1, -1, 42, 9007199254740991, -9007199254740991],
      deep: { a: [{ b: [{ c: null }] }] },
      empty_arr: [],
      empty_obj: {},
    },
  },
  {
    name: "string-escapes",
    body: {
      quote: 'say "hi"',
      backslash: "a\\b",
      tab_newline: "col1\tcol2\nrow2",
      accents_nfc: "café résumé",
      emoji_paired: "🎮 terrain 🗺️",
      slash: "a/b",
    },
  },
  {
    name: "decimal-strings-and-vecref-shape",
    body: {
      shatter: "1.2681",
      heat: "-0.0431",
      exp: "1.7320508075688772e0",
      vec: { b64: "AAAAAAAA8D8AAAAAAAAAQA==", count: 2, dtype: "f64le" },
    },
  },
  {
    name: "tile-shaped",
    body: {
      schema: "terrain-tile-v1",
      canon_version: 1,
      domain: "roblox-luau",
      prev_cid: null,
      scores: { corpus_support: 228, shatter: "1.2681", shatter_scale: "concat-sqrt3-l2" },
      window: {
        t_now: { epoch_ms: 1754380800000, tick: "12345.671875" },
      },
    },
  },
];

const write = process.argv.includes("--write");

if (write) {
  const vectors = CASES.map((c) => ({
    name: c.name,
    body: c.body,
    canonical_utf8_b64: canonicalize(c.body).toString("base64"),
    expected_cid: cidOf(c.body),
  }));
  writeFileSync(VECTORS_PATH, JSON.stringify(vectors, null, 2) + "\n", "utf8");
  console.log(`wrote ${vectors.length} golden vectors → ${VECTORS_PATH}`);
  process.exit(0);
}

const vectors: Array<{ name: string; body: unknown; canonical_utf8_b64: string; expected_cid: string }> =
  JSON.parse(readFileSync(VECTORS_PATH, "utf8"));

let failed = 0;
for (const v of vectors) {
  const canonical = canonicalize(v.body).toString("base64");
  const cid = cidOf(v.body);
  if (canonical !== v.canonical_utf8_b64) {
    console.error(`FAIL ${v.name}: canonical bytes drifted`);
    failed++;
  } else if (cid !== v.expected_cid) {
    console.error(`FAIL ${v.name}: cid drifted (${cid} != ${v.expected_cid})`);
    failed++;
  } else {
    console.log(`ok   ${v.name}  ${cid.slice(0, 24)}…`);
  }
}
if (failed > 0) {
  console.error(`${failed}/${vectors.length} golden vectors FAILED — canon_version 1 has drifted`);
  process.exit(1);
}
console.log(`${vectors.length}/${vectors.length} golden vectors verified (TS)`);
