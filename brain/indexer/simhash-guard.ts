/**
 * WHITE-GLOVE AGENT HUSK: SimHash-128 Drift Guard
 * 
 * Replaces O(N²) floating-point cosine similarity with O(128) bitwise
 * Hamming distance for spectral shard routing on CPU-bound environments.
 * 
 * Architecture:
 * - Twin 64-bit accumulators with domain-separated FNV-1a salt folding.
 * - 128-bit BigInt signature per shard.
 * - XOR + popcount for microsecond drift evaluation.
 *
 * Based on: Charikar (2002) — Locality-Sensitive Hashing.
 * Adapted from airgapped mentor directive for WhiteGlove deployment.
 */

export interface SimHashSignature {
  /** The 128-bit signature as a BigInt */
  signature: bigint;
  /** Source shard ID for audit trail */
  shardId: string;
  /** Timestamp of signature generation */
  generatedAt: string;
}

export interface DriftResult {
  /** Whether the two signatures are within threshold */
  stable: boolean;
  /** Raw Hamming distance (number of differing bits) */
  hammingDistance: number;
  /** Hamming distance as a ratio of total bits (0.0 - 1.0) */
  hammingRatio: number;
  /** The threshold used for evaluation */
  threshold: number;
}

const DIMENSIONS_64 = 64n;
const TOTAL_BITS = 128;

export class SimHashDriftGuard {
  private readonly threshold: number;
  /**
   * Optional IDF token weights (known-issue #4, "token weighting").
   * Without weights, generic tokens ("how", "the", "const", "return")
   * vote as loudly as rare distinctive ones, so every query drifts
   * toward the corpus-average signature and answerable/unanswerable
   * queries land in the same band. With IDF weights, rare tokens
   * dominate the accumulator. Weights are corpus statistics: compute
   * them at index build (computeIdfWeights), persist them with the
   * index, and sign shards AND queries with the same weights.
   */
  private tokenWeights: Map<string, number> | null = null;
  private unseenTokenWeight: number = 1.0;

  /**
   * @param threshold - Hamming ratio threshold for stability (0.0 - 1.0).
   *   Default 0.15 is conservative. Calibrate against your corpus.
   *   The mentor suggested 0.03 — that's extremely tight and should
   *   only be used after empirical calibration.
   */
  constructor(threshold: number = 0.15) {
    if (threshold < 0 || threshold > 1) {
      throw new Error(`Threshold must be 0.0-1.0, got ${threshold}`);
    }
    this.threshold = threshold;
  }

  /**
   * Evaluate drift between two 128-bit SimHash signatures.
   * Returns stability verdict + full diagnostic data.
   */
  evaluateDrift(sigA: bigint, sigB: bigint): DriftResult {
    const xor = sigA ^ sigB;
    const hammingDistance = this.popcount(xor);
    const hammingRatio = hammingDistance / TOTAL_BITS;

    return {
      stable: hammingRatio <= this.threshold,
      hammingDistance,
      hammingRatio,
      threshold: this.threshold
    };
  }

  /**
   * Convenience: check stability as a boolean.
   */
  isStable(sigA: bigint, sigB: bigint): boolean {
    return this.evaluateDrift(sigA, sigB).stable;
  }

  /**
   * Generate a 128-bit SimHash signature from a normalized embedding vector.
   * 
   * The vector MUST be ℓ₂-normalized before calling this.
   * Each float dimension is hashed independently with domain separation,
   * and the accumulator produces a locality-sensitive 128-bit fingerprint.
   * 
   * @param vector - ℓ₂-normalized Float64Array (3072-D)
   * @param schema - Schema identifier for domain separation (e.g., "medline", "usda")
   */
  simHash128FromVector(vector: Float64Array, schema: string): bigint {
    const schemaSlice = schema.slice(0, 6);
    const saltA = Buffer.from(`RFG:shA:${schemaSlice}`);
    const saltB = Buffer.from(`RFG:shB:${schemaSlice}`);

    // Quantize the normalized float vector into token IDs
    // Maps each float [-1, 1] → uint32 [0, 4294967295]
    const tokens = new Uint32Array(vector.length);
    for (let i = 0; i < vector.length; i++) {
      tokens[i] = Math.floor(((vector[i] + 1.0) / 2.0) * 0xFFFFFFFF) >>> 0;
    }

    const sigA = this.simHash64(tokens, saltA);
    const sigB = this.simHash64(tokens, saltB);

    return (sigA << DIMENSIONS_64) | sigB;
  }

