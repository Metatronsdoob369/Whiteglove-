import { LandmarkOrchestrator } from "../../brain/landmark-orchestrator.js";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { SimHashDriftGuard } from "../../brain/indexer/simhash-guard.js";

/** Rank every shard against a query with the patched (corpus-salt) signatures
 *  and show where the expected evidence landed. */
const SHARD_DIR = process.env.SHARD_DIR ?? "";
const guard = new SimHashDriftGuard(1.0);

const queries: Array<{ id: string; text: string; expect: string }> = [
  {
    id: "g-lfu-evict",
    text: "When the shard cache is at capacity, how does it evict the least-frequently-used shard, and what breaks a frequency tie?",
    expect: "brain_cache_shard-cache_ts",
  },
  {
    id: "g-kahan-l2",
    text: "Why does the embedding contract compute the ℓ₂ magnitude with Kahan summation to reduce floating-point accumulation error?",
    expect: "contracts_embeddingContract_ts",
  },
];

const shards = readdirSync(SHARD_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(path.join(SHARD_DIR, f), "utf-8")));

for (const q of queries) {
  const qSig = guard.simHash128FromText(q.text, "corpus");
  const ranked = shards
    .map((s) => ({
      id: s.id as string,
      ratio: guard.evaluateDrift(qSig, guard.simHash128FromText(s.content, "corpus")).hammingRatio,
    }))
    .sort((a, b) => a.ratio - b.ratio);

  console.log(`\n=== ${q.id}`);
  ranked.slice(0, 8).forEach((r, i) => console.log(`  #${i + 1} ${r.ratio.toFixed(4)} ${r.id}`));
  const hit = ranked.findIndex((r) => r.id.startsWith(q.expect));
  console.log(`  expected-evidence best rank: #${hit + 1} @ ${ranked[hit].ratio.toFixed(4)} (${ranked[hit].id})`);
}
