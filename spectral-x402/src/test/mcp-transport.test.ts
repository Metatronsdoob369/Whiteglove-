/**
 * mcp-transport.test.ts — the MCP spoke, exercised for real.
 *
 * A real kernel (StubFacilitator, real sealed packs, real SQLite ledger)
 * behind a real listener on an ephemeral port, driven by the MCP SDK's own
 * client over Streamable HTTP. Nothing in this file mocks anything this
 * repo wrote: when a test says "the client got the bytes", a client got the
 * bytes over a socket.
 *
 * What is pinned here:
 *   - tools/list IS the generated artifact, byte for byte
 *   - the paymentId lift (published inputSchema declares it; the kernel's
 *     strict argSchema does not accept it)
 *   - challenge / delivery / replay / refusal rendering
 *   - the transport-level gates that are HTTP-status cases: TLS posture,
 *     Origin allowlist, session lifecycle
 *   - the entitlement boundary at expiry−1 / expiry / expiry+1, on an
 *     injected clock — no test in this file sleeps
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  attachPaymentToMeta,
  extractPaymentRequiredFromError,
  MCP_PAYMENT_RESPONSE_META_KEY,
} from "@x402/mcp";
import { bootMcp, type BootedMcp, type McpBootOptions } from "../mcp-server.js";
import { bootKernelOnly } from "../server.js";
import { buildRoutes, createPaidMcpServer, SESSION_IDLE_MS, type McpOptions } from "../transports/mcp.js";
import { StubFacilitator } from "../facilitator.js";

const MANIFESTS = path.resolve(__dirname, "../../../manifests");
const PACKS = path.resolve(__dirname, "../../packs");
const PAY_TO = "0x0000000000000000000000000000000000000dev";
const MOUNT = "roblox-luau";
const TOOL = "roblox_luau__tile_fetch";
const PRICE = "500";
const NETWORK = "eip155:84532";
const RETRY_ENTITLEMENT_MS = 86_400_000;

/** The published contract, read straight off disk — the same file boot verifies. */
const PUBLISHED = JSON.parse(readFileSync(path.join(MANIFESTS, "mcp-tools.json"), "utf8")) as {
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
};

/**
 * A fixed synthetic wall clock, mid-day UTC.
 *
 * Mid-day matters: the ledger buckets settled value by UTC day, and a base
 * near midnight would have `expiry+1` land in a different day than the test
 * intended. A fixed constant also means these assertions do not change
 * meaning tomorrow.
 */
const T0 = Date.UTC(2026, 7, 6, 12, 0, 0);

let seq = 0;
const paymentId = () => `pay-mcp-${T0}-${String(seq++).padStart(4, "0")}`;

/**
 * The x402 wire envelope a paying client sends in `_meta["x402/payment"]`.
 *
 * `payload` is the scheme-specific slot, and what our scheme puts there is
 * the same flat payload the HTTP surface carries in `X-Payment`. No
 * `expiresAt`: the StubFacilitator checks that one against the real wall
 * clock, which has nothing to do with the ledger clock these tests inject.
 */
function paymentEnvelope(nonce: string) {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: NETWORK,
      asset: "USDC",
      amount: PRICE,
      payTo: PAY_TO,
      maxTimeoutSeconds: 120,
      extra: {},
    },
    payload: {
      scheme: "exact",
      network: NETWORK,
      payer: "0xBUYER",
      nonce,
      amountAtomic: PRICE,
      asset: "USDC",
      payTo: PAY_TO,
    },
  } as Parameters<typeof attachPaymentToMeta>[1];
}

