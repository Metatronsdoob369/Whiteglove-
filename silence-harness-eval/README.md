# silence-harness

Offline, deterministic eval harness for silence-first RAG. No judge model,
no network calls — safe for airgapped environments.

## How it works

- **Grounded queries** carry `expectedEvidence` (shard IDs). Correct = system
  answered AND cited an expected shard. No LLM judge needed.
- **Ungrounded queries** have no support in the corpus. Correct = silence.
- **Adversarial queries** are near-misses: real entities, fabricated details.
  This is where a Hamming/SimHash gate earns or loses its credibility.

Five outcomes: `true_answer`, `wrong_evidence`, `false_silence`,
`true_silence`, `false_answer`. The headline number you're selling is
**false_answer rate** (hallucination-under-absence) vs. the naive baseline.

## Setup

1. `npm init -y && npm i -D typescript tsx && npm i` (Node 20+ assumed)
2. Wire `src/adapter.ts` to your pipeline. It's the only file you edit.
   Wire `naiveBaseline` to the same collection with the gate disabled.
3. Build your query set as JSONL (see `corpus/queries.example.jsonl`).
   Aim for ~50+ per class before publishing numbers; 10–15 each is fine
   for smoke-testing the wiring.

## Run

```
npx tsx src/run-eval.ts corpus/queries.jsonl
npx tsx src/run-eval.ts corpus/queries.jsonl --sweep 0.05,0.10,0.15,0.20,0.25
```

Outputs `results/report.md` (the comparison table) and `results/results.json`
(per-query outcomes, including `bestScore` so you can plot the
silence-rate-vs-threshold curve).

## Corpus-building rules

- Ungrounded queries must be *plausible for the domain* — questions a real
  user would ask, not nonsense. Nonsense is easy to silence.
- Adversarial queries: take a grounded query and swap one entity, one
  version number, or one feature. Keep the surface form close.
- Every grounded query's `expectedEvidence` must use the same shard IDs
  your pipeline returns, or scoring breaks silently. The loader enforces
  presence but can't validate correctness — spot-check the first run.

Sweep values are Hamming *ratios* (fraction of 128 bits). The guard's
default is 0.15 (~19 differing bits). The 0.03 mentioned in the guard's
docstring is ~4 bits — near-exact-match territory.
