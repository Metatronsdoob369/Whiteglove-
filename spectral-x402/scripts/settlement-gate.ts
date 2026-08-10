/**
 * settlement-gate.ts — the real-settlement gate.
 *
 * Proves, against the LIVE service on loopback and the LIVE Base Sepolia chain,
 * five properties that no local simulation can establish:
 *
 *   1. GENUINE SETTLEMENT      a paid call produces a receipt whose transaction
 *                              exists on chain, succeeded, and moved exactly the
 *                              manifest's price in USDC from the payer to the
 *                              mount's payTo.
 *   2. RECEIPT FIELD MATCH     every field of that receipt agrees with the
 *                              payment we signed AND with the chain evidence.
 *   3. REPLAY WITHOUT RESETTLE  the same paymentId, unpaid, returns the same
 *                              bytes and moves no further money.
 *   4. FAILED EXECUTION NEVER SETTLES  a real payment for a tile that does not
 *                              exist is refused and never settles.
 *   5. RESTART PRESERVES ENTITLEMENT  the same replay holds across a service
 *                              restart (two-phase; the operator restarts
 *                              between them).
 *
 * WHAT THIS PROCESS HOLDS. The payer's private key, for the lifetime of one
 * signature, sourced from the macOS Keychain. It is never printed, never
 * logged, never written to the evidence report, and never placed in any
 * X402_*-named variable — the seller sweeps those at boot and refuses to start
 * if one is key-shaped, and that guard must stay meaningful. The evidence
 * report records the payer's ADDRESS, which is public and appears on chain
 * anyway.
 *
 * TESTNET ONLY. The run refuses to sign anything unless the challenge's own
 * network is eip155:84532.
 *
 * The requirements this client signs are produced by the SAME
 * `toStandardRequirements` the server's facilitator boundary uses. That is
 * deliberate: a second translation here would let the harness prove a payment
 * the server never asked for.
 *
 *   npm run gate:settlement
 *   npm run gate:settlement -- --phase2            # after a service restart
 *   npm run gate:settlement -- --phase2 <paymentId>
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { x402Client } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements as StandardPaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme, getDefaultAsset } from "@x402/evm";
import { toStandardRequirements } from "../src/x402-wire.js";
import type { PaymentRequirements } from "../src/facilitator.js";

// ── constants ────────────────────────────────────────────────────────────────

const PKG_DIR = path.resolve(__dirname, "../..");
const EVIDENCE_DIR = path.join(PKG_DIR, "evidence");
const LEDGER_PATH = path.join(PKG_DIR, "ledger.db");
/**
 * The file the SERVICE reads its configuration from. Overridable only so the
 * preflight can be dry-run against a candidate file before it is installed;
 * pointing it elsewhere proves nothing about the running process, which is why
 * every later proof reads the LIVE service and the LIVE chain instead.
 */
const ENV_LOCAL = process.env.X402_GATE_ENV_FILE ?? path.join(PKG_DIR, ".env.local");

/** Base Sepolia and nothing else. A gate that could run on mainnet is not a gate. */
const REQUIRED_NETWORK = "eip155:84532";
const REQUIRED_CHAIN_ID = 84532;

const BASE_URL = process.env.X402_GATE_BASE_URL ?? "http://localhost:8787";
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
const KEYCHAIN_SERVICE = "x402-payer-key";

/** A cid that is well-formed (so it clears the arg schema) and cannot exist. */
const ABSENT_CID = `b2-256:${"f".repeat(64)}`;

/**
 * Just enough ERC-20 to read a balance and decode a Transfer. Written out rather
 * than parsed from signatures so this constant needs nothing at module load —
 * viem 2.x is ESM-only and this package is CommonJS, so every viem symbol is
 * reached through a dynamic import below.
 */
const ERC20 = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// ── failure modes ────────────────────────────────────────────────────────────

/** Something an OPERATOR must provide. Names the one missing input, and nothing else. */
class ProvisioningMissing extends Error {
  constructor(what: string, fix: string) {
    super(`PROVISIONING MISSING — ${what}\n\n  ${fix}`);
    this.name = "ProvisioningMissing";
  }
}

/** A property that was supposed to hold and did not. This is a gate failure. */
class ProofFailed extends Error {
  constructor(proof: string, detail: string) {
    super(`PROOF FAILED — ${proof}\n\n  ${detail}`);
    this.name = "ProofFailed";
  }
}

// ── tiny helpers ─────────────────────────────────────────────────────────────

const log = (s: string) => process.stdout.write(`${s}\n`);
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
/** Case-insensitive hex compare — addresses arrive EIP-55-checksummed from some sources and lowercase from others. */
const sameHex = (a: string | null | undefined, b: string | null | undefined): boolean =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/** A facilitator URL, safe to log: some deployments carry a key in the query string. */
const redactUrl = (u: string): string => {
  try {
    const parsed = new URL(u);
    return parsed.search ? `${parsed.origin}${parsed.pathname}?<redacted>` : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<unparseable facilitator url>";
  }
};

let seq = 0;
const freshPaymentId = () => `gate-${Date.now()}-${String(seq++).padStart(4, "0")}`;

