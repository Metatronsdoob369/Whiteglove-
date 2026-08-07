/**
 * adapter.ts — the manifest-bound adapter registry.
 *
 * A capability is: a Zod strict OBJECT argument schema over string values, a
 * declared size ceiling, a declared replay-safety flag, and a handler that
 * turns validated args plus a substrate into bytes. `defineAdapter` only
 * shapes that declaration — it binds nothing to a route, a price, or a
 * discovery entry. The commercial manifest (x402-routes.json, generated from
 * spectral-config) stays the sole source for those; this registry exists to
 * bind a manifest-declared `operationId` to the code that actually runs it,
 * and to let boot refuse the two ways that binding can go wrong: a manifest
 * entry nobody implements, or an implementation nobody asked for.
 *
 * What this file does NOT do: decide routes, prices, or schemas for the wire
 * (those stay generated, in x402-routes.json / openapi.json / mcp-tools.json).
 * An adapter's `argSchema` is an enforcement copy of what the generator
 * already publishes for that operationId — the same arrangement `payment-id.ts`
 * and the CID pattern in kernel.ts already use — not a second design surface.
 */
import { z } from "zod";
import type { Substrate } from "./substrate.js";

/** What a handler needs beyond its own validated args. Nothing else is reachable. */
export interface AdapterContext {
  substrate: Substrate;
}

export interface AdapterResult {
  bytes: Buffer;
  contentType: string;
}

/**
 * What an adapter's args are ever allowed to look like: a flat, string-valued
 * record. `PaidInvocation.args` (kernel.ts) is `Record<string, string>` — the
 * wire never carries anything else — and the kernel's fingerprint machinery
 * (`argDigest`) calls `.length` on every value unconditionally. Widening this
 * to `Record<string, unknown>` would let an author-supplied schema pass an
 * object, a number, or `undefined` through to that code: an object collapses
 * to `[object Object]` in the digest (two different requests, one
 * fingerprint), and `undefined.length` throws mid-`handle()`, pre-payment.
 * Constraining the type here is half the fix; `handle()` also asserts every
 * parsed value is actually a string at admission time, since `any`-typed
 * schema fields (`z.any()`, `z.unknown()`) satisfy this constraint
 * structurally without enforcing it at runtime.
 */
export type AdapterArgs = Record<string, string>;

export type AdapterHandler<Args extends AdapterArgs = AdapterArgs> = (
  args: Args,
  ctx: AdapterContext
) => AdapterResult | Promise<AdapterResult>;

/** A registered capability, keyed by the manifest `operationId` it implements. */
export interface Adapter<Args extends AdapterArgs = AdapterArgs> {
  readonly operationId: string;
  readonly argSchema: z.ZodType<Args>;
  /** This adapter's own claim about its output size — see boot-time cross-check in server.ts. */
  readonly maxResultBytes: number;
  /** Declaration only. Kernel replay behavior is ledger-driven and does not read this. */
  readonly declaredReplaySafe: boolean;
  readonly handler: AdapterHandler<Args>;
}

export interface AdapterDefinition<Schema extends z.ZodType<AdapterArgs>> {
  operationId: string;
  argSchema: Schema;
  maxResultBytes: number;
  declaredReplaySafe: boolean;
  handler: AdapterHandler<z.infer<Schema>>;
}

export class AdapterSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterSchemaError";
  }
}

