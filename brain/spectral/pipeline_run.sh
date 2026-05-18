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

compute_stage() {
  echo "=== Compute Stage ==="
  echo "Run ID:     $RUN_ID"
  echo "Shards:     $SHARDS_PATH"
  echo "Heatmap:    $HEATMAP_PATH"
  echo "Ollama:     $OLLAMA_URL"
  echo "Emit:       $POINTS_JSONL"

  [[ -d "$SHARDS_PATH" ]] || { echo "Missing shards dir: $SHARDS_PATH"; exit 1; }
  [[ -f "$HEATMAP_PATH" ]] || { echo "Missing heatmap file: $HEATMAP_PATH"; exit 1; }

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

  [[ -f "$POINTS_JSONL" ]] || { echo "Missing points file: $POINTS_JSONL"; exit 1; }

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
