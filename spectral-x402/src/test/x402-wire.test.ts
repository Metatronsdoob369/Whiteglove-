/**
 * x402-wire.test.ts — the translation seam, asserted against the INSTALLED
 * SDK rather than against a remembered spec.
 *
 * Every "is this the standard shape?" claim here is checked by the SDK's own
 * zod guards (`isPaymentRequirementsV2`, `isPaymentPayloadV2`). A hand-written
 * expected object would only prove we agree with ourselves; the guards are the
 * same code a real facilitator's server surface runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPaymentPayloadV2, isPaymentRequirementsV2 } from "@x402/core/schemas";
import { getDefaultAsset } from "@x402/evm";
import {
  assertMountsTranslatable,
  decodePaymentEnvelope,
  facilitatorReasonCode,
  fromStandardSettle,
  fromStandardSupported,
  fromStandardVerify,
  toStandardRequirements,
  WireTranslationError,
} from "../x402-wire.js";
import type { PaymentRequirements } from "../facilitator.js";

const NETWORK = "eip155:84532";
const PAY_TO = "0x0000000000000000000000000000000000000dev";
const PAYER = "0x1111111111111111111111111111111111111111";
const USDC = getDefaultAsset(NETWORK).address; // 0x036CbD53842c5426634e7929541eC2318f3dCF7e

/** What the kernel hands the boundary, verbatim from the manifest's vocabulary. */
const ours = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: NETWORK,
  asset: "USDC",
  amountAtomic: "500",
  payTo: PAY_TO,
  resource: "/roblox-luau/tile/abc",
  description: "tile_fetch over sealed pack roblox-luau-2026-08",
  maxTimeoutSeconds: 120,
  ...over,
});

const nonce32 = () => `0x${"ab".repeat(32)}`;

/** A standard v2 exact/EIP-3009 envelope, built the way the SDK's client builds one. */
function eip3009Envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    x402Version: 2,
    resource: { url: "/roblox-luau/tile/abc" },
    accepted: toStandardRequirements(ours()),
    payload: {
      signature: `0x${"cd".repeat(65)}`,
      authorization: {
        from: PAYER,
        to: PAY_TO,
        value: "500",
        validAfter: "0",
        validBefore: "1900000000",
        nonce: nonce32(),
      },
    },
    ...over,
  };
}

// ── requirements: ours → the standard's ───────────────────────────────────────

test("wire: our requirements translate to a shape the SDK itself accepts", () => {
  const std = toStandardRequirements(ours());
  assert.equal(isPaymentRequirementsV2(std), true, "the SDK's own guard admits it");

  // The field NAMES are the whole point of this translation.
  assert.equal(std.amount, "500", "our amountAtomic IS the standard's `amount` — same number, new name");
  assert.equal(std.asset, USDC, "our symbolic USDC becomes the ERC-20 contract address");
  assert.equal(std.network, NETWORK, "CAIP-2 passes through unreformatted");
  assert.equal(std.payTo, PAY_TO);
  assert.equal(std.scheme, "exact");
  assert.equal(std.maxTimeoutSeconds, 120);

  // v2 moved these out of requirements entirely; carrying them would be inventing wire.
  assert.equal("amountAtomic" in std, false);
  assert.equal("resource" in std, false);
  assert.equal("description" in std, false);
});

test("wire: requirements carry the EIP-712 domain the SDK's signer refuses to sign without", () => {
  const asset = getDefaultAsset(NETWORK);
  const std = toStandardRequirements(ours());
  assert.equal((std.extra as Record<string, unknown>).name, asset.name);
  assert.equal((std.extra as Record<string, unknown>).version, asset.version);
  assert.equal(asset.decimals, 6, "500 atomic units is 0.0005 USDC — the manifest's own scale");
});

test("wire: an asset already given as a contract address passes through", () => {
  const std = toStandardRequirements(ours({ asset: USDC }));
  assert.equal(std.asset, USDC);
  assert.equal((std.extra as Record<string, unknown>).name, "USDC", "still the default asset, so its domain is known");
});

