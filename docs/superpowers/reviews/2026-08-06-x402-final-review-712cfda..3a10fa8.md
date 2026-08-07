# Independent Verification Review — 712cfda..3a10fa8

**Reviewer:** replacement gate (session b437dc64), 2026-08-06
**Scope:** 11 commits implementing Tasks 5–7 (x402 dep bump, MCP transport over Streamable HTTP, parity/evidence suite) on the spectral-x402 payment kernel.
**Standing:** independent trust review after the authoring session's review artifacts were lost. Finding #0 is pre-adjudicated by the user as BLOCKING and is not re-litigated here.

---

## 1. Scope & Method

**Read in full:**
- The three task briefs (`task-5-brief.md`, `task-6-brief.md`, `task-7-brief.md`) and the progress ledger (`progress.md`) including USER RULINGS and the 16 deferred minors.
- The entire 203KB diff package `review-712cfda..3a10fa8.diff` (4,874 lines): package.json, package-lock.json (all ~90 added lockfile entries enumerated), src/index.ts, src/ledger.ts, src/mcp-server.ts (new), src/server.ts, src/transports/mcp.ts (new, 771 lines), src/test/boundary.test.ts (new, 791 lines), src/test/mcp-transport.test.ts (new, 743 lines), src/test/retry.test.ts (new, 293 lines).
- At HEAD, for parity/context: `spectral-x402/src/http.ts` (clientKey, BODY_CAP, TLS gate, resolveRoute/matchPathTemplate, catch-all), `spectral-x402/src/kernel.ts` (requestFingerprint, authorizationFingerprint, full `handle()` admission→verify→execute→settle path, via `grep -a`/`sed` because of the known NUL-byte binary flagging), `spectral-x402/src/facilitator.ts` (StubFacilitator underpayment check), `spectral-x402/src/server.ts` (digest verification loop), `spectral-config/src/generate-all.ts:100-115` (Finding #0 site), `manifests/generated.lock`, `manifests/mcp-tools.json`.

**Ran (read-only):**
- `git log`/`git show --stat` for all 11 commits (per-commit footprint verification).
- `git diff --name-only 712cfda..3a10fa8` — **kernel.ts is UNCHANGED in this range.** The diff package's "APPENDED: src/kernel.ts full text diff" section at the file's end is an empty header with no content; that is correct, not an omission — verified against git directly. (The task briefing anticipated a real appended diff; there is none because there is no kernel diff.)
- `npm ls @x402/core @x402/evm @x402/mcp @modelcontextprotocol/sdk` — single deduped `@x402/core@2.21.0`; SDK 1.30.0 deduped under `@x402/mcp`. No duplicate copies.
- `grep -rn createPaymentWrapper src/` — appears exactly once, in the mcp.ts header comment declaring it deliberately never imported. Zero imports.
- `grep z.enum/z.nativeEnum` over src (non-test) — no enum schemas exist in shipped adapters.
- `python3` inspection of `generated.lock` (mcp-tools.json IS a locked artifact) and `mcp-tools.json` (6 tools, `{16,128}` paymentId pattern present).

**Not run:** the full test suite (controller ran it: 129/129 pass, spectral-config `check:all` no drift, `{16,128}` present in both manifests). No focused test was run: the doubts raised by reading (Findings #1, #2) are design-level and are settled by the code itself, not by a test execution.

**Verified vs inferred:** every claim below is from direct code reading unless marked *(inferred)*.

---

## 2. Strengths

- **The lifecycle-authority discipline is real, not aspirational.** `transports/mcp.ts` imports exactly four wire helpers + one key constant from `@x402/mcp` (`mcp.ts:90-95`); `createPaymentWrapper` never appears; the file header (`mcp.ts:11-33`) carries the mandated hook→ledger transition map naming the kernel as owner of challenge/verify/execute/cancel/settle/deliver. The edge never calls the facilitator; money-movement assertions in every test read StubFacilitator counters.
- **The edge refuses before it allocates.** Host/Origin gate runs before session allocation (`mcp.ts:~478-480` in-file), the session cap check runs before construction, and the `allocating` counter closes the concurrent-initialize race — with a test (`72e86ec`) that induces `Server.connect` failure via prototype patch and proves the ceiling slot is returned.
- **Both known SDK advisories are explicitly handled**: per-session Server+transport pairs (GHSA-345p-7cg4-v4c7) and DNS-rebinding protection turned on plus duplicated at the edge (GHSA-w48q-cv73-mx4w), with loopback-only default allowlists computed from the actual bound port.
- **The test suites assert money, not just shape.** Cross-transport parity (boundary (b)) asserts one `calls` row, one receipt, one settlement_attempt, `settleCalls==1`, `verifyCalls==1`, byte-identical delivery, same callId — the test's assertions genuinely match its name. Restart evidence (boundary (e)) uses a fresh StubFacilitator so "0 settlements after restart" is a fact about the second boot.
- **Two real pre-existing defects were found and fixed in-range**: the undeclared `execution_failed → payment_present` ledger edge that wedged a paymentId forever with ILLEGAL_TRANSITION (`23b9b69`, pinned by four retry tests including the permanent-miss 3-attempt loop), and the entitlement off-by-one that delivered on the expiry millisecond (`3f8ce0a`, `ledger.ts:672-678`, `>` → `>=`, pinned by injected-clock tests at expiry−1/expiry/expiry+1).
- **The facilitator/payTo pairing guard (`3a10fa8`, `server.ts:~299-310`) closes a genuine burn-address hazard** both CLIs could reach by omission, lives once in `bootKernelOnly` so both spokes inherit it, and is tested in both directions (refuses the pairing; keeps the stub simulation bootable).
- **Commit hygiene is exact.** Task 5's bump (`7174b45`) touches only package.json + lockfile. Each fix commit ships with the test that would have caught it. All claimed pins are exact (`1.30.0`, `2.21.0` ×3).

---

## 3. Findings

### Finding #0 — Generator pathTemplate collision trap (CRITICAL, pre-confirmed, BLOCKING)

**Where:** `spectral-config/src/generate-all.ts:105-110` (verified live at HEAD), paired with `spectral-x402/src/http.ts:301-311` (`resolveRoute`, first-match, no ambiguity detection).

**What:** the generator assigns `pathTemplate` from a hardcoded ternary whose else-branch gives `/<id>/manifest` to ANY operation that is not `tile_fetch`/`pack_inclusion_proof`. A new operation's route therefore collides with `pack_manifest`; `resolveRoute` resolves by insertion order.

**What this review adds — the blast radius is worse than "wrong price," and it is now also a parity violation:**
1. `resolveRoute` returns an **operationId**, so a colliding path dispatches the **wrong operation entirely** — wrong adapter, wrong product, wrong price, silently, on a paid wire (`http.ts:131-136` resolves the operation from the relative path shape alone).
2. The MCP spoke routes by **tool name** (`mount__operation`, `mcp.ts` `buildRoutes`), which cannot collide. So the same new operation would dispatch **correctly over MCP and incorrectly over HTTP** — a direct violation of the two-doors-one-kernel parity claim that is Task 7's headline, live for the first new operation anyone adds.
3. The commits under review neither fix nor worsen the generator itself (spectral-config untouched in range), but the evidence suite **knowingly sidesteps it**: boundary (a)'s fixture hand-authors a non-colliding `pathTemplate` with an in-code comment admitting "`resolveRoute` is first-match with no ambiguity detection, so a colliding shape would resolve to the wrong operation" (`boundary.test.ts`, addEchoCapability). The authoring session saw the trap and routed around it; Task 7(c)'s config-only mount clones existing operations only and does not exercise a new operation. The evidence therefore does not disprove the trap — confirming the user's ruling.
4. The boundary suite also demonstrates (via `fixtureManifests` + the publicly exported `cidOf`) a supported **hand-edit + re-seal** path into production manifests that bypasses the generator entirely.

**Fix (user-mandated, verbatim):** declared per-operation pathTemplates in the generator; generation-time failure on duplicate/colliding paths; artifact regeneration; re-run 129 server tests + 104 config checks + dependency-tree check + no-drift.
**Reviewer recommendation on top (not part of the mandate):** because of (4), also add a boot-time refusal in `bootKernelOnly` on duplicate/ambiguous relative path shapes per method — defense-in-depth against a hand-edited, re-sealed manifest that never passed through the generator.

### Finding #1 — MCP limiter identity is resettable by session churn; initialize is unmetered (IMPORTANT)

**Where:** `spectral-x402/src/transports/mcp.ts` (clientKey `mcp:${sessionId}`, tools/call handler; MAX_SESSIONS=256; POST/initialize path), vs `http.ts:109` (`clientKey = req.socket.remoteAddress`).

**What:** the plan mandated the tools/call clientKey be derived from the MCP session id, and it is — implemented as specified, into the single kernel-owned limiter. But nothing meters `initialize` per remote address. A single client can DELETE its session (or simply abandon it) and re-initialize, receiving a fresh `randomUUID()` and therefore a **fresh limiter bucket at will**. `MAX_SESSIONS` caps *concurrent* sessions, not cycling rate. On HTTP the identity (socket address) is stable; on MCP it is client-refreshable.

**Verified amplification chain (code read):** a fake-payment call with paymentId+payment reaches `ledger.openCall` + `recordAuthorization` before verify fails (`kernel.ts` handle path) — durable rows per attempt. Per-bucket that is bounded by the limiter; across cycled sessions it is unbounded. Net: anonymous-402 flood metering and fake-payment ledger-growth metering are both evadable from one IP on the MCP spoke. (Challenges without a payment write no ledger rows — verified: `openCall` sits after the `!inv.payment` challenge return — so the challenge-flood variant costs CPU only.)

**Why not blocking:** no wrong-price/double-settlement/replay impact; default posture is loopback bind + Host/Origin allowlist, and public exposure requires explicit operator action. This is a plan gap (initialize metering was never specified), not an implementation error against the plan.

**Fix (recommend same fix wave):** meter session creation per `req.socket.remoteAddress` (edge-local bucket or kernel limiter under a distinct key such as `mcp-init:<addr>`); keep the session-id key for tools/call exactly as the plan mandates.

### Finding #2 — Delivery ack keyed by session-scoped JSON-RPC id; concurrent id reuse misattributes the ack (MINOR)

**Where:** `mcp.ts` — `renderOutcome` files `pendingAcks.set(String(extra.requestId), …)` into the **session-level** map; `armDeliveryAck` resolves by ids read from the arming POST's body.

**What:** JSON-RPC ids are client-chosen. Two concurrent POSTs on one session reusing the same id: call A's delivery entry is overwritten by call B's; A's response `close` then acks B's callId against **A's** `writableFinished`, and B's own close finds nothing. Result: a `delivered` mark for bytes that may not have flushed, and a lost ack (call stays settled/replayable — which is safe) for the other. Also `String()` folds id `1` and id `"1"` together. No settlement or pricing impact; the harm is delivery-log/audit accuracy at the transport seam. Requires client misbehavior. *(Unverified whether SDK 1.30.0 independently rejects duplicate in-flight ids per session; the code-level hazard stands regardless.)*

**Fix:** key pending acks by a server-generated token (or `requestId` + per-POST nonce) instead of the raw JSON-RPC id.

### Finding #3 — HTTP edge lacks the nonce-presence guard the MCP edge has (MINOR, pre-existing, surfaced by parity work)

**Where:** `http.ts:144-151` parses X-Payment but never checks `nonce`; `kernel.ts` `recordAuthorization` calls `digestHex(inv.payment.nonce)` unconditionally (`digestHex` at kernel.ts:194 throws on undefined); `http.ts:222` catch-all → 500. The MCP edge refuses this cleanly as `payment_invalid` (`mcp.ts` nonce guard, with a comment acknowledging exactly this).

**What:** a nonce-less X-Payment over HTTP is an unmetered 500 mid-`handle()`; the same payload over MCP is a clean refusal. Out of range (http.ts untouched), but the range's own commit text identifies it. **Fix:** port the MCP guard to http.ts in the fix wave.

### Finding #4 — Boundary (a) test-name overclaim: "callable … on both spokes" is asserted for HTTP only (MINOR)

**Where:** `boundary.test.ts` test "(a) …callable and discoverable on both spokes".

**What:** the externally-registered echo adapter is asserted *discoverable* on both spokes (discovery JSON + tools/list) but its *paid call* is exercised over HTTP only. Same pattern class as the already-parked "test name overclaims" minor from Tasks 3–4. The MCP call path for external adapters is indirectly covered by (b)/(c) machinery, and `buildRoutes`' construction-time symmetry check narrows the gap. **Fix:** one `callTool(ECHO_TOOL, …)` with payment closes it.

### Finding #5 — Session-budget knobs unreachable from `bootMcp`/CLI (MINOR)

**Where:** `mcp-server.ts` `bootMcp` passes only tools/requireTls/allowedHosts/allowedOrigins into `createPaidMcpServer`; `McpOptions.maxSessions` exists but is not plumbed; `SESSION_IDLE_MS` is a constant.

**What:** operators of the shipped entrypoint get MAX_SESSIONS=256 and a 5-minute TTL with no configuration path. Defensible defaults; worth a plumb-through when #1 is addressed.

### Finding #6 — Dependency-surface observations (INFO, no action)

- The SDK pin drags ~90 transitive packages into the lockfile (express 5.2.1, hono, ajv, jose, pkce-challenge, cors, cross-spawn, express-rate-limit, …). All registry-resolved with integrity hashes; none are imported by our edge, which deliberately uses plain `node:http` (`mcp.ts` header notes the SDK's express dependency is unused). Expected for `@modelcontextprotocol/sdk@1.30.0`; recorded as supply-chain surface on a payment server.
- `@x402/evm` has **zero direct imports** anywhere in src; `@x402/core` is imported once, type-only (`mcp.ts:95`). Task 5's blast radius was therefore one type import plus `@x402/mcp`'s internal use — the brief's `x402HTTPResourceServer`/`HTTPAdapter` type-hold check is vacuous in this codebase (no such usage exists).

---

## 4. Deferred-Minors Triage

**MUST FIX BEFORE MERGE (rides the #0 fix wave):**
- **resolveRoute first-match, no ambiguity detection (http.ts:301)** — this is the runtime half of Finding #0; the generator fix removes the known collision source, but the hand-edit+re-seal path proven viable by boundary.test.ts means colliding manifests can still reach boot without the generator. Add the generation-time failure (mandated) and, per reviewer recommendation, a boot-time duplicate-shape refusal.

**STAYS PARKED (one line each):**
- close() doesn't drain in-flight acks (server.ts) — unchanged risk; note it now has a twin in `bootMcp().close()` and the mcp-server CLI (ack-after-close is caught+logged at the MCP edge, `armDeliveryAck` catch).
- TLS-posture + X-Payment-parse refusals unmetered pre-kernel (http.ts) — MCP adds equivalent unmetered pre-kernel refusals by the same design; the material escalation is Finding #1's initialize path, handled there.
- statusFor bypass enumeration (tls_required/payment_invalid literals) — HTTP-only; MCP has no status table.
- transport-seam code-extraction regex syntactic — unchanged.
- OPERATION_ARGS successor (arg schemas → x402-routes.json emission) — unchanged.
- index.ts exports Kernel ctor + StubFacilitator (hand-assembly path) — the new `createPaidMcpServer`/`buildRoutes` exports are the same class; boundary tests legitimately depend on this surface now.
- index.ts/server.ts step-numbering, inline RefusalTable, dead acked guard, dead BODY_CAP — cosmetic, unchanged (note: mcp.ts's BODY_CAP is live).
- BUILTIN_ADAPTERS mutable export — unchanged; boundary (a) composes it read-only.
- External AdapterMiss codes bypass refusals.json guard — MCP renders codes without a status table, so no new failure mode; HTTP-side concern unchanged.
- buildAdapterRegistry duplicate-operationId refusal untested — unchanged.
- "identical to BUILTIN_ADAPTERS" test-name overclaim — unchanged; Finding #4 is the same pattern in a new file.
- kernel.ts no-echo comment / invalid_enum_value echo (forward vector) — **checked against the new edge**: MCP's `refusalResult` forwards kernel `detail` verbatim, so the vector would gain a second transport — but no `z.enum`/`z.nativeEnum` exists in any shipped schema (grep-verified), so it remains latent. Stays parked with a re-check trigger: the moment an external adapter schema with enums lands.
- server.ts casts method/pathTemplate without presence validation — unchanged; new MCP-side symptom (an undefined pathTemplate would surface as an undefined `resource.url` in a challenge) is still config-error territory.
- manifests/discovery.json shape vs live /.well-known/x402 — pre-existing, unchanged.
- field-level .default() silently no-ops — unchanged, documentation debt.

---

## 5. Invariant-by-Invariant Verdicts

| Binding decision | Verdict | Evidence |
|---|---|---|
| One lifecycle authority; wire helpers only; no createPaymentWrapper | **HELD** | `mcp.ts:90-95` imports (4 helpers + META key); grep: zero `createPaymentWrapper` imports; edge never touches facilitator; settle/verify counters asserted across all suites |
| Explicit hook→ledger transition map in mcp transport file header | **HELD** | `mcp.ts:11-33`, names kernel as owner of all six phases, helpers as wire-format only |
| Streamable HTTP, not stdio; session lifecycle (initialize → id → resumption) | **HELD** (resumability EventStore deliberately omitted and declared: `mcp.ts` header "what is deliberately NOT here") | `StreamableHTTPServerTransport`; session tests (g); server-issued UUID ids; stale id → 404, never adopted |
| Origin/host validation | **HELD** | edge pre-gate `rebindingFault` before allocation + SDK `enableDnsRebindingProtection: true`; tests: foreign Host 403, foreign Origin 403 with no session allocated, loopback positive controls |
| TLS posture matching paid HTTP surface | **HELD** | same condition (`x-forwarded-proto !== "https"`), same code (`tls_required`), same 400, applied before all methods; test "code for code"; CLI default fail-closed (`!== "0"`) |
| clientKey from MCP session id; ONE shared limiter, not per-transport buckets | **HELD as specified** — residual: Finding #1 (session churn resets identity; initialize unmetered — plan gap, not deviation) | `mcp:${sessionId}` into kernel-owned `RateLimiter` (kernel.ts:207-217); no limiter instantiated at the edge |
| Entitlement tests: injected clock at expiry−1 / expiry / expiry+1, no elapsed time | **HELD** | mcp-transport (e); `now` threaded boot→Ledger (`server.ts` KernelBootOptions.now → `ledger.ts`); no sleeps in the file. On record: `3f8ce0a` deliberately tightened live behavior from `>` to `>=` (lapses AT expiry, 200→410 on the boundary millisecond) — intentional, now pinned; do not rediscover as a regression |
| Task 7(a) = reachability through public surface | **HELD** (with Finding #4 overclaim caveat) | echo adapter registered via `defineAdapter` + `[...BUILTIN_ADAPTERS, echo]` + manifest edit + re-seal only; discovered on both spokes; paid delivery asserted over HTTP; metered + receipted |
| Result-before-settling; receipt-before-settled; delivery requires both | **HELD** | kernel.ts unchanged in range (git-verified); `commitResult` precedes settling in `handle()`; retry tests assert 0 settles without a result across 3 attempts |
| One paymentId → one fingerprint | **HELD** | retry test "a retry that changes the args still conflicts" → `payment_id_fingerprint_conflict`, 0 settles; fingerprint excludes `resource` (kernel.ts:245-259), so HTTP-concrete-path vs MCP-pathTemplate cannot split fingerprints — cross-transport replay parity holds by construction |
| Never blindly resubmit | **HELD** | replay tests: settleCalls stay 1; restart test: second boot settle=0 AND verify=0; MCP replay carries no payment at all in parity test |
| Cross-transport replay → one receipt (the parity test's actual assertions) | **HELD** | boundary (b): 1 calls row, 1 receipt, 1 settlement_attempt, 1 result, same callId, byte-identical, `replayed:true` — assertions match the name |
| MCP edge records delivery only after its send succeeds | **HELD** | `armDeliveryAck`: ack on `close` only when `res.writableFinished`; aborted send → no ack, call stays settled/replayable; delete-before-ack = ack-once. *(Inferred: `enableJsonResponse: true` makes the POST response the delivery vehicle so `writableFinished` is meaningful — corroborated by the passing delivery-log test, not independently verified against SDK internals.)* Residual: Finding #2 id-collision corner |
| Restart evidence actually restarts | **HELD, with stated caveat** | boundary (e) fully tears down boot #1 (listeners + ledger closed) and re-boots from the same ledger file with a fresh StubFacilitator (counters provably zero); same process, but the identical `bootKernelOnly` path incl. `reconcileOnBoot` runs. OS-process-level `service:restart && service:health` — see CANNOT VERIFY |
| Kernel loses HTTP coupling, never gains it | **HELD** | kernel.ts, http.ts, limiter.ts, facilitator.ts, adapter.ts, substrate.ts all unchanged in range (git diff --stat empty); new transport lives entirely outside the kernel |
| Loopback default / stub-facilitator guards / TLS fail-closed default | **HELD, strengthened** | both CLIs default `127.0.0.1`; mcp-server deliberately reuses `X402_BIND` so the stub-loopback guard covers it (documented rationale); `3a10fa8` adds the mirror-image real-facilitator+dev-payTo refusal, tested both directions |
| Commercial manifest stays authoritative | **HELD** | `mcp-tools.json` is a `generated.lock` artifact (verified), digest-checked at boot (server.ts:118-127); tools/list returns it VERBATIM (deepEqual test); `buildRoutes` refuses both directions of disagreement pre-listen; challenge amount/payTo copied never computed (`paymentRequiredFor`) |
| No secret, address, or endpoint enters git | **HELD** | diff contains only the `0x…dev` placeholder, `facilitator.invalid`, and loopback addresses |
| Exact pins; no duplicate @x402/core | **HELD** | package.json exact `1.30.0`/`2.21.0`×3; `npm ls`: single deduped core; lockfile additions all SDK-transitive (enumerated), no unrelated packages |
| Task 5: changelog review performed ("six minors read") | **CANNOT VERIFY** | no artifact of the reading survives; the bump itself is isolated and mechanically sound (commit 7174b45 touches only package.json+lock), and src exposure to the bumped packages is one type-only import |
| `service:restart && service:health` self-heal (brief's ops check) | **CANNOT VERIFY** | not in the controller's recorded verification; boundary (e) covers ledger-level restart in-process only |

**Coverage note (not a defect):** parity is tested HTTP→MCP only; no test buys over MCP and replays over HTTP. The kernel is symmetric (fingerprint/binding logic transport-blind, verified) and the brief mandates only the tested direction, but the reverse edge is unpinned.

---

## 6. Assessment

**Ready to merge: NO** — solely on Finding #0, per the user's standing ruling. Missing route-authority in the generator plus first-match runtime resolution means the first new operation anyone ships mis-dispatches on the paid HTTP wire (wrong operation, wrong price) while dispatching correctly over MCP — a wrong-price defect and a parity violation at once. The evidence suite in this range demonstrably knew of the trap (it hand-picked a non-colliding path and said why in a comment) and therefore does not disprove it.

**Everything else in the 11 commits is merge-quality.** The verification review found no wrong-price, double-settlement, or replay defect in the new code. The lifecycle-authority, manifest-authority, fail-closed, and fingerprint invariants all HELD under direct code reading, and the tests assert the money-side facts, not just response shapes. Two genuine pre-existing payment-path bugs (the ILLEGAL_TRANSITION retry wedge; the entitlement expiry off-by-one) were found and fixed with pinned tests inside this range — evidence the authoring session was reviewing its own work seriously even though its artifacts were lost.

**The fix wave must include (user-mandated):**
1. Declared per-operation pathTemplates in `spectral-config/src/generate-all.ts` (replace the ternary).
2. Generation-time failure on duplicate/colliding paths.
3. Artifact regeneration; re-run 129 server tests + 104 config checks + dependency-tree check + no-drift.

**Recommended for the same wave (reviewer additions, in priority order):**
4. Boot-time duplicate/ambiguous relative-path refusal in `bootKernelOnly` (closes the hand-edit+re-seal bypass; defense-in-depth for #0).
5. Finding #1: meter MCP session creation per remote address (initialize is currently free identity-refresh).
6. Finding #3: port the MCP nonce guard to http.ts (unmetered 500 → clean `payment_invalid`).
7. Findings #2, #4, #5 as convenient (ack keying, one MCP paid call for the echo adapter, budget knob plumb-through).
