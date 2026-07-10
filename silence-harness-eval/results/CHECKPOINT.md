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

## v2→v3 fold — executed per FOLD_SPEC (2026-07-08, Fable)

v4 schema landed; backward-compat verified first (unchanged v3 config
validated against the extended schema before any folding). Direction as
settled: v3 structure wins, v2 facts win, disagreements recorded — none
auto-picked.

- All 8 pipelines carry the wire fields; selfcheck now prints
  **"Wire fold (v2→v3): 8/8 — fold complete"** using the omitted-vs-`[]`
  semantic (absence = not yet folded, `[]` = confirmed none).
- ArbiterOS tools folded verbatim from its README (6): `consult_statute`,
  `verify_negotiability`, `analyze_clause_risks`, `draft_verified_form`,
  `verify_necessary`, `verify_ordinary`.
- v2 receptacle tool names preserved: `legal_retrieve`, `vault_retrieve`,
  `pattern_scan`, `terrain_query` (the three terrain pipelines).

**Disagreements for Joe (each recorded in the config where it lives):**

1. **roblox-luau + finance-crypto embed model** — v2 `mxbai-embed-large` vs
   v3 `nomic-embed-text` [CONFIRM]. Not locked; likely one answer for the
   temporal pair.
2. **property-data** — v2 note says "Not yet wired", v3 status says
   operational. Also FOLD_SPEC's tools cell said "property-hydra q" but v2's
   fact is `terrain_query` (v2 kept per settled direction). `ingest` left
   omitted = not-yet-folded: eve_v2.py's real path lives in the
   property-hydra repo, unreachable from here.
3. **repo-husk dual store** — v2 records a Qdrant husk path
   (`husk-{repo_name}`, scripts/ingest_husk.py, nomic, 768-D); v3 stores the
   local vault-index (build-index.ts). Both exist in the wild — canonical is
   Joe's call.
4. **medical-corpus Pi backup** — v2's `medical-heatmap` backup collection
   (nomic, 768-D) kept as a note so the fact isn't dropped.
5. **arbiter store.endpoint** — spec cell ":4881→:4880" isn't a URL; set
   `null` (pure consumer — the chain already lives in receptacle.ref).
   lawlibra's endpoint = `LAWLIBRA_URL` env per the ":4880 base" cell.

**Two-layer check is now permanent:** `npm run check:refusal` — **6/6**
(5 schema refusals + the adversarial case: a static 3072-D pipeline parses
fine AND is flagged by `auditDimensions()`). Layers verified distinct, exit
code gates CI if wired in.

