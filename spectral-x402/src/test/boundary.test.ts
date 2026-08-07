/**
 * boundary.test.ts — the boundary claims, made falsifiable.
 *
 * The other suites pin behavior per spoke. This one pins the claims the
 * two-spoke shape is FOR, and every one of them is a claim about a boundary:
 *
 *   (a) extension    — a capability nobody in this repo wrote becomes callable
 *                      and discoverable through the public API plus the
 *                      manifest. Reachability is the assertion; "no file was
 *                      edited" is not something a test can prove.
 *   (b) parity       — HTTP and MCP are two doors onto ONE kernel: buy through
 *                      one, replay through the other, and it is the same call,
 *                      the same bytes, the same receipt, settled once.
 *   (c) config-only  — a THIRD mount is a manifest edit. Zero adapters, zero
 *                      code, `BUILTIN_ADAPTERS` not even mentioned.
 *   (d) both spokes  — one delivery_log, one ledger, `transport` telling the
 *                      truth about which door each write left by.
 *   (e) restart      — the entitlement outlives the process, and a fresh
 *                      facilitator is never asked for money a second time.
 *   (f) no drift     — a generated artifact edited without re-sealing
 *                      `generated.lock` refuses boot. That digest check is the
 *                      anti-drift mechanism; the generator-side half of this
 *                      evidence is `spectral-config`'s own `check:all`, which
 *                      is a build step and deliberately not shelled out to
 *                      from inside a unit test.
 *
 * Nothing here mocks anything this repo wrote: real sealed packs, a real
 * SQLite ledger, real listeners on ephemeral ports, the MCP SDK's own client
 * over a socket. The StubFacilitator substitutes exactly one boundary — the
 * one that would otherwise move money — and its call counters are what the
 * "settled once" assertions read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { attachPaymentToMeta, MCP_PAYMENT_RESPONSE_META_KEY } from "@x402/mcp";
import {
  bootKernelOnly,
  createPaidServer,
  createPaidMcpServer,
  defineAdapter,
  BUILTIN_ADAPTERS,
  StubFacilitator,
  cidOf,
  type Adapter,
  type BootedKernel,
} from "../index.js";

const MANIFESTS = path.resolve(__dirname, "../../../manifests");
const PACKS = path.resolve(__dirname, "../../packs");
const PAY_TO = "0x0000000000000000000000000000000000000dev";
const NETWORK = "eip155:84532";
const MOUNT = "roblox-luau";
const TILE_TOOL = "roblox_luau__tile_fetch";
const TILE_PRICE = "500";

let seq = 0;
/** Clears PAYMENT_ID_MIN_LENGTH (16) by construction, and the URL-safe alphabet. */
const paymentId = (): string => `pay-bnd-${Date.now()}-${String(seq++).padStart(4, "0")}`;

function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "x402-boundary-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** Bounded poll — a delivery ack fires when OUR response finishes, not when the client's read does. */
async function waitFor<T>(what: string, probe: () => T | undefined): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const v = probe();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ─── fixture manifests: the only legitimate way to change what boots ─────────

interface RouteEntry {
  operationId: string;
  method: string;
  pathTemplate: string;
  resultKind: string;
  deadlineMs: number;
  maxResultBytes: number;
  priceAtomic: string;
}

interface MountEntry {
  mountId: string;
  edition: string;
  substrate: { packRef: string; statusListRef: string; [k: string]: unknown };
  price: { payToRef: string; [k: string]: unknown };
  routes: RouteEntry[];
  [k: string]: unknown;
}

interface RoutesArtifact {
  mounts: MountEntry[];
  [k: string]: unknown;
}

interface ToolEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolsArtifact {
  tools: ToolEntry[];
  [k: string]: unknown;
}

/**
 * A clone of the real manifests with `edit` applied, re-sealed over
 * `generated.lock`.
 *
 * BOTH artifacts a paid capability lives in are handed to the editor, because
 * a capability that exists in only one of them is not addable at all: the MCP
 * edge's route table is fail-closed in both directions, so an operation with
 * no `mcp-tools.json` entry refuses the server at construction, and a
 * published tool with no live operation refuses it too.
 *
 * `relock: false` is the drift case — the same edit with the lock left stale,
 * which is what (f) asserts boot refuses. Everything else about the fixture is
 * identical, so the relock is provably the load-bearing step.
 */
