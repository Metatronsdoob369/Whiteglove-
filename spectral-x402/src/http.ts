/**
 * http.ts — paid transport. node:http only, no framework.
 *
 * This edge owns exactly four things: wire decode (path → operationId, headers
 * → paymentId / payment payload), TLS posture, HTTP-native rendering of a
 * kernel outcome, and calling delivery-ack once its own send has completed.
 * Everything else — arg validation, rate limiting, admission, replay, ledger
 * policy — is the kernel's, so a second transport inherits it rather than
 * reimplementing it.
 *
 * It cannot create alternate payment or recovery semantics: every code comes
 * from the kernel, and every KERNEL OUTCOME is rendered by `statusFor` from the
 * generated refusals table.
 *
 * Four sends deliberately never reach the kernel and so never reach
 * `statusFor` — they are edge-local facts about the request, not refusals of a
 * paid call:
 *
 *   - `405` for a non-GET method (route shape)
 *   - `404` for a path with too few segments, and `404` for an unrecognized
 *     verb (route shape — there is no mount/operation to refuse)
 *   - `500` in the catch-all, where we have no outcome at all
 *
 * All four reuse `args_invalid` / `capability_unavailable` as their body code
 * because the generated table declares no route-shape or internal-error code,
 * so the SAME code can leave this server at 400 (from the table, via the
 * kernel), 404, 405, or 500 depending on which line produced it. Those values
 * are what this endpoint has always sent and are left alone here; giving them
 * their own declared codes is spectral-config work.
 */
import * as http from "node:http";
import { Kernel, type KernelOutcome, type PaidInvocation } from "./kernel.js";
import type { PaymentPayload } from "./facilitator.js";
import { decodePaymentEnvelope } from "./x402-wire.js";

const BODY_CAP = 65536;

/** code → HTTP status, as published in the generated `refusals.json`. */
export type RefusalTable = Record<string, { http: number }>;

export interface HttpOptions {
  port: number;
  requireTls: boolean;
  refusals: RefusalTable;
}

/**
 * The ONE place a KERNEL OUTCOME becomes an HTTP status.
 *
 * `challenge` / `accepted` / `delivered` are fixed by x402 itself (402 / 202 /
 * 200), so they follow `kind` and no table may move them. A refusal's status
 * comes from the generated `refusals.json`, digest-verified against
 * generated.lock at boot — so an outcome's status cannot drift from that table.
 *
 * The guarantee stops there, deliberately. `refusals.json` is NOT the same
 * document as the generated OpenAPI: openapi.json enumerates
 * [200, 202, 402, 404, 409, 410, 503] per path and publishes none of
 * args_invalid→400, rate_limited→429, body_too_large→413 or
 * tile_withdrawn→451. Sourcing status here makes the wire consistent with
 * refusals.json and nothing more — a client reading our OpenAPI still cannot
 * enumerate every status we send. Reconciling the two artifacts is
 * spectral-config work, not something this function can fix.
 */
export function statusFor(outcome: KernelOutcome, refusals: RefusalTable): number {
  switch (outcome.kind) {
    case "challenge":
      return 402;
    case "accepted":
      return 202;
    case "delivered":
      return 200;
    case "refused": {
      const declared = refusals[outcome.code]?.http;
      // Every code the kernel itself emits is declared. The only undeclared
      // code that can reach here is a facilitator-supplied verify reason
      // passed through verbatim — a payment fault, so 402 is the honest read.
      if (declared === undefined) return 402;
      // A refusal never renders as success, whatever a table claims.
      return declared >= 400 ? declared : 500;
    }
  }
}

