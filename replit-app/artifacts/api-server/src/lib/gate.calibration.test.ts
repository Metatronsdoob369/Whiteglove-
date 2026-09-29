import { describe, it, expect } from "vitest";
import { simhash128, normalizedHamming, tokenize } from "./simhash";
import { SEED_SHARDS, seedFingerprint, seedSearchText } from "./seed";
import {
  SILENCE_THRESHOLD,
  MIN_SHARED_TOKENS,
  evaluateGate,
  sharedTokenCount,
} from "./gate";

// Calibration battery. Each in-scope query names the shard it should land on
// plus a realistic search phrase the agent would reformulate it into — the
// gate credits the min(raw query, best agent phrase) distance, so paraphrases
// whose raw distance exceeds the threshold are carried by their phrase.
// Unrelated queries are evaluated on the RAW query alone: the agent's honest
// phrases for a genuinely unrelated query are equally unrelated, so raw-only
// is the honest worst case there.
const IN_SCOPE: Array<{ query: string; concept: string; phrase: string }> = [
  { query: "what are the signs of diabetic ketoacidosis", concept: "Diabetic Ketoacidosis (DKA)", phrase: "diabetic ketoacidosis signs symptoms" },
  { query: "my blood sugar keeps dropping and I feel shaky and sweaty", concept: "Hypoglycemia", phrase: "hypoglycemia low blood sugar symptoms" },
  { query: "how is type 1 diabetes treated", concept: "Type 1 Diabetes Management", phrase: "type 1 diabetes treatment management" },
  { query: "what is the difference between basal and bolus insulin", concept: "Insulin Therapy", phrase: "insulin therapy basal bolus dosing" },
  { query: "someone collapsed and has no pulse what do I do", concept: "Cardiac Arrest / CPR", phrase: "cardiac arrest cpr no pulse" },
  { query: "face drooping and slurred speech", concept: "Stroke", phrase: "stroke fast face drooping speech" },
  { query: "severe allergic reaction to a bee sting, throat is swelling", concept: "Anaphylaxis", phrase: "anaphylaxis severe allergic reaction" },
  { query: "first line medication for type 2 diabetes", concept: "Type 2 Diabetes Management", phrase: "type 2 diabetes first line treatment" },
];

const UNRELATED: string[] = [
  "what is quantum mechanics",
  "who won the world cup in 1998",
  "what is the capital of France",
  "how do I bake sourdough bread",
  "explain photosynthesis",
  "best treatment for a sprained ankle", // medical, but outside the vault
  "how to change a car tire",
];

// Negated phrasings of vault topics must still reach the right shard — the
// shard text is where the negation guidance lives ("Do not give aspirin…").
const NEGATED_IN_SCOPE: Array<{ query: string; concept: string; phrase: string }> = [
  { query: "should I not give aspirin during a stroke", concept: "Stroke", phrase: "stroke aspirin contraindication" },
  { query: "is aspirin contraindicated in stroke", concept: "Stroke", phrase: "stroke aspirin contraindicated" },
  { query: "insulin should never be stopped in type 1 diabetes", concept: "Type 1 Diabetes Management", phrase: "type 1 diabetes insulin dependent" },
];

const vault = SEED_SHARDS.map((s, i) => ({
  id: i + 1,
  concept: s.concept,
  fingerprint: seedFingerprint(s),
  searchText: seedSearchText(s),
}));

function shardByConcept(concept: string) {
  return vault.find((s) => s.concept === concept)!;
}

// The gate as the route applies it when the agent chose `concept`: distance
// credits the agent's search phrase (query expansion), but the lexical
// overlap check reads the raw user query only.
function gateFor(query: string, concept: string, phrase?: string) {
  const candidate = shardByConcept(concept);
  return evaluateGate({
    queryFingerprint: simhash128(query),
    rawQuery: query,
    candidateFingerprint: candidate.fingerprint,
    candidateSearchText: candidate.searchText,
    searchBestDistance: phrase
      ? normalizedHamming(simhash128(phrase), candidate.fingerprint)
      : null,
  });
}

// Closest shard by raw distance, for the measurement table.
function bestMatch(query: string) {
  const fp = simhash128(query);
  let best = { concept: null as string | null, distance: Infinity, shared: 0 };
  for (const shard of vault) {
    const d = normalizedHamming(fp, shard.fingerprint);
    if (d < best.distance) {
      best = {
        concept: shard.concept,
        distance: d,
        shared: sharedTokenCount(query, shard.searchText),
      };
    }
  }
  return best;
}

