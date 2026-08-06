/**
 * adapter.ts — the manifest-bound adapter registry.
 *
 * A capability is: a Zod strict argument schema, a declared size ceiling, a
 * declared replay-safety flag, and a handler that turns validated args plus a
 * substrate into bytes. `defineAdapter` only shapes that declaration — it
 * binds nothing to a route, a price, or a discovery entry. The commercial
 * manifest (x402-routes.json, generated from spectral-config) stays the sole
 * source for those; this registry exists to bind a manifest-declared
 * `operationId` to the code that actually runs it, and to let boot refuse the
 * two ways that binding can go wrong: a manifest entry nobody implements, or
 * an implementation nobody asked for.
 *
 * What this file does NOT do: decide routes, prices, or schemas for the wire
 * (those stay generated, in x402-routes.json / openapi.json / mcp-tools.json).
 * An adapter's `argSchema` is an enforcement copy of what the generator
 * already publishes for that operationId — the same arrangement `payment-id.ts`
 * and the CID pattern in kernel.ts already use — not a second design surface.
 */
import type { z } from "zod";
import type { Substrate } from "./substrate.js";

/** What a handler needs beyond its own validated args. Nothing else is reachable. */
export interface AdapterContext {
  substrate: Substrate;
}

export interface AdapterResult {
  bytes: Buffer;
  contentType: string;
}

export type AdapterHandler<Args> = (
  args: Args,
  ctx: AdapterContext
) => AdapterResult | Promise<AdapterResult>;

/** A registered capability, keyed by the manifest `operationId` it implements. */
export interface Adapter<Args = unknown> {
  readonly operationId: string;
  readonly argSchema: z.ZodType<Args>;
  /** This adapter's own claim about its output size — see boot-time cross-check in server.ts. */
  readonly maxResultBytes: number;
  /** Declaration only. Kernel replay behavior is ledger-driven and does not read this. */
  readonly declaredReplaySafe: boolean;
  readonly handler: AdapterHandler<Args>;
}

export interface AdapterDefinition<Schema extends z.ZodTypeAny> {
  operationId: string;
  argSchema: Schema;
  maxResultBytes: number;
  declaredReplaySafe: boolean;
  handler: AdapterHandler<z.infer<Schema>>;
}

/**
 * Declares one capability. This is registration only — nothing here touches
 * routes, prices, or discovery; the manifest still owns those. Task 7's
 * external adapters go through this same function.
 */
export function defineAdapter<Schema extends z.ZodTypeAny>(
  def: AdapterDefinition<Schema>
): Adapter<z.infer<Schema>> {
  return {
    operationId: def.operationId,
    argSchema: def.argSchema,
    maxResultBytes: def.maxResultBytes,
    declaredReplaySafe: def.declaredReplaySafe,
    handler: def.handler,
  };
}

/** The lookup table `Kernel` dispatches through, keyed by operationId. */
export type AdapterRegistry = ReadonlyMap<string, Adapter<any>>;

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
 * kind of ambiguity a manifest-bound registry exists to remove.
 */
export function buildAdapterRegistry(adapters: readonly Adapter<any>[]): AdapterRegistry {
  const map = new Map<string, Adapter<any>>();
  for (const a of adapters) {
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
  adapter: Adapter<any>,
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

  const first = await adapter.handler(parsed.data, ctx);
  if (first.bytes.length > adapter.maxResultBytes) {
    throw new AdapterConformanceError(
      `adapter "${adapter.operationId}": produced ${first.bytes.length} bytes, exceeding its declared maxResultBytes ${adapter.maxResultBytes}`
    );
  }

  if (adapter.declaredReplaySafe) {
    const second = await adapter.handler(parsed.data, ctx);
    if (!first.bytes.equals(second.bytes) || first.contentType !== second.contentType) {
      throw new AdapterConformanceError(
        `adapter "${adapter.operationId}": declares replay-safe but two invocations with identical fixture args produced different output`
      );
    }
  }
}
