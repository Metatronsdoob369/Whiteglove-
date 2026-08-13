/**
 * cut-witness.ts — CLI for the witness chain.
 *
 * Usage:
 *   node dist-gate/scripts/cut-witness.js cut    [ledgerPath] [witnessDir] [keysDir]
 *   node dist-gate/scripts/cut-witness.js verify [witnessDir] [keysDir]
 *
 * Defaults are the live service layout: ledger.db, evidence/witness, packs.
 * Exit codes: 0 clean; 1 refusal (tamper, gap, bad seal); 2 usage.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { cutWitness, verifyWitnessChain, WitnessRefusal } from "../src/witness.js";
import type { TrustEntry } from "../src/substrate.js";

const here = path.resolve(__dirname, "../..");
const mode = process.argv[2] ?? "cut";

function trustStoreFrom(keysDir: string): Record<string, TrustEntry> {
  return JSON.parse(readFileSync(path.join(keysDir, "terrain-keys.json"), "utf8")) as Record<string, TrustEntry>;
}

try {
  if (mode === "cut") {
    const ledgerPath = process.argv[3] ?? path.join(here, "ledger.db");
    const witnessDir = process.argv[4] ?? path.join(here, "evidence", "witness");
    const keysDir = process.argv[5] ?? path.join(here, "packs");
    const file = cutWitness({ ledgerPath, witnessDir, keysDir });
    const w = file.witness;
    console.log(`witness ${w.index} sealed  ${file.seal.cid}`);
    console.log(
      `  calls ${w.ledger.calls_total} | receipts ${w.ledger.receipts_success_total} | payers ${w.ledger.unique_payers} | breaches ${w.invariants.breaches}`
    );
    const { verified, totalBreaches } = verifyWitnessChain(witnessDir, trustStoreFrom(keysDir));
    console.log(`  chain verified: ${verified} witness(es), ${totalBreaches} total breach(es)`);
  } else if (mode === "verify") {
    const witnessDir = process.argv[3] ?? path.join(here, "evidence", "witness");
    const keysDir = process.argv[4] ?? path.join(here, "packs");
    const { verified, totalBreaches } = verifyWitnessChain(witnessDir, trustStoreFrom(keysDir));
    console.log(`chain verified: ${verified} witness(es), ${totalBreaches} total breach(es)`);
  } else {
    console.error(`unknown mode "${mode}" — use cut | verify`);
    process.exit(2);
  }
} catch (e) {
  if (e instanceof WitnessRefusal) {
    console.error(`WITNESS_REFUSED ${e.message}`);
    process.exit(1);
  }
  throw e;
}