interface ToolCallResult {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

interface Ctx {
  b: BootedMcp;
  url: string;
  port: number;
  facilitator: StubFacilitator;
  cid: (i: number) => string;
  /** Open an MCP session; every client opened here is closed on teardown. */
  open: () => Promise<{ client: Client; transport: StreamableHTTPClientTransport }>;
}

async function withMcp(fn: (ctx: Ctx) => Promise<void>, over: Partial<McpBootOptions> = {}): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "x402-mcp-"));
  const facilitator = new StubFacilitator("valid");
  const b = await bootMcp({
    manifestsDir: MANIFESTS,
    packsDir: PACKS,
    ledgerPath: path.join(dir, "ledger.db"),
    port: 0,
    facilitator,
    requireTls: false,
    payToOverride: PAY_TO,
    ...over,
  });
  await new Promise<void>((r) => b.server.listen(0, "127.0.0.1", r));
  const port = (b.server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/mcp`;
  const tiles = b.mounts.get(MOUNT)!.substrate.getManifest().tiles as string[];
  const opened: Client[] = [];

  try {
    await fn({
      b,
      url,
      port,
      facilitator,
      cid: (i) => tiles[i],
      open: async () => {
        const client = new Client({ name: "x402-test-client", version: "0.0.0" });
        const transport = new StreamableHTTPClientTransport(new URL(url));
        await client.connect(transport);
        opened.push(client);
        return { client, transport };
      },
    });
  } finally {
    for (const c of opened) await c.close().catch(() => undefined);
    b.close();
    // Keep-alive sockets would otherwise hold the listener (and the event
    // loop) open past the end of the test.
    b.server.closeAllConnections();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Bounded poll — the delivery ack fires when OUR response finishes, not when the client's read does. */
async function waitFor<T>(what: string, probe: () => T | undefined): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const v = probe();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A paid tool call, with the payment in `_meta` and the paymentId in the arguments. */
async function paidCall(
  client: Client,
  args: Record<string, unknown>,
  nonce: string
): Promise<ToolCallResult> {
  const params = attachPaymentToMeta({ name: TOOL, arguments: args }, paymentEnvelope(nonce));
  return (await client.callTool(params as Parameters<Client["callTool"]>[0])) as unknown as ToolCallResult;
}

function refusalBody(res: ToolCallResult): { code: string; callId?: string; detail?: string } {
  assert.equal(res.isError, true, "a refusal must be marked isError");
  return JSON.parse(res.content[0].text as string);
}

function deliveredBytes(res: ToolCallResult): Buffer {
  assert.notEqual(res.isError, true, `expected a delivery, got ${JSON.stringify(res.content)}`);
  const item = res.content[0] as { type: string; resource: { blob: string; mimeType: string; uri: string } };
  assert.equal(item.type, "resource");
  return Buffer.from(item.resource.blob, "base64");
}

function paymentResponse(res: ToolCallResult): Record<string, unknown> {
  const pr = res._meta?.[MCP_PAYMENT_RESPONSE_META_KEY] as Record<string, unknown> | undefined;
  assert.ok(pr, "a delivery must carry the receipt under the published payment-response key");
  return pr;
}

// ─── (a) the published contract is the contract ──────────────────────────────

test("mcp: tools/list is the generated artifact, verbatim", async () => {
  await withMcp(async ({ open }) => {
    const { client } = await open();
    const listed = await client.listTools();
    assert.deepEqual(listed.tools, PUBLISHED.tools, "tools/list must not differ from mcp-tools.json in any field");
    // Guard the guard: an empty artifact would make the deepEqual vacuous.
    assert.equal(listed.tools.length, 6, "three operations per mount, two mounts");
  });
});

test("mcp: the tool-name map refuses to construct if it disagrees with the artifact, both ways", async () => {
  await withMcp(async ({ b }) => {
    // Construction succeeded above with the real artifact; these are the two
    // ways it must NOT succeed.
    assert.throws(
      () => buildRoutes(b.kernel, [...b.mcpTools, { name: "ghost__tool", description: "", inputSchema: {} }]),
      /no live mount operation/,
      "a published tool we cannot serve must refuse the server, not 404 at call time"
    );
    assert.throws(
      () => buildRoutes(b.kernel, b.mcpTools.filter((t) => t.name !== TOOL)),
      /not published in mcp-tools\.json/,
      "a paid operation reachable over MCP but absent from our contract must refuse the server"
    );
  });
});

test("mcp: an unknown tool is refused at the edge, before any kernel work", async () => {
  await withMcp(async ({ open, facilitator }) => {
    const { client } = await open();
    await assert.rejects(
      client.callTool({ name: "no_such__tool", arguments: {} }),
      (e: Error & { code?: number }) => {
        assert.equal(e.code, -32602, "InvalidParams — there is no mount or operation for the kernel to refuse");
        assert.ok(!/no_such__tool/.test(e.message), "the caller's own text is never echoed back");
        return true;
      }
    );
    assert.equal(facilitator.verifyCalls, 0);
  });
});

// ─── (b) the challenge ───────────────────────────────────────────────────────

test("mcp: an unpaid call is a 402 JSON-RPC error carrying the kernel's requirements and challengeEpoch", async () => {
  await withMcp(async ({ open, cid, b }) => {
    const { client } = await open();
    await assert.rejects(
      client.callTool({ name: TOOL, arguments: { cid: cid(0) } }),
      (e: Error & { code?: number; data?: unknown }) => {
        assert.equal(e.code, 402);

        // Parsed by x402's OWN zod schema, so this asserts the challenge is
        // schema-valid x402 — not merely shaped the way this test expects.
        const pr = extractPaymentRequiredFromError(e);
        assert.ok(pr, "the payment requirements must survive the JSON-RPC round trip intact");
        assert.equal(pr.x402Version, 2);
        assert.equal(pr.error, "payment_id_missing", "the code is the kernel's, not this edge's");
        assert.equal(pr.resource.url, "/roblox-luau/tile/{cid}", "the resource is the manifest's own pathTemplate");
        assert.equal(pr.accepts.length, 1);
        assert.equal(pr.accepts[0].amount, PRICE, "the price is the manifest's priceAtomic");
        assert.equal(pr.accepts[0].network, NETWORK);
        assert.equal(pr.accepts[0].payTo, PAY_TO);
        assert.equal(
          (pr.extensions as { challengeEpoch?: string } | undefined)?.challengeEpoch,
          b.mounts.get(MOUNT)!.challengeEpoch
        );
        return true;
      }
    );
  });
});

test("mcp: a paymentId with no payment gets payment_required — proving the lift reached inv.paymentId", async () => {
  await withMcp(async ({ open, cid }) => {
    const { client } = await open();
    await assert.rejects(
      client.callTool({ name: TOOL, arguments: { cid: cid(0), paymentId: paymentId() } }),
      (e: Error & { code?: number }) => {
        const pr = extractPaymentRequiredFromError(e);
        // payment_id_missing would mean the paymentId never left the tool
        // arguments; args_invalid would mean it reached the kernel's strict
        // argSchema as an argument. Neither is this.
        assert.equal(pr?.error, "payment_required");
        return true;
      }
    );
  });
});

// ─── (c) delivery ────────────────────────────────────────────────────────────

test("mcp: a paid call delivers the exact pack bytes plus the receipt under the published key", async () => {
  await withMcp(async ({ open, cid, b, facilitator }) => {
    const { client } = await open();
    const res = await paidCall(client, { cid: cid(0), paymentId: paymentId() }, "mcp-n1");

    const bytes = deliveredBytes(res);
    const expected = b.mounts.get(MOUNT)!.substrate.getTile(cid(0))!;
    assert.deepEqual(bytes, Buffer.from(expected), "the bytes must be the sealed pack's, byte for byte");

    const pr = paymentResponse(res);
    assert.equal(pr.success, true);
    assert.equal(pr.network, NETWORK);
    assert.equal(pr.amount, PRICE);
    const extra = pr.extra as Record<string, unknown>;
    assert.equal(extra.payTo, PAY_TO);
    assert.equal(extra.asset, "USDC");
    assert.equal(extra.replayed, false);
    assert.equal(typeof extra.callId, "string");
    assert.equal(facilitator.settleCalls, 1);
  });
});

test("mcp: delivery_log records this spoke's own transport", async () => {
  await withMcp(async ({ open, cid, b }) => {
    const { client } = await open();
    const res = await paidCall(client, { cid: cid(0), paymentId: paymentId() }, "mcp-n2");
    const callId = (paymentResponse(res).extra as { callId: string }).callId;

    // The ack fires when OUR response finishes, which is not synchronised
    // with the client's read completing.
    const row = await waitFor(
      "the delivery ack",
      () =>
        b.ledger.db.prepare("SELECT transport, byte_len FROM delivery_log WHERE call_id=?").get(callId) as
          | { transport: string; byte_len: number }
          | undefined
    );
    assert.equal(row.transport, "mcp");
    assert.equal(row.byte_len, deliveredBytes(res).length);
    assert.equal(b.ledger.getCall(callId)!.state, "delivered");
  });
});

test("mcp: the paymentId never reaches the kernel as an argument", async () => {
  await withMcp(async ({ open, cid }) => {
    const { client } = await open();
    // The published inputSchema REQUIRES paymentId; the kernel's argSchema is
    // strict and rejects any key it does not declare. A delivery is only
    // possible if this edge lifted it out on the way through.
    const res = await paidCall(client, { cid: cid(0), paymentId: paymentId() }, "mcp-n3");
    assert.notEqual(res.isError, true, "a leaked paymentId argument would refuse as args_invalid");

    // And the other direction: an argument the schema does not declare is
    // still refused, so the lift is a lift and not a filter.
    const junk = await paidCall(client, { cid: cid(0), paymentId: paymentId(), surprise: "x" }, "mcp-n4");
    assert.equal(refusalBody(junk).code, "args_invalid");
  });
});

// ─── (d) replay ──────────────────────────────────────────────────────────────

test("mcp: replaying a paymentId returns the same bytes and does not settle again", async () => {
  await withMcp(async ({ open, cid, facilitator }) => {
    const { client } = await open();
    const id = paymentId();
    const first = await paidCall(client, { cid: cid(1), paymentId: id }, "mcp-r1");
    assert.equal(facilitator.settleCalls, 1);

    const again = await paidCall(client, { cid: cid(1), paymentId: id }, "mcp-r1");
    assert.deepEqual(deliveredBytes(again), deliveredBytes(first), "a replay is the same bytes");
    assert.equal((paymentResponse(again).extra as { replayed: boolean }).replayed, true);
    assert.equal(facilitator.settleCalls, 1, "a replay must never move money a second time");
  });
});

// ─── (e) the entitlement boundary, on an injected clock ──────────────────────

test("mcp: replay delivers at expiry−1 and is refused at expiry and expiry+1", async () => {
  let clock = T0;
  await withMcp(
    async ({ open, cid }) => {
      const { client } = await open();
      const id = paymentId();
      const first = await paidCall(client, { cid: cid(2), paymentId: id }, "mcp-e1");
      const expiry = (paymentResponse(first).extra as { entitlementExpiresAt: number }).entitlementExpiresAt;
      assert.equal(expiry, T0 + RETRY_ENTITLEMENT_MS, "the mount's declared retry entitlement, off the injected clock");

      clock = expiry - 1;
      const before = await paidCall(client, { cid: cid(2), paymentId: id }, "mcp-e1");
      assert.deepEqual(deliveredBytes(before), deliveredBytes(first), "one millisecond short of expiry still delivers");

      clock = expiry;
      assert.equal(
        refusalBody(await paidCall(client, { cid: cid(2), paymentId: id }, "mcp-e1")).code,
        "entitlement_expired",
        "AT expiry the entitlement is spent — the boundary is inclusive"
      );

      clock = expiry + 1;
      assert.equal(
        refusalBody(await paidCall(client, { cid: cid(2), paymentId: id }, "mcp-e1")).code,
        "entitlement_expired"
      );
    },
    { now: () => clock }
  );
});

// ─── (f) transport-level gates: the HTTP-status cases ────────────────────────

/** A raw Streamable HTTP initialize, so the gates can be probed without the SDK client. */
function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
  });
}

const RAW_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

/**
 * A POST over `node:http` rather than `fetch`.
 *
 * `Host` is a forbidden header name for `fetch`, which silently drops any
 * override — so the one gate that is ABOUT the Host header cannot be probed
 * with it. This client sends exactly the headers it is given.
 */
function rawPost(
  port: number,
  headers: Record<string, string>,
  body: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(body) } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("mcp: TLS posture is the paid HTTP surface's, code for code", async () => {
  await withMcp(
    async ({ url }) => {
      const cleartext = await fetch(url, { method: "POST", headers: RAW_HEADERS, body: initializeBody() });
      assert.equal(cleartext.status, 400);
      assert.equal(((await cleartext.json()) as { code: string }).code, "tls_required", "fail closed, same code as http.ts");

      const terminated = await fetch(url, {
        method: "POST",
        headers: { ...RAW_HEADERS, "x-forwarded-proto": "https" },
        body: initializeBody(),
      });
      assert.equal(terminated.status, 200, "a TLS-terminated request proceeds");
    },
    { requireTls: true }
  );
});

test("mcp: a foreign Origin is refused before a session is allocated; our own is not", async () => {
  await withMcp(async ({ url, port }) => {
    const foreign = await fetch(url, {
      method: "POST",
      headers: { ...RAW_HEADERS, origin: "http://evil.example" },
      body: initializeBody(),
    });
    assert.equal(foreign.status, 403);
    assert.match(((await foreign.json()) as { error: { message: string } }).error.message, /Origin/);
    assert.equal(foreign.headers.get("mcp-session-id"), null, "a rejected rebinding attempt gets no session");

    const own = await fetch(url, {
      method: "POST",
      headers: { ...RAW_HEADERS, origin: `http://127.0.0.1:${port}` },
      body: initializeBody(),
    });
    assert.equal(own.status, 200);
    assert.ok(own.headers.get("mcp-session-id"), "our own loopback origin is allowlisted");
  });
});

