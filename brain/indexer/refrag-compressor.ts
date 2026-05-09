/**
 * WHITE-GLOVE AGENT HUSK: REFRAG Select-k Semantic Compressor
 * 
 * Compresses 3072-D ℓ₂-normalized embeddings into sparse select-k
 * representations by retaining only the top-k most discriminative
 * dimensions. This reduces per-shard memory from 24KB to ~3KB (at k=256)
 * while preserving retrieval quality for topological routing.
 * 
 * The compressed representation stores (index, value) pairs sorted by
 * absolute magnitude — the dimensions that carry the most semantic weight.
 * 
 * Similarity between compressed shards uses sparse dot product,
 * which is O(k) instead of O(3072).
 * 
 * Based on: Mentor Directive #2 — REFRAG Semantic Compression
 * Adapted for WhiteGlove Agent Husk deployment.
 */

import { EmbeddingVector, verifyNormalized } from "../../contracts/embeddingContract";

export interface CompressedEmbedding {
  /** Original shard ID */
  shardId: string;
  /** Number of retained dimensions */
  k: number;
  /** Original dimensionality */
  originalDimensions: number;
  /** Sorted (index, value) pairs — top-k by absolute magnitude */
  components: Array<{ dim: number; val: number }>;
  /** Compression ratio (k / originalDimensions) */
  compressionRatio: number;
  /** Sum of squared retained values — measures how much energy is preserved */
  energyRetained: number;
}

export interface CompressionConfig {
  /** Number of dimensions to retain. Default: 256 */
  k: number;
  /** Minimum energy retention threshold (0.0 - 1.0). 
   *  If top-k dimensions capture less than this fraction of total energy,
   *  the compression is flagged as lossy. Default: 0.70 */
  minEnergyRetention: number;
}

const DEFAULT_CONFIG: CompressionConfig = {
  k: 256,
  minEnergyRetention: 0.70
};

export type CompressionResult =
  | { ok: true; compressed: CompressedEmbedding }
  | { ok: false; error: string; code: "NOT_NORMALIZED" | "K_TOO_LARGE" | "ENERGY_TOO_LOW" };

/**
 * Compress a 3072-D ℓ₂-normalized embedding to its top-k components.
 * 
 * The vector MUST be ℓ₂-normalized (verified via contract gate).
 * For a unit vector, total energy = 1.0, so energyRetained directly
 * represents the fraction of semantic signal preserved.
 */
export function compressEmbedding(
  vector: EmbeddingVector,
  shardId: string,
  config: Partial<CompressionConfig> = {}
): CompressionResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Contract enforcement: vector must be normalized
  if (!verifyNormalized(vector)) {
    return {
      ok: false,
      error: "Vector is not ℓ₂-normalized. Run through embeddingContract first.",
      code: "NOT_NORMALIZED"
    };
  }

  if (cfg.k >= vector.length) {
    return {
      ok: false,
      error: `k (${cfg.k}) must be less than vector dimensions (${vector.length})`,
      code: "K_TOO_LARGE"
    };
  }

  // Build (index, absValue, value) tuples and sort by absolute magnitude descending
  const indexed: Array<{ dim: number; absVal: number; val: number }> = [];
  for (let i = 0; i < vector.length; i++) {
    indexed.push({ dim: i, absVal: Math.abs(vector[i]), val: vector[i] });
  }
  indexed.sort((a, b) => b.absVal - a.absVal);

  // Take top-k
  const topK = indexed.slice(0, cfg.k);
  const energyRetained = topK.reduce((sum, c) => sum + c.val * c.val, 0);

  if (energyRetained < cfg.minEnergyRetention) {
    return {
      ok: false,
      error: `Energy retention ${(energyRetained * 100).toFixed(1)}% below minimum ${(cfg.minEnergyRetention * 100).toFixed(1)}%. Increase k or lower threshold.`,
      code: "ENERGY_TOO_LOW"
    };
  }

  // Store as sorted (dim, val) pairs — sorted by dimension index
  // for efficient sparse dot product via merge-join
  const components = topK
    .map(c => ({ dim: c.dim, val: c.val }))
    .sort((a, b) => a.dim - b.dim);

  return {
    ok: true,
    compressed: {
      shardId,
      k: cfg.k,
      originalDimensions: vector.length,
      components,
      compressionRatio: cfg.k / vector.length,
      energyRetained
    }
  };
}

/**
 * Compute sparse dot product similarity between two compressed embeddings.
 * 
 * Uses merge-join on sorted dimension indices for O(k) complexity
 * instead of O(3072) for dense comparison.
 * 
 * Since inputs are from ℓ₂-normalized vectors, the dot product
 * approximates cosine similarity.
 */
export function sparseSimilarity(a: CompressedEmbedding, b: CompressedEmbedding): number {
  let similarity = 0;
  let i = 0, j = 0;

  while (i < a.components.length && j < b.components.length) {
    if (a.components[i].dim === b.components[j].dim) {
      similarity += a.components[i].val * b.components[j].val;
      i++;
      j++;
    } else if (a.components[i].dim < b.components[j].dim) {
      i++;
    } else {
      j++;
    }
  }

  return similarity;
}

/**
 * Serialize a compressed embedding to a compact JSON-safe format.
 * Dimensions and values are stored as parallel arrays to minimize
 * JSON overhead (no repeated "dim"/"val" keys).
 */
export function serializeCompressed(c: CompressedEmbedding): object {
  return {
    id: c.shardId,
    k: c.k,
    d: c.originalDimensions,
    dims: c.components.map(x => x.dim),
    vals: c.components.map(x => Number(x.val.toFixed(8))),
    energy: Number(c.energyRetained.toFixed(6)),
    ratio: Number(c.compressionRatio.toFixed(6))
  };
}

/**
 * Deserialize a compressed embedding from the compact format.
 */
export function deserializeCompressed(raw: {
  id: string;
  k: number;
  d: number;
  dims: number[];
  vals: number[];
  energy: number;
  ratio: number;
}): CompressedEmbedding {
  const components: Array<{ dim: number; val: number }> = [];
  for (let i = 0; i < raw.dims.length; i++) {
    components.push({ dim: raw.dims[i], val: raw.vals[i] });
  }

  return {
    shardId: raw.id,
    k: raw.k,
    originalDimensions: raw.d,
    components,
    compressionRatio: raw.ratio,
    energyRetained: raw.energy
  };
}
