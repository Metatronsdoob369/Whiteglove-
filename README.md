# WhiteGlove Agent Husk

[![Quality Gates (Regression + Secret Scan + Docs Release Hygiene)](https://github.com/Metatronsdoob369/Whiteglove-/actions/workflows/quality.yml/badge.svg)](https://github.com/Metatronsdoob369/Whiteglove-/actions/workflows/quality.yml)

**Offline-first, hallucination-resistant intelligence infrastructure.**

The Husk is a retrieval engine built on the principle of silence over fabrication. If the knowledge isn't in the vault, the agent says nothing. Zero network dependency. Zero vector database overhead. Runs entirely from a portable ARCHIVE drive.

---

## Core Philosophy — Faith-Less Retrieval

Standard RAG systems generate answers and cite sources after the fact. This inverts that:

1. Query arrives
2. SimHash-128 fingerprints the query
3. Hamming distance ranking finds the closest knowledge shards
4. If nothing is close enough — **the agent stays silent**
5. If shards are found — verified source text is returned as-is
6. Optional: pass verified text to a local LLM for synthesis (RAG mode)

The silence is the feature. An agent that fabricates nothing is more useful in high-stakes environments than one that sounds confident.

---

## Architecture

```
query
  │
  ▼
SimHash-128(query)
  │
  ▼
Hamming distance vs. shard index  ←── Hot Ring Buffer (O(1) for top 5%)
  │
  ▼
Top-N shards within calibrated threshold
  │
  ├── [retrieve mode]  Return verified source text + citations
  │
  └── [query mode]     Build context prompt → Ollama local inference → answer
```

### Components

| Path | Role |
|---|---|
| `brain/landmark-orchestrator.ts` | Core retrieval engine — SimHash ranking, LFU cache, hot ring buffer, Ollama bridge |
| `brain/indexer/simhash-guard.ts` | SimHash-128 implementation + Hamming drift detection |
| `brain/cache/shard-cache.ts` | LFU cache — keeps hot shards in memory, evicts cold ones |
| `brain/shatter.ts` | Chunker — splits source documents into shards |
| `brain/broseidon-indexer.ts` | Raspberry Pi 5 entrypoint — multi-mount path detection, 15k shard indexer |
| `circadian/pulse.ts` | Heartbeat — WAKE cycle scans for new knowledge, DREAM cycle re-indexes and verifies integrity |
| `contracts/embeddingContract.ts` | ℓ₂-normalization gate — all vectors enforced onto unit sphere at ingestion |
| `query.ts` | CLI entry point |
| `topology-map.ts` | Neighborhood visualizer — heat map of shard cluster relationships |
| `brain/dashboard.html` | Local diagnostic dashboard |

---

## Retrieval Thresholds (Calibrated)

Two separate Hamming thresholds are used — tight for shard integrity, wide for query matching:

| Context | Threshold | Reason |
|---|---|---|
| Shard-to-shard drift detection | `0.2858` | Tight — flags genuine content drift between shards. **Predates the 2026-07-10 tokenizer/IDF change — recalibrate before trusting.** |
| Query-to-shard retrieval | `0.325` | Calibrated 2026-07-10 on a 162-query / 131-shard self-corpus sweep: the last zero-false-answer point (the closest unanswerable query lands at `0.3281`). Silence-first by design — raising it trades false answers for recall. |

Thresholds are per-deployment calibration snapshots, not constants: re-run the
`silence-harness-eval` sweep against your corpus before trusting either number.
Changing them changes the silence/recall tradeoff.

---

## Quick Start

```bash
# Install dependencies
npm install

# Index all shards and run diagnostics
ts-node query.ts --diagnostics

# Pure retrieval (Faith-Less — no LLM)
ts-node query.ts "What are the signs of diabetic ketoacidosis?"

# RAG mode (requires Ollama running with a Q4+ model)
ts-node query.ts --rag "What are the signs of diabetic ketoacidosis?"

# Build index only
ts-node query.ts --index-only
```

### Ollama Setup (for RAG mode)

```bash
# Install Ollama
brew install ollama

# Pull the default model
ollama pull qwen2.5-coder:7b

# Start Ollama (runs on localhost:11434)
ollama serve
```

---

## Raspberry Pi 5 Deployment (Broseidon Node)

The indexer is optimized for Pi 5 (3GHz, Vulkan acceleration). It auto-detects the ARCHIVE mount point across Mac and Linux paths:

```bash
# On Pi — ARCHIVE mounted at /mnt/ARCHIVE or /media/pi/ARCHIVE
ts-node brain/broseidon-indexer.ts
```

Mount point detection order:
1. `/Volumes/ARCHIVE/...` (Mac)
2. `/mnt/ARCHIVE/...` (Pi / Linux)
3. `/media/pi/ARCHIVE/...` (Pi alternative)

---

## Circadian Lifecycle

The `CircadianPulse` runs on a 1-hour heartbeat with two modes:

**WAKE (6AM–Midnight)**
- Scans ZIM_Archives for new files not yet ingested
- Detects new shards added since last beat
- Rebuilds index if delta > 0

**DREAM (Midnight–6AM)**
- Full SimHash re-index of all shards
- Integrity check — verifies every shard parses correctly and has required fields
- Diagnostic snapshot written to `brain/pulse_audit.jsonl`

```bash
# Start the heartbeat (runs indefinitely)
ts-node circadian/pulse.ts
```

---

## Knowledge Sources

The default corpus targets medical emergency knowledge (MedlinePlus). Shards live in:

```
brain/shards/medical_clean/    ← cleaned extraction (15,580 shards)
brain/shards/shattered/        ← processed shards ready for indexing
```

New knowledge sources are added by:
1. Dropping a ZIM archive into `ZIM_Archives/`
2. The WAKE cycle detects it and triggers ingestion
3. The DREAM cycle re-indexes the expanded vault

---

## Index Persistence

The index can be saved to disk and restored without a full rebuild:

```typescript
// Save after building
await orchestrator.buildIndex();
await orchestrator.saveIndex('./brain/vault/index.json');

// Restore (query-ready immediately — no rebuild needed)
await orchestrator.loadIndex('./brain/vault/index.json');
```

Signatures are serialized as hex strings for JSON compatibility. BigInt is reconstructed on load.

---

## Output Format

Every query returns a `QueryResult`:

```typescript
{
  answer: string | null,        // null in retrieve mode
  citations: [{
    shardId: string,
    source: string,
    hammingRatio: number,       // lower = closer match
    contentPreview: string
  }],
  sourceTexts: [{
    shardId: string,
    source: string,
    fullText: string            // the actual verified source text
  }],
  metrics: {
    indexLookupMs: number,
    cacheMisses: number,
    inferenceMs: number,
    totalMs: number,
    shardsEvaluated: number,
    shardsSelected: number
  },
  silenced: boolean,            // true = nothing was close enough
  mode: "retrieve" | "query"
}
```

---

## Deployment Requirements

| Requirement | Notes |
|---|---|
| Node.js 20+ | TypeScript via `ts-node` |
| ARCHIVE drive mounted | All shard paths are relative to mount point |
| Ollama (optional) | Only required for RAG mode |
| `qwen2.5-coder:7b` pulled | Default inference model — swap in config |

No cloud. No API keys. No internet connection required.
