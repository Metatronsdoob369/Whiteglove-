/**
 * WHITE-GLOVE AGENT HUSK: LFU Shard Cache
 * 
 * Bounded-memory cache for Spectral Shards using Least-Frequently-Used
 * eviction with LRU tie-breaking. Keeps hot knowledge in RAM while
 * staying within the 3.05GB budget of the CPU-bound failover.
 * 
 * For M < 1000 active shards, sorted-array eviction is sufficient.
 * Upgrade to min-heap only if M exceeds 10,000.
 * 
 * Based on: Mentor Directive #2 — O(logM) LFU Min-Heap Gating
 */

export interface CachedShard {
  /** Shard identifier (e.g., "shard_0001") */
  id: string;
  /** Raw text content of the shard */
  content: string;
  /** Source document identifier */
  source: string;
  /** SimHash-128 signature (if computed) */
  signature?: bigint;
  /** ℓ₂-normalized embedding vector (if computed) */
  embedding?: Float64Array;
  /** Metadata from the shard JSON */
  metadata?: Record<string, unknown>;
}

interface CacheEntry {
  shard: CachedShard;
  frequency: number;
  lastAccessed: number; // monotonic counter for LRU tie-breaking
}

export class ShardCache {
  private readonly maxSize: number;
  private readonly cache: Map<string, CacheEntry> = new Map();
  private accessCounter: number = 0;

  /** Eviction callback — notifies callers when a shard is dropped */
  public onEvict?: (shard: CachedShard) => void;

  /**
   * @param maxSize - Maximum number of shards to hold in memory.
   *   Calibrate based on average shard size and available RAM.
   *   For 3.05GB environment with ~2KB avg shard: maxSize ≈ 500-1000.
   */
  constructor(maxSize: number = 500) {
    if (maxSize < 1) throw new Error("Cache maxSize must be >= 1");
    this.maxSize = maxSize;
  }

  /**
   * Retrieve a shard from cache. Increments frequency counter.
   * Returns undefined if not cached (caller must load from disk).
   */
  get(shardId: string): CachedShard | undefined {
    const entry = this.cache.get(shardId);
    if (!entry) return undefined;

    entry.frequency++;
    entry.lastAccessed = ++this.accessCounter;
    return entry.shard;
  }

  /**
   * Insert a shard into cache. Evicts if at capacity.
   * If the shard already exists, updates content and bumps frequency.
   */
  put(shard: CachedShard): void {
    const existing = this.cache.get(shard.id);

    if (existing) {
      existing.shard = shard;
      existing.frequency++;
      existing.lastAccessed = ++this.accessCounter;
      return;
    }

    // Evict if at capacity
    if (this.cache.size >= this.maxSize) {
      this.evictOne();
    }

    this.cache.set(shard.id, {
      shard,
      frequency: 1,
      lastAccessed: ++this.accessCounter
    });
  }

  /**
   * Evict the least-frequently-used shard.
   * On frequency tie, evict the least-recently-accessed (LRU tie-break).
   */
  private evictOne(): void {
    let victim: string | null = null;
    let victimFreq = Infinity;
    let victimAccess = Infinity;

    for (const [id, entry] of this.cache) {
      if (
        entry.frequency < victimFreq ||
        (entry.frequency === victimFreq && entry.lastAccessed < victimAccess)
      ) {
        victim = id;
        victimFreq = entry.frequency;
        victimAccess = entry.lastAccessed;
      }
    }

    if (victim) {
      const evicted = this.cache.get(victim);
      this.cache.delete(victim);
      if (evicted && this.onEvict) {
        this.onEvict(evicted.shard);
      }
    }
  }

  /**
   * Check if a shard is currently cached.
   */
  has(shardId: string): boolean {
    return this.cache.has(shardId);
  }

  /**
   * Remove a specific shard from cache (manual invalidation).
   */
  invalidate(shardId: string): boolean {
    return this.cache.delete(shardId);
  }

  /**
   * Clear all cached shards.
   */
  flush(): void {
    this.cache.clear();
    this.accessCounter = 0;
  }

  /**
   * Current cache size.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Cache diagnostic snapshot for the Dream cycle.
   * Returns sorted list of cached shards with frequency data.
   */
  diagnostics(): Array<{ id: string; frequency: number; lastAccessed: number }> {
    return Array.from(this.cache.entries())
      .map(([id, entry]) => ({
        id,
        frequency: entry.frequency,
        lastAccessed: entry.lastAccessed
      }))
      .sort((a, b) => b.frequency - a.frequency);
  }
}
