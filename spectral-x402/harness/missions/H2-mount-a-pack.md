# H2 — Mount a sealed pack (Stage-2 mission template)

**Authority: Stage 2.** All work in a worktree; mutation lands only as a PR;
a human "go" merges; the live box is never touched by the agent.

Adding a mount is config-only — proven by the boundary suite's third-mount
test (`src/test/boundary.test.ts`: "a third mount over an existing sealed
pack boots and delivers with no new adapter and no code") and by Mission 1
(commit `e95ee00 "mount fintel-paper-arena — a manifest edit, zero kernel
code"`). This template turns that recipe into an assignable mission.

## Candidates on disk (sealed, unmounted)

- `packs/heatmap-raw-2026-08` — raw f32 payloads (the payload-agnosticism pack)
- `packs/hydra-unclaimed-2026-08`

**Assumption to clear with Joe before assignment: is the dataset cleared to
sell?** `hydra-unclaimed` especially — unclaimed-property-adjacent data needs
a licensing/PII pass before it becomes a paid mount. The mission does not
start until that clearance is written down.

## Steps (agent, in a worktree)

1. Preflight, read-only: the pack quadruple exists
   (`.idx`/`.dat`/`.manifest.json`/`.seal.json`) and the seal verifies against
   `packs/terrain-keys.json`. Transcript everything.
2. Add a pipeline entry with a full `commercial` block to
   `spectral-config/config/domains.config.ts`, modeled on the fintel block
   (the complete template, `domains.config.ts` ~lines 739–835):
   `distribution: "sealed-paid"`, `commercial.sold: true`, the three standard
   operations, prices as atomic strings, and `payToRef: "<mount>-payto"` —
   a logical ref only. It resolves at boot from env
   `X402_PAYTO_<MOUNT>_PAYTO`; no address, no secret enters git.
3. `cd spectral-config && npm run generate:all` — rewrites `manifests/*.json`
   **and `generated.lock`** (boot digest-verifies against the lock, so the
   regenerated artifacts are part of the change). Then `npm run check:all`.
4. `cd spectral-x402 && npm test` — in the worktree, never the live tree.
5. Commit the config + regenerated manifests. PR body carries the transcripts
   (generate, check:all, test) and the discovery diff (resource count before
   → after).
6. Stop. The merge and everything below are the human's.

## Manual checklist for the PR body (Joe-only — the agent cannot do these)

- [ ] Set `X402_PAYTO_<REF>` in `spectral-x402/.env.local` (see `.env.example`)
- [ ] After merge, on the live box: `npm run build` in spectral-x402
- [ ] `bash service/ctl.sh restart` **and** — until ctl.sh restarts all units —
      `launchctl kickstart -k "gui/$(id -u)/co.marshpress.x402.mcp"`
- [ ] Next morning check shows the new resource count (9 → 12 per mount added)

## Prerequisite to settle before first assignment

Hermes push credentials vs. Joe-pushes-the-branch, and branch protection on
master. Until settled, the agent prepares the worktree and the human pushes.
