# terrain-tile-v1 — Sealed Terrain Tile & Pack Specification

**Date:** 2026-08-05
**Status:** Approved in brainstorm; implementation plan to follow.
**Companion:** [x402 Mount Kernel — Parent Architecture](2026-08-05-x402-mount-kernel-design.md)
**Problem:** The paid retrieval kernel requires `replaySafe: true` adapters, but the authoring pipeline produces mutable, time-evolving tiles whose source text is third-party Luau. This spec defines the immutable, signed, licensable artifact that crosses the paid boundary — and the mechanical gates that keep everything else from crossing it.

## Goal

Define the data artifact for paid terrain retrieval: canonicalization, identity, signing, pack manifest, revocation, and the licensing gate. First domain: `roblox-luau` (physics-deterministic `[v_t−1 ‖ v_t ‖ v_t+1]` temporal geometry).

## Non-goals (first ship)

- Similarity-search operations (blocked on Track C calibration; Phase 1 sells content-addressed ops only).
- `full-concat` geometry tier (refused at parse; premium SKU later).
- Onchain anchoring of manifests (append-only local ledger suffices for v1).

## Two layers: working tile vs sealed tile

| | Working tile (`terrain-tile-working.v1`) | Sealed tile (`terrain-tile-v1`) |
|---|---|---|
| Mutability | mutable in place | immutable; any change is a new tile |
| Identity | `lineage_id` (UUIDv4, assigned once) | `cid` = content hash |
| Time | `first_seen` / `last_seen` / `observation_count` mutable | closed `window` only; no open intervals |
| Source text | present | **structurally forbidden** |
| Signed / sold | never / never | always / the only thing served |
| Hash | none, deliberately | `cid`, recomputed by every verifier |

The seal is the authoring/selling boundary. `replaySafe: true` follows mechanically: the paid endpoint has nothing to serve but bytes already frozen and named by their own hash. Time is mutable metadata at the authoring layer and **content** at the sealed layer (the closed window is part of the hash). The corpus moves by emitting new tiles chained via `prev_cid`; novelty is measured against the previous seal — the baseline is a `cid` that already exists, not an invented field.

## Sealed tile — field spec

No float ever appears as a JSON number. Key order is irrelevant (canonicalization sorts).

| pointer | type | R/O | meaning |
|---|---|---|---|
| `/schema` | literal `"terrain-tile-v1"` | R | Pins hash fn (BLAKE2b-256), signature alg (Ed25519), allowed `canon_version` set. |
| `/canon_version` | integer `1` | R | Allow-listed by `/schema`; verifier refuses others. |
| `/domain` | literal `"roblox-luau"` | R | Must equal a `DomainPipeline.id`. |
| `/lineage_id` | uuid v4 | R | Groups seals of one entity over time. Never verified against; never used for trust. |
| `/prev_cid` | cid \| null | R | Previous seal in lineage; `null` = genesis. Novelty baseline + chain link. |
| `/geometry_profile` | enum `transition-only` \| `full-concat` | R | Changes the field set ⇒ changes the `cid`. Phase 1: `transition-only` only. |
| `/norm_convention` | literal `"per-third-unit-kahan"` | R | Each 1024-D third is unit-norm (Kahan); concat is NOT renormalized. |
| `/embed/model` | `"mxbai-embed-large"` | R | |
| `/embed/dim_per_third` | integer `1024` | R | |
| `/embed/concat_dim` | integer `3072` | R | |
| `/embed/concat_norm` | decimal-string `"1.7320508075688772"` | R | √3, declared not assumed. |
| `/window/t_minus1`, `/t_now`, `/t_plus1` | observation | R | See below. |
| `/physics/method` | literal `"physics-deterministic"` | R | Placeholder-`t_plus1` tiles are refused at seal. |
| `/physics/engine_version` | string | R | Determinism warranty is void across versions. |
| `/physics/delta_ms` | decimal-string | R | |
| `/physics/determinism_class` | enum `engine-exact` \| `engine-exact-degraded` | R | |
| `/transition/residual_now_prev` | vecref | R | `v_t − v_t−1` — the work product. |
| `/transition/residual_next_now` | vecref | R | `v_t+1 − v_t` — the sellable physics-deterministic delta. |
| `/transition/cframe_delta` | `{position:[3×dec], rotation:[9×dec]}` \| null | R | |
| `/transition/velocity_delta` | `[3×dec]` \| null | R | |
| `/transition/memory_delta_kb` | decimal-string | R | |
| `/transition/curvature` | decimal-string | R | `‖residual_next_now − residual_now_prev‖`. |
| `/scores/shatter` | decimal-string | R | Euclidean distance to centroid on the declared scale. |
| `/scores/shatter_scale` | literal `"concat-sqrt3-l2"` | R | Required: three incompatible scales exist in-repo. |
| `/scores/heat` | decimal-string | R | |
| `/scores/knn_margin` | decimal-string | R | d(2nd) − d(1st). |
| `/scores/corpus_support` | integer | R | Neighbors within calibrated radius. |
| `/scores/centroid_cid` | cid | R | Binds scores to the exact centroid artifact measured against. |
| `/fingerprint/family` | literal `"simhash128-fnv1a"` | O | Truthful — NOT BLAKE3/BLAKE2b. |
| `/fingerprint/bits` | integer `128` | O | |
| `/fingerprint/hex` | `^[0-9a-f]{32}$` | O | Zero-padded, fixed 32 chars (live index is 29–32 unpadded — pad on seal). |
| `/admission/contract_version` | string | R | |
| `/admission/disallowed_globals_hit` | sorted enum array | R | From `LuauAdmissionContract.disallowGlobals`. |
| `/admission/high_risk_patterns_hit` | sorted enum array | R | |
| `/admission/memory_safe` | boolean | R | |
| `/novelty/vs_prev_cid` | cid \| null | R | Must equal `/prev_cid` (auditable redundancy). |
| `/novelty/metric` | enum `l2-concat` \| `cosine-concat` \| `hamming-128` | R | |
| `/novelty/value` | decimal-string \| null | R | `null` iff genesis. |
| `/license/spdx` | SPDX \| `"NOASSERTION"` | R | Deny-listed values refuse at seal. |
| `/license/source_class` | enum `public-repo` \| `synthetic` \| `owner-authored` | R | |
| `/license/derivative_release` | enum `geometry-only` \| `geometry-and-embeddings` | R | `geometry-only` + `full-concat` ⇒ refuse. |
| `/commitments/source/{key_id,mac}` | string, hex64 | R | **Keyed** BLAKE2b-256 MAC of source text — proves provenance without disclosure. Unkeyed digest would be a confirmation oracle over enumerable public repos. |
| `/commitments/locator/{key_id,mac}` | string, hex64 | R | Keyed MAC over `repo_url‖commit_sha‖path`. |
| `/redaction/{category}` | integer counts | R | Closed enum keys only; free-text summaries banned. |
| `/notes` | enum-code array | O | Not free text. |