/** .env.local, parsed for INSPECTION only. This process never writes that file. */
function readEnvLocal(): Record<string, string> {
  if (!existsSync(ENV_LOCAL)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(ENV_LOCAL, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = val;
  }
  return out;
}

/**
 * The payer's key. Keychain first; `PAYER_PRIVATE_KEY` in this process's own
 * environment as the fallback for a one-shot run.
 *
 * Deliberately NOT named X402_*: the seller refuses to boot when any X402_*
 * variable is key-shaped, and a harness that borrowed that namespace would
 * teach an operator to export the one thing that must never be exported into
 * the server's environment.
 *
 * The return value is never logged and never leaves this process.
 */
function loadPayerKey(): `0x${string}` {
  let raw: string | undefined;
  try {
    raw = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    raw = process.env.PAYER_PRIVATE_KEY?.trim();
  }
  if (!raw) {
    throw new ProvisioningMissing(
      `no payer key: Keychain has no generic password for service "${KEYCHAIN_SERVICE}", and PAYER_PRIVATE_KEY is unset`,
      `Add it yourself (type the key — do not let it into shell history):\n` +
        `    security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w\n` +
        `  It must be a THROWAWAY Base Sepolia wallet holding only test funds.`
    );
  }
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    // Never echo the value, not even a prefix.
    throw new ProvisioningMissing(
      "the payer key is not a 32-byte hex private key",
      `Re-add it: security add-generic-password -U -a "$USER" -s ${KEYCHAIN_SERVICE} -w`
    );
  }
  return key;
}

// ── the live service ─────────────────────────────────────────────────────────

interface Challenge {
  requirements: PaymentRequirements;
  standard: StandardPaymentRequirements;
  challengeEpoch: string | null;
  error: string;
}

/** The unpaid request whose 402 tells us the terms. */
async function fetchChallenge(resource: string): Promise<Challenge> {
  const res = await fetch(`${BASE_URL}${resource}`);
  if (res.status !== 402) {
    throw new ProofFailed(
      "challenge",
      `GET ${resource} without payment returned ${res.status}, not 402. Body: ${(await res.text()).slice(0, 200)}`
    );
  }
  const body = (await res.json()) as { error: string; accepts: PaymentRequirements[] };
  const requirements = body.accepts?.[0];
  if (!requirements) throw new ProofFailed("challenge", "the 402 carried no `accepts` entry");

  // TESTNET GATE. Before a key is touched, before anything is signed.
  if (requirements.network !== REQUIRED_NETWORK) {
    throw new ProvisioningMissing(
      `the challenge declares network "${requirements.network}", not Base Sepolia (${REQUIRED_NETWORK})`,
      `This harness signs real payments and will not run outside Base Sepolia. Refusing.`
    );
  }
  return {
    requirements,
    // The SAME translation the server's facilitator boundary performs, so what
    // we sign is what it will present for settlement.
    standard: toStandardRequirements(requirements),
    challengeEpoch: res.headers.get("x-challenge-epoch"),
    error: body.error,
  };
}

interface PaidResponse {
  status: number;
  bytes: Buffer;
  receipt?: Receipt;
  replayed: string | null;
  callId: string | null;
  body?: { code?: string };
}

interface Receipt {
  transaction: string | null;
  network: string;
  payer: string | null;
  payTo: string;
  asset: string;
  amountAtomic: string;
}

