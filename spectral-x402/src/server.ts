/**
 * server.ts — boot the paid mount server.
 *
 * Boot order, all fail-closed:
 *   1. sweep env for spending-key-shaped values (refuse)
 *   2. load generated manifests; verify every digest against generated.lock
 *   3. load + verify each substrate pack ONCE (merkle root + detached seal)
 *   4. open the ledger, reconcile anything a previous boot left mid-flight
 *   5. admit mounts, then listen
 *
 * Usage:
 *   node dist/server.js                 # stub facilitator (local simulation)
 *   X402_FACILITATOR_URL=... node ...   # real facilitator
 */
import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { Ledger } from "./ledger.js";
import { Substrate, canonicalize, cidOf, type TrustEntry } from "./substrate.js";
import { Kernel, type Mount, type MountOperation } from "./kernel.js";
import { StubFacilitator, HttpFacilitator, type FacilitatorClient } from "./facilitator.js";
import { createPaidServer } from "./http.js";
import { assertNoSpendingKeysInEnv, resolvePayTo, SecretRefusal } from "./secrets.js";
import { KERNEL_VERSION } from "./index.js";

export interface BootOptions {
  manifestsDir: string;
  packsDir: string;
  ledgerPath: string;
  port: number;
  facilitator?: FacilitatorClient;
  requireTls?: boolean;
  /** Test-only: bypass env resolution for payTo. */
  payToOverride?: string;
}

export interface Booted {
  server: import("node:http").Server;
  kernel: Kernel;
  ledger: Ledger;
  mounts: Map<string, Mount>;
  close(): void;
}

