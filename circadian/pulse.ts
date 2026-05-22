/**
 * WHITE-GLOVE AGENT HUSK: CIRCADIAN PULSE
 * 
 * The heartbeat. Runs on a 1-hour interval with two modes:
 * 
 * WAKE (6AM-Midnight):
 *   - Scan ZIM_Archives for new files
 *   - Trigger shatter pipeline on unprocessed sources
 *   - Rebuild SimHash index if new shards detected
 * 
 * DREAM (Midnight-6AM):
 *   - Re-index the SimHash signatures for all shards
 *   - Pre-warm the LFU cache with frequently accessed shards
 *   - Verify shard integrity (file hashes)
 *   - Log diagnostic snapshot to audit trail
 */

import fs from "fs";
import path from "path";
import { LandmarkOrchestrator } from "../brain/landmark-orchestrator";
import { ShardCache } from "../brain/cache/shard-cache";

// Spectral Terrain Layer 4 — circadian hardening loop.
// Dynamically imported so the pulse degrades gracefully if spectral-terrain
// is not present in this environment (different deployment context).
async function runTerrainCircadian(): Promise<void> {
  try {
    const { runCircadian } = await import(
      "/Users/joewales/NODE_OUT_Master/spectral-terrain/engine/circadian.js"
    );
    await runCircadian();
  } catch (err: any) {
    console.warn(` [PULSE:DREAM] Terrain circadian skipped: ${err.message}`);
  }
}

// ─── Configuration ───────────────────────────────────────────────

const HEARTBEAT_INTERVAL = 60 * 60 * 1000; // 1 hour
const SHARD_DIR = "/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/brain/shards/shattered";
const ZIM_WATCH_DIR = "/Volumes/ARCHIVE/Emergency_Information/ZIM_Archives";
const AUDIT_LOG = "/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk/brain/pulse_audit.jsonl";

// ─── The Pulse ───────────────────────────────────────────────────

export class CircadianPulse {
  private isDreaming: boolean = false;
  private orchestrator: LandmarkOrchestrator;
  private lastShardCount: number = 0;

  constructor() {
    this.orchestrator = new LandmarkOrchestrator();
  }

  /**
   * Start the heartbeat loop.
   * First beat fires immediately, then every HEARTBEAT_INTERVAL.
   */
  async start(): Promise<void> {
    console.log(" [PULSE] Heartbeat started. Interval: 1 hour.");
    console.log(` [PULSE] Shard directory: ${SHARD_DIR}`);
    console.log(` [PULSE] ZIM watch directory: ${ZIM_WATCH_DIR}`);

    // Initial index build
    await this.orchestrator.buildIndex();
    this.lastShardCount = this.countShards();

    // First beat
    await this.beat();

    // Ongoing beats
    setInterval(() => this.beat(), HEARTBEAT_INTERVAL);
  }

  /**
   * Single heartbeat. Routes to Wake or Dream based on hour.
   */
  private async beat(): Promise<void> {
    const hour = new Date().getHours();
    const timestamp = new Date().toISOString();

    console.log(`\n [PULSE] Beat at ${timestamp} (hour: ${hour})`);

    if (hour >= 0 && hour < 6) {
      await this.dream();
    } else {
      await this.wake();
    }
  }

  /**
   * WAKE CYCLE: Scan for new knowledge and trigger ingestion.
   */
  private async wake(): Promise<void> {
    console.log("☀️ [PULSE:WAKE] Scanning for new knowledge grafts...");

    // Check for new ZIM files
    const newZims = this.scanForNewZims();
    if (newZims.length > 0) {
      console.log(`☀️ [PULSE:WAKE] Found ${newZims.length} new ZIM file(s):`);
      newZims.forEach(z => console.log(`   → ${z}`));
      // Future: trigger shatter pipeline here
    } else {
      console.log("☀️ [PULSE:WAKE] No new ZIM files detected.");
    }

    // Check if shards have been added since last beat
    const currentCount = this.countShards();
    if (currentCount > this.lastShardCount) {
      const delta = currentCount - this.lastShardCount;
      console.log(`☀️ [PULSE:WAKE] ${delta} new shard(s) detected. Rebuilding index...`);
      await this.orchestrator.buildIndex();
      this.lastShardCount = currentCount;
    }

    this.logAudit("WAKE", { newZims: newZims.length, shardDelta: currentCount - this.lastShardCount });
  }

