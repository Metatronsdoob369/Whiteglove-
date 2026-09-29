import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const shardsTable = pgTable("shards", {
  id: serial("id").primaryKey(),
  concept: text("concept").notNull().unique(),
  source: text("source").notNull(),
  text: text("text").notNull(),
  // Canonical retrieval text: concept + synopsis. The fingerprint is derived
  // from this, and the silence gate tokenizes it for the lexical-overlap
  // check — the two must never be computed from different inputs.
  searchText: text("search_text").notNull().default(""),
  // SimHash-128 fingerprint stored as 32-char hex string (two 64-bit halves)
  fingerprint: text("fingerprint").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertShardSchema = createInsertSchema(shardsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertShard = z.infer<typeof insertShardSchema>;
export type Shard = typeof shardsTable.$inferSelect;

export const decisionLogsTable = pgTable("decision_logs", {
  id: serial("id").primaryKey(),
  query: text("query").notNull(),
  fingerprint: text("fingerprint").notNull(),
  bestDistance: text("best_distance"), // normalized hamming, null when vault empty
  threshold: text("threshold").notNull(),
  verdict: text("verdict").notNull(), // "answered" | "silenced" | "error"
  concept: text("concept"),
  toolCalls: text("tool_calls"), // JSON array of tool call names in order
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertDecisionLogSchema = createInsertSchema(decisionLogsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertDecisionLog = z.infer<typeof insertDecisionLogSchema>;
export type DecisionLog = typeof decisionLogsTable.$inferSelect;
