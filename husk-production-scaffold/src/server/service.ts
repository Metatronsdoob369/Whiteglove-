/**
 * HuskService — thin production wrapper over LandmarkOrchestrator.
 *
 * Responsibilities the raw orchestrator doesn't own:
 *  - single lazy-built instance, health state
 *  - structured, versioned response envelope (stable API contract)
 *  - silence as a first-class response, never an error
 *  - request-level audit fields (id, timestamp, threshold used)
 *
 * The orchestrator stays untouched behind this. If its interface
 * changes, this file is the only thing that adapts.
 */
import { randomUUID } from "node:crypto";
import { LandmarkOrchestrator } from "../../../brain/landmark-orchestrator.js";
import { config, assertCalibrated, type HuskConfig } from "../config/index.js";

export interface HuskRequest {
  question: string;
  mode?: "retrieve" | "rag";
}

export interface HuskEnvelope {
  apiVersion: "husk.v1";
  requestId: string;
  timestamp: string;
  mode: "retrieve" | "rag";
  silenced: boolean;
  /** null when silenced or in pure-retrieve mode */
  answer: string | null;
  sources: Array<{ shardId: string; source: string; fullText: string }>;
  citations: Array<{ shardId: string; source: string; hammingRatio: number }>;
  /** best (lowest) Hamming ratio seen — present even on silence AFTER patch #1 */
  bestScore: number | null;
  thresholdUsed: number;
  calibrated: boolean;
  metrics: {
    indexLookupMs: number;
    inferenceMs: number;
    totalMs: number;
    shardsEvaluated: number;
    shardsSelected: number;
    cacheMisses: number;
  };
}

export class HuskService {
  private orch: LandmarkOrchestrator | null = null;
  private ready = false;

  constructor(private cfg: HuskConfig = config) {}

  async init(): Promise<void> {
    assertCalibrated(this.cfg);
    this.orch = new LandmarkOrchestrator({
      ...(this.cfg.shardDir ? { shardDir: this.cfg.shardDir } : {}),
      queryThreshold: this.cfg.queryThreshold,
      maxContextShards: this.cfg.maxContextShards,
      cacheCapacity: this.cfg.cacheCapacity,
      ollamaModel: this.cfg.ollamaModel,
      ollamaUrl: this.cfg.ollamaUrl,
    } as never);
    await this.orch.buildIndex();
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  async handle(req: HuskRequest): Promise<HuskEnvelope> {
    if (!this.orch || !this.ready) {
      throw new Error("HuskService not initialized — call init() first.");
    }
    const mode = req.mode ?? this.cfg.mode;
    const requestId = randomUUID();
    const timestamp = new Date().toISOString();

    const result =
      mode === "rag"
        ? await this.orch.query(req.question)
        : await this.orch.retrieve(req.question);

    // bestScore: lowest citation ratio if present (post-patch #1, silence too)
    const ratios = (result.citations ?? []).map(
      (c: { hammingRatio: number }) => c.hammingRatio
    );
    const bestScore = ratios.length ? Math.min(...ratios) : null;

    return {
      apiVersion: "husk.v1",
      requestId,
      timestamp,
      mode,
      silenced: result.silenced,
      answer: result.answer ?? null,
      sources: (result.sourceTexts ?? []).map(
        (s: { shardId: string; source: string; fullText: string }) => ({
          shardId: s.shardId,
          source: s.source,
          fullText: s.fullText,
        })
      ),
      citations: (result.citations ?? []).map(
        (c: { shardId: string; source: string; hammingRatio: number }) => ({
          shardId: c.shardId,
          source: c.source,
          hammingRatio: c.hammingRatio,
        })
      ),
      bestScore,
      thresholdUsed: this.cfg.queryThreshold,
      calibrated: this.cfg.thresholdCalibration.calibrated,
      metrics: {
        indexLookupMs: result.metrics.indexLookupMs,
        inferenceMs: result.metrics.inferenceMs,
        totalMs: result.metrics.totalMs,
        shardsEvaluated: result.metrics.shardsEvaluated,
        shardsSelected: result.metrics.shardsSelected,
        cacheMisses: result.metrics.cacheMisses,
      },
    };
  }
}
