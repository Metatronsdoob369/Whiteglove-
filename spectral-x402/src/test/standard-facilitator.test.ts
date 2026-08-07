/**
 * standard-facilitator.test.ts — the real facilitator boundary, proved against
 * a LOCAL facilitator that speaks the standard v2 wire.
 *
 * The mock is a facilitator, not a stub: it is reached over real HTTP by the
 * SDK's own `HTTPFacilitatorClient` (so the paths, the request body, and the
 * zod validation of every response are the SDK's), and it records exactly what
 * arrived. That is what lets these tests assert the WIRE and not just our
 * intentions — a request our translation got wrong would fail the mock's own
 * standard-schema check before any of our code saw a result.
 *
 * Everything above the boundary is the real kernel, the real ledger, and the
 * real HTTP edge. No key, no chain, no money.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { isPaymentPayloadV2, isPaymentRequirementsV2 } from "@x402/core/schemas";
import { getDefaultAsset } from "@x402/evm";
import { boot, bootKernelOnly, type Booted } from "../server.js";
import { StandardFacilitator } from "../facilitator.js";
import { toStandardRequirements } from "../x402-wire.js";

const MANIFESTS = path.resolve(__dirname, "../../../manifests");
const PACKS = path.resolve(__dirname, "../../packs");
const NETWORK = "eip155:84532";
const PAY_TO = "0x00000000000000000000000000000000000000ff";
const PAYER = "0x1111111111111111111111111111111111111111";
const USDC = getDefaultAsset(NETWORK).address;
const TX = `0x${"7f".repeat(32)}`;

let seq = 0;
const paymentId = () => `pay-${Date.now()}-${String(seq++).padStart(4, "0")}`;

type MockMode = "happy" | "verify-invalid" | "settle-rejected" | "settle-hang" | "settle-drop" | "settle-500";

/** A standard v2 facilitator, in ~40 lines, that remembers what it was sent. */
class MockFacilitator {
  readonly server: http.Server;
  mode: MockMode = "happy";
  hits = { verify: 0, settle: 0, supported: 0 };
  received: { verify: unknown[]; settle: unknown[] } = { verify: [], settle: [] };
  url = "";

  constructor(mode: MockMode = "happy") {
    this.mode = mode;
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
        const json = (status: number, payload: unknown) => {
          const buf = Buffer.from(JSON.stringify(payload));
          res.writeHead(status, { "content-type": "application/json", "content-length": buf.length });
          res.end(buf);
        };
        if (req.url === "/supported") {
          this.hits.supported++;
          return json(200, {
            kinds: [
              { x402Version: 2, scheme: "exact", network: NETWORK },
              { x402Version: 2, scheme: "upto", network: NETWORK },
            ],
            extensions: [],
            signers: {},
          });
        }
        if (req.url === "/verify") {
          this.hits.verify++;
          this.received.verify.push(body);
          if (this.mode === "verify-invalid") {
            return json(200, { isValid: false, invalidReason: "insufficient_funds", payer: PAYER });
          }
          return json(200, { isValid: true, payer: PAYER });
        }
        if (req.url === "/settle") {
          this.hits.settle++;
          this.received.settle.push(body);
          // Never answers. The client's own deadline is what ends this, and the
          // money may or may not have moved — the whole point.
          if (this.mode === "settle-hang") return;
          // The connection dies mid-flight: the harsher shape of the same fact.
          if (this.mode === "settle-drop") return req.socket.destroy();
          if (this.mode === "settle-500") return json(500, { error: "boom" });
          if (this.mode === "settle-rejected") {
            return json(200, { success: false, errorReason: "insufficient_funds", transaction: "", network: NETWORK });
          }
          return json(200, { success: true, transaction: TX, network: NETWORK, payer: PAYER });
        }
        json(404, { error: "no such path" });
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close(): void {
    this.server.closeAllConnections?.();
    this.server.close();
  }
}

/** A standard v2 exact/EIP-3009 payment for one of our operations. */
function envelopeFor(priceAtomic: string, resource: string): Record<string, unknown> {
  const accepted = toStandardRequirements({
    scheme: "exact",
    network: NETWORK,
    asset: "USDC",
    amountAtomic: priceAtomic,
    payTo: PAY_TO,
    resource,
    description: "test",
    maxTimeoutSeconds: 120,
  });
  return {
    x402Version: 2,
    resource: { url: resource },
    accepted,
    payload: {
      signature: `0x${"cd".repeat(65)}`,
      authorization: {
        from: PAYER,
        to: PAY_TO,
        value: priceAtomic,
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 600),
        nonce: `0x${Buffer.from(paymentId().padEnd(32, "0").slice(0, 32)).toString("hex")}`,
      },
    },
  };
}

