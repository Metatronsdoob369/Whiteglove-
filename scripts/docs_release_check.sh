#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

REQUIRE_HEAD=0
EXPECTED_SHA=""
CHECK_CI=1

usage() {
  cat <<USAGE
Usage: scripts/docs_release_check.sh [options]

Options:
  --require-head        Require stamped SHA in launch docs to match current HEAD short SHA.
  --sha <short_sha>     Require stamped SHA to match an explicit short SHA.
  --no-ci               Skip GitHub PR/CI status check.
  -h, --help            Show this help.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --require-head)
      REQUIRE_HEAD=1
      shift
      ;;
    --sha)
      [[ $# -lt 2 ]] && { echo "Missing value for --sha"; exit 2; }
      EXPECTED_SHA="$2"
      shift 2
      ;;
    --no-ci)
      CHECK_CI=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 2
      ;;
  esac
done

LAUNCH_FILES=(
  "docs/launch_package/00_README_launch_package.md"
  "docs/launch_package/01_whiteglove_datasheet.md"
  "docs/launch_package/02_whiteglove_demo_script.md"
  "docs/launch_package/03_whiteglove_landing_healthcare.md"
  "docs/launch_package/04_whiteglove_landing_finance.md"
  "docs/launch_package/05_whiteglove_landing_legal.md"
  "docs/launch_package/06_whiteglove_threat_model.md"
  "docs/launch_package/07_whiteglove_compliance.md"
)

echo "== WhiteGlove docs release check =="

for f in "${LAUNCH_FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "[FAIL] Missing required launch file: $f"
    exit 1
  fi
done

# Extract stamped SHA candidates from launch files (backticked 7+ hex hashes).
mapfile -t STAMPED_SHAS < <(
  rg --no-filename -o '`[0-9a-f]{7,40}`' "${LAUNCH_FILES[@]}" \
  | tr -d '`' \
  | sort -u
)

if [[ ${#STAMPED_SHAS[@]} -eq 0 ]]; then
  echo "[FAIL] No SHA stamps detected in launch docs (00-07)."
  exit 1
fi

if [[ ${#STAMPED_SHAS[@]} -ne 1 ]]; then
  echo "[FAIL] Inconsistent SHA stamps detected across launch docs:"
  printf '  - %s\n' "${STAMPED_SHAS[@]}"
  exit 1
fi

STAMPED_SHA="${STAMPED_SHAS[0]}"
echo "[PASS] Single stamped SHA across launch docs: $STAMPED_SHA"

if ! git rev-parse --verify --quiet "$STAMPED_SHA^{commit}" >/dev/null; then
  echo "[FAIL] Stamped SHA does not resolve to a git commit: $STAMPED_SHA"
  exit 1
fi

echo "[PASS] Stamped SHA resolves in repository history"

if [[ -n "$EXPECTED_SHA" ]]; then
  if [[ "$STAMPED_SHA" != "$EXPECTED_SHA" ]]; then
    echo "[FAIL] Stamped SHA mismatch: expected $EXPECTED_SHA, found $STAMPED_SHA"
    exit 1
  fi
  echo "[PASS] Stamped SHA matches expected --sha $EXPECTED_SHA"
fi

if [[ "$REQUIRE_HEAD" -eq 1 ]]; then
  HEAD_SHA="$(git rev-parse --short HEAD)"
  if [[ "$STAMPED_SHA" != "$HEAD_SHA" ]]; then
    echo "[FAIL] Stamped SHA mismatch: HEAD is $HEAD_SHA, docs are $STAMPED_SHA"
    exit 1
  fi
  echo "[PASS] Stamped SHA matches current HEAD: $HEAD_SHA"
fi

# No TODO/WIP/legacy markers in distributed docs.
BAD_MARKERS="$(rg -n -i '\bTODO\b|\bWIP\b|\blegacy\b|f046d9b' "${LAUNCH_FILES[@]}" || true)"
if [[ -n "$BAD_MARKERS" ]]; then
  echo "[FAIL] Found TODO/WIP/legacy/old-SHA markers in launch docs:"
  echo "$BAD_MARKERS"
  exit 1
fi
echo "[PASS] No TODO/WIP/legacy/old-SHA markers in launch docs"

# Required artifact directories exist and are non-empty.
for d in docs/demo docs/artifacts; do
  if [[ ! -d "$d" ]]; then
    echo "[FAIL] Missing directory: $d"
    exit 1
  fi
  if [[ -z "$(ls -A "$d")" ]]; then
    echo "[FAIL] Empty directory: $d"
    exit 1
  fi
  echo "[PASS] Directory exists and non-empty: $d"
done

# Required artifact targets exist and are referenced.
REQUIRED_TARGETS=(
  "docs/demo/90s_proof_demo.md"
  "docs/artifacts/audit_log_sample_placeholder.md"
  "docs/artifacts/snapshot_manifest_example.md"
)

for target in "${REQUIRED_TARGETS[@]}"; do
  if [[ ! -f "$target" ]]; then
    echo "[FAIL] Missing required artifact placeholder file: $target"
    exit 1
  fi
  if ! rg -n "/${target}" "${LAUNCH_FILES[@]}" >/dev/null; then
    echo "[FAIL] Required artifact path not referenced in launch docs: /$target"
    exit 1
  fi
  echo "[PASS] Placeholder exists and is referenced: /$target"
done

# Markdown local-link validation (repo-internal links only).
MARKDOWN_FILES=()
if [[ -f "README.md" ]]; then
  MARKDOWN_FILES+=("README.md")
fi
while IFS= read -r -d '' md; do
  MARKDOWN_FILES+=("$md")
done < <(find docs/launch_package docs/demo docs/artifacts -type f -name '*.md' -print0)

if [[ ${#MARKDOWN_FILES[@]} -eq 0 ]]; then
  echo "[FAIL] No markdown files found for link validation."
  exit 1
fi

python3 - "$ROOT_DIR" "${MARKDOWN_FILES[@]}" <<'PY'
import os
import re
import sys
from urllib.parse import unquote

root = os.path.abspath(sys.argv[1])
files = sys.argv[2:]
link_re = re.compile(r'!?\[[^\]]*\]\(([^)]+)\)')
errors = []

def is_external(target: str) -> bool:
    return bool(re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', target) or target.startswith('//'))

for md in files:
    md_dir = os.path.dirname(md)
    try:
        with open(md, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError as exc:
        errors.append(f"{md}:0: cannot read file ({exc})")
        continue

    for line_no, line in enumerate(lines, start=1):
        for raw in link_re.findall(line):
            target = raw.strip()
            if target.startswith("<") and target.endswith(">"):
                target = target[1:-1].strip()
            if not target:
                continue

            # Drop optional title portion if present: path "title"
            if " " in target:
                target = target.split()[0]

            target = unquote(target)
            if target.startswith("#"):
                continue
            if is_external(target):
                continue

            path_part = target.split("#", 1)[0]
            if not path_part:
                continue

            if path_part.startswith("/"):
                resolved = os.path.normpath(os.path.join(root, path_part.lstrip("/")))
            else:
                resolved = os.path.normpath(os.path.join(md_dir, path_part))

            if not os.path.exists(resolved):
                errors.append(f"{md}:{line_no}: missing local link target '{target}' -> '{resolved}'")

if errors:
    print("[FAIL] Broken local markdown links detected:")
    for e in errors:
        print(f"  - {e}")
    sys.exit(1)

print("[PASS] Local markdown links validated")
PY

if [[ "$CHECK_CI" -eq 1 ]]; then
  if command -v gh >/dev/null 2>&1; then
    BRANCH="$(git branch --show-current)"
    PR_NUMBER="$(gh pr view --json number --jq '.number' 2>/dev/null || true)"
    if [[ -n "$PR_NUMBER" ]]; then
      echo "[INFO] GitHub PR #$PR_NUMBER checks:"
      gh pr checks "$PR_NUMBER" || {
        echo "[FAIL] One or more PR checks are not green."
        exit 1
      }
      echo "[PASS] PR checks are green"
    else
      echo "[WARN] No open PR detected for branch '$BRANCH'; skipping PR checks."
    fi
  else
    echo "[WARN] gh CLI not found; skipping CI check."
  fi
fi

echo "[PASS] docs release check complete"
