# x402 Mount Kernel — Parent Architecture

**Date:** 2026-08-05
**Status:** Approved in brainstorm; implementation plan to follow.
**Supplies the parent for:** [x402 Failure, Recovery, and Verification Design](2026-08-04-x402-failure-recovery-verification-design.md) (child doc; its decisions are locked and cited here, not re-decided).
**Companion:** [terrain-tile-v1](2026-08-05-terrain-tile-v1-design.md)
**Problem:** The child doc specifies failure ownership, the 11-state durable lifecycle, and verification evidence — but presupposes a parent architecture (mounts, commercial manifest, orchestrator, codegen) that was never written. This is that parent, extended per the operator decision to plan both rails with the mainnet flip gated on evidence.

## Load-bearing discovery

`@x402/core@2.15.0` (installed at `~/.openclaw/npm/projects/blockrun-clawrouter-9e7c5a8d27/node_modules/@x402/`) ships **dual CJS+ESM** with a `./server` subpath exporting the official seller side: `x402ResourceServer`, `x402HTTPResourceServer` (with `processHTTPRequest()` and **`processSettlement()` as separate calls**), `HTTPFacilitatorClient`, framework-agnostic `HTTPAdapter` (8 methods, satisfiable by `node:http`), the full lifecycle hook set (`BeforeVerify/AfterVerify/OnVerifyFailure/BeforeSettle/AfterSettle/OnSettleFailure/OnVerifiedPaymentCanceled/ProtectedRequest`), and `@x402/evm/exact/server`. Consequences:

1. "Official middleware" ≠ express/hono; it is `x402HTTPResourceServer` driven through a custom `HTTPAdapter`. The dependency-free `node:http` host is the correct architecture, not a compromise.
2. The gap between `processHTTPRequest()` and `processSettlement()` is where the kernel executes the adapter and commits the result — the child doc's "result committed BEFORE `settling`" is **structurally enforceable by control flow**.
3. `paymentId` is NOT in `@x402/core@2.15.0` (it came from `@x402/extensions`, not installed). Decision: `paymentId` is a kernel-owned request contract — required `X-Payment-Id` header, format generated into OpenAPI and the 402 challenge. If `@x402/extensions` is later pinned and verified, register it and cross-check against the header (`payment_id_channel_mismatch` on disagreement) — additive hardening, never a correctness dependency.

## Four nouns, deliberately not collapsed

| Noun | Definition | Cannot be |
|---|---|---|
| **Mount** | Commercial unit: one manifest entry binding a capability, priced route surface, sealed substrate. Admitted or refused at startup. | An endpoint (one mount → N transports). |
| **Capability** | Versioned `operationId` + strict arg/result schemas + `capabilityVersion`. | Mutable (a change is a new version). |
| **Adapter** | Pure `(Readonly<Args>, Readonly<Substrate>) → Promise<Uint8Array>`. | Networked, stateful, clock-aware, subprocess-backed. |
| **Substrate** | Immutable sealed pack (cid, merkle root, detached Ed25519 seal). | A live Qdrant collection or mutable file. |

Ownership: transport shim (kernel) owns pre-payment admission and writing official response instructions verbatim; official engine owns challenge/verify/settle/cancellation; the **mount orchestrator** owns fingerprints, `paymentId` binding, leases, execution, result+receipt persistence, quarantine, replay, audit, the state machine; the adapter owns args→sealed-bytes; the SQLite ledger is durable truth no transport can bypass. Per the child doc, "manual `@x402/core` flow" (re-implementing verify/settle/challenge) stays rejected; driving `x402ResourceServer` directly for MCP is not that — verification/settlement/cancellation remain official code.

## The keystone: two fingerprints

A single fingerprint over all eleven child-doc inputs would `409` a client that legitimately re-signs after authorization expiry — the exact production behavior ClawRouter's `payment-preauth.ts` documents (Solana blockhash expiry ~60–90s forced `skipPreAuth` to avoid double charges). Split:

