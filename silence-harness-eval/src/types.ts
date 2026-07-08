/**
 * Core types for the silence-first RAG eval harness.
 * The harness never imports your pipeline directly — it talks to a
 * RetrievalAdapter you implement in adapter.ts.
 */

export type QueryClass = "grounded" | "ungrounded" | "adversarial";

export interface EvalQuery {
  id: string;
  text: string;
  class: QueryClass;
  /** For grounded queries: chunk/shard IDs that legitimately answer it. */
  expectedEvidence?: string[];
  /** Optional free-form note (why this query exists, what it probes). */
  note?: string;
}

export interface PipelineResponse {
  /** Did the system produce an answer, or return silence? */
  answered: boolean;
  /** Answer text, if any (not scored — kept for the report). */
  answer?: string;
  /** IDs of chunks/shards the answer was grounded on. */
  evidenceIds?: string[];
  /** Raw similarity / Hamming distance of best match, for sweep plots. */
  bestScore?: number;
  latencyMs?: number;
}

export interface RetrievalAdapter {
  name: string;
  /** threshold is passed through so the sweep can vary it. */
  query(q: EvalQuery, threshold?: number): Promise<PipelineResponse>;
}

export type Outcome =
  | "true_answer"    // grounded, answered, evidence matched
  | "wrong_evidence" // grounded, answered, but evidence didn't match
  | "false_silence"  // grounded, silent (over-refusal)
  | "true_silence"   // ungrounded/adversarial, silent
  | "false_answer";  // ungrounded/adversarial, answered (hallucination surface)

export interface ScoredResult {
  queryId: string;
  class: QueryClass;
  outcome: Outcome;
  bestScore?: number;
  latencyMs?: number;
  answer?: string;
  evidenceIds?: string[];
}

export interface Metrics {
  adapterName: string;
  threshold?: number;
  counts: Record<Outcome, number>;
  /** grounded queries answered with correct evidence / all grounded */
  trueAnswerRate: number;
  /** ungrounded+adversarial met with silence / all ungrounded+adversarial */
  trueSilenceRate: number;
  /** grounded queries wrongly silenced / all grounded */
  falseSilenceRate: number;
  /** ungrounded+adversarial answered / all ungrounded+adversarial */
  falseAnswerRate: number;
  meanLatencyMs?: number;
}