test("wire: a contract address that is NOT the default asset gets no domain parameters", () => {
  const other = "0x2222222222222222222222222222222222222222";
  const std = toStandardRequirements(ours({ asset: other }));
  assert.equal(std.asset, other);
  assert.deepEqual(std.extra, {}, "domain parameters belong to the token — we do not know this one's");
});

test("wire: an unrecognized asset symbol is refused, never guessed", () => {
  assert.throws(() => toStandardRequirements(ours({ asset: "EURC" })), WireTranslationError);
});

test("wire: a network with no declared default asset is refused", () => {
  assert.throws(() => toStandardRequirements(ours({ network: "eip155:999999" })), WireTranslationError);
});

// ── payments: the standard envelope → the flat fields the kernel fingerprints ──

test("wire: an EIP-3009 envelope yields the kernel's three fingerprint fields from the SIGNATURE", () => {
  const env = eip3009Envelope();
  assert.equal(isPaymentPayloadV2(env), true, "the fixture is a real standard envelope, not our idea of one");

  const decoded = decodePaymentEnvelope(env);
  assert.equal(decoded.kind, "payment");
  if (decoded.kind !== "payment") return;
  const p = decoded.payment;

  // These three are exactly what kernel.authorizationFingerprint() digests.
  assert.equal(p.nonce, nonce32(), "authorization.nonce");
  assert.equal(p.payer, PAYER, "authorization.from");
  assert.equal(p.expiresAt, 1900000000, "authorization.validBefore, as seconds");

  // Also signed, so also readable.
  assert.equal(p.amountAtomic, "500", "authorization.value");
  assert.equal(p.payTo, PAY_TO, "authorization.to");

  // Stated rather than signed: required by the flat type, checked by the facilitator.
  assert.equal(p.scheme, "exact");
  assert.equal(p.network, NETWORK);

  // NOT read: an EIP-3009 authorization never names the token.
  assert.equal(p.asset, undefined);

  assert.equal(p.envelope, env, "the envelope is forwarded by reference, unedited");
});

test("wire: nothing is cross-filled from `accepted` — only the signature is read", () => {
  // `accepted` claims a different recipient and price than the signature does.
  // A boundary that trusted `accepted` would report the challenge's terms back
  // to itself; we report what was signed.
  const env = eip3009Envelope({
    accepted: { ...toStandardRequirements(ours()), payTo: "0x9999999999999999999999999999999999999999", amount: "999999" },
  });
  const decoded = decodePaymentEnvelope(env);
  assert.equal(decoded.kind, "payment");
  if (decoded.kind !== "payment") return;
  assert.equal(decoded.payment.payTo, PAY_TO, "the signed `to`, not the echoed one");
  assert.equal(decoded.payment.amountAtomic, "500", "the signed `value`, not the echoed one");
});

test("wire: a permit2 envelope reads its own authorization shape", () => {
  const env = {
    x402Version: 2,
    accepted: toStandardRequirements(ours()),
    payload: {
      signature: `0x${"ef".repeat(65)}`,
      permit2Authorization: {
        from: PAYER,
        permitted: { token: USDC, amount: "500" },
        spender: "0x3333333333333333333333333333333333333333",
        nonce: "12345678901234567890",
        deadline: "1900000001",
        witness: { to: PAY_TO, validAfter: "0" },
      },
    },
  };
  const decoded = decodePaymentEnvelope(env);
  assert.equal(decoded.kind, "payment");
  if (decoded.kind !== "payment") return;
  assert.equal(decoded.payment.nonce, "12345678901234567890");
  assert.equal(decoded.payment.payer, PAYER);
  assert.equal(decoded.payment.expiresAt, 1900000001, "permit2's deadline is its validBefore");
  assert.equal(decoded.payment.payTo, PAY_TO, "witness.to");
  assert.equal(decoded.payment.amountAtomic, "500", "permitted.amount");
});

