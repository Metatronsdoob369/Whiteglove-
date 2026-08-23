#!/usr/bin/env bash
# maintenance-check.sh — the H0 maintenance run. Report-only, always.
#
# The design move, dictated by the Mission-2V history: THIS SCRIPT captures
# every transcript; the agent only narrates over them. Each probe's raw output
# lands in evidence/hermes/maintenance-<UTC>/NN-<probe>.txt with its exit code
# recorded in run-manifest.json alongside a sha256 of every transcript. A claim
# without a transcript is not a finding; the agent cannot fabricate what it
# never writes.
#
# Never mutates: probes are curl reads, read-only verifies, and git queries.
# It never compiles the live tree (tsc would bake uncommitted WIP into the
# dist/ launchd boots), never cuts a witness (the 00:15 unit owns cutting),
# and never reads .env.local or any X402_* secret.
#
# Overrides for running a branch copy against the live system:
#   X402_LIVE_DIR  the live spectral-x402 checkout (default: this script's own)
#   PORT           paid HTTP port (default 8787)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
LIVE="${X402_LIVE_DIR:-$ROOT}"
PORT="${PORT:-8787}"
NODE="${NODE:-$(command -v node || echo node)}"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
OUT="$ROOT/evidence/hermes/maintenance-$STAMP"
mkdir -p "$OUT"

PROBES=()
CODES=()

run_probe() { # <name> <cmd...>  — transcript + exit code, failure tolerated
  local name="$1"; shift
  local file="$OUT/$(printf '%02d' $((${#PROBES[@]} + 1)))-$name.txt"
  local code=0
  {
    echo "\$ $*"
    "$@"
  } >"$file" 2>&1 || code=$?
  PROBES+=("$name"); CODES+=("$code")
  echo "probe $name -> exit $code ($file)"
}

# Bash functions so compound probes still produce one transcript each.
probe_git() {
  git -C "$REPO" rev-parse HEAD
  git -C "$REPO" status --porcelain
  echo "(empty status above = clean tree; src/http.ts WIP lines prove the harness left it alone)"
}
probe_health() {
  curl -fsS -m 5 "http://localhost:$PORT/health"
}
probe_resources() {
  local disc
  disc="$(curl -fsS -m 5 "http://localhost:$PORT/.well-known/x402")" || return 1
  printf '%s\n' "$disc"
  "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(`resources live: ${(JSON.parse(s).resources||[]).length}`)}catch{console.log("resources live: ?")}})' <<<"$disc"
}
probe_witness_verify() {
  "$NODE" "$LIVE/dist-gate/scripts/cut-witness.js" verify "$LIVE/evidence/witness" "$LIVE/packs"
}
probe_config_drift() {
  (cd "$REPO/spectral-config" && npm run --silent check:drift)
}
probe_ci_runs() {
  gh run list --branch master --limit 10
}
probe_spec_drift() {
  cat <<'EOF'
Spec-vs-built drift checklist (REPORT-ONLY — building any of these is out of harness scope):
- ops surface :8788 (runtime-policy declares it; no listener in src/) — probe below
- revocation / status lists (declared everywhere, read nowhere in src/)
- compensation mechanics (make_good/entitlements tables exist; no grant/burn path)
- facilitator failover (spec: two configured; built: one)
- FAULT_POINT fault-injection suite (spec names it; settlement-gate's manual restart proof stands in)
- ctl.sh restart only kickstarts the main label — the MCP door needs its own kickstart
EOF
  printf 'ops :8788 probe -> HTTP %s (000 = nothing listening, as expected while unbuilt)\n' \
    "$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://localhost:8788/" || true)"
}
probe_commerce_delta() {
  "$NODE" -e '
    const fs=require("fs"),p=require("path");
    const dir=process.argv[1];
    const files=fs.readdirSync(dir).filter(f=>/^witness-\d+\.json$/.test(f)).sort();
    if(files.length===0){console.log("no witnesses");process.exit(0)}
    const line=f=>{const w=JSON.parse(fs.readFileSync(p.join(dir,f),"utf8")).witness;
      const vol=(w.ledger.settled_volume||[]).map(v=>`${v.amount_atomic_total} ${v.asset}`).join(", ")||"0";
      return `#${w.index} ${w.cut_at} — calls ${w.ledger.calls_total}, receipts ${w.ledger.receipts_success_total}, payers ${w.ledger.unique_payers}, volume ${vol}, breaches ${w.invariants.breaches}`};
    console.log("latest:  "+line(files.at(-1)));
    if(files.length>1) console.log("previous:"+line(files.at(-2)));
    if(files.length>1){
      const a=JSON.parse(fs.readFileSync(p.join(dir,files.at(-2)),"utf8")).witness.ledger;
      const b=JSON.parse(fs.readFileSync(p.join(dir,files.at(-1)),"utf8")).witness.ledger;
      const d=k=>b[k]-a[k];
      console.log(`delta:   calls ${d("calls_total")}, receipts ${d("receipts_success_total")}, payers ${d("unique_payers")}`);
    }
  ' "$LIVE/evidence/witness"
}

run_probe git-state          probe_git
run_probe service-health     probe_health
run_probe discovery-resources probe_resources
run_probe witness-verify     probe_witness_verify
run_probe config-drift       probe_config_drift
run_probe ci-runs            probe_ci_runs
run_probe spec-drift         probe_spec_drift
run_probe commerce-delta     probe_commerce_delta

# ── run manifest: probes, exit codes, transcript digests ─────────────────────
{
  echo '{'
  echo "  \"schema\": \"hermes-maintenance-run-v1\","
  echo "  \"run_at\": \"$STAMP\","
  echo "  \"live_dir\": \"$LIVE\","
  echo '  "probes": ['
  n=${#PROBES[@]}
  for i in $(seq 0 $((n - 1))); do
    file="$OUT/$(printf '%02d' $((i + 1)))-${PROBES[$i]}.txt"
    sha="$(shasum -a 256 "$file" | cut -d' ' -f1)"
    comma=$([ "$i" -lt $((n - 1)) ] && echo ',' || echo '')
    printf '    {"name": "%s", "exit": %s, "transcript": "%s", "sha256": "%s"}%s\n' \
      "${PROBES[$i]}" "${CODES[$i]}" "$(basename "$file")" "$sha" "$comma"
  done
  echo '  ]'
  echo '}'
} > "$OUT/run-manifest.json"

echo
echo "evidence: $OUT"
echo "manifest: $OUT/run-manifest.json"