| Hash | Inputs | Purpose |
|---|---|---|
| `request_fingerprint` | `operationId`, `capabilityVersion`, `adapterVersion`, `argDigest`, `scheme`, `network`, `asset`, `amount`, `payTo`, `substratePackId` | *What was bought.* The `paymentId` UNIQUE binding is on this. Stable across re-signing. |
| `authorization_fingerprint` | `request_fingerprint`, `paymentNonce`, `paymentExpiry`, `payer` | *Which authorization paid.* Per settlement attempt and receipt; what chain evidence must match. |

Both carry a persisted `fingerprint_version`. **Every `request_fingerprint` input comes from request + generated manifest — none from a payment payload** — so binding validation, 409, 202, settled replay, quarantine 503, and entitlement are all pre-payment admission decisions. Abuse guards: ≤3 distinct authorizations per `paymentId`; none accepted at state ≥ `settling`; once `settled`, new authorizations are refused and the entitlement served instead.

## Commercial manifest & codegen

Extend `spectral-config` (closed enums, mandatory provenance, refusal-over-guessing), per the companion tile spec's extension points. The `commercial` block declares: `effect` (non-`read_only` refused at L1 parse AND L2 startup — keeping the enum makes the startup refusal testable), `replaySafe` (false refused), operations (with `deadlineMs`, `maxResultBytes`), substrate (sealed-pack only), price (`exact` scheme only; `payToRef` never a literal address), `challengeEpoch`, `retryEntitlementSeconds: 86400`, revocation refs, compensation policy, `limits {maxPricePerCall, dailySettledValueCeiling}`, mandatory `license`.

`generate:all` (extending `generate-v2.ts`, one-directional, secrets omitted) emits: `x402-routes.json`, `openapi.json`, `discovery.json` (`GET /.well-known/x402`), `catalog.json`, `mcp-tools.json`, `runtime-policy.json`, `fingerprint-spec.json`, `refusals.json` (the stable machine-readable error-code table), `generated.lock` (digest map). No-drift is enforced twice: CI regenerate-and-byte-compare, and **the kernel hashes every artifact at boot against `generated.lock` and refuses startup on mismatch**. The kernel never reads `domains.config.ts` at runtime — ESM at build time, CJS at runtime, JSON across the seam.

## SQLite ledger

`WAL`, **`synchronous=FULL`** (the loseable commit under NORMAL is the receipt commit — settled money with no receipt is the one unrecoverable state), `busy_timeout=5000`, `foreign_keys=ON`, `trusted_schema=OFF`. All writes `BEGIN IMMEDIATE`. Driver: `better-sqlite3` pinned (synchronous ⇒ transactions cannot interleave within the single writer; reject experimental `node:sqlite` on Node 20). One writer connection behind a mutex; separate readers. `boot_id` per process start distinguishes crashed from live without heartbeats.

Tables: `schema_meta`, `runtime_boot`, `mounts`, `calls` (11-literal `CHECK` on state), `payment_bindings` (**`payment_id` PK → `request_fingerprint`; the 409 source and concurrency primitive**), `authorizations`, `call_states` (append-only, never purged), `state_transitions_allowed` (the machine in data; trigger rejects inserts outside it), `leases` (**PK `(call_id, kind)`, `kind IN ('execute','settle')`** — additively enforces one settlement attempt), `results`, `settlement_attempts`, `receipts` (`UNIQUE(call_id) WHERE success=1`, never purged), `quarantine`, `evidence`, `entitlements`, `make_good`, `delivery_log`, `ops_audit` (written before any ops action acts), `challenge_counters` (anonymous 402 probes — a row per probe is a free-write DoS; `challenged` rows exist only when a `paymentId` was supplied), `value_ledger` (daily ceiling, enforced in-transaction), `revocation_cache`, `denied_payers`.

**Transaction boundaries** (asserted in SQL, `changes()===1` checked):

