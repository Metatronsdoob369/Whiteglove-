# Review — real-settlement gate, `feat/x402-real-settlement` (25ced37..93c08a8)

Reviewed against the branch as checked out (`93c08a8`), the review package
`review-25ced37..93c08a8.diff` read in full, the implementer's
`settlement-gate-report.md`, and the **installed** `@x402/core@2.21.0` /
`@x402/evm@2.21.0` type declarations in `node_modules`.

Verification performed beyond reading:

- compiled the whole branch (`tsc -p tsconfig.gate.json`) to a **scratch**
  `outDir` so `dist/` — the tree the live service runs from — was never
  rewritten. Clean compile, no diagnostics.
- ran **all four new test files** from that scratch build: **38/38 pass**
  (`x402-wire` 22, `standard-facilitator` 11, `mcp-envelope-parity` 3,
  `exact-payment-client` 2). The boot-based files needed `manifests/` and
  `packs/` symlinked into the scratch tree, since they resolve those relative to
  `__dirname` (`standard-facilitator.test.ts:28-29`); with the real `dist/`
  layout that resolution is correct. Every test creates its ledger under
  `mkdtempSync(tmpdir())`, so nothing touched the live `ledger.db`.
- ran a targeted probe against the compiled `decodePaymentEnvelope` to settle the
  envelope-normalization question empirically (see Critical C1).
- executed `getDefaultAsset` for `eip155:84532` **and** `eip155:8453`, and dumped
  `DEFAULT_STABLECOINS` (see Important I4).
- read the SDK's own `HTTPFacilitatorClient.settle` implementation to confirm it
  does not retry internally.
- `npm ls @x402/core viem`; `git diff --name-only` scoped to `src/test/`,
  `manifests/`, `spectral-config/`.

`npm test` was deliberately **not** run: on this branch it invokes `tsc`, which
rebuilds `dist/` from branch source and re-opens exactly the exposure the
implementer flags in their §6. Everything below was established without doing
that.

---

## Spec Compliance

### The five proofs

| # | Proof | Verdict | Evidence |
|---|---|---|---|
| 1 | Genuine settlement: tx hash + matching chain evidence (USDC `Transfer` payer→payTo, exact amount) | ✅ | `scripts/settlement-gate.ts:693` (32-byte hash regex), `:696` → `transferEvidenceFor` at `:350-377` (receipt `status === "success"`, log filtered on **both** token address `:356` and `Transfer` topic `:357`, `decodeEventLog` `:358`), then `:697` from == payer, `:700` to == payTo, `:706` value === `amountAtomic` exact string compare. `assertNotStubSettled` `:612-620` catches a running process still holding the stub. |
| 2 | Receipt fields match payer/recipient/asset/amount/network | ✅ | `:736-753` — checked against the challenge **and** against the chain (`:748-752`). See M6 for the one tautological line. |
| 3 | Replay returns identical bytes with NO second transaction | ✅ | `:772-799` — sha256 **and** byte length `:777`, `x-replayed` header `:780`, `eth_getLogs` transfer count unchanged `:783-789`, plus ledger `settlementAttempts === 1` `:791` and `receipts === 1` `:797`. "No second transaction" is a fact about the chain, not only about our ledger. |
| 4 | Failed capability execution (unknown cid) never settles | ✅ | `:817-842` — well-formed-but-impossible cid `:74`, expects `404 tile_not_found`, asserts no receipt `:828`, chain transfers unchanged `:829`, ledger `settlementAttempts === 0` `:837`. |
| 5 | Two-phase restart-preserves-entitlement | ✅ | `phase1` writes `Phase1State` `:861-877`; `phase2` `:896-986` re-reads it, so the proof does not depend on the phase-1 process surviving. Compares tx-hash **sets** at `:941`, not counts. |

**Buildable/verifiable without secrets** — ✅. `standard-facilitator.test.ts`
boots the real kernel/ledger/HTTP edge against a local standard-v2 facilitator
reached over real HTTP by the SDK's own client, so the assertions are about the
bytes that arrived. `exact-payment-client.test.ts` signs with an ephemeral
generated key. Six no-provisioning harness refusal paths are documented and
were exercised by the implementer.

