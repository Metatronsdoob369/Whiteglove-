/**
 * kernel.ts — the mount orchestrator.
 *
 * Owns: fingerprints, paymentId binding, leases, execution, result and
 * receipt persistence, quarantine, replay, delivery gating.
 * Does NOT own: challenge construction semantics, verification, settlement —
 * those belong to the facilitator boundary.
 *
 * The whole admission order runs BEFORE any facilitator call, because every
 * input to requestFingerprint comes from the request plus the generated
 * manifest — never from a payment payload. That is what makes 409 / 202 /
 * replay / 410 pre-payment decisions.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Ledger, type CallState } from "./ledger.js";
import { RateLimiter, type RateLimitPolicy } from "./limiter.js";
import { Substrate } from "./substrate.js";
import {
  isValidPaymentId,
  PAYMENT_ID_PATTERN_SOURCE,
  PAYMENT_ID_MIN_LENGTH,
  PAYMENT_ID_MAX_LENGTH,
} from "./payment-id.js";
import type { FacilitatorClient, PaymentPayload, PaymentRequirements } from "./facilitator.js";
import { defineAdapter, AdapterMiss, type Adapter, type AdapterRegistry } from "./adapter.js";

export interface MountOperation {
  operationId: string;
  resultKind: "pack-bytes" | "manifest-json" | "proof-json";
  deadlineMs: number;
  maxResultBytes: number;
  priceAtomic: string;
  /**
   * Edge metadata, riding on the operation same as `network` / `asset` /
   * `payTo` ride on the mount — the manifest's own `method` and
   * `pathTemplate` (e.g. "GET", "/roblox-luau/tile/{cid}"), carried through
   * so an HTTP transport can derive routing and discovery from the manifest
   * instead of hardcoding its own copy of the verb/shape convention. The
   * kernel itself never reads either field.
   */
  method: string;
  pathTemplate: string;
}

export interface Mount {
  mountId: string;
  capabilityVersion: string;
  adapterVersion: string;
  edition: string;
  operations: Map<string, MountOperation>;
  substrate: Substrate;
  network: string;
  asset: string;
  payTo: string;
  challengeEpoch: string;
  fingerprintVersion: string;
  retryEntitlementSeconds: number;
  limits: { maxPricePerCallAtomic: bigint; dailySettledValueCeilingAtomic: bigint };
}

export type Transport = "http" | "mcp";

/**
 * One paid invocation, normalized — whatever spoke it arrived on.
 *
 * Each transport decodes only its own wire (HTTP path and headers, MCP `_meta`
 * and tool arguments) into this shape and owns nothing downstream of it.
 *
 * `clientKey` is the rate-limit identity the transport supplies (socket
 * address, MCP session id) so ONE kernel-side limiter meters every spoke,
 * rather than per-transport bucket sets a caller could alternate between.
 */
export interface PaidInvocation {
  mountId: string;
  operationId: string;
  args: Record<string, string>;
  paymentId?: string;
  payment?: PaymentPayload;
  transport: Transport;
  clientKey: string;
  /** What was bought, as the caller named it. Echoed into requirements. */
  resource: string;
}

/**
 * No HTTP status lives here, deliberately.
 *
 * A status is a *rendering* of `kind` + `code`, and rendering belongs to
 * whichever transport is doing it — MCP has no 404. A status decided in the
 * kernel is how HTTP coupling creeps back in, so the edge derives it instead
 * (see `statusFor` in http.ts, driven by the generated refusals table).
 */
export type KernelOutcome =
  | { kind: "challenge"; requirements: PaymentRequirements; challengeEpoch: string; code: string }
  | { kind: "refused"; code: string; callId?: string; detail?: string }
  | { kind: "accepted"; code: string; callId: string }
  | {
      kind: "delivered";
      callId: string;
      bytes: Buffer;
      contentType: string;
      receipt: Record<string, unknown>;
      entitlementExpiresAt: number;
      replayed: boolean;
    };

/**
 * Content address of a tile — the same pattern the generated OpenAPI and MCP
 * tool schemas publish. Until the generator emits argument schemas into
 * x402-routes.json (the kernel's own sealed input), this is the enforcement
 * copy of a published rule; see payment-id.ts for the same arrangement.
 */
const CID_PATTERN = /^b2-256:[0-9a-f]{64}$/;

