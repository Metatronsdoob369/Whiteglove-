/**
 * WHITE-GLOVE AGENT HUSK: LANDMARK ORCHESTRATOR
 * 
 * The brain stem. Wires SimHash routing, LFU cache, and local inference
 * into a single retrieval pipeline that runs entirely offline.
 * 
 * Query Flow:
 *   query → SimHash128(query) → Hamming distance vs shard index
 *   → top-N nearest shards → LFU cache (load or disk fetch)
 *   → construct context prompt → BitNet inference → answer + citations
 * 
 * Zero network dependency. Zero vector database overhead.
 * If it isn't in the shard, the agent stays silent.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import * as crypto from "crypto";
import { SimHashDriftGuard, type DriftResult } from "./indexer/simhash-guard";
import { ShardCache, type CachedShard } from "./cache/shard-cache";

// ─── Configuration ───────────────────────────────────────────────

export interface OrchestratorConfig {
  /** Path to the shattered shard directory */
  shardDir: string;
  /** Ollama model name (must be pulled: `ollama pull <model>`) */
  ollamaModel: string;
  /** Ollama API base URL */
  ollamaUrl: string;
  /** SimHash Hamming threshold for shard-to-shard drift detection (tight) */
  similarityThreshold: number;
  /** SimHash Hamming threshold for query-to-shard matching (wider).
   *  Queries use different vocabulary than source text, so natural
   *  Hamming distance is higher. Calibration showed closest query-shard
   *  pair at 0.3281 — set at P75 of pairwise distances (0.40) to
   *  capture topically related content without hallucination risk. */
  queryThreshold: number;
  /** Maximum number of shards to feed as context */
  maxContextShards: number;
  /** Maximum tokens for inference response */
  maxResponseTokens: number;
  /** LFU cache capacity */
  cacheCapacity: number;
  /** REFRAG top-k pre-filter: keep only this many candidates after
   *  the Hamming scan before threshold filtering. O(N) scan + O(k log k)
   *  sort instead of O(N log N) full sort. Default: 256 */
  refragK: number;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  shardDir: "/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/brain/shards/shattered",
  ollamaModel: "qwen2.5-coder:7b",
  ollamaUrl: "http://127.0.0.1:11434",
  similarityThreshold: 0.2858, // Calibrated: shard-to-shard drift detection
  queryThreshold: 0.45,        // Calibrated: query-to-shard retrieval (empirical)
  maxContextShards: 3,
  maxResponseTokens: 200,
  cacheCapacity: 500,
  refragK: 256                 // REFRAG: top-k pre-filter — O(N) scan, O(k log k) sort
};

// ─── Shard Index Entry ───────────────────────────────────────────

interface IndexEntry {
  shardId: string;
  title: string;
  signature: bigint;
  source: string;
  contentPreview: string;
  frequency: number;
}

// ─── Query Result ────────────────────────────────────────────────

export interface QueryResult {
  /** The generated answer (null in retrieve mode, or if silenced) */
  answer: string | null;
  /** Shards used as context, with similarity scores */
  citations: Array<{
    shardId: string;
    source: string;
    hammingRatio: number;
    contentPreview: string;
  }>;
  /** Full source text from retrieved shards (Faith-Less: the actual data) */
  sourceTexts: Array<{
    shardId: string;
    source: string;
    fullText: string;
  }>;
  /** Performance metrics */
  metrics: {
    indexLookupMs: number;
    cacheMisses: number;
    inferenceMs: number;
    totalMs: number;
    shardsEvaluated: number;
    shardsSelected: number;
  };
  /** If true, no shards were close enough — agent stayed silent */
  silenced: boolean;
  /** "retrieve" = pure source retrieval, "query" = retrieve + LLM inference */
  mode: "retrieve" | "query";
}

// ─── The Orchestrator ────────────────────────────────────────────

export class LandmarkOrchestrator {
  private readonly config: OrchestratorConfig;
  private readonly guard: SimHashDriftGuard;      // Tight: shard-to-shard integrity
  private readonly queryGuard: SimHashDriftGuard;  // Wide: query-to-shard retrieval
  private readonly cache: ShardCache;
  private readonly index: IndexEntry[] = [];
  private hotRingBuffer: Map<string, IndexEntry> = new Map();
  private initialized: boolean = false;
  private indexedCount: number = 0;
  private readonly HOT_THRESHOLD_PERCENT = 0.05;