  /**
   * Generate a 128-bit SimHash signature from raw text content.
   * Uses word-level tokenization (whitespace split + lowercase).
   * Suitable for text shards before embedding.
   * 
   * @param text - Raw text content
   * @param schema - Schema identifier for domain separation
   */
  simHash128FromText(text: string, schema: string): bigint {
    const schemaSlice = schema.slice(0, 6);
    const saltA = Buffer.from(`RFG:shA:${schemaSlice}`);
    const saltB = Buffer.from(`RFG:shB:${schemaSlice}`);

    const words = this.tokenizeText(text);
    const tokens = new Uint32Array(words.length);
    const weights = new Float64Array(words.length);
    for (let i = 0; i < words.length; i++) {
      tokens[i] = this.fnv1a32(words[i]);
      weights[i] = this.tokenWeights
        ? this.tokenWeights.get(words[i]) ?? this.unseenTokenWeight
        : 1.0;
    }

    const sigA = this.simHash64(tokens, saltA, weights);
    const sigB = this.simHash64(tokens, saltB, weights);

    return (sigA << DIMENSIONS_64) | sigB;
  }

  /**
   * Compute IDF weights over a corpus: idf(t) = ln(1 + N/df(t)), with the
   * unseen-token weight pinned to the rarest class (df = 1). Deterministic,
   * offline, dependency-free.
   */
  computeIdfWeights(texts: string[]): { weights: Map<string, number>; unseenWeight: number } {
    const df = new Map<string, number>();
    for (const text of texts) {
      for (const token of this.tokenizeText(text)) {
        df.set(token, (df.get(token) ?? 0) + 1);
      }
    }
    const n = texts.length;
    const weights = new Map<string, number>();
    for (const [token, count] of df) {
      weights.set(token, Math.log(1 + n / count));
    }
    return { weights, unseenWeight: Math.log(1 + n) };
  }

  /** Install (or clear) the IDF weights used by simHash128FromText. */
  setTokenWeights(weights: Map<string, number> | null, unseenWeight: number = 1.0): void {
    this.tokenWeights = weights;
    this.unseenTokenWeight = unseenWeight;
  }

  /** Expose weights for index persistence. */
  getTokenWeights(): { weights: Map<string, number> | null; unseenWeight: number } {
    return { weights: this.tokenWeights, unseenWeight: this.unseenTokenWeight };
  }

  /**
   * Code-aware tokenization. Plain whitespace splitting left punctuation
   * glued to code tokens (`entry.frequency` never matched "frequency"), so
   * short natural-language queries shared almost no token mass with 120-line
   * code chunks — measured on the calibration corpus as median evidence rank
   * 30/131 and NEGATIVE grounded-vs-negative separation. This splits
   * camelCase identifiers, breaks on any non-letter/non-digit rune
   * (unicode-aware, so ℓ₂ survives), and drops 1-char noise.
   *
   * Changing tokenization changes every text signature: serialized indexes
   * must be rebuilt, and thresholds calibrated on the old tokenizer
   * (including the 0.2858 shard-drift value) need recalibration.
   */
  private tokenizeText(text: string): string[] {
    const words = text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 2);
    // Set semantics: each unique token votes once. With raw frequency, a
    // token repeated 20× in a 120-line chunk casts 20 votes and the chunk's
    // bulk vocabulary drowns the few distinctive tokens a short query can
    // share — presence, not repetition, is the similarity signal here.
    return [...new Set(words)];
  }

  /**
   * Internal 64-bit accumulator.
   * Processes token IDs through the salted hash and accumulates
   * weighted votes per bit (weight 1.0 without IDF weights).
   */
  private simHash64(tokens: Uint32Array, personSalt: Buffer, tokenVoteWeights?: Float64Array): bigint {
    const acc = new Float64Array(64);
    // Pre-calculate salt hash part
    let saltHash = 0xcbf29ce484222325n;
    for (let i = 0; i < personSalt.length; i++) {
      saltHash ^= BigInt(personSalt[i]);
      saltHash = (saltHash * 0x100000001b3n) & 0xffffffffffffffffn;
    }

    for (let i = 0; i < tokens.length; i++) {
      let tokenHash = saltHash ^ BigInt(tokens[i]);
      tokenHash = (tokenHash * 0x100000001b3n) & 0xffffffffffffffffn;

      // Split 64-bit BigInt into two 32-bit integers for faster bitwise ops
      let low = Number(tokenHash & 0xffffffffn) | 0;
      let high = Number((tokenHash >> 32n) & 0xffffffffn) | 0;

      const w = tokenVoteWeights ? tokenVoteWeights[i] : 1.0;
      for (let bit = 0; bit < 32; bit++) {
        acc[bit] += (low & (1 << bit)) ? w : -w;
        acc[bit + 32] += (high & (1 << bit)) ? w : -w;
      }
    }

    let sig = 0n;
    for (let i = 0; i < 64; i++) {
      if (acc[i] > 0) {
        sig |= (1n << BigInt(i));
      }
    }
    return sig;
  }

  /**
   * FNV-1a 32-bit hash for word tokenization.
   * Fast, well-distributed, no crypto overhead.
   */
  private fnv1a32(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  /**
   * Popcount for BigInt — counts set bits via iterative shift.
   */
  private popcount(n: bigint): number {
    let count = 0;
    let val = n < 0n ? -n : n;
    while (val > 0n) {
      count += Number(val & 1n);
      val >>= 1n;
    }
    return count;
  }
}
