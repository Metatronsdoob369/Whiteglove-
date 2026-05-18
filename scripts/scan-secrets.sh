#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if command -v gitleaks >/dev/null 2>&1; then
  echo "Running gitleaks (staged diff)..."
  gitleaks git --staged --redact --exit-code 1
  exit 0
fi

echo "gitleaks not found; using fallback staged regex scanner."

PATTERN='(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{80,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN (RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY-----|tskey-auth-[A-Za-z0-9-]+)'

staged_files=$(git diff --cached --name-only --diff-filter=ACMR || true)
if [[ -z "$staged_files" ]]; then
  echo "No staged files to scan."
  exit 0
fi

fail=0
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  if [[ ! -f "$file" ]]; then
    continue
  fi
  if git show ":$file" | rg -n -E "$PATTERN" >/dev/null 2>&1; then
    echo "Potential secret detected in staged file: $file"
    git show ":$file" | rg -n -E "$PATTERN" || true
    fail=1
  fi
done <<< "$staged_files"

if [[ "$fail" -ne 0 ]]; then
  echo "Secret scan failed. Remove secrets or use secure env-based config."
  exit 1
fi

echo "Fallback secret scan passed."