test("mcp: a foreign Host is refused, and our own is not", async () => {
  await withMcp(async ({ port }) => {
    const foreign = await rawPost(port, { ...RAW_HEADERS, host: "attacker.example" }, initializeBody());
    assert.equal(foreign.status, 403);
    assert.match((JSON.parse(foreign.body) as { error: { message: string } }).error.message, /Host/);

    // Positive control: the same request with the real Host is served, so the
    // assertion above is about the header and not about the raw client.
    const own = await rawPost(port, { ...RAW_HEADERS, host: `127.0.0.1:${port}` }, initializeBody());
    assert.equal(own.status, 200);
  });
});

// ─── (g) session lifecycle ───────────────────────────────────────────────────

test("mcp: a second call reuses the session the server issued", async () => {
  await withMcp(async ({ open, cid, facilitator }) => {
    const { client, transport } = await open();
    const sid = transport.sessionId;
    assert.ok(sid, "initialize must yield a server-issued session id");

    await paidCall(client, { cid: cid(0), paymentId: paymentId() }, "mcp-s1");
    await paidCall(client, { cid: cid(1), paymentId: paymentId() }, "mcp-s2");
    assert.equal(transport.sessionId, sid, "both calls rode the same session");
    assert.equal(facilitator.settleCalls, 2, "two distinct paymentIds, two settlements");

    // A second client is a different session — the rate-limit identity this
    // edge vouches for is per-session, not per-process.
    const second = await open();
    assert.notEqual(second.transport.sessionId, sid);
  });
});