/**
 * The one shape an argSchema is allowed to have: a Zod object schema built
 * with `.strict()` — no `.passthrough()`, no plain (strip-mode) `.object()`,
 * and critically, no `.transform()` / `.refine()` / `.pipe()` wrapper, since
 * those produce a `ZodEffects` instance rather than a `ZodObject` and fail the
 * `instanceof` check below outright.
 *
 * Excluding transforms is deliberate, not incidental: `handle()` validates
 * args once, at admission, and `assertAdapterConformance` re-derives its
 * fixture from the SAME schema — if a schema could transform its input, the
 * bytes it produces would depend on which of those two callers' parsed
 * output reached the handler, and conformance could never actually speak for
 * live dispatch. A non-transforming strict object schema is the one shape
 * where "parses" and "matches the declared fields exactly" are the same
 * fact, which is what lets both the kernel's admission gate and this
 * registry's own conformance tool trust a single parse.
 *
 * Checked at TWO points — inside `defineAdapter` (fails fast at the
 * declaration site) and again in `buildAdapterRegistry` (fails closed at
 * boot) — because `Adapter` is a plain structural interface: nothing stops
 * code from building one by hand, bypassing `defineAdapter` entirely.
 */
export function assertStrictObjectArgSchema(operationId: string, schema: z.ZodTypeAny): void {
  if (!(schema instanceof z.ZodObject) || schema._def.unknownKeys !== "strict") {
    throw new AdapterSchemaError(
      `adapter "${operationId}": argSchema must be a Zod object schema built with .strict() ` +
        `(got ${schema.constructor?.name ?? typeof schema}). Transforms, refinements, ` +
        `.passthrough(), and plain (non-strict) object schemas are not accepted — the kernel's ` +
        `admission gate relies on every unknown key being refused by the schema itself.`
    );
  }
}

/**
 * Declares one capability. This is registration only — nothing here touches
 * routes, prices, or discovery; the manifest still owns those. Task 7's
 * external adapters go through this same function.
 *
 * Throws `AdapterSchemaError` synchronously if `argSchema` is not a strict
 * Zod object schema — see `assertStrictObjectArgSchema`.
 *
 * The return type is the WIDENED `Adapter<AdapterArgs>`, not the precise
 * `Adapter<z.infer<Schema>>` — every adapter ends up in one heterogeneous
 * registry (`AdapterRegistry`, `BUILTIN_ADAPTERS`), and `Adapter<Args>` is
 * invariant in `Args` (it appears contravariantly in `handler`'s parameter),
 * so a collection of adapters with DIFFERENT precise arg shapes can only be
 * typed uniformly at their common, declared shape — `AdapterArgs` itself.
 * The one cast this requires is sound by construction, not by assertion: the
 * kernel is the only caller of `adapter.handler`, and it always supplies the
 * exact `args` that just passed THIS SAME adapter's `argSchema.safeParse` a
 * few lines earlier in `handle()` — never another adapter's args, and never
 * an unvalidated `Record<string, string>` pulled from anywhere else.
 */
export function defineAdapter<Schema extends z.ZodType<AdapterArgs>>(
  def: AdapterDefinition<Schema>
): Adapter<AdapterArgs> {
  assertStrictObjectArgSchema(def.operationId, def.argSchema);
  return {
    operationId: def.operationId,
    argSchema: def.argSchema,
    maxResultBytes: def.maxResultBytes,
    declaredReplaySafe: def.declaredReplaySafe,
    handler: def.handler,
  } as Adapter<AdapterArgs>;
}

/** The lookup table `Kernel` dispatches through, keyed by operationId. */
export type AdapterRegistry = ReadonlyMap<string, Adapter>;

export class AdapterRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterRegistrationError";
  }
}

/**
 * Builds the registry from a flat list. Refuses two adapters declaring the
 * same operationId outright — a silent last-write-wins here would make
 * "which handler actually runs" depend on array order, which is exactly the
 * kind of ambiguity a manifest-bound registry exists to remove. Also
 * re-asserts the strict-object argSchema shape (see `assertStrictObjectArgSchema`)
 * for every adapter, closing the path an adapter built by hand — rather than
 * through `defineAdapter` — would otherwise have around that check.
 */
