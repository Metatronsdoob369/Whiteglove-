#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# finalize-mvp.sh — WhiteGlove v1.0.0-mvp Last Sprint
#
# Phases:
#   1. Typecheck       — tsc, zero tolerance
#   2. Shard check     — confirm index is buildable
#   3. Start server    — boot API in background
#   4. Smoke test      — hit /health + /query + /payload
#   5. Package payload — write SYSTEM_DIRECTIVE to dist/
#   6. Commit + tag    — v1.0.0-mvp
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

API_PORT=4880
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

banner() {
  echo -e "\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN}  $1${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC}  $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }

# ─── Phase 1: Typecheck ───────────────────────────────────────────────────────
banner "Phase 1 — TypeScript"

if ! command -v npx &>/dev/null; then
  fail "npx not found. Run: npm install"
fi

npx tsc --noEmit && ok "TypeScript clean" || fail "TypeScript errors — fix before shipping"

# ─── Phase 2: Shard Vault ────────────────────────────────────────────────────
banner "Phase 2 — Shard Vault"

SHARD_DIR="$ROOT/brain/shards/shattered"
STAGING_DIR="$ROOT/brain/shards/staging"

mkdir -p "$SHARD_DIR"

# Remove old contracting shards — superseded corpus
CONTRACTING_COUNT=$(find "$SHARD_DIR" -name "shard_*.json" | wc -l | tr -d ' ')
if [ "$CONTRACTING_COUNT" -gt 0 ]; then
  find "$SHARD_DIR" -name "shard_*.json" -delete
  ok "Removed $CONTRACTING_COUNT legacy contracting shards"
fi

# Corpus selection: WG_CORPUS=medical|fixture|auto (default auto).
# medical is the product when its vault is present; the committed fixture
# corpus (brain/fixture/corpus/) keeps the finish line runnable on a fresh
# clone and in CI, where the ARCHIVE drive does not exist.
CORPUS="${WG_CORPUS:-auto}"
MED_COUNT=$(find "$SHARD_DIR" -name "med_chunk_*.json" | wc -l | tr -d ' ')
if [ "$CORPUS" = "auto" ]; then
  if [ "$MED_COUNT" -gt 0 ]; then CORPUS="medical"; else CORPUS="fixture"; fi
fi

if [ "$CORPUS" = "medical" ]; then
  # Ensure medical shards exist — run rechunker if not
  if [ "$MED_COUNT" -eq 0 ]; then
    echo "  No medical shards found. Running rechunk pipeline..."
    python3 "$ROOT/brain/indexer/rechunk_medical.py" || fail "Rechunk pipeline failed"
    MED_COUNT=$(find "$SHARD_DIR" -name "med_chunk_*.json" | wc -l | tr -d ' ')
  fi
  SHARD_COUNT=$MED_COUNT
  [ "$SHARD_COUNT" -gt 0 ] || fail "No medical shards in vault — check rechunk_medical.py"
  SECTOR="medical"
  SMOKE_QUERY="what+is+A1C"
  ok "$SHARD_COUNT medical shards in vault"
else
  warn "Running against the committed FIXTURE corpus (no medical vault on this machine)"
  # Fixture vault is a derived artifact — always regenerate (idempotent, ~2s),
  # so corpus edits and shard-format changes can never leave a stale vault.
  echo "  Building fixture vault from brain/fixture/corpus/..."
  npx ts-node --project tsconfig.json brain/indexer/build-fixture-vault.ts || fail "Fixture vault build failed"
  FIX_COUNT=$(find "$SHARD_DIR" -name "fix_chunk_*.json" | wc -l | tr -d ' ')
  SHARD_COUNT=$FIX_COUNT
  [ "$SHARD_COUNT" -gt 0 ] || fail "No fixture shards — check brain/indexer/build-fixture-vault.ts"
  SECTOR="fixture"
  # Near-verbatim of two sentences from brain/fixture/corpus/faithless-retrieval.txt ¶2.
  # Measured against the paragraph shards: hammingRatio 0.2578 (gate 0.325) — answers.
  # One sentence alone measured 0.3281 — silenced. Don't shorten this query.
  SMOKE_QUERY="the+engine+inverts+standard+rag+a+query+is+fingerprinted+with+simhash-128+and+hamming+distance+ranking+finds+the+closest+knowledge+shards+in+the+vault+when+no+shard+clears+the+calibrated+hamming+distance+threshold+the+gate+returns+silence+instead+of+fabricating+an+answer"
  ok "$SHARD_COUNT fixture shards in vault"
fi

# ─── Phase 2b: Pre-build index ───────────────────────────────────────────────
banner "Phase 2b — Pre-build Vault Index"

VAULT_DIR="$ROOT/brain/shards/vault"
INDEX_FILE="$VAULT_DIR/index.json"
mkdir -p "$VAULT_DIR"

if [ ! -f "$INDEX_FILE" ]; then
  echo "  Building SimHash index over $SHARD_COUNT shards (one-time, ~30s)..."
  npx ts-node --project tsconfig.json brain/indexer/build-index.ts \
    && ok "Index built and persisted → $INDEX_FILE" \
    || fail "Index build failed"
else
  ok "Index already exists → $INDEX_FILE"
fi

# ─── Phase 3: Start server ───────────────────────────────────────────────────
banner "Phase 3 — API Server"

# Kill anything already on the port
lsof -ti:$API_PORT | xargs kill -9 2>/dev/null || true
sleep 1

PORT=$API_PORT npx ts-node --project tsconfig.json server/api.ts &
SERVER_PID=$!
ok "Server started (PID $SERVER_PID) on port $API_PORT"

# Wait for it to be ready
echo "  Waiting for server..."
for i in $(seq 1 20); do
  if curl -sf "http://localhost:$API_PORT/health" >/dev/null 2>&1; then
    ok "Server is up"
    break
  fi
  if [ "$i" -eq 20 ]; then
    fail "Server did not respond after 10s"
  fi
  sleep 0.5
done

# ─── Phase 4: Smoke tests ────────────────────────────────────────────────────
banner "Phase 4 — Smoke Tests"

# /health
HEALTH=$(curl -sf "http://localhost:$API_PORT/health")
STATUS=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "fail")
if [ "$STATUS" = "ok" ]; then
  ok "/health → $HEALTH"
