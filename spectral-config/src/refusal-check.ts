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
import { parseManifest, auditDimensions, auditSealPolicy } from "./manifest.schema.js";
import domains from "../config/domains.config.js";

let failures = 0;
const clone = (): any => JSON.parse(JSON.stringify(domains));
const commercialIdx = (m: any): number => m.pipelines.findIndex((p: any) => p.commercial);

// ── Layer 1: schema refusal ─────────────────────────────────────────
const refusals: Array<{ name: string; mutate: (m: any) => void }> = [
  { name: "unknown geometry", mutate: (m) => (m.pipelines[0].geometry = "vibes") },
  { name: "negative dims", mutate: (m) => (m.pipelines[1].dimensionality.dims = -768) },
  { name: "missing silence policy", mutate: (m) => delete m.pipelines[2].silence },
  { name: "non-kebab id", mutate: (m) => (m.pipelines[3].id = "Arbiter LegalEngine!") },
  { name: "empty dimensionality rationale", mutate: (m) => (m.pipelines[4].dimensionality.rationale = "") },
  // commercial refusals — payment can never authorize what these declare
  { name: "state-changing paid mount", mutate: (m) => (m.pipelines[commercialIdx(m)].commercial.effect = "state_changing") },
  { name: "non-replay-safe paid mount", mutate: (m) => (m.pipelines[commercialIdx(m)].commercial.replaySafe = false) },
  { name: "sealed-paid without commercial block", mutate: (m) => { const i = commercialIdx(m); delete m.pipelines[i].commercial; } },
  { name: "full-concat paid profile", mutate: (m) => (m.pipelines[commercialIdx(m)].commercial.substrate.geometryProfile = "full-concat") },
  { name: "literal address in payToRef", mutate: (m) => (m.pipelines[commercialIdx(m)].commercial.price.payToRef = "0x1234567890abcdef1234567890abcdef12345678") },
  { name: "URL as trustStoreRef", mutate: (m) => (m.pipelines[commercialIdx(m)].commercial.substrate.trustStoreRef = "https://example.com/keys.json") },
  { name: "non-exact payment scheme", mutate: (m) => (m.pipelines[commercialIdx(m)].commercial.price.scheme = "upto") },
  { name: "paid temporal mount off 3072-D", mutate: (m) => (m.pipelines[commercialIdx(m)].dimensionality.dims = 640) },
  { name: "per-call price above daily ceiling", mutate: (m) => (m.pipelines[commercialIdx(m)].commercial.limits.dailySettledValueCeilingAtomic = "1") },
  { name: "placeholder-zero on exact-match gate", mutate: (m) => { const p = m.pipelines[commercialIdx(m)]; p.silence.gate = "exact-match"; /* threshold 0 + closerIs still present → must refuse */ } },
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

// ── Layer 2b: seal-policy audit flags without refusing ──────────────
// The shipped config itself is the fixture: roblox-luau is sealed-paid with
// an uncalibrated threshold gate. It must PARSE and be FLAGGED — the honest
// to-do, not a refusal.
try {
  const parsed = parseManifest(clone());
  const sealFlags = auditSealPolicy(parsed);
  const flaggedUncalibrated = sealFlags.some(
    (f) => f.id === "roblox-luau" && f.reason.includes("uncalibrated")
  );
  const flaggedPlaceholder = sealFlags.some(
    (f) => f.id === "roblox-luau" && f.reason.includes("placeholder")
  );
  if (flaggedUncalibrated && flaggedPlaceholder) {
    console.log('✓ layers distinct: sealed-paid "roblox-luau" parsed fine AND auditSealPolicy flagged its uncalibrated placeholder gate');
  } else {
    console.log("✗ auditSealPolicy MISSED the sealed-paid uncalibrated gate");
    failures++;
  }
} catch (e) {
  console.log(`✗ schema REFUSED the shipped config — commercial layers conflated: ${(e as Error).message.slice(0, 200)}`);
  failures++;
}

console.log(failures === 0 ? "\nAll two-layer checks passed (17/17)." : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
