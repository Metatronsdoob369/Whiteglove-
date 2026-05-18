# Clean Pipeline Architecture (Compute Plane + Publisher Plane)

## Goal
Maximize control, reproducibility, and cost safety by separating expensive compute from network-sensitive publishing.

## Architecture
1. Compute Plane (ephemeral GPU pod)
- Responsibilities: embed, temporal-compose, classify, emit point artifacts.
- Output: JSONL point artifact + run manifest.
- No direct dependency on Pi/Qdrant availability.

2. Artifact Plane (durable storage)
- Responsibilities: persist point JSONL, heatmap, and manifests.
- Suggested location: `brain/vault/runs/<run_id>/`.

3. Publisher Plane (stable host: Mac or Pi)
- Responsibilities: read artifacts and upsert into Qdrant with checkpointed resume.
- Uses `legal_qdrant_publish.py`.

4. Serving Plane (ArbiterOS / WhiteGlove retrieval)
- Responsibilities: query only published collections.
- Never coupled to live compute jobs.

## Why This Fixes Current Failure Modes
1. Pod network fragility no longer causes full job loss.
2. Qdrant/Tailscale tunnel issues only affect publishing, not compute.
3. Resume is deterministic at artifact line offsets.
4. Cost control: GPU time used only for math, not retries.

## New Tools
1. `legal_temporal_ingest.py` (updated)
- Added:
`--emit-jsonl`, `--append-jsonl`, `--emit-manifest`, `--emit-only`

2. `legal_qdrant_publish.py` (new)
- Reads emitted JSONL and publishes in resumable batches.
- Checkpoint file stores line offset and published count.

3. `pipeline_run.sh` (new)
- Unified wrapper for clean operations: `compute`, `publish`, `all`, `status`.
- Standard artifact layout: `brain/vault/runs/<run_id>/`.

## Recommended Run Pattern
### Preferred (single wrapper)
1. Compute only
```bash
bash brain/spectral/pipeline_run.sh compute \
  --run-id alabama_2026_05_18 \
  --shards brain/shards/alabama_full \
  --heatmap brain/shards/vault/alabama_full_heatmap.json
```

2. Publish only
```bash
bash brain/spectral/pipeline_run.sh publish \
  --run-id alabama_2026_05_18 \
  --qdrant http://100.113.215.46:6340 \
  --collection legal-heatmap
```

3. End-to-end
```bash
bash brain/spectral/pipeline_run.sh all \
  --run-id alabama_2026_05_18 \
  --shards brain/shards/alabama_full \
  --heatmap brain/shards/vault/alabama_full_heatmap.json \
  --qdrant http://100.113.215.46:6340
```

4. Status
```bash
bash brain/spectral/pipeline_run.sh status --run-id alabama_2026_05_18
```

### Manual (component scripts)
1. Compute stage on pod (artifact-only)
```bash
python3 spectral/legal_temporal_ingest.py \
  --shards /root/shards/alabama_full \
  --heatmap /root/shards/vault/alabama_full_heatmap.json \
  --ollama http://localhost:11434 \
  --emit-only \
  --emit-jsonl /root/shards/vault/alabama_points.jsonl \
  --emit-manifest /root/shards/vault/alabama_points_manifest.json
```

2. Transfer artifact to stable host
- Copy `/root/shards/vault/alabama_points.jsonl` + manifest to Mac/Pi durable path.

3. Publish stage on stable host
```bash
python3 brain/spectral/legal_qdrant_publish.py \
  --points-jsonl ~/whiteglove/brain/vault/alabama_points.jsonl \
  --qdrant http://100.113.215.46:6340 \
  --collection legal-heatmap \
  --batch 100 \
  --checkpoint ~/whiteglove/brain/vault/alabama_publish_checkpoint.json
```

4. Resume publish after interruption
```bash
python3 brain/spectral/legal_qdrant_publish.py \
  --points-jsonl ~/whiteglove/brain/vault/alabama_points.jsonl \
  --qdrant http://100.113.215.46:6340 \
  --collection legal-heatmap \
  --batch 100 \
  --checkpoint ~/whiteglove/brain/vault/alabama_publish_checkpoint.json
```

## Cutover Plan
1. Keep current direct-ingest path as fallback during transition.
2. Run one full artifact-only compute job and publish from stable host.
3. Compare point counts and sample retrieval parity.
4. Flip default ops to compute+publish split after parity pass.

## Rollback Plan
1. If publisher issues occur, continue serving existing collection unchanged.
2. Resume publisher from checkpoint after fix.
3. No need to re-run compute unless artifacts are corrupted.

## Operational Guardrails
1. Never run pod compute without `--emit-manifest`.
2. Treat point JSONL as immutable run artifact.
3. Store run id in filenames and checkpoint paths.
4. Rotate credentials/keys from logs immediately.
