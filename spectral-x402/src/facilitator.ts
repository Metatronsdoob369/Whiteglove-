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
 */

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

/** Real facilitator over HTTP. Same interface — swapping it changes nothing above. */
export class HttpFacilitator implements FacilitatorClient {
  readonly id: string;
  constructor(
    private baseUrl: string,
    private apiKey?: string,
    id = "http"
  ) {
    this.id = id;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`facilitator ${path} → ${res.status}`);
    return res.json();
  }

  async getSupported() {
    const r = (await (await fetch(`${this.baseUrl}/supported`)).json()) as { schemes: string[]; networks: string[] };
    return r;
  }

  async verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResult> {
    return (await this.post("/verify", { paymentPayload: payload, paymentRequirements: req })) as VerifyResult;
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResult> {
    try {
      return (await this.post("/settle", { paymentPayload: payload, paymentRequirements: req })) as SettleResult;
    } catch {
      // A network failure is NOT a settlement failure. Indeterminate ⇒ quarantine.
      return { success: false, indeterminate: true, errorReason: "facilitator_unreachable" };
    }
  }
}