export function buildAdapterRegistry(adapters: readonly Adapter[]): AdapterRegistry {
  const map = new Map<string, Adapter>();
  for (const a of adapters) {
    assertStrictObjectArgSchema(a.operationId, a.argSchema);
    if (map.has(a.operationId)) {
      throw new AdapterRegistrationError(`adapter already registered for operationId "${a.operationId}"`);
    }
    map.set(a.operationId, a);
  }
  return map;
}

/**
 * The failure a handler throws for a declared, expected miss — unknown
 * content, bad shape, an oversize result. Not for bugs: an adapter bug should
 * throw its own error and fail the call as `capability_unavailable` via the
 * kernel's catch-all, not be laundered through a miss code it doesn't mean.
 */
export class AdapterMiss extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AdapterMiss";
  }
}

export class AdapterConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterConformanceError";
  }
}

/**
 * Runtime conformance check for a registered adapter, using caller-supplied
 * fixture args and context. Invoked from tests (and by future external
 * adapter authors) — it is NOT wired into the boot path, so a boot never
 * incurs the cost of a live handler call.
 *
 * This checks exactly what a runtime CAN check, from one or two calls with
 * the SAME fixture:
 *
 *   1. the fixture args round-trip through the adapter's own strict schema
 *      (parse succeeds, and parsing the parsed output again is stable)
 *   2. the produced bytes stay within the adapter's declared maxResultBytes
 *   3. only when the adapter declares `declaredReplaySafe`, that two
 *      invocations with the identical fixture args produce byte-identical
 *      output
 *
 * It does NOT — and cannot — prove an adapter is pure or deterministic in
 * general. A handler that reads the network, the clock, or global mutable
 * state can still pass every check here (two calls in the same test run can
 * easily observe the same instant, or the same cache line). This is a
 * runtime smoke test over one fixture, not a proof over all inputs.
 */
export async function assertAdapterConformance(
  adapter: Adapter<AdapterArgs>,
  fixtureArgs: unknown,
  ctx: AdapterContext
): Promise<void> {
  const parsed = adapter.argSchema.safeParse(fixtureArgs);
  if (!parsed.success) {
    throw new AdapterConformanceError(
      `adapter "${adapter.operationId}": fixture args failed its own argSchema: ${parsed.error.message}`
    );
  }
  const reparsed = adapter.argSchema.safeParse(parsed.data);
  if (!reparsed.success || JSON.stringify(reparsed.data) !== JSON.stringify(parsed.data)) {
    throw new AdapterConformanceError(
      `adapter "${adapter.operationId}": argSchema is not stable under round-trip parsing`
    );
  }

  // The handler is called with `fixtureArgs`, NOT `parsed.data` — dispatch
  // never re-parses (see `runAdapter` in kernel.ts: the kernel validates args
  // against this same schema once, at admission, then hands the RAW args
  // straight to the handler). `assertStrictObjectArgSchema` guarantees the
  // outer schema is a non-transforming strict object, but a FIELD-level
  // wrapper (`.transform()`, `.default()`, `.catch()`, `z.preprocess`) can
  // still make `parsed.data` differ from what the caller actually sent, even
  // though the object itself passes that check. Calling the handler with
  // `parsed.data` here would measure a call live dispatch never makes;
  // `fixtureArgs` — already proven above to parse successfully — is what a
  // handler actually receives in production.
  const args = fixtureArgs as AdapterArgs;
  const first = await adapter.handler(args, ctx);
  if (first.bytes.length > adapter.maxResultBytes) {
    throw new AdapterConformanceError(
      `adapter "${adapter.operationId}": produced ${first.bytes.length} bytes, exceeding its declared maxResultBytes ${adapter.maxResultBytes}`
    );
  }

  if (adapter.declaredReplaySafe) {
    const second = await adapter.handler(args, ctx);
    if (!first.bytes.equals(second.bytes) || first.contentType !== second.contentType) {
      throw new AdapterConformanceError(
        `adapter "${adapter.operationId}": declares replay-safe but two invocations with identical fixture args produced different output`
      );
    }
  }
}