const cidArgSchema = z.object({ cid: z.string().regex(CID_PATTERN, "malformed cid") }).strict();
const noArgSchema = z.object({}).strict();

/**
 * The three capabilities this kernel has always shipped, now declared through
 * the same `defineAdapter` a Task 7 external author uses — no privileged
 * shortcut. Their argSchema is the strict-object replacement for the old
 * OPERATION_ARGS map: same validation position (after operation resolution,
 * before fingerprinting, in `handle()`), same `args_invalid` refusal code.
 *
 * These stay defined here, in kernel.ts, rather than in adapter.ts: their
 * `AdapterMiss` literals are load-bearing text that
 * `transport-seam.test.ts`'s `kernelEmittedCodes()` regex-scans out of THIS
 * file to prove every code the kernel can emit is declared in refusals.json.
 * Moving the bodies would silently blind that guard.
 */
const tileFetchAdapter = defineAdapter({
  operationId: "tile_fetch",
  argSchema: cidArgSchema,
  // Smallest maxResultBytes any mount currently declares for tile_fetch — an
  // adapter's declaration must not exceed what EVERY mount using it allows.
  maxResultBytes: 65536,
  declaredReplaySafe: true,
  handler: (args, ctx) => {
    const bytes = ctx.substrate.getTile(args.cid);
    if (!bytes) throw new AdapterMiss("tile_not_found");
    // Verbatim. The kernel never parses a payload — it moves opaque bytes
    // that are named by their own hash. Whatever the pack declares it
    // carries (JSON, parquet, PNG, raw f32 vectors) ships unexamined.
    return { bytes: Buffer.from(bytes), contentType: ctx.substrate.payloadContentType };
  },
});

const packInclusionProofAdapter = defineAdapter({
  operationId: "pack_inclusion_proof",
  argSchema: cidArgSchema,
  maxResultBytes: 16384,
  declaredReplaySafe: true,
  handler: (args, ctx) => {
    const proof = ctx.substrate.getInclusionProof(args.cid);
    if (!proof) throw new AdapterMiss("tile_not_found");
    return { bytes: Buffer.from(JSON.stringify(proof)), contentType: "application/json" };
  },
});

const packManifestAdapter = defineAdapter({
  operationId: "pack_manifest",
  argSchema: noArgSchema,
  maxResultBytes: 2097152,
  declaredReplaySafe: true,
  handler: (_args, ctx) => {
    return { bytes: Buffer.from(JSON.stringify(ctx.substrate.getManifest())), contentType: "application/json" };
  },
});

/** The default registration `bootKernelOnly()` / `boot()` use when `adapters` is omitted. */
export const BUILTIN_ADAPTERS: Adapter[] = [tileFetchAdapter, packInclusionProofAdapter, packManifestAdapter];

/**
 * Renders a ZodError as a single-line refusal detail. Values are never
 * echoed back: a refusal says what was wrong with the shape, not what the
 * caller sent. Zod's own `unrecognized_keys` issue is the one exception that
 * would otherwise leak caller-chosen text — its default message embeds the
 * caller's own key strings verbatim (e.g. "Unrecognized key(s) in object:
 * 'evil_KEY_from_caller'") — so that one code is remapped to a fixed
 * string. Every other ZodIssueCode's default message describes the DECLARED
 * shape (a field name the adapter's author chose, or a generic like
 * "Required"), never a value or key the caller supplied.
 */
function argFaultDetail(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      if (i.code === z.ZodIssueCode.unrecognized_keys) return "unexpected argument";
      return i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message;
    })
    .join("; ");
}

function digestHex(s: string): string {
  return createHash("blake2b512").update(s, "utf8").digest().subarray(0, 32).toString("hex");
}

/** Stable canonical arg digest — sorted keys, length-prefixed values. */
function argDigest(args: Record<string, string>): string {
  const parts = Object.keys(args)
    .sort()
    .map((k) => `${k.length}:${k}=${args[k].length}:${args[k]}`);
  return digestHex(parts.join("|"));
}

export class Kernel {
  /** One limiter for every spoke. See limiter.ts for why it is not per-transport. */
  private readonly limiter: RateLimiter;

  constructor(
    private ledger: Ledger,
    private mounts: Map<string, Mount>,
    private facilitator: FacilitatorClient,
    rateLimit: RateLimitPolicy,
    private adapters: AdapterRegistry
  ) {
    this.limiter = new RateLimiter(rateLimit);
  }

