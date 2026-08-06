/**
 * server.ts — boot the mount kernel, with or without a listener.
 *
 * Boot order, all fail-closed:
 *   1. sweep env for spending-key-shaped values (refuse)
 *   2. load generated manifests; verify every digest against generated.lock
 *   3. load + verify each substrate pack ONCE (merkle root + detached seal)
 *   4. open the ledger, reconcile anything a previous boot left mid-flight
 *   5. admit mounts and build the kernel
 *   6. attach transports
 *
 * Steps 1–5 are `bootKernelOnly` and know nothing about HTTP; `boot` is that
 * plus the paid listener. A second transport composes the same core rather
 * than paying for an HTTP server object it will never listen on.
 *
 * Usage:
 *   node dist/server.js                 # stub facilitator (local simulation)
 *   X402_FACILITATOR_URL=... node ...   # real facilitator
 */
import { readFileSync, existsSync, chmodSync } from "node:fs";
import * as path from "node:path";
import { Ledger } from "./ledger.js";
import { Substrate, canonicalize, cidOf, type TrustEntry } from "./substrate.js";
import { Kernel, type Mount, type MountOperation } from "./kernel.js";
import { StubFacilitator, HttpFacilitator, type FacilitatorClient } from "./facilitator.js";
import { createPaidServer } from "./http.js";
import { assertNoSpendingKeysInEnv, resolvePayTo, SecretRefusal } from "./secrets.js";
import { KERNEL_VERSION } from "./version.js";

export interface KernelBootOptions {
  manifestsDir: string;
  packsDir: string;
  ledgerPath: string;
  facilitator?: FacilitatorClient;
  /** Test-only: bypass env resolution for payTo. */
  payToOverride?: string;
}

export interface BootOptions extends KernelBootOptions {
  port: number;
  requireTls?: boolean;
}

/** The transport-facing slice of runtime-policy.json, digest-verified at boot. */
export interface RuntimePolicy {
  paid: {
    requireTls: boolean;
    rateLimit: { windowSeconds: number; maxRequests: number; anonymous402MaxRequests: number };
  };
  networks: { mainnetStartupBlocked: string[] };
}

export interface BootedKernel {
  kernel: Kernel;
  ledger: Ledger;
  mounts: Map<string, Mount>;
  /** Verified policy a transport needs (TLS posture). Ceilings are already in the kernel. */
  policy: RuntimePolicy;
  /** code → HTTP status, for edges that speak HTTP. Verified against generated.lock. */
  refusals: Record<string, { http: number }>;
  close(): void;
}

export interface Booted extends BootedKernel {
  server: import("node:http").Server;
}

/**
 * Ledger + mounts + kernel. No listener, no socket, no HTTP server object.
 *
 * This is the whole paid capability minus a way in. Every fail-closed check
 * lives here — including the stub-facilitator loopback refusal — so a transport
 * cannot acquire a kernel that skipped one.
 */
export async function bootKernelOnly(opts: KernelBootOptions): Promise<BootedKernel> {
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
  // The published refusal vocabulary, digest-verified above. The transport
  // renders statuses from this and nothing else, so the code a client reads in
  // our OpenAPI and the status it receives are the same fact.
  const refusals = read("refusals.json") as { codes: Record<string, { http: number }> };
  const policy = read("runtime-policy.json") as RuntimePolicy;

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

  // The stub approves any well-formed payment without touching a chain. That
  // is correct for tests and catastrophic for a listening service: anyone who
  // can reach the port gets unlimited free data. Requiring an explicit opt-in
  // means the dangerous configuration cannot be reached by omission.
  let facilitator = opts.facilitator;
  if (!facilitator) {
    if (process.env.X402_FACILITATOR_URL) {
      facilitator = new HttpFacilitator(
        process.env.X402_FACILITATOR_URL,
        process.env.X402_FACILITATOR_API_KEY,
        "http"
      );
    } else if (process.env.X402_ALLOW_STUB_FACILITATOR === "1") {
      console.warn(
        "[SECURITY] stub facilitator active — every well-formed payment is " +
          "accepted WITHOUT verification. Never expose this beyond loopback."
      );
      facilitator = new StubFacilitator("valid");
    } else {
      throw new Error(
        "BOOT_REFUSED: no facilitator. Set X402_FACILITATOR_URL for real " +
          "settlement, or X402_ALLOW_STUB_FACILITATOR=1 to knowingly accept " +
          "unverified payments (loopback only)."
      );
    }
  }

  // Belt-and-suspenders: an unverified facilitator on a public interface is
  // "free data for anyone who can route to us". Refuse the pairing outright
  // rather than trusting two independent settings to both be right.
  const bindAddr = process.env.X402_BIND ?? "127.0.0.1";
  const isLoopback = bindAddr === "127.0.0.1" || bindAddr === "localhost" || bindAddr === "::1";
  if (facilitator.id === "stub" && !isLoopback && !opts.facilitator) {
    throw new Error(
      `BOOT_REFUSED: stub facilitator bound to ${bindAddr}. Unverified payments ` +
        `must never leave loopback.`
    );
  }

  // The declared ceiling, enforced once behind the kernel boundary — the same
  // numbers the HTTP edge used to hold, now shared with every future spoke.
  const kernel = new Kernel(ledger, mounts, facilitator, {
    windowMs: policy.paid.rateLimit.windowSeconds * 1000,
    max: policy.paid.rateLimit.maxRequests,
    anonymousMax: policy.paid.rateLimit.anonymous402MaxRequests,
  });
  return {
    kernel,
    ledger,
    mounts,
    policy,
    refusals: refusals.codes,
    close() {
      ledger.close();
    },
  };
}

