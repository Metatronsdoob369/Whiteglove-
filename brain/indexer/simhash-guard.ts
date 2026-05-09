/**
 * WHITE-GLOVE AGENT HUSK: SimHash-128 Drift Guard
 * 
 * Replaces O(N²) floating-point cosine similarity with O(128) bitwise
 * Hamming distance for spectral shard routing on CPU-bound environments.
 * 
 * Architecture:
 * - Twin 64-bit accumulators with domain-separated BLAKE2b salts.
 * - 128-bit BigInt signature per shard.
 * - XOR + popcount for microsecond drift evaluation.
 * 
 * Based on: Charikar (2002) — Locality-Sensitive Hashing.
 * Adapted from airgapped mentor directive for WhiteGlove deployment.
 */

import * as crypto from "crypto";

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

    // Simple word-level tokenization: lowercase, split on whitespace
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    const tokens = new Uint32Array(words.length);
    for (let i = 0; i < words.length; i++) {
      tokens[i] = this.fnv1a32(words[i]);
    }

    const sigA = this.simHash64(tokens, saltA);
    const sigB = this.simHash64(tokens, saltB);

    return (sigA << DIMENSIONS_64) | sigB;
  }

  /**
   * Internal 64-bit accumulator.
   * Processes token IDs through BLAKE2b, applies bit-weights
   * to isolate systemic token dominance.
   */
  private simHash64(tokens: Uint32Array, personSalt: Buffer): bigint {
    const acc = new Int32Array(64);

    for (let i = 0; i < tokens.length; i++) {
      const tokenHash = this.hashToken(tokens[i], personSalt);
      for (let bit = 0n; bit < DIMENSIONS_64; bit++) {
        acc[Number(bit)] += ((tokenHash >> bit) & 1n) === 1n ? 1 : -1;
      }
    }

    let sig = 0n;
    for (let i = 0n; i < DIMENSIONS_64; i++) {
      if (acc[Number(i)] > 0) {
        sig |= (1n << i);
      }
    }
    return sig;
  }

  /**
   * 8-byte BLAKE2b digest with domain-separation salt prepended.
   * Node.js crypto doesn't support the `person` parameter natively,
   * so we prepend the salt to the input buffer (functionally equivalent).
   */
  private hashToken(token: number, personSalt: Buffer): bigint {
    const tokenBuf = Buffer.alloc(4);
    tokenBuf.writeUInt32BE(token, 0);

    const data = Buffer.concat([personSalt, tokenBuf]);
    const hash = crypto.createHash("blake2b512").update(data).digest();

    return hash.readBigUInt64BE(0);
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
