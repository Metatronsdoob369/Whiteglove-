/**
 * Generate manifests/pipeline.json (the v2 shape) FROM the v3 manifest —
 * never the reverse (FOLD_SPEC "After the fold"). One source of truth
 * (config/domains.config.ts), one generated artifact. The hand-maintained
 * v2 is retired the moment this runs.
 *
 * Secrets note: `qdrant` is emitted only when the endpoint env var is set,
 * so the committed artifact never carries the Pi's Tailscale IP literal.
 *
 * Usage: npx tsx src/generate-v2.ts [outPath]   (default ../manifests/pipeline.json)
 */
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(process.argv[2] ?? path.join(here, "../../manifests/pipeline.json"));

interface V2Domain {
  processor: string;
  collection: string;
  qdrant?: string;
  embed_model?: string;
  dims: number;
  receptacle: string;
  ingest_script?: string;
  tools?: string[];
  note?: string;
}

const domains: Record<string, V2Domain> = {};
for (const p of MANIFEST.pipelines) {
  domains[p.id] = {
    processor: p.processor,
    collection: p.store.location,
    ...(p.store.endpoint ? { qdrant: p.store.endpoint } : {}),
    ...(p.store.embedModel ? { embed_model: p.store.embedModel } : {}),
    dims: p.dimensionality.dims,
    // v2's receptacle was the tool name (legal_retrieve, vault_retrieve,
    // pattern_scan, terrain_query) — first folded tool preserves that.
    receptacle: p.receptacle.tools?.[0] ?? p.receptacle.ref,
    ...(p.ingest ? { ingest_script: p.ingest.script } : {}),
    ...(p.receptacle.tools ? { tools: p.receptacle.tools } : {}),
    ...(p.notes ? { note: p.notes } : {}),
  };
}

const v2 = {
  version: "2.0",
  description:
    "GENERATED from spectral-config/config/domains.config.ts — do not hand-edit. " +
    "Regenerate with `npm run generate:v2` in spectral-config/. " +
    "TGIL domain routing table — domain → processor → collection → receptacle.",
  domains,
};

writeFileSync(outPath, JSON.stringify(v2, null, 2) + "\n");
console.log(`Generated ${outPath} from v3 manifest (${MANIFEST.pipelines.length} domains).`);
