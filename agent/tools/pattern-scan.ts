/**
 * pattern-scan.ts — Vuln Pattern Scanner over Repo Husks
 *
 * Queries husk-<repo> collections in Pi Qdrant for code semantically
 * similar to known vulnerability patterns. Returns file:line findings
 * ranked by score, or silence if nothing exceeds threshold.
 *
 * Registered as "pattern_scan" in tool-registry.ts.
 */

import type { Tool, ToolResult } from "../types";

const QDRANT_PI = process.env["QDRANT_PI_URL"] ?? "http://100.113.215.46:6333";
const OLLAMA    = process.env["OLLAMA_URL"]     ?? "http://localhost:11434";
const SIMILARITY_THRESHOLD = 0.72;
const QUERY_TIMEOUT_MS = 15_000;

// ── Vuln pattern seed descriptions ───────────────────────────────────────────
// Natural-language descriptions embedded and compared against husk shards.

const VULN_PATTERNS: Record<string, string[]> = {
  "sql-injection": [
    "raw SQL query string concatenation with user input",
    "execute query with unescaped parameter",
    "database query built by joining untrusted user data",
  ],
  "reflected-output": [
    "render user input directly into page output without encoding",
    "write request parameter value into response body unescaped",
    "output user-controlled string directly to template context",
  ],
  "hardcoded-secrets": [
    "API key hardcoded in source code as string literal",
    "password assigned as plain text constant in config",
    "private token embedded directly in repository file",
  ],
  "auth-bypass": [
    "authentication check skipped based on user-controlled header",
    "admin flag bypassed with null or missing user object",
    "JWT verification disabled or commented out",
    "role check absent from protected endpoint handler",
  ],
  "path-traversal": [
    "file read using user-controlled path without sanitization",
    "directory traversal via unsanitized filename parameter",
    "open file with unvalidated path from request",
  ],
  "rce": [
    "execute shell command with user-controlled input",
    "eval with user-provided string",
    "subprocess call with unsanitized argument from request",
  ],
  "insecure-deserialization": [
    "deserialize untrusted data from request body",
    "unsafe deserialization of user-controlled byte stream",
    "load serialized object from network without validation",
  ],
};

interface HuskFinding {
  pattern: string;
  score: number;
  file: string;
  line_start: number;
  line_end?: number;
  excerpt: string;
  collection: string;
}

async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 15_000);
    const res = await fetch(`${OLLAMA}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text:latest", prompt: text.slice(0, 1024) }),
      signal: ac.signal,
    });
    clearTimeout(tid);
    if (!res.ok) return null;
    const body = await res.json() as { embedding: number[] };
    return body.embedding;
  } catch {
    return null;
  }
}

async function listHuskCollections(): Promise<string[]> {
  try {
    const res = await fetch(`${QDRANT_PI}/collections`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return [];
    const body = await res.json() as { result?: { collections?: Array<{ name: string }> } };
    return (body.result?.collections ?? [])
      .map(c => c.name)
      .filter(name => name.startsWith("husk-"));
  } catch {
    return [];
  }
}

async function scanCollection(
  collection: string,
  patternName: string,
  vector: number[]
): Promise<HuskFinding[]> {
  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), QUERY_TIMEOUT_MS);
    const res = await fetch(`${QDRANT_PI}/collections/${collection}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector,
        limit: 5,
        with_payload: true,
        score_threshold: SIMILARITY_THRESHOLD,
      }),
      signal: ac.signal,
    });
    clearTimeout(tid);

    if (!res.ok) return [];
    const body = await res.json() as {
      result?: Array<{
        score: number;
        payload: Record<string, unknown>;
      }>;
    };

    return (body.result ?? []).map(hit => ({
      pattern: patternName,
      score: hit.score,
      file: (hit.payload["file"] as string) ?? "unknown",
      line_start: (hit.payload["line_start"] as number) ?? 0,
      line_end: hit.payload["line_end"] as number | undefined,
      excerpt: ((hit.payload["excerpt"] as string) ?? "").slice(0, 300),
      collection,
    }));
  } catch {
    return [];
  }
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const patternScanTool: Tool<
  { repo?: string; patterns?: string[] },
  { findings: HuskFinding[]; silenced: boolean; collections_scanned: number }
> = {
  name: "pattern_scan",
  description: "Scan repo husk collections in Pi Qdrant for known vulnerability patterns. Returns file:line findings or silence.",
  params: [
    {
      name: "repo",
      type: "string",
      description: "Optional: repo name (e.g. 'my-app'). If omitted, scans all husk-* collections.",
      required: false,
    },
    {
      name: "patterns",
      type: "object",
      description: "Optional: pattern names to check. Choices: sql-injection, reflected-output, hardcoded-secrets, auth-bypass, path-traversal, rce, insecure-deserialization. If omitted, runs all.",
      required: false,
    },
  ],
  execute: async (input, _context): Promise<ToolResult<{ findings: HuskFinding[]; silenced: boolean; collections_scanned: number }>> => {
    const allCollections = await listHuskCollections();
    const collections = input.repo
      ? allCollections.filter(c => c === `husk-${input.repo}` || c.includes(input.repo ?? ""))
      : allCollections;

    if (!collections.length) {
      return { ok: true, data: { findings: [], silenced: true, collections_scanned: 0 } };
    }

    const patternNames = (input.patterns as string[] | undefined)?.length
      ? (input.patterns as string[]).filter(p => p in VULN_PATTERNS)
      : Object.keys(VULN_PATTERNS);

    const allFindings: HuskFinding[] = [];

    for (const patternName of patternNames) {
      const seeds = VULN_PATTERNS[patternName];
      for (const seed of seeds) {
        const vector = await getEmbedding(seed);
        if (!vector) continue;
        for (const collection of collections) {
          const hits = await scanCollection(collection, patternName, vector);
          allFindings.push(...hits);
        }
      }
    }

    // Deduplicate by file+line+pattern, keep highest score
    const seen = new Map<string, HuskFinding>();
    for (const f of allFindings) {
      const key = `${f.collection}:${f.file}:${f.line_start}:${f.pattern}`;
      const existing = seen.get(key);
      if (!existing || f.score > existing.score) seen.set(key, f);
    }

    const findings = Array.from(seen.values()).sort((a, b) => b.score - a.score);

    return {
      ok: true,
      data: { findings, silenced: findings.length === 0, collections_scanned: collections.length },
    };
  },
};