test("mcp: a bogus session id is refused, not quietly given a fresh session", async () => {
  await withMcp(async ({ url }) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...RAW_HEADERS, "mcp-session-id": "not-a-real-session" },
      body: initializeBody(),
    });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("mcp-session-id"), null);
  });
});

test("mcp: DELETE ends the session and the id stops working", async () => {
  await withMcp(async ({ url, port }) => {
    const init = await fetch(url, {
      method: "POST",
      headers: { ...RAW_HEADERS, origin: `http://127.0.0.1:${port}` },
      body: initializeBody(),
    });
    const sid = init.headers.get("mcp-session-id")!;
    assert.ok(sid);

    const del = await fetch(url, { method: "DELETE", headers: { "mcp-session-id": sid } });
    assert.ok(del.status < 300, `DELETE should end the session, got ${del.status}`);

    const after = await fetch(url, {
      method: "POST",
      headers: { ...RAW_HEADERS, "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(after.status, 404, "the session id must die with the session");
  });
});

// ─── (i) the session budget ──────────────────────────────────────────────────

/**
 * The transport built directly, so a test can set the two knobs `bootMcp`
 * leaves at their defaults: the session ceiling, and the clock session
 * liveness is measured against.
 *
 * That clock is deliberately NOT the ledger's — the entitlement test above
 * steps the ledger's a day at a time, which would make every session look
 * abandoned. Two questions about time, two clocks.
 */
async function withTransport(
  fn: (ctx: { port: number }) => Promise<void>,
  over: Partial<McpOptions> = {}
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "x402-mcp-cap-"));
  const core = await bootKernelOnly({
    manifestsDir: MANIFESTS,
    packsDir: PACKS,
    ledgerPath: path.join(dir, "ledger.db"),
    facilitator: new StubFacilitator("valid"),
    payToOverride: PAY_TO,
  });
  const server = createPaidMcpServer(core.kernel, { tools: core.mcpTools, requireTls: false, ...over });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn({ port: (server.address() as AddressInfo).port });
  } finally {
    server.close();
    server.closeAllConnections();
    core.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const toolsListBody = () => JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} });
