# Re-review — fix round 1, `feat/x402-real-settlement` (93c08a8 → 7cf6516)

Verdict scope: the six findings from `settlement-gate-review.md` (one Critical,
five Important) and the fix diff `review-93c08a8..7cf6516.diff` (3 commits, 8
files). Read-only on git state; working tree left on master; branch files read
via `git show 7cf6516:<path>`. `dist/` not rebuilt. Full suite not re-run
(controller's job); every verdict below is established by reading the branch
source, tracing both spokes, and confirming the surrounding unchanged code
(http.ts, mcp.ts, kernel.ts, refusals.json) still routes as the fix requires.

---

## Per-finding verdicts

### C1 (Critical) — envelope/flat-field integrity — **ADDRESSED**

The strip/derive is a **refuse**, and it lives in the ONE shared function both
spokes call, `decodePaymentEnvelope` (`x402-wire.ts:203`). The reserved-field
guard is placed **first**, before any `not-an-envelope` return
(`x402-wire.ts:220-222`):

```ts
if (rec.envelope !== undefined || (isRecord(rec.payload) && rec.payload.envelope !== undefined)) {
  return { kind: "invalid", detail: "payment payload carries a reserved `envelope` field" };
}
```

**Both spokes route through it and refuse `invalid`:**
- HTTP (`http.ts:158-163`): `const wire = decodePaymentEnvelope(decoded); if (wire.kind === "invalid") return send(res, 402, {code:"payment_invalid", detail:wire.detail}); payment = wire.kind === "payment" ? wire.payment : (decoded as PaymentPayload);`
- MCP (`transports/mcp.ts`, the `_meta` payment slot): `const wire = decodePaymentEnvelope(envelope); if (wire.kind === "invalid") return refusalResult("payment_invalid", …, wire.detail);` then `wire.payment` on the envelope branch, `envelope.payload` (nonce-required) on the legacy branch.

Neither edge was changed by this round (both absent from the diff) — the fix
works because the pre-existing edges already treat `kind:"invalid"` as a
`payment_invalid` refusal, which I confirmed by reading both files on the
branch.

**With an envelope present, no client-supplied flat field reaches kernel
fingerprinting.** On the `kind:"payment"` branch (`x402-wire.ts:258-271`),
`payment.nonce/payer/expiresAt` are read from `facts = readEip3009(inner) ??
readPermit2(inner)` — the signed authorization — never from top-level siblings.
`scheme`/`network` come from `accepted`/`rec.scheme` and the facilitator
re-checks them. `inv.payment` = `wire.payment`, so the top-level sibling
`nonce`/`payer`/`expiresAt` are simply never read. The receipt fallback
`payer: s.payer ?? inv.payment.payer ?? null` (`kernel.ts:490`, `:504`) therefore
resolves to the envelope's `authorization.from` when the facilitator omits payer
— exactly what the new `happy-no-payer` end-to-end test asserts
(`standard-facilitator.test.ts`: `receipt.payer === PAYER`, ledger
`authorizations.payer === PAYER`, `receipts success=1` — real behaviour, not
"no throw").

**Did not over-correct.** A genuine v2 envelope carries no top-level `envelope`
and its `payload` (ExactEIP3009/Permit2) has no `envelope` key, so the guard is
false for legitimate traffic. The legacy flat path (no envelope, the
StubFacilitator shape all 137 tests use) still flows: HTTP falls to `decoded as
PaymentPayload`, MCP to `envelope.payload`, with flat `nonce`/`payer` intact —
the guard only fires on a smuggled `envelope` field.

### I2 (Important) — key read before testnet gate — **ADDRESSED**

`loadPayerAccount()` has a single call site, moved to `settlement-gate.ts:665`,
after `fetchChallenge(resource)` (`:649`) and the token/payTo checks. The
network gate lives inside `fetchChallenge` at `:224` (`requirements.network !==
REQUIRED_NETWORK` → refusal, `REQUIRED_NETWORK = "eip155:84532"`). `preflight`
(`:545`) reads no key; the only key reads (`find-generic-password` `:175`,
`PAYER_PRIVATE_KEY` `:180`) are inside `loadPayerAccount`. The Keychain is not
touched until the service is confirmed Base Sepolia. The header/comment/docs
claims are now true.

### I3 (Important) — v1 envelopes — **ADDRESSED**

`decodePaymentEnvelope` refuses `isPaymentPayloadV1(value)` with an explicit
reason (`x402-wire.ts:243-245`: "x402 v1 payment envelopes are not supported…"),
checked **before** the v2 guard (the schemas are mutually exclusive on
`x402Version`). New test proves the fixture is a real v1 payload per the SDK's
own `isPaymentPayloadV1` and that decode returns `invalid`.

### I4 (Important) — facilitator reason namespacing — **ADDRESSED**

`facilitatorReasonCode(raw)` (`x402-wire.ts:295-298`) lowercases, replaces
non-alphanumerics with `_`, trims, clamps to 64 chars, and prefixes
`facilitator_`; empty/whitespace/undefined → `payment_invalid`. It is applied on
**both** the verify paths that feed the wire `code`:
- `fromStandardVerify` (`x402-wire.ts:308-314`), and
- the `VerifyError` (non-2xx-with-body) branch in `facilitator.ts` verify.

The kernel uses the verify `reasonCode` directly as the refused `code`
(`kernel.ts:442`) → `statusFor` → HTTP status; namespacing removes the aliasing.
**No collision surface remains:** `refusals.json` contains no `facilitator_*`
key (grepped — "NONE"), so `facilitator_<anything>` can never index `statusFor`
as our vocabulary; it renders the honest 402. New tests prove `rate_limited`,
`tile_withdrawn`, `settlement_rejected`, `payment_invalid` all become
`facilitator_*` (not 429/451/…), plus charset/length clamp behaviour.

**Settle failure path — no residual defect.** `fromStandardSettle`
(`x402-wire.ts:328-330`) passes the facilitator's `errorReason` through verbatim
on a rejection, BUT the kernel never uses it as the wire `code`: a determinate
rejection returns fixed `code:"settlement_rejected"` (`kernel.ts:517`) and an
indeterminate one fixed `code:"settlement_pending_review"` (`kernel.ts:514`). The
facilitator `errorReason` lands only in `ledger.failSettlement(…)`'s diagnostic
column (`kernel.ts:513`, `:516`), never in `statusFor` and never in the HTTP
response body (the refused render emits only `outcome.code`/`outcome.detail`, and
these outcomes carry no detail). So the settle path was never part of the I4
attack surface — the kernel's fixed codes already close it. (One residual: the
verbatim `errorReason` passthrough in `fromStandardSettle` (`x402-wire.ts:328-330`,
in-scope branch code) is unclamped, and its only sink is the kernel's ledger
diagnostic write. It never indexes `statusFor` and is not the I4 defect; it could
be charset/length-clamped there as future hygiene, mirroring the verify path.)