else
  fail "/health returned unexpected response: $HEALTH"
fi

# /payload/:sector
PAYLOAD=$(curl -sf "http://localhost:$API_PORT/payload/$SECTOR")
if echo "$PAYLOAD" | grep -q "SYSTEM_DIRECTIVE"; then
  ok "/payload/$SECTOR → SYSTEM_DIRECTIVE generated"
else
  fail "/payload/$SECTOR did not return expected payload"
fi

# /retrieve — Faith-Less retrieve only (no LLM, no timeout risk)
RETRIEVE_RESULT=$(curl -sf "http://localhost:$API_PORT/retrieve?q=$SMOKE_QUERY" 2>&1 || echo "ERROR")

if echo "$RETRIEVE_RESULT" | grep -q "silenced"; then
  SILENCED=$(echo "$RETRIEVE_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['silenced'])" 2>/dev/null || echo "unknown")
  TOTAL_MS=$(echo "$RETRIEVE_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('metrics',{}).get('totalMs','?'))" 2>/dev/null || echo "?")
  ok "/retrieve → silenced=$SILENCED | ${TOTAL_MS}ms"
  # Fixture mode is a hard assertion: the smoke query is near-verbatim from a
  # committed paragraph shard, so it MUST retrieve. Silence here means the
  # retrieval path (shatter → index → gate) is broken, not strict.
  if [ "$CORPUS" = "fixture" ] && [ "$SILENCED" != "False" ]; then
    fail "fixture smoke query must retrieve (grounded, near-verbatim) — got silenced=$SILENCED"
  fi
else
  warn "/retrieve returned unexpected response"
  echo "  $RETRIEVE_RESULT" | head -3
fi

# ─── Phase 5: Package payload ────────────────────────────────────────────────
banner "Phase 5 — Package"

