# H1 — Witness backfill (first Stage-2 mission)

**Authority: Stage 2.** Mutation lands only as a PR; a human "go" merges it.

## Why this mission first

Witness 000001 was deliberately committed as the genesis attestation
(`41f6810 "witness 000001 — genesis attestation of the live ledger"`); the
nightly cuts since — `evidence/witness/witness-000002.json` through the
current tail — exist only on the operator's machine. Committing them makes
the attested chain public and reproducibly verifiable. Zero code, zero
config: this mission exists to exercise the whole Stage-2 loop
(worktree branch → transcript evidence → PR → human go) at minimum stakes.

## Steps

1. Worktree + branch, Mission-1 convention:
   ```bash
   git -C /Users/joewales/Whiteglove worktree add .claude/worktrees/witness-backfill -b worktree-witness-backfill master
   ```
2. Verify the chain read-only and keep the raw output — it goes in the PR
   body verbatim:
   ```bash
   node dist-gate/scripts/cut-witness.js verify \
     /Users/joewales/Whiteglove/spectral-x402/evidence/witness \
     /Users/joewales/Whiteglove/spectral-x402/packs
   ```
   (Run the LIVE checkout's compiled cutter against the LIVE evidence and
   trust store — the worktree has neither `dist-gate/` nor `packs/`.)
3. Copy the untracked witness files into the worktree's
   `spectral-x402/evidence/witness/` and `git add` exactly those files —
   nothing else.
4. One commit: `witness 0000NN–0000MM — backfill the attested chain`.
5. Push, open the PR: chain-verify transcript verbatim in the body, plus
   `shasum -a 256` of each added file. CI (the `x402-kernel` and
   `config-drift` jobs) gates it automatically.
6. Stop. The merge is the human's.

## Refusal conditions

- Chain verify reports any breach → no PR; report the breach with the
  transcript instead.
- Any file to be added differs from the live tree's copy (compare sha256)
  → stop and report.