  getMount(id: string): Mount | undefined {
    return this.mounts.get(id);
  }

  mountIds(): string[] {
    return [...this.mounts.keys()];
  }

  /**
   * Called by a transport once its OWN send has completed — not when the
   * response was handed off, and never from a settlement hook, which fires
   * while the bytes may still be in a buffer.
   *
   * What this records is a successful write on `transport`. It proves the bytes
   * left us; it does NOT prove the client consumed them, and nothing
   * downstream may read it as consumption.
   */
  recordDelivery(callId: string, byteLen: number, transport: Transport): void {
    this.ledger.recordDelivery(callId, byteLen, transport);
  }

  /**
   * WHAT was bought. Nonce-free by design: a client that legitimately
   * re-signs after authorization expiry must not be punished with a 409.
   */
  requestFingerprint(m: Mount, op: MountOperation, args: Record<string, string>): string {
    return digestHex(
      [
        op.operationId,
        m.capabilityVersion,
        m.adapterVersion,
        argDigest(args),
        "exact",
        m.network,
        m.asset,
        op.priceAtomic,
        m.payTo,
        m.substrate.packId,
      ].join(" ")
    );
  }

  /** WHICH authorization paid. Recorded per settlement attempt and receipt. */
  authorizationFingerprint(requestFp: string, p: PaymentPayload): string {
    return digestHex([requestFp, p.nonce, String(p.expiresAt ?? ""), p.payer ?? ""].join(" "));
  }

  requirementsFor(m: Mount, op: MountOperation, resource: string): PaymentRequirements {
    return {
      scheme: "exact",
      network: m.network,
      asset: m.asset,
      amountAtomic: op.priceAtomic,
      payTo: m.payTo,
      resource,
      description: `${op.operationId} over sealed pack ${m.edition}`,
      maxTimeoutSeconds: 120,
    };
  }

  private async runAdapter(m: Mount, op: MountOperation, args: Record<string, string>): Promise<{ bytes: Buffer; contentType: string }> {
    // Adapters receive only their validated args and the substrate. No db
    // handle, no fetch, no fs, no clock — there is nothing here to reach for.
    // `args` was already checked against this same adapter's argSchema at
    // admission time in `handle()`, so this lookup existing is the only thing
    // asserted here — a miss means boot's manifest/registry symmetry check
    // was bypassed, which `bootKernelOnly` is what actually prevents.
    const adapter = this.adapters.get(op.operationId);
    if (!adapter) throw new AdapterMiss("args_invalid");
    return adapter.handler(args, { substrate: m.substrate });
  }

