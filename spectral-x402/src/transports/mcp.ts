/**
 * transports/mcp.ts — the MCP spoke, over Streamable HTTP.
 *
 * This is the second edge onto the same kernel. It owns exactly what http.ts
 * owns on its own wire, and nothing else: wire decode (tool name → mount +
 * operation, tool arguments → paymentId + args, `_meta` → payment payload),
 * TLS posture, MCP-native rendering of a kernel outcome, and calling
 * delivery-ack once its OWN send has completed.
 *
 * ── hook → ledger transition map ────────────────────────────────────────────
 * Who owns each phase of a paid call. There is no second answer anywhere in
 * this file:
 *
 *   challenge  OUR KERNEL   — `kernel.handle` returns `{kind:"challenge"}` with
 *                             requirements built from the digest-verified
 *                             manifest. @x402/mcp only formats it as a
 *                             JSON-RPC error (`createPaymentRequiredError`).
 *   verify     OUR KERNEL   — via its own FacilitatorClient boundary, after
 *                             the whole admission order has already run.
 *   execute    OUR KERNEL   — under a ledger lease, against a sealed pack.
 *   cancel     OUR KERNEL   — adapter failure ⇒ ledger `execution_failed`,
 *                             and NO settlement.
 *   settle     OUR KERNEL   — only after the result is durable; receipt and
 *                             entitlement are ledger rows.
 *   deliver    OUR KERNEL   — gated on stored result + matching receipt + live
 *                             entitlement; THIS FILE only renders the bytes
 *                             and then acks the write.
 *
 * @x402/mcp owns WIRE FORMAT ONLY — four pure functions and two key constants.
 * `createPaymentWrapper` is deliberately never imported: it runs its own
 * verify/settle lifecycle, which would double-verify and risk double-settling
 * against a kernel that is already the sole authority.
 *
 * ── why the low-level `Server`, not `McpServer` ─────────────────────────────
 * Two reasons, both load-bearing:
 *
 *   1. `McpServer.registerTool` takes a Zod shape, so using it would mean
 *      hand-rebuilding every tool's schema in code — a second source of truth
 *      beside the generated, digest-verified `mcp-tools.json`. The low-level
 *      Server lets `tools/list` return the artifact VERBATIM.
 *   2. `McpServer`'s tool-handler catch block re-throws only one error code
 *      and converts everything else to a text result, which would silently
 *      drop the `data` of a 402 — i.e. the payment requirements themselves.
 *      The low-level request path preserves any safe-integer `code` plus
 *      `data`, so the x402 challenge reaches the client intact.
 *
 * ── per-session isolation (GHSA-345p-7cg4-v4c7) ─────────────────────────────
 * A fresh `Server` AND a fresh `StreamableHTTPServerTransport` are built for
 * every session and torn down with it. Sharing either across clients is the
 * cross-client response-misrouting advisory; the SDK's 1.26.0 fix turns that
 * misrouting into a thrown error but does not make sharing correct.
 *
 * ── DNS-rebinding protection (GHSA-w48q-cv73-mx4w) ──────────────────────────
 * Off by default in the SDK, so it is turned ON here explicitly, and the
 * same allowlist is ALSO enforced at this edge before a session is allocated
 * (a rejected request must not cost us a Server + transport pair). The
 * allowlist is the loopback forms of our own listening address, computed
 * after bind so an ephemeral port is covered, plus whatever an operator
 * declares for a fronted deployment. Semantics match the SDK's exactly: Host
 * must be present and allowlisted; Origin is checked only when present,
 * because non-browser MCP clients do not send one.
 *
 * ── the session budget ──────────────────────────────────────────────────────
 * `initialize` is the only request that allocates without reaching the
 * kernel's limiter — that limiter meters `tools/call`, keyed by a session id
 * that does not exist yet at initialize time. So sessions carry their own
 * budget: a hard ceiling (`MAX_SESSIONS`, refused at 503 before anything is
 * allocated) and an idle TTL (`SESSION_IDLE_MS`, swept lazily on the request
 * path). Neither is optional — a ceiling with no way for abandoned entries to
 * leave would simply wedge, and a TTL with no ceiling still lets a fast
 * caller outrun it.
 *
 * ── what is deliberately NOT here ───────────────────────────────────────────
 * No auth layer, no resumability `EventStore`, no server-initiated
 * notifications beyond what the transport itself needs. The paid gate is the
 * kernel's; adding a second one here would be a second policy.
 */
