/**
 * payment-id.ts — x402 payment-identifier validation constants.
 *
 * VENDORED, DELIBERATELY. Source of truth:
 *
 *     @x402/extensions@2.21.0  →  ./payment-identifier
 *     PAYMENT_ID_MIN_LENGTH = 16
 *     PAYMENT_ID_MAX_LENGTH = 128
 *
 * Why vendored rather than imported: the official package pulls eight
 * transitive dependencies — jose, siwe, viem, tweetnacl, ajv, @noble/curves,
 * @scure/base — onto the process that settles payments, taking this package
 * from 59 to 113 modules. We issue no JWTs, do no Ethereum sign-in, and send
 * no transactions (the seller is key-less), so none of that code is exercised.
 * Three numbers and a character class do not justify that surface.
 *
 * THE HARD LINE: only *validation constants* are vendored here. Cryptographic
 * verification, scheme logic, and settlement behavior are NEVER vendored —
 * they stay in the official packages or behind the FacilitatorClient boundary.
 * If you find yourself adding a signature check to this file, stop.
 *
 * Drift is visible upgrade work, not silent divergence: payment-id.test.ts
 * pins every constant below and cites the version above. When upstream moves,
 * that test is the tripwire and the fix is a scheduled task.
 */

/** Minimum admissible paymentId length, per @x402/extensions@2.21.0. */
export const PAYMENT_ID_MIN_LENGTH = 16;

/** Maximum admissible paymentId length, per @x402/extensions@2.21.0. */
export const PAYMENT_ID_MAX_LENGTH = 128;

/** Admissible character class: URL-safe base64 alphabet without padding. */
export const PAYMENT_ID_CHARS = "A-Za-z0-9_-";

/**
 * Anchored pattern for a well-formed paymentId.
 *
 * Emitted verbatim into the generated OpenAPI and MCP tool schemas, so a
 * client reading our published contract and a caller hitting our endpoint are
 * held to exactly the same rule.
 */
export const PAYMENT_ID_PATTERN_SOURCE = `^[${PAYMENT_ID_CHARS}]{${PAYMENT_ID_MIN_LENGTH},${PAYMENT_ID_MAX_LENGTH}}$`;

export const PAYMENT_ID_PATTERN = new RegExp(PAYMENT_ID_PATTERN_SOURCE);

/**
 * True when `value` is a well-formed paymentId.
 *
 * Length and character class only. This says nothing about whether the id is
 * bound, paid, or entitled — those are ledger questions, answered by the
 * kernel's binding lookup.
 */
export function isValidPaymentId(value: unknown): value is string {
  return typeof value === "string" && PAYMENT_ID_PATTERN.test(value);
}
