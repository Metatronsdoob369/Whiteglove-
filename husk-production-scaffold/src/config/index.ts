/**
 * Production configuration for the WhiteGlove Husk service.
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  PLACEHOLDER VALUES — NOT YET CALIBRATED                     │
 * │  Every value tagged UNCALIBRATED below is a guess standing   │
 * │  in for a number that comes out of the harness sweep         │
 * │  (CHORES.md Task 11). Do not treat these as validated.       │
 * └─────────────────────────────────────────────────────────────┘
 */

export interface HuskConfig {
  shardDir: string;
  /** UNCALIBRATED — placeholder. Real value from post-salt-fix sweep. */
  queryThreshold: number;
  /** Calibration provenance — fill when Task 11 sets the threshold. */
  thresholdCalibration: {
    calibrated: boolean;
    corpusName: string | null;
    corpusSize: number | null;
    date: string | null;
    falseAnswerRateAtThreshold: number | null;
    falseSilenceRateAtThreshold: number | null;
  };
  maxContextShards: number;
  cacheCapacity: number;
  mode: "retrieve" | "rag";
  ollamaModel: string;
  ollamaUrl: string;
  server: { host: string; port: number };
}

export const config: HuskConfig = {
  shardDir: process.env.SHARD_DIR ?? "",
  queryThreshold: Number(process.env.QUERY_THRESHOLD ?? 0.45), // UNCALIBRATED
  thresholdCalibration: {
    calibrated: false,
    corpusName: null,
    corpusSize: null,
    date: null,
    falseAnswerRateAtThreshold: null,
    falseSilenceRateAtThreshold: null,
  },
  maxContextShards: Number(process.env.MAX_CONTEXT_SHARDS ?? 3),
  cacheCapacity: Number(process.env.CACHE_CAPACITY ?? 500),
  mode: (process.env.HUSK_MODE as "retrieve" | "rag") ?? "retrieve",
  ollamaModel: process.env.OLLAMA_MODEL ?? "qwen2.5-coder:7b",
  ollamaUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
  server: {
    host: process.env.HOST ?? "127.0.0.1", // airgap default: loopback only
    port: Number(process.env.PORT ?? 8787),
  },
};

/**
 * Refuses to start in "trust me" mode: if the config still carries the
 * uncalibrated threshold and calibration.calibrated is false, we warn
 * loudly. Flip STRICT_CALIBRATION=1 to hard-fail instead (recommended
 * for any real deployment).
 */
export function assertCalibrated(cfg: HuskConfig = config): void {
  if (!cfg.thresholdCalibration.calibrated) {
    const msg =
      "[HUSK] queryThreshold is UNCALIBRATED — running on a placeholder. " +
      "Calibrate via the harness sweep (CHORES.md Task 11) before trusting silence behavior.";
    if (process.env.STRICT_CALIBRATION === "1") {
      throw new Error(msg);
    }
    console.warn("⚠️  " + msg);
  }
}