import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_PAYMENT_META_KEY,
  attachPaymentResponseToMeta,
  createPaymentRequiredError,
  extractPaymentFromMeta,
} from "@x402/mcp";
import type { Network, PaymentRequired, SettleResponse } from "@x402/core/types";
import { Kernel, type KernelOutcome, type PaidInvocation } from "../kernel.js";
import type { PaymentPayload } from "../facilitator.js";
import type { McpToolDeclaration } from "../server.js";
import { KERNEL_VERSION } from "../version.js";

/** Same cap the paid HTTP surface uses. A paid endpoint may not buffer without one. */
const BODY_CAP = 65536;

/** The single MCP endpoint. Streamable HTTP is one path, three methods. */
const ENDPOINT = "/mcp";

const SESSION_HEADER = "mcp-session-id";

/**
 * Hard ceiling on live sessions.
 *
 * `initialize` is the one request that ALLOCATES (an `Server` plus a
 * transport) without reaching the kernel's limiter — that limiter meters
 * `tools/call` keyed by a session id which, at initialize time, does not yet
 * exist. So without a ceiling here, a caller past the Host/Origin gate can
 * allocate a pair per request, forever, having paid nothing. This is the same
 * budget the rebinding gate below already refuses to spend on a request we
 * will not serve, extended to the request we WILL serve.
 *
 * Same reasoning, and the same shape, as `MAX_TRACKED` in limiter.ts.
 */
const MAX_SESSIONS = 256;

/**
 * A session with no request for this long is treated as gone.
 *
 * Streamable HTTP puts no keep-alive obligation on a client: DELETE is the
 * only explicit end, and a client is free to simply stop. A cap alone would
 * therefore wedge permanently once reached, so the cap needs a way for
 * abandoned entries to leave.
 *
 * Swept LAZILY, on the request path — no interval to keep the process alive,
 * nothing for a supervisor's drain or a test's teardown to fight.
 */
const SESSION_IDLE_MS = 300_000;

export { MAX_SESSIONS, SESSION_IDLE_MS };

export interface McpOptions {
  /**
   * The published tool list, VERBATIM from the generated `mcp-tools.json`
   * that boot already digest-verified. This file never reconstructs a tool
   * name or a schema — see `buildRoutes` for the one place the naming
   * convention appears, and the fail-closed check that guards it.
   */
  tools: readonly McpToolDeclaration[];
  /** Fail-closed TLS posture. Same value, same meaning, as the paid HTTP surface. */
  requireTls: boolean;
  /** Extra Host header values to accept, for a deployment behind a proxy. */
  allowedHosts?: readonly string[];
  /** Extra Origin header values to accept, for a browser-hosted client. */
  allowedOrigins?: readonly string[];
  /** Live-session ceiling. Defaults to `MAX_SESSIONS`. */
  maxSessions?: number;
  /**
   * Test-only: the clock session liveness is measured against.
   *
   * Deliberately NOT the ledger's clock, which `bootMcp` leaves alone. The
   * ledger's is a wall clock for entitlements and a test steps it a day at a
   * time; sessions would all look abandoned the moment it jumped. These are
   * two different questions about time and they get two different clocks.
   */
  now?: () => number;
}

/** What a tool name dispatches to, resolved once at construction. */
interface Route {
  mountId: string;
  operationId: string;
  /** The manifest's own resource shape — what the challenge advertises as bought. */
  pathTemplate: string;
}

/**
 * The generator's tool-naming convention: mount id with `-` → `_`, then `__`,
 * then the operation id (`roblox-luau` + `tile_fetch` → `roblox_luau__tile_fetch`).
 *
 * This is the ONLY place the convention appears in code, it runs in the
 * FORWARD direction only (never parsing a name back into a mount id, which is
 * lossy), and `buildRoutes` refuses to construct a server if it ever stops
 * agreeing with the digest-verified artifact — in both directions. That
 * fail-closed pairing is what makes having the convention here safe, and it
 * is the same arrangement the adapter registry uses for operation ids.
 */
