# evidence/hermes/ — harness run evidence

Transcript directories written by `harness/maintenance-check.sh` (and future
harness runners), one per run: `maintenance-<UTC>/NN-<probe>.txt` plus
`run-manifest.json` recording every probe's exit code and each transcript's
sha256.

Rules of this directory:

- **Transcripts are produced by the harness script, not the agent.** The agent
  reads them and narrates; it never writes here by hand. A claim without a
  transcript is not a finding.
- Reports follow the doctrine order: what was tried → what actually happened
  (each line cites a transcript file) → what we do about it → how it makes the
  system better; **verdict last**. Self-graded green — or self-graded
  "unbreakable" — is necessary, never sufficient.
- No secrets ever appear here. Payer addresses are public; keys never. The
  probes read no `.env.local` and no `X402_*` value, so there is nothing to
  leak — keep it that way when adding probes.
- Stage 1 writes evidence but never commits it. Committing evidence is a
  Stage-2 action: a worktree branch, a PR, a human merge (precedent: witness
  000001, commit 41f6810).
