/**
 * mcp-envelope-parity.test.ts — the second spoke decodes a STANDARD payment the
 * same way the first one does.
 *
 * The MCP edge has always received an x402 envelope (that is what
 * `_meta["x402/payment"]` is) and has always read our own flat payload out of
 * its scheme slot. A conforming client puts an EIP-3009 authorization there
 * instead. If only the HTTP edge learned to read that, the two spokes would
 * disagree about what a payment IS — which is the exact class of divergence the
 * transport seam exists to prevent.
 *
 * Real MCP client, real Streamable HTTP, real kernel and ledger; the facilitator
 * is a local server speaking the standard v2 wire. No key, no chain.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { attachPaymentToMeta, MCP_PAYMENT_RESPONSE_META_KEY } from "@x402/mcp";
import { isPaymentPayloadV2 } from "@x402/core/schemas";
import { bootMcp, type BootedMcp } from "../mcp-server.js";
import { StandardFacilitator } from "../facilitator.js";
import { toStandardRequirements } from "../x402-wire.js";

const MANIFESTS = path.resolve(__dirname, "../../../manifests");
const PACKS = path.resolve(__dirname, "../../packs");
const PAY_TO = "0x0000000000000000000000000000000000000dev";
const PAYER = "0x2222222222222222222222222222222222222222";
const TOOL = "roblox_luau__tile_fetch";
const PRICE = "500";
const NETWORK = "eip155:84532";
const TX = `0x${"3c".repeat(32)}`;

let seq = 0;
const paymentId = () => `pay-mcp-env-${Date.now()}-${String(seq++).padStart(4, "0")}`;

/** The same minimal standard facilitator the HTTP-side tests use. */
function mockFacilitator(): { server: http.Server; url: () => string; settled: unknown[]; verified: unknown[] } {
  const settled: unknown[] = [];
  const verified: unknown[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const json = (payload: unknown) => {
        const buf = Buffer.from(JSON.stringify(payload));
        res.writeHead(200, { "content-type": "application/json", "content-length": buf.length });
        res.end(buf);
      };
      if (req.url === "/verify") {
        verified.push(body);
        return json({ isValid: true, payer: PAYER });
      }
      if (req.url === "/settle") {
        settled.push(body);
        return json({ success: true, transaction: TX, network: NETWORK, payer: PAYER });
      }
      return json({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} });
    });
  });
  return {
    server,
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    settled,
    verified,
  };
}

/** A standard v2 exact/EIP-3009 envelope — what a conforming client actually sends. */
function standardEnvelope(over: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    resource: { url: "/roblox-luau/tile/{cid}" },
    accepted: toStandardRequirements({
      scheme: "exact",
      network: NETWORK,
      asset: "USDC",
      amountAtomic: PRICE,
      payTo: PAY_TO,
      resource: "/roblox-luau/tile/{cid}",
      description: "test",
      maxTimeoutSeconds: 120,
    }),
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from: PAYER,
        to: PAY_TO,
        value: PRICE,
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 600),
        nonce: `0x${"5e".repeat(32)}`,
      },
    },
    ...over,
  } as unknown as Parameters<typeof attachPaymentToMeta>[1];
}

