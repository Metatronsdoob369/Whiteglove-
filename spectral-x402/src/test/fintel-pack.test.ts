/**
 * fintel-pack.test.ts — Hermes-Spectral Mission 1, made falsifiable.
 *
 * The financial-intel loop's own record — closed trades, per-strategy
 * performance, the portfolio snapshot — is a sealed pack behind the paid
 * kernel, declared in the manifest like any other mount. These tests pin
 * the mission's done-criterion: a paid call delivers the arena record over
 * BOTH doors on loopback, priced by the fintel mount's own declaration.
 *
 * Real sealed pack, real ledger, real listeners; the StubFacilitator
 * substitutes only the boundary that would move money.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { attachPaymentToMeta, MCP_PAYMENT_RESPONSE_META_KEY } from "@x402/mcp";
import {
  bootKernelOnly,
  createPaidServer,
  createPaidMcpServer,
  StubFacilitator,
  type BootedKernel,
} from "../index.js";

const MANIFESTS = path.resolve(__dirname, "../../../manifests");
const PACKS = path.resolve(__dirname, "../../packs");
const PAY_TO = "0x0000000000000000000000000000000000000dev";
const NETWORK = "eip155:84532";
const MOUNT = "fintel-paper-arena";
const TILE_TOOL = "fintel_paper_arena__tile_fetch";
const TILE_PRICE = "200";
const TILE_SCHEMA_RE = /^fintel-arena-(trade|strategy|snapshot)-v1$/;

let seq = 0;
const paymentId = (): string => `pay-fin-${Date.now()}-${String(seq++).padStart(4, "0")}`;

function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "x402-fintel-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function paymentHeader(nonce: string, amountAtomic: string): string {
  return Buffer.from(
    JSON.stringify({
      scheme: "exact",
      network: NETWORK,
      payer: "0xBUYER",
      nonce,
      amountAtomic,
      asset: "USDC",
      payTo: PAY_TO,
    })
  ).toString("base64");
}

function paymentEnvelope(nonce: string, amountAtomic: string) {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: NETWORK,
      asset: "USDC",
      amount: amountAtomic,
      payTo: PAY_TO,
      maxTimeoutSeconds: 120,
      extra: {},
    },
    payload: {
      scheme: "exact",
      network: NETWORK,
      payer: "0xBUYER",
      nonce,
      amountAtomic,
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

interface Edges {
  core: BootedKernel;
  httpUrl: string;
  openMcp(): Promise<Client>;
  stop(): Promise<void>;
}

async function bootEdges(ledgerPath: string, stub: StubFacilitator): Promise<Edges> {
  const core = await bootKernelOnly({
    manifestsDir: MANIFESTS,
    packsDir: PACKS,
    ledgerPath,
    facilitator: stub,
    payToOverride: PAY_TO,
  });
  const httpServer = createPaidServer(core.kernel, { port: 0, requireTls: false, refusals: core.refusals });
  const mcpServer = createPaidMcpServer(core.kernel, { tools: core.mcpTools, requireTls: false });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => mcpServer.listen(0, "127.0.0.1", r));
  const httpUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const mcpUrl = `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/mcp`;
  const clients: Client[] = [];
  return {
    core,
    httpUrl,
    async openMcp() {
      const client = new Client({ name: "x402-fintel-test", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
      clients.push(client);
      return client;
    },
    async stop() {
      for (const c of clients) await c.close().catch(() => undefined);
      httpServer.close();
      mcpServer.close();
      httpServer.closeAllConnections();
      mcpServer.closeAllConnections();
      core.close();
    },
  };
}

test("fintel: the paper-arena mount boots from the manifest and serves its own record's shape", async () => {
  await withTmpDir(async (dir) => {
    const e = await bootEdges(path.join(dir, "ledger.db"), new StubFacilitator("valid"));
    try {
      const mount = e.core.mounts.get(MOUNT);
      assert.ok(mount, "the manifest declaration alone must produce a live mount");
      assert.equal(mount.substrate.packId, "fintel-paper-arena-2026-08");
      assert.equal(mount.substrate.payloadContentType, "application/json");
      const manifest = mount.substrate.getManifest() as { tiles: string[]; domain: string; tile_count: number };
      assert.equal(manifest.domain, MOUNT);
      assert.equal(manifest.tile_count, manifest.tiles.length, "tile_count must agree with the tiles list");
      assert.ok(manifest.tiles.length >= 3, "at least one trade, one strategy, one snapshot tile");
    } finally {
      await e.stop();
    }
  });
});

test("fintel: a paid call delivers an arena record over the HTTP door at the mount's own price", async () => {
  await withTmpDir(async (dir) => {
    const stub = new StubFacilitator("valid");
    const e = await bootEdges(path.join(dir, "ledger.db"), stub);
    try {
      const cid = (e.core.mounts.get(MOUNT)!.substrate.getManifest().tiles as string[])[0];
      const res = await fetch(`${e.httpUrl}/${MOUNT}/tile/${cid}`, {
        headers: { "x-payment-id": paymentId(), "x-payment": paymentHeader("fin-http-1", TILE_PRICE) },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json");
      const record = (await res.json()) as { schema: string; domain: string };
      assert.match(record.schema, TILE_SCHEMA_RE, "the bytes are the arena's own record, not filler");
      assert.equal(record.domain, MOUNT);
      assert.equal(stub.settleCalls, 1, "delivery at 200 proves the fintel mount's declared price is in force");
    } finally {
      await e.stop();
    }
  });
});

test("fintel: the same record is sold through the MCP door and carries the receipt", async () => {
  await withTmpDir(async (dir) => {
    const stub = new StubFacilitator("valid");
    const e = await bootEdges(path.join(dir, "ledger.db"), stub);
    try {
      const client = await e.openMcp();
      const listed = await client.listTools();
      assert.ok(
        listed.tools.some((t) => t.name === TILE_TOOL),
        "the fintel tools must appear in tools/list"
      );

      const cid = (e.core.mounts.get(MOUNT)!.substrate.getManifest().tiles as string[])[0];
      const base = { name: TILE_TOOL, arguments: { cid, paymentId: paymentId() } };
      const params = attachPaymentToMeta(base, paymentEnvelope("fin-mcp-1", TILE_PRICE));
      const res = (await client.callTool(params as Parameters<Client["callTool"]>[0])) as unknown as ToolCallResult;

      assert.notEqual(res.isError, true, `expected a delivery, got ${JSON.stringify(res.content)}`);
      const item = res.content[0] as { type: string; resource: { blob: string } };
      assert.equal(item.type, "resource");
      const bytes = Buffer.from(item.resource.blob, "base64");
      assert.deepEqual(
        bytes,
        Buffer.from(e.core.mounts.get(MOUNT)!.substrate.getTile(cid)!),
        "the MCP door serves the sealed pack's exact bytes"
      );
      const receipt = res._meta?.[MCP_PAYMENT_RESPONSE_META_KEY] as Record<string, unknown> | undefined;
      assert.ok(receipt, "a delivery must carry the receipt under the published payment-response key");
      assert.equal(stub.settleCalls, 1);
    } finally {
      await e.stop();
    }
  });
});
