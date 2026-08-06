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
  buildAdapterRegistry,
  assertAdapterConformance,
  AdapterConformanceError,
  AdapterSchemaError,
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

async function bootWith(dir: string, adapters?: readonly Adapter[]): Promise<BootedKernel> {
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

test("registry: assertAdapterConformance invokes the handler with the RAW fixture, not a field-level transform's output", async () => {
  // assertStrictObjectArgSchema only inspects the OUTER schema (instanceof
  // ZodObject + unknownKeys === "strict"); a FIELD-level `.transform()` still
  // type-checks and passes that gate, since the object itself isn't a
  // ZodEffects. Live dispatch never re-parses (runAdapter hands the kernel's
  // raw inv.args straight to the handler), so conformance must call the
  // handler with the SAME raw fixture it was given — never the schema's
  // transformed parse output — or it would measure a call dispatch never
  // actually makes.
  await withTmpDir(async (dir) => {
    const core = await bootWith(dir);
    try {
      const substrate = core.mounts.get(MOUNT)!.substrate;
      let observedTag: string | undefined;
      const lowercasingField = defineAdapter({
        operationId: "lowercasing_field_test",
        argSchema: z.object({ tag: z.string().transform((s) => s.toLowerCase()) }).strict(),
        maxResultBytes: 64,
        declaredReplaySafe: false,
        handler: (args) => {
          observedTag = args.tag;
          return { bytes: Buffer.alloc(0), contentType: "text/plain" };
        },
      });
      await assertAdapterConformance(lowercasingField, { tag: "SHOUT" }, { substrate });
      assert.equal(
        observedTag,
        "SHOUT",
        "the handler must see the caller's raw fixture value, not the schema's lowercased parse output"
      );
    } finally {
      core.close();
    }
  });
});

// ─── (c) argSchema must be a strict Zod object — Finding 3 ──────────────────
//
// This is what makes the round-trip / transform-divergence concern moot: a
// ZodEffects (`.transform()`, `.refine()`, `.pipe()`) is never `instanceof
// ZodObject`, so it cannot become a registered adapter in the first place —
// not through `defineAdapter`, and not by hand-building an `Adapter` object
// and handing it to `buildAdapterRegistry` either.

test("registry: defineAdapter refuses a non-strict (default strip-mode) object schema", () => {
  // Zod's strip/strict distinction is a runtime-behavior flag, not reflected
  // in the static Output type — this schema type-checks fine against
  // Adapter<AdapterArgs> and needs no suppression; only the runtime
  // instanceof/_def check catches it.
  assert.throws(
    () =>
      defineAdapter({
        operationId: "not_strict_test",
        argSchema: z.object({ cid: z.string() }), // no .strict()
        maxResultBytes: 64,
        declaredReplaySafe: true,
        handler: () => ({ bytes: Buffer.alloc(0), contentType: "text/plain" }),
      }),
    AdapterSchemaError
  );
});

test("registry: defineAdapter refuses a .passthrough() object schema", () => {
  assert.throws(
    () =>
      defineAdapter({
        operationId: "passthrough_test",
        // @ts-expect-error — intentionally the wrong shape for this test
        argSchema: z.object({ cid: z.string() }).passthrough(),
        maxResultBytes: 64,
        declaredReplaySafe: true,
        handler: () => ({ bytes: Buffer.alloc(0), contentType: "text/plain" }),
      }),
    AdapterSchemaError
  );
});

test("registry: defineAdapter refuses a .transform()-wrapped schema, even when its output shape still fits Record<string,string>", () => {
  // Output-shape-preserving on purpose: this schema WOULD satisfy the
  // Adapter<AdapterArgs> type constraint if defineAdapter only checked types.
  // It must still be refused, because a ZodEffects is never `instanceof
  // ZodObject` — the runtime check is what actually closes this off, not the
  // compiler.
  const transformed = z
    .object({ cid: z.string() })
    .strict()
    .transform((v) => ({ cid: v.cid }));
  assert.throws(
    () =>
      defineAdapter({
        operationId: "transform_test",
        argSchema: transformed,
        maxResultBytes: 64,
        declaredReplaySafe: true,
        handler: () => ({ bytes: Buffer.alloc(0), contentType: "text/plain" }),
      }),
    AdapterSchemaError
  );
});

test("registry: buildAdapterRegistry ALSO refuses a non-strict schema on an Adapter built by hand, bypassing defineAdapter", () => {
  // Adapter is a plain structural interface — nothing stops code from
  // constructing one without going through defineAdapter's guard. This is
  // the second enforcement point (boot-time), closing that gap.
  const handBuilt: Adapter = {
    operationId: "hand_built_test",
    argSchema: z.object({}), // no .strict()
    maxResultBytes: 64,
    declaredReplaySafe: true,
    handler: () => ({ bytes: Buffer.alloc(0), contentType: "text/plain" }),
  };
  assert.throws(() => buildAdapterRegistry([handBuilt]), AdapterSchemaError);
});

// ─── (d) argSchema output must actually be strings — Finding 1 ──────────────

/** Clones manifests and appends a route for `operationId` to the roblox-luau mount. */
function manifestsWithExtraRoute(dir: string, operationId: string): string {
  const md = path.join(dir, "manifests");
  mkdirSync(md, { recursive: true });
  cpSync(MANIFESTS, md, { recursive: true });

  const routes = JSON.parse(readFileSync(path.join(md, "x402-routes.json"), "utf8"));
  const mount = routes.mounts.find((m: { mountId: string }) => m.mountId === MOUNT);
  mount.routes.push({
    operationId,
    method: "GET",
    pathTemplate: `/${MOUNT}/${operationId}`,
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

test("registry: a z.any()-typed field receiving an object value is refused, not silently digested as [object Object]", async () => {
  await withTmpDir(async (dir) => {
    const md = manifestsWithExtraRoute(dir, "risky_any_op");
    // z.any() satisfies Adapter<AdapterArgs>'s type constraint structurally
    // (any is compatible with everything) without enforcing it at runtime —
    // exactly the gap the type constraint alone cannot close.
    const risky = defineAdapter({
      operationId: "risky_any_op",
      argSchema: z.object({ payload: z.any() }).strict(),
      maxResultBytes: 64,
      declaredReplaySafe: true,
      handler: () => ({ bytes: Buffer.from("ok"), contentType: "text/plain" }),
    });
    const core = await bootKernelOnly({
      manifestsDir: md,
      packsDir: PACKS,
      ledgerPath: path.join(dir, "ledger.db"),
      facilitator: new StubFacilitator("valid"),
      payToOverride: PAY_TO,
      adapters: [...BUILTIN_ADAPTERS, risky],
    });
    try {
      const out = await core.kernel.handle({
        mountId: MOUNT,
        operationId: "risky_any_op",
        args: { payload: { nested: "object" } } as unknown as Record<string, string>,
        transport: "http",
        clientKey: "risky-test-client",
        resource: `/${MOUNT}/risky_any_op`,
      });
      assert.equal(out.kind, "refused");
      if (out.kind !== "refused") return;
      assert.equal(out.code, "args_invalid");
    } finally {
      core.close();
    }
  });
});

test("registry: an optional field explicitly set to undefined is refused, not a TypeError inside requestFingerprint", async () => {
  await withTmpDir(async (dir) => {
    const md = manifestsWithExtraRoute(dir, "cursor_op");
    const cursorAdapter = defineAdapter({
      operationId: "cursor_op",
      argSchema: z.object({ cursor: z.string().optional() }).strict(),
      maxResultBytes: 64,
      declaredReplaySafe: true,
      handler: () => ({ bytes: Buffer.from("ok"), contentType: "text/plain" }),
    });
    const core = await bootKernelOnly({
      manifestsDir: md,
      packsDir: PACKS,
      ledgerPath: path.join(dir, "ledger.db"),
      facilitator: new StubFacilitator("valid"),
      payToOverride: PAY_TO,
      adapters: [...BUILTIN_ADAPTERS, cursorAdapter],
    });
    try {
      // A well-typed caller never sends this; a malformed one (or a future
      // transport) can. This must refuse cleanly, not throw mid-handle().
      const out = await core.kernel.handle({
        mountId: MOUNT,
        operationId: "cursor_op",
        args: { cursor: undefined } as unknown as Record<string, string>,
        transport: "http",
        clientKey: "cursor-test-client",
        resource: `/${MOUNT}/cursor_op`,
      });
      assert.equal(out.kind, "refused");
      if (out.kind !== "refused") return;
      assert.equal(out.code, "args_invalid");
    } finally {
      core.close();
    }
  });
});

test("registry: a coercing field (z.coerce.string()) whose raw value is non-string is refused before fingerprinting, not silently coerced", async () => {
  await withTmpDir(async (dir) => {
    const md = manifestsWithExtraRoute(dir, "coerce_op");
    // z.coerce.string() type-checks against Adapter<AdapterArgs> (its
    // inferred output is `string`) and passes assertStrictObjectArgSchema
    // (the OUTER object is still a plain strict ZodObject) — but its parsed
    // VALUE is a coerced string even when the caller's raw value was an
    // object or null. A guard checked against parsed.data would miss this
    // entirely: the coerced value reads as a clean string while inv.args —
    // what requestFingerprint and runAdapter actually consume — still
    // carries the original non-string.
    const coerceAdapter = defineAdapter({
      operationId: "coerce_op",
      argSchema: z.object({ tag: z.coerce.string() }).strict(),
      maxResultBytes: 64,
      declaredReplaySafe: true,
      handler: () => ({ bytes: Buffer.from("ok"), contentType: "text/plain" }),
    });
    const core = await bootKernelOnly({
      manifestsDir: md,
      packsDir: PACKS,
      ledgerPath: path.join(dir, "ledger.db"),
      facilitator: new StubFacilitator("valid"),
      payToOverride: PAY_TO,
      adapters: [...BUILTIN_ADAPTERS, coerceAdapter],
    });
    try {
      // Sanity: the schema really does coerce this shape into a string —
      // proving the gap is genuine, not a schema that would have failed
      // parsing anyway.
      const parsed = coerceAdapter.argSchema.safeParse({ tag: { a: 1 } });
      assert.equal(parsed.success, true);
      if (parsed.success) assert.equal(typeof parsed.data.tag, "string");

      const objectValue = await core.kernel.handle({
        mountId: MOUNT,
        operationId: "coerce_op",
        args: { tag: { a: 1 } } as unknown as Record<string, string>,
        transport: "http",
        clientKey: "coerce-test-client-1",
        resource: `/${MOUNT}/coerce_op`,
      });
      assert.equal(objectValue.kind, "refused");
      if (objectValue.kind === "refused") assert.equal(objectValue.code, "args_invalid");

      // null also coerces to a string ("null") — and must not throw
      // mid-handle() the way argDigest's `.length` access on a raw null
      // value would.
      const nullValue = await core.kernel.handle({
        mountId: MOUNT,
        operationId: "coerce_op",
        args: { tag: null } as unknown as Record<string, string>,
        transport: "http",
        clientKey: "coerce-test-client-2",
        resource: `/${MOUNT}/coerce_op`,
      });
      assert.equal(nullValue.kind, "refused");
      if (nullValue.kind === "refused") assert.equal(nullValue.code, "args_invalid");
    } finally {
      core.close();
    }
  });
});

// ─── (e) refusal detail never echoes a caller-chosen key name — Finding 2 ───

test("registry: an unrecognized argument key never echoes the caller's key name in the refusal detail", async () => {
  await withTmpDir(async (dir) => {
    const core = await bootWith(dir);
    try {
      const cid = (core.mounts.get(MOUNT)!.substrate.getManifest().tiles as string[])[0];
      const out = await core.kernel.handle({
        mountId: MOUNT,
        operationId: "tile_fetch",
        args: { cid, evil_KEY_from_caller: "<script>" } as Record<string, string>,
        transport: "http",
        clientKey: "detail-test-client",
        resource: `/${MOUNT}/tile`,
      });
      assert.equal(out.kind, "refused");
      if (out.kind !== "refused") return;
      assert.equal(out.code, "args_invalid");
      assert.equal(out.detail, "unexpected argument");
      assert.ok(
        !out.detail?.includes("evil_KEY_from_caller") && !out.detail?.includes("<script>"),
        `refusal detail must never echo a caller-chosen key name, got: ${out.detail}`
      );
    } finally {
      core.close();
    }
  });
});

// ─── (f) a new capability, registered through the public API, end to end ───

test("registry: a new capability registered via defineAdapter (from the public index) is boot-admitted and delivers", async () => {
  await withTmpDir(async (dir) => {
    const md = manifestsWithExtraRoute(dir, "echo_ping");
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