- **T1 executed**: insert `results` + `executing→executed` + delete execute lease, one commit.
- **T2 settling**: `executed→settling` guarded by `EXISTS(results…)` in the UPDATE's WHERE; acquire settle lease (PK conflict ⇒ 202); insert `settlement_attempts(outcome='unknown')`. Nothing calls `processSettlement()` before T2 commits. Crash after T2 ⇒ `settling` ⇒ `settlement_unknown` at restart — exactly the child doc's rule.
- **Receipt commit**: insert `receipts` + `settling→settled` guarded by `EXISTS(receipts… success=1)` + entitlement row + value-ledger increment + delete settle lease, one commit.
- **Delivery**: join results×receipts on the same `request_fingerprint` + live entitlement. Write bytes, THEN record delivery (recording first can record a delivery that never happened; stuck-at-`settled` is harmless and self-heals on retry). Repeat deliveries append to `delivery_log` without re-transitioning.

Retention: `result_bytes` nulled at entitlement expiry (`result_purged_at` annotation, not a transition); receipts/state/audit rows permanent.

## Module & runtime

**CJS kernel package `spectral-x402/` with its own tsconfig (`module: node16`, `moduleResolution: node16`, ES2022, Node 20). Root untouched.** Rationale: `@x402/*` ship `require` conditions for every subpath; `better-sqlite3` is native CJS; root `pkg` (node18 targets, no ESM support) can never host the kernel — exclude it from `pkg` entirely. Root's classic `node` resolution can't see `exports` subpaths, which is why the kernel gets its own tsconfig. `zod` stays v3. The kernel imports zero ESM; `spectral-config` runs at build time only.

## Cost-per-call

Today's live surfaces are payment-safety defects, not perf nits: `/retrieve` reparses 14.6 MB JSON per request; `POST /query` rebuilds from 33,685 files per request; terrain_query spawns a conda subprocess with 15 s SIGKILL. Execution latency that can exceed the payment authorization window produces "execution succeeded, settlement impossible" — the one outcome with no remedy — and attacker-controllable cost is DoS-by-payment.

The paid path touches none of it: `SubstrateRegistry` singleton loads each pack once at boot (verifies merkle root + seal exactly once); on-disk `pack.idx` (fixed-width 32-byte sorted cid digests + offsets) and `pack.dat` (concatenated canonical tile bytes) read into Buffers; lookup = binary search → `subarray` — zero parse, zero copy. Canonicalization cost per call is zero (tiles stored canonical at seal time). **Budget rule: adapter CPU within the same order of magnitude as the ~4-fsync durability floor — `deadlineMs = 5` p99, `maxResultBytes = 2 MB`, declared per operation, enforced by the orchestrator, asserted by a CI benchmark gate.** Subprocess adapters are inadmissible in Phase 1; `query_naics.py` is demoted to an offline pack builder.

**Phase-1 sellable ops are content-addressed** — `tile_fetch(cid)`, `pack_inclusion_proof(cid)`, `pack_manifest(packId)` — because the roblox-luau kNN gate is uncalibrated (`threshold: 0` placeholder) and an uncalibrated gate cannot be sold as a silence guarantee. Similarity search is admitted as a second operation when Track C closes.

**Challenge stability** (the pre-auth double-charge lesson folded in): the 402 challenge for `(mount, capabilityVersion, network)` is deterministic and manifest-derived; `DynamicPrice`/`DynamicPayTo` refused at parse; `challengeEpoch` emitted on both 402 and 200 so caching clients invalidate deterministically; re-signing clients are not punished (nonce-free `request_fingerprint`); paid responses carry `Cache-Control: no-store`.

## Adapter boundary: `scripts[].source` structurally cannot leak

1. **No import path**: the kernel's transitive import graph contains zero modules under `spectral-terrain/contracts/**` — CI-failing dependency-direction test.
2. **The seal boundary**: `source` is not a tile field; a tile containing it would have a different `cid` and would have had to be deliberately signed.
3. **Egress digest check**: `blake2b256(emitted_bytes) === requested_cid` before the envelope — unforgeable, indifferent to field names. Plus `.strict()` result schemas (positive allowlist).
4. Sealing-time refusal (forbidden keys, byte ceiling). 5. Adapter purity (no db/fetch/fs/clock/env injected; lint ban incl. `toFacilitatorEvmSigner`, `child_process`). 6. Manifest refusals make paid-mount-on-Qdrant unrepresentable. 7. **Revocation checked pre-verify, not pre-delivery** — refusing after settlement manufactures the no-refund case; a mid-window withdrawal delivers the exact bytes paid for plus a status advisory, and the operator eats the make-good.

