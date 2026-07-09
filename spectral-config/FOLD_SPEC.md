# v2 → v3 Fold Spec — schema extension for wire details

Target for Fable's fold of `pipeline.json` (v2) into the Zod manifest (v3).
The schema in this package (`src/manifest.schema.ts`) already carries the
new fields, typechecks clean, and stays backward-compatible (all additions
optional). This doc says what each field is for and how to populate it from
v2 without dropping anything or guessing.

## Direction of the fold (settled)

- **v3 structure wins** — schema, dimension policy, silence taxonomy,
  liveVsTarget conflict tracking. That's the framework.
- **v2 facts win** — Qdrant URLs, ingest scripts, receptacle tool names,
  and any embed-model value v2 carries. v3's `[CONFIRM]` fields were
  Claude-inferred; where v2 has a real value, v2 is authoritative.
- **Factual disagreements are Joe's to arbitrate.** Neither agent can
  reach the Pi. Do not auto-pick. List each disagreement; Joe confirms.

## New fields (already in the schema)

### `store.endpoint` — string URL | null | omitted
Reachable store endpoint. `http://100.113.215.46:6333` for Qdrant;
`null` for local-file stores (vault-index, faiss-pack); omit if v2 didn't
record it. **Security note:** this puts the Pi's Tailscale IP in the
manifest. If the manifest is ever committed to a public repo, endpoints
should come from env vars, not literals — see "Secrets" below.

### `store.distanceMetric` — "cosine" | "dot" | "euclid" | null | omitted
How the STORE indexes vectors. Deliberately separate from
`silence.signal` (how the RECEPTACLE gates). They usually match; recording
both catches the pipeline where a cosine-indexed store is gated by an
L2-to-centroid receptacle (the spectral-terrain Zone 2 case). If v2 and the
live Qdrant config disagree, the live Qdrant collection wins.

### `ingest` — { script, refineryStage } | omitted
How the corpus is (re)built. `script` = the v2 ingest command
(e.g. `scripts/ingest-finance-heatmap.ts`). `refineryStage` = the processor
entrypoint if separate, else null. **This is what the three HOT pipelines
need** — the low-D re-ingest points here.

### `receptacle.tools` — string[] | omitted
Named tools/endpoints the receptacle exposes. ArbiterOS:
`["consult_statute","verify_negotiability","analyze_clause_risks", ...]`
(the 6 from its README). LawLibra: `["/health","/api/legal/query"]`.
Omitted = not yet folded; `[]` = confirmed none. Keep the distinction.

## Per-pipeline fold checklist

For each of the 8 pipelines, pull from v2 `pipeline.json` and set:

| pipeline | endpoint (v2) | distanceMetric | ingest.script | receptacle.tools |
|---|---|---|---|---|
| roblox-luau | Qdrant URL | ? | ingest:roblox | query.ts entry |
| legal-corpus | Qdrant URL | cosine? | legal_heatmap.py | LawLibra eps |
| lawlibra | :4880 base | — | — | /health,/api/legal/query |
| arbiter-legalengine | :4881→:4880 | — | — | 6 verify_* tools |
| medical-corpus | vault path→null | — | rechunk_medical.py | agent/index.ts |
| repo-husk | vault path→null | — | build-index.ts | agent/index.ts |
| property-data | hydra Qdrant URL | ? | eve_v2 ingest | property-hydra q |
| finance-crypto | Qdrant URL | ? | ingest-finance-heatmap.ts | navigate-finance.ts |

`?` = v2 may have it; Joe confirms. `—` = not applicable (local file or
pure consumer).

## Known factual disagreements to surface to Joe

1. **roblox embed model** — v3 says `nomic-embed-text` (Claude-inferred,
   was tagged `[CONFIRM]`), v2 says `mxbai-embed-large`. v2 likely right.
   Joe confirms which the Pi actually runs.
2. **property-data dims** — v3 flags 3072-D as HOT/violation; unknown if
   GAT needs the width or it's an over-embed. Joe decides; if it needs
   width, set a documented exception, else schedule the drop.
3. Any other field where v2 has a value and v3 has `[CONFIRM]` — treat v2
   as authoritative pending Joe's check.

## Two-layer guarantee (for the team, so it's not over-trusted)

- **Schema refusal (hard):** malformed structure is rejected at parse.
  Fable verified 5/5. This is `DomainManifest.parse()` throwing.
- **Dimension audit (soft):** a structurally-valid pipeline that violates
  the dim rule is *flagged, not refused*, by `auditDimensions()`. The three
  HOT pipelines are valid manifests that break the rule. Different
  guarantee from refusal — don't conflate them.

Add one adversarial case to Fable's five if not already covered: a static
pipeline at 3072-D. Expected: parses fine (valid), shows up in
`auditDimensions()` (flagged). Confirms the two layers are distinct.

## Secrets / public-repo caution

`settings.local.json` and any manifest carrying `store.endpoint` literals
expose the Pi's Tailscale IP and host. Before this manifest lands on a
public branch: move endpoints to env (`process.env.QDRANT_URL` etc.) and
keep literals only in a gitignored local override. Not urgent for a private
PR; blocking for anything public.

## After the fold

Generate `pipeline.json` FROM the v3 manifest (not the reverse) so any
future v2 consumer keeps working, then retire the hand-maintained v2.
One source of truth, one generated artifact. That's the fragmentation gone.