**Observation sub-object** (`/window/t_*`): `tick` (decimal-string), `epoch_ms` (integer), `vec` (vecref; present iff `full-concat`), `state_digest` (hex64 — unkeyed BLAKE2b-256 over canonical non-source state, for cross-party comparison), `constraint_classes` (enum array — never raw constraint strings, which leak instance names), `script_count` (integer).

**Redaction categories (closed):** `source_text_withheld`, `source_locator_withheld`, `identifier_withheld`, `constraint_names_generalized`, `unicode_stripped`, `unicode_normalized`, `embedding_downcast`, `neighbor_ref_withheld`.

## The licensing gate — a validator, not prose

```
SEALED_FORBIDDEN_KEYS@1 = {
  source, source_text, sourceText, scripts, raw_snapshot, rawSnapshot,
  source_ref, sourceRef, repo_url, repoUrl, commit_sha, commitSha, path,
  script_name, scriptName, file, symbol, deltaTarget,
  first_seen, last_seen, updated_at, ingestedAt, generated_at,
  pack_id, packId, edition_id,
  tile_neighbors, neighbors, adjacency,
  tile_hash, tileHash, cid, hash, blake2b_16,
  sig, signature, signature_algorithm, alg, public_key_ref, publicKeyRef,
  redaction_summary, confidence, confidence_score
}
```

A sealed tile is **refused** if any key at any depth matches, case-insensitive, `-`/`_` folded. Additional seal-time refusals: deny-listed license (`NOASSERTION`, `LicenseRef-Proprietary` by default); `geometry-only` license with `full-concat` profile; any non-NFC string; placeholder `t_plus1`.

Rationale: `scripts[].source` is raw third-party Luau from public repos. The mapping is the owner's work product; the source text is not. The boundary is enforced by a function, not a review habit.

## Canonicalization