function mcpToolName(mountId: string, operationId: string): string {
  return `${mountId.replace(/-/g, "_")}__${operationId}`;
}

/**
 * name → route, built by walking the kernel's OWN mounts and matching each
 * against the published artifact.
 *
 * Refuses both ways, before a socket exists:
 *   - a published tool with no live mount operation behind it would be a
 *     tool we advertise and cannot serve;
 *   - a live mount operation with no published tool would be a paid
 *     capability reachable over MCP that our own contract never declared.
 */
export function buildRoutes(kernel: Kernel, tools: readonly McpToolDeclaration[]): Map<string, Route> {
  const routes = new Map<string, Route>();
  for (const mountId of kernel.mountIds()) {
    const mount = kernel.getMount(mountId)!;
    for (const op of mount.operations.values()) {
      routes.set(mcpToolName(mountId, op.operationId), {
        mountId,
        operationId: op.operationId,
        pathTemplate: op.pathTemplate,
      });
    }
  }
  const published = new Set(tools.map((t) => t.name));
  for (const name of published) {
    if (!routes.has(name)) {
      throw new Error(`MCP_REFUSED: published tool "${name}" has no live mount operation behind it`);
    }
  }
  for (const name of routes.keys()) {
    if (!published.has(name)) {
      throw new Error(`MCP_REFUSED: mount operation "${name}" is not published in mcp-tools.json`);
    }
  }
  return routes;
}

/**
 * The MCP edge, as a plain `node:http` server — no framework, same as
 * http.ts. (The SDK drags `express` in transitively for a convenience helper
 * we do not use.)
 *
 * Returned unlistening, exactly like `createPaidServer`, so the caller
 * chooses the bind address.
 */
