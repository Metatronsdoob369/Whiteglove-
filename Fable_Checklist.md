# WhiteGlove Husk — Harness Kickoff Chore List

Ordered. Each task has a done-check. Don't skip the pre-patch run (Task 4) — it's the before-image that proves the salt fix did something.

Assumptions: Node 20+, `tsx` available, repo checked out, shattered shards on disk. Adjust paths to your tree.

---

## Phase 1 — Wire it up

### Task 1: Drop the harness into the repo
- Unzip `silence-harness-v5` somewhere inside the repo (e.g., `tools/silence-harness/` or utilize the existing `/Users/joewales/Whiteglove/silence-harness-eval` directory).
- `cd` into the harness directory and run `npm install` (installs typescript, tsx, @types/node).
- [ ] Done: `npx tsc` runs and reports ONLY the landmark-orchestrator import error.

### Task 2: Fix the import path (2 files)
- In `src/adapter.ts` and `src/husk-tui.ts`, line 1: change `../../brain/landmark-orchestrator.js` to the correct relative path from the harness location to your compiled/orchestrator module.
- If the repo runs TS directly via tsx, the `.js` extension in the import may need to stay (nodenext) — confirm against how the rest of the repo imports.
- [ ] Done: `npx tsc` reports 0 errors.

### Task 3: Point at the shards
- Set `SHARD_DIR` to the real shattered path (the orchestrator's default is the `/Volumes/ARCHIVE/...` path from the original box — almost certainly wrong here).
- [ ] Done: `SHARD_DIR=... npx tsx -e "import('./src/adapter.js')"` doesn't throw a shard-dir-not-found warning on index build.

---

## Phase 2 — Pre-patch baseline (DO NOT SKIP)

### Task 4: Run the harness UNPATCHED against the example corpus
- Run the evaluation command:
  ```bash
  SHARD_DIR=... npx tsx src/run-eval.ts corpus/queries.example.jsonl
  ```
- Save the output: `cp results/results.json results/PRE-PATCH.json`
- Expectation if the salt hypothesis is right: high `false_answer` and/or `wrong_evidence`, few or zero `true_silence`. Record what you actually see.
- [ ] Done: `results/PRE-PATCH.json` exists and is committed/stashed somewhere safe.

### Task 5: Sanity-check evidence IDs line up
- Open `results/PRE-PATCH.json`, pick one grounded query, confirm the `evidenceIds` the pipeline returned use the SAME id format as the `expectedEvidence` in the corpus (both should look like `brain_cache_shard-cache_ts__chunk_0000`).
- If they don't match format, scoring is silently broken — fix the corpus IDs or the adapter's `evidenceIds` mapping before trusting any number.
- [ ] Done: at least one grounded query shows a real evidence-ID match OR you've confirmed the mismatch and its cause.

---

## Phase 3 — Apply the patches (from PATCHES.md)

### Task 6: Patch 1 — silence carries closest miss
- In `landmark-orchestrator.ts` `retrieve()`, the `selected.length === 0` block: populate `citations` with `ranked[0]`'s shardId/source/hammingRatio/preview.
- This one is behavior-preserving for answers, only adds data to silence.
- [ ] Done: a query you expect to be silenced now returns a citation with a hammingRatio (visible in the TUI silence render or results.json bestScore).

### Task 7: Patch 2 — align the salts
- In `buildIndex()`: `simHash128FromText(shard.content, "corpus")`.
- In `retrieve()`: `simHash128FromText(question, "corpus")`.
- Leave the shard-to-shard drift guard (similarityThreshold path) alone — its per-source separation is intentional there.
- [ ] Done: both call sites use the identical schema string.

### Task 8: Re-run, compare to PRE-PATCH
- Run the evaluation command again:
  ```bash
  SHARD_DIR=... npx tsx src/run-eval.ts corpus/queries.example.jsonl
  ```
- Save the post-patch output: `cp results/results.json results/POST-PATCH.json`
- Diff the two. You're looking for: true_silence up, false_answer down, related-query Hamming ratios dropping below unrelated ones.
- [ ] Done: PRE vs POST diff captured. If nothing changed, STOP — the salt hypothesis was wrong and we need to look again before proceeding.

---

## Phase 4 — Calibrate (only after Phase 3 shows separation)

### Task 9: Run the threshold sweep
- Run the sweep evaluation:
  ```bash
  SHARD_DIR=... npx tsx src/run-eval.ts corpus/queries.example.jsonl --sweep 0.05,0.15,0.25,0.35,0.45
  ```
- Read the table. Note where false_answer bottoms out and where false_silence starts climbing.
- [ ] Done: sweep table saved. Do NOT hardcode a threshold from this — 6 queries is not a calibration set. This is a smoke test of the mechanism, not a value to ship.

### Task 10: Build the real query set
- Target ~50 per class (grounded / ungrounded / adversarial).
- Grounded: real questions with real expectedEvidence shard IDs.
- Ungrounded: plausible-for-domain, unanswerable from corpus.
- Adversarial: take a grounded query, swap ONE entity/version/feature.
- [ ] Done: `corpus/queries.jsonl` with 150+ lines, loader accepts it.

### Task 11: Re-sweep on the real set, THEN pick a threshold
- Same sweep command against the full corpus.
- Choose the operating threshold WITH THE CURVE IN FRONT OF YOU — the point that zeroes false_answer usually spikes false_silence; that tradeoff is a per-deployment call, not a constant.
- [ ] Done: a threshold chosen with documented false_answer/false_silence values at that point. Record it in AGENT.md with the corpus + date it was calibrated against, so it's a snapshot with provenance, not a magic number.

---

## Report back for review
After Task 8, paste: PRE-PATCH.json, POST-PATCH.json, and the Task 9 sweep table. That's the checkpoint where we confirm the gate works before building out the real corpus.