### I5 (Important) — boot-time translatability — **ADDRESSED**

`assertMountsTranslatable` (`x402-wire.ts:366-388`) runs the real
`toStandardRequirements` over each mount's `(network, asset)` and rethrows a
`WireTranslationError` as `BOOT_REFUSED` naming mount + asset + network. Wired
into `bootKernelOnly` for any non-stub facilitator only
(`server.ts:` boot block: `if (facilitator.id !== "stub")
assertMountsTranslatable([...mounts.values()].map(m => ({mountId, network,
asset})))`), so the stub path (137 tests) skips it and the real
StandardFacilitator boot tests still pass (both shipped mounts are
eip155:84532/USDC, translatable). Unit tests prove pass for 84532/USDC and
`BOOT_REFUSED` for 8453/USDC (with the `getDefaultAsset("eip155:8453").name ===
"USD Coin"` precondition asserted).

### I6 (Important) — key-sweep covers PAYER_PRIVATE_KEY — **ADDRESSED**

`assertNoSpendingKeysInEnv` (`secrets.ts`) now watches `name.startsWith("X402_")
|| WATCHED_NON_PREFIXED_KEY_NAMES.includes(name)` with
`WATCHED_NON_PREFIXED_KEY_NAMES = ["PAYER_PRIVATE_KEY"]`. It is a **name-scoped
deny-list**, not a blanket value scan, so it does not false-positive on unrelated
key-shaped values (new test: `SOME_CONTENT_DIGEST` holding 64-hex does not trip).
A key-shaped `PAYER_PRIVATE_KEY` (or BIP-39 seed) refuses boot; an address or
empty string does not (so the key-less seller still boots on public addresses
only). The refusal message names the variable but never echoes the value. The
gate harness (a separate process) does not call this guard, so it can still read
its own `PAYER_PRIVATE_KEY` fallback — the fail-closed refusal targets the
server's env only, as intended.

---

## New breakage inspection

- **kernel.ts untouched.** `git diff --stat` for `spectral-x402/src/kernel.ts` is
  empty on both `93c08a8..7cf6516` and `master..7cf6516`. The appended
  `kernel.ts --text` section of the review package is empty (file ends at the
  marker). No Critical regression.
- **137 pre-existing tests unmodified.** `git diff --name-status master 7cf6516 --
  spectral-x402/src/test` lists five files, all `A` (added): `x402-wire`,
  `standard-facilitator`, `mcp-envelope-parity`, `exact-payment-client`,
  `payer-key-sweep`. The two files marked `M` in the fix diff
  (`standard-facilitator`, `x402-wire`) are themselves branch-new files (added
  before 93c08a8), not part of the 137. No pre-existing test file
  (`kernel.test.ts`, `mcp-transport.test.ts`, `boundary.test.ts`, …) appears in
  any diff.
- **New tests assert real behaviour**, not just absence of a throw: C1 checks
  `receipt.payer === envelope payer` and the ledger `authorizations` row; the
  injected-`envelope` cases assert `mock.hits.verify === 0` (the split never
  reaches the facilitator) and `receipts === 0`; I4 checks the concrete
  `facilitator_*` code and the 402 (not 429); I3 checks against the SDK's own v1
  guard.
- No other logic files changed beyond the six fix hunks. The fix diff is focused
  and additive; no widening of the kernel-facing interface (only the pre-existing
  optional `PaymentPayload.envelope?`).

No new Critical or Important breakage found.

---

## Round verdict

**All findings addressed, no new Critical/Important breakage.**

C1, I2, I3, I4, I5, I6 are each ADDRESSED with the specific defect eliminated in
branch source; the kernel is untouched, the 137 pre-existing tests are
unmodified, and the new tests pin the corrected behaviour.

**Live settlement proofs — may they run on this code once secrets are
provisioned: YES.** The two review blockers are resolved: I2 (the gate no longer
unseals the payer key before confirming Base Sepolia) and C1 (`receipt.payer` and
the fingerprinted authorization are no longer client-spoofable, so proof #2's
receipt integrity now means what it claims). Standard operational caveats from
the report still apply and do not block the Base Sepolia run: CDP's wire/auth
shape is unprobed; a real facilitator's `invalidReason` vocabulary is untested
against production (now namespaced regardless); x402.org settlement latency vs the
SDK's 30s default is a quarantine-by-design risk. Provisioning steps in the
report §7 stand. The `dist/` posture note (§6) also stands: any `npm test` on
this branch rebuilds `dist/` from branch source, so if the live service must keep
running master-built code, restore `dist/` to master after any branch test run
(or merge the branch to make it moot).
