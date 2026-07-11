# Silence-First RAG Benchmark

Generated 2026-07-10T16:55:34.608Z — fully offline, deterministic (evidence-matched scoring, no judge model).

| System | Threshold | True Answer | True Silence | False Silence | False Answer | Mean Latency |
|---|---|---|---|---|---|---|
| husk-silence-first | 0.05 | 0.0% | 100.0% | 100.0% | 0.0% | 2ms |
| husk-silence-first | 0.15 | 0.0% | 100.0% | 100.0% | 0.0% | 2ms |
| husk-silence-first | 0.25 | 0.0% | 100.0% | 98.2% | 0.0% | 2ms |
| husk-silence-first | 0.35 | 7.1% | 76.4% | 67.9% | 23.6% | 2ms |
| husk-silence-first | 0.45 | 16.1% | 0.9% | 0.0% | 99.1% | 3ms |
| naive-topk-no-gate | — | 16.1% | 0.0% | 0.0% | 100.0% | 2ms |

**Reading this table:** False Answer is the hallucination surface — the rate at
which the system fabricates when the corpus cannot support an answer. False
Silence is the over-refusal cost. A useful system drives False Answer toward
zero without letting False Silence climb.