Envelope: extend `HuskEnvelope` → `apiVersion: "mount.v1"`, adding `callId`, `paymentId`, `requestFingerprint`, `fingerprintVersion`, `cid`, `packId`, `merkleRoot`, `inclusionProof`, `tileStatus`, `receipt` (public fields), `entitlementExpiresAt`, `challengeEpoch`. (Resolve the `// FIX PATH` import in `husk-production-scaffold/src/server/service.ts` first.)

## Public behavior (pre-payment admission order)

TLS/body-cap/rate-limit → route match → revocation freshness (fail closed) → daily ceiling → strict args → `argDigest` → `request_fingerprint` → require `X-Payment-Id` (absent ⇒ 402, counter only) → binding lookup:

| Binding state | Response |
|---|---|
| none | continue to official verify |
| different fingerprint | **409** `payment_id_fingerprint_conflict` |
| settled/delivered, entitlement live | replay via `ProtectedRequestHook.grantAccess`: stored result + receipt, no payment consumed |
| settled/delivered, entitlement expired | **410** `entitlement_expired` (a `paymentId` is one logical paid request, forever) |
| payment_present/verified/executing | **202** + `callId` |
| execution_unknown | new lease, re-execute (replay-safe, audited); live lease ⇒ 202 |
| executed/settling | **202** + `callId` |
| settlement_unknown | **503** opaque `settlement_pending_review` |
| execution_failed | retry permitted (payment was cancelled), bounded by `attempt_count`; after K ⇒ 503 |
| settlement_rejected | **402** `settlement_rejected`; output locked |