const paymentHeader = (env: unknown): string => Buffer.from(JSON.stringify(env)).toString("base64");

interface Ctx {
  url: string;
  b: Booted;
  mock: MockFacilitator;
  count: (table: string, where?: string) => number;
  cid: string;
}

/**
 * Boots the whole kernel against the mock, wired the way an OPERATOR wires it:
 * `X402_FACILITATOR_URL` in the environment, no in-process facilitator, and
 * per-mount payTo resolved from env — the same path `bootKernelOnly` takes in
 * production, including its refusal to pair a real facilitator with an
 * overridden payTo.
 */
async function withMock(mode: MockMode, fn: (c: Ctx) => Promise<void>): Promise<void> {
  const mock = new MockFacilitator(mode);
  await mock.listen();
  const dir = mkdtempSync(path.join(tmpdir(), "x402-std-"));
  const saved = { ...process.env };
  process.env.X402_FACILITATOR_URL = mock.url;
  delete process.env.X402_FACILITATOR_API_KEY;
  delete process.env.X402_ALLOW_STUB_FACILITATOR;
  process.env.X402_PAYTO_ROBLOX_LUAU_PAYTO = PAY_TO;
  process.env.X402_PAYTO_MEDICAL_MEDLINEPLUS_PAYTO = PAY_TO;
  let b: Booted | undefined;
  try {
    b = await boot({
      manifestsDir: MANIFESTS,
      packsDir: PACKS,
      ledgerPath: path.join(dir, "ledger.db"),
      port: 0,
      requireTls: false,
    });
    await new Promise<void>((r) => b!.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(b.server.address() as AddressInfo).port}`;
    const count = (table: string, where = "1=1") =>
      (b!.ledger.db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get() as { c: number }).c;
    const cid = (b.mounts.get("roblox-luau")!.substrate.getManifest().tiles as string[])[0];
    await fn({ url, b, mock, count, cid });
  } finally {
    b?.close();
    mock.close();
    rmSync(dir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test("standard: a paid call settles through the real boundary and the wire is the standard's", async () => {
  await withMock("happy", async ({ url, mock, cid, count }) => {
    const id = paymentId();
    const resource = `/roblox-luau/tile/${cid}`;
    const res = await fetch(`${url}${resource}`, {
      headers: { "x-payment-id": id, "x-payment": paymentHeader(envelopeFor("500", resource)) },
    });
    assert.equal(res.status, 200);
    const receipt = JSON.parse(Buffer.from(res.headers.get("x-payment-response")!, "base64").toString("utf8"));
    assert.equal(receipt.transaction, TX, "the facilitator's own transaction, not one we invented");
    assert.equal(receipt.network, NETWORK);
    assert.equal(receipt.payer, PAYER);
    assert.equal(receipt.payTo, PAY_TO);
    assert.equal(receipt.asset, "USDC", "the RECEIPT keeps the manifest's vocabulary");
    assert.equal(receipt.amountAtomic, "500");

    // What actually went over the wire — validated by the SDK's own schemas, so
    // this asserts standard-conformance and not merely self-consistency.
    assert.equal(mock.hits.verify, 1);
    assert.equal(mock.hits.settle, 1);
    for (const body of [...mock.received.verify, ...mock.received.settle] as Array<Record<string, unknown>>) {
      assert.equal(body.x402Version, 2, "the request declares its version");
      assert.equal(isPaymentPayloadV2(body.paymentPayload), true);
      assert.equal(isPaymentRequirementsV2(body.paymentRequirements), true);
      const req = body.paymentRequirements as Record<string, unknown>;
      assert.equal(req.amount, "500", "our amountAtomic arrived as `amount`");
      assert.equal(req.asset, USDC, "our symbolic USDC arrived as the contract address");
      assert.equal(req.payTo, PAY_TO);
      assert.equal((req.extra as Record<string, unknown>).name, "USDC", "the EIP-712 domain the payer signed against");
      const payload = (body.paymentPayload as Record<string, unknown>).payload as Record<string, unknown>;
      assert.ok(payload.authorization, "the client's signed authorization is forwarded, not rebuilt");
    }

    assert.equal(count("receipts", "success=1"), 1);
    assert.equal(count("receipts", `facilitator_id='http'`), 1, "the ledger's facilitator_id vocabulary is unchanged");
    assert.equal(count("settlement_attempts"), 1);
    assert.equal(count("quarantine"), 0);
  });
});

test("standard: a facilitator that never answers settle ⇒ indeterminate ⇒ quarantine, never resubmitted", async () => {
  await withMock("settle-hang", async ({ url, mock, cid, count, b }) => {
    // The SDK client's own deadline ends this; 700ms keeps the test honest and short.
    (b.kernel as unknown as { facilitator: unknown }).facilitator = new StandardFacilitator(mock.url, undefined, "http", 700);
    const id = paymentId();
    const resource = `/roblox-luau/tile/${cid}`;
    const env = envelopeFor("500", resource);
    const first = await fetch(`${url}${resource}`, {
      headers: { "x-payment-id": id, "x-payment": paymentHeader(env) },
    });
    assert.equal(first.status, 503, "settlement_pending_review");
    assert.equal((await first.json() as { code: string }).code, "settlement_pending_review");
    assert.equal(count("quarantine"), 1, "quarantined, because we do not know");
    assert.equal(count("receipts"), 0, "no receipt for a settlement we cannot vouch for");
    assert.equal(count("calls", `state='settlement_unknown'`), 1);
    assert.equal(mock.hits.settle, 1);

    // The load-bearing half: asking again must not settle again.
    const again = await fetch(`${url}${resource}`, {
      headers: { "x-payment-id": id, "x-payment": paymentHeader(env) },
    });
    assert.equal(again.status, 503);
    assert.equal((await again.json() as { code: string }).code, "settlement_pending_review");
    assert.equal(mock.hits.settle, 1, "a quarantined call is NEVER resubmitted");
    assert.equal(count("settlement_attempts"), 1);
  });
});

test("standard: a dropped connection at settle is the same indeterminate, not a rejection", async () => {
  await withMock("settle-drop", async ({ url, cid, count }) => {
    const resource = `/roblox-luau/tile/${cid}`;
    const res = await fetch(`${url}${resource}`, {
      headers: { "x-payment-id": paymentId(), "x-payment": paymentHeader(envelopeFor("500", resource)) },
    });
    assert.equal(res.status, 503);
    assert.equal(count("quarantine"), 1);
    assert.equal(count("calls", `state='settlement_rejected'`), 0, "unknown is not rejected");
  });
});

test("standard: a non-2xx settle is indeterminate too — a status is not an answer", async () => {
  await withMock("settle-500", async ({ url, cid, count }) => {
    const resource = `/roblox-luau/tile/${cid}`;
    const res = await fetch(`${url}${resource}`, {
      headers: { "x-payment-id": paymentId(), "x-payment": paymentHeader(envelopeFor("500", resource)) },
    });
    assert.equal(res.status, 503);
    assert.equal(count("quarantine"), 1);
  });
});

test("standard: a STATED settlement failure is determinate — rejected, not quarantined", async () => {
  await withMock("settle-rejected", async ({ url, cid, count }) => {
    const resource = `/roblox-luau/tile/${cid}`;
    const res = await fetch(`${url}${resource}`, {
      headers: { "x-payment-id": paymentId(), "x-payment": paymentHeader(envelopeFor("500", resource)) },
    });
    assert.equal(res.status, 402, "settlement_rejected");
    assert.equal((await res.json() as { code: string }).code, "settlement_rejected");
    assert.equal(count("quarantine"), 0, "the facilitator SPOKE — nothing unknown to hold");
    assert.equal(count("calls", `state='settlement_rejected'`), 1);
    assert.equal(count("receipts"), 0);
  });
});

test("standard: a facilitator's invalidReason reaches the caller verbatim, and nothing settles", async () => {
  await withMock("verify-invalid", async ({ url, mock, cid, count }) => {
    const resource = `/roblox-luau/tile/${cid}`;
    const res = await fetch(`${url}${resource}`, {
      headers: { "x-payment-id": paymentId(), "x-payment": paymentHeader(envelopeFor("500", resource)) },
    });
    assert.equal(res.status, 402, "an undeclared facilitator reason renders 402, per statusFor");
    assert.equal((await res.json() as { code: string }).code, "insufficient_funds");
    assert.equal(mock.hits.settle, 0, "a payment that did not verify is never settled");
    assert.equal(count("receipts"), 0);
  });
});

test("standard: a legacy flat payment is refused rather than sent to a real facilitator", async () => {
  await withMock("happy", async ({ url, mock, cid }) => {
    // No envelope means nothing a conforming facilitator can read. Sending it
    // anyway would risk reading a shrug as approval.
    const flat = { scheme: "exact", network: NETWORK, payer: PAYER, nonce: "flat-nonce", amountAtomic: "500", asset: "USDC", payTo: PAY_TO };
    const res = await fetch(`${url}/roblox-luau/tile/${cid}`, {
      headers: { "x-payment-id": paymentId(), "x-payment": paymentHeader(flat) },
    });
    assert.equal(res.status, 402);
    assert.equal((await res.json() as { code: string }).code, "payment_invalid");
    assert.equal(mock.hits.verify, 0, "never reached the facilitator at all");
    assert.equal(mock.hits.settle, 0);
  });
});

test("standard: a failed execution never settles, even with a good payment", async () => {
  await withMock("happy", async ({ url, mock, count }) => {
    // Well-formed and absent: it must clear the arg schema to reach the adapter,
    // or this would prove nothing about settlement.
    const resource = `/roblox-luau/tile/b2-256:${"f".repeat(64)}`;
    const res = await fetch(`${url}${resource}`, {
      headers: { "x-payment-id": paymentId(), "x-payment": paymentHeader(envelopeFor("500", resource)) },
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json() as { code: string }).code, "tile_not_found");
    assert.equal(mock.hits.verify, 1, "the payment was verified");
    assert.equal(mock.hits.settle, 0, "and then NOT settled, because there was nothing to sell");
    assert.equal(count("receipts"), 0);
    assert.equal(count("settlement_attempts"), 0);
  });
});

test("standard: getSupported maps the v2 kinds list", async () => {
  const mock = new MockFacilitator("happy");
  await mock.listen();
  try {
    const f = new StandardFacilitator(mock.url);
    assert.deepEqual(await f.getSupported(), { schemes: ["exact", "upto"], networks: [NETWORK] });
    assert.equal(mock.hits.supported, 1);
    assert.equal(f.id, "http");
  } finally {
    mock.close();
  }
});

test("standard: boot builds a real facilitator from the environment alone", async () => {
  // The operator's whole configuration surface for going live: one env var.
  const mock = new MockFacilitator("happy");
  await mock.listen();
  const dir = mkdtempSync(path.join(tmpdir(), "x402-std-boot-"));
  const saved = { ...process.env };
  process.env.X402_FACILITATOR_URL = mock.url;
  delete process.env.X402_ALLOW_STUB_FACILITATOR;
  process.env.X402_PAYTO_ROBLOX_LUAU_PAYTO = PAY_TO;
  process.env.X402_PAYTO_MEDICAL_MEDLINEPLUS_PAYTO = PAY_TO;
  try {
    const core = await bootKernelOnly({
      manifestsDir: MANIFESTS,
      packsDir: PACKS,
      ledgerPath: path.join(dir, "ledger.db"),
    });
    try {
      for (const m of core.mounts.values()) assert.equal(m.payTo, PAY_TO, "payTo came from env, not an override");
    } finally {
      core.close();
    }
  } finally {
    mock.close();
    rmSync(dir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("standard: a real facilitator paired with an overridden payTo still refuses to boot", async () => {
  // The mirror-image guard, re-asserted here because this is the first test file
  // in which the real facilitator branch is actually reachable.
  const dir = mkdtempSync(path.join(tmpdir(), "x402-std-refuse-"));
  const saved = { ...process.env };
  process.env.X402_FACILITATOR_URL = "http://127.0.0.1:1";
  process.env.X402_PAYTO_ROBLOX_LUAU_PAYTO = PAY_TO;
  process.env.X402_PAYTO_MEDICAL_MEDLINEPLUS_PAYTO = PAY_TO;
  try {
    await assert.rejects(
      () =>
        bootKernelOnly({
          manifestsDir: MANIFESTS,
          packsDir: PACKS,
          ledgerPath: path.join(dir, "ledger.db"),
          payToOverride: "0x0000000000000000000000000000000000000dev",
        }),
      /BOOT_REFUSED: real facilitator/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
