import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import { sql, inArray } from "drizzle-orm";
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { SEED_SHARDS, seedVault, seedFingerprint, seedSearchText } from "./seed";

// Seeding tests run against a scratch table with the same shape as `shards`
// (including its unique constraint, which ON CONFLICT relies on). The real
// shards table is never touched — tests must not be able to erase or re-id
// live vault data, whatever database DATABASE_URL points at.

const scratch = pgTable("seed_test_scratch", {
  id: serial("id").primaryKey(),
  concept: text("concept").notNull().unique(),
  source: text("source").notNull(),
  text: text("text").notNull(),
  searchText: text("search_text").notNull().default(""),
  fingerprint: text("fingerprint").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

const scratchTable = scratch as unknown as Parameters<typeof seedVault>[1];

const noop = () => {};
const seed = () => seedVault(db, scratchTable, SEED_SHARDS, noop);

async function rows() {
  return db.select().from(scratch).orderBy(scratch.id);
}

async function rowCount(): Promise<number> {
  return (await db.select({ id: scratch.id }).from(scratch)).length;
}

describe("seedVault", () => {
  beforeAll(async () => {
    // INCLUDING ALL copies the unique constraint on concept (required for
    // ON CONFLICT) and the NOT NULL defaults.
    await db.execute(
      sql`CREATE TABLE IF NOT EXISTS seed_test_scratch (LIKE shards INCLUDING ALL)`,
    );
    await db.execute(sql`TRUNCATE seed_test_scratch`);
  });

  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS seed_test_scratch`);
  });

  it("seeds the full corpus with correct retrieval fields", async () => {
    await seed();
    expect(await rowCount()).toBe(SEED_SHARDS.length);
    const all = await rows();
    for (const s of SEED_SHARDS) {
      const row = all.find((r) => r.concept === s.concept);
      expect(row, s.concept).toBeDefined();
      expect(row!.fingerprint).toBe(seedFingerprint(s));
      expect(row!.searchText).toBe(seedSearchText(s));
      expect(row!.text).toBe(s.text);
    }
  });

  it("is idempotent: a second call changes nothing, ids included", async () => {
    await seed();
    const before = await rows();
    await seed();
    expect(await rows()).toEqual(before);
  });

  it("recovers from partial seeding (missing rows are restored)", async () => {
    await seed();
    // Simulate a crashed earlier seed: two shards never made it.
    const victims = SEED_SHARDS.slice(0, 2).map((s) => s.concept);
    await db.delete(scratch).where(inArray(scratch.concept, victims));
    expect(await rowCount()).toBe(SEED_SHARDS.length - 2);
    await seed();
    expect(await rowCount()).toBe(SEED_SHARDS.length);
    const all = await rows();
    for (const concept of victims) {
      expect(all.find((r) => r.concept === concept), concept).toBeDefined();
    }
  });

  it("refreshes stale retrieval fields left by an older tokenizer, keeping the row id", async () => {
    await seed();
    const concept = SEED_SHARDS[0].concept;
    const [before] = await db
      .select()
      .from(scratch)
      .where(sql`concept = ${concept}`);
    await db.execute(
      sql`UPDATE seed_test_scratch SET fingerprint = ${"0".repeat(32)}, search_text = '' WHERE concept = ${concept}`,
    );
    await seed();
    const [after] = await db
      .select()
      .from(scratch)
      .where(sql`concept = ${concept}`);
    expect(after.id).toBe(before.id);
    expect(after.fingerprint).toBe(seedFingerprint(SEED_SHARDS[0]));
    expect(after.searchText).toBe(seedSearchText(SEED_SHARDS[0]));
    // Verified text is never clobbered.
    expect(after.text).toBe(SEED_SHARDS[0].text);
  });

  it("survives concurrent first-request seeding", async () => {
    await db.execute(sql`TRUNCATE seed_test_scratch`);
    await expect(
      Promise.all([seed(), seed(), seed(), seed(), seed()]),
    ).resolves.toBeDefined();
    // Exactly one row per concept — no duplicate-key 500s, no doubles.
    expect(await rowCount()).toBe(SEED_SHARDS.length);
    const concepts = (await rows()).map((r) => r.concept);
    expect(new Set(concepts).size).toBe(SEED_SHARDS.length);
  });
});
