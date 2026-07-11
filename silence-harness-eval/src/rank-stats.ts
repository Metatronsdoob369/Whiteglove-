/**
 * Rank statistics over the calibration corpus — the separation metric the
 * outcome table can't show. For every grounded query: where does its best
 * expected-evidence shard rank, and at what Hamming ratio? For every
 * ungrounded/adversarial query: how close is the closest (wrong) shard?
 *
 * Usage: SHARD_DIR=... npx tsx src/rank-stats.ts corpus/queries.jsonl results/RANKS-X.json
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { loadQueries } from "./corpus.js";
import { SimHashDriftGuard } from "../../brain/indexer/simhash-guard.js";

const queriesPath = process.argv[2] ?? "corpus/queries.jsonl";
const outPath = process.argv[3] ?? "results/RANKS.json";
const SHARD_DIR = process.env.SHARD_DIR ?? "";

const guard = new SimHashDriftGuard(1.0);
const shardDocs = readdirSync(SHARD_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(path.join(SHARD_DIR, f), "utf-8")));
// Same IDF weighting the orchestrator applies at buildIndex.
const idf = guard.computeIdfWeights(shardDocs.map((s) => s.content));
guard.setTokenWeights(idf.weights, idf.unseenWeight);
const shards = shardDocs.map((s) => ({
  id: s.id as string,
  sig: guard.simHash128FromText(s.content, "corpus"),
}));

const queries = loadQueries(queriesPath) as Array<{
  id: string;
  text: string;
  class: string;
  expectedEvidence?: string[];
}>;

interface Row {
  id: string;
  class: string;
  bestScore: number;
  evidenceRank?: number;
  evidenceScore?: number;
}

const rows: Row[] = [];
for (const q of queries) {
  const qSig = guard.simHash128FromText(q.text, "corpus");
  const ranked = shards
    .map((s) => ({ id: s.id, ratio: guard.evaluateDrift(qSig, s.sig).hammingRatio }))
    .sort((a, b) => a.ratio - b.ratio);
  const row: Row = { id: q.id, class: q.class, bestScore: ranked[0].ratio };
  if (q.class === "grounded") {
    const idx = ranked.findIndex((r) => (q.expectedEvidence ?? []).includes(r.id));
    row.evidenceRank = idx + 1;
    row.evidenceScore = ranked[idx]?.ratio;
  }
  rows.push(row);
}

const grounded = rows.filter((r) => r.class === "grounded");
const negatives = rows.filter((r) => r.class !== "grounded");
const ranks = grounded.map((r) => r.evidenceRank!).sort((a, b) => a - b);
const median = (xs: number[]) => xs[Math.floor(xs.length / 2)];
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (n: number) => ((n / grounded.length) * 100).toFixed(1) + "%";

const summary = {
  grounded: {
    n: grounded.length,
    evidenceRank: {
      median: median(ranks),
      top1: pct(ranks.filter((r) => r === 1).length),
      top3: pct(ranks.filter((r) => r <= 3).length),
      top10: pct(ranks.filter((r) => r <= 10).length),
    },
    meanEvidenceScore: Number(mean(grounded.map((r) => r.evidenceScore!)).toFixed(4)),
    meanBestScore: Number(mean(grounded.map((r) => r.bestScore)).toFixed(4)),
  },
  negatives: {
    n: negatives.length,
    meanBestScore: Number(mean(negatives.map((r) => r.bestScore)).toFixed(4)),
    minBestScore: Number(Math.min(...negatives.map((r) => r.bestScore)).toFixed(4)),
  },
  separation: {
    note: "meanEvidenceScore (grounded, want LOW) vs meanBestScore (negatives, want HIGH)",
    gap: Number(
      (mean(negatives.map((r) => r.bestScore)) - mean(grounded.map((r) => r.evidenceScore!))).toFixed(4)
    ),
  },
};

writeFileSync(outPath, JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
