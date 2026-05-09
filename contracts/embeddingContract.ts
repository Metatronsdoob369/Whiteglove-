/**
 * WHITE-GLOVE AGENT HUSK: EMBEDDING CONTRACT
 * 
 * ℓ₂-Normalization Gate — enforced at ingestion time.
 * All vectors entering the Spectral Vault MUST pass through this contract.
 * Unnormalized embeddings are rejected. Zero vectors are rejected.
 * 
 * This is the mathematical foundation that SimHash-128 and cosine
 * similarity both depend on. Without it, bit-weight distribution
 * in the SimHash accumulator will be dominated by high-magnitude
 * dimensions, producing garbage signatures.
 */

export type EmbeddingVector = Float64Array;

export type NormalizationResult =
  | { ok: true; vector: EmbeddingVector; magnitude: number }
  | { ok: false; error: string; code: "ZERO_VECTOR" | "NAN_DETECTED" | "INVALID_DIMENSIONS" | "MAGNITUDE_DRIFT" };

const EXPECTED_DIMENSIONS = 3072;
const MAGNITUDE_TOLERANCE = 1e-6; // For verifying already-normalized vectors

/**
 * Computes the ℓ₂ magnitude (Euclidean norm) of a vector.
 * Uses Kahan summation to reduce floating-point accumulation error
 * on high-dimensional vectors.
 */
function l2Magnitude(vec: EmbeddingVector): number {
  let sum = 0.0;
  let compensation = 0.0; // Kahan compensation variable

  for (let i = 0; i < vec.length; i++) {
    const term = vec[i] * vec[i] - compensation;
    const temp = sum + term;
    compensation = (temp - sum) - term;
    sum = temp;
  }

  return Math.sqrt(sum);
}

/**
 * ℓ₂-Normalize a raw embedding vector.
 * Returns a NEW Float64Array — never mutates the input.
 * 
 * Enforces:
 * - Correct dimensionality (3072)
 * - No NaN/Infinity values
 * - Non-zero magnitude
 */
export function l2Normalize(raw: number[] | Float64Array): NormalizationResult {
  if (raw.length !== EXPECTED_DIMENSIONS) {
    return {
      ok: false,
      error: `Expected ${EXPECTED_DIMENSIONS} dimensions, got ${raw.length}`,
      code: "INVALID_DIMENSIONS"
    };
  }

  const vec = raw instanceof Float64Array ? raw : new Float64Array(raw);

  // Scan for NaN/Infinity before computing magnitude
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) {
      return {
        ok: false,
        error: `NaN or Infinity detected at dimension ${i}`,
        code: "NAN_DETECTED"
      };
    }
  }

  const magnitude = l2Magnitude(vec);

  if (magnitude === 0) {
    return {
      ok: false,
      error: "Zero vector rejected — no semantic content",
      code: "ZERO_VECTOR"
    };
  }

  const normalized = new Float64Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    normalized[i] = vec[i] / magnitude;
  }

  return { ok: true, vector: normalized, magnitude };
}

/**
 * Verify that a vector is already ℓ₂-normalized.
 * Used at query time as a fast guard — if this fails,
 * the vector was tampered with or corrupted in transit.
 */
export function verifyNormalized(vec: EmbeddingVector): boolean {
  if (vec.length !== EXPECTED_DIMENSIONS) return false;
  const mag = l2Magnitude(vec);
  return Math.abs(mag - 1.0) < MAGNITUDE_TOLERANCE;
}

/**
 * Contract-level validation for embedding payloads.
 * Combines dimensionality, NaN, and normalization checks
 * into a single gate.
 */
export function validateEmbeddingPayload(payload: unknown): NormalizationResult {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Payload must be an object", code: "INVALID_DIMENSIONS" };
  }

  const p = payload as Record<string, unknown>;

  if (!Array.isArray(p.vector) && !(p.vector instanceof Float64Array)) {
    return { ok: false, error: "Missing or invalid 'vector' field", code: "INVALID_DIMENSIONS" };
  }

  return l2Normalize(p.vector as number[] | Float64Array);
}
