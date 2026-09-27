#!/usr/bin/env bash
# ci-fixture-packs.sh — build throwaway sealed packs so the test suite can run
# where packs/ is absent (CI checkouts, scratch worktrees). The suite loads
# real sealed packs by edition name, but packs/ is gitignored: the sold packs
# and their signing key exist only on the operator's machine.
#
# REFUSES to run where a signing key or any target edition already exists —
# the only environment it may populate is a clean checkout. That refusal is
# what protects the real sold packs and packs/.signing-key.pem from a careless
# local run; never weaken it to "overwrite".
#
# Requires dist/ and dist-gate/ already built:
#   npx tsc && npx tsc -p tsconfig.gate.json
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKS="$ROOT/packs"
EDITIONS=(roblox-luau-2026-08 medical-medlineplus-2026-08 heatmap-raw-2026-08 fintel-paper-arena-2026-08)

if [ -f "$PACKS/.signing-key.pem" ]; then
  echo "REFUSED: $PACKS/.signing-key.pem exists — this looks like a live checkout, not a clean one." >&2
  exit 1
fi
for e in "${EDITIONS[@]}"; do
  if [ -e "$PACKS/$e.manifest.json" ]; then
    echo "REFUSED: $PACKS/$e.manifest.json exists — fixture packs never overwrite sealed packs." >&2
    exit 1
  fi
done
for f in "$ROOT/dist/make-pack.js" "$ROOT/dist/make-pack-raw.js" "$ROOT/dist-gate/scripts/cut-fintel-pack.js"; do
  if [ ! -f "$f" ]; then
    echo "REFUSED: $f missing — build first: npx tsc && npx tsc -p tsconfig.gate.json" >&2
    exit 1
  fi
done

cd "$ROOT"
# First run generates the throwaway signing keypair + trust store in packs/;
# the rest reuse it. Content-provenance key only — not a wallet.
node dist/make-pack.js ./packs roblox-luau-2026-08
node dist/make-pack.js ./packs medical-medlineplus-2026-08
node dist/make-pack-raw.js ./packs heatmap-raw-2026-08 32 3072
node dist-gate/scripts/cut-fintel-pack.js ./packs fintel-paper-arena-2026-08 \
  harness/fixtures/fintel-trades.jsonl harness/fixtures/fintel-portfolio.json

echo "fixture packs built: ${EDITIONS[*]}"