  async handle(inv: PaidInvocation): Promise<KernelOutcome> {
    // Cheapest refusal first, on the identity the transport vouched for. An
    // invocation with no paymentId gets the anonymous ceiling.
    if (this.limiter.limited(inv.clientKey, !inv.paymentId)) {
      return { kind: "refused", code: "rate_limited" };
    }

    const m = this.mounts.get(inv.mountId);
    if (!m) return { kind: "refused", code: "args_invalid", detail: "unknown mount" };
    const op = m.operations.get(inv.operationId);
    if (!op) return { kind: "refused", code: "args_invalid", detail: "unknown operation" };

    // argSchema is the registry's replacement for the old OPERATION_ARGS map —
    // same position (after operation resolution, before fingerprinting), same
    // args_invalid code. `bootKernelOnly` refuses to boot a mount operation
    // with no registered adapter, so an absent adapter here would mean that
    // invariant was bypassed; it fails the same way a schema fault would.
    const adapter = this.adapters.get(op.operationId);
    if (!adapter) return { kind: "refused", code: "args_invalid", detail: "no registered adapter for operation" };
    const parsedArgs = adapter.argSchema.safeParse(inv.args);
    if (!parsedArgs.success) {
      return { kind: "refused", code: "args_invalid", detail: argFaultDetail(parsedArgs.error) };
    }
    // Belt-and-suspenders on top of the Record<string,string> type constraint
    // on Adapter itself: a schema field typed `z.any()` / `z.unknown()`
    // satisfies that constraint structurally without enforcing it at
    // runtime, so a value that is an object or `undefined` (e.g. an optional
    // field passed explicitly as `undefined`) can still reach here. Left
    // unchecked, argDigest's unconditional `.length` access throws on
    // `undefined` mid-`handle()`, pre-payment, and an object value collapses
    // to `[object Object]` in the digest — two materially different
    // requests producing ONE fingerprint. Refuse before either can happen.
    for (const v of Object.values(parsedArgs.data)) {
      if (typeof v !== "string") {
        return { kind: "refused", code: "args_invalid", detail: "argument values must be strings" };
      }
    }

    // Daily ceiling — the operator's pre-chosen worst case, enforced before
    // any new money can move.
    if (this.ledger.dailySettled() >= m.limits.dailySettledValueCeilingAtomic) {
      return { kind: "refused", code: "daily_ceiling_reached" };
    }
    if (BigInt(op.priceAtomic) > m.limits.maxPricePerCallAtomic) {
      return { kind: "refused", code: "capability_unavailable", detail: "price exceeds declared per-call cap" };
    }

    const requirements = this.requirementsFor(m, op, inv.resource);

    if (!inv.paymentId) {
      return { kind: "challenge", requirements, challengeEpoch: m.challengeEpoch, code: "payment_id_missing" };
    }

    // Enforce the SAME rule we publish. Previously the generated contract
    // advertised a pattern while the endpoint accepted any string at all — so a
    // paymentId that worked here would be rejected by a spec-compliant peer,
    // and one our own OpenAPI called invalid would still bind a call.
    if (!isValidPaymentId(inv.paymentId)) {
      return {
        kind: "refused",
        code: "args_invalid",
        detail: `paymentId must match ${PAYMENT_ID_PATTERN_SOURCE} (${PAYMENT_ID_MIN_LENGTH}-${PAYMENT_ID_MAX_LENGTH} chars, URL-safe base64 alphabet)`,
      };
    }

    const requestFp = this.requestFingerprint(m, op, inv.args);

    // ── binding lookup: every branch below is decided with no facilitator call
    const bound = this.ledger.findBinding(inv.paymentId);
    if (bound) {
      if (bound.requestFingerprint !== requestFp) {
        return { kind: "refused", code: "payment_id_fingerprint_conflict", callId: bound.call.call_id };
      }
      const st = bound.call.state as CallState;
      if (st === "settled" || st === "delivered") {
        const d = this.ledger.fetchDeliverable(bound.call.call_id);
        if (!d) return { kind: "refused", code: "entitlement_expired", callId: bound.call.call_id };
        return {
          kind: "delivered",
          callId: bound.call.call_id,
          bytes: d.bytes,
          contentType: d.contentType,
          receipt: d.receipt,
          entitlementExpiresAt: d.entitlementExpiresAt,
          replayed: true,
        };
      }
      if (st === "settlement_unknown") {
        return { kind: "refused", code: "settlement_pending_review", callId: bound.call.call_id };
      }
      if (st === "settlement_rejected") {
        return { kind: "refused", code: "settlement_rejected", callId: bound.call.call_id };
      }
      if (st === "executing" || st === "executed" || st === "settling" || st === "verified") {
        return { kind: "accepted", code: "call_in_progress", callId: bound.call.call_id };
      }
      // execution_failed / execution_unknown / payment_present / challenged
      // fall through and are retried below.
    }

    if (!inv.payment) {
      return { kind: "challenge", requirements, challengeEpoch: m.challengeEpoch, code: "payment_required" };
    }

    const opened = this.ledger.openCall({
      mountId: m.mountId,
      operationId: op.operationId,
      paymentId: inv.paymentId,
      requestFingerprint: requestFp,
      fingerprintVersion: m.fingerprintVersion,
      initialState: "payment_present",
    });
    if (opened.conflict) {
      return { kind: "refused", code: "payment_id_fingerprint_conflict", callId: opened.call.call_id };
    }
    const callId = opened.call.call_id;

    const authFp = this.authorizationFingerprint(requestFp, inv.payment);
    const authCount = this.ledger.recordAuthorization(callId, {
      fingerprint: authFp,
      payer: inv.payment.payer ?? null,
      nonceDigest: digestHex(inv.payment.nonce),
      expiresAt: inv.payment.expiresAt ?? null,
    });
    if (authCount > 3) {
      return { kind: "refused", code: "payment_invalid", callId, detail: "too many distinct authorizations" };
    }

    // ── verify (official boundary)
    let current = this.ledger.getCall(callId)!.state as CallState;
    if (current === "execution_failed" || current === "execution_unknown") {
      // Retry permitted: the payment was cancelled, not settled.
      this.ledger.transition(callId, current, current === "execution_unknown" ? "executing" : "payment_present", "kernel", "retry");
      current = this.ledger.getCall(callId)!.state as CallState;
    }

    if (current === "payment_present" || current === "challenged") {
      if (current === "challenged") this.ledger.transition(callId, "challenged", "payment_present");
      const v = await this.facilitator.verify(inv.payment, requirements);
      if (!v.isValid) {
        this.ledger.transition(callId, "payment_present", "execution_failed", "kernel", v.reasonCode ?? "payment_invalid");
        return { kind: "refused", code: v.reasonCode ?? "payment_invalid", callId };
      }
      this.ledger.transition(callId, "payment_present", "verified");
      current = "verified";
    }

    // ── execute under a lease
    if (current === "verified" || current === "executing") {
      if (current === "verified") {
        const lease = this.ledger.acquireLease(callId, "execute", op.deadlineMs + 30_000);
        if (!lease) return { kind: "accepted", code: "call_in_progress", callId };
        this.ledger.transition(callId, "verified", "executing");
      }
      try {
        const out = await this.runAdapter(m, op, inv.args);
        if (out.bytes.length > op.maxResultBytes) throw new AdapterMiss("capability_unavailable");
        this.ledger.commitResult(callId, {
          requestFingerprint: requestFp,
          fingerprintVersion: m.fingerprintVersion,
          digest: createHash("blake2b512").update(out.bytes).digest().subarray(0, 32).toString("hex"),
          bytes: out.bytes,
          adapterVersion: m.adapterVersion,
          packId: m.substrate.packId,
          merkleRoot: m.substrate.merkleRootHex,
          contentType: out.contentType,
        });
      } catch (e) {
        const code = e instanceof AdapterMiss ? e.code : "capability_unavailable";
        this.ledger.releaseLease(callId, "execute");
        this.ledger.transition(callId, "executing", "execution_failed", "kernel", code);
        // Adapter failure ⇒ official cancellation, and NO settlement.
        return { kind: "refused", code, callId };
      }
      current = "executed";
    }

    // ── settle (only after the result is durable)
    if (current === "executed") {
      const settleLease = this.ledger.acquireLease(callId, "settle", 60_000);
      if (!settleLease) return { kind: "accepted", code: "call_in_progress", callId };
      const attemptNo = this.ledger.beginSettlement(callId, authFp, this.facilitator.id);
      if (attemptNo === null) return { kind: "accepted", code: "call_in_progress", callId };

      const s = await this.facilitator.settle(inv.payment, requirements);
      if (s.success) {
        const receiptJson = JSON.stringify({
          transaction: s.transaction ?? null,
          network: s.network ?? m.network,
          payer: s.payer ?? inv.payment.payer ?? null,
          payTo: m.payTo,
          asset: m.asset,
          amountAtomic: op.priceAtomic,
        });
        this.ledger.commitReceipt(
          callId,
          {
            authorizationFingerprint: authFp,
            attemptNo,
            txn: s.transaction ?? null,
            network: s.network ?? m.network,
            asset: m.asset,
            amountAtomic: op.priceAtomic,
            payer: s.payer ?? inv.payment.payer ?? null,
            payTo: m.payTo,
            facilitatorId: this.facilitator.id,
            receiptJson,
            receiptJsonDigest: digestHex(receiptJson),
          },
          m.retryEntitlementSeconds
        );
      } else if (s.indeterminate) {
        this.ledger.failSettlement(callId, attemptNo, false, s.errorReason ?? "facilitator_timeout");
        return { kind: "refused", code: "settlement_pending_review", callId };
      } else {
        this.ledger.failSettlement(callId, attemptNo, true, s.errorReason ?? "settlement_rejected");
        return { kind: "refused", code: "settlement_rejected", callId };
      }
    }

    // ── deliver (requires stored result AND matching receipt)
    const d = this.ledger.fetchDeliverable(callId);
    if (!d) return { kind: "refused", code: "capability_unavailable", callId };
    return {
      kind: "delivered",
      callId,
      bytes: d.bytes,
      contentType: d.contentType,
      receipt: d.receipt,
      entitlementExpiresAt: d.entitlementExpiresAt,
      replayed: false,
    };
  }
}

export { digestHex, argDigest, randomUUID, AdapterMiss };
