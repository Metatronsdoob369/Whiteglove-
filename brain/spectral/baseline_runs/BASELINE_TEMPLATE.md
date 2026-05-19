# WhiteGlove Canonical Baseline Run

**Run ID:** `<run_id>`  
**Date:** `<YYYY-MM-DD HH:MM UTC or local time>`  
**Pipeline Version/Commit:** `<commit SHA>`  
**Operator:** `<name or initials>`

---

## Corpus

- **Source:** `<dataset/corpus path or identifier>`
- **Final points_count:** `<integer>`
- **Any data pre-processing notes:**
  - `<notes>`

---

## Artifacts

- **Compute output:**  
  - Path: `<path>`  
  - Artifact SHA(s): `<SHA256...>`
- **Publish location:**  
  - Path/URL: `<path or URL>`
- **Verify logs/output:**  
  - Path: `<path>`

---

## Key Outputs & Snapshots

- **Demo snapshot:**  
  - Location: `brain/vault/runs/<run_id>/demo_snapshot.md` (runtime/local)
  - Versioned mirror: `brain/spectral/baseline_runs/<run_id>.md` (tracked)
  - Sample retrieval behavior:
    - No-match query: `"<example_no_match_query>"` → `silenced = true`
    - Known-hit query: `"<example_hit_query>"` → source: `"..."`

---

## Pipeline Parameters

- Compute parameters:
  - SimHash threshold: `<value>`
  - Query threshold: `<value>`
  - Context shards: `<value>`
  - Model: `<model or none>`
- Environment/infra notes:
  - `<node/os/cpu/ram/pod info>`

---

## Verification

- Did all pipeline stages complete (`compute`, `publish`, `verify`)?
- All artifact checksums/SHA256 recorded?
- Manual test queries pass (`no-match` / `known-hit`)?
- All output counts match expectations?

---

## Notes

- Any observed issues, warnings, or anomalies.
- Lessons learned or tweaks for future baselines.

---

## Audit Linkage

- Previous baseline: `<run_id or N/A>`
- Superseded/Updated by: `<run_id if newer exists>`

---

## Session Handover Checklist

- [ ] Golden repo state confirmed (all PRs merged, CI green, SHA recorded)
- [ ] Baseline run complete and versioned:
  - Path: `brain/spectral/baseline_runs/<run_id>.md`
  - Corpus, counts, run ID, and audit fields filled
- [ ] Active corpus status:
  - [ ] All completed ingests and point counts recorded
  - [ ] Next corpus and ingest plan clearly named
- [ ] Scripts and pipelines:
  - [ ] All paths, runbook steps, and flags checked/updated as needed
  - [ ] Known-hit retrieval and silence tests logged (demo query)
- [ ] Security/compliance:
  - [ ] Secret scan, regression, and retrieval contract tests up to date
  - [ ] `.gitleaks.toml` and ignore paths current
- [ ] All operational notes, pod/tunnel/network context recorded
- [ ] Next step clear (who, what, where, run ID/plan)
- [ ] Last updated timestamp (UTC/local)

Any future agent or operator should use this checklist to confirm full state awareness before proceeding.

## Session State Block

```markdown
# WhiteGlove Session State — <YYYY-MM-DD HH:MM>

- **Repo SHA:** `<commit_sha>`
- **Baseline run:** `<run_id>` (see: `brain/spectral/baseline_runs/<run_id>.md`)
- **Corpus summary:**
  | Corpus    | Shards   | Status         |
  |-----------|----------|----------------|
  | Example X | 12,345   | Complete, green|
  | Example Y | 9,876    | In progress    |
  | Example Z | -        | Next planned   |
- **Operational status:**
  - No active pods/tunnels _or_ {details if running}
  - Point counts: [List Pi Qdrant, artifacts]
- **Quality & Compliance:** All checks green: [x] Regression [x] Retrieval [x] Secrets
- **Publisher-plane:** All publishing via Mac/Pi publisher; no direct pod->Qdrant.
- **Action Log (last 2-3 moves):**
  - Closed `<run_id>`
  - Started planning `<next_run_id>`
  - Updated baseline records and scripts
- **Next step:** `<next major action, e.g., uscode_v1_artifact_publisher compute>`
- **Last updated:** `<timestamp>`

---

**Operator:** `<name or initials>`
**Contact/Slack:** `<channel or DM>`
```
