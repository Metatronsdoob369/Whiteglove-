import { createHash } from "node:crypto";

// SimHash-128: tokenize -> hash each token to 128 bits -> accumulate signed
// bit vector -> collapse to 128-bit fingerprint. Hamming distance between
// fingerprints approximates cosine-ish semantic overlap of the token sets.

// Negation terms are content, not stopwords: "should NOT give aspirin" must
// never fingerprint identically to "should give aspirin". Keep them (and any
// other polarity-bearing word) out of this list.
export const NEGATION_TERMS = new Set([
  "not", "no", "never", "avoid", "contraindicated",
]);

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "in", "on", "at", "to", "for",
  "with", "is", "are", "was", "were", "be", "been", "do", "does", "did",
  "what", "whats", "how", "when", "where", "why", "which", "who", "whom",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "them",
  "my", "your", "his", "its", "our", "their", "this", "that", "these",
  "those", "there", "here", "if", "then", "than", "so", "such", "as", "by",
  "from", "up", "down", "out", "about", "into", "over", "after", "before",
  "can", "could", "should", "would", "will", "shall", "may", "might", "must",
  "yes", "someone", "somebody", "something", "give", "take",
  "get", "got", "has", "have", "had", "tell", "know", "use", "used", "using",
]);

export function tokenize(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  // unigrams + bigrams so multi-word concepts ("blood sugar") count
  const tokens: string[] = [...words];
  for (let i = 0; i < words.length - 1; i++) {
    tokens.push(`${words[i]}_${words[i + 1]}`);
  }
  return tokens;
}

function hash128(token: string): [bigint, bigint] {
  const digest = createHash("md5").update(token).digest();
  const hi = digest.readBigUInt64BE(0);
  const lo = digest.readBigUInt64BE(8);
  return [hi, lo];
}

// Returns the fingerprint as a 32-char hex string (16 bytes).
export function simhash128(text: string): string {
  const tokens = tokenize(text);
  const v = new Array<number>(128).fill(0);

  // term frequency weighting
  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);

  for (const [token, weight] of freq) {
    const [hi, lo] = hash128(token);
    for (let i = 0; i < 64; i++) {
      const bit = (hi >> BigInt(63 - i)) & 1n;
      v[i] += bit === 1n ? weight : -weight;
    }
    for (let i = 0; i < 64; i++) {
      const bit = (lo >> BigInt(63 - i)) & 1n;
      v[64 + i] += bit === 1n ? weight : -weight;
    }
  }

  let hi = 0n;
  let lo = 0n;
  for (let i = 0; i < 64; i++) {
    if (v[i] > 0) hi |= 1n << BigInt(63 - i);
  }
  for (let i = 0; i < 64; i++) {
    if (v[64 + i] > 0) lo |= 1n << BigInt(63 - i);
  }
  return hi.toString(16).padStart(16, "0") + lo.toString(16).padStart(16, "0");
}

function hexToBigints(hex: string): [bigint, bigint] {
  const normalized = hex.padStart(32, "0").slice(0, 32);
  return [
    BigInt("0x" + normalized.slice(0, 16)),
    BigInt("0x" + normalized.slice(16, 32)),
  ];
}

function popcount64(x: bigint): number {
  let count = 0;
  while (x > 0n) {
    x &= x - 1n;
    count++;
  }
  return count;
}

// Raw hamming distance (0..128) between two hex fingerprints.
export function hammingDistance(hexA: string, hexB: string): number {
  const [aHi, aLo] = hexToBigints(hexA);
  const [bHi, bLo] = hexToBigints(hexB);
  return popcount64(aHi ^ bHi) + popcount64(aLo ^ bLo);
}

// Normalized distance in [0, 1].
export function normalizedHamming(hexA: string, hexB: string): number {
  return hammingDistance(hexA, hexB) / 128;
}

export interface RankedCandidate {
  id: number;
  distance: number; // normalized
}

export function rankCandidates(
  queryFingerprint: string,
  vault: Array<{ id: number; fingerprint: string }>,
  topK = 3,
): RankedCandidate[] {
  return vault
    .map((s) => ({ id: s.id, distance: normalizedHamming(queryFingerprint, s.fingerprint) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, topK);
}
