import { LandmarkOrchestrator } from "../../brain/landmark-orchestrator.js"; // FIX PATH to your repo
import type { RetrievalAdapter, EvalQuery, PipelineResponse } from "./types.js";

/**
 * Wired and verified against landmark-orchestrator.ts.
 *
 * Confirmed:
 *  - retrieve() lazy-builds the index; we build explicitly so first-query
 *    latency isn't polluted.
 *  - queryThreshold (Hamming RATIO, default 0.45) gates query→shard.
 *    similarityThreshold (0.2858) is the separate shard→shard drift gate —
 *    do not sweep that one.
 *  - Lower hammingRatio = closer.
 *
 * Set SHARD_DIR to your shattered/ path. The orchestrator default points
 * at /Volumes/ARCHIVE/... which is only right on the original box.
 */
const SHARD_DIR = process.env.SHARD_DIR ?? ""; // e.g. ".../brain/shards/shattered"

const orchestrators = new Map<string, LandmarkOrchestrator>();
async function getOrchestrator(threshold?: number): Promise<LandmarkOrchestrator> {
  const key = threshold === undefined ? "default" : String(threshold);
  let orch = orchestrators.get(key);
  if (!orch) {
    orch = new LandmarkOrchestrator({
      ...(SHARD_DIR ? { shardDir: SHARD_DIR } : {}),
      ...(threshold !== undefined ? { queryThreshold: threshold } : {}),
    });
    await orch.buildIndex();
    orchestrators.set(key, orch);
  }
  return orch;
}

async function run(
  q: EvalQuery,
  threshold?: number
): Promise<PipelineResponse> {
  const orch = await getOrchestrator(threshold);
  const t0 = performance.now();
  const result = await orch.retrieve(q.text); // FAITH-LESS mode
  const latencyMs = performance.now() - t0;

  if (result.silenced) {
    // bestScore stays undefined until the one-line orchestrator patch
    // (see PATCHES.md) adds the closest failed ratio to silenced returns.
    return { answered: false, latencyMs };
  }

  return {
    answered: true,
    answer: result.sourceTexts.map((s: { fullText: string }) => s.fullText).join("\n---\n"),
    evidenceIds: result.citations.map((c: { shardId: string }) => c.shardId),
    bestScore: result.citations.length
      ? Math.min(...result.citations.map((c: { hammingRatio: number }) => c.hammingRatio))
      : undefined,
    latencyMs,
  };
}

export const huskAdapter: RetrievalAdapter = {
  name: "husk-silence-first",
  query: (q, threshold) => run(q, threshold),
};

/**
 * Gate-off baseline using the same pipeline: queryThreshold = 1.0 makes
 * every shard "stable", so retrieve() always answers with top-N by
 * Hamming rank. This is the no-silence comparison column.
 */
export const naiveBaseline: RetrievalAdapter = {
  name: "naive-topk-no-gate",
  query: (q) => run(q, 1.0),
};
