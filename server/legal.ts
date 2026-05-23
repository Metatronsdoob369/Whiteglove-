/**
 * legal.ts — WhiteGlove Legal Query Endpoint
 *
 * GET  /legal/health       — check all Qdrant instances + Ollama connectivity
 * POST /legal/query        — embed query, fan out to all Qdrant nodes, merge + re-rank
 *
 * Embedding: mxbai-embed-large via Ollama (Pi preferred, localhost fallback)
 * Vector stores (all queried in parallel):
 *   - Pi Qdrant   (100.113.215.46:6340) legal-heatmap — 52K Alabama Code
 *   - Local Qdrant (localhost:6340)     legal-heatmap — 11K Law StackExchange Q&A
 * Dims: 3072 (T‖T-1‖T-start concatenation)
 *
 * Returns top-k results merged and re-ranked by score, enriched with:
 *   - spectral_band: settled / active / contested / noise
 *   - corpus_heat: graph Laplacian diffusion score
 *   - drift: T-1 axis delta (confidence indicator)
 *   - citation: human-readable "Ala. Code §X-X-X" or Q&A title
 */

import http from "http";
import fs from "fs";
import path from "path";

// Primary embedding host — Pi preferred, localhost fallback
const OLLAMA_URL  = process.env.WG_OLLAMA_URL   ?? "http://100.113.215.46:11434";
const EMBED_MODEL = process.env.WG_EMBED_MODEL  ?? "mxbai-embed-large";
const COLLECTION  = process.env.WG_COLLECTION   ?? "legal-heatmap";
const TOP_K       = 8;

// All Qdrant nodes to fan out to
const QDRANT_NODES: string[] = (
  process.env.WG_QDRANT_NODES
    ? process.env.WG_QDRANT_NODES.split(",")
    : ["http://100.113.215.46:6340", "http://localhost:6340"]
);

// Legacy single-node var still respected if set (overrides node list)
const QDRANT_URL  = process.env.WG_QDRANT_URL ?? QDRANT_NODES[0];

// Directories to search for shard JSON files (ordered by priority)
const SHARD_DIRS = [
  path.resolve(__dirname, "../brain/shards/alabama_full"),
  path.resolve(__dirname, "../brain/shards/alabama"),
  path.resolve(__dirname, "../brain/shards/legal"),
  path.resolve(__dirname, "../brain/shards/legal_qa_chunked"),
  path.resolve(__dirname, "../brain/shards/gutenberg_law_chunked"),
];

// ─── Embedding ────────────────────────────────────────────────────────────────

async function embed(text: string): Promise<number[]> {
  // mxbai-embed-large produces 1024-D vectors
  // We store 3072-D (T‖T-1‖T-start). For query we embed once and tile:
  // query_vec = [embed, embed, embed] — neutral drift, anchored to itself
  const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!resp.ok) {
    throw new Error(`Ollama embed failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json() as { embedding: number[] };
  const v = data.embedding; // 1024-D
  // Tile to 3072-D: [T=v, T-1=v, T-start=v]
  return [...v, ...v, ...v];
}

// ─── Qdrant Search ────────────────────────────────────────────────────────────

interface QdrantHit {
  id: string | number;
  score: number;
  payload: Record<string, unknown>;
}

async function qdrantSearchOne(nodeUrl: string, vector: number[], limit: number): Promise<QdrantHit[]> {
  try {
    const resp = await fetch(`${nodeUrl}/collections/${COLLECTION}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vector, limit, with_payload: true, with_vector: false }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];
    const data = await resp.json() as { result: QdrantHit[] };
    return data.result ?? [];
  } catch {
    return [];
  }
}

