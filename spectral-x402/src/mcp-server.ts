/**
 * mcp-server.ts — boot the mount kernel behind an MCP listener.
 *
 * The exact counterpart of `boot` in server.ts: the SAME `bootKernelOnly`
 * core — same digest-verified manifests, same verified packs, same ledger,
 * same fail-closed facilitator rules — with a different way in. Nothing about
 * a paid call is decided here.
 *
 * Streamable HTTP, not stdio: stdio serves one locally spawned client, and
 * this is a remote, multi-client paid surface.
 *
 * Bind address is `X402_BIND`, the SAME variable the HTTP surface uses, and
 * deliberately not a second one — `bootKernelOnly`'s refusal to pair a stub
 * facilitator with a non-loopback bind reads that variable, so a spoke that
 * invented its own would be a spoke that guard does not cover.
 *
 * The port is its own variable because two listeners cannot share one.
 *
 * Usage:
 *   node dist/mcp-server.js                 # stub facilitator (local simulation)
 *   X402_FACILITATOR_URL=... node ...       # real facilitator
 */
import type * as http from "node:http";
import * as path from "node:path";
import { bootKernelOnly, loadEnvFile, type BootedKernel, type KernelBootOptions } from "./server.js";
import { createPaidMcpServer } from "./transports/mcp.js";
import { SecretRefusal } from "./secrets.js";

export interface McpBootOptions extends KernelBootOptions {
  port: number;
  /** Defaults to the verified runtime policy, so omitting it fails closed. */
  requireTls?: boolean;
  /** Extra Host / Origin values to accept beyond our own loopback address. */
  allowedHosts?: readonly string[];
  allowedOrigins?: readonly string[];
}

export interface BootedMcp extends BootedKernel {
  server: http.Server;
}

/** The kernel plus an MCP listener, constructed but not listening. */
export async function bootMcp(opts: McpBootOptions): Promise<BootedMcp> {
  const core = await bootKernelOnly(opts);
  const server = createPaidMcpServer(core.kernel, {
    // The published tool list, already digest-verified by the boot above.
    tools: core.mcpTools,
    requireTls: opts.requireTls ?? core.policy.paid.requireTls,
    allowedHosts: opts.allowedHosts,
    allowedOrigins: opts.allowedOrigins,
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

// ── CLI boot ─────────────────────────────────────────────────────────────────
if (require.main === module) {
  const here = path.resolve(__dirname, "..");
  const envFile = loadEnvFile(here);
  if (envFile) console.log(`[${new Date().toISOString()}] loaded ${envFile}`);
  // Its own default, clear of both the paid HTTP surface (8787) and the ops
  // port runtime-policy declares (8788).
  const port = Number(process.env.X402_MCP_PORT ?? 8789);
  bootMcp({
    manifestsDir: path.resolve(here, "../manifests"),
    packsDir: path.resolve(here, "packs"),
    ledgerPath: path.resolve(here, "ledger.db"),
    port,
    // Absent env → inherit runtime-policy (true). Only an explicit "0"
    // disables the fail-closed TLS check, so forgetting to set it is safe.
    requireTls: process.env.X402_REQUIRE_TLS !== "0",
    // Local-simulation convenience only, and refused by the SAME guard in
    // `bootKernelOnly` the HTTP surface inherits: a real facilitator paired
    // with this fallback would settle real money to a burn address.
    payToOverride: process.env.X402_PAYTO_ROBLOX_LUAU_PAYTO ? undefined : "0x0000000000000000000000000000000000000dev",
  })
    .then((b) => {
      const bind = process.env.X402_BIND ?? "127.0.0.1";
      b.server.listen(port, bind, () => {
        const facilitatorKind = process.env.X402_FACILITATOR_URL ? "http" : "stub (local simulation)";
        console.log(`[${new Date().toISOString()}] x402 mcp spoke listening on ${bind}:${port}/mcp`);
        if (bind !== "127.0.0.1" && bind !== "localhost") {
          console.warn(
            `[SECURITY] bound to ${bind} — publicly reachable. The default Origin/Host allowlist ` +
              `covers loopback only; declare allowedHosts/allowedOrigins for a fronted deployment.`
          );
        }
        console.log(`  facilitator ${facilitatorKind}`);
        for (const t of b.mcpTools) console.log(`  tool ${t.name}`);
      });

      // Same drain contract as the HTTP surface: close the listener (which
      // closes every live MCP session), let in-flight calls finish, then
      // close the ledger. Exiting dirty leaves a lease held by a boot that
      // is gone, which costs a needless quarantine on the next start.
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
        setTimeout(() => {
          console.error(`[${new Date().toISOString()}] drain timed out — forcing exit`);
          process.exit(0);
        }, 10_000).unref();
      };
      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));
    })
    .catch((e) => {
      const msg = e instanceof SecretRefusal ? e.message : (e as Error).message;
      console.error(`[${new Date().toISOString()}] BOOT REFUSED: ${msg}`);
      process.exit(1);
    });
}
