#!/usr/bin/env bash
# pipeline_run.sh — Clean compute/publish orchestration for legal spectral ingest
#
# Modes:
#   compute  -> generate point artifacts only (no Qdrant writes)
#   publish  -> publish existing point artifacts to Qdrant with checkpoint resume
#   all      -> compute then publish
#   status   -> show run artifact/checkpoint status
#   verify   -> three-way integrity check: JSONL lines vs checkpoint vs Qdrant points_count
#
# Examples:
#   bash brain/spectral/pipeline_run.sh compute --run-id alabama_2026_05_18 \
#     --shards brain/shards/alabama_full --heatmap brain/shards/vault/alabama_full_heatmap.json
#
#   bash brain/spectral/pipeline_run.sh publish --run-id alabama_2026_05_18 \
#     --qdrant http://100.113.215.46:6340 --collection legal-heatmap
#
#   bash brain/spectral/pipeline_run.sh all --run-id alabama_2026_05_18 \
#     --shards brain/shards/alabama_full --heatmap brain/shards/vault/alabama_full_heatmap.json \
#     --qdrant http://100.113.215.46:6340

set -euo pipefail

usage() {
  cat <<USAGE
Usage: $0 <compute|publish|all|status|verify> [options]

Options:
  --run-id <id>          Explicit run id (default: run_YYYYMMDD_HHMMSS)
  --shards <path>        Shards path relative to repo root
  --heatmap <path>       Heatmap JSON path relative to repo root
  --ollama <url>         Ollama URL for compute stage
  --qdrant <url>         Qdrant URL for publish stage
  --collection <name>    Qdrant collection name
  --batch <n>            Publish batch size (default: 100)
  --resume <n>           Compute stage resume index
  --end <n>              Compute stage end index (exclusive)
  --start-line <n>       Publisher JSONL start line override
  --end-line <n>         Publisher JSONL end line override
  --dry-run              Publish: parse + validate only, no Qdrant writes
USAGE
}

MODE="${1:-}"
if [[ -z "$MODE" || "$MODE" == "--help" || "$MODE" == "-h" ]]; then
  usage
  exit 0
fi
shift || true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

RUN_ID="run_$(date +%Y%m%d_%H%M%S)"
RUN_START_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
SHARDS_REL="brain/shards/alabama_full"
HEATMAP_REL="brain/shards/vault/alabama_full_heatmap.json"
OLLAMA_URL="http://localhost:11434"
QDRANT_URL="http://localhost:6340"
COLLECTION="legal-heatmap"
BATCH="100"
RESUME="0"
END=""
START_LINE=""
END_LINE=""
DRY_RUN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id) RUN_ID="$2"; shift 2 ;;
    --shards) SHARDS_REL="$2"; shift 2 ;;
    --heatmap) HEATMAP_REL="$2"; shift 2 ;;
    --ollama) OLLAMA_URL="$2"; shift 2 ;;
    --qdrant) QDRANT_URL="$2"; shift 2 ;;
    --collection) COLLECTION="$2"; shift 2 ;;
    --batch) BATCH="$2"; shift 2 ;;
    --resume) RESUME="$2"; shift 2 ;;
    --end) END="$2"; shift 2 ;;
    --start-line) START_LINE="$2"; shift 2 ;;
    --end-line) END_LINE="$2"; shift 2 ;;
    --dry-run) DRY_RUN="1"; shift ;;
    *)
      echo "Unknown arg: $1"
      exit 1
      ;;
  esac
done

RUN_DIR="$ROOT_DIR/brain/vault/runs/$RUN_ID"
POINTS_JSONL="$RUN_DIR/points.jsonl"
COMPUTE_MANIFEST="$RUN_DIR/compute_manifest.json"
PUBLISH_CHECKPOINT="$RUN_DIR/publish_checkpoint.json"

mkdir -p "$RUN_DIR"

SHARDS_PATH="$ROOT_DIR/$SHARDS_REL"
HEATMAP_PATH="$ROOT_DIR/$HEATMAP_REL"