async function call(resource: string, paymentId: string, paymentHeader?: string): Promise<PaidResponse> {
  const res = await fetch(`${BASE_URL}${resource}`, {
    headers: {
      "x-payment-id": paymentId,
      ...(paymentHeader ? { "x-payment": paymentHeader } : {}),
    },
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  const rawReceipt = res.headers.get("x-payment-response");
  const out: PaidResponse = {
    status: res.status,
    bytes,
    replayed: res.headers.get("x-replayed"),
    callId: res.headers.get("x-call-id"),
    ...(rawReceipt ? { receipt: JSON.parse(Buffer.from(rawReceipt, "base64").toString("utf8")) as Receipt } : {}),
  };
  if ((res.headers.get("content-type") ?? "").includes("application/json") && !rawReceipt) {
    try {
      out.body = JSON.parse(bytes.toString("utf8")) as { code?: string };
    } catch {
      /* not JSON after all */
    }
  }
  return out;
}

// ── the payment ──────────────────────────────────────────────────────────────

/**
 * A REAL exact-scheme payment: the SDK's own client, the SDK's own EVM scheme,
 * a viem local account. Nothing about the signature is hand-rolled here — the
 * point of the gate is that a conforming client's payment settles.
 */
type LocalAccount = Awaited<ReturnType<typeof loadPayerAccount>>;

/**
 * The payer, as a viem local account. The key is read here and handed straight
 * to viem; it is never returned, stored, or logged — only the account object,
 * whose public face is the address.
 */
async function loadPayerAccount() {
  const { privateKeyToAccount } = await import("viem/accounts");
  return privateKeyToAccount(loadPayerKey());
}

async function buildPayment(challenge: Challenge, account: LocalAccount): Promise<string> {
  const client = x402Client.fromConfig({
    schemes: [{ network: challenge.standard.network, client: new ExactEvmScheme(account) }],
  });
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    error: challenge.error,
    resource: { url: challenge.requirements.resource, description: challenge.requirements.description },
    accepts: [challenge.standard],
  };
  const envelope = await client.createPaymentPayload(paymentRequired);
  // The seller's edge reads X-Payment as base64 JSON. Encoded here rather than
  // through a header helper so there is no question which base64 alphabet.
  return Buffer.from(JSON.stringify(envelope)).toString("base64");
}

// ── the chain ────────────────────────────────────────────────────────────────

/**
 * viem 2.x publishes ESM only and this package is CommonJS, so viem is reached
 * through a dynamic import — the one Node supports in both directions — rather
 * than by making the whole package a module.
 */
async function openChain() {
  const viem = await import("viem");
  const { baseSepolia } = await import("viem/chains");
  return {
    viem,
    client: viem.createPublicClient({ chain: baseSepolia, transport: viem.http(RPC_URL) }),
  };
}
type Chain = Awaited<ReturnType<typeof openChain>>;

/** Set once by `main`, before any proof runs. */
let chain: Chain;

interface TransferEvidence {
  txHash: string;
  blockNumber: string;
  status: string;
  from: string;
  to: string;
  value: string;
  token: string;
}

/** The USDC Transfer inside a settlement transaction, or a refusal saying why not. */
async function transferEvidenceFor(txHash: `0x${string}`, token: string): Promise<TransferEvidence> {
  const receipt = await chain.client.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new ProofFailed("1 GENUINE SETTLEMENT", `transaction ${txHash} has chain status "${receipt.status}"`);
  }
  for (const l of receipt.logs) {
    if (!sameHex(l.address, token)) continue;
    if (l.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const decoded = chain.viem.decodeEventLog({ abi: ERC20, topics: l.topics, data: l.data }) as unknown as {
      eventName: string;
      args: { from: string; to: string; value: bigint };
    };
    if (decoded.eventName !== "Transfer") continue;
    return {
      txHash,
      blockNumber: receipt.blockNumber.toString(),
      status: receipt.status,
      from: chain.viem.getAddress(decoded.args.from),
      to: chain.viem.getAddress(decoded.args.to),
      value: decoded.args.value.toString(),
      token: chain.viem.getAddress(l.address),
    };
  }
  throw new ProofFailed(
    "1 GENUINE SETTLEMENT",
    `transaction ${txHash} succeeded but carries no ${token} Transfer log — that is not a USDC settlement`
  );
}

/**
 * Every USDC transfer from the payer to payTo since `fromBlock`.
 *
 * This is how "no second settlement" is established as a fact about the CHAIN
 * rather than about our own ledger: if a replay had settled again, a second
 * transfer would be here.
 */
async function transfersFromPayer(
  token: string,
  payer: string,
  payTo: string,
  fromBlock: bigint
): Promise<string[]> {
  const logs = await chain.client.getLogs({
    address: chain.viem.getAddress(token),
    event: ERC20[0],
    args: { from: chain.viem.getAddress(payer), to: chain.viem.getAddress(payTo) },
    fromBlock,
    toBlock: "latest",
  });
  return logs.flatMap((l) => (l.transactionHash ? [String(l.transactionHash)] : []));
}

async function usdcBalance(token: string, owner: string): Promise<bigint> {
  return (await chain.client.readContract({
    address: chain.viem.getAddress(token),
    abi: ERC20,
    functionName: "balanceOf",
    args: [chain.viem.getAddress(owner)],
  })) as bigint;
}

// ── the ledger (read-only) ───────────────────────────────────────────────────

interface LedgerFacts {
  callId: string | null;
  state: string | null;
  settlementAttempts: number;
  receipts: number;
  txns: string[];
}

/**
 * What the live ledger says about one paymentId. Opened READ-ONLY: the running
 * service owns this database, and WAL admits a concurrent reader.
 */
function ledgerFacts(paymentId: string): LedgerFacts {
  const db = new Database(LEDGER_PATH, { readonly: true, fileMustExist: true });
  try {
    const call = db.prepare("SELECT call_id, state FROM calls WHERE payment_id=?").get(paymentId) as
      | { call_id: string; state: string }
      | undefined;
    if (!call) return { callId: null, state: null, settlementAttempts: 0, receipts: 0, txns: [] };
    const attempts = (
      db.prepare("SELECT COUNT(*) c FROM settlement_attempts WHERE call_id=?").get(call.call_id) as { c: number }
    ).c;
    const receipts = db.prepare("SELECT txn FROM receipts WHERE call_id=? AND success=1").all(call.call_id) as Array<{
      txn: string | null;
    }>;
    return {
      callId: call.call_id,
      state: call.state,
      settlementAttempts: attempts,
      receipts: receipts.length,
      txns: receipts.map((r) => r.txn).filter((t): t is string => typeof t === "string"),
    };
  } finally {
    db.close();
  }
}

// ── evidence ─────────────────────────────────────────────────────────────────

interface ProofRecord {
  id: string;
  title: string;
  passed: boolean;
  facts: Record<string, unknown>;
}

interface Phase1State {
  version: 1;
  recordedAt: string;
  paymentId: string;
  resource: string;
  bodySha256: string;
  bodyLength: number;
  transaction: string;
  blockNumber: string;
  payerAddress: string;
  payTo: string;
  amountAtomic: string;
  network: string;
  token: string;
}

const STATE_PATH = path.join(EVIDENCE_DIR, "settlement-gate-phase1.json");

/**
 * What has been established so far, and against what.
 *
 * Module-level because a FAILING gate is exactly when the report matters, and
 * the top-level handler has to be able to write one from wherever the failure
 * happened. This is a single-run CLI; there is one gate per process.
 */
const collected: ProofRecord[] = [];
let evidenceContext: Record<string, unknown> = {};

function writeEvidence(phase: string, proofs: ProofRecord[], context: Record<string, unknown>): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(EVIDENCE_DIR, `settlement-gate-${stamp}`);
  const payload = {
    gate: "spectral-x402 real settlement",
    phase,
    recordedAt: new Date().toISOString(),
    // Public inputs only. No key, no key fingerprint, no key prefix.
    context,
    proofs,
    verdict: proofs.every((p) => p.passed) ? "PASS" : "FAIL",
  };
  writeFileSync(`${base}.json`, `${JSON.stringify(payload, null, 2)}\n`);

  const md: string[] = [
    `# spectral-x402 settlement gate — ${phase}`,
    "",
    `- recorded: ${payload.recordedAt}`,
    `- verdict: **${payload.verdict}**`,
    "",
    "## Context",
    "",
    ...Object.entries(context).map(([k, v]) => `- ${k}: \`${String(v)}\``),
    "",
    "## Proofs",
    "",
  ];
  for (const p of proofs) {
    md.push(`### ${p.id} — ${p.title}`, "", `${p.passed ? "PASS" : "FAIL"}`, "");
    for (const [k, v] of Object.entries(p.facts)) md.push(`- ${k}: \`${String(v)}\``);
    md.push("");
  }
  md.push(
    "## Secrets",
    "",
    "The payer's private key was held in process memory for the duration of one signature —",
    "read from the macOS Keychain (or, for a one-shot run, PAYER_PRIVATE_KEY) — and appears",
    "nowhere in this report. The payer ADDRESS recorded above is public and is on chain",
    "regardless. A facilitator URL is recorded with any query string redacted.",
    ""
  );
  writeFileSync(`${base}.md`, `${md.join("\n")}\n`);
  return base;
}