### Binding constraints

| Constraint | Verdict | Evidence |
|---|---|---|
| `src/kernel.ts` absent from the diff | ✅ | Not in `git diff --stat 25ced37..93c08a8`. The appended `kernel.ts --text` section at the package tail (`review-…diff` final line) is **empty** — the file ends at the marker. |
| Kernel-facing `FacilitatorClient` interface unchanged | ✅ | `src/facilitator.ts` — `FacilitatorClient`, `VerifyResult`, `SettleResult`, `PaymentRequirements` all byte-identical in the diff. `PaymentPayload` gained one **optional** field, `envelope?: unknown`; additive and optional, so no kernel call site changes. |
| Kernel lifecycle untouched | ✅ | No `kernel.ts` change; `server.ts` delta is the class rename plus a comment. |
| Flat `nonce`/`payer`/`expiresAt` keep their fingerprinting meaning; the HTTP edge normalizes envelopes into them (wire decode edge-owned) | ❌ | The decode *is* edge-owned (`http.ts:158`, `transports/mcp.ts:390`) and shared between the spokes. But the invariant the code states for itself — the flat fields are a *read* of the signed authorization, "not a second, independent claim" (`facilitator.ts:46-56`, the `envelope?` doc comment) — is **not enforced**. See Critical C1. |
| Indeterminate-on-network-failure is sacred | ✅ | `facilitator.ts` `settle` catch has exactly one behaviour: `{ success: false, indeterminate: true, errorReason: indeterminateReason(e) }`. `indeterminateReason` only *names* why (three stable greppable strings). Verified the SDK does **not** resubmit: `node_modules/@x402/core/dist/cjs/http/index.js:1152-1190` has no retry loop — only `getSupported` retries (`:1232-1249`). The two pre-flight guards ahead of the call are determinate, correctly: no request left the process. |
| Seller stays key-less; no `X402_*`-named key-shaped values | ✅ (with ⚠️ I5) | No key in server env or code. `.env.example` **removes** the old `export X402_TEST_PAYER_PRIVATE_KEY` advice. Harness reads Keychain `x402-payer-key`, falls back to `PAYER_PRIVATE_KEY` (`settlement-gate.ts:172-199`); never printed, never written to evidence. Letter of the constraint met — but `secrets.ts:91-104` only sweeps names starting `X402_`, so the documented fallback name is invisible to the guard (I5). |
| Harness refuses any network other than `eip155:84532` | ⚠️ | The gate itself is correct and unconditional (`:224-229`, also applied to the absent-cid challenge at `:819`). But it does **not** run before the key is touched, contrary to the claim at `:29-30`, the comment at `:223`, and `docs/SETTLEMENT-PROVISIONING.md:90-91`. See Important I1. |
| Legacy flat payments + `StubFacilitator` keep working | ✅ | `StubFacilitator` untouched in the diff. Legacy flat path preserved on both spokes (`http.ts:162`, `mcp.ts:404-412`). |
| All 137 pre-existing tests UNMODIFIED | ✅ | `git diff --name-only 25ced37..93c08a8 -- src/test/` returns **only** the four new files. `kernel.test.ts`, `transport-seam.test.ts`, `evidence.test.ts`, `agnostic.test.ts`, `adapter-registry.test.ts`, `http-routing.test.ts`, `route-authority.test.ts` all absent. 38 new tests counted statically (22 + 11 + 3 + 2) and **all 38 executed green here**, matching the claimed 137 → 175. |
| Manifests untouched | ✅ | No `manifests/` or `spectral-config/` path in the diff. |
| `spectral-config check:all` green | ⚠️ unverified | Not run here (separate package, and the diff touches nothing it consumes). Consistent with the diff; taken on the implementer's word. |
| `@x402/core` single deduped; `viem` devDependency; one-line lockfile delta | ✅ | `npm ls`: `@x402/core@2.21.0` once, `deduped` under evm/mcp; `viem@2.55.11` once, `deduped` with `@x402/evm`'s copy. Lockfile hunk is exactly the root `devDependencies` block (1 deletion, 2 insertions) — no package entered the tree. |