const withSession = (sid: string) => ({ ...RAW_HEADERS, "mcp-session-id": sid });

/** initialize + the initialized notification, returning the server-issued id. */
async function openRaw(port: number): Promise<string> {
  const init = await rawPost(port, RAW_HEADERS, initializeBody());
  assert.equal(init.status, 200, `initialize should have been served: ${init.body}`);
  const sid = init.headers["mcp-session-id"] as string;
  assert.ok(sid);
  await rawPost(port, withSession(sid), JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return sid;
}

test("mcp: session allocation is capped, and a refused initialize costs no session", async () => {
  await withTransport(
    async ({ port }) => {
      const a = await openRaw(port);
      const b = await openRaw(port);

      const over = await rawPost(port, RAW_HEADERS, initializeBody());
      assert.equal(over.status, 503, "initialize is the one request that allocates without paying — it needs a ceiling");
      assert.equal(over.headers["mcp-session-id"], undefined, "a refused initialize must not have allocated a pair");

      // The ceiling refuses NEW sessions; it does not disturb live ones.
      for (const sid of [a, b]) {
        assert.equal((await rawPost(port, withSession(sid), toolsListBody())).status, 200);
      }
    },
    { maxSessions: 2 }
  );
});

test("mcp: an abandoned session is evicted, freeing its slot, and its id then reads as unknown", async () => {
  let clock = T0;
  await withTransport(
    async ({ port }) => {
      const sid = await openRaw(port);
      assert.equal((await rawPost(port, withSession(sid), toolsListBody())).status, 200);
      assert.equal(
        (await rawPost(port, RAW_HEADERS, initializeBody())).status,
        503,
        "at capacity while the first session is live"
      );

      clock = T0 + SESSION_IDLE_MS + 1;

      // The slot came back — which is only true if the entry actually left
      // the map, not merely if a stale id stopped resolving.
      const replacement = await rawPost(port, RAW_HEADERS, initializeBody());
      assert.equal(replacement.status, 200);
      assert.notEqual(replacement.headers["mcp-session-id"], sid);

      assert.equal(
        (await rawPost(port, withSession(sid), toolsListBody())).status,
        404,
        "an evicted id behaves exactly like one that never existed"
      );
    },
    { maxSessions: 1, now: () => clock }
  );
});

test("mcp: activity refreshes the TTL — a busy session outlives a quiet one", async () => {
  let clock = T0;
  await withTransport(
    async ({ port }) => {
      const busy = await openRaw(port);
      const quiet = await openRaw(port);

      // Just short of the TTL: both still live, and this touches `busy`.
      clock = T0 + SESSION_IDLE_MS - 1;
      assert.equal((await rawPost(port, withSession(busy), toolsListBody())).status, 200);

      // Past the TTL as measured from T0, but not from `busy`'s last request.
      clock = T0 + SESSION_IDLE_MS + 1;
      assert.equal((await rawPost(port, withSession(busy), toolsListBody())).status, 200, "the busy session survives");
      assert.equal((await rawPost(port, withSession(quiet), toolsListBody())).status, 404, "the quiet one does not");
    },
    { now: () => clock }
  );
});

// ─── (j) a malformed payment is a payment fault, not a challenge ─────────────

test("mcp: a present but undecodable x402/payment is refused, not downgraded to a challenge", async () => {
  await withMcp(async ({ open, cid }) => {
    const { client } = await open();
    const res = (await client.callTool({
      name: TOOL,
      arguments: { cid: cid(0), paymentId: paymentId() },
      _meta: { "x402/payment": { not: "an envelope" } },
    })) as unknown as ToolCallResult;
    assert.equal(refusalBody(res).code, "payment_invalid");
  });
});

test("mcp: an envelope whose payload carries no nonce is refused before the ledger digests it", async () => {
  await withMcp(async ({ open, cid, facilitator }) => {
    const { client } = await open();
    const res = (await client.callTool({
      name: TOOL,
      arguments: { cid: cid(0), paymentId: paymentId() },
      _meta: {
        "x402/payment": { x402Version: 2, accepted: paymentEnvelope("x").accepted, payload: { scheme: "exact" } },
      },
    })) as unknown as ToolCallResult;
    assert.equal(refusalBody(res).code, "payment_invalid");
    assert.equal(facilitator.verifyCalls, 0, "a payload the ledger cannot digest never reaches the facilitator");
  });
});
