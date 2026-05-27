/**
 * terrain-query.ts — Universal TGIL Terrain Query Tool
 *
 * Single tool that replaces per-domain retrieval tools.
 * Calls the router-service to classify the query, then dispatches
 * to the correct backend (LawLibra, vault, or Qdrant directly).
 *
 * Returns a unified shape: { domain, results, silenced, band? }
 *
 * Registered as "terrain_query" in tool-registry.ts.
 */

import type { Tool, ToolResult } from "../types";

const ROUTER_URL = process.env["ROUTER_URL"] ?? "http://localhost:7700";
const QUERY_TIMEOUT_MS = 10_000;

interface RouterResult {
  domain: string;
  confidence: string;
  queryEndpoint: string;
  geometry: string;
  silencePolicy: string;
  thresholds?: Record<string, number>;
}

interface TerrainResult {
  rank: number;
  score: number;
  text: string;
  citation?: string;
  source?: string;
  spectral_band?: string;
  file?: string;
  line_start?: number;
}

interface TerrainQueryOutput {
  domain: string;
  silenced: boolean;
  results: TerrainResult[];
  band?: string;
  confidence?: string;
  latencyMs?: number;
}

async function fetchWithTimeout(url: string, opts: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    return res;
  } finally {
    clearTimeout(tid);
  }
}

async function routeQuery(query: string): Promise<RouterResult | null> {
  try {
    const res = await fetchWithTimeout(
      `${ROUTER_URL}/route?q=${encodeURIComponent(query)}`,
      { method: "GET" },
      3_000
    );
    if (!res.ok) return null;
    return await res.json() as RouterResult;
  } catch {
    return null;
  }
}

// ── Backend dispatchers ───────────────────────────────────────────────────────

async function dispatchLawLibra(query: string, endpoint: string): Promise<TerrainQueryOutput> {
  try {
    const res = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, top_k: 3 }),
    }, QUERY_TIMEOUT_MS);

    if (!res.ok) return { domain: "legal-corpus", silenced: true, results: [] };

    const body = await res.json() as {
      results?: Array<{ rank: number; score: number; text: string; citation: string; source: string; spectral_band: string }>;
      meta?: { latency_ms: number };
    };

    if (!body.results?.length) return { domain: "legal-corpus", silenced: true, results: [] };

    return {
      domain: "legal-corpus",
      silenced: false,
      band: body.results[0].spectral_band,
      latencyMs: body.meta?.latency_ms,
      results: body.results.map(r => ({
        rank: r.rank,
        score: r.score,
        text: r.text,
        citation: r.citation,
        source: r.source,
        spectral_band: r.spectral_band,
      })),
    };
  } catch {
    return { domain: "legal-corpus", silenced: true, results: [] };
  }
}

async function dispatchQdrant(
  query: string,
  domainId: string,
  qdrantUrl: string,
  collection: string
): Promise<TerrainQueryOutput> {
  // Embed via Mac Ollama then search Qdrant directly
  const OLLAMA = process.env["OLLAMA_URL"] ?? "http://localhost:11434";
  try {
    // Get embedding
    const embedRes = await fetchWithTimeout(`${OLLAMA}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text:latest", prompt: query }),
    }, 15_000);

    if (!embedRes.ok) return { domain: domainId, silenced: true, results: [] };
    const embedBody = await embedRes.json() as { embedding: number[] };
    const vector = embedBody.embedding;

    // Search Qdrant
    const searchRes = await fetchWithTimeout(`${qdrantUrl}/collections/${collection}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vector, limit: 5, with_payload: true }),
    }, QUERY_TIMEOUT_MS);

    if (!searchRes.ok) return { domain: domainId, silenced: true, results: [] };
    const searchBody = await searchRes.json() as {
      result?: Array<{ id: number; score: number; payload: Record<string, unknown> }>;
    };

    const hits = searchBody.result ?? [];
    if (!hits.length) return { domain: domainId, silenced: true, results: [] };

    return {
      domain: domainId,
      silenced: false,
      band: hits[0].payload["spectral_band"] as string | undefined,
      results: hits.map((h, i) => ({
        rank: i + 1,
        score: h.score,
        text: (h.payload["excerpt"] as string) ?? "",
        citation: (h.payload["shard_id"] as string) ?? String(h.id),
        source: (h.payload["source"] as string) ?? "",
        spectral_band: (h.payload["spectral_band"] as string) ?? undefined,
      })),
    };
  } catch {
    return { domain: domainId, silenced: true, results: [] };
  }
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const terrainQueryTool: Tool<{ query: string; domain?: string }, TerrainQueryOutput> = {
  name: "terrain_query",
  description: "Query the TGIL terrain — automatically routes to the correct domain (legal, medical, security, etc.) and returns verified results or silence",
  params: [
    { name: "query", type: "string", description: "The question to query against the terrain", required: true },
    { name: "domain", type: "string", description: "Optional: force a specific domain (legal-corpus, medical-corpus, repo-husk). If omitted, router classifies automatically.", required: false },
  ],
  execute: async (input, _context): Promise<ToolResult<TerrainQueryOutput>> => {
    const query = input.query;

    // 1. Route the query (or use forced domain)
    let routing: RouterResult | null = null;
    if (input.domain) {
      // Forced domain — build a minimal routing object
      try {
        const res = await fetchWithTimeout(
          `${ROUTER_URL}/domain/${encodeURIComponent(input.domain)}`,
          { method: "GET" },
          3_000
        );
        if (res.ok) {
          const cfg = await res.json() as { receptacle: { queryEndpoint: string; url?: string }; geometry: string };
          routing = {
            domain: input.domain,
            confidence: "forced",
            queryEndpoint: cfg.receptacle.queryEndpoint,
            geometry: cfg.geometry,
            silencePolicy: "strict",
          };
        }
      } catch { /* fall through to auto-route */ }
    }

    if (!routing) {
      routing = await routeQuery(query);
    }

    if (!routing) {
      // Router unreachable — fail open to legal-corpus directly
      const out = await dispatchLawLibra(query, "http://localhost:4880/legal/query");
      return { ok: true, data: out };
    }

    // 2. Dispatch to correct backend based on domain
    let output: TerrainQueryOutput;

    if (routing.domain === "legal-corpus" || routing.queryEndpoint.includes("4880")) {
      output = await dispatchLawLibra(query, "http://localhost:4880/legal/query");
    } else if (routing.queryEndpoint.includes("6333") || routing.queryEndpoint.includes("6340")) {
      // Direct Qdrant — extract base URL and collection from endpoint
      const qdrantBase = routing.queryEndpoint.includes("6333")
        ? "http://100.113.215.46:6333"
        : "http://127.0.0.1:6340";
      output = await dispatchQdrant(query, routing.domain, qdrantBase, "legal-heatmap");
    } else {
      // Unknown endpoint — silence
      output = { domain: routing.domain, silenced: true, results: [] };
    }

    output.confidence = routing.confidence;
    return { ok: true, data: output };
  },
};