---

## Strengths

- **One translation module, and it throws rather than half-translating.**
  `x402-wire.ts:73-128`. An asset that is neither the network's declared default
  symbol nor a contract address raises `WireTranslationError` instead of being
  guessed. "Guessing a contract address is guessing where money goes" is the
  right instinct and the code follows it.
- **`extra: {}` for a non-default contract** (`x402-wire.ts:97-111`). Rather than
  attach a domain that belongs to a *different* token, the translation attaches
  nothing, so the client's own signer refuses loudly at signing time. That is a
  materially better failure than a signature over the wrong EIP-712 domain.
- **The envelope is forwarded byte-for-byte** and nothing is cross-filled from
  `accepted` (`x402-wire.ts:179-249`); a test pins signature-over-`accepted`
  precedence with a fixture whose `accepted` deliberately disagrees.
- **The settle trichotomy is implemented as one behaviour, not three branches.**
  Any throw ⇒ `indeterminate: true`. The reason string is metadata for a human
  reading `quarantine.reason_code`, never control flow.
- **The verify/settle asymmetry on a non-2xx-with-parseable-body is reasoned, not
  sloppy.** `VerifyError` is definitive (nothing settled, so a refusal is safe
  and retry stays open); `SettleError` is indeterminate (money may have moved).
  Implementer concern #3 is the correct call in the safe direction.
- **`id` stays `"http"`** through the class rename (`server.ts`), so renaming a
  class does not rename `facilitator_id` rows in a live ledger. Small, and
  exactly the kind of thing that usually gets missed.
- **`tsconfig.gate.json` + gitignored `dist-gate/`** keeps the gate from
  rewriting the `dist/` the live service runs from — a deviation from the brief's
  build layout that is *more* correct than the brief.
- **Chain evidence is real evidence.** Decoded `Transfer` (from/to/value/token) +
  `eth_getLogs`, not `status: success` and a shrug.
- **The harness and the server share one `toStandardRequirements`** — so the
  harness structurally cannot prove a payment the server never asked for.
- **The report and docs are unusually honest.** The non-standard 402 challenge on
  both edges, the point-in-time `dist/` restore, the unprobed CDP wire, and the
  untested `apiKey` branch are all disclosed rather than papered over. Concerns
  #1–#6 are real concerns, correctly identified.
- **Evidence output is structurally address-only.** `context` is an explicit
  literal built in `phase1`/`phase2` (`:666-679`, `:912-922`), never an env dump;
  the facilitator URL is query-redacted (`:131-138`); and `ProvisioningMissing` —
  the only error class whose text touches key provisioning — writes **no** report
  (`:1048-1052`).

---

## Issues

### Critical

**C1 — A client-supplied `envelope` on the legacy flat path decouples the
fingerprinted authorization from the one that actually settles.**

*Where:* `src/x402-wire.ts:202-209` (the not-an-envelope sniff) →
`src/http.ts:162` and `src/transports/mcp.ts:412` (raw passthrough) →
`src/facilitator.ts:211` `verify` / `:240` `settle` (which forward
`payload.envelope` at `:214` / `:244`).

*What.* `decodePaymentEnvelope` classifies anything without a top-level
`x402Version`, or whose inner `payload` carries a string `nonce`, as
`not-an-envelope`. Both edges then use the **raw decoded object** as the
`PaymentPayload`:

```ts
// http.ts:162
payment = wire.kind === "payment" ? wire.payment : (decoded as PaymentPayload);
// transports/mcp.ts:412
payment = inner as PaymentPayload;
```

Nothing strips or rejects an `envelope` property the client put there. So a
caller can send flat fields of their choosing **and** a genuine signed envelope
in the same object. Confirmed empirically against the compiled module:

```
decode kind: not-an-envelope
payment.nonce  (fingerprinted): ATTACKER-CHOSEN-NONCE
payment.payer  (fingerprinted): 0x…dEaD
payment.expiresAt (fingerprinted): 9999999999
payment.envelope present (forwarded to facilitator): true
envelope's REAL signed nonce: 0xdeadbeef
envelope's REAL signed from : 0xREALPAYER
```

*Why it matters.* `kernel.ts:263`
`authorizationFingerprint(requestFp, p) = digest(requestFp, p.nonce, p.expiresAt, p.payer)`
is documented as "**WHICH** authorization paid" and is written into
`settlement_attempts.authorization_fingerprint` (`kernel.ts:419`,
`ledger.ts:541-565`) and into the receipt row (`kernel.ts:498`).
`recordAuthorization` (`kernel.ts:419-424`) likewise persists `payer`,
`digestHex(nonce)` and `expiresAt` from the same spoofable fields — as does the
`authCount > 3` "too many distinct authorizations" cap. And the receipt itself:

```ts
// kernel.ts:490 (receipt JSON), mirrored at :504 (receipt row)
payer: s.payer ?? inv.payment.payer ?? null,
```

`SettleResponse.payer` is **optional** in the SDK type
(`x402Client-CzZlbbXy.d.ts:1302`), so against any facilitator that omits it the
receipt names a client-chosen address. Proof #2 of this very mandate is a
receipt-integrity proof; that field is spoofable.

*Bounding the blast radius honestly:* funds cannot be misrouted. The facilitator
validates the envelope's authorization against **our** translated requirements
(`payTo`, `amount`, `asset`, `network`), so the money still moves in the right
amount to the right address, and the on-chain EIP-3009 nonce still blocks
double-spend. `beginSettlement` dedupes on the call's `state='executed'` guard,
not on `authFp`, so this is not a double-settle. This is an **audit-trail and
receipt-attribution** break, not a funds break — but the ledger's answer to
"which authorization paid" becomes client-controlled, and that is the record the
evidence reports and any future dispute rest on.

*Fix (small, and cannot disturb the 137).* Refuse a client-supplied `envelope`
on the non-envelope path, in the one place both spokes share. In
`decodePaymentEnvelope`, before returning `not-an-envelope`:

```ts
if (rec.envelope !== undefined || (isRecord(rec.payload) && rec.payload.envelope !== undefined)) {
  return { kind: "invalid", detail: "payment payload carries a reserved envelope field" };
}
```

Both branches are needed because HTTP hands this function the flat payload while
MCP hands it the outer wrapper whose `payload` becomes the flat one. Stripping
instead of refusing is also acceptable and slightly more conservative. Verified
no pre-existing test sends such a field — the only other `envelope` mentions in
untouched tests are comments and a `{ not: "an envelope" }` fixture
(`mcp-transport.test.ts:68,724,730`; `boundary.test.ts:345`) — so the 137 stay
green either way. Also verified that **no new test covers this case**: nothing in
`x402-wire.test.ts` or `mcp-envelope-parity.test.ts` sends a flat payload
carrying an `envelope` field, which is why 38/38 green does not catch it.

---

### Important

**I2 — The harness reads the payer key *before* the testnet gate runs.**

*Where:* `scripts/settlement-gate.ts:626` vs the gate at `:224`.

```
624 async function phase1() {
625   const pre = await preflight();
626   const account = await loadPayerAccount();   ← Keychain read, key in memory
…
647   const challenge = await fetchChallenge(resource);   ← TESTNET GATE lives here
```

The file's own header claims "The run refuses to sign anything unless the
challenge's own network is eip155:84532" and, more strongly, `:223` says
"**TESTNET GATE. Before a key is touched**, before anything is signed", echoed by
`docs/SETTLEMENT-PROVISIONING.md:90-91` ("refuses before touching a key").
Nothing is *signed* on a wrong network — signing happens at `:683`, after the
gate — but the key **is** unsealed from the Keychain and materialized into a
viem account against a service that might be pointed at mainnet.