function fixtureManifests(
  dir: string,
  edit: (a: { routes: RoutesArtifact; tools: ToolsArtifact }) => void,
  opts: { relock?: boolean } = {}
): string {
  const md = path.join(dir, "manifests");
  mkdirSync(md, { recursive: true });
  cpSync(MANIFESTS, md, { recursive: true });

  const routes = JSON.parse(readFileSync(path.join(md, "x402-routes.json"), "utf8")) as RoutesArtifact;
  const tools = JSON.parse(readFileSync(path.join(md, "mcp-tools.json"), "utf8")) as ToolsArtifact;
  edit({ routes, tools });
  writeFileSync(path.join(md, "x402-routes.json"), JSON.stringify(routes, null, 2) + "\n");
  writeFileSync(path.join(md, "mcp-tools.json"), JSON.stringify(tools, null, 2) + "\n");

  if (opts.relock !== false) {
    const lock = JSON.parse(readFileSync(path.join(md, "generated.lock"), "utf8")) as {
      artifacts: Record<string, string>;
    };
    lock.artifacts["x402-routes.json"] = cidOf(routes);
    lock.artifacts["mcp-tools.json"] = cidOf(tools);
    writeFileSync(path.join(md, "generated.lock"), JSON.stringify(lock, null, 2) + "\n");
  }
  return md;
}

/** The generator's tool-naming convention, as the MCP edge documents it. */
const toolName = (mountId: string, operationId: string): string =>
  `${mountId.replace(/-/g, "_")}__${operationId}`;

// ── (a)'s fixture: one new operation on an existing mount
const ECHO_OP = "echo_ping";
const ECHO_TOOL = toolName(MOUNT, ECHO_OP);
const ECHO_PRICE = "100";

function addEchoCapability(a: { routes: RoutesArtifact; tools: ToolsArtifact }): void {
  const mount = a.routes.mounts.find((m) => m.mountId === MOUNT)!;
  mount.routes.push({
    operationId: ECHO_OP,
    method: "GET",
    // A relative shape ("echo_ping") that collides with none of the three the
    // real manifest declares — `resolveRoute` is first-match with no ambiguity
    // detection, so a colliding shape would resolve to the wrong operation.
    pathTemplate: `/${MOUNT}/${ECHO_OP}`,
    resultKind: "manifest-json",
    deadlineMs: 5,
    maxResultBytes: 64,
    priceAtomic: ECHO_PRICE,
  });
  a.tools.tools.push({
    name: ECHO_TOOL,
    description: `${ECHO_OP} over sealed pack roblox-luau-2026-08 (x402 metered, ${ECHO_PRICE} atomic USDC)`,
    // The published shape the generator emits: paymentId is declared IN the
    // tool input (the MCP edge lifts it back out), and the kernel's own strict
    // argSchema never sees it.
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["paymentId"],
      properties: { paymentId: { type: "string", pattern: "^[A-Za-z0-9_-]{16,128}$" } },
    },
  });
}

// ── (c)'s fixture: a third mount over a pack already in the tree
//
// `Substrate.load` binds a pack to a packRef and to nothing else — there is no
// mount id in a seal, and `mounts.mount_id` is the ledger's only uniqueness
// constraint (no `substrate_pack_id` uniqueness) — so a second mount can be
// configured over an ALREADY-SEALED substrate. No new pack, no new key, no
// re-seal, and no new code: a new id, new paths and its own price tier.
//
// The pack is the one the `medical-medlineplus` mount already declares, so
// this test depends on nothing the rest of the file does not already require:
// boot loads a substrate for EVERY mount in the manifest, so that pack is an
// unguarded hard dependency of every boot in this suite.
const THIRD_MOUNT = "medical-bulk";
const THIRD_SOURCE_MOUNT = "medical-medlineplus";
const THIRD_PACK = "medical-medlineplus-2026-08";