**pipeline.json is now GENERATED:** `npm run generate:v2` emits
`manifests/pipeline.json` from the v3 manifest (8 domains, v2 receptacle
names preserved as the `receptacle` field). The hand-maintained v2 is
retired; pipeline-router.ts says so in its header and its `DomainRoute` type
matches the generated shape. NOTE: v2's `role` field has no v3 home — the
generated file omits it; if agent role-routing ever needs it, add an optional
`role` to the schema (one-liner, Joe's call).

**Secrets — acted on, plus one flag Joe should read:**

- `store.endpoint` values resolve from env (`QDRANT_PI_URL` /
  `LAWLIBRA_URL`, names matching ingest_husk.py). The folded config and the
  generated pipeline.json contain **zero endpoint literals** (grep-verified).
  `getQdrantUrl()`'s hardcoded Pi fallback now reads the env var too.
- ⚠ **Pre-existing exposure:** this repo is PUBLIC, and the Pi's Tailscale
  IP was already on master before this fold (old pipeline.json, the router
  fallback, scripts/ingest_husk.py defaults) — and stays in git history
  regardless. FOLD_SPEC's "fine for a private PR" premise doesn't hold here.
  Treat the IP/host as exposed — tailnet ACLs are the real boundary; consider
  rotating the tailnet IP and scrubbing ingest_husk.py's default in a
  follow-up. Flagged, not actioned: that script drives live ingests on Joe's
  side.


### Pre-Merge Manifest Corrections & Fact Arbitration

The PR #26 fact arbitration verified the following configuration rules, which were applied to `spectral-config/config/domains.config.ts` before merge:

1. **Roblox/Finance Embed Model:** Both models are active on the Pi, but all ingest scripts strictly use `mxbai-embed-large`. The v3 manifest was corrected from `nomic-embed-text` to `mxbai-embed-large`.
2. **property-data Status:** Confirmed operational. The `hydra-unclaimed` collection exists on the Pi (3072-D, 500 points). Ingest path verified as `agents/ingest_eve.py`.
3. **repo-husk Stores:** Both the local vault and Pi Qdrant collections exist. The manifest was updated to set Qdrant `husk-whiteglove` as the canonical store, and the local vault as the secondary mirror (`local-fast-path`).
4. **medical backup:** Pi collection `medical-heatmap` exists (29,333 points, 768-D). Note retained.
5. **arbiter endpoint:** Left as `null`. Arbiter routes through LawLibra's HTTP seam, not directly to Qdrant.

Additionally, a `provenance` field was added to the DomainPipeline schema. The `medical-corpus` and the WhiteGlove-resident legal data (in `repo-husk`) have been marked as `pipeline-test-fixture` to formally distinguish them from production corpora like LawLibra's canonical legal-heatmap.

### Post-merge hygiene (2026-07-09, Fable)

- **`manifests/pipeline.json` regenerated** — the arbitration edited the source
  manifest without rerunning `generate:v2`, so the generated artifact was one
  commit stale (embed models, husk-whiteglove store, eve ingest path). Working
  rule going forward: any `domains.config.ts` edit ends with
  `npm run generate:v2`.
- **The five in-config disagreement notes now record their resolutions** —
  they still asked "Joe confirms" for questions the arbitration had answered,
  which contradicted the corrected fields sitting right above them.
- **repo-husk `ingest.script` aligned to the new canonical store**: it still
  pointed at `brain/indexer/build-index.ts` (the local-vault builder) after
  the arbitration made Qdrant `husk-whiteglove` canonical. Now
  `scripts/ingest_husk.py` (the canonical store's builder — v2's own fact for
  the husk path), with build-index.ts noted as the secondary-vault builder.
  One-glance confirm requested from Joe since this cell wasn't in the
  arbitration list.
- Suggestion (not actioned): add `npm run typecheck && npm run check:refusal`
  in `spectral-config/` to quality.yml so manifest regressions gate PRs.


## Phase 4 — silence-gate calibration (2026-07-10, Fable; Tasks 10–11 CLOSED)

Branch `feat/silence-gate-calibration`. Everything reproducible from committed
artifacts: `corpus/queries.jsonl` (162 queries), `results/CAL-PRE-TOKENIZER.*`,
`results/CAL-POST-TOKENIZER.*`, `results/RANKS-PRE.json`, `results/RANKS-POST.json`.

### Task 10 — the real corpus

162 queries against the 131-shard repo self-corpus (57 source files):
**56 grounded** (evidence IDs verified to exist), **50 ungrounded** (every
premise term machine-verified absent via word-boundary grep), **56 adversarial**
(one-entity swaps of grounded queries). `src/check-corpus.ts` enforces all
invariants — it caught 2 authoring premise bugs (substring false-positives)
before any number was trusted. 0 hard failures, 0 weak-overlap warnings.

### Known-issue #4 fix — three measured steps

Baseline exposed how broken whitespace tokenization was at corpus scale:
**median grounded evidence rank 30/131 and NEGATIVE separation** — wrong
shards scored closer than right evidence, on average.

| tokenizer step | median rank | top-1 | top-3 | top-10 | negatives' closest |
|---|---|---|---|---|---|
| whitespace (baseline) | 30 | 7.1% | 16.1% | 33.9% | 0.2656 |
| + code-aware split | 13 | 16.1% | 21.4% | 44.6% | 0.2734 |
| + set semantics | 11 | 14.3% | 32.1% | 50.0% | 0.2891 |
| + corpus-IDF vote weighting | **8** | **25.0%** | **37.5%** | **53.6%** | **0.3281** |

Ungated (no-gate baseline) true-answer rate: **16.1% → 37.5%**. The negatives'
closest-shard floor rising 0.2656 → 0.3281 is what makes a zero-false-answer
threshold exist at all.

### Task 11 — the curve and the pick (full stack, 162 queries)

| Threshold | True Answer | True Silence | False Silence | False Answer |
|---|---|---|---|---|
| 0.25 | 1.8% | 100% | 98.2% | 0% |
| 0.30 | 5.4% | 100% | 92.9% | 0% |
| **0.325** | **7.1%** | **100%** | **91.1%** | **0%** |
| 0.35 | 14.3% | 89.6% | 76.8% | 10.4% |
| 0.375 | 30.4% | 49.1% | 30.4% | 50.9% |
| 0.40 | 35.7% | 12.3% | 5.4% | 87.7% |
| 0.45 | 37.5% | 0% | 0% | 100% |
| naive baseline | 37.5% | 0% | 0% | 100% |

**Picked: `queryThreshold = 0.325`** — the last zero-false-answer point.
Rationale: the product IS silence-over-fabrication; the headline number is
hallucination-under-absence, and 0.325 holds it at **0% vs the ungated
baseline's 100%** while keeping every answer it does give evidence-backed.
The cost is honest and documented: 91.1% false silence on this deliberately
hard corpus (short NL questions vs 120-line code chunks). `0.35` is the
documented recall-leaning alternative (2× true answers for 10.4% FA) — a
per-deployment call, recorded in the manifest note.

Margin warning: the closest unanswerable query sits at 0.3281 — 0.4 bits above
the gate. Any corpus or tokenizer change moves that tail: **re-sweep, always.**

### Where the number now lives

- `landmark-orchestrator.ts` default + provenance comment
- manifest `repo-husk.silence` — **first `calibrated: true` pipeline**, full
  provenance (corpus, size, date, curve pointer); `pipeline.json` regenerated
- README threshold table, AGENT.md §4 + known-issue #4 (FIXED, with numbers)
  + new §5.5 operational note
- server/api.ts SYSTEM_DIRECTIVE, finalize-mvp.sh vault blurb

### Operational notes

- **IDF weights are part of the index**: buildIndex computes them, saveIndex
  persists them, loadIndex restores them (and warns on pre-fix indexes).
  Indexes serialized before this change must be rebuilt.
- `similarityThreshold: 0.2858` (shard-drift path) predates the tokenizer
  change — flagged for recalibration, not touched.
- `broseidon-indexer.ts` / `medical-test.ts` still pin 0.45 explicitly for the
  MEDICAL corpus, which has never been swept — deliberately left alone; the
  medical manifest entry now says exactly that. Running the medical sweep on
  the Pi vault is the natural next calibration (Preston-side corpus).
