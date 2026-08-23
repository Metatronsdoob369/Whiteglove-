# harness/ — the Hermes harness

The staged-authority harness that makes Hermes the eventual CI agent for this
system: maintenance first, then config-only mount missions, then the market
lane. Charter: `docs/superpowers/specs/2026-08-19-hermes-harness-design.md`
(repo root). Missions live in `missions/`; evidence lands in
`../evidence/hermes/`.

## Why bash, and why this directory

Nothing in `harness/` is reachable by `tsconfig.gate.json` (which compiles
`scripts/**/*.ts` into `dist-gate/` — the build the launchd witness cutter
boots from) or by any launchd unit. A broken harness can therefore never break
the witness cutter, the morning check, or either service. Keep it that way:
no TypeScript in this directory, no imports from `src/`, no plist points here.

## Invariants (the short list — the charter carries the full one)

- **Report, never mutate.** The only sanctioned writes are evidence files
  under `evidence/hermes/` and, for Stage-2 missions, commits on a worktree
  branch that land as a PR. Merge-to-main requires a human "go".
- **Never compile on the live tree.** `npm test` runs `tsc`, which would bake
  uncommitted WIP into the `dist/` launchd boots. Suites run in CI or a
  disposable worktree only.
- **The script captures the transcripts; the agent narrates over them.**
  A claim without a transcript is not a finding. Self-graded green is
  necessary, never sufficient.
- Never touch `packs/.signing-key.pem`, wallet-mcp, `.env.local`, or any
  `X402_*` secret. Burner wallets for anything that pays.

## Contents

| Path | What |
|---|---|
| `ci-fixture-packs.sh` | Builds throwaway sealed packs so the suite runs on a clean checkout (CI). Refuses anywhere a signing key or sealed edition already exists. |
| `fixtures/` | Deterministic synthetic inputs for the fintel fixture pack. |
| `maintenance-check.sh` | The H0 runner — 8 read-only probes, each transcribed to `evidence/hermes/maintenance-<UTC>/` with sha256s in `run-manifest.json`. |
| `local-ci.sh` | The CI gate run locally: same two jobs as `quality.yml` (kernel suite + drift gate) in a disposable worktree, transcribed with a PASS/FAIL manifest. The merge gate when GitHub Actions is locked or gone. |
| `missions/` | Mission specs H0 (maintenance), H1 (witness backfill), H2 (mount a pack). |
