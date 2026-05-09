/**
 * WHITE-GLOVE AGENT HUSK: SimHash Calibration
 * 
 * Runs SimHash-128 over the existing 57 shards, computes all pairwise
 * Hamming distances, and reports the natural cluster boundaries.
 * 
 * The output tells us what the REAL threshold should be —
 * not the mentor's guess of 0.03, but what the data says.
 * 
 * Usage: ts-node calibration.ts
 */

import fs from "fs";
import path from "path";
import { SimHashDriftGuard } from "./simhash-guard";

const SHARD_DIR = "/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/brain/shards/shattered";

interface ShardPayload {
  id: string;
  source: string;
  content: string;
  timestamp: string;
  spectral_id: string;
}

async function calibrate() {
  console.log("💎 [CALIBRATION] Loading shards...\n");

  const guard = new SimHashDriftGuard(); // threshold doesn't matter here — we're measuring
  const files = fs.readdirSync(SHARD_DIR)
    .filter(f => f.endsWith(".json"))
    .sort();

  // Generate signatures for all shards
  const signatures: Array<{ id: string; sig: bigint; contentPreview: string }> = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(SHARD_DIR, file), "utf-8");
    const shard: ShardPayload = JSON.parse(raw);
    const sig = guard.simHash128FromText(shard.content, shard.source);

    signatures.push({
      id: shard.id,
      sig,
      contentPreview: shard.content.slice(0, 80).replace(/\n/g, " ")
    });
  }

  console.log(`📊 [CALIBRATION] ${signatures.length} shards indexed.\n`);

  // Compute ALL pairwise Hamming distances
  const distances: number[] = [];
  const adjacentDistances: number[] = [];
  let minDist = Infinity, maxDist = 0;
  let minPair = ["", ""], maxPair = ["", ""];

  for (let i = 0; i < signatures.length; i++) {
    for (let j = i + 1; j < signatures.length; j++) {
      const drift = guard.evaluateDrift(signatures[i].sig, signatures[j].sig);
      distances.push(drift.hammingRatio);

      // Track adjacent shards (sequential content from same document)
      if (j === i + 1) {
        adjacentDistances.push(drift.hammingRatio);
      }

      if (drift.hammingRatio < minDist) {
        minDist = drift.hammingRatio;
        minPair = [signatures[i].id, signatures[j].id];
      }
      if (drift.hammingRatio > maxDist) {
        maxDist = drift.hammingRatio;
        maxPair = [signatures[i].id, signatures[j].id];
      }
    }
  }

  // Sort distances for percentile analysis
  distances.sort((a, b) => a - b);
  adjacentDistances.sort((a, b) => a - b);

  const percentile = (arr: number[], p: number) => {
    const idx = Math.floor(arr.length * p);
    return arr[Math.min(idx, arr.length - 1)];
  };

  const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;

  console.log("═══════════════════════════════════════════════════");
  console.log("  PAIRWISE HAMMING DISTANCE ANALYSIS");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Total pairs analyzed:    ${distances.length}`);
  console.log(`  Min distance:            ${minDist.toFixed(4)} (${minPair[0]} ↔ ${minPair[1]})`);
  console.log(`  Max distance:            ${maxDist.toFixed(4)} (${maxPair[0]} ↔ ${maxPair[1]})`);
  console.log(`  Mean distance:           ${mean(distances).toFixed(4)}`);
  console.log(`  Median (P50):            ${percentile(distances, 0.5).toFixed(4)}`);
  console.log(`  P10 (similar):           ${percentile(distances, 0.1).toFixed(4)}`);
  console.log(`  P25:                     ${percentile(distances, 0.25).toFixed(4)}`);
  console.log(`  P75:                     ${percentile(distances, 0.75).toFixed(4)}`);
  console.log(`  P90 (distant):           ${percentile(distances, 0.9).toFixed(4)}`);
  console.log("");
  console.log("───────────────────────────────────────────────────");
  console.log("  ADJACENT SHARD DISTANCES (sequential content)");
  console.log("───────────────────────────────────────────────────");
  console.log(`  Adjacent pairs:          ${adjacentDistances.length}`);
  console.log(`  Mean adjacent distance:  ${mean(adjacentDistances).toFixed(4)}`);
  console.log(`  Min adjacent:            ${Math.min(...adjacentDistances).toFixed(4)}`);
  console.log(`  Max adjacent:            ${Math.max(...adjacentDistances).toFixed(4)}`);
  console.log("");
  console.log("───────────────────────────────────────────────────");
  console.log("  THRESHOLD RECOMMENDATIONS");
  console.log("───────────────────────────────────────────────────");

  // The threshold should be set between the mean adjacent distance
  // and the overall P25 — this captures "same topic" shards while
  // excluding genuinely different content.
  const recommended = (mean(adjacentDistances) + percentile(distances, 0.25)) / 2;

  console.log(`  Mentor suggested:        0.0300`);
  console.log(`  Data-driven (recommended): ${recommended.toFixed(4)}`);
  console.log(`  Conservative (P10):      ${percentile(distances, 0.1).toFixed(4)}`);
  console.log(`  Aggressive (adj mean):   ${mean(adjacentDistances).toFixed(4)}`);
  console.log("");
  console.log("═══════════════════════════════════════════════════");

  // Write calibration results to disk for audit trail
  const calibrationReport = {
    timestamp: new Date().toISOString(),
    shardCount: signatures.length,
    pairCount: distances.length,
    statistics: {
      min: minDist,
      max: maxDist,
      mean: mean(distances),
      median: percentile(distances, 0.5),
      p10: percentile(distances, 0.1),
      p25: percentile(distances, 0.25),
      p75: percentile(distances, 0.75),
      p90: percentile(distances, 0.9)
    },
    adjacentStatistics: {
      count: adjacentDistances.length,
      mean: mean(adjacentDistances),
      min: Math.min(...adjacentDistances),
      max: Math.max(...adjacentDistances)
    },
    thresholds: {
      mentor: 0.03,
      recommended,
      conservative: percentile(distances, 0.1),
      aggressive: mean(adjacentDistances)
    }
  };

  const reportPath = path.join(SHARD_DIR, "..", "calibration_report.json");
  fs.writeFileSync(reportPath, JSON.stringify(calibrationReport, null, 2));
  console.log(`\n📄 Report saved to: ${reportPath}`);
}

calibrate().catch(console.error);
