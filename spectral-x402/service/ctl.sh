#!/usr/bin/env bash
# ctl.sh — install / control the x402 mount kernel as a launchd service.
#
# The plist in this directory is a TEMPLATE with __NODE__ and __ROOT__
# placeholders, so the committed copy contains no machine-specific paths.
# Installing renders it into ~/Library/LaunchAgents.
set -euo pipefail

LABEL="co.marshpress.x402"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$ROOT/service/$LABEL.plist"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

usage() { echo "usage: ctl.sh {install|uninstall|start|stop|restart|status|logs|health}"; exit 1; }
[ $# -ge 1 ] || usage

render() {
  local node; node="$(command -v node)"
  [ -n "$node" ] || { echo "node not found on PATH"; exit 1; }
  mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs"
  sed -e "s|__NODE__|$node|g" -e "s|__ROOT__|$ROOT|g" "$TEMPLATE" > "$TARGET"
  echo "rendered $TARGET"
  echo "  node $node"
  echo "  root $ROOT"
}

preflight() {
  # Refuse to install a service that cannot boot. A crash-looping agent is
  # worse than no agent: it buries the reason in restart noise.
  [ -f "$ROOT/dist/server.js" ] || { echo "REFUSED: dist/server.js missing — run npm run build"; exit 1; }
  if [ ! -f "$ROOT/.env.local" ] && [ ! -f "$ROOT/.env" ]; then
    echo "WARNING: no .env.local — the service will boot with a dev payTo placeholder."
    echo "         Copy .env.example and fill in the PUBLIC receiving address."
  fi
  local n; n="$(ls "$ROOT"/packs/*.manifest.json 2>/dev/null | wc -l | tr -d ' ')"
  [ "$n" -gt 0 ] || { echo "REFUSED: no sealed packs in packs/ — nothing to serve"; exit 1; }
  echo "preflight ok — $n sealed pack(s)"
}

case "$1" in
  install)
    preflight; render
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$TARGET"
    launchctl enable "$DOMAIN/$LABEL"
    echo "installed and started $LABEL"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$TARGET"
    echo "uninstalled $LABEL"
    ;;
  start)   launchctl kickstart -k "$DOMAIN/$LABEL"; echo "started" ;;
  stop)    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true; echo "stopped" ;;
  restart) launchctl kickstart -k "$DOMAIN/$LABEL"; echo "restarted" ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | grep -E "^\s*(state|pid|last exit (code|status)|runs) " || true
    else
      echo "not loaded"
    fi
    ;;
  logs)
    tail -n "${2:-40}" "$ROOT/logs/x402.out.log" 2>/dev/null || echo "(no stdout log yet)"
    if [ -s "$ROOT/logs/x402.err.log" ]; then
      echo "--- stderr ---"; tail -n "${2:-40}" "$ROOT/logs/x402.err.log"
    fi
    ;;
  health)
    port="${PORT:-8787}"
    curl -fsS -m 5 "http://localhost:$port/health" && echo || { echo "UNHEALTHY on :$port"; exit 1; }
    ;;
  *) usage ;;
esac
