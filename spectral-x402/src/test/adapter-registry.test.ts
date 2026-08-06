/**
 * adapter-registry.test.ts — the manifest-bound adapter registry.
 *
 * kernel.test.ts pins what the three built-in operations DO; these pin the
 * registry mechanism itself: that boot refuses a manifest/registry mismatch
 * in EITHER direction, that a declared maxResultBytes contradiction is
 * refused too, that `assertAdapterConformance` checks what it claims to
 * check and nothing more, and that a genuinely new capability can be
 * registered through the package's own public entry point (`../index.js`) —
 * the surface Task 7 exercises — and actually served end to end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { bootKernelOnly, type BootedKernel } from "../server.js";
import { BUILTIN_ADAPTERS } from "../kernel.js";
import { cidOf } from "../substrate.js";
import { StubFacilitator, type PaymentPayload } from "../facilitator.js";
import {
  defineAdapter,
  assertAdapterConformance,
  AdapterConformanceError,
  type Adapter,
  type AdapterContext,
} from "../index.js";

const MANIFESTS = path.resolve(__dirname, "../../../manifests");
const PACKS = path.resolve(__dirname, "../../packs");
const PAY_TO = "0x0000000000000000000000000000000000000dev";
const MOUNT = "roblox-luau";

function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "x402-registry-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function bootWith(dir: string, adapters?: readonly Adapter<any>[]): Promise<BootedKernel> {
  return bootKernelOnly({
    manifestsDir: MANIFESTS,
    packsDir: PACKS,
    ledgerPath: path.join(dir, "ledger.db"),
    facilitator: new StubFacilitator("valid"),
    payToOverride: PAY_TO,
    ...(adapters ? { adapters } : {}),
  });
}

// ─── (a) boot refusal is symmetric ───────────────────────────────────────────

test("registry: a manifest operation with no registered adapter refuses boot, naming the operationId", async () => {
  await withTmpDir(async (dir) => {
    const adapters = BUILTIN_ADAPTERS.filter((a) => a.operationId !== "pack_manifest");
    await assert.rejects(
      () => bootWith(dir, adapters),
      (e: Error) => {
        assert.match(e.message, /BOOT_REFUSED/);
        assert.match(e.message, /pack_manifest/);
        assert.match(e.message, /no registered adapter handler/);
        return true;
      }
    );
  });
});

test("registry: a registered adapter with no manifest entry refuses boot, naming the operationId", async () => {
  await withTmpDir(async (dir) => {
    const orphan = defineAdapter({
      operationId: "fake_op_no_manifest_entry",
      argSchema: z.object({}).strict(),
      maxResultBytes: 10,
      declaredReplaySafe: true,
      handler: () => ({ bytes: Buffer.alloc(0), contentType: "text/plain" }),
    });
    await assert.rejects(
      () => bootWith(dir, [...BUILTIN_ADAPTERS, orphan]),
      (e: Error) => {
        assert.match(e.message, /BOOT_REFUSED/);
        assert.match(e.message, /fake_op_no_manifest_entry/);
        assert.match(e.message, /no manifest entry/);
        return true;
      }
    );
  });
});

test("registry: an adapter declaring more than a mount's maxResultBytes refuses boot as a config contradiction", async () => {
  await withTmpDir(async (dir) => {
    const oversized = defineAdapter({
      operationId: "tile_fetch",
      argSchema: z.object({ cid: z.string() }).strict(),
      maxResultBytes: 999_999_999,
      declaredReplaySafe: true,
      handler: (args: { cid: string }, ctx: AdapterContext) => {
        const bytes = ctx.substrate.getTile(args.cid);
        return { bytes: Buffer.from(bytes ?? Buffer.alloc(0)), contentType: ctx.substrate.payloadContentType };
      },
    });
    const adapters = [oversized, ...BUILTIN_ADAPTERS.filter((a) => a.operationId !== "tile_fetch")];
    await assert.rejects(
      () => bootWith(dir, adapters),
      (e: Error) => {
        assert.match(e.message, /BOOT_REFUSED/);
        assert.match(e.message, /tile_fetch/);
        assert.match(e.message, /exceeding/);
        return true;
      }
    );
  });
});

test("registry: an adapter list identical to BUILTIN_ADAPTERS boots exactly like the default", async () => {
  await withTmpDir(async (dir) => {
    const core = await bootWith(dir, BUILTIN_ADAPTERS);
    assert.ok(core.mounts.size > 0);
    assert.ok([...core.mounts.values()][0].operations.has("tile_fetch"));
    core.close();
  });
});

// ─── (b) assertAdapterConformance checks exactly what it claims ─────────────

test("registry: assertAdapterConformance passes the three built-ins with a real fixture", async () => {
  await withTmpDir(async (dir) => {
    const core = await bootWith(dir);
    try {
      const substrate = core.mounts.get(MOUNT)!.substrate;
      const cid = (substrate.getManifest().tiles as string[])[0];
      const ctx: AdapterContext = { substrate };
      for (const op of ["tile_fetch", "pack_inclusion_proof", "pack_manifest"]) {
        const adapter = BUILTIN_ADAPTERS.find((a) => a.operationId === op)!;
        const fixture = op === "pack_manifest" ? {} : { cid };
        await assert.doesNotReject(
          () => assertAdapterConformance(adapter, fixture, ctx),
          `conformance should pass for ${op}`
        );
      }
    } finally {
      core.close();
    }
  });
});

test("registry: assertAdapterConformance rejects a fixture that fails the adapter's own strict schema", async () => {
  await withTmpDir(async (dir) => {
    const core = await bootWith(dir);
    try {
      const substrate = core.mounts.get(MOUNT)!.substrate;
      const cid = (substrate.getManifest().tiles as string[])[0];
      const adapter = BUILTIN_ADAPTERS.find((a) => a.operationId === "tile_fetch")!;
      await assert.rejects(
        () => assertAdapterConformance(adapter, { cid, extra: "not declared" }, { substrate }),
        AdapterConformanceError
      );
    } finally {
      core.close();
    }
  });
});

test("registry: assertAdapterConformance rejects output exceeding the adapter's declared maxResultBytes", async () => {
  await withTmpDir(async (dir) => {
    const core = await bootWith(dir);
    try {
      const substrate = core.mounts.get(MOUNT)!.substrate;
      const cid = (substrate.getManifest().tiles as string[])[0];
      const undersized = defineAdapter({
        operationId: "tile_fetch",
        argSchema: z.object({ cid: z.string() }).strict(),
        maxResultBytes: 1, // no real tile is this small
        declaredReplaySafe: true,
        handler: (args: { cid: string }, ctx: AdapterContext) => {
          const bytes = ctx.substrate.getTile(args.cid)!;
          return { bytes: Buffer.from(bytes), contentType: ctx.substrate.payloadContentType };
        },
      });
      await assert.rejects(
        () => assertAdapterConformance(undersized, { cid }, { substrate }),
        (e: Error) => {
          assert.ok(e instanceof AdapterConformanceError);
          assert.match(e.message, /maxResultBytes/);
          return true;
        }
      );
    } finally {
      core.close();
    }
  });
});

test("registry: assertAdapterConformance rejects a declared-replay-safe adapter whose output is not stable", async () => {
  await withTmpDir(async (dir) => {
    const core = await bootWith(dir);
    try {
      const substrate = core.mounts.get(MOUNT)!.substrate;
      const flaky = defineAdapter({
        operationId: "flaky_test",
        argSchema: z.object({}).strict(),
        maxResultBytes: 1024,
        declaredReplaySafe: true,
        handler: () => ({ bytes: randomBytes(16), contentType: "application/octet-stream" }),
      });
      await assert.rejects(
        () => assertAdapterConformance(flaky, {}, { substrate }),
        (e: Error) => {
          assert.ok(e instanceof AdapterConformanceError);
          assert.match(e.message, /replay-safe/);
          return true;
        }
      );
    } finally {
      core.close();
    }
  });
});

test("registry: assertAdapterConformance does NOT run the stability check when declaredReplaySafe is false", async () => {
  await withTmpDir(async (dir) => {
    const core = await bootWith(dir);
    try {
      const substrate = core.mounts.get(MOUNT)!.substrate;
      const flakyButHonest = defineAdapter({
        operationId: "flaky_honest_test",
        argSchema: z.object({}).strict(),
        maxResultBytes: 1024,
        declaredReplaySafe: false, // does not claim what it cannot promise
        handler: () => ({ bytes: randomBytes(16), contentType: "application/octet-stream" }),
      });
      await assert.doesNotReject(() => assertAdapterConformance(flakyButHonest, {}, { substrate }));
    } finally {
      core.close();
    }
  });
});

test("registry: assertAdapterConformance rejects an argSchema that is not stable under round-trip parsing", async () => {
  await withTmpDir(async (dir) => {
    const core = await bootWith(dir);
    try {
      const substrate = core.mounts.get(MOUNT)!.substrate;
      // A schema whose transform mutates on every parse — parsing its own
      // output again does not reproduce that output. Fixture-agnostic: this
      // fails before the handler is even reachable via a normal call.
      const unstableSchema = z.object({ n: z.number() }).transform((v) => ({ n: v.n + 1 }));
      const unstable = defineAdapter({
        operationId: "unstable_schema_test",
        argSchema: unstableSchema,
        maxResultBytes: 64,
        declaredReplaySafe: false,
        handler: () => ({ bytes: Buffer.from("x"), contentType: "text/plain" }),
      });
      await assert.rejects(
        () => assertAdapterConformance(unstable, { n: 1 }, { substrate }),
        (e: Error) => {
          assert.ok(e instanceof AdapterConformanceError);
          assert.match(e.message, /round-trip/);
          return true;
        }
      );
    } finally {
      core.close();
    }
  });
});

// ─── (c) a new capability, registered through the public API, end to end ────

/** Clones manifests and appends a fourth route to the roblox-luau mount. */
function manifestsWithEchoOp(dir: string): string {
  const md = path.join(dir, "manifests");
  mkdirSync(md, { recursive: true });
  cpSync(MANIFESTS, md, { recursive: true });

  const routes = JSON.parse(readFileSync(path.join(md, "x402-routes.json"), "utf8"));
  const mount = routes.mounts.find((m: { mountId: string }) => m.mountId === MOUNT);
  mount.routes.push({
    operationId: "echo_ping",
    method: "GET",
    pathTemplate: `/${MOUNT}/echo`,
    resultKind: "manifest-json",
    deadlineMs: 5,
    maxResultBytes: 64,
    priceAtomic: "100",
  });
  writeFileSync(path.join(md, "x402-routes.json"), JSON.stringify(routes, null, 2) + "\n");

  // Re-seal the lock over the edited artifact — the only legitimate way to
  // change what the kernel will boot (see agnostic.test.ts for the refusal
  // path this deliberately does not exercise).
  const lock = JSON.parse(readFileSync(path.join(md, "generated.lock"), "utf8"));
  lock.artifacts["x402-routes.json"] = cidOf(routes);
  writeFileSync(path.join(md, "generated.lock"), JSON.stringify(lock, null, 2) + "\n");
  return md;
}