*Fix:* move `loadPayerAccount()` to after `fetchChallenge(resource)`. The account
is not needed until `assertFunded` at `:661`, so the reorder is three lines and
makes the documented property true.

**I3 — v1 payment envelopes are accepted at the edge, but the facilitator request
pairs `x402Version: 1` with v2-shaped requirements.**

*Where:* `x402-wire.ts:213-217` accepts `isPaymentPayloadV1`; `toStandardRequirements`
only ever emits the v2 shape (`amount`, no `maxAmountRequired`); the SDK sends
`x402Version: paymentPayload.x402Version`
(`node_modules/@x402/core/dist/cjs/http/index.js:1166`).

A v1-paying client therefore causes a request that announces protocol version 1
while carrying requirements in which the v1 price field
(`PaymentRequirementsV1.maxAmountRequired`) is **absent**. Best case the
facilitator rejects it opaquely; a lenient facilitator reading v1 fields sees no
declared maximum. This path has no test — the only `x402Version: 1` in
`x402-wire.test.ts` is a `/supported` *kind* fixture at `:298`, not a payload
decode.

*Fix:* refuse v1 envelopes at the edge (we publish only v2 requirements, so we
cannot honestly serve a v1 payment), or translate requirements to the v1 shape
when the envelope is v1. Refusing is the smaller and safer change.

**I4 — `invalidReason` pass-through can *collide* with a declared refusal code,
not merely render 402.**

*Where:* `x402-wire.ts:264` and the `VerifyError` branch in `facilitator.ts` →
`kernel.ts` (`code: v.reasonCode`) → `http.ts:64-80` `statusFor`.

This is implementer concern #2, and the answer is a degree worse than the report
states. `statusFor` renders an **undeclared** code as 402 — correct. But a
facilitator string that *matches* a key in `refusals.json` takes that entry's
status: `rate_limited` → 429, `tile_withdrawn` → 451, `settlement_rejected` →
whatever the table says. So a third party chooses our HTTP status and the `code`
a client's retry logic branches on. The string is additionally written unbounded
and unsanitized into the ledger's transition reason and echoed verbatim into the
response body.

*Fix:* keep the verbatim intent but make it unmistakably foreign — clamp length
and charset, and refuse (or namespace) any value that collides with a key in
`opts.refusals`. `facilitator:<reason>` would preserve the information, keep
`statusFor` at 402, and remove the aliasing entirely.

**I5 — Symbol→address resolution keys on the SDK's *display name*, and there is
no boot-time translatability check.**

*Where:* `x402-wire.ts:88`
`declared.toUpperCase() === defaultAsset.name.toUpperCase()`.

`DEFAULT_STABLECOINS` carries no `symbol` field, only `name` — so `name` is the
only handle available, but it is not a ticker. Executed against the installed
package:

```
eip155:84532 → { …, name: "USDC",     version: "2", decimals: 6 }
eip155:8453  → { …, name: "USD Coin", version: "2", decimals: 6 }
```

`eip155:137`, `:42161`, `:143` are also `"USD Coin"`. A manifest declaring
`asset: "USDC"` on any of those networks **boots cleanly** and then fails every
paid call — `verify` returns `capability_unavailable` (503) and `settle` returns
`requirements_untranslatable`. Fail-closed, which is the right direction, but
discovered at the first customer request rather than at startup. Base Sepolia
happens to say `"USDC"`, so the branch under review is unaffected; mainnet day is
where this bites.

*Fix:* at boot, when a `StandardFacilitator` is configured, run
`toStandardRequirements` over every mount/operation's requirements and refuse to
start on `WireTranslationError`. That is the same posture as the already-merged
"refuse an unresolvable route table at boot" (`5055116`), and it converts a
runtime 503 into a startup refusal an operator sees immediately.

**I6 — `PAYER_PRIVATE_KEY` sits outside the boot sweep's namespace.**