  /**
   * DREAM CYCLE: Consolidate, re-index, verify integrity.
   */
  private async dream(): Promise<void> {
    if (this.isDreaming) {
      console.log(" [PULSE:DREAM] Already dreaming. Skipping.");
      return;
    }

    this.isDreaming = true;
    console.log(" [PULSE:DREAM] Starting consolidation...");

    try {
      // 1. Full re-index
      console.log(" [PULSE:DREAM] Phase 1: Rebuilding SimHash index...");
      await this.orchestrator.buildIndex();
      this.lastShardCount = this.countShards();

      // 2. Integrity check — verify all shard files parse correctly
      console.log(" [PULSE:DREAM] Phase 2: Verifying shard integrity (batched)...");
      const integrity = await this.verifyShardsIntegrity();

      // 3. Diagnostic snapshot
      const diag = this.orchestrator.diagnostics();
      console.log(" [PULSE:DREAM] Phase 3: Diagnostic snapshot:");
      console.log(`   Index size:     ${diag.indexSize} shards`);
      console.log(`   Cache size:     ${diag.cacheSize}/${diag.cacheCapacity}`);
      console.log(`   Threshold:      ${diag.threshold}`);
      console.log(`   Integrity:      ${integrity.valid}/${integrity.total} valid`);

      if (integrity.corrupted.length > 0) {
        console.warn(`   ⚠️ Corrupted:   ${integrity.corrupted.length} shards detected.`);
        if (integrity.corrupted.length <= 10) {
          console.warn(`   ⚠️ Details:     ${integrity.corrupted.join(", ")}`);
        }
      }

      this.logAudit("DREAM", {
        indexSize: diag.indexSize,
        cacheSize: diag.cacheSize,
        integrityValid: integrity.valid,
        integrityCorrupted: integrity.corrupted.length
      });

      // 4. Spectral Terrain Layer 4 — centroid recompute + monitor recalibration
      console.log(" [PULSE:DREAM] Phase 4: Terrain circadian hardening...");
      await runTerrainCircadian();

    } catch (err: any) {
      console.error("❌ [PULSE:DREAM] CRITICAL FAILURE during consolidation:", err);
      this.logAudit("DREAM_FAILURE", { error: err.message, stack: err.stack });
    } finally {
      this.isDreaming = false;
      console.log(" [PULSE:DREAM] Consolidation cycle exited.");
    }
  }

  /**
   * Scan ZIM_Archives for files not yet ingested.
   */
  private scanForNewZims(): string[] {
    if (!fs.existsSync(ZIM_WATCH_DIR)) return [];

    const zimFiles = fs.readdirSync(ZIM_WATCH_DIR)
      .filter((f: string) => f.endsWith(".zim"));

    // Simple heuristic: if we have shards, assume existing ZIMs are processed.
    // A proper implementation would track processed ZIMs in a manifest.
    // For now, return ZIMs that don't have a corresponding marker file.
    return zimFiles.filter((z: string) => {
      const markerPath = path.join(ZIM_WATCH_DIR, `${z}.ingested`);
      return !fs.existsSync(markerPath);
    });
  }

  /**
   * Count shard files on disk.
   */
  private countShards(): number {
    if (!fs.existsSync(SHARD_DIR)) return 0;
    return fs.readdirSync(SHARD_DIR).filter((f: string) => f.endsWith(".json")).length;
  }

  /**
   * Verify all shard JSON files are parseable and have required fields.
   */
  private async verifyShardsIntegrity(): Promise<{ total: number; valid: number; corrupted: string[] }> {
    if (!fs.existsSync(SHARD_DIR)) return { total: 0, valid: 0, corrupted: [] };
    
    const files = fs.readdirSync(SHARD_DIR).filter((f: string) => f.endsWith(".json"));
    const corrupted: string[] = [];
    const BATCH_SIZE = 50;
    const MAX_FILE_SIZE = 1024 * 1024; // 1MB

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filePath = path.join(SHARD_DIR, file);

      try {
        const stats = fs.statSync(filePath);
        if (stats.size > MAX_FILE_SIZE) {
          corrupted.push(`${file} (OVERSIZED: ${(stats.size / 1024).toFixed(1)}KB)`);
          continue;
        }

        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (!parsed.id || !parsed.content || !parsed.source) {
          corrupted.push(file);
        }
      } catch {
        corrupted.push(file);
      }

      if (i % BATCH_SIZE === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    return {
      total: files.length,
      valid: files.length - corrupted.length,
      corrupted
    };
  }

  /**
   * Append a structured audit log entry.
   */
  private logAudit(cycle: "WAKE" | "DREAM" | "DREAM_FAILURE", data: Record<string, unknown>): void {
    const entry = {
      timestamp: new Date().toISOString(),
      cycle,
      ...data
    };

    try {
      fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + "\n");
    } catch (err) {
      console.error("⚠️ [PULSE] Failed to write audit log:", err);
    }
  }

  /**
   * Get the orchestrator for external query access.
   */
  getOrchestrator(): LandmarkOrchestrator {
    return this.orchestrator;
  }
}