- **Algorithm:** RFC 8785 JCS over the tile body. Hash: **BLAKE2b-256**, rendered `b2-256:<64 hex>`.
- **Numbers:** no JSON floats ever. Vectors as `vecref` `{dtype: f64le|f32le, count, b64}` (raw IEEE-754 bytes). Non-integer scalars as decimal strings matching `^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$`; `-0`, `NaN`, `Infinity` refused; integers refused outside ±(2^53−1). This kills cross-language float-formatting divergence (Python builder vs TS verifier — a live hazard here, not hypothetical).
- **Unicode:** all strings must already be NFC; sealer **refuses** rather than normalizes (silent normalization mutates content after license review). Refuse unpaired surrogates, U+FEFF, C0 (except `\t\n`), C1, and `Cf` codepoints (bidi-override smuggling from public-repo strings).
- **Exclusion sets:** tile = **empty** (`seal_exclusions@1 = []`) — the `cid` is the filename, never a body field; the signature is detached. An empty exclusion set cannot drift. Pack = exactly `["/seal"]` (`pack_exclusions@1`), machine-checked.
- **`canon_version`** lives inside the hashed body (not circular: verifier parses it, re-canonicalizes under that rule, checks the `cid`). Downgrade defense: the hash function is never selectable, and the canon set is allow-listed by `/schema`. Legacy registration: `naics_terrain_pack.v1` ⇒ `canon_version: 0` (`py-jsondumps-sortkeys-ascii`, BLAKE2b-128) — existing digests keep verifying; invalid for new artifacts.
- **Enforcement:** golden-vector fixtures with known `cid`s checked from BOTH the TS and Python implementations in CI. Cross-language canonicalization divergence is the highest-probability implementation failure in this design.

## Identity model — three identities

| identity | form | purpose | content hash? | in tile? | manifest refs? | verification recomputes? |
|---|---|---|---|---|---|---|
| `cid` | `b2-256:<hex64>` | THE identity: filename, manifest entry, merkle leaf, signature subject | yes | no | yes | yes |
| `lineage_id` | uuid v4 | grouping across time; powers `prev_cid` chains | no | yes | no | no |
| `locator` | `spectral://roblox-luau/<edition>/<cid>` | commercial/retrieval address | derived | no | no | no |

The payment identity (`paymentId`) is a fourth identity confined to the transport layer — never in an artifact (a tile carrying a receipt id could not be resold; same defect class as `pack_id`-in-tile).

## Signing envelope — detached, over the digest

`<cid>.tile.json` + `<cid>.seal.json`. The signature covers `"terrain-seal-v1" || 0x00 || <32 raw digest bytes of cid>` (Ed25519). Signing the digest forces every verification to recompute the canonical form — canonicalization is exercised on every verify instead of rotting unused.

Seal fields: `seal_schema` (literal — **pins the algorithm**; migration = `terrain-seal-v2`, never an `alg` field), `cid`, `canon_version` (must match body), `signer` (key id name — never a URL, never key material), `sig` (base64, 64 bytes), `signed_at`, `sig_scope` (enum `tile|pack|status`).

**Key resolution: local trust store only** (`trust/terrain-keys.json`: `key_id → {public_key_b64, valid_from, valid_until, status: active|retired|revoked, scopes}`). Unknown key ⇒ refuse, never fetch. Rotation = new key id; nothing re-signed. Compromise = trust-store revocation AND a status-list entry. A `public_key_ref` URL inside a signed document is a document vouching for its own authority — banned.

## Pack manifest (`terrain-pack-v1`)

Packs are the commercial unit, cut at snapshot boundaries, chained via `prev_pack_cid`.

Binds content two ways: (1) `tiles` = lexicographically sorted, deduplicated `cid` array; (2) `merkle_root` = BLAKE2b-256, RFC 6962 style (leaf `H(0x00‖digest)`, internal `H(0x01‖L‖R)`, **odd nodes promoted, never duplicated** — duplication is the CVE-2012-2459 ambiguity). The root enables per-tile inclusion proofs under the per-pack signature — what makes per-tile pricing possible.

Adjacency lives in the manifest, not tiles (mutual tile references are unhashable): `knn: {k, metric, edges: [[i, j, "weight"], …]}` with indices into the sorted `tiles` array, `i < j`, sorted, no self-loops. Out-of-pack neighbors are dropped and counted in `redaction.neighbor_ref_withheld`.

Other required fields: `schema`, `canon_version`, `pack_exclusions`, `domain`, `edition` (SKU, e.g. `roblox-luau-2026-08`), `snapshot {cut_at, window_from, window_to}`, `prev_pack_cid`, `tile_count` (checked = len), `geometry` (echoes tile conventions once; refuse if any tile disagrees), `centroid {cid, corpus_size, stability|null, stability_target}` (**`null` = genesis, never `0`**), `silence` (the actual calibrated gate — refuse to build if `calibrated: false`), `confidence_model`, `license/summary` (spdx counts), `redaction_totals`, `status_list_ref` (local logical name), `carrier_note` (free text OK here — no per-item source material), `/seal` (`sig_scope: "pack"`).

**Confidence: components in the tile, model in the pack, scalar nowhere.** The pack ships `confidence_model` (id, inputs, `shatter_ref` percentiles, weights, functional form) and the consumer computes the scalar. Reproducible by construction; a number that doesn't exist can't drift. Blocked on Track C resolving the shatter-scale contradiction.

## Revocation (`terrain-status-v1`)