export function createPaidMcpServer(kernel: Kernel, opts: McpOptions): http.Server {
  const routes = buildRoutes(kernel, opts.tools);
  const sessions = new Map<string, Session>();
  const maxSessions = opts.maxSessions ?? MAX_SESSIONS;
  const now = opts.now ?? (() => Date.now());
  /**
   * Sessions allocated but not yet in the map.
   *
   * `onsessioninitialized` fires DURING `handleRequest`, so a burst of
   * concurrent initializes would every one of them read `sessions.size`
   * below the cap and allocate. Counting the in-flight ones is what makes the
   * ceiling a ceiling rather than a ceiling per event-loop turn.
   */
  let allocating = 0;

  interface Session {
    transport: StreamableHTTPServerTransport;
    server: Server;
    /** When this session last carried a request. Drives idle eviction. */
    lastSeen: number;
    /**
     * JSON-RPC request id → the delivery that request produced, awaiting the
     * proof that our send finished. See `armDeliveryAck`.
     */
    pendingAcks: Map<string, { callId: string; byteLen: number }>;
  }

  /**
   * Forget a session and tear down what it holds, by exactly the path an
   * explicit DELETE takes: closing the transport runs the onclose chain,
   * which is where the `Server` bound to it (and its own delete from this
   * map, harmlessly a second time) is cleaned up.
   */
  function dropSession(id: string, session: Session): void {
    sessions.delete(id);
    void session.transport.close();
  }

  /** Sweep sessions that have gone quiet. Called on the request path, never on a timer. */
  function evictIdle(): void {
    const cutoff = now() - SESSION_IDLE_MS;
    for (const [id, session] of sessions) {
      if (session.lastSeen <= cutoff) dropSession(id, session);
    }
  }

  /**
   * The loopback forms of the address we are ACTUALLY listening on, computed
   * per session because an ephemeral port (`listen(0)`) is not known until
   * after bind. Plus whatever an operator declared.
   */
  function allowlist(): { hosts: string[]; origins: string[] } {
    const addr = httpServer.address();
    const port = addr !== null && typeof addr === "object" ? addr.port : 0;
    const loopback = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    return {
      hosts: [...loopback, ...(opts.allowedHosts ?? [])],
      origins: [
        ...loopback.flatMap((h) => [`http://${h}`, `https://${h}`]),
        ...(opts.allowedOrigins ?? []),
      ],
    };
  }

  /** Null when the request may proceed; a reason string when it may not. */
  function rebindingFault(req: http.IncomingMessage): string | null {
    const { hosts, origins } = allowlist();
    const host = header(req, "host");
    if (!host || !hosts.includes(host)) return "Invalid Host header";
    const origin = header(req, "origin");
    // Only a PRESENT origin is checked — a non-browser client sends none, and
    // rejecting that would refuse every ordinary MCP client. Matches the SDK.
    if (origin !== undefined && !origins.includes(origin)) return "Invalid Origin header";
    return null;
  }

  async function createSession(): Promise<Session> {
    const pendingAcks = new Map<string, { callId: string; byteLen: number }>();
    let session: Session | undefined;
    const { hosts, origins } = allowlist();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // A POST answers with a plain JSON body rather than an SSE stream. That
      // is what makes "the response is finished" an observable fact on the
      // ServerResponse, which is what delivery-ack is required to wait for.
      // The standalone GET stream is unaffected.
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: hosts,
      allowedOrigins: origins,
      onsessioninitialized: (id) => {
        if (session) sessions.set(id, session);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };

    const server = new Server(
      { name: "spectral-x402", version: KERNEL_VERSION },
      { capabilities: { tools: {} } }
    );

    // The published list, handed back untouched — no filter, no reshape, no
    // schema rebuilt from a Zod description of itself. The artifact IS the
    // contract, so anything that "fixed up" a field here would be editing the
    // contract on its way out the door.
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: opts.tools }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const route = routes.get(request.params.name);
      // Edge-local, exactly like http.ts's 404 for an unrecognized path
      // shape: there is no mount or operation for the kernel to refuse. The
      // caller's own text is never echoed back.
      if (!route) throw new McpError(ErrorCode.InvalidParams, "unknown tool");

      // Server-issued, never client-supplied: the session id is ours, which
      // is the only reason it is acceptable as a rate-limit identity. One
      // kernel-side limiter meters this spoke on the same buckets as HTTP.
      // A tools/call cannot arrive without a session, so the fallback is
      // unreachable — and it collapses such callers into ONE bucket, which
      // is the safe direction to be wrong in (http.ts's `?? "unknown"`).
      const sessionId = extra.sessionId ?? transport.sessionId ?? "unknown";

      // THE paymentId LIFT. The published contract declares `paymentId`
      // inside each tool's inputSchema, but the kernel's per-operation arg
      // schemas are strict and exclude it — so it must come out of the
      // arguments and travel as its own field, or every paid call would be
      // refused for an unrecognized argument.
      const { paymentId, ...rest } = (request.params.arguments ?? {}) as Record<string, unknown>;

      // The signed payment travels separately, in `_meta`. A key that is
      // PRESENT but does not decode is refused rather than treated as
      // absent — the same call http.ts makes for an unparseable X-Payment
      // header. Silently downgrading a malformed payment to "no payment"
      // would answer a broken client with a challenge it already answered.
      const meta = request.params._meta;
      const envelope = extractPaymentFromMeta({
        name: request.params.name,
        arguments: rest,
        _meta: meta,
      });
      if (meta !== undefined && MCP_PAYMENT_META_KEY in meta && !envelope) {
        return refusalResult("payment_invalid", undefined, "unparseable x402/payment envelope");
      }

      let payment: PaymentPayload | undefined;
      if (envelope) {
        // The x402 envelope's `payload` is the SCHEME-SPECIFIC slot, and what
        // our scheme puts there is the same flat payload the HTTP edge
        // carries in X-Payment. Nothing is cross-filled from `accepted`:
        // asserting the terms is the facilitator's job, and an edge that
        // "helpfully" filled them in would be manufacturing agreement.
        const inner = envelope.payload as Partial<PaymentPayload> | undefined;
        // The ledger digests the nonce unconditionally. A missing or
        // non-string one would throw mid-`handle()`, after admission and
        // before any outcome — so it is refused here, as a payment fault.
        if (!inner || typeof inner.nonce !== "string") {
          return refusalResult("payment_invalid", undefined, "payment payload carries no nonce");
        }
        payment = inner as PaymentPayload;
      }

      const inv: PaidInvocation = {
        mountId: route.mountId,
        operationId: route.operationId,
        // Raw and unvalidated, minus the lifted paymentId. The kernel's own
        // argSchema is the only arg authority; an edge that pre-validated
        // would be a second one, and its non-string guard is what refuses a
        // value MCP's JSON allows and the kernel's digest does not.
        args: rest as Record<string, string>,
        // A non-string paymentId is treated as ABSENT, not as an invented
        // args_invalid: the kernel then issues its ordinary
        // `payment_id_missing` challenge, which is a decision it made.
        paymentId: typeof paymentId === "string" ? paymentId : undefined,
        payment,
        transport: "mcp",
        clientKey: `mcp:${sessionId}`,
        resource: route.pathTemplate,
      };

      const outcome = await kernel.handle(inv);
      return renderOutcome(outcome, inv, pendingAcks, String(extra.requestId));
    });

    session = { transport, server, pendingAcks, lastSeen: now() };
    await server.connect(transport);
    return session;
  }

  /**
   * Ack a delivery only once THIS response is finished — every byte flushed.
   *
   * The tool handler files the delivery under its JSON-RPC request id; this
   * arms the HTTP response that will carry it. `close` always fires, so the
   * entry is always removed (no leak) and the ack runs only when
   * `writableFinished` says the body actually left us. A client that aborts
   * mid-send therefore gets NO ack: the call stays settled and replayable,
   * which is the correct outcome. Deleting before acking is the ack-once
   * guard.
   */
  function armDeliveryAck(res: http.ServerResponse, session: Session, ids: string[]): void {
    if (ids.length === 0) return;
    res.once("close", () => {
      for (const id of ids) {
        const pending = session.pendingAcks.get(id);
        if (!pending) continue;
        session.pendingAcks.delete(id);
        if (!res.writableFinished) continue;
        try {
          kernel.recordDelivery(pending.callId, pending.byteLen, "mcp");
        } catch (e) {
          // The response is already gone and we are outside the request's
          // try/catch. Losing the ack costs a replay; throwing here would
          // cost the process.
          process.stderr.write(`[kernel] delivery ack failed for ${pending.callId}: ${(e as Error).message}\n`);
        }
      }
    });
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/health") {
        return sendJson(res, 200, { status: "ok", kernel: "mount.v1", transport: "mcp" });
      }
      if (url.pathname !== ENDPOINT) {
        return jsonRpcError(res, 404, ErrorCode.InvalidRequest, "Not found");
      }

      // Fail closed, mirroring the paid HTTP surface line for line: same
      // condition, same `tls_required` code, same status. A paid capability
      // may not be reachable in clear text on one spoke and not the other.
      if (opts.requireTls && header(req, "x-forwarded-proto") !== "https") {
        return sendJson(res, 400, { code: "tls_required" });
      }

      // Before any allocation: a rebinding attempt must not cost a session.
      const fault = rebindingFault(req);
      if (fault) return jsonRpcError(res, 403, -32000, fault);

      // Abandoned sessions leave here, on the way in. A client whose own
      // session has gone quiet past the TTL is swept along with the rest and
      // then reads as unknown below — which is the truth: it is gone.
      evictIdle();

      if (req.method === "POST") {
        const body = await readJsonBody(req);
        if (body === TOO_LARGE) return jsonRpcError(res, 413, ErrorCode.InvalidRequest, "Body too large");
        if (body === UNPARSEABLE) return jsonRpcError(res, 400, ErrorCode.ParseError, "Parse error");

        const sid = header(req, SESSION_HEADER);
        let session = sid === undefined ? undefined : sessions.get(sid);
        let created = false;
        if (session) {
          session.lastSeen = now();
        } else {
          // An unknown session id is refused rather than quietly starting a
          // new session: a client holding a stale id must learn that its
          // session is gone, not silently get a different one.
          if (sid !== undefined) return jsonRpcError(res, 404, -32001, "Session not found");
          if (!isInitializeRequest(body)) {
            return jsonRpcError(res, 400, ErrorCode.InvalidRequest, "Missing Mcp-Session-Id");
          }
          // Refused BEFORE allocating anything — the same principle as the
          // rebinding gate above. Capacity, so 503, matching what the
          // refusals table declares for capability_unavailable.
          if (sessions.size + allocating >= maxSessions) {
            return jsonRpcError(res, 503, -32000, "Session capacity reached");
          }
          allocating++;
          created = true;
        }
        try {
          // Inside the try, deliberately. `allocating` is incremented above,
          // so EVERY exit from here — including `createSession` itself
          // rejecting — has to reach the decrement. Constructing the session
          // outside this block would let a failed allocation eat a slot of
          // the ceiling permanently: the count would stay inflated for the
          // life of the process, silently shrinking capacity with no
          // operator-visible signal until enough failures wedged admission
          // entirely, with zero live sessions.
          if (!session) session = await createSession();
          armDeliveryAck(res, session, requestIdsIn(body));
          await session.transport.handleRequest(req, res, body);
          // An initialize the transport itself rejected leaves a Server and a
          // transport bound to no session and reachable by nothing. Close it
          // rather than leak it.
          if (session.transport.sessionId === undefined) void session.transport.close();
        } finally {
          // Not before now: the map insert happens inside handleRequest, so
          // decrementing any earlier would reopen the concurrency gap the
          // counter exists to close.
          if (created) allocating--;
        }
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        const sid = header(req, SESSION_HEADER);
        const session = sid === undefined ? undefined : sessions.get(sid);
        if (!session) return jsonRpcError(res, 404, -32001, "Session not found");
        session.lastSeen = now();
        return await session.transport.handleRequest(req, res);
      }

      return jsonRpcError(res, 405, ErrorCode.InvalidRequest, "Method not allowed");
    } catch (e) {
      // Never leak err.message to a paid caller.
      if (!res.headersSent) jsonRpcError(res, 500, ErrorCode.InternalError, "Internal error");
      process.stderr.write(`[kernel] ${(e as Error).stack ?? String(e)}\n`);
    }
  });

  // Every live session holds a Server and a transport. Closing the listener
  // without closing them would leave both, and their ledger-facing state,
  // alive in a process that believes it shut down.
  httpServer.on("close", () => {
    for (const session of [...sessions.values()]) void session.transport.close();
    sessions.clear();
  });

  return httpServer;
}