test("wire: our legacy flat payload is left alone", () => {
  // The shape the HTTP edge has always carried in X-Payment.
  const flat = {
    scheme: "exact",
    network: NETWORK,
    payer: PAYER,
    nonce: "flat-nonce-1",
    amountAtomic: "500",
    asset: "USDC",
    payTo: PAY_TO,
  };
  assert.equal(decodePaymentEnvelope(flat).kind, "not-an-envelope");
});

test("wire: our flat payload INSIDE an envelope's scheme slot is still legacy", () => {
  // The shape the MCP edge has always accepted: an x402 envelope whose
  // scheme-specific slot holds our own flat payload. Reading it as a standard
  // authorization would refuse a payment that has always worked.
  const wrapped = {
    x402Version: 2,
    accepted: toStandardRequirements(ours()),
    payload: { scheme: "exact", network: NETWORK, payer: PAYER, nonce: "flat-nonce-2", amountAtomic: "500" },
  };
  assert.equal(decodePaymentEnvelope(wrapped).kind, "not-an-envelope");
});

test("wire: an envelope with no readable authorization is a payment fault", () => {
  const decoded = decodePaymentEnvelope(eip3009Envelope({ payload: { signature: "0xdead" } }));
  assert.equal(decoded.kind, "invalid");
  if (decoded.kind !== "invalid") return;
  assert.match(decoded.detail, /no readable authorization/);
});

test("wire: an envelope the SDK's own schema rejects is a payment fault", () => {
  // `accepted` is missing maxTimeoutSeconds — invalid per PaymentPayloadV2Schema.
  const bad = eip3009Envelope({ accepted: { scheme: "exact", network: NETWORK, asset: USDC, amount: "500", payTo: PAY_TO } });
  assert.equal(isPaymentPayloadV2(bad), false);
  const decoded = decodePaymentEnvelope(bad);
  assert.equal(decoded.kind, "invalid");
  if (decoded.kind !== "invalid") return;
  assert.match(decoded.detail, /not a valid x402 v2 payment envelope/);
});

test("wire: an authorization with no nonce is refused — the ledger digests it unconditionally", () => {
  const env = eip3009Envelope({
    payload: { signature: "0xdead", authorization: { from: PAYER, to: PAY_TO, value: "500", validAfter: "0", validBefore: "1900000000" } },
  });
  assert.equal(decodePaymentEnvelope(env).kind, "invalid");
});

test("wire: non-objects and non-envelopes never claim to be payments", () => {
  for (const v of [null, undefined, 42, "x", [], {}, { x402Version: 2 }, { payload: {} }]) {
    assert.equal(decodePaymentEnvelope(v).kind, "not-an-envelope");
  }
});

// ── C1: the flat fields and the forwarded envelope share one source ────────────

test("wire: a valid envelope's flat fields come from the SIGNATURE, not from sibling top-level keys", () => {
  // The object IS a genuine standard envelope AND carries attacker-chosen flat
  // nonce/payer/expiresAt as extra top-level keys. The signed authorization must
  // win: those siblings are what a spoofer would set to make the kernel
  // fingerprint one authorization while a different one settles.
  const env = eip3009Envelope({
    nonce: "ATTACKER-NONCE",
    payer: "0x000000000000000000000000000000000000dEaD",
    expiresAt: 9999999999,
  });
  const decoded = decodePaymentEnvelope(env);
  assert.equal(decoded.kind, "payment");
  if (decoded.kind !== "payment") return;
  assert.equal(decoded.payment.nonce, nonce32(), "the signed nonce, not the sibling");
  assert.equal(decoded.payment.payer, PAYER, "authorization.from, not the sibling payer");
  assert.equal(decoded.payment.expiresAt, 1900000000, "authorization.validBefore, not the sibling");
});

