# AGENT.md — White-Glove Agent Husk

A silence-first, fully-offline retrieval agent. If the requested
information is not present in its corpus, it returns **silence** — a
first-class, measurable outcome — instead of generating a plausible
fabrication. This document describes what the system does, how, and
where its current limits are.

*Scope note: this rundown covers the components verified from source
(query CLI, landmark orchestrator, SimHash guard, embedding contract,
REFRAG compressor, index builder). Components referenced but not
reviewed here — shard cache internals, pipeline router, agent loop,
ingest scripts — are described only by their observed interfaces.*

---

## 1. What problem this solves

Standard RAG has a failure mode high-stakes industries cannot accept:
when retrieval returns weak matches, the LLM answers anyway, smoothing
the gap with fabrication. The Husk inverts the default:

> **Faith-Less principle:** if it isn't in the shard, the agent stays
> silent. No generation without verified source material.

Silence is not an error state. It is the correct answer to a question
the corpus cannot support, and it is rendered, cited, and measured as
such.

## 2. Operating modes

| Mode | What happens | LLM involved |
|---|---|---|
| **retrieve** (default) | Query → gate → verbatim source text + citations | No |
| **rag** | retrieve first; if shards pass the gate, a local model (Ollama, default `qwen2.5-coder:7b`) answers *only from those shards* | Yes, local only |
| **silence** | No shard passes the gate → structured refusal with metrics | No |

RAG mode inherits the gate: if retrieval is silenced, no prompt is ever
constructed, so the model never gets the chance to freestyle.

## 3. Architecture

```
question
   │
   ▼
SimHash-128 signature of query          (simhash-guard)
   │
   ▼
Hot ring buffer check (top ~5% by hit frequency, O(1) fast path)
   │ miss
   ▼
Hamming distance vs every shard signature (O(N), bitwise XOR+popcount)
   │
   ▼
Gate: hammingRatio ≤ queryThreshold ?   (landmark-orchestrator)
   │ none pass                │ top-N pass (default 3)
   ▼                          ▼
SILENCE                LFU shard cache → disk fetch on miss
                              │
                              ▼
              retrieve: verbatim text + citations
              rag:      context-locked prompt → local Ollama model
```

### Components

- **`contracts/embeddingContract.ts`** — ℓ₂-normalization gate for
  3072-D vectors at ingestion. Kahan-summed magnitude, rejects zero
  vectors, NaN, wrong dimensionality. Foundation for any vector-space
  operation downstream.
- **`brain/indexer/simhash-guard.ts`** — 128-bit SimHash signatures
  (twin 64-bit accumulators, domain-separated salts) + Hamming drift
  evaluation. Two signature sources: word-level text tokens, and
  quantized embedding vectors.
- **`brain/indexer/refrag-compressor.ts`** — select-k sparse
  compression of normalized embeddings (top-256 of 3072 dims, ~8×
  memory reduction) with energy-retention floor and O(k) sparse
  similarity.
- **`brain/landmark-orchestrator.ts`** — the brain stem. Builds the
  signature index over shattered shards, runs the gate, manages the
  LFU cache and hot buffer, constructs the context-locked prompt for
  RAG mode, calls local inference.
- **`query.ts`** — one-shot CLI. **`src/husk-tui.ts`** — interactive
  shell. **`silence-harness/`** — offline eval harness (see §6).

### Which similarity path is live

The **retrieval gate currently runs on the text path**
(`simHash128FromText` over word tokens), for both shards and queries.
The embedding contract and REFRAG compressor exist in the codebase but
are not in the verified retrieve() path. The vector-signature path
(`simHash128FromVector`) is not locality-sensitive as implemented
(per-dimension value hashing rather than hyperplane projection) and
should not be used for similarity gating without rework.

## 4. Configuration

