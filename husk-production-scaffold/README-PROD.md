# WhiteGlove Husk — Production Scaffold

**Status: SCAFFOLD. Not production-validated.** This packages the
orchestrator behind a stable service API and an airgapped HTTP server so
a capable model can extend toward MVP in one session. It assumes the
harness metrics come back clean — but that hasn't happened yet.

## What "assuming we crush the metrics" means here

Everything below is built as if the salt fix works and the gate
cleanly separates related from unrelated shards. Until CHORES.md
Tasks 4–11 actually run, the following are UNVALIDATED and marked in
code:

- `config.queryThreshold` — placeholder 0.45, uncalibrated
- `thresholdCalibration.calibrated = false` — flips true only after a
  real sweep on a real corpus
- The claim that silence-first behaves correctly — unproven until the
  PRE/POST diff exists

`assertCalibrated()` warns (or hard-fails with `STRICT_CALIBRATION=1`)
so nothing downstream mistakes the placeholder for a validated value.

## Layout

```
src/
  config/index.ts     central config + calibration provenance + guard
  server/service.ts   HuskService: orchestrator wrapper, husk.v1 envelope
  server/http.ts      loopback HTTP server, builtins only
  adapter.ts          harness adapter (eval path, unchanged)
  run-eval.ts         harness runner (eval path, unchanged)
  husk-tui.ts         interactive shell (unchanged)
```

The eval harness and the service share one orchestrator interface but
are separate entry points: harness proves the gate, service serves it.

## Run (after wiring the import paths)

```
SHARD_DIR=/path/to/shattered npx tsx src/server/http.ts
curl -s localhost:8787/health
curl -s -X POST localhost:8787/query -H 'content-type: application/json' \
  -d '{"question":"how does the shard cache evict entries?"}' | jq
```

## What is deliberately NOT in this scaffold

Do not ship without these. Listed so the gaps are explicit, not
discovered later:

- **Auth / API keys** — none. Loopback-only bind is the sole control.
- **Rate limiting** — none.
- **TLS** — none; assumes localhost or an upstream terminating proxy.
- **Input sanitation beyond size cap** — minimal.
- **Persistence of the index** — orchestrator has save/loadIndex; the
  server rebuilds on boot. Wire loadIndex for faster cold starts.
- **Concurrency limits on inference** — RAG mode calls Ollama
  synchronously via the orchestrator; parallel requests will queue/block.
- **Observability** — console logs only; no structured log sink, no
  metrics export.
- **Threshold hot-reload** — changing the gate requires a restart
  (orchestrator fixes it at construction).

## Handoff notes for the extending session

Good first targets toward MVP, roughly in value order:
1. Wire `loadIndex`/`saveIndex` so boot doesn't re-sign the whole corpus.
2. Add an API-key middleware + non-loopback bind behind a flag.
3. Persist per-request envelopes to an audit log (the envelope is
   already audit-shaped: requestId, timestamp, thresholdUsed, calibrated).
4. Add a `/calibration` endpoint that reads the latest harness
   results.json and reports the operating point.
5. Concurrency guard around RAG inference.

Do NOT have the session hardcode a threshold or claim calibration —
those depend on harness runs that live on the box, not in the model.
