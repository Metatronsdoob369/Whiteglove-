/**
 * http.ts — paid transport. node:http only, no framework.
 *
 * Transport translates kernel outcomes into HTTP. It cannot create alternate
 * payment or recovery semantics — every status and every code comes from the
 * kernel or from the generated refusals table.
 */
import * as http from "node:http";
import { Kernel, type KernelRequest } from "./kernel.js";
import type { PaymentPayload } from "./facilitator.js";

const BODY_CAP = 65536;

export interface HttpOptions {
  port: number;
  requireTls: boolean;
  rateLimit: { windowMs: number; max: number; anonymousMax: number };
}

interface Bucket {
  windowStart: number;
  paid: number;
  anon: number;
}

export function createPaidServer(kernel: Kernel, opts: HttpOptions): http.Server {
  const buckets = new Map<string, Bucket>();

  // Hard ceiling on tracked clients. Without eviction every distinct source
  // address is a permanent allocation, so the rate limiter becomes the
  // memory-exhaustion vector it exists to prevent.
  const MAX_TRACKED = 10_000;
  let lastSweep = Date.now();

  function sweep(now: number): void {
    if (now - lastSweep < opts.rateLimit.windowMs) return;
    lastSweep = now;
    for (const [k, v] of buckets) {
      if (now - v.windowStart > opts.rateLimit.windowMs) buckets.delete(k);
    }
    // Still oversized after expiry means an active flood: drop oldest first.
    if (buckets.size > MAX_TRACKED) {
      const ordered = [...buckets.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart);
      for (const [k] of ordered.slice(0, buckets.size - MAX_TRACKED)) buckets.delete(k);
    }
  }

  function limited(ip: string, anonymous: boolean): boolean {
    const now = Date.now();
    sweep(now);
    let b = buckets.get(ip);
    if (!b || now - b.windowStart > opts.rateLimit.windowMs) {
      b = { windowStart: now, paid: 0, anon: 0 };
      // At capacity mid-window, fail CLOSED for unknown clients rather than
      // growing without bound. Known clients keep their existing bucket.
      if (buckets.size >= MAX_TRACKED) return true;
      buckets.set(ip, b);
    }
    if (anonymous) {
      b.anon++;
      return b.anon > opts.rateLimit.anonymousMax;
    }
    b.paid++;
    return b.paid > opts.rateLimit.max;
  }

  function send(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
      "content-type": Buffer.isBuffer(body) ? (extra["content-type"] ?? "application/json") : "application/json",
      "content-length": payload.length,
      "cache-control": "no-store", // paid content must never be cached by an intermediary
      ...extra,
    });
    res.end(payload);
  }

  return http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress ?? "unknown";
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

      const args: Record<string, string> = {};
      if (operationId !== "pack_manifest") {
        if (parts.length < 3) return send(res, 400, { code: "args_invalid", detail: "cid required" });
        args.cid = parts[2];
        if (!/^b2-256:[0-9a-f]{64}$/.test(args.cid)) {
          return send(res, 400, { code: "args_invalid", detail: "malformed cid" });
        }
      }

      const paymentId = header(req, "x-payment-id");
      if (limited(ip, !paymentId)) return send(res, 429, { code: "rate_limited" });

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

      const kreq: KernelRequest = { mountId, operationId, args, paymentId, payment };
      const outcome = await kernel.handle(kreq, url.pathname);

      switch (outcome.kind) {
        case "challenge":
          return send(
            res,
            402,
            {
              x402Version: 2,
              error: outcome.code,
              accepts: [outcome.requirements],
            },
            { "x-challenge-epoch": outcome.challengeEpoch }
          );
        case "refused":
          return send(res, outcome.status, {
            code: outcome.code,
            ...(outcome.callId ? { callId: outcome.callId } : {}),
            ...(outcome.detail ? { detail: outcome.detail } : {}),
          });
        case "accepted":
          return send(res, 202, { code: outcome.code, callId: outcome.callId, retryAfterMs: 250 });
        case "delivered": {
          send(res, 200, outcome.bytes, {
            "content-type": outcome.contentType,
            "x-call-id": outcome.callId,
            "x-payment-response": Buffer.from(JSON.stringify(outcome.receipt)).toString("base64"),
            "x-entitlement-expires": String(outcome.entitlementExpiresAt),
            "x-replayed": String(outcome.replayed),
          });
          // Bytes first, THEN record delivery — recording a delivery that
          // never reached the wire is the failure we refuse to manufacture.
          kernel.recordDelivery(outcome.callId, outcome.bytes.length);
          return;
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