// ─── rendering a kernel outcome onto MCP ─────────────────────────────────────

/**
 * The ONE place a KERNEL OUTCOME becomes an MCP result.
 *
 * MCP has no status line, so unlike http.ts's `statusFor` there is no table
 * to consult: `challenge` is a JSON-RPC error because it is a protocol
 * demand rather than a tool result, and everything else is a tool result —
 * `delivered` carrying bytes plus the receipt, `refused` and `accepted`
 * carrying the kernel's own code with `isError`. `accepted` is marked
 * isError not because the call went wrong but because nothing was delivered:
 * MCP has no 202, and the honest rendering of "in progress, retry with the
 * same paymentId" is "this call did not return your bytes".
 */
function renderOutcome(
  outcome: KernelOutcome,
  inv: PaidInvocation,
  pendingAcks: Map<string, { callId: string; byteLen: number }>,
  requestId: string
): { content: unknown[]; isError?: boolean; _meta?: Record<string, unknown> } {
  switch (outcome.kind) {
    case "challenge":
      // Thrown, so it leaves as a JSON-RPC error with `data` intact. The
      // helper owns the envelope; every value inside it is the kernel's.
      throw createPaymentRequiredError(paymentRequiredFor(outcome));
    case "refused":
      return refusalResult(outcome.code, outcome.callId, outcome.detail);
    case "accepted":
      return refusalResult(outcome.code, outcome.callId, undefined, { retryAfterMs: 250 });
    case "delivered": {
      // Filed, not acked. The ack happens when the HTTP response finishes.
      pendingAcks.set(requestId, { callId: outcome.callId, byteLen: outcome.bytes.length });
      return attachPaymentResponseToMeta(
        {
          content: [
            {
              // An embedded resource, so the bytes survive verbatim whatever
              // the pack declares it carries. `uri` is what the challenge
              // named as the resource, so what was quoted and what was
              // delivered are the same string.
              type: "resource",
              resource: {
                uri: inv.resource,
                mimeType: outcome.contentType,
                blob: outcome.bytes.toString("base64"),
              },
            },
          ],
        },
        settleResponseFor(outcome)
      ) as { content: unknown[]; _meta?: Record<string, unknown> };
    }
  }
}