Separate signed mutable document; sealed bytes are never rewritten. Fields: `schema`, `domain`, `sequence` (strictly monotonic — clients refuse lower; rollback defense), `issued_at`, `next_update` (**past it, status is *unknown*, not *active* — fail closed**), `entries [{subject_cid, subject_kind, status, reason_code, effective_at, replacement_cid?}]`, `/seal` (`sig_scope: "status"`).

| status | endpoint behavior |
|---|---|
| `active` (absent) | serve |
| `superseded` | serve + `X-Terrain-Status: superseded` + replacement cid |
| `withdrawn-license` | stop serving; honor paid replays for receipt TTL, flagged |
| `withdrawn-defect` | stop serving new; replay flagged |
| `key-compromised` | stop; point at replacement |

Reason codes (closed): `license-reassessed`, `source-takedown`, `centroid-invalid`, `threshold-uncalibrated`, `engine-version-mismatch`, `canonicalization-defect`, `key-compromise`, `superseded-by-snapshot`.

## Dimensionality (locked 2026-08-05)

Input style decides geometry: **temporal** domains = 3072-D concat (3×1024 mxbai, ‖concat‖=√3); **static** domains = single vector ≤768-D. Frozen into sealed content (`embed/*`, `norm_convention` are hashed fields) — a dimension change produces different `cid`s under a new schema version, so mixed dimensionality is unrepresentable. Future dims (640-D finance REFRAG, nomic-768 cutover) are new editions with new calibration, never migrations. The measured shatter scale (`roblox-luau-profile.json`: p90 1.2681, σ 0.0662 on the √3 scale) is authoritative; `LuauAdmissionContract.shatterThresholds` (0.03/0.08/0.15) and `ShatterReportSchema` bands (0.05/0.15) are wrong-scale and must be re-expressed or deleted.

## Manifest schema extension points (`spectral-config/src/manifest.schema.ts`)

- `StoreKind` += `"sealed-tile-pack"`; `RetrievalSignal` += `"content-address"`; `Processor` += `"terrain-tile-seal"`.
- `SilencePolicy` gains `gate: "threshold" | "exact-match" | "schema-refusal"` (default `"threshold"`; non-threshold gates must OMIT `threshold`/`closerIs` — no placeholder constants).
- New optional `commercial` block (unit, edition, replaySafe, schema ids, canonVersion, trustStoreRef/statusListRef as **logical names not URLs**, geometryProfile, licenseGate) and `distribution: "internal-only" | "sealed-public" | "sealed-paid"`.
- **L1 hard refusals** (parse): `commercial.replaySafe && store.kind === "qdrant"` ⇒ refuse (fires on roblox-luau today — forces the paid path onto a sealed pack); `distribution === "sealed-paid"` without `commercial` ⇒ refuse; `temporalAxis ⟺ dims === 3072`; static ⇒ dims ≤ 768; `geometryProfile === "full-concat"` ⇒ refuse (Phase 1).
- **L2 soft audit** `auditSealPolicy()`: sealed-paid with `calibrated: false`; placeholder threshold on paid path; embeddings of unlicensed source; temporal tile sold without lineage chain.
- Tile/pack Zod schemas live in `spectral-config/src/tile.schema.ts` + `src/canon.ts`; sealed artifacts are generated, never hand-edited (per FOLD_SPEC one-way rule).

## Calibration prerequisites (Track C — gates go-live, not build)

Strict order 1→2→4→3; 5–7 parallel; 8 gates release:

1. **Pin normalization**: wire `contracts/embeddingContract.ts` at `dim = 1024` per third (NOT 3072 — that would renormalize the concat and rescale the corpus by 1/√3); retire the duplicate Kahan in `engine/embed.ts`.
2. **Resolve the shatter-scale contradiction** (do not seal past this).
3. **Sweep the temporal kNN silence threshold** on a labeled held-out set; fill the calibration block honestly.
4. **Re-derive the centroid** with an explicit `domain` filter (`spectral-heatmap` is shared with finance-crypto — cross-domain contamination otherwise); serialize `stability: null` for genesis; content-address the result.
5. Fingerprint truthfulness + zero-padding. 6. Engine-version pinning (change ⇒ `engine-version-mismatch` revocation, never silent re-seal). 7. Refuse placeholder `t_plus1`. 8. Cross-language golden vectors.

## Testing & success criteria

- Adversarial fixtures: every `SEALED_FORBIDDEN_KEYS` member refused at any depth; non-NFC refused; JSON float refused; wrong `canon_version` refused; unknown signer refused; stale status list ⇒ unknown ⇒ fail closed; lower `sequence` refused.
- Round-trip: seal → verify → tamper one byte → refuse.
- Inclusion proof verifies standalone against the pack seal.
- Differential test: identical `cid`s from TS and Python canonicalizers over the golden set.