// ── preflight ────────────────────────────────────────────────────────────────

interface Preflight {
  facilitatorUrl: string;
  payTo: string;
  health: string;
}

/**
 * Every operator-supplied input, checked one at a time so a failure names
 * exactly which one is absent instead of "something is not configured".
 */
async function preflight(): Promise<Preflight> {
  const env = readEnvLocal();

  const facilitatorUrl = env.X402_FACILITATOR_URL?.trim() ?? "";
  if (facilitatorUrl === "") {
    throw new ProvisioningMissing(
      `X402_FACILITATOR_URL is unset or empty in ${ENV_LOCAL}`,
      `Set it to a Base Sepolia x402 v2 facilitator, then restart the service:\n` +
        `    X402_FACILITATOR_URL=https://x402.org/facilitator\n` +
        `  (see docs/SETTLEMENT-PROVISIONING.md)`
    );
  }
  if (env.X402_ALLOW_STUB_FACILITATOR !== undefined && env.X402_ALLOW_STUB_FACILITATOR !== "") {
    throw new ProvisioningMissing(
      `X402_ALLOW_STUB_FACILITATOR is still present in ${ENV_LOCAL}`,
      `The stub accepts every well-formed payment WITHOUT verification. Remove that line entirely, then restart the service.`
    );
  }
  const payTo = env.X402_PAYTO_ROBLOX_LUAU_PAYTO?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    throw new ProvisioningMissing(
      `X402_PAYTO_ROBLOX_LUAU_PAYTO in ${ENV_LOCAL} is not a public EVM address`,
      `Set it to the seller's PUBLIC receiving address (0x + 40 hex), then restart the service.`
    );
  }

  let health: string;
  try {
    const res = await fetch(`${BASE_URL}/health`);
    health = JSON.stringify(await res.json());
  } catch (e) {
    throw new ProvisioningMissing(
      `the service is not answering on ${BASE_URL}`,
      `Start it (npm run service:status / service:restart) and re-run. Detail: ${(e as Error).message}`
    );
  }

  if (!existsSync(LEDGER_PATH)) {
    throw new ProvisioningMissing(`no ledger at ${LEDGER_PATH}`, `The service has never run here. Start it and re-run.`);
  }
  return { facilitatorUrl, payTo, health };
}

/** The payer must be able to pay. EIP-3009 is gasless for them, so USDC is the only balance that matters. */
async function assertFunded(token: string, payer: string, amountAtomic: string): Promise<string> {
  let balance: bigint;
  try {
    balance = await usdcBalance(token, payer);
  } catch (e) {
    throw new ProvisioningMissing(
      `cannot read USDC balance from ${RPC_URL}`,
      `Check the RPC (BASE_SEPOLIA_RPC_URL overrides it). Detail: ${(e as Error).message}`
    );
  }
  // Enough for four settlements: three proofs sign, and headroom keeps a
  // borderline balance from failing the gate for the wrong reason.
  const need = BigInt(amountAtomic) * 4n;
  if (balance < need) {
    throw new ProvisioningMissing(
      `payer ${payer} holds ${balance} atomic USDC on Base Sepolia; this run needs at least ${need}`,
      `Fund it from Circle's testnet faucet: https://faucet.circle.com (select Base Sepolia).`
    );
  }
  return balance.toString();
}