export function createPaidServer(kernel: Kernel, opts: HttpOptions): http.Server {
  /**
   * `onSent` runs when this response is finished — every byte flushed. That is
   * the only moment at which "we sent it" is a fact rather than an intention.
   */
  function send(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    extra: Record<string, string> = {},
    onSent?: () => void
  ): void {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
      "content-type": Buffer.isBuffer(body) ? (extra["content-type"] ?? "application/json") : "application/json",
      "content-length": payload.length,
      "cache-control": "no-store", // paid content must never be cached by an intermediary
      ...extra,
    });
    res.end(payload, onSent);
  }

  return http.createServer(async (req, res) => {
    // The rate-limit identity this edge vouches for. Socket address, never a
    // client-supplied header: behind a reverse proxy every caller shares one
    // bucket, which is the safe direction to be wrong in.
    const clientKey = req.socket.remoteAddress ?? "unknown";
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${opts.port}`);
      const parts = url.pathname.split("/").filter(Boolean);

      if (url.pathname === "/health") {
        return send(res, 200, { status: "ok", kernel: "mount.v1" });
      }

      if (url.pathname === "/.well-known/x402") {
        return send(res, 200, kernelDiscovery(kernel));
      }

      // Edge-local, not a kernel outcome: no declared code exists for "wrong
      // method", so args_invalid carries a status the table never assigned it.
      if (req.method !== "GET") return send(res, 405, { code: "args_invalid", detail: "GET only" });

      // /<mount>/<relative-shape-from-the-manifest's-own-pathTemplate>
      // Route shape, also edge-local: with no mount segment or no recognized
      // shape there is no paid call to refuse, so these 404s are not
      // table-derived either. The shape itself is never hardcoded here — see
      // `resolveRoute`.
      if (parts.length < 2) return send(res, 404, { code: "args_invalid" });
      const mountId = parts[0];
      const relPath = parts.slice(1).join("/");
      const matched = resolveRoute(kernel, req.method, relPath);
      if (!matched) return send(res, 404, { code: "args_invalid" });
      const { operationId, args } = matched;

      const paymentId = header(req, "x-payment-id");
      if (opts.requireTls && header(req, "x-forwarded-proto") !== "https") {
        return send(res, 400, { code: "tls_required" }); // fail closed
      }

      let payment: PaymentPayload | undefined;
      const raw = header(req, "x-payment");
      if (raw) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
        } catch {
          return send(res, 402, { code: "payment_invalid", detail: "unparseable X-Payment header" });
        }
        // Wire decode, which is this edge's own job: a standard x402 v2 envelope
        // and our legacy flat payload arrive in the same header, and the kernel
        // reads only the flat fields. An envelope is read into them from its
        // SIGNED authorization; anything that is not an envelope is passed
        // through exactly as it always has been, unexamined.
        const wire = decodePaymentEnvelope(decoded);
        if (wire.kind === "invalid") {
          return send(res, 402, { code: "payment_invalid", detail: wire.detail });
        }
        payment = wire.kind === "payment" ? wire.payment : (decoded as PaymentPayload);
      }

      const inv: PaidInvocation = {
        mountId,
        operationId,
        args,
        paymentId,
        payment,
        transport: "http",
        clientKey,
        resource: url.pathname,
      };
      const outcome = await kernel.handle(inv);

      switch (outcome.kind) {
        case "challenge":
          return send(
            res,
            statusFor(outcome, opts.refusals),
            {
              x402Version: 2,
              error: outcome.code,
              accepts: [outcome.requirements],
            },
            { "x-challenge-epoch": outcome.challengeEpoch }
          );
        case "refused":
          return send(res, statusFor(outcome, opts.refusals), {
            code: outcome.code,
            ...(outcome.callId ? { callId: outcome.callId } : {}),
            ...(outcome.detail ? { detail: outcome.detail } : {}),
          });
        case "accepted":
          return send(res, statusFor(outcome, opts.refusals), {
            code: outcome.code,
            callId: outcome.callId,
            retryAfterMs: 250,
          });
        case "delivered": {
          let acked = false;
          return send(
            res,
            statusFor(outcome, opts.refusals),
            outcome.bytes,
            {
              "content-type": outcome.contentType,
              "x-call-id": outcome.callId,
              "x-payment-response": Buffer.from(JSON.stringify(outcome.receipt)).toString("base64"),
              "x-entitlement-expires": String(outcome.entitlementExpiresAt),
              "x-replayed": String(outcome.replayed),
            },
            () => {
              // The response is FINISHED — every byte flushed. Acking before
              // this point records a delivery that may never have left the
              // socket, which is the failure we refuse to manufacture. A client
              // that aborts mid-body simply gets no ack: the call stays
              // `settled` and replayable, which is the correct outcome.
              if (acked) return;
              acked = true;
              try {
                kernel.recordDelivery(outcome.callId, outcome.bytes.length, inv.transport);
              } catch (e) {
                // We are outside the request try/catch here, and the response
                // is already gone. Losing the ack costs a replay; throwing
                // inside a stream callback would cost the process.
                process.stderr.write(`[kernel] delivery ack failed for ${outcome.callId}: ${(e as Error).message}\n`);
              }
            }
          );
        }
      }
    } catch (e) {
      // Never leak err.message to a paid caller. Edge-local: there is no
      // outcome to render, so this 500 is ours, not the table's 503 for
      // capability_unavailable.
      send(res, 500, { code: "capability_unavailable" });
      process.stderr.write(`[kernel] ${(e as Error).stack ?? String(e)}\n`);
    }
  });
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * A mount's own `pathTemplate` (e.g. "/roblox-luau/tile/{cid}") with its
 * leading segment — the mount's own id — stripped, leaving just the shape a
 * caller's path is expected to carry after the mount: "tile/{cid}".
 *
 * `pathTemplate` always begins with the declaring mount's id (that is how
 * the generator writes it), so this is the manifest's own convention, not
 * one invented here.
 */
function relativeTemplate(pathTemplate: string): string {
  return pathTemplate.split("/").filter(Boolean).slice(1).join("/");
}

/**
 * Matches a `{name}`-templated relative shape against a caller's relative
 * path (both already split on "/"), replicating exactly what the verb
 * ternary this replaces did:
 *
 *   - every LITERAL segment of the template must match the actual path at
 *     the same position — a mismatch, or a missing actual segment where a
 *     literal is required, is not a match;
 *   - a `{placeholder}` segment is captured from the actual path ONLY IF
 *     that position is present — a request with the placeholder segment
 *     omitted (e.g. `/mount/tile` with no cid) still resolves the
 *     operationId, just with that key absent from `args`, exactly as the
 *     old code left `args.cid` unset rather than 404ing; the kernel's own
 *     argSchema is what refuses a missing required arg, not this edge;
 *   - actual segments beyond what the template names are ignored, exactly
 *     as the old code read only `parts[2]` and never looked past it.
 *
 * Returns null when a required literal segment doesn't match — the only
 * case this function treats as "not this operation".
 */
function matchPathTemplate(template: string, actualRelPath: string): Record<string, string> | null {
  const templateParts = template.split("/").filter(Boolean);
  const actualParts = actualRelPath.split("/").filter(Boolean);
  for (let i = 0; i < templateParts.length; i++) {
    const t = templateParts[i];
    const isPlaceholder = t.startsWith("{") && t.endsWith("}");
    if (!isPlaceholder && actualParts[i] !== t) return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < templateParts.length; i++) {
    const t = templateParts[i];
    if (t.startsWith("{") && t.endsWith("}") && actualParts[i] !== undefined) {
      params[t.slice(1, -1)] = actualParts[i];
    }
  }
  return params;
}

/**
 * Resolves an operationId and its captured args from a caller's relative
 * path, by trying every operation ANY known mount declares — mount-agnostic
 * on purpose, exactly like the verb ternary this replaces, which recognized
 * "tile" / "proof" / "manifest" regardless of which (or whether a real)
 * mount preceded it. A shape a real mount doesn't actually serve is still
 * caught — by the kernel's own "unknown mount" / "unknown operation"
 * refusal, not by this edge guessing which mounts exist.
 *
 * Returns null only when NO known mount declares a matching (method, shape)
 * pair at all — the one case this edge still 404s itself, since there is no
 * mount or operation for the kernel to refuse.
 */
function resolveRoute(kernel: Kernel, method: string, relPath: string): { operationId: string; args: Record<string, string> } | null {
  for (const mountId of kernel.mountIds()) {
    const mount = kernel.getMount(mountId)!;
    for (const op of mount.operations.values()) {
      if (op.method !== method) continue;
      const params = matchPathTemplate(relativeTemplate(op.pathTemplate), relPath);
      if (params) return { operationId: op.operationId, args: params };
    }
  }
  return null;
}

function kernelDiscovery(kernel: Kernel): unknown {
  const out: unknown[] = [];
  for (const mountId of kernel.mountIds()) {
    const m = kernel.getMount(mountId)!;
    for (const op of m.operations.values()) {
      out.push({
        // Straight from the manifest — this used to be a ternary rebuilding
        // the same three shapes by hand; pathTemplate already IS that string.
        resource: op.pathTemplate,
        operationId: op.operationId,
        scheme: "exact",
        network: m.network,
        asset: m.asset,
        priceAtomic: op.priceAtomic,
        challengeEpoch: m.challengeEpoch,
      });
    }
  }
  return { x402Version: 2, resources: out };
}