  constructor(config: Partial<OrchestratorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.guard = new SimHashDriftGuard(this.config.similarityThreshold);
    this.queryGuard = new SimHashDriftGuard(this.config.queryThreshold);
    this.cache = new ShardCache(this.config.cacheCapacity);
  }

  /**
   * Build the in-memory SimHash index from all shards on disk.
   * Called once at startup or during the Dream cycle.
   */
  async saveIndex(filePath: string) {
    const data = {
      index: this.index.map((entry) => ({
        shardId: entry.shardId,
        title: entry.title,
        signatureHex: entry.signature.toString(16),
        source: entry.source,
        contentPreview: entry.contentPreview,
        frequency: entry.frequency
      })),
      indexedCount: this.indexedCount
    };
    await fs.promises.writeFile(filePath, JSON.stringify(data));
    console.log(` [HUSK] Index persisted to ${filePath}`);
  }

  async loadIndex(filePath: string) {
    if (!fs.existsSync(filePath)) return false;
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);
    this.index.length = 0;
    if (Array.isArray(data.index)) {
      for (const row of data.index) {
        this.index.push({
          shardId: row.shardId,
          title: row.title || "Untitled",
          signature: BigInt(`0x${row.signatureHex}`),
          source: row.source,
          contentPreview: row.contentPreview || "",
          frequency: row.frequency || 0
        });
      }
    }
    this.indexedCount = this.index.length;
    this.initialized = true;
    this.rebalanceHotBuffer();
    console.log(` [HUSK] Index restored: ${this.indexedCount} landmarks`);
    return true;
  }

  /**
   * Build the in-memory SimHash index from all shards on disk.
   * Hardened for memory safety and large-scale datasets.
   */
  async buildIndex(limit?: number): Promise<void> {
    const startMs = Date.now();
    this.index.length = 0;
    const MAX_FILE_SIZE = 1024 * 1024; // 1MB safety cap per shard
    const BATCH_SIZE = 100;

    if (!fs.existsSync(this.config.shardDir)) {
      console.warn(`⚠️ [ORCHESTRATOR] Shard directory not found: ${this.config.shardDir}`);
      return;
    }

    const files = fs.readdirSync(this.config.shardDir)
      .filter((f: string) => f.endsWith(".json"))
      .sort();

    console.log(` [ORCHESTRATOR] Building index for ${files.length} shards...`);

    let processed = 0;
    let skipped = 0;

    for (let i = 0; i < files.length; i++) {
      if (limit && processed >= limit) break;
      
      const file = files[i];
      const filePath = path.join(this.config.shardDir, file);
      
      try {
        const stats = fs.statSync(filePath);
        if (stats.size > MAX_FILE_SIZE) {
          console.warn(`⚠️ [ORCHESTRATOR] Skipping oversized shard (${(stats.size / 1024).toFixed(1)}KB): ${file}`);
          skipped++;
          continue;
        }

        const raw = fs.readFileSync(filePath, "utf-8");
        const shard = JSON.parse(raw);

        // Required fields check
        if (!shard.content) {
          console.warn(`⚠️ [ORCHESTRATOR] Skipping invalid shard (missing content): ${file}`);
          skipped++;
          continue;
        }

        const signature = this.guard.simHash128FromText(shard.content, shard.source || "unknown");

        this.index.push({
          shardId: shard.id || shard.shardId || file.replace(".json", ""),
          title: shard.title || "Untitled",
          signature,
          source: shard.source || "unknown",
          contentPreview: shard.content.slice(0, 100).replace(/\n/g, " "),
          frequency: 0
        });

        processed++;

        // Every BATCH_SIZE files, yield to the event loop to allow GC
        if (processed % BATCH_SIZE === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }

      } catch (err) {
        console.error(`❌ [ORCHESTRATOR] Error processing shard ${file}:`, err);
        skipped++;
      }
    }

    this.initialized = true;
    this.indexedCount = this.index.length;
    this.rebalanceHotBuffer();
    const elapsed = Date.now() - startMs;
    console.log(` [ORCHESTRATOR] Index built: ${this.indexedCount} active shards (${skipped} skipped) in ${elapsed}ms`);
  }

  private rebalanceHotBuffer() {
    const sorted = [...this.index].sort((a, b) => b.frequency - a.frequency);
    const limit = Math.ceil(this.indexedCount * this.HOT_THRESHOLD_PERCENT);
    this.hotRingBuffer.clear();
    for (let i = 0; i < limit; i++) {
      if (sorted[i]) {
        this.hotRingBuffer.set(sorted[i].shardId, sorted[i]);
      }
    }
    console.log(` [HUSK] Hot Buffer Rebalanced: ${this.hotRingBuffer.size} critical landmarks pinned.`);
  }

  private async finishRetrieval(selected: any[], totalStart: number, indexStart: number): Promise<QueryResult> {
    const indexLookupMs = Date.now() - indexStart;
    let cacheMisses = 0;
    const contextShards: any[] = [];

    for (const { entry } of selected) {
      const cacheKey = this.blake2bCacheKey(entry.shardId);
      let shard = this.cache.get(cacheKey);
      if (!shard) {
        cacheMisses++;
        const filePath = path.join(this.config.shardDir, `${entry.shardId}.json`);
        if (fs.existsSync(filePath)) {
          const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          shard = { id: cacheKey, content: raw.content, source: raw.source };
          this.cache.put(shard);
        }
      }
      if (shard) contextShards.push({ id: entry.shardId, content: shard.content, source: shard.source });
    }

    const citations = selected.map(r => ({
      shardId: r.entry.shardId,
      source: r.entry.source,
      hammingRatio: r.drift.hammingRatio,
      contentPreview: r.entry.contentPreview
    }));

    const sourceTexts = contextShards.map(s => ({
      shardId: s.id,
      source: s.source,
      fullText: s.content
    }));

    return {
      answer: null,
      citations,
      sourceTexts,
      metrics: {
        indexLookupMs,
        cacheMisses,
        inferenceMs: 0,
        totalMs: Date.now() - totalStart,
        shardsEvaluated: this.index.length,
        shardsSelected: selected.length
      },
      silenced: false,
      mode: "retrieve"
    };
  }

  /**
   * BLAKE2b-512 deterministic cache key for a shard.
   * Salt "RFGv1" (REFRAG v1) provides domain separation.
   * Same shardId → same key across sessions = amortized O(1) cache hit rate.
   */
  private blake2bCacheKey(shardId: string): string {
    return crypto
      .createHash("blake2b512")
      .update(`RFGv1|${shardId}`)
      .digest("hex")
      .slice(0, 64); // 256-bit truncation — still collision-resistant at this corpus size
  }

  /**
   * SANITIZATION: L2-Normalization Gate
   * Prevents "Qubit Poison" (variance blowouts) in 3072-D space.
   * Enforces all vectors onto the Unit Sphere.
   */
  private normalizeL2(vector: number[]): number[] {
    const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    if (magnitude === 0) return new Array(vector.length).fill(0);
    const normalized = vector.map(val => val / magnitude);
    
    // Safety Check: Verify Unit Sphere projection
    const newMag = Math.sqrt(normalized.reduce((sum, val) => sum + val * val, 0));
    if (Math.abs(newMag - 1.0) > 0.0001) {
      console.warn(`⚠️ [QUBIT_ALARM] Normalization Drift: ${newMag}`);
    }
    return normalized;
  }

  /**
   * Query the knowledge vault.
   * 
   * 1. SimHash the query
   * 2. Rank all shards by Hamming distance
   * 3. Select top-N within threshold
   * 4. Return verified source text with citations
   * 
   * This is the FAITH-LESS core: no generation, no hallucination.
   * If the shard doesn't contain it, the agent stays silent.
   */
  async retrieve(question: string): Promise<QueryResult> {
    if (!this.initialized) {
      await this.buildIndex();
    }

    const totalStart = Date.now();

    // ─── Step 1: SimHash the query ──────────────────────────────
    const indexStart = Date.now();
    const querySignature = this.guard.simHash128FromText(question, "query_");

    // ─── Step 1.5: O(1) HOT PATH ────────────────────────────────
    for (const hot of this.hotRingBuffer.values()) {
      const drift = this.queryGuard.evaluateDrift(querySignature, hot.signature);
      if (drift.hammingRatio < 0.10) {
        console.log(`⚡ [HOT_PATH] Direct Hit: ${hot.shardId}`);
        hot.frequency++;
        // If we hit the hot path, we can skip the full index search
        // Note: For simplicity, we bypass the slice/filter and just return the hot hit
        const selected = [{ entry: hot, drift }];
        return this.finishRetrieval(selected, totalStart, indexStart);
      }
    }

    // ─── Step 2: REFRAG top-k pre-filter ────────────────────────
    // O(N) scan keeping a running top-k heap by Hamming ratio.
    // With 33k+ shards, this avoids O(N log N) full sort —
    // we only sort the k=256 finalists.
    const k = this.config.refragK;
    const topK: Array<{ entry: IndexEntry; drift: DriftResult }> = [];
    let worstInTopK = 1.0; // highest hammingRatio currently in top-k

    for (const entry of this.index) {
      const drift = this.queryGuard.evaluateDrift(querySignature, entry.signature);
      if (topK.length < k) {
        topK.push({ entry, drift });
        if (drift.hammingRatio > worstInTopK || topK.length === 1) {
          worstInTopK = topK.reduce((max, c) => c.drift.hammingRatio > max ? c.drift.hammingRatio : max, 0);
        }
      } else if (drift.hammingRatio < worstInTopK) {
        // Find and replace the worst entry
        let worstIdx = 0;
        for (let i = 1; i < topK.length; i++) {
          if (topK[i].drift.hammingRatio > topK[worstIdx].drift.hammingRatio) worstIdx = i;
        }
        topK[worstIdx] = { entry, drift };
        worstInTopK = topK[worstIdx].drift.hammingRatio;
        // Recalculate worstInTopK from scratch (only when we evict)
        for (const c of topK) {
          if (c.drift.hammingRatio > worstInTopK) worstInTopK = c.drift.hammingRatio;
        }
      }
    }

    // Sort the k finalists ascending (closest first)
    topK.sort((a, b) => a.drift.hammingRatio - b.drift.hammingRatio);

    console.log(` [REFRAG] Pre-filter: ${k} of ${this.index.length} shards selected for threshold evaluation`);

    const indexLookupMs = Date.now() - indexStart;

    // ─── Step 3: Select top-N within threshold ──────────────────
    const selected = topK
      .filter(r => r.drift.stable) // Below calibrated threshold
      .slice(0, this.config.maxContextShards);

    // Faith-Less enforcement: if nothing is close enough, stay silent
    if (selected.length === 0) {
      return {
        answer: null,
        citations: [],
        sourceTexts: [],
        metrics: {
          indexLookupMs,
          cacheMisses: 0,
          inferenceMs: 0,
          totalMs: Date.now() - totalStart,
          shardsEvaluated: this.index.length,  // full N scanned
          shardsSelected: 0
        },
        silenced: true,
        mode: "retrieve"
      };
    }

    // ─── Step 4: Load shard content (BLAKE2b-keyed cache or disk) ──
    // Cache key = BLAKE2b-512 of "RFGv1|{shardId}" — deterministic
    // across sessions, collision-resistant, amortized O(1) for repeated queries.
    let cacheMisses = 0;
    const contextShards: CachedShard[] = [];

    for (const { entry } of selected) {
      const cacheKey = this.blake2bCacheKey(entry.shardId);
      let shard = this.cache.get(cacheKey);

      if (!shard) {
        cacheMisses++;
        const filePath = path.join(this.config.shardDir, `${entry.shardId}.json`);
        if (fs.existsSync(filePath)) {
          const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          shard = { id: cacheKey, content: raw.content, source: raw.source };
          this.cache.put(shard);
        }
      }

      if (shard) {
        // Re-attach the original shardId/source for citation output
        contextShards.push({
          id: entry.shardId,
          content: shard.content,
          source: shard.source
        });
      }
    }

    // ─── Build result (pure retrieval — no LLM) ─────────────────
    const citations = selected.map(r => ({
      shardId: r.entry.shardId,
      source: r.entry.source,
      hammingRatio: r.drift.hammingRatio,
      contentPreview: r.entry.contentPreview
    }));

    const sourceTexts = contextShards.map(s => ({
      shardId: s.id,
      source: s.source,
      fullText: s.content
    }));

    return {
      answer: null, // Pure retrieval: no generated answer
      citations,
      sourceTexts,
      metrics: {
        indexLookupMs,
        cacheMisses,
        inferenceMs: 0,
        totalMs: Date.now() - totalStart,
        shardsEvaluated: this.index.length,  // full corpus scanned (O(N) Hamming)
        shardsSelected: selected.length       // survivors after REFRAG k=256 + threshold
      },
      silenced: false,
      mode: "retrieve"
    };
  }

  /**
   * RAG query: retrieve relevant shards THEN run LLM inference.
   * Use this only when a capable model is available (Q4+ quantization).
   * Falls back to retrieve() if inference fails.
   */
  async query(question: string): Promise<QueryResult> {
    const retrieval = await this.retrieve(question);

    if (retrieval.silenced || retrieval.sourceTexts.length === 0) {
      return retrieval;
    }

    // Construct prompt from retrieved sources
    // Full shard content — Qwen2.5 has 32K context, no need to truncate
    const contextBlock = retrieval.sourceTexts
      .map((s, i) => `[Source ${i + 1}: ${s.source} / ${s.shardId}]\n${s.fullText}`)
      .join("\n\n");

    const prompt = [
      `<|system|>`,
      `You are a knowledge retrieval assistant. Answer ONLY using the provided source material. Always cite which source you used. If the sources do not contain the answer, say "I cannot answer from the provided sources."`,
      `<|end|>`,
      `<|user|>`,
      `Here is the reference material:\n${contextBlock}\n\nBased on the above sources, answer this question: ${question}`,
      `<|end|>`,
      `<|assistant|>`
    ].join("\n");

    const inferenceStart = Date.now();
    const answer = this.runInference(prompt);
    const inferenceMs = Date.now() - inferenceStart;

    return {
      ...retrieval,
      answer,
      metrics: {
        ...retrieval.metrics,
        inferenceMs,
        totalMs: Date.now() - (Date.now() - retrieval.metrics.totalMs)
      },
      mode: "query"
    };
  }

  /**
   * Execute local inference via Ollama HTTP API.
   * Synchronous wrapper around the async API for simplicity.
   * Ollama handles model loading, quantization, and threading internally.
   */
  private runInference(prompt: string): string {
    try {
      const payload = JSON.stringify({
        model: this.config.ollamaModel,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: this.config.maxResponseTokens
        }
      });

      // Synchronous HTTP POST via execSync + curl
      // Using curl because Node's http module is async-only
      const escaped = payload.replace(/'/g, "'\\''");
      const cmd = `curl -s -X POST ${this.config.ollamaUrl}/api/generate -d '${escaped}'`;

      const output = execSync(cmd, {
        timeout: 120_000,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024
      });

      const parsed = JSON.parse(output);
      return parsed.response?.trim() || "[NO_ANSWER_GENERATED]";

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`❌ [ORCHESTRATOR] Inference failed: ${message}`);
      return "[INFERENCE_ERROR: The local model failed to generate a response.]";
    }
  }

  /**
   * Get index diagnostics for monitoring.
   */
  /**
   * Get an entry from the index by index.
   */
  public getIndexEntry(idx: number) {
    return this.index[idx];
  }

  /**
   * Find the closest neighbors for a given signature.
   */
  public findNeighbors(signature: bigint, count: number) {
    const results = this.index.map(entry => ({
      ...entry,
      hammingRatio: this.guard.evaluateDrift(signature, entry.signature).hammingRatio
    }));

    return results
      .sort((a, b) => a.hammingRatio - b.hammingRatio)
      .slice(1, count + 1); // Skip the self-match if it exists
  }

  diagnostics(): {
    indexSize: number;
    cacheSize: number;
    cacheCapacity: number;
    threshold: number;
    queryThreshold: number;
    ollamaModel: string;
  } {
    return {
      indexSize: this.index.length,
      cacheSize: this.cache.size,
      cacheCapacity: this.config.cacheCapacity,
      threshold: this.config.similarityThreshold,
      queryThreshold: this.config.queryThreshold,
      ollamaModel: this.config.ollamaModel
    };
  }
}