preflight_check() {
  echo "=== Preflight ==="
  [[ -d "$SHARDS_PATH" ]] || { echo "ABORT: Missing shards dir: $SHARDS_PATH"; exit 1; }
  [[ -f "$HEATMAP_PATH" ]] || { echo "ABORT: Missing heatmap file: $HEATMAP_PATH"; exit 1; }

  local shard_count
  shard_count=$(find "$SHARDS_PATH" -maxdepth 1 -name "*.json" | wc -l | tr -d ' ')

  local heatmap_count
  heatmap_count=$(python3 -c "
import json, sys
try:
    d = json.load(open('$HEATMAP_PATH'))
    # heatmap is a dict keyed by shard id
    print(len(d))
except Exception as e:
    print('ERROR')
" 2>/dev/null || echo "ERROR")

  echo "Shard files:    $shard_count  ($SHARDS_PATH)"
  echo "Heatmap keys:   $heatmap_count  ($HEATMAP_PATH)"

  if [[ "$heatmap_count" == "ERROR" ]]; then
    echo "ABORT: Could not parse heatmap file."
    exit 1
  fi

  if [[ "$shard_count" -ne "$heatmap_count" ]]; then
    echo "ABORT: Shard/heatmap count mismatch — $shard_count shards vs $heatmap_count heatmap keys."
    echo "       Re-run legal_heatmap.py before compute."
    exit 1
  fi

  echo "Preflight OK: $shard_count shards == $heatmap_count heatmap keys"
  echo ""
}

compute_stage() {
  echo "=== Compute Stage ==="
  echo "Run ID:     $RUN_ID"
  echo "Shards:     $SHARDS_PATH"
  echo "Heatmap:    $HEATMAP_PATH"
  echo "Ollama:     $OLLAMA_URL"
  echo "Emit:       $POINTS_JSONL"

  preflight_check

  local extra=()
  if [[ -n "$END" ]]; then
    extra+=(--end "$END")
  fi

  python3 "$SCRIPT_DIR/legal_temporal_ingest.py" \
    --shards "$SHARDS_PATH" \
    --heatmap "$HEATMAP_PATH" \
    --ollama "$OLLAMA_URL" \
    --resume "$RESUME" \
    --emit-only \
    --emit-jsonl "$POINTS_JSONL" \
    --emit-manifest "$COMPUTE_MANIFEST" \
    "${extra[@]}"

  echo "Compute complete."
}

publish_stage() {
  echo "=== Publish Stage ==="
  echo "Run ID:       $RUN_ID"
  echo "Points JSONL: $POINTS_JSONL"
  echo "Qdrant:       $QDRANT_URL"
  echo "Collection:   $COLLECTION"
  echo "Checkpoint:   $PUBLISH_CHECKPOINT"
  [[ -n "$DRY_RUN" ]] && echo "Mode:         DRY RUN (no writes)"

  [[ -f "$POINTS_JSONL" ]] || { echo "Missing points file: $POINTS_JSONL"; exit 1; }

  if [[ -n "$DRY_RUN" ]]; then
    echo ""
    echo "--- Dry-run checks ---"

    # 1. Parse every line of JSONL
    local parse_errors
    parse_errors=$(python3 -c "
import json, sys
errors = []
with open('$POINTS_JSONL') as f:
    for i, line in enumerate(f, 1):
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
            if 'id' not in d or 'vector' not in d:
                errors.append(f'line {i}: missing id or vector')
        except Exception as e:
            errors.append(f'line {i}: {e}')
if errors:
    print('\n'.join(errors[:20]))
    if len(errors) > 20:
        print(f'... and {len(errors)-20} more')
else:
    print('OK')
" 2>/dev/null || echo "ERROR: parse failed")
    echo "JSONL parse:      $parse_errors"

    # 2. Checkpoint state
    if [[ -f "$PUBLISH_CHECKPOINT" ]]; then
      echo "Checkpoint:       present — $(cat "$PUBLISH_CHECKPOINT")"
    else
      echo "Checkpoint:       none (fresh publish)"
    fi

    # 3. Qdrant collection health
    local qdrant_health
    qdrant_health=$(curl -sf "${QDRANT_URL}/collections/${COLLECTION}" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    pts = d['result']['points_count']
    status = d['result']['status']
    print(f'OK — status={status} points={pts}')
except:
    print('ERROR')
" 2>/dev/null || echo "UNREACHABLE")
    echo "Qdrant health:    $qdrant_health"

    echo ""
    echo "Dry-run complete. No writes made."
    return 0
  fi

  local extra=()
  if [[ -n "$START_LINE" ]]; then
    extra+=(--start-line "$START_LINE")
  fi
  if [[ -n "$END_LINE" ]]; then
    extra+=(--end-line "$END_LINE")
  fi

  python3 "$SCRIPT_DIR/legal_qdrant_publish.py" \
    --points-jsonl "$POINTS_JSONL" \
    --qdrant "$QDRANT_URL" \
    --collection "$COLLECTION" \
    --batch "$BATCH" \
    --checkpoint "$PUBLISH_CHECKPOINT" \
    "${extra[@]}"

  echo "Publish complete."
}

status_stage() {
  echo "=== Run Status ==="
  echo "Run ID:         $RUN_ID"
  echo "Run Dir:        $RUN_DIR"
  echo "Points JSONL:   $POINTS_JSONL"
  echo "Manifest:       $COMPUTE_MANIFEST"
  echo "Checkpoint:     $PUBLISH_CHECKPOINT"

  if [[ -f "$POINTS_JSONL" ]]; then
    echo "Points lines:   $(wc -l < "$POINTS_JSONL" | tr -d ' ')"
  else
    echo "Points lines:   (missing)"
  fi

  if [[ -f "$COMPUTE_MANIFEST" ]]; then
    echo "Manifest:       present"
  else
    echo "Manifest:       (missing)"
  fi

  if [[ -f "$PUBLISH_CHECKPOINT" ]]; then
    echo "Checkpoint data:" 
    cat "$PUBLISH_CHECKPOINT"
  else
    echo "Checkpoint:     (missing)"
  fi
}

verify_stage() {
  echo "=== Verify Stage ==="
  echo "Run ID:       $RUN_ID"
  echo "Run Dir:      $RUN_DIR"
  echo "Qdrant:       $QDRANT_URL"
  echo "Collection:   $COLLECTION"
  echo ""

  local jsonl_lines=0
  local checkpoint_line=0
  local checkpoint_points=0
  local qdrant_count="N/A"
  local pass=1

  # 1. JSONL line count
  if [[ -f "$POINTS_JSONL" ]]; then
    jsonl_lines=$(wc -l < "$POINTS_JSONL" | tr -d ' ')
    echo "JSONL lines:        $jsonl_lines  ($POINTS_JSONL)"
  else
    echo "JSONL lines:        MISSING  ($POINTS_JSONL)"
    pass=0
  fi

  # 2. Checkpoint last committed line
  if [[ -f "$PUBLISH_CHECKPOINT" ]]; then
    read -r checkpoint_line checkpoint_points < <(python3 -c "
import json, sys
try:
    d = json.load(open('$PUBLISH_CHECKPOINT'))
    # Current publisher schema uses: line_offset, published_points
    # Keep backward compatibility with older key name last_committed_line.
    line = d.get('line_offset', d.get('last_committed_line', 0))
    pts = d.get('published_points', 0)
    print(f'{line} {pts}')
except Exception as e:
    print('0 0')
" 2>/dev/null || echo "0 0")
    echo "Checkpoint line:    $checkpoint_line  ($PUBLISH_CHECKPOINT)"
    echo "Checkpoint points:  $checkpoint_points  ($PUBLISH_CHECKPOINT)"
  else
    echo "Checkpoint line:    (no checkpoint yet)"
    echo "Checkpoint points:  (no checkpoint yet)"
  fi

  # 3. Qdrant points_count
  qdrant_count=$(curl -sf "${QDRANT_URL}/collections/${COLLECTION}" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d['result']['points_count'])
except:
    print('ERROR')
" 2>/dev/null || echo "ERROR")
  echo "Qdrant points:      $qdrant_count  (${QDRANT_URL}/collections/${COLLECTION})"

  echo ""

  # Summary
  if [[ "$jsonl_lines" -gt 0 && "$checkpoint_line" -gt 0 ]]; then
    local pct_committed=$(python3 -c "print(f'{100 * $checkpoint_line / $jsonl_lines:.1f}%')" 2>/dev/null || echo "?")
    echo "Publish progress:   $checkpoint_line / $jsonl_lines lines ($pct_committed)"
  fi

  if [[ "$jsonl_lines" -gt 0 && "$checkpoint_line" -gt "$jsonl_lines" ]]; then
    echo "Integrity:          WARNING — checkpoint line exceeds JSONL lines"
    pass=0
  fi

  if [[ "$jsonl_lines" -gt 0 && "$qdrant_count" != "ERROR" && "$qdrant_count" != "N/A" ]]; then
    local delta=$((jsonl_lines - qdrant_count))
    if [[ "$delta" -le 0 ]]; then
      echo "Integrity:          OK — Qdrant has >= JSONL lines (possible multi-run overlap)"
    else
      echo "Integrity:          $delta lines in JSONL not yet in Qdrant"
    fi
  fi

  # 4. Capture snapshot
  local snapshot="$RUN_DIR/demo_snapshot.md"
  local end_ts
  end_ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  local git_sha
  git_sha="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")"
  local script_hash
  script_hash="$(shasum -a 256 "${BASH_SOURCE[0]}" 2>/dev/null | awk '{print $1}' || echo "unknown")"
  local ingest_hash
  ingest_hash="$(shasum -a 256 "$SCRIPT_DIR/legal_temporal_ingest.py" 2>/dev/null | awk '{print $1}' || echo "unknown")"
  local publish_hash
  publish_hash="$(shasum -a 256 "$SCRIPT_DIR/legal_qdrant_publish.py" 2>/dev/null | awk '{print $1}' || echo "unknown")"

  cat > "$snapshot" <<SNAP
# Demo Snapshot — $RUN_ID

## Timestamps
- Started:  $RUN_START_TS
- Verified: $end_ts

## Provenance
- Git SHA:              $git_sha
- pipeline_run.sh:      $script_hash
- legal_temporal_ingest.py: $ingest_hash
- legal_qdrant_publish.py:  $publish_hash

## Run
- Run ID:    $RUN_ID
- Qdrant:    $QDRANT_URL
- Collection: $COLLECTION

## Integrity Check
- JSONL lines:       $jsonl_lines
- Checkpoint line:   $checkpoint_line
- Checkpoint points: $checkpoint_points
- Qdrant points:     $qdrant_count
- Pass:              $([[ "$pass" -eq 1 ]] && echo "YES" || echo "NO — see verify output")

## Notes
<!-- run method: legacy-direct | artifact-publisher -->
<!-- corpus: alabama_v1 | uscode_v1 | ... -->
<!-- pod: host, port, instance id, cost/hr -->
SNAP
  echo ""
  echo "Snapshot saved: $snapshot"

  if [[ "$pass" -eq 0 ]]; then
    echo ""
    echo "WARNING: One or more checks failed — see above."
    return 1
  fi
}

case "$MODE" in
  compute)
    compute_stage
    ;;
  publish)
    publish_stage
    ;;
  all)
    compute_stage
    publish_stage
    verify_stage
    ;;
  status)
    status_stage
    ;;
  verify)
    verify_stage
    ;;
  *)
    echo "Invalid mode: $MODE"
    usage
    exit 1
    ;;
esac