*Where:* `secrets.ts:91-104` (`if (!name.startsWith("X402_")) continue;`) vs the
harness's documented fallback at `settlement-gate.ts:180` and in `.env.example`.

The non-`X402_*` name is a deliberate and correct choice — the point was not to
teach operators to export a key into the namespace the guard protects. But the
consequence is that the guard is *blind* to the one variable name this work
introduces, so an operator who exports `PAYER_PRIVATE_KEY` in the shell that
launches the service gets a paying key in the seller's process and boot says
nothing.

*Fix:* add the exact documented name(s) to the sweep as a small deny-list
alongside the `X402_*` prefix rule. Cheap, precise, no false-positive risk.

---

### Minor

**M1 — `timeoutMs` is unreachable in production.** `facilitator.ts`'s
`StandardFacilitator` constructor takes a 4th `timeoutMs` parameter; `server.ts`
never passes it, so the service always runs on the SDK's 30 s default and the
only caller is `standard-facilitator.test.ts:234`, which reaches in via a
private-field cast. The report itself flags settlement latency vs 30 s as an
open risk, and the knob to manage it exists but is not wired.
*Fix:* read `X402_FACILITATOR_TIMEOUT_MS` in `bootKernelOnly`.

**M2 — `fromStandardSupported` loses the (scheme, network) pairing.**
`x402-wire.ts:299-307` flattens `kinds` into two independent sets, so a
facilitator supporting `{exact, eip155:1}` and `{upto, eip155:84532}` yields
lists that "contain" `exact` and `eip155:84532` while supporting neither
together. Harmless **today** — `getSupported` has no caller outside the
interface declaration and tests (`facilitator.ts:77,104,207`) — but it is a trap
laid for whoever adds a boot-time capability check.
*Fix:* return the pairs, or make the lossiness impossible to consume by accident.

**M3 — Phase-1's "no second transfer" compares log *counts* over
`toBlock: "latest"`.** `settlement-gate.ts:386-400`, used at `:774`, `:783`,
`:829`. An unrelated concurrent payer→payTo transfer, or an RPC that advances
between the two calls, false-fails the proof. Safe direction, but it makes the
gate flaky if the payer address is ever reused.
*Fix:* compare tx-hash **sets**, as phase 2 already does at `:941`.

**M4 — the `GATE ERROR` catch-all prints a full stack.**
`settlement-gate.ts:1053`. Every *expected* failure is a typed error that prints
no stack, and the key is regex-validated at `:191` before it reaches viem, so
this is narrow — but it is the one path where an unexpected library error could
surface a value the process holds.
*Fix:* print `e.message` plus a `cause`-free stack, or scrub.

**M5 — `toStandardRequirements` does not validate `amountAtomic`'s shape.**
`x402-wire.ts:123` passes the manifest value straight into `amount`. The
manifest is generated and authoritative so this is defense-in-depth only, but
`amount` is the single field a wrong value moves money on. A
`/^[0-9]+$/` assertion costs one line. **No unit-conversion bug exists** —
`decimals` is never read, `amountAtomic` *is* the standard's `amount` in atomic
units, and the harness compares the chain's `Transfer` value to it as an exact
decimal string (`:706`). There is no factor-of-10^x anywhere on the path.

**M6 — proof 2's asset line is a tautology.** `settlement-gate.ts:741` compares
`receipt.asset` to `challenge.requirements.asset` — both the symbol `"USDC"`.
The real asset binding is proved elsewhere (contract-address assertion at `:649`,
and the token-address filter inside `transferEvidenceFor` at `:356`), and `:761`
labels the symbolic value honestly, so this is presentation rather than a hole.
Worth folding the contract-address comparison into proof 2 so the proof stands
alone.

---

## SDK-delta verification

