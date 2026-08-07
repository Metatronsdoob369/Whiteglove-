/**
 * facilitator.ts — the payment boundary.
 *
 * The kernel talks to a FacilitatorClient and nothing else. The real one
 * speaks to a hosted x402 facilitator; the stub is programmable so the full
 * local-simulation evidence list runs with no chain and no money.
 *
 * `succeed-then-drop-response` is the important stub mode: it produces a
 * genuine settlement whose outcome we never learn — the only honest way to
 * manufacture `settlement_unknown` and prove we quarantine instead of
 * blindly resubmitting.
 *
 * The shapes below are OURS: the manifest's vocabulary, flat, with a symbolic
 * asset and `amountAtomic`. They are what the kernel and both transports speak.
 * Translating them to the standard x402 v2 wire happens in exactly one place —
 * `StandardFacilitator`, via x402-wire.ts — so the manifest stays authoritative
 * and the kernel never learns what a contract address is.
 */
import { HTTPFacilitatorClient } from "@x402/core/http";
import { FacilitatorTimeoutError, SettleError, VerifyError } from "@x402/core/types";
import type { PaymentPayload as StandardPaymentPayload } from "@x402/core/types";
import { fromStandardSettle, fromStandardSupported, fromStandardVerify, toStandardRequirements } from "./x402-wire.js";

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  asset: string;
  amountAtomic: string;
  payTo: string;
  resource: string;
  description: string;
  maxTimeoutSeconds: number;
}

export interface PaymentPayload {
  scheme: string;
  network: string;
  payer?: string;
  nonce: string;
  expiresAt?: number;
  amountAtomic?: string;
  asset?: string;
  payTo?: string;
  signature?: string;
  /**
   * The standard x402 v2 payment envelope EXACTLY as the client sent it, when
   * the client sent one. Opaque here on purpose: this boundary forwards it to
   * the facilitator unmodified, and a boundary that edited a signed envelope
   * would be altering the thing the signature covers.
   *
   * The flat fields above are then a READ of that envelope's signed
   * authorization (see x402-wire.ts), not a second, independent claim — which
   * is what lets the kernel keep fingerprinting `nonce` / `payer` / `expiresAt`
   * without knowing any of this exists.
   */
  envelope?: unknown;
}

export interface VerifyResult {
  isValid: boolean;
  reasonCode?: string;
  payer?: string;
}

export interface SettleResult {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
  /** true when the outcome is genuinely unknown (timeout / lost response). */
  indeterminate?: boolean;
}

export interface FacilitatorClient {
  readonly id: string;
  getSupported(): Promise<{ schemes: string[]; networks: string[] }>;
  verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResult>;
  settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResult>;
}

export type StubMode =
  | "valid"
  | "invalid"
  | "expired"
  | "underpaid"
  | "wrong-asset"
  | "wrong-network"
  | "wrong-recipient"
  | "settle-reject"
  | "settle-timeout"
  | "succeed-then-drop-response";

export class StubFacilitator implements FacilitatorClient {
  readonly id = "stub";
  mode: StubMode = "valid";
  verifyCalls = 0;
  settleCalls = 0;

  constructor(mode: StubMode = "valid") {
    this.mode = mode;
  }

  async getSupported() {
    return { schemes: ["exact"], networks: ["eip155:84532"] };
  }

  async verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResult> {
    this.verifyCalls++;
    switch (this.mode) {
      case "invalid":
        return { isValid: false, reasonCode: "payment_invalid" };
      case "expired":
        return { isValid: false, reasonCode: "payment_expired" };
      case "underpaid":
        return { isValid: false, reasonCode: "payment_underpaid" };
      case "wrong-asset":
        return { isValid: false, reasonCode: "payment_wrong_asset" };
      case "wrong-network":
        return { isValid: false, reasonCode: "payment_wrong_network" };
      case "wrong-recipient":
        return { isValid: false, reasonCode: "payment_wrong_recipient" };
      default:
        break;
    }
    // Even in a "valid" run the terms are checked — the stub substitutes the
    // facilitator, it does not fake the protocol.
    if (p.scheme !== r.scheme) return { isValid: false, reasonCode: "payment_invalid" };
    if (p.network !== r.network) return { isValid: false, reasonCode: "payment_wrong_network" };
    if (p.asset && p.asset !== r.asset) return { isValid: false, reasonCode: "payment_wrong_asset" };
    if (p.payTo && p.payTo !== r.payTo) return { isValid: false, reasonCode: "payment_wrong_recipient" };
    if (p.amountAtomic && BigInt(p.amountAtomic) < BigInt(r.amountAtomic)) {
      return { isValid: false, reasonCode: "payment_underpaid" };
    }
    if (p.expiresAt !== undefined && p.expiresAt * 1000 < Date.now()) {
      return { isValid: false, reasonCode: "payment_expired" };
    }
    return { isValid: true, payer: p.payer ?? "0xstubpayer" };
  }

