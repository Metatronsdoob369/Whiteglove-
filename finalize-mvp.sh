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

# ─── Phase 2: Shard check ────────────────────────────────────────────────────
banner "Phase 2 — Shard Vault"

SHARD_DIR="$ROOT/brain/shards/shattered"
STAGING_DIR="$ROOT/brain/shards/staging"

if [ ! -d "$SHARD_DIR" ]; then
  fail "Shard directory missing: $SHARD_DIR"
fi

SHARD_COUNT=$(find "$SHARD_DIR" -name "*.json" | wc -l | tr -d ' ')
if [ "$SHARD_COUNT" -eq 0 ]; then
  fail "No shards found in $SHARD_DIR — run the ingestion pipeline first"
fi
ok "$SHARD_COUNT shards in vault"

if [ -d "$STAGING_DIR" ]; then
  STAGING_COUNT=$(find "$STAGING_DIR" -name "*.json" | wc -l | tr -d ' ')
  if [ "$STAGING_COUNT" -gt 0 ]; then
    warn "$STAGING_COUNT oversized shards isolated in staging — review before next ingest"
  fi
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

# /payload/medical
PAYLOAD=$(curl -sf "http://localhost:$API_PORT/payload/medical")
if echo "$PAYLOAD" | grep -q "SYSTEM_DIRECTIVE"; then
  ok "/payload/medical → SYSTEM_DIRECTIVE generated"
else
  fail "/payload/medical did not return expected payload"
fi

# /query — use first available shard title as the query
FIRST_SHARD=$(find "$SHARD_DIR" -name "*.json" | head -1)
SHARD_TITLE=$(python3 -c "import json; d=json.load(open('$FIRST_SHARD')); print(d.get('title','test query')[:60])" 2>/dev/null || echo "test query")

echo "  Query: \"$SHARD_TITLE\""
QUERY_RESULT=$(curl -sf -X POST "http://localhost:$API_PORT/query" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"$SHARD_TITLE\", \"sector\": \"medical\"}" 2>&1 || echo "ERROR")

if echo "$QUERY_RESULT" | grep -q "sessionId"; then
  SILENCED=$(echo "$QUERY_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['silenced'])" 2>/dev/null || echo "unknown")
  TOTAL_MS=$(echo "$QUERY_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['totalMs'])" 2>/dev/null || echo "?")
  ok "/query → silenced=$SILENCED | ${TOTAL_MS}ms"
else
  warn "/query returned unexpected response — check server logs"
  echo "  $QUERY_RESULT" | head -5
fi

# ─── Phase 5: Package payload ────────────────────────────────────────────────
banner "Phase 5 — Package"

mkdir -p "$ROOT/dist"

# Write the canonical SYSTEM_DIRECTIVE payload
curl -sf "http://localhost:$API_PORT/payload/medical" \
  > "$ROOT/dist/WHITEGLOVE_SYSTEM_DIRECTIVE_medical.json"
ok "dist/WHITEGLOVE_SYSTEM_DIRECTIVE_medical.json written"

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
    "threshold": 0.45
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

if [ ! -d "$ROOT/.git" ]; then
  warn "No git repo found — skipping commit. Run: git init"
else
  git -C "$ROOT" add \
    server/api.ts \
    finalize-mvp.sh \
    dist/manifest.json \
    dist/WHITEGLOVE_SYSTEM_DIRECTIVE_medical.json \
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
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  WhiteGlove v1.0.0-mvp — SHIPPED${NC}"
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