describe("silence-gate calibration", () => {
  it("prints the measured distance table", () => {
    const rows: Array<Record<string, unknown>> = [];
    for (const { query, concept, phrase } of IN_SCOPE) {
      const raw = gateFor(query, concept);
      const g = gateFor(query, concept, phrase);
      rows.push({
        kind: "in-scope",
        query,
        expected: concept,
        rawDist: raw.distance.toFixed(4),
        creditedDist: g.distance.toFixed(4),
        shared: g.sharedTokens,
        gate: g.allows ? "ALLOW" : `VETO(${g.veto})`,
      });
    }
    for (const { query, concept, phrase } of NEGATED_IN_SCOPE) {
      const raw = gateFor(query, concept);
      const g = gateFor(query, concept, phrase);
      rows.push({
        kind: "negated",
        query,
        expected: concept,
        rawDist: raw.distance.toFixed(4),
        creditedDist: g.distance.toFixed(4),
        shared: g.sharedTokens,
        gate: g.allows ? "ALLOW" : `VETO(${g.veto})`,
      });
    }
    for (const query of UNRELATED) {
      const b = bestMatch(query);
      const g = gateFor(query, b.concept!);
      rows.push({
        kind: "unrelated",
        query,
        expected: "(silence)",
        rawDist: b.distance.toFixed(4),
        creditedDist: b.distance.toFixed(4),
        shared: b.shared,
        gate: g.allows ? "ALLOW" : `VETO(${g.veto})`,
      });
    }
    console.table(rows);
    const inScopeMax = Math.max(
      ...[...IN_SCOPE, ...NEGATED_IN_SCOPE].map(({ query, concept, phrase }) => gateFor(query, concept, phrase).distance),
    );
    const unrelatedMin = Math.min(...UNRELATED.map((q) => bestMatch(q).distance));
    const unrelatedMaxShared = Math.max(...UNRELATED.map((q) => bestMatch(q).shared));
    console.log(
      `threshold=${SILENCE_THRESHOLD} minShared=${MIN_SHARED_TOKENS} | ` +
        `max in-scope credited distance=${inScopeMax.toFixed(4)} | ` +
        `min unrelated distance=${unrelatedMin.toFixed(4)} | ` +
        `max unrelated shared tokens=${unrelatedMaxShared}`,
    );
  });

  it("in-scope queries are allowed by the gate against the expected shard", () => {
    for (const { query, concept, phrase } of IN_SCOPE) {
      const g = gateFor(query, concept, phrase);
      expect(g.allows, `${query} -> ${JSON.stringify(g)}`).toBe(true);
    }
  });

  it("unrelated queries are silenced by the GATE, not just the model", () => {
    for (const query of UNRELATED) {
      const b = bestMatch(query);
      // Simulate the worst case: the model was fooled and chose the argmin
      // shard. The gate must still veto on raw-query evidence alone.
      const g = gateFor(query, b.concept!);
      expect(g.allows, `${query} -> ${JSON.stringify({ ...g, concept: b.concept })}`).toBe(false);
    }
  });

  it("the gate still vetoes when a fooled model searches vault vocabulary", () => {
    // Adversarial case: for an unrelated query, a fooled model could search
    // vault terminology (manufacturing a low credited distance AND token
    // overlap if overlap credited phrases) and answer with that shard. The
    // overlap check reads the raw query only, so this attack must fail.
    for (const query of UNRELATED) {
      const b = bestMatch(query);
      const misleadingPhrase = b.concept!.toLowerCase(); // e.g. "insulin therapy"
      const g = gateFor(query, b.concept!, misleadingPhrase);
      expect(
        g.allows,
        `${query} w/ misleading phrase "${misleadingPhrase}" -> ${JSON.stringify(g)}`,
      ).toBe(false);
      expect(g.veto).toBe("overlap");
    }
  });

  it("negated in-scope queries still reach the right shard", () => {
    for (const { query, concept, phrase } of NEGATED_IN_SCOPE) {
      const g = gateFor(query, concept, phrase);
      expect(g.allows, `${query} -> ${JSON.stringify(g)}`).toBe(true);
    }
  });

  it("separation margins are enforced", () => {
    // Distance: every in-scope query (with its realistic agent phrase) clears
    // the threshold with margin.
    const inScopeMax = Math.max(
      ...[...IN_SCOPE, ...NEGATED_IN_SCOPE].map(({ query, concept, phrase }) => gateFor(query, concept, phrase).distance),
    );
    expect(inScopeMax).toBeLessThan(SILENCE_THRESHOLD);
    // Lexical separation: no unrelated query may reach MIN_SHARED_TOKENS
    // against ANY shard, however close its fingerprint accidentally lands.
    for (const query of UNRELATED) {
      for (const shard of vault) {
        expect(
          sharedTokenCount(query, shard.searchText),
          `${query} vs ${shard.concept}`,
        ).toBeLessThan(MIN_SHARED_TOKENS);
      }
    }
    // And every in-scope query clears the overlap bar against its shard on
    // the RAW query alone (agent phrases are not credited for overlap).
    const inScopeMinShared = Math.min(
      ...[...IN_SCOPE, ...NEGATED_IN_SCOPE].map(({ query, concept }) =>
        sharedTokenCount(query, shardByConcept(concept).searchText),
      ),
    );
    expect(inScopeMinShared).toBeGreaterThanOrEqual(MIN_SHARED_TOKENS);
  });

  it("tokenize keeps negation terms out of the overlap blind spot", () => {
    // Guard the calibration's premise: negations are content tokens.
    expect(tokenize("should I not give aspirin")).toContain("not");
  });
});
