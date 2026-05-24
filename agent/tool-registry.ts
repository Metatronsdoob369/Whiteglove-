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
import { terrainQueryTool } from "./tools/terrain-query";
import { patternScanTool } from "./tools/pattern-scan";

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

// ─── Legal Retrieve: Direct Pi Qdrant ────────────────────────────────────────
//
// Queries legal-heatmap on Pi Qdrant directly — no external HTTP process needed.
// Embeds via Pi Ollama (nomic-embed-text, 768-D), searches Qdrant, returns
// full statute text from payload. Same silence guarantee as before.
//
// Override via env:
//   QDRANT_PI_URL  (default: http://100.113.215.46:6333)
//   OLLAMA_URL     (default: http://100.113.215.46:11434)
//   LAWLIBRA_URL   (set to use external LawLibra HTTP instead — escape hatch)

const LEGAL_QDRANT_URL   = process.env["QDRANT_PI_URL"]  ?? "http://100.113.215.46:6333";
const LEGAL_OLLAMA_URL   = process.env["OLLAMA_URL"]     ?? "http://100.113.215.46:11434";
const LEGAL_EMBED_MODEL  = "nomic-embed-text";
const LEGAL_COLLECTION   = "legal-heatmap";
const LEGAL_TOP_K        = 5;
const LEGAL_TIMEOUT_MS   = 15_000;

// If LAWLIBRA_URL is set, use external HTTP (escape hatch for external deployments)
const LAWLIBRA_OVERRIDE  = process.env["LAWLIBRA_URL"];

async function embedQuery(query: string): Promise<number[]> {
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), LEGAL_TIMEOUT_MS);
  try {
    const res = await fetch(`${LEGAL_OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: LEGAL_EMBED_MODEL, input: [query] }),
      signal: ac.signal,
    });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`Ollama embed failed: ${res.status}`);
    const body = await res.json() as { embeddings: number[][] };
    const vecs = body.embeddings;
    if (!vecs || vecs.length === 0) throw new Error("Ollama returned no embeddings");
    return vecs[0]!;
  } finally {
    clearTimeout(tid);
  }
}

async function searchLegalHeatmap(vector: number[]): Promise<QdrantHit[]> {
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), LEGAL_TIMEOUT_MS);
  try {
    const res = await fetch(`${LEGAL_QDRANT_URL}/collections/${LEGAL_COLLECTION}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector,
        limit: LEGAL_TOP_K,
        with_payload: true,
        with_vector: false,
      }),
      signal: ac.signal,
    });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`Qdrant search failed: ${res.status}`);
    const body = await res.json() as { result: QdrantHit[] };
    return body.result ?? [];
  } finally {
    clearTimeout(tid);
  }
}

interface QdrantHit {
  id: number | string;
  score: number;
  payload: {
    shard_id?: string;
    title?: string;
    source?: string;
    full_text?: string;
    excerpt?: string;
    data_role?: string;
    penalty_tier?: string;
    spectral_band?: string;
  };
}

function classifyBand(score: number): string {
  if (score >= 0.85) return "settled";
  if (score >= 0.70) return "active";
  if (score >= 0.50) return "contested";
  return "noise";
}

/**
 * legal_retrieve — Faith-Less query against Pi Qdrant legal-heatmap.
 *
 * Embeds via Pi Ollama → searches legal-heatmap → returns full statute text
 * from enriched payload. No external process dependency.
 * Silence if unreachable or no results above threshold.
 */
export const legalRetrieveTool: Tool<{ question: string }, unknown> = {
  name: "legal_retrieve",
  description: "Retrieve verified Alabama statute text via Faith-Less retrieval from Pi Qdrant",
  params: [
    { name: "question", type: "string", description: "The legal query to retrieve against", required: true }
  ],
  execute: async (input, _context) => {
    const t0 = Date.now();

    // Escape hatch: if LAWLIBRA_URL set, fall back to external HTTP
    if (LAWLIBRA_OVERRIDE) {
      try {
        const ac = new AbortController();
        const tid = setTimeout(() => ac.abort(), LEGAL_TIMEOUT_MS);
        const res = await fetch(LAWLIBRA_OVERRIDE, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: input.question, top_k: LEGAL_TOP_K }),
          signal: ac.signal,
        });
        clearTimeout(tid);
        if (!res.ok) return { ok: true, data: { silenced: true, sourceTexts: [], citations: [] } };
        const body = await res.json() as { results?: Array<{ citation: string; source: string; score: number; text: string }> };
        if (!body.results?.length) return { ok: true, data: { silenced: true, sourceTexts: [], citations: [] } };
        return {
          ok: true,
          data: {
            silenced: false,
            formattedResponse: `${body.results[0]!.citation}\n\n${body.results[0]!.text}`,
            sourceTexts: body.results.map(r => ({ shardId: r.citation, source: r.source, fullText: r.text })),
            citations: body.results.map(r => ({ shardId: r.citation, source: r.source, hammingRatio: 1 - r.score, preview: r.text.slice(0, 120) })),
          },
        };
      } catch {
        return { ok: true, data: { silenced: true, sourceTexts: [], citations: [] } };
      }
    }

    // Primary path: direct Pi Qdrant
    try {
      const vector = await embedQuery(input.question);
      const hits   = await searchLegalHeatmap(vector);

      if (!hits.length) {
        return { ok: true, data: { silenced: true, sourceTexts: [], citations: [] } };
      }

      const latencyMs = Date.now() - t0;

      const sourceTexts = hits.map(h => ({
        shardId:  h.payload.shard_id ?? String(h.id),
        source:   h.payload.source   ?? "Alabama Code",
        fullText: h.payload.full_text ?? h.payload.excerpt ?? "",
      }));

      const citations = hits.map(h => ({
        shardId:      h.payload.shard_id ?? String(h.id),
        source:       h.payload.source   ?? "Alabama Code",
        hammingRatio: 1 - h.score,
        preview:      (h.payload.full_text ?? h.payload.excerpt ?? "").slice(0, 120),
        band:         classifyBand(h.score),
        penaltyTier:  h.payload.penalty_tier ?? "",
      }));

      const top = hits[0]!;
      const formatted = `${top.payload.shard_id ?? top.id}\n\n${top.payload.full_text ?? top.payload.excerpt ?? ""}`;

      return {
        ok: true,
        data: {
          silenced: false,
          formattedResponse: formatted,
          sourceTexts,
          citations,
          metrics: { latencyMs },
        },
      };
    } catch {
      // Pi unreachable or embed failed — strict silence, no fallback
      return { ok: true, data: { silenced: true, sourceTexts: [], citations: [] } };
    }
  }
};

/**
 * Build the default registry with all built-in tools registered.
 */
export function buildDefaultRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(vaultRetrieveTool)
    .register(legalRetrieveTool)
    .register(terrainQueryTool)
    .register(patternScanTool)
    .register(memorySetTool)
    .register(memoryGetTool);
}
