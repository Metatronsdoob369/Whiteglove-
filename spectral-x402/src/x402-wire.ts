/**
 * x402-wire.ts — the ONE place our shapes become the standard x402 v2 wire.
 *
 * Two vocabularies meet here and neither may leak into the other:
 *
 *   - OURS (facilitator.ts): a flat `PaymentRequirements` / `PaymentPayload`
 *     with `amountAtomic`, a SYMBOLIC asset ("USDC"), `resource` and
 *     `description`. The manifest is its author and the kernel fingerprints
 *     three of its fields. Nothing in this file may change what they mean.
 *
 *   - THE STANDARD's (@x402/core 2.21): `PaymentRequirements` is
 *     `{ scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra }` —
 *     `asset` is an ERC-20 CONTRACT ADDRESS, the price field is `amount`, and
 *     there is no `resource`/`description` at all (resource moved up into the
 *     `PaymentRequired` envelope in v2). A payment is
 *     `{ x402Version, resource?, accepted, payload }`, where `payload` is the
 *     scheme's own slot — for `exact` on EVM, an EIP-3009
 *     `transferWithAuthorization` envelope.
 *
 * Every field name above was read out of the INSTALLED types
 * (node_modules/@x402/core/dist/cjs/x402Client-*.d.ts and
 * @x402/evm's index.d.ts), not out of a spec summary. The SDK is the authority.
 *
 * The translation is deliberately one-directional and total: a requirement we
 * cannot translate THROWS rather than being sent half-formed to a facilitator
 * that would then settle against terms we did not mean.
 */