test("wire: a client-supplied `envelope` field on the flat path is refused, never forwarded", () => {
  // The C1 attack: flat fields of the caller's choosing PLUS a genuine signed
  // envelope smuggled in under a reserved key. The kernel would fingerprint the
  // flat nonce/payer while the envelope settled a different authorization. The
  // shared decoder must refuse it rather than admit the split.
  const genuine = eip3009Envelope();
  const attack = {
    scheme: "exact",
    network: NETWORK,
    nonce: "ATTACKER-NONCE",
    payer: "0x000000000000000000000000000000000000dEaD",
    expiresAt: 9999999999,
    envelope: genuine,
  };
  const decoded = decodePaymentEnvelope(attack);
  assert.equal(decoded.kind, "invalid");
  if (decoded.kind !== "invalid") return;
  assert.match(decoded.detail, /reserved `envelope` field/);
});

test("wire: a client-supplied `envelope` inside the MCP scheme slot is refused too", () => {
  // MCP hands the decoder the outer wrapper; the injected field would ride in
  // its `payload`. Both spokes share this refusal.
  const attack = {
    x402Version: 2,
    accepted: toStandardRequirements(ours()),
    payload: { scheme: "exact", network: NETWORK, payer: PAYER, nonce: "flat", envelope: eip3009Envelope() },
  };
  const decoded = decodePaymentEnvelope(attack);
  assert.equal(decoded.kind, "invalid");
  if (decoded.kind !== "invalid") return;
  assert.match(decoded.detail, /reserved `envelope` field/);
});

// ── I3: v1 payment envelopes are refused ───────────────────────────────────────

test("wire: an x402 v1 payment envelope is refused (this seller publishes v2 requirements)", () => {
  const { isPaymentPayloadV1 } = require("@x402/core/schemas") as typeof import("@x402/core/schemas");
  const v1 = {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: `0x${"cd".repeat(65)}`,
      authorization: { from: PAYER, to: PAY_TO, value: "500", validAfter: "0", validBefore: "1900000000", nonce: nonce32() },
    },
  };
  assert.equal(isPaymentPayloadV1(v1), true, "the fixture is a real v1 payload per the SDK guard");
  const decoded = decodePaymentEnvelope(v1);
  assert.equal(decoded.kind, "invalid");
  if (decoded.kind !== "invalid") return;
  assert.match(decoded.detail, /v1 payment envelopes are not supported/);
});

// ── I5: boot-time translatability ──────────────────────────────────────────────

test("wire: assertMountsTranslatable passes for a network/symbol that resolves", () => {
  assert.doesNotThrow(() =>
    assertMountsTranslatable([{ mountId: "roblox-luau", network: NETWORK, asset: "USDC" }])
  );
});

test("wire: assertMountsTranslatable REFUSES a symbol that does not resolve for its network", () => {
  // Base MAINNET's default asset name is "USD Coin", not "USDC" — so a mount
  // declaring asset "USDC" there cannot be put on the wire, and boot must refuse
  // rather than fail every paid call later.
  assert.equal(getDefaultAsset("eip155:8453").name, "USD Coin", "precondition: mainnet USDC is named 'USD Coin'");
  assert.throws(
    () => assertMountsTranslatable([{ mountId: "roblox-luau", network: "eip155:8453", asset: "USDC" }]),
    (e: Error) => /BOOT_REFUSED/.test(e.message) && /roblox-luau/.test(e.message) && /eip155:8453/.test(e.message)
  );
});

// ── responses: the standard's → ours ──────────────────────────────────────────

test("wire: a valid verify carries the facilitator's payer through", () => {
  assert.deepEqual(fromStandardVerify({ isValid: true, payer: PAYER }), { isValid: true, payer: PAYER });
});

