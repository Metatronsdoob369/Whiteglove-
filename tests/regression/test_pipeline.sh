#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PIPELINE="$ROOT_DIR/brain/spectral/pipeline_run.sh"
PUBLISHER="$ROOT_DIR/brain/spectral/legal_qdrant_publish.py"
MOCK_SERVER="$SCRIPT_DIR/mock_qdrant_server.py"

TEST_ID="regress_$$"
WORK_REL="tests/.tmp/$TEST_ID"
WORK_DIR="$ROOT_DIR/$WORK_REL"
RUN_DIR_BASE="$ROOT_DIR/brain/vault/runs"

MOCK_PID=""
MOCK_PORT=""

cleanup() {
  if [[ -n "${MOCK_PID}" ]]; then
    kill "$MOCK_PID" >/dev/null 2>&1 || true
    wait "$MOCK_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK_DIR"
  rm -rf "$RUN_DIR_BASE/test_${TEST_ID}_"*
}
trap cleanup EXIT

start_mock() {
  local points="$1"
  MOCK_PORT="$(python3 - <<'PY'
import socket
s=socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
PY
)"
  python3 "$MOCK_SERVER" --port "$MOCK_PORT" --points "$points" >"$WORK_DIR/mock.log" 2>&1 &
  MOCK_PID="$!"

  for _ in $(seq 1 50); do
    if curl -sf "http://127.0.0.1:${MOCK_PORT}/collections" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done

  echo "Failed to start mock Qdrant server" >&2
  return 1
}

stop_mock() {
  if [[ -n "${MOCK_PID}" ]]; then
    kill "$MOCK_PID" >/dev/null 2>&1 || true
    wait "$MOCK_PID" >/dev/null 2>&1 || true
    MOCK_PID=""
  fi
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "Assertion failed: expected output to contain: $needle" >&2
    return 1
  fi
}

mkdir -p "$WORK_DIR"

echo "[1/4] preflight mismatch abort"
mkdir -p "$WORK_DIR/shards_mismatch"
printf '{"id":"a"}\n' > "$WORK_DIR/shards_mismatch/a.json"
printf '{"id":"b"}\n' > "$WORK_DIR/shards_mismatch/b.json"
printf '{"a":{"heat":0.1}}\n' > "$WORK_DIR/heatmap_mismatch.json"

set +e
preflight_out=$(bash "$PIPELINE" compute \
  --run-id "test_${TEST_ID}_preflight" \
  --shards "$WORK_REL/shards_mismatch" \
  --heatmap "$WORK_REL/heatmap_mismatch.json" 2>&1)
preflight_code=$?
set -e

if [[ "$preflight_code" -eq 0 ]]; then
  echo "Expected compute preflight to fail on shard/heatmap mismatch" >&2
  exit 1
fi
assert_contains "$preflight_out" "ABORT: Shard/heatmap count mismatch"

echo "[2/4] publish --dry-run catches malformed JSONL"
runid_dry="test_${TEST_ID}_dryrun"
run_dir_dry="$RUN_DIR_BASE/$runid_dry"
mkdir -p "$run_dir_dry"
cat > "$run_dir_dry/points.jsonl" <<'JSONL'
{"id": 1, "vector": [0.1, 0.2], "payload": {"source": "ok"}}
{"id": 2, "vector": [0.3, 0.4], "payload": {"source": "oops"}
JSONL

start_mock 10
set +e
dry_out=$(bash "$PIPELINE" publish \
  --run-id "$runid_dry" \
  --qdrant "http://127.0.0.1:${MOCK_PORT}" \
  --collection legal-heatmap \
  --dry-run 2>&1)
dry_code=$?
set -e
stop_mock

if [[ "$dry_code" -ne 0 ]]; then
  echo "Dry-run should not fail hard on malformed lines" >&2
  echo "$dry_out" >&2
  exit 1
fi
assert_contains "$dry_out" "JSONL parse:"
assert_contains "$dry_out" "line 2"
assert_contains "$dry_out" "Dry-run complete. No writes made."

echo "[3/4] publisher resume checkpoint and completion"
cat > "$WORK_DIR/points_resume.jsonl" <<'JSONL'
{"id": 1, "vector": [0.1], "payload": {"k": "a"}}
{"id": 2, "vector": [0.2], "payload": {"k": "b"}}
{"id": 3, "vector": [0.3], "payload": {"k": "c"}}
{"id": 4, "vector": [0.4], "payload": {"k": "d"}}
{"id": 5, "vector": [0.5], "payload": {"k": "e"}}
JSONL
checkpoint="$WORK_DIR/checkpoint.json"

start_mock 0
python3 "$PUBLISHER" \
  --points-jsonl "$WORK_DIR/points_resume.jsonl" \
  --qdrant "http://127.0.0.1:${MOCK_PORT}" \
  --collection legal-heatmap \
  --batch 2 \
  --checkpoint "$checkpoint" \
  --end-line 3 > "$WORK_DIR/publish_first.log"

read -r line1 pts1 < <(python3 - <<PY
import json
ck=json.load(open('$checkpoint'))
print(ck['line_offset'], ck['published_points'])
PY
)
if [[ "$line1" != "3" || "$pts1" != "3" ]]; then
  echo "Checkpoint after partial publish expected line_offset=3 published_points=3, got $line1/$pts1" >&2
  exit 1
fi

python3 "$PUBLISHER" \
  --points-jsonl "$WORK_DIR/points_resume.jsonl" \
  --qdrant "http://127.0.0.1:${MOCK_PORT}" \
  --collection legal-heatmap \
  --batch 2 \
  --checkpoint "$checkpoint" > "$WORK_DIR/publish_resume.log"

read -r line2 pts2 < <(python3 - <<PY
import json
ck=json.load(open('$checkpoint'))
print(ck['line_offset'], ck['published_points'])
PY
)
if [[ "$line2" != "5" || "$pts2" != "5" ]]; then
  echo "Checkpoint after resume expected line_offset=5 published_points=5, got $line2/$pts2" >&2
  exit 1
fi

server_count=$(curl -sf "http://127.0.0.1:${MOCK_PORT}/collections/legal-heatmap" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['points_count'])")
if [[ "$server_count" != "5" ]]; then
  echo "Mock Qdrant points_count expected 5, got $server_count" >&2
  exit 1
fi
stop_mock

echo "[4/4] verify snapshot emits provenance"
runid_verify="test_${TEST_ID}_verify"
run_dir_verify="$RUN_DIR_BASE/$runid_verify"
mkdir -p "$run_dir_verify"
cp "$WORK_DIR/points_resume.jsonl" "$run_dir_verify/points.jsonl"
cat > "$run_dir_verify/publish_checkpoint.json" <<'JSON'
{
  "line_offset": 5,
  "published_points": 5,
  "updated_at_epoch": 0
}
JSON

start_mock 5
verify_out=$(bash "$PIPELINE" verify \
  --run-id "$runid_verify" \
  --qdrant "http://127.0.0.1:${MOCK_PORT}" \
  --collection legal-heatmap)
stop_mock

assert_contains "$verify_out" "Snapshot saved:"
snapshot="$run_dir_verify/demo_snapshot.md"
if [[ ! -f "$snapshot" ]]; then
  echo "Expected verify snapshot file at $snapshot" >&2
  exit 1
fi
snap_content="$(cat "$snapshot")"
assert_contains "$snap_content" "## Provenance"
assert_contains "$snap_content" "Pass:              YES"

echo "All regression checks passed."
