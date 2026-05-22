/**
 * TOOL REGISTRY
 *
 * All tools the agent can invoke. Registration is explicit — nothing
 * runs unless it's registered here and allowed by the active role contract.
 *
 * Channel B (Spectral Terrain Watchdog):
 *   When WATCHDOG_URL is set (default: http://127.0.0.1:7340/intercept),
 *   every tool invocation POSTs an intent payload before execution.
 *   Response { action: "hold" } blocks the call and returns a held error.
 *   Response { action: "proceed" } or any network failure → proceed (fail-open).
 *   Set WATCHDOG_ENFORCE=1 to convert holds into hard blocks.
 */

import type { Tool, AgentContext, ToolResult } from "./types";

const WATCHDOG_URL  = process.env["WATCHDOG_URL"]  ?? "http://127.0.0.1:7340/intercept";
const WATCHDOG_ENFORCE = process.env["WATCHDOG_ENFORCE"] === "1";
const WATCHDOG_TIMEOUT_MS = 3_000;

async function channelBCheck(
  toolName: string,
  input: Record<string, unknown>,
  context: AgentContext
): Promise<"proceed" | "hold"> {
  const payload = {
    tool:          toolName,
    args:          input,
    code_to_write: typeof input["code"] === "string" ? input["code"] : undefined,
    domain:        context.role.sector,
  };
  try {
    const ac  = new AbortController();
    const tid = setTimeout(() => ac.abort(), WATCHDOG_TIMEOUT_MS);
    const res = await fetch(WATCHDOG_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
      signal:  ac.signal,
    });
    clearTimeout(tid);
    if (!res.ok) return "proceed";
    const body = await res.json() as { action?: string };
    return body.action === "hold" ? "hold" : "proceed";
  } catch {
    // Watchdog not running or timed out — fail open
    return "proceed";
  }
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register<TInput, TOutput>(tool: Tool<TInput, TOutput>): this {
    this.tools.set(tool.name, tool as unknown as Tool);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }

  async invoke(
    name: string,
    input: Record<string, unknown>,
    context: AgentContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      return { ok: false, error: `Tool "${name}" not registered` };
    }

    if (!context.role.allowedTools.includes(name)) {
      return { ok: false, error: `Tool "${name}" not permitted by role "${context.role.id}"` };
    }

    // ── Channel B: Spectral Terrain pre-tool-call geometry check ─────────────
    const watchdogAction = await channelBCheck(name, input, context);
    if (watchdogAction === "hold") {
      const detail = WATCHDOG_ENFORCE
        ? `Tool "${name}" blocked by watchdog (enforce mode)`
        : `Tool "${name}" flagged by watchdog (observe mode — proceeding)`;
      if (WATCHDOG_ENFORCE) {
        return { ok: false, error: detail };
      }
      // Observe mode: log and continue
      console.warn(`[watchdog] ${detail}`);
    }

    try {
      return await tool.execute(input, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Tool "${name}" threw: ${message}` };
    }
  }
}

// ─── Built-in Tools ───────────────────────────────────────────────────────────

/**
 * vault_retrieve — query the Faith-Less shard vault
 * Available to all roles by default.
 */
export const vaultRetrieveTool: Tool<{ question: string }, unknown> = {
  name: "vault_retrieve",
  description: "Retrieve verified source text from the knowledge vault using SimHash-128 ranking",
  params: [
    { name: "question", type: "string", description: "The query to retrieve against", required: true }
  ],
  execute: async (input, _context) => {
    // Dynamically import to avoid circular dependency
    const { LandmarkOrchestrator } = await import("../brain/landmark-orchestrator");
    const orchestrator = new LandmarkOrchestrator();
    await orchestrator.buildIndex();
    const result = await orchestrator.retrieve(input.question);

    if (result.silenced) {
      return { ok: true, data: { silenced: true, sourceTexts: [], citations: [] } };
    }

    return {
      ok: true,
      data: {
        silenced: false,
        sourceTexts: result.sourceTexts,
        citations: result.citations,
        metrics: result.metrics
      }
    };
  }
};

/**
 * memory_set — store a key/value in ephemeral session memory
 */
export const memorySetTool: Tool<{ key: string; value: unknown }, void> = {
  name: "memory_set",
  description: "Store a value in the agent's ephemeral session memory",
  params: [
    { name: "key", type: "string", description: "Memory key", required: true },
    { name: "value", type: "object", description: "Value to store", required: true }
  ],
  execute: async (input, context) => {
    context.memory[input.key] = input.value;
    return { ok: true };
  }
};

/**
 * memory_get — read from ephemeral session memory
 */
export const memoryGetTool: Tool<{ key: string }, unknown> = {
  name: "memory_get",
  description: "Read a value from the agent's ephemeral session memory",
  params: [
    { name: "key", type: "string", description: "Memory key", required: true }
  ],
  execute: async (input, context) => {
    return { ok: true, data: context.memory[input.key] ?? null };
  }
};

/**
 * Build the default registry with all built-in tools registered.
 */
export function buildDefaultRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(vaultRetrieveTool)
    .register(memorySetTool)
    .register(memoryGetTool);
}
