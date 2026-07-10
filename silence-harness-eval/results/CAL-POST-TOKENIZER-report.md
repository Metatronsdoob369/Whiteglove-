# Silence-First RAG Benchmark

Generated 2026-07-10T17:01:19.601Z — fully offline, deterministic (evidence-matched scoring, no judge model).

| System | Threshold | True Answer | True Silence | False Silence | False Answer | Mean Latency |
|---|---|---|---|---|---|---|
| husk-silence-first | 0.25 | 1.8% | 100.0% | 98.2% | 0.0% | 2ms |
| husk-silence-first | 0.3 | 5.4% | 100.0% | 92.9% | 0.0% | 2ms |
| husk-silence-first | 0.325 | 7.1% | 100.0% | 91.1% | 0.0% | 2ms |
| husk-silence-first | 0.35 | 14.3% | 89.6% | 76.8% | 10.4% | 2ms |
| husk-silence-first | 0.375 | 30.4% | 49.1% | 30.4% | 50.9% | 3ms |
| husk-silence-first | 0.4 | 35.7% | 12.3% | 5.4% | 87.7% | 3ms |
| husk-silence-first | 0.45 | 37.5% | 0.0% | 0.0% | 100.0% | 3ms |
| naive-topk-no-gate | — | 37.5% | 0.0% | 0.0% | 100.0% | 3ms |

**Reading this table:** False Answer is the hallucination surface — the rate at
which the system fabricates when the corpus cannot support an answer. False
Silence is the over-refusal cost. A useful system drives False Answer toward
zero without letting False Silence climb.