test("registry: a new capability registered via defineAdapter (from the public index) is boot-admitted and delivers", async () => {
  await withTmpDir(async (dir) => {
    const md = manifestsWithEchoOp(dir);
    const echoAdapter = defineAdapter({
      operationId: "echo_ping",
      argSchema: z.object({}).strict(),
      maxResultBytes: 64,
      declaredReplaySafe: true,
      handler: () => ({ bytes: Buffer.from(JSON.stringify({ pong: true })), contentType: "application/json" }),
    });

    const core = await bootKernelOnly({
      manifestsDir: md,
      packsDir: PACKS,
      ledgerPath: path.join(dir, "ledger.db"),
      facilitator: new StubFacilitator("valid"),
      payToOverride: PAY_TO,
      adapters: [...BUILTIN_ADAPTERS, echoAdapter],
    });
    try {
      const payment: PaymentPayload = {
        scheme: "exact",
        network: "eip155:84532",
        payer: "0xBUYER",
        nonce: "echo-nonce-1",
        amountAtomic: "100",
        asset: "USDC",
        payTo: PAY_TO,
      };
      const out = await core.kernel.handle({
        mountId: MOUNT,
        operationId: "echo_ping",
        args: {},
        paymentId: "pay-echo-0000000001",
        payment,
        transport: "http",
        clientKey: "echo-test-client",
        resource: `/${MOUNT}/echo`,
      });
      assert.equal(out.kind, "delivered");
      if (out.kind !== "delivered") return;
      assert.equal(out.contentType, "application/json");
      assert.deepEqual(JSON.parse(out.bytes.toString("utf8")), { pong: true });

      // Still a genuine tile_fetch mount underneath — the new capability was
      // ADDED, not swapped in place of the built-ins.
      const stillWorks = await core.kernel.handle({
        mountId: MOUNT,
        operationId: "pack_manifest",
        args: {},
        paymentId: "pay-echo-0000000002",
        payment: { ...payment, nonce: "echo-nonce-2", amountAtomic: "1000" },
        transport: "http",
        clientKey: "echo-test-client-2",
        resource: `/${MOUNT}/manifest`,
      });
      assert.equal(stillWorks.kind, "delivered");
    } finally {
      core.close();
    }
  });
});
