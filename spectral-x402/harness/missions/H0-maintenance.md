# H0 — Maintenance run (report-only, repeatable)

**Authority: Stage 1.** Read everything, mutate nothing. The only writes are
the transcript files the harness script itself produces.

## Run

```bash
bash harness/maintenance-check.sh
```

From a branch/worktree copy, point the live-system probes at the live
checkout:

```bash
X402_LIVE_DIR=/Users/joewales/Whiteglove/spectral-x402 bash harness/maintenance-check.sh
```

Eight probes, all reused from existing doctrine (morning-check probes, the
compiled witness cutter in verify mode, the write-free drift check):
git state · service health · discovery resources · witness-chain verify ·
manifest drift · CI runs · spec-vs-built drift checklist · commerce delta.

## Report

Write the report from the transcripts in `evidence/hermes/maintenance-<UTC>/`
— never from memory. Doctrine order, verdict last:

1. **What was tried** — the probe list, verbatim commands.
2. **What actually happened** — every line cites its transcript file by name
   (`03-discovery-resources.txt` says …). Quote statuses and counts exactly.
3. **What we do about it** — concrete next actions, each with an owner
   (operator / harness / out-of-scope).
4. **How it makes the system better.**
5. **Verdict.** Last, and only as strong as the transcripts.

Rule, quoted from the hub: "Self-graded green — or self-graded 'unbreakable'
— is necessary, never sufficient."

## Standing observations to carry while they hold

- The commerce flatline: witnesses have carried identical figures since
  genesis (2026-08-13). The `commerce-delta` probe exists to surface the day
  that changes — or keep saying plainly that it hasn't.
- Spec-vs-built drift is REPORT-ONLY: ops surface :8788, revocation/status
  lists, compensation mechanics, facilitator failover, FAULT_POINT suite,
  the ctl.sh restart gap (MCP door needs its own kickstart). Building any of
  these is out of harness scope (Boundary 1 — clarity).
