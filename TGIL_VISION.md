# TGIL — The Vision, The Architecture, The Why
**Author:** Joe Wales / NODE OUT
**Read this before asking Joe to explain anything.**

---

## The Core Insight

Standard RAG finds similar tokens. Fine-tuning bakes knowledge into weights. Both are wrong for high-stakes, fast-moving domains.

The alternative: **encode the structural geometry of a domain into a high-dimensional manifold that an agent inhabits rather than searches.**

The agent doesn't read the code. It arrives in the right region of space because the geometry already encodes what's related, what's contested, what's settled, what drifts, what's dangerous.

No fine-tuning. No hallucination. No retrieval theater.

---

## Where It Started — Roblox

The first proof was Roblox game state. Nobody was using time as a structural dimension.

Game state at frame N is causally shaped by frame N-1. So the vector became:

```
[v_t-1 | v_t | v_t+1]  →  3072-D point
```

- `v_t-1` — where this code came from
- `v_t`   — what this code is now
- `v_t+1` — where this code is going (physics-deterministic for Roblox)

Any agent dropped into that terrain could immediately predict game states. No training. Because it was *in* the code, not reading about it.

**This is the proof of concept. It worked.**

---

## The Epistemology

This is not a geometrical hack. It is a new epistemology for how agents interact with data.

Different data types have different natural geometries:

| Data Type | Natural Geometry | Processor | Dimensions |
|-----------|-----------------|-----------|------------|
| Game state, crypto, mempool | Causal/temporal — frame N depends on N-1 | `[v_t-1 \| v_t \| v_t+1]` concatenation | 3072-D |
| Legal doctrine, medical corpus | Topological — settled vs contested regions | Laplacian + heat kernel diffusion | 768-D |
| Repo self-knowledge (husks) | Fingerprint similarity — silence over fabrication | SimHash-128 + Hamming distance | bitwise |
| Property/financial records | Graph attention — GAT over entity relationships | Eve v2 (GAT + spectral) | 3072-D |

**The key rule:** temporal geometry is ONLY for data where sequence encodes causality — game states, block chains, liquidity pools, arbitrage windows, flash loans. Legal statutes from 1875 and 2024 are equally valid; no temporal axis applies.

---

## The Factory

All processing runs through one factory: **`spectral-terrain`**

```
DATA IN
  │
  ├── [temporal/causal]  →  engine/embed.ts  →  [v_t-1|v_t|v_t+1]  →  Qdrant 3072-D
  │
  ├── [corpus/doctrinal]  →  legal_heatmap.py  →  Laplacian topology  →  Qdrant 768-D
  │
  └── [repo husks]  →  simhash-guard.ts  →  SimHash-128 index  →  vault/index.json
```

Key factory components:
- `engine/embed.ts` — temporal vector builder, heat/shatter scoring
- `engine/ingest.ts` — ingests any codebase into terrain
- `engine/calibrate.ts` — computes Diamond-Stable centroid per domain
- `brain/spectral/legal_heatmap.py` — corpus Laplacian + heat kernel (domain-agnostic)
- `A-MEM-3072-ENGINE.ts` — REFRAG-OPRO monad: memory routing, DriftGuard, EvasionGate
- `eve_v2.py` — GAT + spectral for property/financial graph data

---

## The Receptacle Pattern

Every use case needs a **receptacle** — a thin interface that lets an agent query the terrain without knowing how it was built.

The WhiteGlove agent framework IS the universal receptacle:

```
WhiteGlove Agent Framework
  ├── RoleContract  (domain-specific rules + silence policy)
  ├── tool-registry (what tools this role can use)
  └── AgentLoop     (Faith-Less retrieval → answer or silence)
```

**Medical role** → queries medical vault → SimHash retrieval → Faith-Less answer
**Legal role** → queries legal-heatmap → cosine search → topology-aware answer
**Roblox role** → queries spectral-heatmap → 3072-D nearest → game state prediction

