import type {
  EvalQuery,
  PipelineResponse,
  ScoredResult,
  Outcome,
  Metrics,
} from "./types.js";

export function scoreOne(q: EvalQuery, r: PipelineResponse): ScoredResult {
  let outcome: Outcome;

  if (q.class === "grounded") {
    if (!r.answered) {
      outcome = "false_silence";
    } else {
      const hit = (r.evidenceIds ?? []).some((id) =>
        (q.expectedEvidence ?? []).includes(id)
      );
      outcome = hit ? "true_answer" : "wrong_evidence";
    }
  } else {
    // ungrounded and adversarial: the only correct behavior is silence
    outcome = r.answered ? "false_answer" : "true_silence";
  }

  return {
    queryId: q.id,
    class: q.class,
    outcome,
    bestScore: r.bestScore,
    latencyMs: r.latencyMs,
    answer: r.answer,
    evidenceIds: r.evidenceIds,
  };
}

export function aggregate(
  adapterName: string,
  results: ScoredResult[],
  threshold?: number
): Metrics {
  const counts: Record<Outcome, number> = {
    true_answer: 0,
    wrong_evidence: 0,
    false_silence: 0,
    true_silence: 0,
    false_answer: 0,
  };
  for (const r of results) counts[r.outcome]++;

  const grounded =
    counts.true_answer + counts.wrong_evidence + counts.false_silence;
  const negatives = counts.true_silence + counts.false_answer;

  const latencies = results
    .map((r) => r.latencyMs)
    .filter((x): x is number => typeof x === "number");

  return {
    adapterName,
    threshold,
    counts,
    trueAnswerRate: grounded ? counts.true_answer / grounded : 0,
    falseSilenceRate: grounded ? counts.false_silence / grounded : 0,
    trueSilenceRate: negatives ? counts.true_silence / negatives : 0,
    falseAnswerRate: negatives ? counts.false_answer / negatives : 0,
    meanLatencyMs: latencies.length
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : undefined,
  };
}
