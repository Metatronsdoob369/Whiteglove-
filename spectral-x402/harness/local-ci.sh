#!/usr/bin/env bash
# local-ci.sh — the CI gate, run on this machine. Same two jobs as
# .github/workflows/quality.yml's x402-kernel and config-drift, executed in a
# disposable git worktree so the live tree is never compiled (charter
# invariant), with every step transcribed the maintenance-check way.
#
# Exists so the merge gate does not depend on GitHub's billing state: when
# Actions is locked (or gone), this is the gate. Same steps, same commands,
# local Node instead of ubuntu-latest — say so when citing a run.
#
# Usage: bash harness/local-ci.sh [ref]     (default: HEAD of this checkout)
# Evidence: evidence/hermes/local-ci-<UTC>/ + run-manifest.json (sha256s).
# Exit 0 = both jobs green. KEEP_WORKTREE=1 to keep the scratch worktree.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
REF="${1:-HEAD}"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
OUT="$ROOT/evidence/hermes/local-ci-$STAMP"
WT="$REPO/.claude/worktrees/local-ci-$STAMP"
mkdir -p "$OUT"

STEPS=()
CODES=()
FAILED=0

step() { # <name> <cmd...> — transcript + exit code; first failure gates
  local name="$1"; shift
  local file="$OUT/$(printf '%02d' $((${#STEPS[@]} + 1)))-$name.txt"
  local code=0
  {
    echo "\$ $*"
    "$@"
  } >"$file" 2>&1 || code=$?
  STEPS+=("$name"); CODES+=("$code")
  echo "step $name -> exit $code ($file)"
  if [ "$code" -ne 0 ]; then FAILED=1; fi
  return 0
}

resolved="$(git -C "$REPO" rev-parse "$REF")" || { echo "bad ref: $REF" >&2; exit 2; }
echo "local-ci: gating $REF ($resolved)"
git -C "$REPO" worktree add --detach "$WT" "$resolved" >/dev/null 2>&1 || { echo "worktree add failed" >&2; exit 2; }

cleanup() {
  if [ "${KEEP_WORKTREE:-0}" != "1" ]; then
    git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true
  else
    echo "kept worktree: $WT"
  fi
}
trap cleanup EXIT

X="$WT/spectral-x402"
C="$WT/spectral-config"

# ── job 1: x402 kernel, exactly the workflow's steps ──────────────────────────
step kernel-npm-ci       bash -c "cd '$X' && npm ci --no-audit --no-fund"
[ "$FAILED" -eq 0 ] && step kernel-build     bash -c "cd '$X' && npx tsc && npx tsc -p tsconfig.gate.json"
[ "$FAILED" -eq 0 ] && step fixture-packs    bash -c "cd '$X' && bash harness/ci-fixture-packs.sh"
[ "$FAILED" -eq 0 ] && step kernel-suite     bash -c "cd '$X' && npm test"

# ── job 2: manifest no-drift gate ─────────────────────────────────────────────
step drift-npm-ci        bash -c "cd '$C' && npm ci --no-audit --no-fund"
step drift-gate          bash -c "cd '$C' && npm run check:drift"

# ── run manifest ──────────────────────────────────────────────────────────────
{
  echo '{'
  echo "  \"schema\": \"hermes-local-ci-run-v1\","
  echo "  \"run_at\": \"$STAMP\","
  echo "  \"ref\": \"$REF\","
  echo "  \"commit\": \"$resolved\","
  echo "  \"node\": \"$(node --version 2>/dev/null || echo unknown)\","
  echo '  "steps": ['
  n=${#STEPS[@]}
  for i in $(seq 0 $((n - 1))); do
    file="$OUT/$(printf '%02d' $((i + 1)))-${STEPS[$i]}.txt"
    sha="$(shasum -a 256 "$file" | cut -d' ' -f1)"
    comma=$([ "$i" -lt $((n - 1)) ] && echo ',' || echo '')
    printf '    {"name": "%s", "exit": %s, "transcript": "%s", "sha256": "%s"}%s\n' \
      "${STEPS[$i]}" "${CODES[$i]}" "$(basename "$file")" "$sha" "$comma"
  done
  echo '  ],'
  echo "  \"verdict\": \"$([ "$FAILED" -eq 0 ] && echo PASS || echo FAIL)\""
  echo '}'
} > "$OUT/run-manifest.json"

echo
echo "evidence: $OUT"
if [ "$FAILED" -eq 0 ]; then
  echo "local-ci: PASS ($resolved)"
  exit 0
else
  echo "local-ci: FAIL ($resolved) — read the first non-zero transcript above"
  exit 1
fi
