/**
 * WHITEGLOVE API SERVER
 *
 * Wraps the AgentLoop in an HTTP interface.
 * Sector-agnostic: the caller defines the role via request body.
 * Ships as a standalone local server or behind any reverse proxy.
 *
 * Routes:
 *   POST /query          — run a query against a shard vault
 *   GET  /health         — liveness check
 *   GET  /payload/:role  — return the SYSTEM_DIRECTIVE prompt payload for a sector
 */

import http from "http";
import path from "path";
import fs from "fs";
import { AgentLoop } from "../agent/loop/agent-loop";
import { buildDefaultRegistry } from "../agent/tool-registry";
import type { RoleContract } from "../agent/types";
import { routeLegal } from "./legal";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 4880;
const DEFAULT_VAULT_INDEX = process.env.WG_VAULT_INDEX
  ?? path.resolve(__dirname, "../brain/shards/vault/index.json");
const DEFAULT_SHARD_DIR   = path.resolve(__dirname, "../brain/shards/shattered");

// ─── Role Factory ─────────────────────────────────────────────────────────────
// Build a role contract from a request. Callers bring their own sector/shardDir.
// If they don't, we fall back to the built-in medical role.

function buildRole(params: {
  sector?: string;
  silencePolicy?: "strict" | "permissive";
  systemPrompt?: string;
  maxResponseTokens?: number;
}): RoleContract {
  const sector = params.sector ?? "general";
  return {
    id: `${sector}-whiteglove-v1`,
    name: `WhiteGlove ${sector.charAt(0).toUpperCase() + sector.slice(1)} Agent`,
    sector,
    systemPrompt: params.systemPrompt ?? `You are a sovereign retrieval agent for the ${sector} domain.
You answer ONLY from verified source material retrieved from the knowledge vault.
You never speculate or fabricate. If the vault has nothing relevant, you stay silent.
Always cite your source shards.`,
    allowedTools: ["vault_retrieve", "memory_set", "memory_get"],
    silencePolicy: params.silencePolicy ?? "strict",
    maxResponseTokens: params.maxResponseTokens ?? 300,
  };
}

// ─── Request Body ─────────────────────────────────────────────────────────────

interface QueryRequest {
  query: string;
  shardDir?: string;       // Absolute path to caller's shard directory
  sector?: string;
  silencePolicy?: "strict" | "permissive";
  systemPrompt?: string;
  maxResponseTokens?: number;
}

// ─── SYSTEM_DIRECTIVE Payload Generator ───────────────────────────────────────

function buildSystemDirective(sector: string, shardDir: string): object {
  return {
    SYSTEM_DIRECTIVE: `You are a WhiteGlove Sovereign Retrieval Agent for the ${sector} domain.
Ingest the A-MEM architectural state below. Your sole directive is Faith-Less retrieval:
return only verified source text from the vault. If distance > 0.45 threshold, return silence.
Never fabricate. Never hallucinate. Cite every shard.`,
    AGENTIC_MEMORY_PAYLOAD: {
      metadata: {
        origin: "WhiteGlove_Sovereign_Pipeline",
        security_posture: "Faith-Less / Silence-Gated",
        sector,
        shardDir,
      },
      architectural_state: {
        vectorization: "SimHash-128 Hamming Space. Strict threshold enforcement.",
        ingestion_engine: "Shard-based. O(k) lookup via pre-built landmark index.",
        cache_routing: "LFU cache with LRU tie-break. Keys salted BLAKE3. Drift guarded at Hamming ratio <= 0.45.",
      },
      execution_gating: {
        silence_policy: "strict",
        threshold: 0.45,
        rule: "If nearest shard Hamming ratio > 0.45 -> SILENCE. No LLM fallback.",
      },
    },
    EXECUTION_COMMAND: `Acknowledge ingestion. You are now operating as a WhiteGlove ${sector} agent.
Respond only with verified shard content. Begin.`,
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function router(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const method = req.method ?? "GET";

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // /legal/* — Qdrant-backed legal retrieval
  const handled = await routeLegal(req, res, url.pathname, method);
  if (handled) return;

  // GET /health
  if (method === "GET" && url.pathname === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok", version: "1.0.0-mvp", ts: new Date().toISOString() }));
    return;
  }

  // GET /retrieve — Faith-Less retrieve only, no LLM inference
  if (method === "GET" && url.pathname === "/retrieve") {
    const query = url.searchParams.get("q");
    const shardDirParam = url.searchParams.get("shardDir");
    if (!query) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Missing query param: q" }));
      return;
    }
    const shardDir = shardDirParam
      ? path.resolve(shardDirParam)
      : path.resolve(__dirname, "../brain/shards/shattered");

    const { LandmarkOrchestrator } = await import("../brain/landmark-orchestrator");
    const orchestrator = new LandmarkOrchestrator({ shardDir });

    // Load persisted index if available, otherwise build
    const indexPath = fs.existsSync(DEFAULT_VAULT_INDEX)
      ? DEFAULT_VAULT_INDEX
      : path.join(shardDir, "..", "vault", "index.json");
    const loaded = await orchestrator.loadIndex(indexPath);
    if (!loaded) await orchestrator.buildIndex();

    const result = await orchestrator.retrieve(query);
    res.writeHead(200);
    res.end(JSON.stringify(result));
    return;
  }

  // GET /payload/:role
  if (method === "GET" && url.pathname.startsWith("/payload/")) {
    const sector = url.pathname.replace("/payload/", "").trim() || "general";
    const shardDir = url.searchParams.get("shardDir") ?? "./brain/shards/shattered";
    res.writeHead(200);
    res.end(JSON.stringify(buildSystemDirective(sector, shardDir), null, 2));
    return;
  }

  // POST /query
  if (method === "POST" && url.pathname === "/query") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    let parsed: QueryRequest;
    try {
      parsed = JSON.parse(body) as QueryRequest;
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    if (!parsed.query) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Missing required field: query" }));
      return;
    }

    const shardDir = parsed.shardDir
      ? path.resolve(parsed.shardDir)
      : path.resolve(__dirname, "../brain/shards/shattered");

    if (!fs.existsSync(shardDir)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: `Shard directory not found: ${shardDir}` }));
      return;
    }

    const role = buildRole({
      sector: parsed.sector,
      silencePolicy: parsed.silencePolicy,
      systemPrompt: parsed.systemPrompt,
      maxResponseTokens: parsed.maxResponseTokens,
    });

    const registry = buildDefaultRegistry();
    const loop = new AgentLoop(registry, { shardDir });

    const start = Date.now();
    try {
      await loop.init();
      const result = await loop.run(parsed.query, role);
      res.writeHead(200);
      res.end(JSON.stringify({ ...result, serverMs: Date.now() - start }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  router(req, res).catch((err) => {
    res.writeHead(500);
    res.end(JSON.stringify({ error: String(err) }));
  });
});

server.listen(PORT, () => {
  console.log(`\nWhiteGlove API — port ${PORT}`);
  console.log(`  POST /query          — sovereign retrieval (SimHash/file shards)`);
  console.log(`  GET  /health         — liveness check`);
  console.log(`  GET  /payload/:role  — SYSTEM_DIRECTIVE for a sector`);
  console.log(`  GET  /legal/health   — Pi Qdrant + Ollama connectivity check`);
  console.log(`  POST /legal/query    — legal corpus search (Qdrant 3072-D)\n`);
});