import { getDefaultAsset } from "@x402/evm";
import { isPaymentPayloadV1, isPaymentPayloadV2 } from "@x402/core/schemas";
import type {
  Network,
  PaymentPayload as StandardPaymentPayload,
  PaymentRequirements as StandardPaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { PaymentPayload, PaymentRequirements, SettleResult, VerifyResult } from "./facilitator.js";

/** Public EVM address, same shape secrets.ts admits for a payTo. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * A requirement that cannot be expressed on the standard wire. Thrown, never
 * swallowed into a partial translation: the caller decides whether that is a
 * boot refusal or a verify refusal, and both are safer than a guess.
 */
export class WireTranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireTranslationError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Our symbolic asset + CAIP-2 network → the standard wire's contract address
 * and the EIP-712 domain parameters the client needs to SIGN against it.
 *
 * `extra.name` / `extra.version` are not decoration: @x402/evm's
 * `signEIP3009Authorization` REFUSES to sign without them (they must match the
 * token's own domain separator), so a requirement that omitted them would
 * produce a challenge no conforming client could answer.
 *
 * The mapping is only ever made in the direction symbol → address, and only
 * when the network's own declared default stablecoin carries that symbol. An
 * unrecognized symbol is a refusal, not a lookup we improvise: guessing a
 * contract address is guessing where money goes.
 */
export function toStandardRequirements(req: PaymentRequirements): StandardPaymentRequirements {
  let defaultAsset: ReturnType<typeof getDefaultAsset>;
  try {
    defaultAsset = getDefaultAsset(req.network as Network);
  } catch {
    throw new WireTranslationError(
      `network "${req.network}" has no default asset in @x402/evm — declare the asset as a contract address, ` +
        `or add the network upstream. Refusing to invent one.`
    );
  }

  const declared = req.asset.trim();
  let asset: string;
  if (ADDRESS_RE.test(declared)) {
    asset = declared;
  } else if (declared.toUpperCase() === defaultAsset.name.toUpperCase()) {
    asset = defaultAsset.address;
  } else {
    throw new WireTranslationError(
      `asset "${req.asset}" is not the declared default asset for ${req.network} ` +
        `("${defaultAsset.name}") and is not a contract address. Refusing to guess a token contract.`
    );
  }

  // Domain parameters belong to the TOKEN, so they are only honest when the
  // asset we resolved is in fact that token. A manifest naming some other
  // contract gets an empty `extra`, and the client's own signer refuses —
  // loudly, at signing time, instead of signing the wrong domain.
  const isDefaultAsset = asset.toLowerCase() === defaultAsset.address.toLowerCase();
  const extra: Record<string, unknown> = isDefaultAsset
    ? {
        name: defaultAsset.name,
        version: defaultAsset.version,
        ...(defaultAsset.assetTransferMethod !== undefined
          ? { assetTransferMethod: defaultAsset.assetTransferMethod }
          : {}),
        ...(defaultAsset.supportsEip2612 !== undefined ? { supportsEip2612: defaultAsset.supportsEip2612 } : {}),
      }
    : {};

  return {
    scheme: req.scheme,
    // The manifest already publishes CAIP-2 ("eip155:84532"); the SDK's type is
    // the narrower template form. A cast, because reformatting a manifest value
    // on its way out would make this file its editor.
    network: req.network as Network,
    asset,
    // OUR `amountAtomic` IS the standard's `amount` — atomic units of the
    // asset, 6 decimals for USDC. Same number, different field name; nothing is
    // scaled here.
    amount: req.amountAtomic,
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    extra,
  };
}

/** What the kernel needs lifted out of a signed authorization. */
interface SignedFacts {
  nonce: string;
  payer: string;
  expiresAt?: number;
  amountAtomic?: string;
  payTo?: string;
}

function readEip3009(payload: Record<string, unknown>): SignedFacts | null {
  const auth = payload.authorization;
  if (!isRecord(auth)) return null;
  if (typeof auth.nonce !== "string" || auth.nonce === "") return null;
  if (typeof auth.from !== "string") return null;
  const validBefore = Number(auth.validBefore);
  return {
    nonce: auth.nonce,
    payer: auth.from,
    ...(Number.isFinite(validBefore) ? { expiresAt: validBefore } : {}),
    ...(typeof auth.value === "string" ? { amountAtomic: auth.value } : {}),
    ...(typeof auth.to === "string" ? { payTo: auth.to } : {}),
  };
}

function readPermit2(payload: Record<string, unknown>): SignedFacts | null {
  const auth = payload.permit2Authorization;
  if (!isRecord(auth)) return null;
  if (typeof auth.nonce !== "string" || auth.nonce === "") return null;
  if (typeof auth.from !== "string") return null;
  const deadline = Number(auth.deadline);
  const permitted = isRecord(auth.permitted) ? auth.permitted : undefined;
  const witness = isRecord(auth.witness) ? auth.witness : undefined;
  return {
    nonce: auth.nonce,
    payer: auth.from,
    ...(Number.isFinite(deadline) ? { expiresAt: deadline } : {}),
    ...(permitted && typeof permitted.amount === "string" ? { amountAtomic: permitted.amount } : {}),
    ...(witness && typeof witness.to === "string" ? { payTo: witness.to } : {}),
  };
}

export type EnvelopeDecode =
  /** Not a standard envelope — the caller's own legacy handling applies, unchanged. */
  | { kind: "not-an-envelope" }
  /** A standard envelope whose signed authorization we read. */
  | { kind: "payment"; payment: PaymentPayload }
  /** Recognizably an envelope, but nothing signable in it. A payment fault. */
  | { kind: "invalid"; detail: string };

/**
 * Reads a standard x402 payment envelope into the FLAT payload the kernel
 * fingerprints, carrying the envelope itself along untouched.
 *
 * The flat fields come from the SIGNED authorization and nowhere else —
 * `authorization.nonce` / `.from` / `.validBefore`, plus `.value` / `.to`
 * (permit2: `permit2Authorization.nonce` / `.from` / `.deadline`,
 * `permitted.amount`, `witness.to`). That distinction is the whole point:
 * those values are what the payer put their signature over, so reading them is
 * reading the signature. Nothing is copied out of `accepted`, which is only
 * our own challenge echoed back — filling terms from it would manufacture the
 * agreement the facilitator exists to check.
 *
 * `asset` is deliberately left unset: an EIP-3009 authorization never names
 * the token (it lives in the EIP-712 domain's `verifyingContract`), and an
 * asset we did not read from the signature would be exactly that manufactured
 * agreement.
 *
 * An envelope whose `payload` already carries a flat `nonce` is OUR OWN
 * scheme slot (the shape the MCP edge has always accepted), not a standard
 * authorization — it is reported as `not-an-envelope` so the legacy path keeps
 * handling it byte-for-byte as before.
 */
export function decodePaymentEnvelope(value: unknown): EnvelopeDecode {
  if (!isRecord(value)) return { kind: "not-an-envelope" };
  // Held separately because the SDK's guards narrow `value` to one version's
  // shape, and the two versions carry scheme/network in different places.
  const rec: Record<string, unknown> = value;
  if (!("x402Version" in rec) || !isRecord(rec.payload)) return { kind: "not-an-envelope" };
  const inner = rec.payload;
  if (typeof inner.nonce === "string") return { kind: "not-an-envelope" };

  // Shape validation is the SDK's, not ours — these are the same guards the
  // standard's own server surface uses.
  const isV2 = isPaymentPayloadV2(value);
  const isV1 = !isV2 && isPaymentPayloadV1(value);
  if (!isV2 && !isV1) {
    return { kind: "invalid", detail: "not a valid x402 payment envelope" };
  }

  const facts = readEip3009(inner) ?? readPermit2(inner);
  if (!facts) {
    return { kind: "invalid", detail: "payment envelope carries no readable authorization" };
  }

  const accepted = isRecord(rec.accepted) ? rec.accepted : undefined;
  const scheme = (typeof accepted?.scheme === "string" ? accepted.scheme : undefined) ??
    (typeof rec.scheme === "string" ? rec.scheme : undefined);
  const network = (typeof accepted?.network === "string" ? accepted.network : undefined) ??
    (typeof rec.network === "string" ? rec.network : undefined);
  if (scheme === undefined || network === undefined) {
    return { kind: "invalid", detail: "payment envelope names no scheme/network" };
  }

  return {
    kind: "payment",
    payment: {
      // Which scheme and network this payment is FOR — the only two fields the
      // envelope states rather than signs, and both are required by the flat
      // type. The facilitator still checks them against our requirements.
      scheme,
      network,
      nonce: facts.nonce,
      payer: facts.payer,
      ...(facts.expiresAt !== undefined ? { expiresAt: facts.expiresAt } : {}),
      ...(facts.amountAtomic !== undefined ? { amountAtomic: facts.amountAtomic } : {}),
      ...(facts.payTo !== undefined ? { payTo: facts.payTo } : {}),
      envelope: rec as unknown as StandardPaymentPayload,
    },
  };
}

/**
 * The standard verify response as ours.
 *
 * `invalidReason` is passed through VERBATIM. The standard's reason vocabulary
 * is not our refusals table and pretending otherwise would put a translated
 * word in a facilitator's mouth; `statusFor` already documents this exact case
 * (an undeclared code from a facilitator renders 402). Only a MISSING reason is
 * substituted, because a refusal with no code at all is unrenderable.
 */
export function fromStandardVerify(res: VerifyResponse): VerifyResult {
  if (res.isValid) return { isValid: true, ...(res.payer ? { payer: res.payer } : {}) };
  return {
    isValid: false,
    reasonCode: res.invalidReason && res.invalidReason !== "" ? res.invalidReason : "payment_invalid",
    ...(res.payer ? { payer: res.payer } : {}),
  };
}

/**
 * The standard settle response as ours.
 *
 * A RETURNED response is a determinate answer either way — the facilitator
 * spoke. `indeterminate` is never set here; it belongs to the call that never
 * came back, which is the caller's catch block.
 *
 * The standard types `transaction` as a required string, so a settlement with
 * no chain transaction carries `""`. That is mapped to absent, because the
 * ledger's column means "no transaction" by being null, not by being empty.
 */
export function fromStandardSettle(res: SettleResponse, fallbackNetwork: string): SettleResult {
  if (!res.success) {
    return { success: false, errorReason: res.errorReason && res.errorReason !== "" ? res.errorReason : "settlement_rejected" };
  }
  return {
    success: true,
    ...(res.transaction && res.transaction !== "" ? { transaction: res.transaction } : {}),
    network: res.network ? res.network : fallbackNetwork,
    ...(res.payer ? { payer: res.payer } : {}),
  };
}

/**
 * The standard `/supported` response as the two lists our boundary publishes.
 *
 * v2 publishes `kinds` — one entry per (x402Version, scheme, network) triple —
 * so scheme and network are flattened and de-duplicated. The pairing is lost in
 * that flattening, which is what our own two-list shape has always meant.
 */
export function fromStandardSupported(res: SupportedResponse): { schemes: string[]; networks: string[] } {
  const schemes = new Set<string>();
  const networks = new Set<string>();
  for (const k of res.kinds ?? []) {
    if (k.scheme) schemes.add(k.scheme);
    if (k.network) networks.add(k.network);
  }
  return { schemes: [...schemes], networks: [...networks] };
}