export async function boot(opts: BootOptions): Promise<Booted> {
  assertNoSpendingKeysInEnv();

  // ── generated artifacts + lock
  const read = (n: string) => JSON.parse(readFileSync(path.join(opts.manifestsDir, n), "utf8"));
  const lock = read("generated.lock") as { artifacts: Record<string, string> };
  for (const [name, expected] of Object.entries(lock.artifacts)) {
    const p = path.join(opts.manifestsDir, name);
    if (!existsSync(p)) throw new Error(`BOOT_REFUSED: generated artifact missing: ${name}`);
    const actual = cidOf(JSON.parse(readFileSync(p, "utf8")));
    if (actual !== expected) {
      throw new Error(`BOOT_REFUSED: ${name} does not match generated.lock — regenerate (npm run generate:all)`);
    }
  }
  const routes = read("x402-routes.json") as {
    mounts: Array<{
      mountId: string;
      capabilityVersion: string;
      edition: string;
      substrate: { packRef: string; trustStoreRef: string; statusListRef: string };
      price: { networks: string[]; asset: string; payToRef: string };
      challengeEpoch: string;
      fingerprintVersion: string;
      retryEntitlementSeconds: number;
      limits: { maxPricePerCallAtomic: string; dailySettledValueCeilingAtomic: string };
      routes: Array<{ operationId: string; resultKind: string; deadlineMs: number; maxResultBytes: number; priceAtomic: string }>;
    }>;
  };
  const policy = read("runtime-policy.json") as {
    paid: { requireTls: boolean; rateLimit: { windowSeconds: number; maxRequests: number; anonymous402MaxRequests: number } };
    networks: { mainnetStartupBlocked: string[] };
  };

  // ── mainnet stays blocked without a signed gate artifact
  const gatePath = path.join(opts.manifestsDir, "mainnet-gate.json");
  const gatePresent = existsSync(gatePath);
  for (const m of routes.mounts) {
    for (const n of m.price.networks) {
      if (policy.networks.mainnetStartupBlocked.includes(n) && !gatePresent) {
        throw new Error(`BOOT_REFUSED: mount "${m.mountId}" declares ${n} but manifests/mainnet-gate.json is absent (mainnet_gate_unmet)`);
      }
    }
  }

  // ── substrates, verified exactly once
  const trustStore = JSON.parse(readFileSync(path.join(opts.packsDir, "terrain-keys.json"), "utf8")) as Record<string, TrustEntry>;
  const mounts = new Map<string, Mount>();
  for (const r of routes.mounts) {
    const substrate = Substrate.load(path.join(opts.packsDir, r.substrate.packRef), trustStore);
    const payTo = opts.payToOverride ?? resolvePayTo(r.price.payToRef);
    const operations = new Map<string, MountOperation>();
    for (const op of r.routes) {
      operations.set(op.operationId, {
        operationId: op.operationId,
        resultKind: op.resultKind as MountOperation["resultKind"],
        deadlineMs: op.deadlineMs,
        maxResultBytes: op.maxResultBytes,
        priceAtomic: op.priceAtomic,
      });
    }
    mounts.set(r.mountId, {
      mountId: r.mountId,
      capabilityVersion: r.capabilityVersion,
      adapterVersion: "1.0.0",
      edition: r.edition,
      operations,
      substrate,
      network: r.price.networks[0],
      asset: r.price.asset,
      payTo,
      challengeEpoch: r.challengeEpoch,
      fingerprintVersion: r.fingerprintVersion,
      retryEntitlementSeconds: r.retryEntitlementSeconds,
      limits: {
        maxPricePerCallAtomic: BigInt(r.limits.maxPricePerCallAtomic),
        dailySettledValueCeilingAtomic: BigInt(r.limits.dailySettledValueCeilingAtomic),
      },
    });
  }

  // ── ledger + crash reconciliation
  const lockDigest = cidOf(lock);
  const ledger = new Ledger(opts.ledgerPath, { kernelVersion: KERNEL_VERSION, lockDigest });
  const recon = ledger.reconcileOnBoot();
  for (const m of mounts.values()) {
    ledger.registerMount({
      mountId: m.mountId,
      capabilityVersion: m.capabilityVersion,
      adapterVersion: m.adapterVersion,
      packId: m.substrate.packId,
      merkleRoot: m.substrate.merkleRootHex,
      fingerprintVersion: m.fingerprintVersion,
    });
  }

  const facilitator =
    opts.facilitator ??
    (process.env.X402_FACILITATOR_URL
      ? new HttpFacilitator(process.env.X402_FACILITATOR_URL, process.env.X402_FACILITATOR_API_KEY, "http")
      : new StubFacilitator("valid"));

  const kernel = new Kernel(ledger, mounts, facilitator);
  const server = createPaidServer(kernel, {
    port: opts.port,
    requireTls: opts.requireTls ?? policy.paid.requireTls,
    rateLimit: {
      windowMs: policy.paid.rateLimit.windowSeconds * 1000,
      max: policy.paid.rateLimit.maxRequests,
      anonymousMax: policy.paid.rateLimit.anonymous402MaxRequests,
    },
  });

  return {
    server,
    kernel,
    ledger,
    mounts,
    close() {
      server.close();
      ledger.close();
    },
  };
}

// ── CLI boot ─────────────────────────────────────────────────────────────────
if (require.main === module) {
  const here = path.resolve(__dirname, "..");
  const port = Number(process.env.PORT ?? 8787);
  boot({
    manifestsDir: path.resolve(here, "../manifests"),
    packsDir: path.resolve(here, "packs"),
    ledgerPath: path.resolve(here, "ledger.db"),
    port,
    requireTls: process.env.X402_REQUIRE_TLS === "1",
    payToOverride: process.env.X402_PAYTO_ROBLOX_LUAU_PAYTO ? undefined : "0x0000000000000000000000000000000000000dev",
  })
    .then((b) => {
      b.server.listen(port, "0.0.0.0", () => {
        const facilitatorKind = process.env.X402_FACILITATOR_URL ? "http" : "stub (local simulation)";
        console.log(`x402 mount kernel listening on :${port}`);
        console.log(`  facilitator ${facilitatorKind}`);
        for (const m of b.mounts.values()) {
          console.log(`  mount ${m.mountId} — ${m.substrate.tileCount} tiles, ${[...m.operations.keys()].join(", ")}`);
        }
      });
    })
    .catch((e) => {
      if (e instanceof SecretRefusal) console.error(`\n${e.message}\n`);
      else console.error(`\n${(e as Error).message}\n`);
      process.exit(1);
    });
}
