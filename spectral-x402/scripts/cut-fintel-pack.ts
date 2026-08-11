/**
 * cut-fintel-pack.ts — cut a sealed pack from the financial-intel paper
 * arena's own output: closed trades, per-strategy performance, and the
 * portfolio snapshot. Hermes-Spectral Mission 1: the loop's own record,
 * sold by content address.
 *
 * Deterministic by construction: every tile derives purely from the input
 * records, and the snapshot timestamps come from the data (max closedAt),
 * never the wall clock — the same inputs rebuild byte-identical packs.
 *
 * Emits <outDir>/<edition>.{idx,dat,manifest.json,seal.json}, signing with
 * the trust store already in <outDir> (content-provenance key, not a wallet).
 *
 * Usage: node dist-gate/scripts/cut-fintel-pack.js \
 *          [outDir] [edition] [tradesJsonl] [portfolioJson]
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { sign as edSign } from "node:crypto";
import { canonicalize, cidOf, merkleRoot } from "../src/substrate.js";

interface Trade {
  id: string;
  arena: string;
  market: string;
  question: string;
  side: string;
  strategy: string;
  entryPrice: number;
  exitPrice: number | null;
  size: number;
  pnl: number | null;
  openedAt: string;
  closedAt: string;
  reason: string;
}

/** An expired trade with no exit print has no exit price and no pnl — null stays null. */
function decOrNull(n: number | null): string | null {
  return n === null ? null : dec(n);
}

/** Non-integer reals travel as decimal strings; canonicalize refuses floats. */
function dec(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`non-finite number: ${n}`);
  if (Object.is(n, -0) || n === 0) return "0";
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

const outDir = process.argv[2] ?? "./packs";
const edition = process.argv[3] ?? "fintel-paper-arena-2026-08";
const tradesPath =
  process.argv[4] ??
  "/Users/joewales/NODE_OUT_Master/financial-intel-mcp/src/paper/output/trades.jsonl";
const portfolioPath =
  process.argv[5] ??
  "/Users/joewales/NODE_OUT_Master/financial-intel-mcp/src/paper/output/portfolio.json";