/**
 * The new mount's own prices — a cheaper tier over the same bytes.
 *
 * They differ from the source mount's on purpose. `requestFingerprint` covers
 * the substrate's packId but deliberately NOT the mountId, so a mount cloned
 * price-for-price over a shared pack would fingerprint identically to the one
 * it was cloned from. Charging differently is what a second tier is for, and
 * it keeps this fixture from quietly depending on that coincidence.
 */
const THIRD_PRICES: Record<string, string> = {
  tile_fetch: "200",
  pack_inclusion_proof: "100",
  pack_manifest: "800",
};

function addThirdMount(a: { routes: RoutesArtifact; tools: ToolsArtifact }): void {
  const template = a.routes.mounts.find((m) => m.mountId === THIRD_SOURCE_MOUNT)!;
  const clone = JSON.parse(JSON.stringify(template)) as MountEntry;
  clone.mountId = THIRD_MOUNT;
  clone.substrate.statusListRef = `${THIRD_MOUNT}-status`;
  clone.price.payToRef = `${THIRD_MOUNT}-payto`;
  // `packRef` and `edition` are left exactly as cloned: this mount is a new
  // offering over the SAME sealed substrate. Operation ids and limits are the
  // template's too — the mount introduces no new CAPABILITY, only a new way
  // to buy one.
  for (const r of clone.routes) {
    r.pathTemplate = r.pathTemplate.replace(`/${THIRD_SOURCE_MOUNT}/`, `/${THIRD_MOUNT}/`);
    r.priceAtomic = THIRD_PRICES[r.operationId];
  }
  a.routes.mounts.push(clone);

  for (const r of clone.routes) {
    const source = a.tools.tools.find((t) => t.name === toolName(THIRD_SOURCE_MOUNT, r.operationId))!;
    a.tools.tools.push({
      name: toolName(THIRD_MOUNT, r.operationId),
      description: `${r.operationId} over sealed pack ${THIRD_PACK} (x402 metered, ${r.priceAtomic} atomic USDC)`,
      inputSchema: JSON.parse(JSON.stringify(source.inputSchema)) as Record<string, unknown>,
    });
  }
}

// ─── one kernel, both edges ──────────────────────────────────────────────────

interface Edges {
  core: BootedKernel;
  httpUrl: string;
  openMcp(): Promise<Client>;
  /** Everything this boot holds — clients, both listeners, the ledger. */
  stop(): Promise<void>;
}

/**
 * Both spokes attached to ONE `BootedKernel`.
 *
 * This is the arrangement the parity claim is about: not two servers that
 * happen to agree, but two wire decoders in front of a single kernel, a
 * single limiter and a single ledger. Anything either edge could decide on
 * its own would show up here as a disagreement.
 */
async function attachEdges(core: BootedKernel): Promise<Edges> {
  const httpServer = createPaidServer(core.kernel, {
    port: 0,
    requireTls: false,
    refusals: core.refusals,
  });
  // Constructing this at all is already an assertion: `buildRoutes` refuses
  // any disagreement between the kernel's live operations and the published
  // tool list, in both directions.
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
      const client = new Client({ name: "x402-boundary-test", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
      clients.push(client);
      return client;
    },
    async stop() {
      for (const c of clients) await c.close().catch(() => undefined);
      httpServer.close();
      mcpServer.close();
      // Keep-alive sockets would otherwise hold both listeners — and the event
      // loop — open past the end of the test.
      httpServer.closeAllConnections();
      mcpServer.closeAllConnections();
      core.close();
    },
  };
}

async function bootEdges(o: {
  ledgerPath: string;
  facilitator: StubFacilitator;
  manifestsDir?: string;
  adapters?: readonly Adapter[];
}): Promise<Edges> {
  const core = await bootKernelOnly({
    manifestsDir: o.manifestsDir ?? MANIFESTS,
    packsDir: PACKS,
    ledgerPath: o.ledgerPath,
    facilitator: o.facilitator,
    payToOverride: PAY_TO,
    ...(o.adapters ? { adapters: o.adapters } : {}),
  });
  return attachEdges(core);
}