/** A stub-settled receipt is not a settlement. Caught here rather than at the RPC. */
function assertNotStubSettled(receipt: Receipt): void {
  if (receipt.transaction === null || receipt.transaction.startsWith("0xstub")) {
    throw new ProvisioningMissing(
      `the running service settled WITHOUT a chain transaction (receipt.transaction = ${JSON.stringify(receipt.transaction)})`,
      `That is the stub facilitator. .env.local may be correct while the RUNNING process still holds the old\n` +
        `  environment — restart the service so it re-reads .env.local, then re-run this gate.`
    );
  }
}

// ── phase 1 ──────────────────────────────────────────────────────────────────

async function phase1(): Promise<number> {
  const pre = await preflight();

  log(`gate: service ${BASE_URL} — ${pre.health}`);
  log(`gate: facilitator ${redactUrl(pre.facilitatorUrl)}`);
  log(`gate: rpc ${RPC_URL}`);

  // The tile to buy: the first one the live service actually serves.
  const manifestRes = await fetch(`${BASE_URL}/.well-known/x402`);
  if (!manifestRes.ok) throw new ProofFailed("discovery", `/.well-known/x402 returned ${manifestRes.status}`);
  const discovery = (await manifestRes.json()) as { resources: Array<{ resource: string; operationId: string }> };
  const tileTemplate = discovery.resources.find((r) => r.operationId === "tile_fetch");
  if (!tileTemplate) throw new ProofFailed("discovery", "no tile_fetch operation is published");

  // A cid the pack really holds. Every operation that would NAME one costs
  // money, so it is read off the sealed pack on disk — the same artifact the
  // service loaded and merkle-verified at boot.
  const cid = await firstServedCid(tileTemplate.resource);
  const resource = tileTemplate.resource.replace("{cid}", cid);

  // THE TESTNET GATE, and it runs BEFORE the payer key is unsealed. fetchChallenge
  // refuses any network other than eip155:84532. Nothing may materialize a
  // spending key into this process until the service on the other end is
  // confirmed to be Base Sepolia — a wrong-network service must never so much as
  // cause the Keychain to be read.
  const challenge = await fetchChallenge(resource);
  const token = challenge.standard.asset;
  if (!sameHex(token, getDefaultAsset(REQUIRED_NETWORK).address)) {
    throw new ProofFailed(
      "challenge",
      `the challenge resolves to token ${token}, not Base Sepolia USDC ${getDefaultAsset(REQUIRED_NETWORK).address}`
    );
  }
  if (!sameHex(challenge.requirements.payTo, pre.payTo)) {
    throw new ProvisioningMissing(
      `the live challenge pays to ${challenge.requirements.payTo}, but ${ENV_LOCAL} declares ${pre.payTo}`,
      `The running process is using a different payTo than the file. Restart the service and re-run.`
    );
  }

  // Only now — network and terms confirmed — is the key unsealed.
  const account = await loadPayerAccount();
  const payer = account.address;
  log(`gate: payer ${payer}`);

  const balanceBefore = await assertFunded(token, payer, challenge.requirements.amountAtomic);
  log(`gate: buying ${resource} for ${challenge.requirements.amountAtomic} atomic USDC → ${challenge.requirements.payTo}`);

  const startBlock = await chain.client.getBlockNumber();
  const proofs = collected;
  evidenceContext = {
    service: BASE_URL,
    facilitator: redactUrl(pre.facilitatorUrl),
    rpc: RPC_URL,
    network: REQUIRED_NETWORK,
    chainId: REQUIRED_CHAIN_ID,
    payerAddress: payer,
    payerUsdcBalanceBefore: balanceBefore,
    payTo: challenge.requirements.payTo,
    token,
    challengeEpoch: challenge.challengeEpoch ?? "(absent)",
    startBlock: startBlock.toString(),
    kernelLedger: LEDGER_PATH,
  };

  // ── proof 1: genuine settlement ────────────────────────────────────────────
  const paymentId = freshPaymentId();
  const paid = await call(resource, paymentId, await buildPayment(challenge, account));
  if (paid.status !== 200) {
    throw new ProofFailed(
      "1 GENUINE SETTLEMENT",
      `paid call returned ${paid.status} (${JSON.stringify(paid.body ?? paid.bytes.toString("utf8").slice(0, 200))})`
    );
  }
  const receipt = paid.receipt;
  if (!receipt) throw new ProofFailed("1 GENUINE SETTLEMENT", "a 200 with no x-payment-response receipt");
  assertNotStubSettled(receipt);
  if (!/^0x[0-9a-fA-F]{64}$/.test(receipt.transaction!)) {
    throw new ProofFailed("1 GENUINE SETTLEMENT", `receipt.transaction "${receipt.transaction}" is not a 32-byte tx hash`);
  }
  const evidence = await transferEvidenceFor(receipt.transaction as `0x${string}`, token);
  if (!sameHex(evidence.from, payer)) {
    throw new ProofFailed("1 GENUINE SETTLEMENT", `chain transfer is from ${evidence.from}, not the payer ${payer}`);
  }
  if (!sameHex(evidence.to, challenge.requirements.payTo)) {
    throw new ProofFailed(
      "1 GENUINE SETTLEMENT",
      `chain transfer is to ${evidence.to}, not the mount's payTo ${challenge.requirements.payTo}`
    );
  }
  if (evidence.value !== challenge.requirements.amountAtomic) {
    throw new ProofFailed(
      "1 GENUINE SETTLEMENT",
      `chain transfer moved ${evidence.value}, not the manifest's price ${challenge.requirements.amountAtomic}`
    );
  }
  const bodySha = sha256(paid.bytes);
  proofs.push({
    id: "1",
    title: "GENUINE SETTLEMENT — the receipt's transaction is real, succeeded, and moved the manifest's price",
    passed: true,
    facts: {
      paymentId,
      resource,
      httpStatus: paid.status,
      bodyBytes: paid.bytes.length,
      bodySha256: bodySha,
      transaction: evidence.txHash,
      blockNumber: evidence.blockNumber,
      chainStatus: evidence.status,
      transferFrom: evidence.from,
      transferTo: evidence.to,
      transferValueAtomic: evidence.value,
      token: evidence.token,
      rpc: RPC_URL,
    },
  });
  log(`  proof 1 PASS — tx ${evidence.txHash} block ${evidence.blockNumber}`);

  // ── proof 2: receipt field match ───────────────────────────────────────────
  const mismatches: string[] = [];
  if (!sameHex(receipt.payer, payer)) mismatches.push(`payer ${receipt.payer} != ${payer}`);
  if (!sameHex(receipt.payTo, challenge.requirements.payTo)) {
    mismatches.push(`payTo ${receipt.payTo} != ${challenge.requirements.payTo}`);
  }
  if (receipt.asset !== challenge.requirements.asset) {
    mismatches.push(`asset ${receipt.asset} != ${challenge.requirements.asset}`);
  }
  if (receipt.amountAtomic !== challenge.requirements.amountAtomic) {
    mismatches.push(`amountAtomic ${receipt.amountAtomic} != ${challenge.requirements.amountAtomic}`);
  }
  if (receipt.network !== REQUIRED_NETWORK) mismatches.push(`network ${receipt.network} != ${REQUIRED_NETWORK}`);
  if (!sameHex(receipt.payer, evidence.from)) mismatches.push(`payer ${receipt.payer} != chain from ${evidence.from}`);
  if (!sameHex(receipt.payTo, evidence.to)) mismatches.push(`payTo ${receipt.payTo} != chain to ${evidence.to}`);
  if (receipt.amountAtomic !== evidence.value) {
    mismatches.push(`amountAtomic ${receipt.amountAtomic} != chain value ${evidence.value}`);
  }
  if (mismatches.length > 0) throw new ProofFailed("2 RECEIPT FIELD MATCH", mismatches.join("; "));
  proofs.push({
    id: "2",
    title: "RECEIPT FIELD MATCH — the receipt agrees with the payment AND with the chain",
    passed: true,
    facts: {
      "receipt.payer": receipt.payer!,
      "receipt.payTo": receipt.payTo,
      "receipt.asset": `${receipt.asset} (symbolic; the wire carried ${token})`,
      "receipt.amountAtomic": receipt.amountAtomic,
      "receipt.network": receipt.network,
      "chain.from": evidence.from,
      "chain.to": evidence.to,
      "chain.value": evidence.value,
      "chainId": REQUIRED_CHAIN_ID,
    },
  });
  log("  proof 2 PASS — receipt matches payment and chain");

  // ── proof 3: replay without re-settlement ──────────────────────────────────
  const settledBlock = BigInt(evidence.blockNumber);
  const transfersAfterFirst = await transfersFromPayer(token, payer, challenge.requirements.payTo, settledBlock);
  const replay = await call(resource, paymentId);
  if (replay.status !== 200) throw new ProofFailed("3 REPLAY WITHOUT RE-SETTLEMENT", `replay returned ${replay.status}`);
  if (sha256(replay.bytes) !== bodySha || replay.bytes.length !== paid.bytes.length) {
    throw new ProofFailed("3 REPLAY WITHOUT RE-SETTLEMENT", "the replayed body is not byte-identical");
  }
  if (replay.replayed !== "true") {
    throw new ProofFailed("3 REPLAY WITHOUT RE-SETTLEMENT", `x-replayed was ${JSON.stringify(replay.replayed)}`);
  }
  const transfersAfterReplay = await transfersFromPayer(token, payer, challenge.requirements.payTo, settledBlock);
  if (transfersAfterReplay.length !== transfersAfterFirst.length) {
    throw new ProofFailed(
      "3 REPLAY WITHOUT RE-SETTLEMENT",
      `the chain gained a transfer during the replay: ${transfersAfterFirst.join(",")} → ${transfersAfterReplay.join(",")}`
    );
  }
  const facts = ledgerFacts(paymentId);
  if (facts.settlementAttempts !== 1) {
    throw new ProofFailed(
      "3 REPLAY WITHOUT RE-SETTLEMENT",
      `the ledger records ${facts.settlementAttempts} settlement attempts for this call, not 1`
    );
  }
  if (facts.receipts !== 1) {
    throw new ProofFailed("3 REPLAY WITHOUT RE-SETTLEMENT", `the ledger holds ${facts.receipts} receipts, not 1`);
  }
  proofs.push({
    id: "3",
    title: "REPLAY WITHOUT RE-SETTLEMENT — the same paymentId returns the same bytes and moves no money",
    passed: true,
    facts: {
      httpStatus: replay.status,
      "x-replayed": replay.replayed!,
      bodySha256: sha256(replay.bytes),
      byteIdentical: true,
      "ledger.state": facts.state!,
      "ledger.settlementAttempts": facts.settlementAttempts,
      "ledger.receipts": facts.receipts,
      "chain.transfersFromPayerSinceSettlement": transfersAfterReplay.join(",") || "(none beyond the settlement)",
    },
  });
  log("  proof 3 PASS — byte-identical replay, one settlement attempt, no new transfer");

  // ── proof 4: failed execution never settles ────────────────────────────────
  const absentResource = tileTemplate.resource.replace("{cid}", ABSENT_CID);
  const absentChallenge = await fetchChallenge(absentResource);
  const failPaymentId = freshPaymentId();
  const failed = await call(absentResource, failPaymentId, await buildPayment(absentChallenge, account));
  if (failed.status !== 404 || failed.body?.code !== "tile_not_found") {
    throw new ProofFailed(
      "4 FAILED EXECUTION NEVER SETTLES",
      `expected 404 tile_not_found, got ${failed.status} ${JSON.stringify(failed.body)}`
    );
  }
  if (failed.receipt) throw new ProofFailed("4 FAILED EXECUTION NEVER SETTLES", "a failed call carried a receipt");
  const transfersAfterFailure = await transfersFromPayer(token, payer, challenge.requirements.payTo, settledBlock);
  if (transfersAfterFailure.length !== transfersAfterFirst.length) {
    throw new ProofFailed(
      "4 FAILED EXECUTION NEVER SETTLES",
      `the chain gained a transfer for a call that produced nothing: ${transfersAfterFailure.join(",")}`
    );
  }
  const failedFacts = ledgerFacts(failPaymentId);
  if (failedFacts.settlementAttempts !== 0) {
    throw new ProofFailed(
      "4 FAILED EXECUTION NEVER SETTLES",
      `the ledger records ${failedFacts.settlementAttempts} settlement attempts for a failed call`
    );
  }
  proofs.push({
    id: "4",
    title: "FAILED EXECUTION NEVER SETTLES — a real payment for an absent tile is refused and never settles",
    passed: true,
    facts: {
      paymentId: failPaymentId,
      resource: absentResource,
      httpStatus: failed.status,
      code: failed.body?.code ?? "",
      receiptPresent: false,
      "ledger.state": failedFacts.state ?? "(no call)",
      "ledger.settlementAttempts": failedFacts.settlementAttempts,
      "chain.transfersUnchanged": true,
    },
  });
  log("  proof 4 PASS — 404 tile_not_found, no receipt, no transfer");

  // ── phase-1 state, for the restart proof ───────────────────────────────────
  const state: Phase1State = {
    version: 1,
    recordedAt: new Date().toISOString(),
    paymentId,
    resource,
    bodySha256: bodySha,
    bodyLength: paid.bytes.length,
    transaction: evidence.txHash,
    blockNumber: evidence.blockNumber,
    payerAddress: payer,
    payTo: challenge.requirements.payTo,
    amountAtomic: challenge.requirements.amountAtomic,
    network: REQUIRED_NETWORK,
    token,
  };
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);

  const base = writeEvidence("phase 1 (proofs 1–4)", proofs, evidenceContext);

  log("");
  log(`gate: phase 1 PASS — evidence at ${base}.md / .json`);
  log("");
  log("PROOF 5 — RESTART PRESERVES ENTITLEMENT requires an operator action:");
  log("");
  log("  1. Restart the service:      npm run service:restart");
  log("  2. Confirm it came back:     npm run service:health");
  log(`  3. Run phase 2:              npm run gate:settlement -- --phase2 ${paymentId}`);
  log("");
  log(`(phase 2 reads ${STATE_PATH} if you omit the paymentId)`);
  return 0;
}