/** A refusal (or an in-progress call) as a tool error carrying the kernel's own code. */
function refusalResult(
  code: string,
  callId?: string,
  detail?: string,
  extra?: Record<string, unknown>
): { content: unknown[]; isError: true } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          code,
          ...(callId ? { callId } : {}),
          ...(detail ? { detail } : {}),
          ...extra,
        }),
      },
    ],
    isError: true,
  };
}

/**
 * The kernel's requirements as an x402 `PaymentRequired`.
 *
 * Every field is copied, none is computed: `amount` is the manifest's
 * priceAtomic, `resource.url` is the manifest's pathTemplate. `challengeEpoch`
 * rides in `extensions` — the MCP analog of the `x-challenge-epoch` header
 * the HTTP surface sends, and the only place it can go without pretending it
 * is a scheme parameter.
 */
function paymentRequiredFor(outcome: Extract<KernelOutcome, { kind: "challenge" }>): PaymentRequired {
  const r = outcome.requirements;
  return {
    x402Version: 2,
    error: outcome.code,
    resource: { url: r.resource, description: r.description },
    accepts: [
      {
        scheme: r.scheme,
        // The manifest publishes CAIP-2 strings ("eip155:84532"); x402's own
        // type is the narrower template form. A cast, because reformatting a
        // manifest value on its way out would make this file its editor.
        network: r.network as Network,
        asset: r.asset,
        amount: r.amountAtomic,
        payTo: r.payTo,
        maxTimeoutSeconds: r.maxTimeoutSeconds,
        extra: {},
      },
    ],
    extensions: { challengeEpoch: outcome.challengeEpoch },
  };
}