Same interface. Different vault. Same silence guarantee.

---

## The Pipeline Manifest

```
domain          → processor              → collection         → receptacle
─────────────────────────────────────────────────────────────────────────
roblox-luau     → temporal concat 3072-D → spectral-heatmap   → spectral-terrain/engine/query.ts
finance-crypto  → temporal concat 3072-D → spectral-heatmap   → spectral-terrain/engine/query.ts
legal-corpus    → Laplacian heatmap 768-D → legal-heatmap      → LawLibra /legal/query
medical-corpus  → SimHash-128            → vault/index.json   → WhiteGlove agent/index.ts
repo-husk       → SimHash-128            → vault/index.json   → WhiteGlove agent/index.ts
property-data   → Eve v2 GAT 3072-D     → hydra-unclaimed    → property-hydra query
```

---

## The Husk Pattern

A husk is a repo's **self-knowledge encoded as geometry**.

Instead of a README that an agent reads: ingest the entire source code of the repo into its own vault. An agent dropped into that repo queries the husk and arrives already knowing how to operate it — not by reading docs but by inhabiting the geometry of the codebase itself.

Example: `/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk`
The WhiteGlove repo ingested into its own SimHash vault. Any agent entering that directory queries `vault/index.json` and immediately knows the retrieval thresholds, architecture, silence policy, and operating commands — because those facts live in the geometry, not in prose.

This pattern should be applied to every major repo.

---

## What's Built vs What's Pending

**Built and working:**
- Roblox terrain (3072-D, temporal) — PROVEN
- legal_heatmap.py — Laplacian corpus topology, domain-agnostic
- WhiteGlove agent framework — Faith-Less retrieval, medical role live
- A-MEM-3072-ENGINE.ts — REFRAG-OPRO monad (routing layer)
- Eve v2 — GAT spectral for property data
- spectral-terrain — factory scaffold, ingest/query/calibrate

**Needs wiring:**
- Pipeline manifest as executable config (domain router)
- Legal role in WhiteGlove agent framework
- Parallel ingest (sequential Ollama calls are the bottleneck — fix with async batch)
- Husk pattern applied to spectral-terrain itself

---

## What Joe Is NOT Asking For

- Do not rewrite the math. The math is correct.
- Do not suggest RAG alternatives. This replaces RAG.
- Do not ask Joe to explain the architecture. Read this file.
- Do not write "theater" — scaffolding, boilerplate, or demo code that simulates the pipeline without actually running it.

If something is disconnected, **reconnect it**. If something is missing, **add the minimum wire**. The vision is complete. The implementation just needs its pieces joined.

---

## Key Paths

| Thing | Path |
|-------|------|
| Factory | `/Users/joewales/NODE_OUT_Master/spectral-terrain/` |
| Factory (768-D variant) | `/Users/joewales/NODE_OUT_Master/spectral-terrain-768/` |
| Legal heatmap processor | `/home/throttleneck-15/whiteglove/brain/spectral/legal_heatmap.py` |
| Eve v2 (property/GAT) | `/Users/joewales/property-hydra/knowledge/spectral/eve_v2.py` |
| OPRO monad | `/Users/joewales/NODE_OUT_Master/open-model-contracts/scripts/pi-lab/A-MEM-3072-ENGINE.ts` |
| WhiteGlove agent framework | `/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/agent/` |
| Legal receptacle (LawLibra) | `/Users/joewales/LawLibra/` |
| Legal use case (frontend) | `/Users/joewales/arbiterOS-legal-confidant-/` |
| Pi 5 (Qdrant + Ollama) | `ssh throttleneck-15@100.113.215.46` |
| Qdrant on Pi | `http://100.113.215.46:6333` |
| Ollama on Pi | `http://100.113.215.46:11434` — models: nomic-embed-text, mxbai-embed-large |

---

*This file is the canonical vision document. Update it when the architecture evolves. Copy it to `AGENT_ENTRY.md` in any repo that needs orientation.*
