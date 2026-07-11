# WhiteGlove — plan

Thin scheduling layer. Deep orientation lives in
[`brain/spectral/CLEAN_PIPELINE_ARCHITECTURE.md`](brain/spectral/CLEAN_PIPELINE_ARCHITECTURE.md) —
this file says what is scheduled, not how the pipeline works.

## Vision

WhiteGlove is offline-first, hallucination-resistant intelligence infrastructure built on
one principle: **silence over fabrication.** If the answer isn't in the vault, the agent
says nothing — in high-stakes work, an agent that fabricates nothing beats one that sounds
confident. Zero network dependency, zero cloud; runs from a portable ARCHIVE drive.

Today's engine inverts standard RAG: SimHash-128 fingerprints the query, Hamming distance
finds the closest knowledge shards, and if nothing clears the calibrated threshold the
agent stays silent. Retrieve mode returns verified source text as-is (~1ms, no LLM on the
path); query mode optionally synthesizes through a local model.

But the durable direction is a different **epistemology** than retrieval. WhiteGlove is
moving to **spectral-terrain**: knowledge is embedded, composed, and emitted as a geometric
heatmap so information is *experienced as navigable terrain* — zones and neighborhoods you
move through — rather than looked up as flat text. The pipeline (compute plane → heatmap
artifact → publisher → serving) is built and in final testing, with baseline runs already
logged; it will supersede RAG-style retrieval as the primary access model. Domain packs
swap by changing the vault index — medical today, legal and any corpus tomorrow.

## Current state

_2026-07-10_

- **Faith-Less retrieval engine — operational.** SimHash-128 ranking + Hamming drift guard,
  LFU shard cache + hot ring buffer, ℓ₂-normalization gate (Kahan summation), circadian
  WAKE/DREAM re-index. Thresholds calibrated: `0.2858` shard-drift, `0.45` query-retrieval.
  `retrieve()` prioritized over `query()` until a Q4 model is configured. CI quality gates
  (regression + secret scan + docs hygiene) green.
- **Spectral-terrain pipeline — built, in final testing.** Compute / artifact / publisher /
  serving planes per `CLEAN_PIPELINE_ARCHITECTURE.md`; baseline runs under
  `brain/spectral/baseline_runs/`. v2→v3 manifest fold underway (`spectral-config/FOLD_SPEC.md`).
- **Uncommitted WIP on disk** (not in this PR): `husk-production-scaffold/`, `packages/`.

## Next work

- [ ] Finish spectral-terrain testing → promote it to the primary access model over
      RAG-style retrieval. _(owner: Preston)_
- [ ] Resolve v2→v3 fold `[CONFIRM]` disagreements — Pi-side facts, Joe arbitrates.
- [ ] Configure a Q4 model so `query()` synthesis is first-class.
- [x] Backfill Co-Lab standard files — this PR (Bonnie).