/**
 * The kernel plus a paid HTTP listener, constructed but not listening.
 *
 * `requireTls` defaults to the verified runtime policy, so omitting it fails
 * closed rather than open.
 */
export async function boot(opts: BootOptions): Promise<Booted> {
  const core = await bootKernelOnly(opts);
  const server = createPaidServer(core.kernel, {
    port: opts.port,
    requireTls: opts.requireTls ?? core.policy.paid.requireTls,
    refusals: core.refusals,
  });

  return {
    ...core,
    server,
    close() {
      server.close();
      core.close();
    },
  };
}

/**
 * Load .env.local into process.env without overwriting anything already set.
 *
 * This is what lets a launchd plist carry zero configuration: the service
 * definition stays in git, the values stay in a gitignored file. Shell-set
 * vars still win, so a one-off run can override without editing the file.
 */
function loadEnvFile(dir: string): string | null {
  for (const name of [".env.local", ".env"]) {
    const p = path.join(dir, name);
    if (!existsSync(p)) continue;
    // This file will hold a facilitator API key. Tighten it on every load so
    // a permissive default can never persist unnoticed.
    try {
      chmodSync(p, 0o600);
    } catch {
      /* non-fatal: read-only mount, or not owner */
    }
    for (const raw of readFileSync(p, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (val !== "" && process.env[key] === undefined) process.env[key] = val;
    }
    return name;
  }
  return null;
}

// ── CLI boot ─────────────────────────────────────────────────────────────────
if (require.main === module) {
  const here = path.resolve(__dirname, "..");
  const envFile = loadEnvFile(here);
  if (envFile) console.log(`[${new Date().toISOString()}] loaded ${envFile}`);
  const port = Number(process.env.PORT ?? 8787);
  boot({
    manifestsDir: path.resolve(here, "../manifests"),
    packsDir: path.resolve(here, "packs"),
    ledgerPath: path.resolve(here, "ledger.db"),
    port,
    // Absent env → inherit runtime-policy (true). Only an explicit "0"
    // disables the fail-closed TLS check, so forgetting to set it is safe.
    requireTls: process.env.X402_REQUIRE_TLS !== "0",
    payToOverride: process.env.X402_PAYTO_ROBLOX_LUAU_PAYTO ? undefined : "0x0000000000000000000000000000000000000dev",
  })
    .then((b) => {
      // Loopback unless told otherwise. A paid endpoint bound to every
      // interface by default is an accident waiting for a network change.
      const bind = process.env.X402_BIND ?? "127.0.0.1";
      b.server.listen(port, bind, () => {
        const facilitatorKind = process.env.X402_FACILITATOR_URL ? "http" : "stub (local simulation)";
        console.log(`[${new Date().toISOString()}] x402 mount kernel listening on ${bind}:${port}`);
        if (bind !== "127.0.0.1" && bind !== "localhost") {
          console.warn(`[SECURITY] bound to ${bind} — publicly reachable. Confirm TLS termination and the facilitator are real.`);
        }
        console.log(`  facilitator ${facilitatorKind}`);
        for (const m of b.mounts.values()) {
          console.log(`  mount ${m.mountId} — ${m.substrate.tileCount} tiles, ${[...m.operations.keys()].join(", ")}`);
        }
      });

      // Graceful shutdown. A supervisor sends SIGTERM; if we exit dirty the
      // ledger can be left with a lease held by a boot that is gone, which
      // costs a needless quarantine on the next start. Close the listener,
      // let in-flight calls finish, then close the ledger.
      let closing = false;
      const shutdown = (sig: string) => {
        if (closing) return;
        closing = true;
        console.log(`[${new Date().toISOString()}] ${sig} — draining`);
        b.server.close(() => {
          b.ledger.close();
          console.log(`[${new Date().toISOString()}] ledger closed, exiting 0`);
          process.exit(0);
        });
        // Never hang a supervisor: hard-exit if drain stalls.
        setTimeout(() => {
          console.error(`[${new Date().toISOString()}] drain timed out — forcing exit`);
          process.exit(0);
        }, 10_000).unref();
      };
      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));
    })
    .catch((e) => {
      // Fail closed and say why. Under a supervisor this is a restart loop, so
      // the reason has to be in the log or the loop is undiagnosable.
      const msg = e instanceof SecretRefusal ? e.message : (e as Error).message;
      console.error(`[${new Date().toISOString()}] BOOT REFUSED: ${msg}`);
      process.exit(1);
    });
}