  async settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResult> {
    this.settleCalls++;
    if (this.mode === "settle-reject") {
      return { success: false, errorReason: "insufficient_funds" };
    }
    if (this.mode === "settle-timeout" || this.mode === "succeed-then-drop-response") {
      // The money may or may not have moved. We do not know, and saying
      // otherwise would be a lie the ledger then treats as truth.
      return { success: false, indeterminate: true, errorReason: "facilitator_timeout" };
    }
    return {
      success: true,
      transaction: `0xstub${Buffer.from(p.nonce).toString("hex").slice(0, 56)}`,
      network: r.network,
      payer: p.payer ?? "0xstubpayer",
    };
  }
}

/**
 * A real, standard-conforming x402 v2 facilitator. Same interface — swapping it
 * changes nothing above.
 *
 * The HTTP calls themselves are the SDK's `HTTPFacilitatorClient`: it owns the
 * wire (POST `/verify`, POST `/settle` with
 * `{ x402Version, paymentPayload, paymentRequirements }`; GET `/supported`), the
 * per-request deadline, and zod validation of every response. Hand-rolling that
 * again is how our shapes drifted from the standard's in the first place.
 *
 * This class owns exactly the translation: our requirements out (x402-wire.ts),
 * the standard's answers back in, and — the part that must not move — the
 * settlement outcome trichotomy:
 *
 *   settled          ← a returned success
 *   rejected         ← a returned failure (the facilitator SPOKE)
 *   INDETERMINATE    ← anything else: timeout, refused connection, unparseable
 *                      body, non-2xx. The money may or may not have moved, and
 *                      the ledger quarantines rather than resubmit.
 *
 * That last line is the invariant the whole ledger rests on, so the catch around
 * the settle call has exactly one behaviour: `indeterminate: true`. The two
 * pre-flight guards ahead of it are determinate on purpose — no request left the
 * process, so there is nothing unknown to hold open.
 */
export class StandardFacilitator implements FacilitatorClient {
  readonly id: string;
  private readonly client: HTTPFacilitatorClient;

  constructor(baseUrl: string, apiKey?: string, id = "http", timeoutMs?: number) {
    this.client = new HTTPFacilitatorClient({
      url: baseUrl,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      // The SDK requires auth headers keyed BY PATH and throws on a flat
      // object — returning one would silently drop auth on every request.
      ...(apiKey
        ? {
            createAuthHeaders: async () => {
              const headers = { Authorization: `Bearer ${apiKey}` };
              return { verify: headers, settle: headers, supported: headers };
            },
          }
        : {}),
    });
    this.id = id;
  }

  async getSupported() {
    return fromStandardSupported(await this.client.getSupported());
  }

  async verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResult> {
    // A real facilitator cannot read our flat shape, and sending it one would
    // get a shrug we might misread as approval. No envelope, no verification.
    if (!payload.envelope) return { isValid: false, reasonCode: "payment_invalid" };
    let standard;
    try {
      standard = toStandardRequirements(req);
    } catch {
      // Our own requirement is untranslatable. That is a capability fault on
      // our side, not a fault in the caller's payment.
      return { isValid: false, reasonCode: "capability_unavailable" };
    }
    try {
      return fromStandardVerify(await this.client.verify(payload.envelope as StandardPaymentPayload, standard));
    } catch (e) {
      // A non-2xx that still carried a verify body is a real answer.
      if (e instanceof VerifyError) {
        return {
          isValid: false,
          reasonCode: e.invalidReason && e.invalidReason !== "" ? e.invalidReason : "payment_invalid",
          ...(e.payer ? { payer: e.payer } : {}),
        };
      }
      // Anything else means we never learned whether the payment is good.
      // Nothing has settled, so refusing is safe and the call stays retryable.
      return { isValid: false, reasonCode: "capability_unavailable" };
    }
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResult> {
    // Both guards below are DETERMINATE failures: no request left this process,
    // so no money can have moved and quarantine would be a lie in the other
    // direction — it would hold a call open against a settlement that never was.
    if (!payload.envelope) return { success: false, errorReason: "payment_invalid" };
    let standard;
    try {
      standard = toStandardRequirements(req);
    } catch {
      return { success: false, errorReason: "requirements_untranslatable" };
    }
    try {
      return fromStandardSettle(
        await this.client.settle(payload.envelope as StandardPaymentPayload, standard),
        req.network
      );
    } catch (e) {
      // The sacred case. A network failure is NOT a settlement failure, and a
      // timeout least of all: the SDK's own docs note the facilitator may have
      // completed the settlement. Indeterminate ⇒ quarantine.
      return { success: false, indeterminate: true, errorReason: indeterminateReason(e) };
    }
  }
}

/**
 * Why we do not know. Three stable, greppable values — this string is written
 * into `quarantine.reason_code`, where a human reads it later.
 */
function indeterminateReason(e: unknown): string {
  if (e instanceof FacilitatorTimeoutError) return "facilitator_timeout";
  if (e instanceof SettleError) return "facilitator_settle_error";
  return "facilitator_unreachable";
}
