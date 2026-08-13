#!/usr/bin/env bash
# morning-check.sh — the daily check-in. Reads the x402 system's own state
# and reports it to Telegram, so the operator is TOLD how the machine did
# rather than having to go look. Runs under a launchd timer at 08:00 local.
#
# Reports, never mutates. Every probe tolerates its own failure so a down
# service still produces a report (that IS the report). Always appends to
# logs/morning-check.log; also sends to Telegram when a token is reachable.
#
# Telegram token is read at runtime from $TELEGRAM_ENV (default: the local
# channel .env) — it never enters git or this file. Chat id from $TG_CHAT_ID.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8787}"
WITNESS_DIR="${WITNESS_DIR:-$ROOT/evidence/witness}"
KEYS_DIR="${KEYS_DIR:-$ROOT/packs}"
CUTTER="$ROOT/dist-gate/scripts/cut-witness.js"
LOG="$ROOT/logs/morning-check.log"
TELEGRAM_ENV="${TELEGRAM_ENV:-$HOME/.claude/channels/telegram/.env}"
TG_CHAT_ID="${TG_CHAT_ID:-6985719694}"
# Prefer the injected NODE (the plist pins the install-time nvm path): the
# PATH fallback can resolve homebrew Node 26, which better-sqlite3 v11
# refuses — the cutter's verify would false-alarm on every morning report.
NODE="${NODE:-$(command -v node || echo node)}"
STAMP="$(date '+%Y-%m-%d %H:%M %Z')"

# ── service health ────────────────────────────────────────────────────────────
if health="$(curl -fsS -m 5 "http://localhost:$PORT/health" 2>/dev/null)"; then
  svc="UP  $health"
else
  svc="DOWN (no /health on :$PORT)"
fi

# ── mount / resource count from live discovery ────────────────────────────────
if disc="$(curl -fsS -m 5 "http://localhost:$PORT/.well-known/x402" 2>/dev/null)"; then
  res_n="$("$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).resources||[]).length)}catch{console.log("?")}})' <<<"$disc")"
  mounts="$res_n resources live"
else
  mounts="discovery unreachable"
fi

# ── witness chain audit (read-only verify) ────────────────────────────────────
if [ -f "$CUTTER" ]; then
  if wout="$("$NODE" "$CUTTER" verify "$WITNESS_DIR" "$KEYS_DIR" 2>&1)"; then
    chain="$(printf '%s' "$wout" | tail -1)"
  else
    chain="VERIFY FAILED — $(printf '%s' "$wout" | tail -1)"
  fi
else
  chain="cutter not compiled (run npm run witness:verify once)"
fi

# ── latest witness headline numbers ───────────────────────────────────────────
latest="$(ls "$WITNESS_DIR"/witness-*.json 2>/dev/null | sort | tail -1)"
if [ -n "$latest" ]; then
  head_line="$("$NODE" -e '
    const w=require(process.argv[1]).witness;
    const vol=(w.ledger.settled_volume||[]).map(v=>`${v.amount_atomic_total} ${v.asset}`).join(", ")||"0";
    console.log(`witness #${w.index} — calls ${w.ledger.calls_total}, receipts ${w.ledger.receipts_success_total}, payers ${w.ledger.unique_payers}, volume ${vol}, breaches ${w.invariants.breaches}`);
  ' "$latest" 2>/dev/null || echo "witness present, unreadable")"
else
  head_line="no witness cut yet"
fi

MSG="$(printf '🌅 x402 morning check — %s\n• service: %s\n• %s\n• chain: %s\n• %s\n• threads: Pi deploy · CDP Sepolia lane → first mainnet dollar' \
  "$STAMP" "$svc" "$mounts" "$chain" "$head_line")"

# ── record (always) ───────────────────────────────────────────────────────────
mkdir -p "$ROOT/logs"
printf '%s\n%s\n\n' "=== $STAMP ===" "$MSG" >> "$LOG"

# ── report to Telegram (best-effort) ──────────────────────────────────────────
tok=""
[ -f "$TELEGRAM_ENV" ] && tok="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$TELEGRAM_ENV" | head -1 | cut -d= -f2- | tr -d '"'"'"' ')"
if [ -n "$tok" ]; then
  curl -fsS -m 10 -X POST "https://api.telegram.org/bot${tok}/sendMessage" \
    --data-urlencode "chat_id=${TG_CHAT_ID}" \
    --data-urlencode "text=${MSG}" >/dev/null 2>&1 \
    && echo "morning-check: reported to Telegram" \
    || echo "morning-check: Telegram send failed (logged to $LOG)"
else
  echo "morning-check: no Telegram token at $TELEGRAM_ENV (logged to $LOG only)"
fi