// ── phase 2 ──────────────────────────────────────────────────────────────────

async function phase2(argPaymentId?: string): Promise<number> {
  if (!existsSync(STATE_PATH)) {
    throw new ProvisioningMissing(
      `no phase-1 state at ${STATE_PATH}`,
      `Run \`npm run gate:settlement\` first: phase 2 asserts that PHASE 1's purchase survived a restart.`
    );
  }
  const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Phase1State;
  const paymentId = argPaymentId ?? state.paymentId;
  if (paymentId !== state.paymentId) {
    throw new ProvisioningMissing(
      `paymentId ${paymentId} is not the one phase 1 recorded (${state.paymentId})`,
      `Pass the phase-1 paymentId, or omit it entirely and let phase 2 read the state file.`
    );
  }
  const pre = await preflight();
  evidenceContext = {
    service: BASE_URL,
    facilitator: redactUrl(pre.facilitatorUrl),
    rpc: RPC_URL,
    network: state.network,
    payerAddress: state.payerAddress,
    payTo: state.payTo,
    token: state.token,
    phase1Transaction: state.transaction,
    phase1RecordedAt: state.recordedAt,
  };
  log(`gate: phase 2 — service ${BASE_URL} — ${pre.health}`);
  log(`gate: replaying ${paymentId} recorded at ${state.recordedAt}`);

  // No payment header: the entitlement alone must carry this.
  const replay = await call(state.resource, paymentId);
  if (replay.status !== 200) {
    throw new ProofFailed("5 RESTART PRESERVES ENTITLEMENT", `replay after restart returned ${replay.status}`);
  }
  if (sha256(replay.bytes) !== state.bodySha256 || replay.bytes.length !== state.bodyLength) {
    throw new ProofFailed(
      "5 RESTART PRESERVES ENTITLEMENT",
      `the replayed body differs from phase 1's (${sha256(replay.bytes)} vs ${state.bodySha256})`
    );
  }
  if (replay.replayed !== "true") {
    throw new ProofFailed("5 RESTART PRESERVES ENTITLEMENT", `x-replayed was ${JSON.stringify(replay.replayed)}`);
  }
  const transfers = await transfersFromPayer(state.token, state.payerAddress, state.payTo, BigInt(state.blockNumber));
  const extra = transfers.filter((h) => !sameHex(h, state.transaction));
  if (extra.length > 0) {
    throw new ProofFailed(
      "5 RESTART PRESERVES ENTITLEMENT",
      `the chain gained transfer(s) beyond phase 1's settlement: ${extra.join(",")}`
    );
  }
  const facts = ledgerFacts(paymentId);
  if (facts.settlementAttempts !== 1) {
    throw new ProofFailed(
      "5 RESTART PRESERVES ENTITLEMENT",
      `the ledger records ${facts.settlementAttempts} settlement attempts, not 1`
    );
  }
  if (!facts.txns.some((t) => sameHex(t, state.transaction))) {
    throw new ProofFailed(
      "5 RESTART PRESERVES ENTITLEMENT",
      `the ledger's receipt no longer names phase 1's transaction ${state.transaction}`
    );
  }

  collected.push({
    id: "5",
    title: "RESTART PRESERVES ENTITLEMENT — the phase-1 purchase replays byte-identically after a restart",
    passed: true,
    facts: {
      paymentId,
      resource: state.resource,
      httpStatus: replay.status,
      "x-replayed": replay.replayed,
      bodySha256: sha256(replay.bytes),
      phase1BodySha256: state.bodySha256,
      byteIdentical: true,
      "ledger.state": facts.state ?? "",
      "ledger.settlementAttempts": facts.settlementAttempts,
      "ledger.receiptTransaction": facts.txns.join(","),
      "chain.transfersSincePhase1Block": transfers.join(",") || "(none)",
      "chain.newTransfers": 0,
    },
  });
  const base = writeEvidence("phase 2 (proof 5)", collected, evidenceContext);
  log("  proof 5 PASS — byte-identical after restart, one settlement attempt, no new transfer");
  log("");
  log(`gate: phase 2 PASS — evidence at ${base}.md / .json`);
  return 0;
}

