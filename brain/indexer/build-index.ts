/**
 * build-index.ts — one-shot index builder
 * Builds SimHash index over shattered/ and persists to vault/index.json
 */
import path from "path";
import { LandmarkOrchestrator } from "../landmark-orchestrator";

const SHARD_DIR  = path.resolve(__dirname, "../shards/shattered");
const INDEX_PATH = path.resolve(__dirname, "../shards/vault/index.json");

async function main() {
  const o = new LandmarkOrchestrator({ shardDir: SHARD_DIR });
  await o.buildIndex();
  await o.saveIndex(INDEX_PATH);
  console.log(`Index saved → ${INDEX_PATH}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