Each of the implementer's five claimed deltas, checked against the installed
declarations — `node_modules/@x402/core/dist/cjs/x402Client-CzZlbbXy.d.ts` and
`node_modules/@x402/evm/dist/cjs/`.

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | The v2 price field is **`amount`**, not `maxAmountRequired` (which is v1) | **CONFIRMED** | `x402Client-CzZlbbXy.d.ts:1256-1264`: v2 `PaymentRequirements = { scheme, network, asset, amount: string, payTo, maxTimeoutSeconds, extra }`. `maxAmountRequired` appears **only** in `PaymentRequirementsV1` (`:1-13`). The session's earlier `progress.md` note was indeed wrong for 2.21. |
| 2 | v2 requirements carry **no `resource`, no `description`**; `resource` moved up into `PaymentRequired` as a `ResourceInfo` object | **CONFIRMED** | `:1256-1264` has neither field. `interface ResourceInfo { url; description?; mimeType?; serviceName?; tags?; iconUrl? }` at `:1248-1255`, and `PaymentRequired = { x402Version, error?, resource: ResourceInfo, accepts, extensions? }` at `:1265-1271`. The task brief's listing of `resource` as a requirements field to translate was wrong. |
| 3 | **`extra.{name, version}` are mandatory for signing** — `@x402/evm` throws without them | **CONFIRMED** | `@x402/evm/dist/cjs/index.js:530` and `:1474` throw ``EIP-712 domain parameters (name, version) are required in payment requirements for asset ${…}`` and only then destructure `const { name, version } = requirements.extra`. A translation omitting `extra` would produce a challenge no conforming client could answer. The implementer is right that this is the most load-bearing finding of their recon. |
| 4 | v2 `PaymentPayload` has **no top-level scheme/network** — they live inside `accepted`; the brief described the v1 shape | **CONFIRMED** | v2: `PaymentPayload = { x402Version, resource?, accepted: PaymentRequirements, payload, extensions? }` (`:1272-1278`). v1: `PaymentPayloadV1 = { x402Version: 1, scheme, network, payload }` (`:19-23`). |
| 5 | `SupportedResponse` is **`{ kinds, extensions, signers }`**, not `{ schemes, networks }` | **CONFIRMED** | `SupportedKind = { x402Version, scheme, network, extra? }`, `SupportedResponse = { kinds: SupportedKind[]; extensions: string[]; signers: Record<string, string[]> }` (`:1310-1320`). The old `HttpFacilitator`'s assumption was wrong. |

Corroborated alongside them:

- `SettleResponse` (`:1298`) types `transaction: string` (`:1303`) and
  `network: Network` (`:1304`) as **required** — so `fromStandardSettle`'s
  `""` → absent mapping is correct, and its `res.network ? … : fallbackNetwork`
  is harmless belt-and-braces.
- `SettleResponse.payer?` (`:1302`) is **optional** — which is what makes C1's
  receipt attribution reachable.
- `VerifyResponse.invalidReason?: string` is free text, not an enum (`:1285-1292`)
  — which is what makes I4 reachable.
- `createAuthHeaders?: () => Promise<{ verify?; settle?; supported?; bazaar? }>`
  (`:91-96`) — keyed by path exactly as the report says, and the doc comment at
  `:85-89` is verbatim the shape `StandardFacilitator` returns.
- `getDefaultAsset("eip155:84532")` → `{ 0x036CbD53842c5426634e7929541eC2318f3dCF7e,
  "USDC", "2", 6 }` — executed, matches the report.
- `HTTPFacilitatorClient.settle` performs **no** internal retry
  (`http/index.js:1152-1190`); only `getSupported` retries (`:1232-1249`). The
  "never a resubmit" invariant is safe at the SDK layer too.

**One delta the implementer did not report**, found here:
`getDefaultAsset("eip155:8453")` returns `name: "USD Coin"`, and
`DEFAULT_STABLECOINS` has no `symbol` field at all. That is the substance of I5.

---

## Named-risk checks — direct answers

1. **Can a crafted envelope make the flat fields disagree with what the
   facilitator verifies? Can an attacker bind a paymentId to one authorization
   and settle a different one?** — **Yes**, via the legacy passthrough with an
   injected `envelope` key. Confirmed empirically. Not through the *envelope*
   path, which reads only the signed authorization and never `accepted` — that
   part is right. C1.