202 lease-contention nuance: same `authorization_fingerprint` (retransmit) ⇒ do NOT cancel (would cancel the live attempt's authorization); audit `duplicate_inflight`. Different one ⇒ dispatch official cancellation so non-settlement is recorded. Falls directly out of the two-fingerprint split; not left to transport code.

Ops surface: loopback-only listener (refuse non-loopback bind), detached Ed25519 request signatures (no bearer tokens — nothing to leak into a config file), 5/min rate limit, `/ops/reconcile` additionally behind `--allow-reconcile`. The operator attaches evidence; the **same evidence evaluator as the automatic path** decides; no write path to `receipts`; no code path from ops to `delivered`.

## The five deferred decisions (dual-rail scope)

1. **Wallet**: key-less seller — `payTo` is a watch-only address; spending key in hardware, never on server. Startup refuses any config value shaped like a private key or mnemonic. No transfer capability in the build; sweeps manual from hardware.
2. **Custody**: non-custodial, `exact` only. `batch-settlement` (claim key ⇒ custody), `auth-capture` (escrow ⇒ custody + money-transmission analysis), `upto` (breaks challenge stability) all refused at parse despite being installed.
3. **Facilitator criteria** (each with a dated artifact): `/supported` on `eip155:8453`; documented settlement semantics incl. timeout meaning; **written single-use-nonce guarantee (EIP-3009 `authorizationState`) or a status-lookup endpoint** — the crux that converts `settlement_unknown` from "operator eats it" to "safe to resolve"; repeated-settle behavior; rotatable credentials; fees/gas; liability/SLA; jurisdiction; funds flow payer→payTo directly; **two facilitators configured** (failover between calls, never within one settlement).
4. **Compensation** (no onchain refund, no fungible credit — locked): (a) stoppable entitlement clock — `settlement_unknown` time doesn't count; audited operator extensions; (b) one-shot named make-good — exactly one future specific `request_fingerprint` served free via `ProtectedRequestHook.grantAccess`, burned in the delivery transaction, structurally unable to fire without a live grant/entitlement row; (c) policy published machine-readable in discovery/catalog/OpenAPI and referenced from the 402 challenge; (d) what the operator eats: money-not-service demands (manual, out-of-band), goodwill gas, `settlement_unknown` review labor, facilitator misreports until chain evidence — **bounded by `maxPricePerCall` + `dailySettledValueCeiling` enforced in-transaction; the worst-case day is a number chosen in advance. Pricing is a risk control, not only revenue.**
5. **Compliance posture** (not legal advice): non-custodial/key-less/no-fiat keeps money-transmission analysis simple; no fungible credits by design; record `payer` when supplied + operator `denied_payers` list in `BeforeVerifyHook` + rely on facilitator screening (recorded as trust boundary) — do not build a screening service; mandatory license/provenance at seal + `withdrawn-license` revocation for data rights; permanent receipts for tax export; **counsel review before mainnet is a named gate item, signed or explicitly waived in writing.**

## The mainnet flip gate

`eip155:8453` startup block holds until `manifests/mainnet-gate.json` + detached operator signature exists and validates at boot: every child-doc evidence item from BOTH namespaces (`sim.*` AND `sepolia.*` — simulation can never file under a Sepolia id), digests of captured sanitized evidence files all present and matching, the five decision documents digested, plus: calibration true for any kNN op (else content-addressed only), facilitator criteria complete incl. nonce guarantee, custody attested + sweep rehearsed, limits set, compensation published, drift green, integrity claims fixed, transport hardening proven, **7-day Sepolia soak with zero unexplained `settlement_unknown` and one deliberately induced crash at each of `executing`/`executed`/`settling` recovered correctly**, screening live, counsel item resolved. Missing items enumerated in the refusal. The flip is a signed artifact, not an env var.

## Verification

Test framework: `node:test` (built into Node 20, zero deps, CJS-native) + bespoke exit-code refusal scripts in the `refusal-check.ts` house style. The stub facilitator substitutes the one boundary (`FacilitatorClient`) — everything above it is real official code — with programmable modes: valid, invalid, expired, underpaid, wrong-asset, wrong-network, wrong-recipient, arg-mismatch, timeout, hang, **succeed-then-drop-response** (produces `settlement_unknown` without a chain). Every child-doc local-sim evidence item maps to a test asserted in SQL counts, never log scraping. Fault injection: child process + SIGKILL at 7 instrumented points (`FAULT_POINT` read once at boot), each with an expected post-restart state and buyer-visible outcome. Secret-leak test by sentinel injection (plant unique values in payment payloads; assert zero occurrences in stdout/stderr/metrics). Sepolia suite = the child doc's seven items, each emitting a sanitized evidence file, skipping cleanly when credentials are absent.

**"Hardened boilerplate" operationally**: `defineAdapter({operationId, capabilityVersion, argSchema, resultKind, handler})` as the only registrable shape; `assertAdapterConformance` (deterministic, pure, bounded, digest-clean, schema-strict); a fixture-pack builder (no Pi/Qdrant in tests); the stub facilitator + fault injector; `npm run admit <mountId>` running parse → refusals → codegen → drift → conformance → full sim suite → GO/NO-GO. **Adapter N's onboarding: write the adapter, declare the mount, run `admit`.**

## Must-fix before any paid call (summary)

False BLAKE3/BLAKE2b claims (`server/api.ts:80`, `simhash-guard.ts` header + dead `hashToken`) — fixed 2026-08-05 on this branch. Unpadded `signatureHex` (pad to 32 on any sealed surface). Paid path bypasses (not fixes): per-request index reload, per-request `buildIndex()`, BigInt-popcount linear scan, conda spawn, unreachable `registry.invoke()`. Caller-supplied `shardDir` never crosses to the paid surface (closed `packId` set only). Body caps + `refusals.json`-mapped errors on all paid routes; `Cache-Control: no-store`. `husk-production-scaffold` committed and its `// FIX PATH` resolved. Kernel excluded from `pkg`.
