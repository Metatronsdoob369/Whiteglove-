# Silence-First RAG Benchmark

Generated 2026-07-08T21:50:36.037Z — fully offline, deterministic (evidence-matched scoring, no judge model).

| System | Threshold | True Answer | True Silence | False Silence | False Answer | Mean Latency |
|---|---|---|---|---|---|---|
| husk-silence-first | — | 0.0% | 0.0% | 0.0% | 100.0% | 3ms |
| naive-topk-no-gate | — | 0.0% | 0.0% | 0.0% | 100.0% | 3ms |

**Reading this table:** False Answer is the hallucination surface — the rate at
which the system fabricates when the corpus cannot support an answer. False
Silence is the over-refusal cost. A useful system drives False Answer toward
zero without letting False Silence climb.
