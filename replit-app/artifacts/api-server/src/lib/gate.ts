import { normalizedHamming, tokenize } from "./simhash";

// Silence gate: a shard may only be spoken if BOTH conditions hold:
//
//  1. Statistical: the measured SimHash distance is at or below
//     SILENCE_THRESHOLD.
//  2. Lexical: the RAW USER QUERY shares at least MIN_SHARED_TOKENS content
//     tokens with the shard's retrieval text.
//
// Why two conditions: SimHash-128 on short texts cannot by itself separate
// related from unrelated content — an unrelated query can land at ~0.41 of a
// shard purely by chance (measured: "what is quantum mechanics" scored 0.406
// against Insulin Therapy). But chance near-misses share no tokens with the
// shard, while genuine in-scope queries do. The lexical check vetoes the
// accidents; the distance check vetoes lexically-overlapping-but-weak
// matches. Both are enforced here, in server code, not by the model.
//
// Why the overlap check reads ONLY the raw query: the distance check may
// credit the agent's reformulated search phrases (query expansion — a valid
// paraphrase can exceed the raw-distance threshold while its agent phrase
// lands close). But phrases are model output. If overlap also credited
// phrases, a fooled model could launder an unrelated query into a pass by
// searching vault vocabulary ("insulin therapy basal bolus dosing" for a
// quantum-mechanics question), manufacturing both a low distance and token
// overlap. Anchoring overlap to the user's own words keeps the lexical veto
// independent of model behavior.
//
// The threshold and minimum-overlap values are calibrated against a fixed
// battery of in-scope, unrelated, and negated queries — see
// src/lib/gate.calibration.test.ts (measures and enforces the separation)
// and docs/silence-gate-calibration.md (the recorded numbers).
export const SILENCE_THRESHOLD = 0.45;
export const MIN_SHARED_TOKENS = 2;

// The distance the gate acts on combines two measurements:
//  - the raw user query fingerprinted against the candidate shard
//  - the agent's best reformulated search-phrase distance against that shard
//    (query expansion is the agent's contribution to retrieval)
// The honest distance is the minimum of the two.
export function gateDistance(
  queryFingerprint: string,
  candidateFingerprint: string,
  searchBestDistance: number | null | undefined,
): number {
  const queryDistance = normalizedHamming(queryFingerprint, candidateFingerprint);
  return searchBestDistance != null
    ? Math.min(queryDistance, searchBestDistance)
    : queryDistance;
}

// Content tokens shared between the raw user query and the candidate shard's
// retrieval text. Deliberately takes the raw query only — never agent
// search phrases (see module comment).
export function sharedTokenCount(
  rawQuery: string,
  candidateSearchText: string,
): number {
  const candidateTokens = new Set(tokenize(candidateSearchText));
  const queryTokens = new Set(tokenize(rawQuery));
  let shared = 0;
  for (const t of queryTokens) if (candidateTokens.has(t)) shared++;
  return shared;
}

export interface GateDecision {
  allows: boolean;
  distance: number;
  sharedTokens: number;
  // Why the gate vetoed, when it did — surfaced in the UI and decision log.
  veto: "distance" | "overlap" | null;
}

export function evaluateGate(input: {
  queryFingerprint: string;
  rawQuery: string;
  candidateFingerprint: string;
  candidateSearchText: string;
  searchBestDistance: number | null | undefined;
}): GateDecision {
  const distance = gateDistance(
    input.queryFingerprint,
    input.candidateFingerprint,
    input.searchBestDistance,
  );
  const sharedTokens = sharedTokenCount(input.rawQuery, input.candidateSearchText);
  if (sharedTokens < MIN_SHARED_TOKENS) {
    return { allows: false, distance, sharedTokens, veto: "overlap" };
  }
  if (distance > SILENCE_THRESHOLD) {
    return { allows: false, distance, sharedTokens, veto: "distance" };
  }
  return { allows: true, distance, sharedTokens, veto: null };
}
