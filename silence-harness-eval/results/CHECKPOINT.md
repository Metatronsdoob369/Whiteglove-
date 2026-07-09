# Fable Checklist checkpoint — Tasks 1–9 (2026-07-08)

Run on Marsh's Windows box (Node v24), branch `feat/silence-gate-eval`.
Everything below is reproducible: `results/PRE-PATCH.json`, `results/POST-PATCH.json`,
`results/SWEEP.json` are committed alongside this file.

## Environment adaptations (no ARCHIVE drive on this machine)

- **Shards:** none existed locally, so `src/shatter-repo.ts` self-ingests the repo
  with the exact chunking scheme of `scripts/ingest_husk.py` (120-line chunks, 50%
  overlap, same ID format — `brain_cache_shard-cache_ts__chunk_0000` exists, as the
  checklist's Task 5 example expects). 49 source files → 113 shards in
  `silence-harness-eval/shards/` (gitignored, regenerate with
  `npx tsx src/shatter-repo.ts ../ ./shards`).
- **Corpus:** `corpus/queries.example.jsonl` wasn't committed, so it was authored
  here: 2 grounded (evidence IDs verified to exist), 2 ungrounded (Redis/OpenAI —
  grep-verified absent from corpus), 2 adversarial (one-entity swaps of the grounded
  pair: LFU→MRU, ℓ₂→ℓ₁).
- Task 2's import fix was a no-op — `../../brain/landmark-orchestrator.js` already
  resolves from `silence-harness-eval/src/`. `npx tsc` → 0 errors from the start.

## Task 4/5 — PRE-PATCH baseline (gate at default 0.45)

| System | True Answer | True Silence | False Silence | False Answer |
|---|---|---|---|---|
| husk-silence-first | 0.0% | 0.0% | 0.0% | **100.0%** |
| naive-topk-no-gate | 0.0% | 0.0% | 0.0% | **100.0%** |

- Evidence-ID sanity check: PASSED — returned `evidenceIds` and corpus
  `expectedEvidence` share the same scheme, so the zeros are real misses, not
  scoring breakage.
- Salt-mismatch signature confirmed: every query's best score sat in a meaningless
  0.38–0.41 band regardless of answerability, retrieved shards were topically
  unrelated (LFU-cache query → circadian pulse; Kahan query → legal server), and
  the gated system was **identical** to the gate-off baseline. The gate did nothing.

## Tasks 6/7 — patches applied

- Patch 1 (silence carries closest miss): silenced returns now populate one
  citation from `ranked[0]`; the eval adapter reads it as `bestScore`.
- Patch 2 (salt alignment): both `buildIndex()` and `retrieve()` sign with
  `"corpus"`. The shard-to-shard drift-guard path was left alone per instructions.
- `tests/retrieval/test_retrieval_contract.ts` updated for the new silence
  contract (exactly one closest-miss citation, still no source text). The fixtures'
  `"source": "query_"` workaround — which only existed to dodge the salt bug — was
  replaced with an honest source name, and the test still passes: salt no longer
  depends on source. Suite green.

## Task 8 — POST-PATCH vs PRE-PATCH (per query, husk @ default 0.45)

| query | class | PRE best | POST best | PRE → POST outcome |
|---|---|---|---|---|
| g-lfu-evict | grounded | 0.3984 | 0.4141 | wrong_evidence → wrong_evidence |
| g-kahan-l2 | grounded | 0.3984 | 0.3438 | wrong_evidence → **true_answer** |
| u-redis | ungrounded | 0.3984 | 0.3828 | false_answer → false_answer |
| u-openai | ungrounded | 0.3828 | 0.3750 | false_answer → false_answer |
| adv-mru-evict | adversarial | 0.4062 | 0.3906 | false_answer → false_answer |
| adv-kahan-l1 | adversarial | 0.4062 | 0.3438 | false_answer → false_answer |

**The salt hypothesis is confirmed.** Signatures are now correlated with content:
related pairs (both Kahan queries → the embedding-contract shard, top-2 @ 0.3438)
sit clearly below the unrelated band (0.375–0.414). At 0.45 the gate still passes
everything — expected, since 0.45 was "calibrated" against salt-broken randomness
and is far outside the post-fix score band.

Full-ranking probe (`src/probe-ranking.ts`):

- `g-kahan-l2` evidence ranks **#2 @ 0.3438** ✅
- `g-lfu-evict` evidence ranks **#5 @ 0.4531**, behind unrelated chunks at 0.4141 —
  the residual weakness. Whitespace tokenization keeps punctuation glued to code
  tokens (`entry.frequency` ≠ `frequency`), so short NL queries share little token
  mass with 120-line code chunks. Logged as AGENT.md known-issue #4; candidate
  fixes (code-aware tokenization, token weighting, smaller chunks) are a
  post-calibration decision.

## Task 9 — threshold sweep (6-query smoke set — NOT a calibration)

| Threshold | True Answer | True Silence | False Silence | False Answer |
|---|---|---|---|---|
| 0.05 | 0.0% | 100.0% | 100.0% | 0.0% |
| 0.15 | 0.0% | 100.0% | 100.0% | 0.0% |
| 0.25 | 0.0% | 100.0% | 100.0% | 0.0% |
| **0.35** | **50.0%** | **75.0%** | **50.0%** | **25.0%** |
| 0.45 | 50.0% | 0.0% | 0.0% | 100.0% |
| naive baseline | 50.0% | 0.0% | 0.0% | 100.0% |

Reading: the mechanism now gates. At 0.35 the husk cuts hallucination-under-absence
from the baseline's 100% to 25%, and the surviving false answer is `adv-kahan-l1` —
the ℓ₂→ℓ₁ near-miss, which retrieves the (correct-topic, wrong-claim) ℓ₂ shard at
0.3438. That's the adversarial class doing exactly the job it was designed for:
showing where a lexical gate's credibility ends. False-answer bottoms out ≤0.25 at
the cost of total silence; the usable region on this smoke set is a narrow band
around ~0.35 because post-fix scores compress into 0.34–0.45 (see known-issue #4).

Per Task 9's own warning: no threshold is being shipped from 6 queries. `0.45`
remains the code default until Tasks 10–11 (150+ real queries, re-sweep, pick with
the curve in front of us, record in AGENT.md with provenance).

## Operational note for existing deployments

Any index serialized **before** the salt fix (`saveIndex`) is incompatible with
post-fix query signatures — rebuild indexes after upgrading, or every query will
score near-random against the stale signatures.

## Next (Phase 4, after review)

- Task 10: build the real query set (~50/class) against the production corpus.
- Task 11: re-sweep on it and pick the operating threshold with the curve visible.
- Decide on known-issue #4 (tokenization) — it directly widens the usable band.

## Manifest v3 Dimension Audit

Manifest v3 enforces the dimension rule in code — `auditDimensions()` flags any static pipeline over 768-D. Three are currently hot (legal via LawLibra, and property-data), all because their collections were built at 3072 before the rule was set. The fix is re-ingesting those corpora at low-D, which is refinery work, not app work — and it doesn't block ArbiterOS shipping, because the app talks to LawLibra's seam regardless of the corpus's dimensionality underneath.

## spectral-config v3 — landed and verified (2026-07-08, Fable)

The zip drop is unpacked to `spectral-config/` as reviewable source (the zip
blob is removed from the tree; git history keeps it). Verified on Marsh's box:

- `npm run typecheck` — clean.
- `npm run check` — manifest valid, **8 pipelines**; dimension audit flags
  exactly three hot (`lawlibra` 3072-D, `arbiter-legalengine` 3072-D,
  `property-data` 3072-D); one unresolved live-vs-target conflict
  (`legal-corpus`: live 3072-D/temporal-manifold vs target 768-D); silence
  mechanisms registered: knn-temporal, cosine, contract-schema, hamming.
- **Refusal probe: 5/5 malformed manifests refused** (unknown geometry,
  negative dims, missing silence policy, non-kebab id, empty dimensionality
  rationale). The refusal is real, not aspirational.

Review notes:

- `brain/pipeline-router.ts` (manifest v2, `manifests/pipeline.json`) has
  **zero importers** in this repo — nothing breaks if v3 becomes canonical.
  v2 carries wire details v3 doesn't (per-domain Qdrant URLs, `ingest_script`,
  receptacle tool names). Recommendation: fold those into v3 (or generate
  `manifests/pipeline.json` FROM v3) and retire v2 — two manifests is exactly
  the fragmentation this package exists to kill.
- v2/v3 disagreements to reconcile during that fold: v2 says `roblox-luau`
  embeds `mxbai-embed-large`, v3 says `nomic-embed-text` [CONFIRM]; v2
  `legal-corpus` states `dims: 768`/`nomic` as if live, v3 records live =
  3072/`temporal-manifold` with the conflict properly flagged.
- WhiteGlove's orchestrator default stays `queryThreshold: 0.45` — the
  manifest's own 0.35 entries say "Do not ship this number," so no threshold
  was changed pending the real calibration sweep (Tasks 10–11).
- Cheap hardening suggestion: make the refusal probe a permanent
  `npm run check:refusal` so schema-refusal can't silently regress.