const trades: Trade[] = readFileSync(tradesPath, "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as Trade);
if (trades.length === 0) throw new Error("no closed trades — nothing to cut");

const portfolio = JSON.parse(readFileSync(portfolioPath, "utf8")) as {
  cash: number | null;
  startingCash: number;
  positions: unknown[];
};

const cutAt = trades.map((t) => t.closedAt).sort().at(-1)!;
const windowFrom = trades.map((t) => t.openedAt).sort()[0];
const domain = "fintel-paper-arena";

function tradeTile(t: Trade): Record<string, unknown> {
  return {
    schema: "fintel-arena-trade-v1",
    canon_version: 1,
    domain,
    trade: {
      id: t.id,
      arena: t.arena,
      market: t.market,
      question: t.question,
      side: t.side,
      strategy: t.strategy,
      entry_price: dec(t.entryPrice),
      exit_price: decOrNull(t.exitPrice),
      size: dec(t.size),
      pnl: decOrNull(t.pnl),
      opened_at: t.openedAt,
      closed_at: t.closedAt,
      reason: t.reason,
    },
    provenance: { source: "paper-arena/trades.jsonl", cut_at: cutAt },
  };
}

function strategyTile(strategy: string, ts: Trade[]): Record<string, unknown> {
  const pnls = ts.map((t) => t.pnl).filter((p): p is number => p !== null);
  return {
    schema: "fintel-arena-strategy-v1",
    canon_version: 1,
    domain,
    strategy,
    window: { from: windowFrom, to: cutAt },
    trades: ts.length,
    wins: pnls.filter((p) => p > 0).length,
    losses: pnls.filter((p) => p < 0).length,
    flat: pnls.filter((p) => p === 0).length,
    unresolved: ts.length - pnls.length,
    pnl_total: dec(pnls.reduce((a, b) => a + b, 0)),
    arenas: [...new Set(ts.map((t) => t.arena))].sort(),
    provenance: { source: "paper-arena/trades.jsonl", cut_at: cutAt },
  };
}

const snapshotTile: Record<string, unknown> = {
  schema: "fintel-arena-snapshot-v1",
  canon_version: 1,
  domain,
  cash: decOrNull(portfolio.cash),
  starting_cash: dec(portfolio.startingCash),
  open_positions: portfolio.positions.length,
  closed_trades: trades.length,
  window: { from: windowFrom, to: cutAt },
  provenance: { source: "paper-arena/portfolio.json", cut_at: cutAt },
};

const strategies = [...new Set(trades.map((t) => t.strategy))].sort();
const bodies: Array<Record<string, unknown>> = [
  ...trades.map(tradeTile),
  ...strategies.map((s) => strategyTile(s, trades.filter((t) => t.strategy === s))),
  snapshotTile,
];

const tiles = bodies.map((body) => {
  const bytes = canonicalize(body);
  return { cid: cidOf(body), bytes };
});
tiles.sort((a, b) => (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));

const REC = 44;
const idx = Buffer.alloc(4 + tiles.length * REC);
idx.writeUInt32LE(tiles.length, 0);
const datParts: Buffer[] = [];
let offset = 0;
tiles.forEach((t, i) => {
  Buffer.from(t.cid.slice(7), "hex").copy(idx, 4 + i * REC);
  idx.writeBigUInt64LE(BigInt(offset), 4 + i * REC + 32);
  idx.writeUInt32LE(t.bytes.length, 4 + i * REC + 40);
  datParts.push(t.bytes);
  offset += t.bytes.length;
});
const dat = Buffer.concat(datParts);
const root = merkleRoot(tiles.map((t) => Buffer.from(t.cid.slice(7), "hex")));

const manifestBody = {
  schema: "terrain-pack-v1",
  canon_version: 1,
  pack_exclusions: ["/seal"],
  domain,
  edition,
  snapshot: { cut_at: cutAt, window_from: windowFrom, window_to: cutAt },
  prev_pack_cid: null,
  tiles: tiles.map((t) => t.cid),
  tile_count: tiles.length,
  merkle_root: root.toString("hex"),
  geometry: {
    profile: "record-stream",
    embed_model: null,
    dim_per_third: null,
    concat_dim: null,
    norm_convention: null,
    shatter_scale: null,
  },
  centroid: null,
  silence: { gate: "exact-match", signal: "content-address" },
  confidence_model: null,
  knn: null,
  license_summary: { spdx_counts: { "CC-BY-4.0": tiles.length }, derivative_release: "records-as-published" },
  redaction_totals: { source_text_withheld: 0 },
  payload_content_type: "application/json",
  status_list_ref: "fintel-paper-arena-status",
  carrier_note:
    "Paper-arena trading record: closed trades, per-strategy performance, portfolio snapshot. " +
    "First-party output of the financial-intel loop; no third-party source text.",
};

const signerIdPath = path.join(outDir, ".signer-id");
const signerId = existsSync(signerIdPath)
  ? readFileSync(signerIdPath, "utf8").trim()
  : "nodeout-terrain-2026a";
const privateKeyPem = readFileSync(path.join(outDir, ".signing-key.pem"), "utf8");

const manifestCid = cidOf(manifestBody);
const message = Buffer.concat([
  Buffer.from("terrain-seal-v1", "utf8"),
  Buffer.from([0]),
  Buffer.from(manifestCid.slice(7), "hex"),
]);
const sig = edSign(null, message, privateKeyPem);

const base = path.join(outDir, edition);
writeFileSync(base + ".idx", idx);
writeFileSync(base + ".dat", dat);
writeFileSync(base + ".manifest.json", JSON.stringify(manifestBody, null, 2) + "\n");
writeFileSync(
  base + ".seal.json",
  JSON.stringify(
    {
      seal_schema: "terrain-seal-v1",
      cid: manifestCid,
      canon_version: 1,
      signer: signerId,
      sig: sig.toString("base64"),
      signed_at: cutAt,
      sig_scope: "pack",
    },
    null,
    2
  ) + "\n"
);

console.log(`Sealed ${edition}`);
console.log(`  tiles       ${tiles.length} (${trades.length} trades, ${strategies.length} strategies, 1 snapshot)`);
console.log(`  dat         ${(dat.length / 1024).toFixed(1)} KB`);
console.log(`  merkle_root ${root.toString("hex").slice(0, 32)}…`);
console.log(`  manifest    ${manifestCid}`);
console.log(`  signer      ${signerId}`);
tiles.slice(0, 3).forEach((t) => console.log(`  ${t.cid}`));
