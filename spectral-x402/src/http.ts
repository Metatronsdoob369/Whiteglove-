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
 * from the kernel, and every refusal status from the generated refusals table.
 */
import * as http from "node:http";
import { Kernel, type KernelOutcome, type PaidInvocation } from "./kernel.js";
import type { PaymentPayload } from "./facilitator.js";

const BODY_CAP = 65536;

/** code → HTTP status, as published in the generated `refusals.json`. */
export type RefusalTable = Record<string, { http: number }>;

export interface HttpOptions {
  port: number;
  requireTls: boolean;
  refusals: RefusalTable;
}

/**
 * The ONE place an outcome becomes an HTTP status.
 *
 * `challenge` / `accepted` / `delivered` are fixed by x402 itself (402 / 202 /
 * 200), so they follow `kind` and no table may move them. A refusal's status
 * comes from the generated refusals table — the same table our OpenAPI
 * publishes — so the status we send cannot drift from the status we document.
 * The table is digest-verified against generated.lock at boot.
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

      if (req.method !== "GET") return send(res, 405, { code: "args_invalid", detail: "GET only" });

      // /<mount>/tile/<cid> | /<mount>/proof/<cid> | /<mount>/manifest
      if (parts.length < 2) return send(res, 404, { code: "args_invalid" });
      const mountId = parts[0];
      const verb = parts[1];
      const operationId =
        verb === "tile" ? "tile_fetch" : verb === "proof" ? "pack_inclusion_proof" : verb === "manifest" ? "pack_manifest" : null;
      if (!operationId) return send(res, 404, { code: "args_invalid" });

      // Decode only. Whether a cid is well-formed, present, or required is the
      // kernel's schema question, answered identically for every transport.
      const args: Record<string, string> = {};
      if (operationId !== "pack_manifest" && parts.length >= 3) args.cid = parts[2];

      const paymentId = header(req, "x-payment-id");
      if (opts.requireTls && header(req, "x-forwarded-proto") !== "https") {
        return send(res, 400, { code: "tls_required" }); // fail closed
      }

      let payment: PaymentPayload | undefined;
      const raw = header(req, "x-payment");
      if (raw) {
        try {
          payment = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as PaymentPayload;
        } catch {
          return send(res, 402, { code: "payment_invalid", detail: "unparseable X-Payment header" });
        }
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
      // Never leak err.message to a paid caller.
      send(res, 500, { code: "capability_unavailable" });
      process.stderr.write(`[kernel] ${(e as Error).stack ?? String(e)}\n`);
    }
  });
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function kernelDiscovery(kernel: Kernel): unknown {
  const out: unknown[] = [];
  for (const mountId of kernel.mountIds()) {
    const m = kernel.getMount(mountId)!;
    for (const op of m.operations.values()) {
      out.push({
        resource: `/${m.mountId}/${op.operationId === "tile_fetch" ? "tile/{cid}" : op.operationId === "pack_inclusion_proof" ? "proof/{cid}" : "manifest"}`,
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
