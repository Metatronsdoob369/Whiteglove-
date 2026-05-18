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
