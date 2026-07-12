/**
 * build-fixture-vault.ts — materialize the committed fixture corpus as a vault
 *
 * Reads brain/fixture/corpus/*.txt (committed, public-safe, self-describing),
 * writes one shard per document to brain/shards/shattered/ as
 * fix_chunk_NNNN.json, then builds and persists the SimHash index — so
 * finalize-mvp.sh Phase 2 passes on a fresh clone with no external drive.
 *
 * brain/shards/ is gitignored: fixture shards are build artifacts, only the
 * corpus sources are committed. Shard id === filename stem (the orchestrator
 * reloads shards by `${shardId}.json`).
 *
 * Usage: npx ts-node --project tsconfig.json brain/indexer/build-fixture-vault.ts
 */
import fs from "fs";
import path from "path";
import { LandmarkOrchestrator } from "../landmark-orchestrator";

const CORPUS_DIR = path.resolve(__dirname, "../fixture/corpus");
const SHARD_DIR  = path.resolve(__dirname, "../shards/shattered");
const INDEX_PATH = path.resolve(__dirname, "../shards/vault/index.json");

async function main() {
  if (!fs.existsSync(CORPUS_DIR)) {
    throw new Error(`Fixture corpus missing: ${CORPUS_DIR}`);
  }
  fs.mkdirSync(SHARD_DIR, { recursive: true });

  // Idempotent rebuild: clear prior fixture shards (and only fixture shards).
  for (const f of fs.readdirSync(SHARD_DIR)) {
    if (f.startsWith("fix_chunk_") && f.endsWith(".json")) {
      fs.unlinkSync(path.join(SHARD_DIR, f));
    }
  }

  const docs = fs.readdirSync(CORPUS_DIR).filter(f => f.endsWith(".txt")).sort();
  if (docs.length === 0) {
    throw new Error(`Fixture corpus is empty: ${CORPUS_DIR}`);
  }

  // One shard per PARAGRAPH, not per document: SimHash distance between a
  // one-sentence query and a whole-document fingerprint rarely clears the
  // calibrated gate, so paragraph-sized shards are what make the fixture's
  // grounded smoke query actually answer (mirrors tests/retrieval/fixtures).
  let count = 0;
  for (const doc of docs) {
    const text = fs.readFileSync(path.join(CORPUS_DIR, doc), "utf-8").trim();
    const docTitle = text.split("\n")[0]!.trim();
    const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
    for (let p = 0; p < paragraphs.length; p++) {
      const id = `fix_chunk_${count.toString().padStart(4, "0")}`;
      const shard = {
        id,
        title: `${docTitle} (¶${p + 1})`,
        source: `fixture/${doc}`,
        content: paragraphs[p]!
      };
      fs.writeFileSync(path.join(SHARD_DIR, `${id}.json`), JSON.stringify(shard, null, 2));
      count++;
    }
  }
  console.log(`[fixture] ${count} shards written -> ${SHARD_DIR}`);

  const orchestrator = new LandmarkOrchestrator({ shardDir: SHARD_DIR });
  await orchestrator.buildIndex();
  fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  await orchestrator.saveIndex(INDEX_PATH);
  console.log(`[fixture] index saved -> ${INDEX_PATH}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