| Option | Default | Meaning |
|---|---|---|
| `shardDir` | machine-specific | shattered shard JSON directory |
| `queryThreshold` | 0.45 | query→shard gate, Hamming ratio of 128 bits. **Lower = stricter = more silence.** |
| `similarityThreshold` | 0.2858 | shard→shard drift detection (integrity, not retrieval) |
| `maxContextShards` | 3 | max shards fed as context / returned |
| `ollamaModel` | qwen2.5-coder:7b | local model for RAG mode |
| `cacheCapacity` | 500 | LFU cache entries |
| `maxResponseTokens` | 200 | RAG response cap |

Threshold intuition: 0.45 ≈ 57 of 128 bits differing; 0.15 ≈ 19 bits;
0.03 ≈ 4 bits (near-duplicate territory). Random unrelated signatures
sit near 0.50. Calibrate against your corpus with the harness sweep —
do not trust defaults.

## 5. Known issues (current status)

1. **Salt mismatch in the retrieval gate (open, fix drafted).** Shards
   are signed with per-source schema salts; queries are signed with the
   `"query_"` schema. Different salts produce uncorrelated signatures,
   so query→shard distances cluster near random (~0.5) regardless of
   topical overlap, and the 0.45 gate passes a nontrivial fraction of
   shards by chance. Practical effect: the gate rarely silences and
   selection is weakly correlated with relevance. Fix: sign all
   retrieval signatures with one corpus-wide schema (see
   `PATCHES.md` §2), then re-calibrate thresholds.
2. **Silence carries no score (open, one-line fix).** Silenced results
   don't report the closest failed match, which blocks the
   silence-vs-threshold curve. `PATCHES.md` §1.
3. **Vector SimHash path not locality-sensitive** — see §3. Parked
   unless/until vector gating is needed.

These are listed deliberately: the product's credibility rests on
measuring its own failure surface honestly.

## 6. Evaluation harness

Offline, deterministic, no judge model. Three query classes —
grounded (with expected evidence shard IDs), ungrounded, adversarial
(near-miss) — scored into five outcomes:

| Outcome | Meaning |
|---|---|
| true_answer | grounded, answered, cited expected evidence |
| wrong_evidence | grounded, answered, cited the wrong shards |
| false_silence | grounded, wrongly silenced (over-refusal cost) |
| true_silence | unanswerable, correctly silent |
| **false_answer** | **unanswerable, answered — the hallucination surface** |

Baseline column: the same pipeline with `queryThreshold = 1.0`
(gate off, always answers top-N). Run:

```
SHARD_DIR=... npx tsx src/run-eval.ts corpus/queries.jsonl
SHARD_DIR=... npx tsx src/run-eval.ts corpus/queries.jsonl --sweep 0.05,0.15,0.25,0.35,0.45
```

## 7. Interactive shell

```
SHARD_DIR=... npx tsx src/husk-tui.ts
```

`:mode retrieve|rag`, `:threshold <0.0-1.0>` (rebuilds index),
`:diagnostics`, `:reload`, `:quit`. Silence renders as a first-class
result with the closest-miss distance once PATCHES.md §1 is applied.

## 8. Deployment posture

- **Airgap-native.** No network calls anywhere in the retrieval path.
  RAG mode talks only to a local Ollama endpoint (127.0.0.1).
- **Deterministic evaluation.** Evidence-matched scoring; no cloud
  judge; results reproducible byte-for-byte on the same corpus.
- **Auditability.** Every answer carries shard IDs, source files, and
  Hamming distances. Every silence carries the evaluation count and
  (post-patch) the closest miss.

## 9. Glossary

- **Shard** — a chunked JSON unit of the corpus (`shattered/`), with
  id, source, content.
- **Signature** — 128-bit SimHash fingerprint of a shard or query.
- **Hamming ratio** — differing bits ÷ 128. Distance metric; lower is
  closer.
- **Gate** — the threshold test that decides answer vs. silence.
- **Faith-Less** — retrieval-only mode: verbatim sources, zero
  generation.
- **Hot ring buffer** — top ~5% most-hit shards, checked O(1) before
  the full index scan.
