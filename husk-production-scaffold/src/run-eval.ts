import { writeFileSync, mkdirSync } from "node:fs";
import { loadQueries } from "./corpus.js";
import { scoreOne, aggregate } from "./metrics.js";
import { huskAdapter, naiveBaseline } from "./adapter.js";
import type { Metrics, RetrievalAdapter, ScoredResult } from "./types.js";

/**
 * Usage:
 *   npx tsx src/run-eval.ts corpus/queries.jsonl
 *   npx tsx src/run-eval.ts corpus/queries.jsonl --sweep 4,8,12,16,20
 *
 * Outputs: results/results.json, results/report.md
 * Deterministic: no sampling, no judge model, fixed query order.
 */

async function runAdapter(
  adapter: RetrievalAdapter,
  queriesPath: string,
  threshold?: number
): Promise<{ metrics: Metrics; results: ScoredResult[] }> {
  const queries = loadQueries(queriesPath);
  const results: ScoredResult[] = [];
  for (const q of queries) {
    const r = await adapter.query(q, threshold);
    results.push(scoreOne(q, r));
  }
  return { metrics: aggregate(adapter.name, results, threshold), results };
}

function pct(x: number): string {
  return (x * 100).toFixed(1) + "%";
}

function renderReport(all: Metrics[]): string {
  const rows = all
    .map(
      (m) =>
        `| ${m.adapterName} | ${m.threshold ?? "—"} | ${pct(m.trueAnswerRate)} | ${pct(
          m.trueSilenceRate
        )} | ${pct(m.falseSilenceRate)} | ${pct(m.falseAnswerRate)} | ${
          m.meanLatencyMs ? m.meanLatencyMs.toFixed(0) + "ms" : "—"
        } |`
    )
    .join("\n");

  return `# Silence-First RAG Benchmark

Generated ${new Date().toISOString()} — fully offline, deterministic (evidence-matched scoring, no judge model).

| System | Threshold | True Answer | True Silence | False Silence | False Answer | Mean Latency |
|---|---|---|---|---|---|---|
${rows}

**Reading this table:** False Answer is the hallucination surface — the rate at
which the system fabricates when the corpus cannot support an answer. False
Silence is the over-refusal cost. A useful system drives False Answer toward
zero without letting False Silence climb.
`;
}

async function main() {
  const queriesPath = process.argv[2];
  if (!queriesPath) {
    console.error("Usage: tsx src/run-eval.ts <queries.jsonl> [--sweep t1,t2,...]");
    process.exit(1);
  }
  const sweepArg = process.argv.indexOf("--sweep");
  const thresholds =
    sweepArg > -1
      ? process.argv[sweepArg + 1].split(",").map(Number)
      : [undefined];

  const allMetrics: Metrics[] = [];
  const allResults: Record<string, ScoredResult[]> = {};

  for (const t of thresholds) {
    const { metrics, results } = await runAdapter(huskAdapter, queriesPath, t);
    allMetrics.push(metrics);
    allResults[`${huskAdapter.name}@${t ?? "default"}`] = results;
  }

  // Baseline once (no gate, threshold irrelevant)
  try {
    const { metrics, results } = await runAdapter(naiveBaseline, queriesPath);
    allMetrics.push(metrics);
    allResults[naiveBaseline.name] = results;
  } catch {
    console.warn("Baseline adapter not wired — skipping (wire it for the comparison table).");
  }

  mkdirSync("results", { recursive: true });
  writeFileSync("results/results.json", JSON.stringify({ metrics: allMetrics, results: allResults }, null, 2));
  writeFileSync("results/report.md", renderReport(allMetrics));
  console.log(renderReport(allMetrics));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