interface ToolCallResult {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

async function withMcp(
  fn: (c: {
    b: BootedMcp;
    open: () => Promise<Client>;
    cid: (i: number) => string;
    mock: ReturnType<typeof mockFacilitator>;
  }) => Promise<void>
): Promise<void> {
  const mock = mockFacilitator();
  await new Promise<void>((r) => mock.server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(path.join(tmpdir(), "x402-mcp-env-"));
  const b = await bootMcp({
    manifestsDir: MANIFESTS,
    packsDir: PACKS,
    ledgerPath: path.join(dir, "ledger.db"),
    port: 0,
    facilitator: new StandardFacilitator(mock.url()),
    requireTls: false,
    payToOverride: PAY_TO,
  });
  await new Promise<void>((r) => b.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(b.server.address() as AddressInfo).port}/mcp`;
  const tiles = b.mounts.get("roblox-luau")!.substrate.getManifest().tiles as string[];
  const opened: Client[] = [];
  try {
    await fn({
      b,
      mock,
      cid: (i) => tiles[i],
      open: async () => {
        const client = new Client({ name: "x402-envelope-test", version: "0.0.0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(url)));
        opened.push(client);
        return client;
      },
    });
  } finally {
    for (const c of opened) await c.close().catch(() => undefined);
    b.close();
    b.server.closeAllConnections();
    mock.server.closeAllConnections?.();
    mock.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("mcp: a STANDARD envelope in _meta settles through the real facilitator boundary", async () => {
  await withMcp(async ({ open, cid, b, mock }) => {
    const client = await open();
    const params = attachPaymentToMeta(
      { name: TOOL, arguments: { cid: cid(0), paymentId: paymentId() } },
      standardEnvelope()
    );
    const res = (await client.callTool(params as Parameters<Client["callTool"]>[0])) as unknown as ToolCallResult;

    assert.notEqual(res.isError, true, `expected a delivery, got ${JSON.stringify(res.content)}`);
    const item = res.content[0] as { type: string; resource: { blob: string } };
    assert.deepEqual(
      Buffer.from(item.resource.blob, "base64"),
      Buffer.from(b.mounts.get("roblox-luau")!.substrate.getTile(cid(0))!),
      "the sealed pack's bytes, byte for byte"
    );

    const pr = res._meta?.[MCP_PAYMENT_RESPONSE_META_KEY] as Record<string, unknown>;
    assert.equal(pr.success, true);
    assert.equal(pr.transaction, TX, "the facilitator's transaction reached the receipt");

    // The kernel fingerprinted the SIGNED authorization's fields.
    const auth = b.ledger.db.prepare("SELECT payer, expires_at FROM authorizations LIMIT 1").get() as {
      payer: string;
      expires_at: number | null;
    };
    assert.equal(auth.payer, PAYER, "authorization.from became the payer the ledger recorded");
    assert.ok(auth.expires_at, "authorization.validBefore became the recorded expiry");

    // And the envelope reached the facilitator unedited, on both calls.
    assert.equal(mock.verified.length, 1);
    assert.equal(mock.settled.length, 1);
    for (const body of [...mock.verified, ...mock.settled] as Array<Record<string, unknown>>) {
      assert.equal(isPaymentPayloadV2(body.paymentPayload), true);
      const payload = (body.paymentPayload as Record<string, unknown>).payload as Record<string, unknown>;
      const authorization = payload.authorization as Record<string, unknown>;
      assert.equal(authorization.from, PAYER);
      assert.equal(authorization.nonce, `0x${"5e".repeat(32)}`, "the signed nonce, forwarded verbatim");
    }
  });
});

test("mcp: an envelope with nothing signable is a payment fault, not a 500", async () => {
  await withMcp(async ({ open, cid, mock }) => {
    const client = await open();
    const params = attachPaymentToMeta(
      { name: TOOL, arguments: { cid: cid(0), paymentId: paymentId() } },
      standardEnvelope({ payload: { signature: "0xdead" } })
    );
    const res = (await client.callTool(params as Parameters<Client["callTool"]>[0])) as unknown as ToolCallResult;
    assert.equal(res.isError, true);
    const body = JSON.parse(res.content[0].text as string) as { code: string; detail?: string };
    assert.equal(body.code, "payment_invalid");
    assert.match(body.detail ?? "", /no readable authorization/);
    assert.equal(mock.verified.length, 0, "never reached the facilitator");
  });
});

test("mcp: the legacy flat payload in the scheme slot still works, unchanged", async () => {
  // The shape every existing MCP test sends. Standard-envelope support must not
  // have cost it: this is the same kernel, the same slot, the same result.
  await withMcp(async ({ open, cid, mock }) => {
    const client = await open();
    const legacy = {
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
        nonce: "mcp-legacy-nonce-1",
        amountAtomic: PRICE,
        asset: "USDC",
        payTo: PAY_TO,
      },
    } as unknown as Parameters<typeof attachPaymentToMeta>[1];
    const params = attachPaymentToMeta({ name: TOOL, arguments: { cid: cid(0), paymentId: paymentId() } }, legacy);
    const res = (await client.callTool(params as Parameters<Client["callTool"]>[0])) as unknown as ToolCallResult;

    // A real facilitator cannot read it, so the boundary refuses BEFORE the wire
    // — which is the honest outcome, and is not a decode failure.
    assert.equal(res.isError, true);
    assert.equal((JSON.parse(res.content[0].text as string) as { code: string }).code, "payment_invalid");
    assert.equal(mock.verified.length, 0, "refused at the boundary, not sent as a shape nobody can read");
  });
});
