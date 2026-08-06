/**
 * evidence.test.ts — the child doc's local-simulation evidence list.
 *
 * Every claim is asserted in SQL counts, never by scraping logs. The stub
 * facilitator substitutes exactly one boundary; everything above it is the
 * real kernel.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { boot, type Booted } from "../server.js";
import { StubFacilitator, type StubMode } from "../facilitator.js";
import type { AddressInfo } from "node:net";

const MANIFESTS = path.resolve(__dirname, "../../../manifests");
const PACKS = path.resolve(__dirname, "../../packs");
const PAY_TO = "0x0000000000000000000000000000000000000dev";

let seq = 0;
const paymentId = () => `pay-${Date.now()}-${seq++}`;

function paymentHeader(nonce: string, over: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({
      scheme: "exact",
      network: "eip155:84532",
      payer: "0xBUYER",
      nonce,
      amountAtomic: "500",
      asset: "USDC",
      payTo: PAY_TO,
      ...over,
    })
  ).toString("base64");
}

async function withServer(
  mode: StubMode,
  fn: (ctx: { url: string; b: Booted; stub: StubFacilitator; sql: (q: string) => unknown }) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "x402-"));
  const stub = new StubFacilitator(mode);
  const b = await boot({
    manifestsDir: MANIFESTS,
    packsDir: PACKS,
    ledgerPath: path.join(dir, "ledger.db"),
    port: 0,
    facilitator: stub,
    requireTls: false,
    payToOverride: PAY_TO,
  });
  await new Promise<void>((r) => b.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(b.server.address() as AddressInfo).port}`;
  const sql = (q: string) => b.ledger.db.prepare(q).get();
  try {
    await fn({ url, b, stub, sql });
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function firstCid(b: Booted): string {
  const m = b.mounts.get("roblox-luau")!;
  return (m.substrate.getManifest().tiles as string[])[0];
}
function secondCid(b: Booted): string {
  const m = b.mounts.get("roblox-luau")!;
  return (m.substrate.getManifest().tiles as string[])[1];
}

const count = (b: Booted, table: string, where = "1=1"): number =>
  (b.ledger.db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get() as { c: number }).c;

test("manifest-generated unpaid request returns an x402 v2 challenge", async () => {
  await withServer("valid", async ({ url, b }) => {
    const res = await fetch(`${url}/roblox-luau/tile/${firstCid(b)}`);
    assert.equal(res.status, 402);
    assert.equal(res.headers.get("x-challenge-epoch"), "2026-08-05.1");
    const body = (await res.json()) as { x402Version: number; accepts: Array<Record<string, string>> };
    assert.equal(body.x402Version, 2);
    assert.equal(body.accepts[0].scheme, "exact");
    assert.equal(body.accepts[0].network, "eip155:84532");
    assert.equal(body.accepts[0].amountAtomic, "500");
    assert.equal(body.accepts[0].payTo, PAY_TO);
    // No payment attempted ⇒ nothing durable was written.
    assert.equal(count(b, "calls"), 0);
    assert.equal(count(b, "receipts"), 0);
  });
});

test("challenge is byte-stable across requests (cached pre-auth stays valid)", async () => {
  await withServer("valid", async ({ url, b }) => {
    const a = await (await fetch(`${url}/roblox-luau/tile/${firstCid(b)}`)).text();
    const c = await (await fetch(`${url}/roblox-luau/tile/${firstCid(b)}`)).text();
    assert.equal(a, c);
  });
});

test("a valid payment executes exactly once and settles exactly once", async () => {
  await withServer("valid", async ({ url, b, stub }) => {
    const pid = paymentId();
    const res = await fetch(`${url}/roblox-luau/tile/${firstCid(b)}`, {
      headers: { "x-payment-id": pid, "x-payment": paymentHeader("n1") },
    });
    assert.equal(res.status, 200);
    assert.equal(count(b, "results"), 1);
    assert.equal(count(b, "settlement_attempts"), 1);
    assert.equal(count(b, "receipts", "success=1"), 1);
    assert.equal(stub.settleCalls, 1);
  });
});

test("delivered bytes hash to the requested cid (egress digest check)", async () => {
  await withServer("valid", async ({ url, b }) => {
    const cid = firstCid(b);
    const res = await fetch(`${url}/roblox-luau/tile/${cid}`, {
      headers: { "x-payment-id": paymentId(), "x-payment": paymentHeader("n2") },
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    const { createHash } = await import("node:crypto");
    const digest = createHash("blake2b512").update(bytes).digest().subarray(0, 32).toString("hex");
    assert.equal(`b2-256:${digest}`, cid);
  });
});

test("matching replay returns the stored result with no second settlement", async () => {
  await withServer("valid", async ({ url, b, stub }) => {
    const pid = paymentId();
    const cid = firstCid(b);
    const first = Buffer.from(
      await (
        await fetch(`${url}/roblox-luau/tile/${cid}`, {
          headers: { "x-payment-id": pid, "x-payment": paymentHeader("n3") },
        })
      ).arrayBuffer()
    );
    const settlesAfterFirst = stub.settleCalls;
    // Replay with NO payment attached at all.
    const res = await fetch(`${url}/roblox-luau/tile/${cid}`, { headers: { "x-payment-id": pid } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-replayed"), "true");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), first);
    assert.equal(stub.settleCalls, settlesAfterFirst, "replay must not re-settle");
    assert.equal(count(b, "settlement_attempts"), 1);
    assert.equal(count(b, "delivery_log"), 2);
  });
});

test("paymentId reused with different arguments returns 409 and executes nothing", async () => {
  await withServer("valid", async ({ url, b, stub }) => {
    const pid = paymentId();
    await fetch(`${url}/roblox-luau/tile/${firstCid(b)}`, {
      headers: { "x-payment-id": pid, "x-payment": paymentHeader("n4") },
    });
    const before = { results: count(b, "results"), settles: stub.settleCalls };
    const res = await fetch(`${url}/roblox-luau/tile/${secondCid(b)}`, {
      headers: { "x-payment-id": pid, "x-payment": paymentHeader("n4") },
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json() as { code: string }).code, "payment_id_fingerprint_conflict");
    assert.equal(count(b, "results"), before.results, "409 must not execute");
    assert.equal(stub.settleCalls, before.settles, "409 must not settle");
  });
});

for (const [mode, code] of [
  ["invalid", "payment_invalid"],
  ["expired", "payment_expired"],
  ["underpaid", "payment_underpaid"],
  ["wrong-asset", "payment_wrong_asset"],
  ["wrong-network", "payment_wrong_network"],
  ["wrong-recipient", "payment_wrong_recipient"],
] as Array<[StubMode, string]>) {
  test(`${mode} payment fails closed with code ${code}, no execution, no settlement`, async () => {
    await withServer(mode, async ({ url, b, stub }) => {
      const res = await fetch(`${url}/roblox-luau/tile/${firstCid(b)}`, {
        headers: { "x-payment-id": paymentId(), "x-payment": paymentHeader("n5") },
      });
      assert.equal(res.status, 402);
      assert.equal((await res.json() as { code: string }).code, code);
      assert.equal(count(b, "results"), 0, "must not execute");
      assert.equal(count(b, "receipts"), 0, "must not settle");
      assert.equal(stub.settleCalls, 0);
    });
  });
}

test("concurrent identical requests produce one execution and one settlement", async () => {
  await withServer("valid", async ({ url, b, stub }) => {
    const pid = paymentId();
    const cid = firstCid(b);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(`${url}/roblox-luau/tile/${cid}`, {
          headers: { "x-payment-id": pid, "x-payment": paymentHeader("n6") },
        }).then((r) => r.status)
      )
    );
    assert.equal(count(b, "results"), 1, "exactly one execution");
    assert.equal(count(b, "settlement_attempts"), 1, "exactly one settlement attempt");
    assert.equal(count(b, "receipts", "success=1"), 1, "exactly one receipt");
    assert.equal(stub.settleCalls, 1);
    assert.ok(results.includes(200), "at least one caller got the bytes");
    assert.ok(results.every((s) => [200, 202].includes(s)), `unexpected statuses: ${results}`);
  });
});

test("adapter miss (unknown cid) never settles", async () => {
  await withServer("valid", async ({ url, b, stub }) => {
    const res = await fetch(`${url}/roblox-luau/tile/b2-256:${"f".repeat(64)}`, {
      headers: { "x-payment-id": paymentId(), "x-payment": paymentHeader("n7") },
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json() as { code: string }).code, "tile_not_found");
    assert.equal(count(b, "receipts"), 0, "adapter failure must never settle");
    assert.equal(stub.settleCalls, 0);
    assert.equal(count(b, "calls", "state='execution_failed'"), 1);
  });
});

test("definitive settlement rejection locks the output", async () => {
  await withServer("settle-reject", async ({ url, b }) => {
    const res = await fetch(`${url}/roblox-luau/tile/${firstCid(b)}`, {
      headers: { "x-payment-id": paymentId(), "x-payment": paymentHeader("n8") },
    });
    assert.equal(res.status, 402);
    assert.equal((await res.json() as { code: string }).code, "settlement_rejected");
    assert.equal(count(b, "results"), 1, "the result exists");
    assert.equal(count(b, "receipts"), 0, "but no receipt, so it is locked");
    assert.equal(count(b, "calls", "state='settlement_rejected'"), 1);
  });
});

test("indeterminate settlement quarantines, never resubmits, never delivers", async () => {
  await withServer("succeed-then-drop-response", async ({ url, b, stub }) => {
    const pid = paymentId();
    const cid = firstCid(b);
    const res = await fetch(`${url}/roblox-luau/tile/${cid}`, {
      headers: { "x-payment-id": pid, "x-payment": paymentHeader("n9") },
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json() as { code: string }).code, "settlement_pending_review");
    assert.equal(count(b, "quarantine"), 1);
    assert.equal(count(b, "calls", "state='settlement_unknown'"), 1);
    assert.equal(count(b, "receipts"), 0);
    assert.equal(count(b, "delivery_log"), 0, "quarantined calls never deliver");

    // Retrying must NOT resubmit the settlement — the money may already have moved.
    const settlesBefore = stub.settleCalls;
    const again = await fetch(`${url}/roblox-luau/tile/${cid}`, {
      headers: { "x-payment-id": pid, "x-payment": paymentHeader("n9") },
    });
    assert.equal(again.status, 503);
    assert.equal(stub.settleCalls, settlesBefore, "never blindly resubmit a settlement");
    assert.equal(count(b, "settlement_attempts"), 1);
  });
});

test("crash during settling becomes settlement_unknown on restart, not settled", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "x402-crash-"));
  const ledgerPath = path.join(dir, "ledger.db");
  try {
    // Boot 1: drive a call into `settling`, then die without resolving it.
    const b1 = await boot({
      manifestsDir: MANIFESTS,
      packsDir: PACKS,
      ledgerPath,
      port: 0,
      facilitator: new StubFacilitator("valid"),
      requireTls: false,
      payToOverride: PAY_TO,
    });
    const m = b1.mounts.get("roblox-luau")!;
    const cid = (m.substrate.getManifest().tiles as string[])[0];
    const fp = b1.kernel.requestFingerprint(m, m.operations.get("tile_fetch")!, { cid });
    const opened = b1.ledger.openCall({
      mountId: "roblox-luau",
      operationId: "tile_fetch",
      paymentId: paymentId(),
      requestFingerprint: fp,
      fingerprintVersion: "fp-v1",
      initialState: "payment_present",
    });
    const cid2 = opened.call.call_id;
    b1.ledger.transition(cid2, "payment_present", "verified");
    b1.ledger.acquireLease(cid2, "execute", 60_000);
    b1.ledger.transition(cid2, "verified", "executing");
    b1.ledger.commitResult(cid2, {
      requestFingerprint: fp,
      fingerprintVersion: "fp-v1",
      digest: "00",
      bytes: Buffer.from("{}"),
      adapterVersion: "1.0.0",
      packId: m.substrate.packId,
      merkleRoot: m.substrate.merkleRootHex,
      contentType: "application/json",
    });
    b1.ledger.acquireLease(cid2, "settle", 60_000);
    b1.ledger.beginSettlement(cid2, "authfp", "stub");
    assert.equal(b1.ledger.getCall(cid2)!.state, "settling");
    b1.close(); // simulate the process dying mid-settlement

    // Boot 2: reconciliation must quarantine, not guess.
    const b2 = await boot({
      manifestsDir: MANIFESTS,
      packsDir: PACKS,
      ledgerPath,
      port: 0,
      facilitator: new StubFacilitator("valid"),
      requireTls: false,
      payToOverride: PAY_TO,
    });
    assert.equal(b2.ledger.getCall(cid2)!.state, "settlement_unknown");
    assert.equal(count(b2, "quarantine", `call_id='${cid2}'`), 1);
    assert.equal(count(b2, "receipts"), 0);
    b2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("crash during executing recovers as execution_unknown (replay-safe rerun)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "x402-crash2-"));
  const ledgerPath = path.join(dir, "ledger.db");
  try {
    const b1 = await boot({
      manifestsDir: MANIFESTS, packsDir: PACKS, ledgerPath, port: 0,
      facilitator: new StubFacilitator("valid"), requireTls: false, payToOverride: PAY_TO,
    });
    const m = b1.mounts.get("roblox-luau")!;
    const cid = (m.substrate.getManifest().tiles as string[])[0];
    const fp = b1.kernel.requestFingerprint(m, m.operations.get("tile_fetch")!, { cid });
    const opened = b1.ledger.openCall({
      mountId: "roblox-luau", operationId: "tile_fetch", paymentId: paymentId(),
      requestFingerprint: fp, fingerprintVersion: "fp-v1", initialState: "payment_present",
    });
    const callId = opened.call.call_id;
    b1.ledger.transition(callId, "payment_present", "verified");
    b1.ledger.acquireLease(callId, "execute", 60_000);
    b1.ledger.transition(callId, "verified", "executing");
    b1.close();

    const b2 = await boot({
      manifestsDir: MANIFESTS, packsDir: PACKS, ledgerPath, port: 0,
      facilitator: new StubFacilitator("valid"), requireTls: false, payToOverride: PAY_TO,
    });
    assert.equal(b2.ledger.getCall(callId)!.state, "execution_unknown");
    // The recovery edge is recorded AS a recovery, not silently.
    const rec = b2.ledger.db
      .prepare("SELECT recovery FROM call_states WHERE call_id=? AND to_state='execution_unknown'")
      .get(callId) as { recovery: number };
    assert.equal(rec.recovery, 1);
    assert.equal(count(b2, "receipts"), 0);
    b2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("boot refuses when a generated artifact drifts from generated.lock", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "x402-drift-"));
  try {
    const { mkdirSync, cpSync, writeFileSync, readFileSync } = await import("node:fs");
    const md = path.join(dir, "manifests");
    mkdirSync(md, { recursive: true });
    cpSync(MANIFESTS, md, { recursive: true });
    const tampered = JSON.parse(readFileSync(path.join(md, "refusals.json"), "utf8"));
    tampered.codes.payment_invalid.http = 200; // make a refusal look like success
    writeFileSync(path.join(md, "refusals.json"), JSON.stringify(tampered, null, 2) + "\n");
    await assert.rejects(
      () => boot({
        manifestsDir: md, packsDir: PACKS, ledgerPath: path.join(dir, "l.db"), port: 0,
        facilitator: new StubFacilitator("valid"), requireTls: false, payToOverride: PAY_TO,
      }),
      /BOOT_REFUSED.*generated\.lock/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no payment payload material appears in the response", async () => {
  await withServer("valid", async ({ url, b }) => {
    const SENTINEL = "SENTINEL-a7f3c9e2-secret-signature-material";
    const res = await fetch(`${url}/roblox-luau/tile/${firstCid(b)}`, {
      headers: {
        "x-payment-id": paymentId(),
        "x-payment": paymentHeader("n10", { signature: SENTINEL }),
      },
    });
    const text = await res.text();
    const headers = JSON.stringify([...res.headers.entries()]);
    assert.ok(!text.includes(SENTINEL), "signature material leaked into the body");
    assert.ok(!headers.includes(SENTINEL), "signature material leaked into headers");
  });
});
