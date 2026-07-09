import { MANIFEST, listPipelines, uncalibrated, dimensionViolations } from "./index.js";
console.log(`✓ Manifest valid — ${MANIFEST.pipelines.length} pipelines`);
console.log(`  Dimension policy: static ≤ ${MANIFEST.dimensionPolicy.maxStaticDims}-D, temporal = ${MANIFEST.dimensionPolicy.temporalDims}-D\n`);
console.log("Pipelines:");
for (const p of listPipelines()) console.log(`  ${p.id.padEnd(20)} ${p.status.padEnd(12)} ${p.geometry}`);
console.log(`\n⚠ Running HOT (static above ${MANIFEST.dimensionPolicy.maxStaticDims}-D — violate the rule):`);
const v = dimensionViolations();
if (v.length === 0) console.log("  none");
for (const x of v) console.log(`  ${x.id.padEnd(20)} ${x.dims}-D`);
console.log(`\nUnresolved live-vs-target conflicts:`);
for (const p of MANIFEST.pipelines.filter(p => p.liveVsTarget && !p.liveVsTarget.resolved)) {
  console.log(`  ${p.id}: live=[${p.liveVsTarget!.live.slice(0,40)}...] target=[${p.liveVsTarget!.target.slice(0,40)}...]`);
}
const unfolded = MANIFEST.pipelines.filter((p) => p.receptacle.tools === undefined).map((p) => p.id);
console.log(
  `\nWire fold (v2→v3): ${MANIFEST.pipelines.length - unfolded.length}/${MANIFEST.pipelines.length} pipelines carry receptacle.tools` +
    (unfolded.length ? ` — pending: ${unfolded.join(", ")}` : " — fold complete")
);
console.log(`\nSilence mechanisms: ${[...new Set(MANIFEST.pipelines.map(p => p.silence.signal))].join(", ")}`);
