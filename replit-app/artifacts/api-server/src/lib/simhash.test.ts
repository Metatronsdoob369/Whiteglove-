import { describe, it, expect } from "vitest";
import {
  simhash128,
  tokenize,
  hammingDistance,
  normalizedHamming,
  NEGATION_TERMS,
} from "./simhash";

describe("tokenize", () => {
  it("preserves negation words — they are content, not stopwords", () => {
    const tokens = tokenize("should I not give aspirin, never give it, avoid contraindicated drugs, no exceptions");
    for (const neg of ["not", "never", "avoid", "contraindicated", "no"]) {
      expect(tokens).toContain(neg);
    }
    expect(NEGATION_TERMS).toContain("not");
    expect(NEGATION_TERMS).toContain("never");
    expect(NEGATION_TERMS).toContain("no");
    expect(NEGATION_TERMS).toContain("avoid");
    expect(NEGATION_TERMS).toContain("contraindicated");
  });

  it("drops stopwords but keeps content words and bigrams", () => {
    const tokens = tokenize("what is the blood sugar");
    expect(tokens).not.toContain("what");
    expect(tokens).not.toContain("the");
    expect(tokens).toContain("blood");
    expect(tokens).toContain("sugar");
    expect(tokens).toContain("blood_sugar");
  });
});

describe("simhash128 negation safety", () => {
  it("a negated statement fingerprints differently from the affirmative", () => {
    const affirmative = simhash128("should give aspirin for stroke");
    const negated = simhash128("should not give aspirin for stroke");
    expect(negated).not.toBe(affirmative);
    // The difference must be meaningful, not a single flipped bit.
    expect(hammingDistance(negated, affirmative)).toBeGreaterThanOrEqual(8);
  });

  it("negation moves the fingerprint away from the affirmative topical match", () => {
    // Two queries identical except polarity must not be interchangeable.
    const a = simhash128("aspirin is safe during stroke");
    const b = simhash128("aspirin is never safe during stroke");
    expect(normalizedHamming(a, b)).toBeGreaterThan(0.05);
  });

  it("is deterministic and 128-bit", () => {
    const fp = simhash128("diabetic ketoacidosis signs");
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
    expect(simhash128("diabetic ketoacidosis signs")).toBe(fp);
  });
});