async function qdrantSearch(vector: number[], limit: number): Promise<QdrantHit[]> {
  // Fan out to all nodes in parallel, merge by score, deduplicate by shard_id
  const perNode = limit + 4; // fetch a few extra per node before trimming
  const results = await Promise.all(QDRANT_NODES.map(n => qdrantSearchOne(n, vector, perNode)));
  const all = results.flat();

  // Deduplicate by shard_id payload, keep highest score
  const seen = new Map<string, QdrantHit>();
  for (const hit of all) {
    const key = String(hit.payload?.shard_id ?? hit.id);
    const existing = seen.get(key);
    if (!existing || hit.score > existing.score) seen.set(key, hit);
  }

  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// ─── Result Formatter ─────────────────────────────────────────────────────────

interface LegalResult {
  rank: number;
  score: number;
  citation: string;
  title: string;
  source: string;
  path: string;
  spectral_band: string;
  corpus_heat: number;
  drift: number;
  shard_id: string;
  confidence: "high" | "medium" | "low";
}

function formatResult(hit: QdrantHit, rank: number): LegalResult {
  const p = hit.payload;
  const band   = String(p.spectral_band ?? "unknown");
  const heat   = Number(p.corpus_heat   ?? p.manhattan_heat ?? 0.003);
  const drift  = Number(p.drift         ?? 0);

  // Confidence: settled=high, active=medium, contested/noise=low
  const confidence: "high" | "medium" | "low" =
    band === "settled" ? "high" :
    band === "active"  ? "medium" : "low";

  return {
    rank,
    score:        Math.round(hit.score * 10000) / 10000,
    citation:     String(p.title    ?? p.shard_id ?? hit.id),
    title:        String(p.title    ?? ""),
    source:       String(p.source   ?? ""),
    path:         String(p.path     ?? ""),
    spectral_band: band,
    corpus_heat:  Math.round(heat  * 100000) / 100000,
    drift:        Math.round(drift * 100000) / 100000,
    shard_id:     String(p.shard_id ?? hit.id),
    confidence,
  };
}

// ─── Shard Text Resolver ──────────────────────────────────────────────────────

interface ShardContent {
  id: string;
  content: string;
  title: string;
  source: string;
  path: string;
}

function resolveShardText(shardId: string): ShardContent | null {
  for (const dir of SHARD_DIRS) {
    const filePath = path.join(dir, `${shardId}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        return {
          id: shardId,
          content: raw.content ?? raw.text ?? raw.chunk ?? "",
          title: raw.title ?? shardId,
          source: raw.source ?? "",
          path: raw.path ?? "",
        };
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export async function handleLegalHealth(): Promise<object> {
  const checks: Record<string, string> = {};

  // Qdrant — check all nodes
  await Promise.all(QDRANT_NODES.map(async (node) => {
    const label = `qdrant:${node.replace("http://", "")}`;
    try {
      const r = await fetch(`${node}/collections/${COLLECTION}`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const d = await r.json() as { result?: { points_count?: number } };
        checks[label] = `ok — ${d.result?.points_count ?? "?"} points`;
      } else {
        checks[label] = `error ${r.status}`;
      }
    } catch (e) {
      checks[label] = `unreachable: ${e}`;
    }
  }));

  // Ollama
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    if (r.ok) {
      const d = await r.json() as { models?: Array<{ name: string }> };
      const names = (d.models ?? []).map(m => m.name).join(", ");
      checks.ollama = `ok — models: ${names || "none loaded"}`;
    } else {
      checks.ollama = `error ${r.status}`;
    }
  } catch (e) {
    checks.ollama = `unreachable: ${e}`;
  }

  const ok = !Object.values(checks).some(v => v.startsWith("error") || v.startsWith("unreachable"));
  return { status: ok ? "ok" : "degraded", checks };
}

export async function handleLegalQuery(body: string): Promise<object> {
  let parsed: { query?: string; top_k?: number; filter_band?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON body");
  }

  const query = (parsed.query ?? "").trim();
  if (!query) throw new Error("Missing required field: query");

  const limit      = Math.min(parsed.top_k ?? TOP_K, 20);
  const filterBand = parsed.filter_band; // optional: "settled" | "active" | "contested"

  const start = Date.now();

  // Embed
  let vector: number[];
  try {
    vector = await embed(query);
  } catch (e) {
    throw new Error(`Embedding failed — is Ollama running on Pi? (${e})`);
  }

  // Search
  const hits = await qdrantSearch(vector, filterBand ? limit * 2 : limit);

  // Format + optional band filter
  let results = hits.map((h, i) => formatResult(h, i + 1));
  if (filterBand) {
    results = results.filter(r => r.spectral_band === filterBand).slice(0, limit);
    results.forEach((r, i) => { r.rank = i + 1; });
  }

  // Enrich results with shard text content
  const enriched = results.map(r => {
    const shard = resolveShardText(r.shard_id);
    return {
      ...r,
      text: shard?.content ?? null,
    };
  });

  return {
    query,
    results: enriched,
    meta: {
      total_returned: enriched.length,
      collection: COLLECTION,
      embed_model: EMBED_MODEL,
      vector_dims: vector.length,
      latency_ms: Date.now() - start,
    },
  };
}

// ─── Route Registration ───────────────────────────────────────────────────────

export async function routeLegal(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string
): Promise<boolean> {
  if (!pathname.startsWith("/legal")) return false;

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  // GET /legal/health
  if (method === "GET" && pathname === "/legal/health") {
    try {
      const result = await handleLegalHealth();
      res.writeHead(200);
      res.end(JSON.stringify(result, null, 2));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(e) }));
    }
    return true;
  }

  // GET /legal/shard/:id — fetch raw shard text by shard_id
  if (method === "GET" && pathname.startsWith("/legal/shard/")) {
    const shardId = pathname.replace("/legal/shard/", "").trim();
    if (!shardId) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Missing shard ID" }));
      return true;
    }
    const shard = resolveShardText(shardId);
    if (!shard) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: `Shard not found: ${shardId}` }));
      return true;
    }
    res.writeHead(200);
    res.end(JSON.stringify(shard));
    return true;
  }

  // POST /legal/query
  if (method === "POST" && pathname === "/legal/query") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const result = await handleLegalQuery(body);
      res.writeHead(200);
      res.end(JSON.stringify(result, null, 2));
    } catch (e) {
      const msg = String(e);
      const status = msg.includes("Invalid JSON") || msg.includes("Missing") ? 400 : 500;
      res.writeHead(status);
      res.end(JSON.stringify({ error: msg }));
    }
    return true;
  }

  return false;
}