// ─── wire helpers ────────────────────────────────────────────────────────────

/** The flat payload the HTTP spoke carries in `X-Payment`. */
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

/** The same payload, in the x402 envelope the MCP spoke carries in `_meta`. */
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

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  payment?: { nonce: string; amountAtomic: string }
): Promise<ToolCallResult> {
  const base = { name, arguments: args };
  const params = payment ? attachPaymentToMeta(base, paymentEnvelope(payment.nonce, payment.amountAtomic)) : base;
  return (await client.callTool(params as Parameters<Client["callTool"]>[0])) as unknown as ToolCallResult;
}

function deliveredBytes(res: ToolCallResult): Buffer {
  assert.notEqual(res.isError, true, `expected a delivery, got ${JSON.stringify(res.content)}`);
  const item = res.content[0] as { type: string; resource: { blob: string; mimeType: string } };
  assert.equal(item.type, "resource");
  return Buffer.from(item.resource.blob, "base64");
}

function paymentResponse(res: ToolCallResult): Record<string, unknown> {
  const pr = res._meta?.[MCP_PAYMENT_RESPONSE_META_KEY] as Record<string, unknown> | undefined;
  assert.ok(pr, "a delivery must carry the receipt under the published payment-response key");
  return pr;
}

// ─── ledger helpers ──────────────────────────────────────────────────────────

const count = (core: BootedKernel, table: string, where = "1=1"): number =>
  (core.ledger.db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get() as { c: number }).c;

const deliveriesByTransport = (core: BootedKernel): Array<{ transport: string; n: number }> =>
  core.ledger.db
    .prepare("SELECT transport, COUNT(*) n FROM delivery_log GROUP BY transport ORDER BY transport")
    .all() as Array<{ transport: string; n: number }>;

const tileCid = (core: BootedKernel, mountId: string, i: number): string =>
  (core.mounts.get(mountId)!.substrate.getManifest().tiles as string[])[i];

// ─── (a) the extension boundary ──────────────────────────────────────────────