/**
 * The ledger's receipt as an x402 `SettleResponse`.
 *
 * The facts the HTTP surface puts in `x-call-id` / `x-entitlement-expires` /
 * `x-replayed` have no header to ride on here, so they travel in `extra` —
 * inside the one published key, rather than under a second `_meta` key this
 * file would have invented.
 */
function settleResponseFor(outcome: Extract<KernelOutcome, { kind: "delivered" }>): SettleResponse {
  const r = outcome.receipt as {
    transaction: string | null;
    network: string;
    asset: string;
    amountAtomic: string;
    payer: string | null;
    payTo: string;
  };
  return {
    success: true,
    // x402 types `transaction` as a required string; a facilitator that
    // settles without one (our stub, and any non-chain settlement) leaves it
    // null in the ledger. Empty string is the honest rendering of "settled,
    // no transaction hash" — inventing one would be worse.
    transaction: r.transaction ?? "",
    network: r.network as Network,
    ...(r.payer ? { payer: r.payer } : {}),
    amount: r.amountAtomic,
    extra: {
      asset: r.asset,
      payTo: r.payTo,
      callId: outcome.callId,
      entitlementExpiresAt: outcome.entitlementExpiresAt,
      replayed: outcome.replayed,
    },
  };
}

// ─── plumbing ────────────────────────────────────────────────────────────────

const TOO_LARGE = Symbol("body-too-large");
const UNPARSEABLE = Symbol("body-unparseable");

/**
 * Read and parse the POST body ourselves so the SDK gets a `parsedBody` and
 * we get the JSON-RPC ids on it — which is how a finished response is matched
 * back to the delivery it carried. Capped, because an uncapped read on a paid
 * endpoint is a way to spend our memory for free.
 */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > BODY_CAP) return TOO_LARGE;
    chunks.push(buf);
  }
  if (total === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return UNPARSEABLE;
  }
}

/** The JSON-RPC request ids a body carries — one message or a batch of them. */
function requestIdsIn(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  const ids: string[] = [];
  for (const m of messages) {
    if (m === null || typeof m !== "object") continue;
    const id = (m as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number") ids.push(String(id));
  }
  return ids;
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": payload.length,
    "cache-control": "no-store", // paid content must never be cached by an intermediary
  });
  res.end(payload);
}

/** A transport-level refusal, in the same envelope the SDK's own gates use. */
function jsonRpcError(res: http.ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}