test("wire: a facilitator invalidReason is namespaced, never left to alias our vocabulary", () => {
  // The standard's reason vocabulary is not refusals.json, and a bare reason
  // would index statusFor. The `facilitator_` prefix — a token our refusal
  // codes never use — keeps the diagnostic string while forcing statusFor to
  // 402, the honest read of a payment fault.
  const r = fromStandardVerify({ isValid: false, invalidReason: "invalid_exact_evm_payload_authorization_valid_before" });
  assert.equal(r.isValid, false);
  assert.equal(r.reasonCode, "facilitator_invalid_exact_evm_payload_authorization_valid_before");
});

test("wire: a facilitator reason that COLLIDES with a declared code cannot inherit its status", () => {
  // The whole point of I4: a third party returning one of OUR codes must not
  // pick that code's HTTP status/semantics.
  for (const declared of ["rate_limited", "tile_withdrawn", "settlement_rejected", "payment_invalid"]) {
    const code = facilitatorReasonCode(declared);
    assert.equal(code, `facilitator_${declared}`);
    assert.notEqual(code, declared, "the namespaced code is not the declared one");
  }
});

test("wire: facilitator reasons are length- and charset-clamped", () => {
  assert.equal(facilitatorReasonCode("Insufficient Funds!"), "facilitator_insufficient_funds");
  assert.equal(facilitatorReasonCode("   "), "payment_invalid", "an all-whitespace reason is unrenderable");
  assert.equal(facilitatorReasonCode(undefined), "payment_invalid");
  const long = facilitatorReasonCode("x".repeat(500));
  assert.ok(long.length <= "facilitator_".length + 64, "clamped to the max reason length");
});

test("wire: an invalid verify with no reason at all still renders", () => {
  assert.equal(fromStandardVerify({ isValid: false }).reasonCode, "payment_invalid");
});

test("wire: a returned settlement is determinate in BOTH directions", () => {
  const ok = fromStandardSettle(
    { success: true, transaction: "0xfeed", network: NETWORK, payer: PAYER },
    NETWORK
  );
  assert.equal(ok.indeterminate, undefined, "the facilitator SPOKE — nothing to quarantine");
  assert.deepEqual(ok, { success: true, transaction: "0xfeed", network: NETWORK, payer: PAYER });

  const no = fromStandardSettle(
    { success: false, errorReason: "insufficient_funds", transaction: "", network: NETWORK },
    NETWORK
  );
  assert.equal(no.success, false);
  assert.equal(no.errorReason, "insufficient_funds");
  assert.equal(no.indeterminate, undefined, "a stated failure is a rejection, not an unknown");
});

test("wire: an empty transaction string becomes absent, so the ledger stores null", () => {
  const r = fromStandardSettle({ success: true, transaction: "", network: NETWORK }, NETWORK);
  assert.equal(r.transaction, undefined);
  assert.equal(r.network, NETWORK);
});

test("wire: a failed settlement with no reason still names one", () => {
  assert.equal(
    fromStandardSettle({ success: false, transaction: "", network: NETWORK }, NETWORK).errorReason,
    "settlement_rejected"
  );
});

test("wire: /supported flattens the v2 `kinds` list", () => {
  // Recorded from https://x402.org/facilitator/supported (reachable with no API
  // key) on 2026-08-07 — abridged, shape verbatim.
  const supported = fromStandardSupported({
    kinds: [
      { x402Version: 2, scheme: "exact", network: "eip155:84532" },
      { x402Version: 2, scheme: "upto", network: "eip155:84532" },
      { x402Version: 2, scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" },
      // A v1 kind: its network is NOT CAIP-2, which is why the cast is here and
      // why our two-list shape cannot express the pairing.
      { x402Version: 1, scheme: "exact", network: "base-sepolia" as `${string}:${string}` },
    ],
    extensions: ["builder-code"],
    signers: {},
  });
  assert.deepEqual(supported.schemes, ["exact", "upto"], "de-duplicated across kinds");
  assert.deepEqual(supported.networks, ["eip155:84532", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "base-sepolia"]);
});