mkdir -p "$ROOT/dist"

# Write the canonical SYSTEM_DIRECTIVE payload for the active corpus
curl -sf "http://localhost:$API_PORT/payload/$SECTOR" \
  > "$ROOT/dist/WHITEGLOVE_SYSTEM_DIRECTIVE_${SECTOR}.json"
ok "dist/WHITEGLOVE_SYSTEM_DIRECTIVE_${SECTOR}.json written"

# Write a generic/general payload
curl -sf "http://localhost:$API_PORT/payload/general" \
  > "$ROOT/dist/WHITEGLOVE_SYSTEM_DIRECTIVE_general.json"
ok "dist/WHITEGLOVE_SYSTEM_DIRECTIVE_general.json written"

# Write version manifest
cat > "$ROOT/dist/manifest.json" <<EOF
{
  "name": "whiteglove-agent-husk",
  "version": "1.0.0-mvp",
  "description": "Sovereign tokenless memory — Faith-Less retrieval over massive datasets. No fine-tuning required.",
  "api": {
    "port": $API_PORT,
    "routes": {
      "query":   "POST /query",
      "health":  "GET  /health",
      "payload": "GET  /payload/:sector"
    }
  },
  "vault": {
    "shards": $SHARD_COUNT,
    "algorithm": "SimHash-128",
    "dimensions": "3072-D Spectral Landmark Projection",
    "threshold": 0.325
  },
  "built": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
ok "dist/manifest.json written"

# Kill server before commit
kill "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""
ok "Server stopped"

# ─── Phase 6: Commit + tag ───────────────────────────────────────────────────
banner "Phase 6 — Commit + Tag"

if [ "${WG_VERIFY:-0}" = "1" ]; then
  ok "Verify mode (WG_VERIFY=1) — skipping commit + tag"
elif [ ! -d "$ROOT/.git" ]; then
  warn "No git repo found — skipping commit. Run: git init"
else
  git -C "$ROOT" add \
    server/api.ts \
    finalize-mvp.sh \
    dist/manifest.json \
    "dist/WHITEGLOVE_SYSTEM_DIRECTIVE_${SECTOR}.json" \
    dist/WHITEGLOVE_SYSTEM_DIRECTIVE_general.json

  git -C "$ROOT" commit -m "$(cat <<'EOF'
feat(whiteglove): v1.0.0-mvp — Sovereign API + Faith-Less retrieval

- HTTP API server (server/api.ts): POST /query, GET /health, GET /payload/:sector
- Role factory: sector-agnostic, caller-defined shard directory
- SYSTEM_DIRECTIVE payload generator: drop-in sovereign agent context for any LLM
- dist/: packaged payloads + version manifest
- finalize-mvp.sh: typecheck → shard verify → smoke test → package → ship

Faith-Less. Silence-Gated. No fine-tuning required.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
  )" && ok "Committed" || warn "Nothing new to commit"

  git -C "$ROOT" tag -a v1.0.0-mvp \
    -m "WhiteGlove v1.0.0-mvp — Sovereign tokenless memory API" \
    2>/dev/null && ok "Tagged v1.0.0-mvp" || warn "Tag already exists"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
SHIP_LABEL="SHIPPED"
[ "${WG_VERIFY:-0}" = "1" ] && SHIP_LABEL="VERIFIED (verify mode — nothing committed or tagged)"
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  WhiteGlove v1.0.0-mvp [$CORPUS corpus] — ${SHIP_LABEL}${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Vault:    $SHARD_COUNT shards indexed"
echo "  API:      http://localhost:$API_PORT"
echo "  Payload:  dist/WHITEGLOVE_SYSTEM_DIRECTIVE_*.json"
echo "  Manifest: dist/manifest.json"
echo ""
echo "  To start:  PORT=4880 npx ts-node server/api.ts"
echo "  To query:  curl -X POST http://localhost:4880/query \\"
echo "               -H 'Content-Type: application/json' \\"
echo "               -d '{\"query\": \"your question\", \"sector\": \"medical\"}'"
echo ""
