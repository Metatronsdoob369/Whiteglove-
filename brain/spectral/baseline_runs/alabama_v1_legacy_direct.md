# WhiteGlove Canonical Baseline Run

**Run ID:** `alabama_v1_legacy_direct`  
**Date:** `2026-05-18 17:07 CDT (2026-05-18 22:07 UTC)`  
**Pipeline Version/Commit:** `50fa30f06cc97dfb5e65db521babbd5c8b62f6da`  
**Operator:** `JoeCWales`

---

## Corpus

- **Source:** Alabama ingest (full corpus) from pod shard set `/root/shards/alabama_full`
- **Final points_count:** `52,294` (`status=green`) — 52,294/52,294 shards, perfect completion
- **Live points_count (snapshot time):** `41,481` (`status=green`)
- **Any data pre-processing notes:**
  - Heatmap generated before ingest (`alabama_full_heatmap.json`)
  - Temporal ingest writes into `legal-heatmap`
  - Tunnel interruptions observed and recovered during run

---

## Artifacts

- **Compute output:**  
  - Path: `N/A for this run (legacy direct path; no emit-jsonl artifact persisted)`  
  - Artifact SHA(s): `N/A`
- **Publish location:**  
  - Qdrant: `http://100.113.215.46:6340`  
  - Collection: `legal-heatmap`
- **Verify logs/output:**  
  - Pod log: `/tmp/ingest.log` (pod)
  - Local monitoring: tunnel + point count checks

---

## Key Outputs & Snapshots

- **Demo snapshot:**  
  - Runtime/local: `brain/vault/runs/alabama_v1_legacy_direct/demo_snapshot.md`
  - Versioned/tracked: `brain/spectral/baseline_runs/alabama_v1_legacy_direct.md`
  - Sample retrieval behavior:
    - No-match query: `"completely unrelated nebula harmonics with zero overlap"` → `silenced = true`
    - Known-hit query: `"Are there any kinds of laws that prohibit personally harmful speech?"` → source: `<fill from retrieval result>`

---

## Pipeline Parameters

- Compute parameters (thresholds, chunk size, etc.):
  - SimHash threshold: `0.2858` (orchestrator default)
  - Query threshold: `0.45` (orchestrator default)
  - Context shards: `3` (orchestrator default)
  - Model: `mxbai-embed-large` (ingest embedding) / `qwen2.5-coder:7b` (orchestrator query mode default)
- Any environment/infra notes:
  - Repo branch at snapshot: `master`
  - Tunnel mode used for pod -> Pi writes (`127.0.0.1:16340` on pod)

---

## Verification

- Did all pipeline stages complete (compute, publish, verify)?
  - `COMPLETE` — ingest finished 2026-05-18 17:35 CDT, 52,294/52,294 shards
- All artifact checksums/SHA256 recorded?
  - `N/A for this run` (no persisted JSONL artifact — legacy direct path)
- Manual test queries pass (no-match/hit)?
  - `No-match contract covered in CI retrieval contract test`
  - `Known-hit on legal corpus: CONFIRMED — query "DUI blood alcohol limit Alabama" → shard al_32_5A_191_001 (Title 32 Chapter 5A, DUI statutes)`
- All output counts match expectations?
  - `YES — Pi Qdrant points_count=52,294 == shard count 52,294`

---

## Notes

- Observed transient tunnel failures causing `Qdrant flush failed` warnings; tunnel revived and ingest resumed.
- For strict canonical lineage, next run should be artifact-backed (`compute -> publish -> verify`) using `pipeline_run.sh` run directory artifacts.

---

## Audit Linkage

- Previous baseline: `N/A`
- Superseded/Updated by: `<future_run_id>`
