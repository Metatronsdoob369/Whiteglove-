/**
 * Two-layer guarantee check (FOLD_SPEC "Two-layer guarantee") — CI-gateable.
 *
 *   Layer 1 — schema refusal (HARD): malformed STRUCTURE is rejected at
 *   parse. Five adversarial manifests must throw.
 *
 *   Layer 2 — dimension audit (SOFT): a structurally-valid pipeline that
 *   breaks the dim RULE is flagged, not refused. The adversarial case: a
 *   static pipeline at 3072-D must parse fine AND appear in auditDimensions().
 *
 * The layers are different guarantees — refusal proves structure, audit
 * flags policy. This check fails (exit 1) if either layer leaks into the
 * other's job.
 */
import { parseManifest, auditDimensions } from "./manifest.schema.js";
import domains from "../config/domains.config.js";

let failures = 0;
const clone = (): any => JSON.parse(JSON.stringify(domains));

// ── Layer 1: schema refusal ─────────────────────────────────────────
const refusals: Array<{ name: string; mutate: (m: any) => void }> = [
  { name: "unknown geometry", mutate: (m) => (m.pipelines[0].geometry = "vibes") },
  { name: "negative dims", mutate: (m) => (m.pipelines[1].dimensionality.dims = -768) },
  { name: "missing silence policy", mutate: (m) => delete m.pipelines[2].silence },
  { name: "non-kebab id", mutate: (m) => (m.pipelines[3].id = "Arbiter LegalEngine!") },
  { name: "empty dimensionality rationale", mutate: (m) => (m.pipelines[4].dimensionality.rationale = "") },
];

for (const c of refusals) {
  const m = clone();
  c.mutate(m);
  try {
    parseManifest(m);
    console.log(`✗ ACCEPTED (schema hole): ${c.name}`);
    failures++;
  } catch {
    console.log(`✓ refused: ${c.name}`);
  }
}

// ── Layer 2: audit flags without refusing ───────────────────────────
const hot = clone();
const idx = hot.pipelines.findIndex(
  (p: any) => !p.dimensionality.temporalAxis && p.dimensionality.dims <= hot.dimensionPolicy.maxStaticDims
);
hot.pipelines[idx].dimensionality.dims = 3072; // static pipeline running hot — valid manifest, broken rule

try {
  const parsed = parseManifest(hot);
  const flagged = auditDimensions(parsed).some((v) => v.id === parsed.pipelines[idx].id);
  if (flagged) {
    console.log(`✓ layers distinct: static 3072-D "${parsed.pipelines[idx].id}" parsed fine AND was flagged by the audit`);
  } else {
    console.log(`✗ audit MISSED a static 3072-D pipeline ("${parsed.pipelines[idx].id}")`);
    failures++;
  }
} catch {
  console.log("✗ schema REFUSED a structurally-valid hot pipeline — layers conflated");
  failures++;
}

console.log(failures === 0 ? "\nAll two-layer checks passed (6/6)." : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
