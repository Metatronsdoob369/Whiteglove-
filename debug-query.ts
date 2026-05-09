/**
 * Debug tool: show Hamming distances for a query against all shards.
 * Usage: ts-node debug-query.ts "your question"
 */

import fs from "fs";
import path from "path";
import { SimHashDriftGuard } from "./brain/indexer/simhash-guard";

const SHARD_DIR = "/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/brain/shards/shattered";

async function debug() {
  const question = process.argv.slice(2).join(" ");
  if (!question) { console.log("Usage: ts-node debug-query.ts \"question\""); return; }

  const guard = new SimHashDriftGuard(0.2858);
  const querySig = guard.simHash128FromText(question, "query_");

  const files = fs.readdirSync(SHARD_DIR).filter((f: string) => f.endsWith(".json")).sort();

  const results: Array<{ id: string; ratio: number; stable: boolean; preview: string }> = [];

  for (const file of files) {
    const shard = JSON.parse(fs.readFileSync(path.join(SHARD_DIR, file), "utf-8"));
    const shardSig = guard.simHash128FromText(shard.content, shard.source);
    const drift = guard.evaluateDrift(querySig, shardSig);
    results.push({
      id: shard.id,
      ratio: drift.hammingRatio,
      stable: drift.stable,
      preview: shard.content.slice(0, 60).replace(/\n/g, " ")
    });
  }

  results.sort((a, b) => a.ratio - b.ratio);

  console.log(`\nQuery: "${question}"\nThreshold: 0.2858\n`);
  console.log("TOP 10 CLOSEST SHARDS:");
  console.log("─".repeat(80));
  for (const r of results.slice(0, 10)) {
    const flag = r.stable ? "✅" : "❌";
    console.log(`${flag} ${r.ratio.toFixed(4)}  ${r.id}  ${r.preview}...`);
  }
}

debug().catch(console.error);