/**
 * The cid to buy.
 *
 * Discovery publishes the path TEMPLATE, not the tiles, and every operation
 * that would name a tile is paid — so the cid is read from the sealed pack on
 * disk, which is the same artifact the service loaded and merkle-verified at
 * boot. `X402_GATE_CID` overrides it for a pack this process cannot see.
 */
async function firstServedCid(tileTemplate: string): Promise<string> {
  const override = process.env.X402_GATE_CID;
  if (override) return override;
  const packsDir = path.join(PKG_DIR, "packs");
  const mountId = tileTemplate.split("/").filter(Boolean)[0];
  const routes = JSON.parse(readFileSync(path.join(PKG_DIR, "../manifests/x402-routes.json"), "utf8")) as {
    mounts: Array<{ mountId: string; substrate: { packRef: string } }>;
  };
  const mount = routes.mounts.find((m) => m.mountId === mountId);
  if (!mount) throw new ProofFailed("discovery", `no manifest mount for "${mountId}"`);
  // `<packsDir>/<packRef>.manifest.json` — Substrate.load's own naming.
  const manifestPath = path.join(packsDir, `${mount.substrate.packRef}.manifest.json`);
  if (!existsSync(manifestPath)) {
    throw new ProvisioningMissing(
      `no sealed pack manifest at ${manifestPath}`,
      `Build the packs (npm run make-pack in the terrain pipeline) or set X402_GATE_CID to a cid the service serves.`
    );
  }
  const tiles = (JSON.parse(readFileSync(manifestPath, "utf8")) as { tiles: string[] }).tiles;
  if (!tiles?.length) throw new ProofFailed("discovery", `the sealed pack at ${manifestPath} declares no tiles`);
  return tiles[0];
}

// ── entry ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  chain = await openChain();
  const args = process.argv.slice(2);
  const i = args.indexOf("--phase2");
  if (i >= 0) return phase2(args[i + 1]);
  return phase1();
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    // A gate that fails quietly is worse than no gate. Never print the key,
    // and never print a stack for an operator-facing refusal.
    if (e instanceof ProofFailed) {
      // A FAILING gate is exactly when the report matters most: it records what
      // did hold, and the fact that stopped the run.
      const [headline, ...rest] = e.message.split("\n");
      collected.push({
        id: "!",
        title: headline,
        passed: false,
        facts: { detail: rest.join(" ").trim() },
      });
      const base = writeEvidence("FAILED", collected, evidenceContext);
      process.stderr.write(`\n${e.message}\n\n  evidence: ${base}.md / .json\n\n`);
      process.exit(2);
    }
    if (e instanceof ProvisioningMissing) {
      // Nothing was proved and nothing was attempted — no report to write.
      process.stderr.write(`\n${e.message}\n\n`);
      process.exit(2);
    }
    process.stderr.write(`\nGATE ERROR — ${(e as Error).stack ?? String(e)}\n\n`);
    process.exit(3);
  });
