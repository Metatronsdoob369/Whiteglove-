/**
 * Corpus invariant checker — run before trusting any eval numbers.
 *
 *  HARD failures (exit 1):
 *   - malformed JSONL / duplicate ids / missing class fields (via loadQueries)
 *   - fewer than 50 queries in any class
 *   - grounded expectedEvidence ID with no matching shard file (the silent
 *     scoring-breakage the Fable checklist Task 5 warned about)
 *   - ungrounded mustBeAbsent term found in the shard corpus (false premise
 *     would make "silence" the wrong expected answer)
 *
 *  SOFT warnings:
 *   - grounded query sharing fewer than 3 word tokens with its evidence
 *     (evidence exists but the query may not lexically reach it)
 *
 * Usage: SHARD_DIR=... npx tsx src/check-corpus.ts corpus/queries.jsonl
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import * as path from "node:path";
import { loadQueries } from "./corpus.js";

const queriesPath = process.argv[2] ?? "corpus/queries.jsonl";
const SHARD_DIR = process.env.SHARD_DIR ?? "";
if (!SHARD_DIR || !existsSync(SHARD_DIR)) {
  console.error(`SHARD_DIR missing or not found: "${SHARD_DIR}"`);
  process.exit(1);
}

const queries = loadQueries(queriesPath) as Array<{
  id: string;
  text: string;
  class: string;
  expectedEvidence?: string[];
  mustBeAbsent?: string[];
}>;

let hardFailures = 0;

// ── ids unique, class counts ─────────────────────────────────────────
const ids = new Set<string>();
for (const q of queries) {
  if (ids.has(q.id)) {
    console.error(`✗ duplicate id: ${q.id}`);
    hardFailures++;
  }
  ids.add(q.id);
}
const counts: Record<string, number> = {};
for (const q of queries) counts[q.class] = (counts[q.class] ?? 0) + 1;
console.log(`Classes: ${JSON.stringify(counts)} (total ${queries.length})`);
for (const cls of ["grounded", "ungrounded", "adversarial"]) {
  if ((counts[cls] ?? 0) < 50) {
    console.error(`✗ class "${cls}" has ${counts[cls] ?? 0} queries — need ≥50`);
    hardFailures++;
  }
}

// ── load shard corpus once ───────────────────────────────────────────
const shardFiles = readdirSync(SHARD_DIR).filter((f) => f.endsWith(".json"));
const shardIds = new Set(shardFiles.map((f) => f.replace(/\.json$/, "")));
const corpusText = shardFiles
  .map((f) => readFileSync(path.join(SHARD_DIR, f), "utf-8").toLowerCase())
  .join("\n");
const shardContent = new Map<string, string>();
for (const f of shardFiles) {
  const d = JSON.parse(readFileSync(path.join(SHARD_DIR, f), "utf-8"));
  shardContent.set(d.id, String(d.content).toLowerCase());
}

// ── grounded: evidence exists + lexical reachability ─────────────────
const tokenize = (s: string) =>
  new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2));
let weakOverlap = 0;
for (const q of queries.filter((q) => q.class === "grounded")) {
  for (const ev of q.expectedEvidence ?? []) {
    if (!shardIds.has(ev)) {
      console.error(`✗ ${q.id}: expectedEvidence "${ev}" has no shard file`);
      hardFailures++;
    }
  }
  const qTokens = tokenize(q.text);
  const best = Math.max(
    ...(q.expectedEvidence ?? []).map((ev) => {
      const content = shardContent.get(ev);
      if (!content) return 0;
      const cTokens = tokenize(content);
      return [...qTokens].filter((t) => cTokens.has(t)).length;
    })
  );
  if (best < 3) {
    console.warn(`⚠ ${q.id}: only ${best} shared tokens with its best evidence shard`);
    weakOverlap++;
  }
}

// ── ungrounded: absent-term premise holds ────────────────────────────
// Word-boundary match, not substring — "bert" must not trip on
// "aethelbert", nor "systemd" on "buildSystemDirective".
const termAbsent = (term: string): boolean => {
  const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return !new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(corpusText);
};
for (const q of queries.filter((q) => q.class === "ungrounded")) {
  for (const term of q.mustBeAbsent ?? []) {
    if (!termAbsent(term)) {
      console.error(`✗ ${q.id}: mustBeAbsent term "${term}" FOUND in corpus — premise broken`);
      hardFailures++;
    }
  }
  if (!q.mustBeAbsent?.length) {
    console.warn(`⚠ ${q.id}: ungrounded without mustBeAbsent terms (unverifiable premise)`);
  }
}

console.log(
  hardFailures === 0
    ? `\nCorpus OK — ${queries.length} queries, 0 hard failures, ${weakOverlap} weak-overlap warnings.`
    : `\n${hardFailures} HARD failure(s).`
);
process.exit(hardFailures === 0 ? 0 : 1);
