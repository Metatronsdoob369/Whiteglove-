/**
 * exact-payment-client.test.ts — the round trip, end to end, with no secrets.
 *
 * A payment built by the SDK's OWN client (`x402Client` + `ExactEvmScheme` + a
 * viem local account) against OUR translated requirements must be an envelope
 * our edge reads back into the exact fields the kernel fingerprints. Every other
 * test in this repo either builds the envelope by hand or checks one half of
 * that path; this one closes it.
 *
 * The key here is generated in-process and thrown away. It signs an EIP-3009
 * authorization — a local signature over typed data, no chain, no transaction,
 * no funds — which is precisely what a payer does before anyone settles.
 * Nothing is submitted anywhere.
 *
 * This is the same construction `scripts/settlement-gate.ts` performs against
 * the live service, so a break here is a break there, caught without
 * provisioning.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { x402Client } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { isPaymentPayloadV2 } from "@x402/core/schemas";
import { ExactEvmScheme, getDefaultAsset } from "@x402/evm";
import { decodePaymentEnvelope, toStandardRequirements } from "../x402-wire.js";
import type { PaymentRequirements } from "../facilitator.js";

const NETWORK = "eip155:84532";
const PAY_TO = "0x00000000000000000000000000000000000000ff";

/** Exactly what the kernel's `requirementsFor` produces for a tile_fetch. */
const OURS: PaymentRequirements = {
  scheme: "exact",
  network: NETWORK,
  asset: "USDC",
  amountAtomic: "500",
  payTo: PAY_TO,
  resource: "/roblox-luau/tile/b2-256:abc",
  description: "tile_fetch over sealed pack roblox-luau-2026-08",
  maxTimeoutSeconds: 120,
};

test("client: a payment the SDK builds against our requirements decodes to the kernel's fields", async () => {
  // viem 2.x is ESM-only and this package is CommonJS — the same dynamic import
  // the settlement-gate harness uses.
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(generatePrivateKey());

  const standard = toStandardRequirements(OURS);
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    error: "payment_required",
    resource: { url: OURS.resource, description: OURS.description },
    accepts: [standard],
  };

  const client = x402Client.fromConfig({
    schemes: [{ network: standard.network, client: new ExactEvmScheme(account) }],
  });
  // If `extra.{name,version}` were missing from our translation, this line would
  // throw — the SDK's EIP-3009 signer refuses to sign an unknown domain.
  const envelope = await client.createPaymentPayload(paymentRequired);

  assert.equal(isPaymentPayloadV2(envelope), true, "a conforming client produced a conforming envelope");
  assert.equal(envelope.x402Version, 2);
  assert.deepEqual(envelope.accepted, standard, "the client echoes the requirements we published");

  const authorization = (envelope.payload as { authorization: Record<string, string> }).authorization;
  assert.ok(authorization, "the exact scheme on EVM signs an EIP-3009 transferWithAuthorization");
  assert.equal(authorization.value, "500", "the client signed for the manifest's atomic price");
  assert.equal(authorization.to.toLowerCase(), PAY_TO.toLowerCase());
  assert.match((envelope.payload as { signature: string }).signature, /^0x[0-9a-f]{130}$/i);

  // The signature is over the TOKEN's domain — the contract our translation
  // resolved, not the symbol the manifest declares.
  assert.equal(standard.asset, getDefaultAsset(NETWORK).address);

  // And our edge reads it back into what the kernel fingerprints.
  const decoded = decodePaymentEnvelope(envelope);
  assert.equal(decoded.kind, "payment");
  if (decoded.kind !== "payment") return;
  assert.equal(decoded.payment.nonce, authorization.nonce);
  assert.equal(decoded.payment.payer?.toLowerCase(), account.address.toLowerCase());
  assert.equal(decoded.payment.expiresAt, Number(authorization.validBefore));
  assert.equal(decoded.payment.amountAtomic, "500");
  assert.equal(decoded.payment.payTo?.toLowerCase(), PAY_TO.toLowerCase());
  assert.equal(decoded.payment.scheme, "exact");
  assert.equal(decoded.payment.network, NETWORK);
  assert.equal(decoded.payment.envelope, envelope, "forwarded to the facilitator by reference, unedited");

  // The authorization expires by the requirement's own maxTimeoutSeconds.
  const now = Math.floor(Date.now() / 1000);
  assert.ok(
    decoded.payment.expiresAt! > now && decoded.payment.expiresAt! <= now + OURS.maxTimeoutSeconds + 5,
    `validBefore ${decoded.payment.expiresAt} should be within maxTimeoutSeconds of now (${now})`
  );
});

test("client: two payments never share a nonce", async () => {
  // The kernel's authorizationFingerprint digests the nonce; a client that
  // reused one would make two distinct authorizations look like one.
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(generatePrivateKey());
  const standard = toStandardRequirements(OURS);
  const client = x402Client.fromConfig({
    schemes: [{ network: standard.network, client: new ExactEvmScheme(account) }],
  });
  const required: PaymentRequired = {
    x402Version: 2,
    resource: { url: OURS.resource },
    accepts: [standard],
  };
  const a = await client.createPaymentPayload(required);
  const b = await client.createPaymentPayload(required);
  const nonceOf = (e: typeof a) => (e.payload as { authorization: { nonce: string } }).authorization.nonce;
  assert.notEqual(nonceOf(a), nonceOf(b));
});