test("boundary: a capability registered through the public API alone is callable and discoverable on both spokes", async () => {
  await withTmpDir(async (dir) => {
    const md = fixtureManifests(dir, addEchoCapability);
    // Everything this adapter needs comes from the package's own public entry
    // point — the surface an external author has. It knows nothing about the
    // kernel's internals, and the kernel knows nothing about it beyond the
    // operationId the manifest declares.
    const echo = defineAdapter({
      operationId: ECHO_OP,
      argSchema: z.object({}).strict(),
      maxResultBytes: 64,
      declaredReplaySafe: true,
      handler: () => ({
        bytes: Buffer.from(JSON.stringify({ pong: true })),
        contentType: "application/json",
      }),
    });
    const stub = new StubFacilitator("valid");
    const e = await bootEdges({
      ledgerPath: path.join(dir, "ledger.db"),
      facilitator: stub,
      manifestsDir: md,
      adapters: [...BUILTIN_ADAPTERS, echo],
    });
    try {
      // Discoverable on the HTTP spoke, priced by the manifest.
      const discovery = (await (await fetch(`${e.httpUrl}/.well-known/x402`)).json()) as {
        resources: Array<{ resource: string; operationId: string; priceAtomic: string }>;
      };
      const published = discovery.resources.find((r) => r.operationId === ECHO_OP);
      assert.ok(published, "the new operation must appear in /.well-known/x402");
      assert.equal(published.resource, `/${MOUNT}/${ECHO_OP}`);
      assert.equal(published.priceAtomic, ECHO_PRICE, "the price is the manifest's, not the adapter's");

      // Discoverable on the MCP spoke. Not a length or a deepEqual — this
      // fixture publishes seven tools, and what matters is that the new one is
      // among them.
      const client = await e.openMcp();
      const listed = await client.listTools();
      assert.ok(
        listed.tools.some((t) => t.name === ECHO_TOOL),
        "the new operation must appear in tools/list"
      );

      // And callable: a paid call delivers the external handler's bytes.
      const res = await fetch(`${e.httpUrl}/${MOUNT}/${ECHO_OP}`, {
        headers: { "x-payment-id": paymentId(), "x-payment": paymentHeader("bnd-echo-1", ECHO_PRICE) },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json");
      assert.deepEqual(await res.json(), { pong: true });
      assert.equal(stub.settleCalls, 1, "a new capability is metered like any other");
      assert.equal(count(e.core, "receipts", "success=1"), 1);
    } finally {
      await e.stop();
    }
  });
});

// ─── (b) HTTP/MCP parity: two doors, one call ────────────────────────────────

test("boundary: a paymentId bought over HTTP replays over MCP as the same call, the same bytes, one receipt", async () => {
  await withTmpDir(async (dir) => {
    const stub = new StubFacilitator("valid");
    const e = await bootEdges({ ledgerPath: path.join(dir, "ledger.db"), facilitator: stub });
    try {
      const cid = tileCid(e.core, MOUNT, 0);
      const pid = paymentId();

      const bought = await fetch(`${e.httpUrl}/${MOUNT}/tile/${cid}`, {
        headers: { "x-payment-id": pid, "x-payment": paymentHeader("bnd-parity-1", TILE_PRICE) },
      });
      assert.equal(bought.status, 200);
      assert.equal(bought.headers.get("x-replayed"), "false");
      const httpBytes = Buffer.from(await bought.arrayBuffer());
      const callId = bought.headers.get("x-call-id");
      const httpReceipt = JSON.parse(
        Buffer.from(bought.headers.get("x-payment-response")!, "base64").toString("utf8")
      ) as { network: string; asset: string; amountAtomic: string; payTo: string };
      assert.equal(stub.settleCalls, 1);

      // The replay carries NO payment at all — only the paymentId. There is
      // nothing here the facilitator could be asked about even in principle.
      const client = await e.openMcp();
      const replay = await callTool(client, TILE_TOOL, { cid, paymentId: pid });
      const mcpBytes = deliveredBytes(replay);

      assert.deepEqual(mcpBytes, httpBytes, "the second door must return the first door's bytes, byte for byte");
      assert.deepEqual(
        httpBytes,
        Buffer.from(e.core.mounts.get(MOUNT)!.substrate.getTile(cid)!),
        "and those bytes are the sealed pack's"
      );

      // The receipt is the SAME stored receipt, rendered onto a second wire.
      const pr = paymentResponse(replay);
      const extra = pr.extra as { callId: string; payTo: string; asset: string; replayed: boolean };
      assert.equal(pr.success, true);
      assert.equal(extra.callId, callId, "both doors name the same call");
      assert.equal(extra.replayed, true, "the MCP side knows it did not buy this");
      assert.equal(pr.amount, httpReceipt.amountAtomic);
      assert.equal(pr.network, httpReceipt.network);
      assert.equal(extra.payTo, httpReceipt.payTo);
      assert.equal(extra.asset, httpReceipt.asset);

      // One call, one receipt, one settlement — across both transports.
      assert.equal(count(e.core, "calls"), 1, "two transports, one ledger row");
      assert.equal(count(e.core, "receipts"), 1);
      assert.equal(count(e.core, "settlement_attempts"), 1);
      assert.equal(count(e.core, "results"), 1);
      assert.equal(stub.settleCalls, 1, "a cross-transport replay must never move money a second time");
      assert.equal(stub.verifyCalls, 1);
    } finally {
      await e.stop();
    }
  });
});

// ─── (c) a third mount, by configuration alone ───────────────────────────────

test("boundary: a third mount over an existing sealed pack boots and delivers with no new adapter and no code", async () => {
  await withTmpDir(async (dir) => {
    const md = fixtureManifests(dir, addThirdMount);
    const stub = new StubFacilitator("valid");
    // `adapters` is deliberately NOT passed: this boot runs on exactly the
    // three capabilities the package has always shipped.
    const e = await bootEdges({ ledgerPath: path.join(dir, "ledger.db"), facilitator: stub, manifestsDir: md });
    try {
      const mount = e.core.mounts.get(THIRD_MOUNT);
      assert.ok(mount, "the manifest edit alone must produce a live mount");
      assert.equal(mount.substrate.packId, THIRD_PACK, "serving the real pack, seal verified at boot");
      assert.equal(e.core.mounts.size, 3);

      const cid = tileCid(e.core, THIRD_MOUNT, 0);
      // Paid at the NEW mount's declared price, not the source mount's 300.
      // Underpaying is a `payment_underpaid` refusal at the facilitator
      // boundary, so a 200 delivering is itself the proof that this mount's
      // own configured price is the one being charged.
      const res = await fetch(`${e.httpUrl}/${THIRD_MOUNT}/tile/${cid}`, {
        headers: {
          "x-payment-id": paymentId(),
          "x-payment": paymentHeader("bnd-third-1", THIRD_PRICES.tile_fetch),
        },
      });
      assert.equal(res.status, 200);
      const receipt = JSON.parse(
        Buffer.from(res.headers.get("x-payment-response")!, "base64").toString("utf8")
      ) as { amountAtomic: string };
      assert.equal(receipt.amountAtomic, THIRD_PRICES.tile_fetch, "the receipt is written at the new tier's price");
      assert.deepEqual(
        Buffer.from(await res.arrayBuffer()),
        Buffer.from(mount.substrate.getTile(cid)!),
        "the new mount serves the sealed pack's bytes"
      );
      // Same substrate, reached through a mount that did not exist before this
      // manifest edit — a second Substrate instance over the same pack, loaded
      // and seal-verified independently at boot.
      assert.deepEqual(
        Buffer.from(mount.substrate.getTile(cid)!),
        Buffer.from(e.core.mounts.get(THIRD_SOURCE_MOUNT)!.substrate.getTile(cid)!)
      );
      assert.equal(
        res.headers.get("content-type"),
        mount.substrate.payloadContentType,
        "content type comes from the pack's sealed manifest"
      );
      assert.equal(stub.settleCalls, 1);

      // The MCP spoke admitted it too — `createPaidMcpServer` would have
      // refused to construct if the published tools and the live operations
      // disagreed in either direction.
      const client = await e.openMcp();
      const listed = await client.listTools();
      for (const op of ["tile_fetch", "pack_inclusion_proof", "pack_manifest"]) {
        assert.ok(
          listed.tools.some((t) => t.name === toolName(THIRD_MOUNT, op)),
          `the third mount's ${op} must be published`
        );
      }
    } finally {
      await e.stop();
    }
  });
});

// ─── (d) one delivery log, two transports ────────────────────────────────────

test("boundary: delivery_log records each spoke's own transport against one ledger", async () => {
  await withTmpDir(async (dir) => {
    const stub = new StubFacilitator("valid");
    const e = await bootEdges({ ledgerPath: path.join(dir, "ledger.db"), facilitator: stub });
    try {
      const cid = tileCid(e.core, MOUNT, 0);

      const client = await e.openMcp();
      const overMcp = await callTool(
        client,
        TILE_TOOL,
        { cid, paymentId: paymentId() },
        { nonce: "bnd-log-mcp", amountAtomic: TILE_PRICE }
      );
      deliveredBytes(overMcp);

      const overHttp = await fetch(`${e.httpUrl}/${MOUNT}/tile/${tileCid(e.core, MOUNT, 1)}`, {
        headers: { "x-payment-id": paymentId(), "x-payment": paymentHeader("bnd-log-http", TILE_PRICE) },
      });
      assert.equal(overHttp.status, 200);
      await overHttp.arrayBuffer();

      // Two distinct purchases, so two settlements — and two acks, each fired
      // when its OWN response finished.
      assert.equal(stub.settleCalls, 2);
      const rows = await waitFor("both delivery acks", () => {
        const r = deliveriesByTransport(e.core);
        return r.reduce((n, x) => n + x.n, 0) === 2 ? r : undefined;
      });
      assert.deepEqual(rows, [
        { transport: "http", n: 1 },
        { transport: "mcp", n: 1 },
      ]);
    } finally {
      await e.stop();
    }
  });
});

// ─── (e) the entitlement outlives the process ────────────────────────────────

test("boundary: a restart serves the same bytes from the ledger and never re-settles", async () => {
  await withTmpDir(async (dir) => {
    const ledgerPath = path.join(dir, "ledger.db");
    const pid = paymentId();

    const firstStub = new StubFacilitator("valid");
    const e1 = await bootEdges({ ledgerPath, facilitator: firstStub });
    let sale: { bytes: Buffer; cid: string; callId: string } | undefined;
    try {
      const cid = tileCid(e1.core, MOUNT, 2);
      const res = await fetch(`${e1.httpUrl}/${MOUNT}/tile/${cid}`, {
        headers: { "x-payment-id": pid, "x-payment": paymentHeader("bnd-restart-1", TILE_PRICE) },
      });
      assert.equal(res.status, 200);
      const callId = res.headers.get("x-call-id")!;
      sale = { bytes: Buffer.from(await res.arrayBuffer()), cid, callId };
      assert.equal(firstStub.settleCalls, 1);
      // Let the first boot finish its own bookkeeping, so what the restart
      // reads is a settled call and not a race.
      await waitFor("the first boot's delivery ack", () =>
        e1.core.ledger.db.prepare("SELECT call_id FROM delivery_log WHERE call_id=?").get(callId)
      );
    } finally {
      await e1.stop();
    }
    assert.ok(sale, "the first boot must have delivered");

    // A NEW facilitator instance is what makes the assertion below mean
    // something: its counters start at zero, so "0 settlements" is a fact
    // about this boot rather than a number carried over from the last one.
    const secondStub = new StubFacilitator("valid");
    const e2 = await bootEdges({ ledgerPath, facilitator: secondStub });
    try {
      const res = await fetch(`${e2.httpUrl}/${MOUNT}/tile/${sale.cid}`, {
        headers: { "x-payment-id": pid },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-replayed"), "true");
      assert.equal(res.headers.get("x-call-id"), sale.callId, "the same call, across a process boundary");
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), sale.bytes, "byte-identical after a restart");
      assert.equal(secondStub.settleCalls, 0, "a replay after a restart must never move money again");
      assert.equal(secondStub.verifyCalls, 0, "nor ask the facilitator anything at all");
      assert.equal(count(e2.core, "calls"), 1);
      assert.equal(count(e2.core, "receipts"), 1);
      assert.equal(count(e2.core, "settlement_attempts"), 1);

      // The same durable call is reachable from the other spoke too.
      const client = await e2.openMcp();
      const replay = await callTool(client, TILE_TOOL, { cid: sale.cid, paymentId: pid });
      assert.deepEqual(deliveredBytes(replay), sale.bytes);
      assert.equal(secondStub.settleCalls, 0);
    } finally {
      await e2.stop();
    }
  });
});

// ─── (f) drift refuses to boot ───────────────────────────────────────────────

test("boundary: a generated artifact edited without re-sealing generated.lock refuses boot", async () => {
  await withTmpDir(async (dir) => {
    // Byte-for-byte the fixture the third-mount test boots successfully —
    // minus the re-seal. So this pins the digest check as the thing standing
    // between a manifest edit and a running kernel, and it pins the relock in
    // `fixtureManifests` as load-bearing rather than decorative. The refusal
    // lands in boot's FIRST step, before a pack, a ledger or a listener is
    // touched at all.
    const md = fixtureManifests(dir, addThirdMount, { relock: false });
    await assert.rejects(
      () =>
        bootKernelOnly({
          manifestsDir: md,
          packsDir: PACKS,
          ledgerPath: path.join(dir, "ledger.db"),
          facilitator: new StubFacilitator("valid"),
          payToOverride: PAY_TO,
        }),
      (e: Error) => {
        assert.match(e.message, /BOOT_REFUSED/);
        assert.match(e.message, /x402-routes\.json/);
        assert.match(e.message, /generated\.lock/);
        return true;
      }
    );
  });
});
