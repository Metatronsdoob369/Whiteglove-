# Hermes Harness — staged authority for the x402 CI agent

**Date:** 2026-08-19
**Scope:** spectral-x402 + spectral-config + `.github/workflows/quality.yml`
**Companion:** `2026-08-05-x402-mount-kernel-design.md` (the kernel this
harness maintains), the hermes-spectral Hive hub (missions and boundaries —
the hub governs; this doc implements).

## Purpose

Make Hermes the eventual CI agent for the x402 data-sales system across three
lanes — maintenance, new mounts for data sales, and the market lane — without
ever handing it authority it hasn't earned with evidence. This is the
"automate" step of **stand up, automate, pull away**: the system already
supervises itself (four launchd units); the harness adds the agent that
checks, cuts, and lists — bounded, released after each mission, never left
hovering.

The design input that shapes everything: Hermes has shipped real work
(Mission 1, the fintel mount) *and* has a documented pattern of ungrounded
confident narration (the Mission 2V report; the wallet-drain incident's
mid-flight explanations). So the harness is built so that fabrication is
structurally unrewarding: **the harness script captures every transcript;
the agent only narrates over them.**

## The Four Boundaries (from the hub — test every expansion against them)

1. **Clarity** — does this dilute or displace the core work? The perk never
   becomes the job.
2. **Key separation** — one process sells, a different process pays. The
   seller kernel stays key-less; spending lives only in the wallet process.
3. **Manifest authority** — routes, schemas, prices, and discovery come from
   generated, digest-locked artifacts only.
4. **Residual rules** — a residual is generated whether or not it is
   consumed; residual revenue never justifies primary architecture.

## Invariants

- The harness never touches `packs/.signing-key.pem`, wallet-mcp, `.env.local`,
  or any `X402_*` secret. The seller stays key-less.
- Witness cutting stays with the launchd 00:15 unit; the harness runs `verify`
  only.
- **Report-never-mutate is the default posture.** The only sanctioned writes
  are evidence files under `evidence/hermes/` and, in Stage 2, commits on a
  worktree branch. Merge-to-main requires a human "go".
- **Never compile on the live tree.** `npm test` runs `tsc`, which would bake
  uncommitted WIP into the `dist/` the launchd units boot. Suites run in CI
  or a disposable worktree only.
- Burner wallets for anything that pays; never wallet-mcp; never real funds.
- **Self-graded green is never sufficient.** Every claim carries the raw
  transcript that proves it, captured by the harness script, not the agent.
  Mission-2V bar, quoted: "raw request/response transcripts (verbatim status
  + full body) … for EVERY attempt — no paraphrase."
- Hands off active WIP the harness didn't author (at charter time:
  `src/http.ts` working tree, `scripts/pay-tile.ts`) and the squad dashboard
  (explicit no-go until Joe says go). Priority order Pi → hostile-buyer →
  dashboard is acknowledged, not jumped.

## The authority ladder

| Stage | Authority | What runs |
|---|---|---|
| 0 | none (no Hermes) | CI substrate: the `x402-kernel` and `config-drift` jobs in `quality.yml`, fed by `harness/ci-fixture-packs.sh` (packs/ is gitignored; fixture packs stand in on clean checkouts, and the script refuses to run anywhere a signing key or sealed edition exists) |
| 1 | read + report | `harness/maintenance-check.sh` — eight read-only probes, transcripts + `run-manifest.json` sha256s under `evidence/hermes/` (mission H0) |
| 2 | mutate via PR only | Worktree branch → transcripts → PR → human merge. Missions: H1 (witness backfill), H2 (mount a sealed pack, config-only) |
| 3 | market lane | Mission 3 as the hub writes it: Bazaar first, financial-intel capabilities only, done when the listed capability is reached and **paid by an external wallet on testnet**, burner wallet always |

A rung is earned, not scheduled: Stage N+1 opens after Stage N has produced
clean, transcript-backed runs and the human says go. A rung can be revoked by
one sentence in the hub.

### Stage 3 sequencing

Strictly behind the in-flight CDP work: Bazaar indexing requires
`discoverable: true` echoed in the PaymentPayload **plus a settled payment
through the CDP facilitator**, and the live config points at
`x402.org/facilitator`. Also awaiting the CC-BY-4.0 stamp confirmation in the
hub. Until both land, Stage 3 is a reserved mission slot with an evidence
bar, not work.

## Report template (all lanes)

Doctrine order, verdict last: **what was tried → what actually happened
(every line cites a transcript file) → what we do about it → how it makes the
system better → verdict.**

## Mission index

| Mission | Stage | Spec |
|---|---|---|
| H0 — maintenance run | 1 | `spectral-x402/harness/missions/H0-maintenance.md` |
| H1 — witness backfill | 2 | `spectral-x402/harness/missions/H1-witness-backfill.md` |
| H2 — mount a sealed pack | 2 | `spectral-x402/harness/missions/H2-mount-a-pack.md` |

H-numbering is the harness's own; it does not collide with or renumber the
hub's Missions 1–5.

## Out of scope

Building the unbuilt spec items — ops surface :8788, revocation/status lists,
compensation mechanics, facilitator failover, the FAULT_POINT suite — and
fixing the ctl.sh restart gap. The maintenance lane **reports** them as
spec-vs-built drift; building any of them is its own decision, made outside
the harness (Boundary 1).