2. **Does the requirements translation preserve amount semantics exactly?** —
   **Yes.** `amount: req.amountAtomic` with no scaling; `decimals` is never read;
   the harness compares the on-chain `Transfer` value to the manifest price as an
   exact decimal string. No 10^x error exists. (M5 is hygiene only.)
3. **What does an arbitrary `invalidReason` do to `statusFor` and the wire?** —
   Undeclared strings render 402 as the report says, **but** a string colliding
   with a declared refusal code inherits that code's status and semantics. I4.
4. **Do the harness's chain checks verify the Transfer log, or just tx
   existence?** — They verify the **log**: receipt status, token address, Transfer
   topic, and decoded `from`/`to`/`value`, plus an `eth_getLogs` sweep filtered on
   `Transfer(payer → payTo)` for the no-second-settlement claim. Genuine.
5. **Was envelope normalization applied at the MCP edge, consistently?** —
   **Yes**, by sharing `decodePaymentEnvelope` rather than reimplementing it
   (`transports/mcp.ts:390-412`), and MCP keeps its pre-existing nonce guard on
   the legacy branch. Parity is real — including parity in the C1 defect.
6. **Is the evidence dir committable and structurally incapable of holding
   secrets?** — Yes to both, as far as the code can make it: `context` is an
   explicit literal, facilitator URLs are query-redacted, `ProvisioningMissing`
   writes no report, and the payer **address** is the only identity recorded.
   `.gitignore` adds only `dist-gate/`, so `evidence/` stays committable. The one
   residual path is M4's stack print, which goes to stderr and not to a file.

---

## Assessment

**Task quality: Needs fixes.**

The engineering judgement on display is genuinely good — the translation module,
the fail-closed asset resolution, the empty-`extra` refusal, the single-behaviour
settle catch, the `id: "http"` preservation, the `dist-gate/` deviation, and the
honesty of the report and docs are all above the bar. All five claimed SDK
deltas are **CONFIRMED** against the installed `.d.ts`, and the implementer was
right to resolve them in favour of the SDK; the recon was careful and the one
thing they missed (`"USD Coin"`) cuts in the same direction they were already
reasoning.

What holds it back is that the branch's own central invariant — *the flat fields
are a read of the signed authorization, not a second claim* — is written down in
a comment and not enforced in code. That is C1, it is reachable from an
unauthenticated request on either spoke, and the fix is a five-line guard in the
one function both spokes already share.

**May the live proofs run on this code once provisioned: yes, after I2.**

- **I2 first** (three-line reorder). The gate is the artifact being trusted here,
  and its own advertised safety property — refuses before touching a key — is
  not what the code does. Fix it before the Keychain entry exists, not after.
- **C1 before the receipts are treated as authoritative, and before the port
  leaves loopback.** It does *not* invalidate the five proofs: the harness sends
  only well-formed standard envelopes, so the evidence a passing run produces is
  genuine, and funds cannot be misrouted in any case. But the gate exists to
  produce receipts that mean something a month later, and shipping it with a
  client-spoofable `receipt.payer` undercuts the point of proof #2. It is a small
  fix that cannot disturb the 137 — there is no good reason to defer it past the
  first run.
- **I3, I4, I5, I6 do not block the Base Sepolia proofs.** I5 is a mainnet-day
  landmine and should land before any mainnet gate discussion; I4 should land
  before a third-party facilitator whose reason vocabulary we do not control is
  pointed at production.
- Minors are all optional, though M3 is worth taking before the first run purely
  so a flake does not get mistaken for a failure.

One thing that surprised me, worth recording: the *envelope* path is the careful
one and the *legacy* path is where the hole is. Every comment in `x402-wire.ts`
is about not manufacturing agreement from `accepted` — and the code honours that
scrupulously — while the unexamined `decoded as PaymentPayload` cast two files
away quietly re-admits exactly the class of claim those comments exist to
refuse.
