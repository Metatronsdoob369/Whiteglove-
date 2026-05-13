/**
 * AGENT LOOP
 *
 * The core execution cycle. Deliberately simple — no framework magic.
 *
 * Each turn:
 *   1. Retrieve from vault (always first)
 *   2. If silenced AND role is strict → return silence
 *   3. If tool calls are needed → invoke via registry
 *   4. Synthesize response from verified sources
 *   5. Return structured result with full audit trail
 *
 * Cherry-picked patterns:
 *   - Silence gate:    Faith-Less (proprietary)
 *   - Tool dispatch:   inspired by LangGraph node routing (simplified)
 *   - Role contract:   OMC governance pattern (Domicile)
 *   - Step audit:      inspired by AutoGen message history (flattened)
 */

import { randomUUID } from "crypto";
import type {
  AgentContext,
  AgentRunResult,
  LoopStep,
  Message,
  RoleContract,
  ToolResult
} from "../types";
import { ToolRegistry } from "../tool-registry";
import { LandmarkOrchestrator } from "../../brain/landmark-orchestrator";

// ─── Agent Loop ───────────────────────────────────────────────────────────────

export class AgentLoop {
  private orchestrator: LandmarkOrchestrator;
  private registry: ToolRegistry;
  private indexReady = false;

  constructor(registry: ToolRegistry, orchestratorConfig?: Partial<ConstructorParameters<typeof LandmarkOrchestrator>[0]>) {
    this.registry = registry;
    this.orchestrator = new LandmarkOrchestrator(orchestratorConfig);
  }

  /**
   * Warm the index. Call once before running queries.
   * Subsequent runs reuse the loaded index.
   */
  async init(indexPath?: string): Promise<void> {
    if (indexPath) {
      const loaded = await this.orchestrator.loadIndex(indexPath);
      if (loaded) {
        this.indexReady = true;
        return;
      }
    }
    await this.orchestrator.buildIndex();
    this.indexReady = true;
  }

  /**
   * Run a single turn against the agent.
   * Returns a fully audited AgentRunResult.
   */
  async run(
    userMessage: string,
    role: RoleContract,
    sessionMemory: Record<string, unknown> = {}
  ): Promise<AgentRunResult> {
    const totalStart = Date.now();
    const sessionId = randomUUID();
    const steps: LoopStep[] = [];

    const context: AgentContext = {
      role,
      sessionId,
      turn: 1,
      memory: sessionMemory,
      vaultPath: this.orchestrator.diagnostics().toString()
    };

    // ── Step 1: Vault Retrieval (always first) ────────────────────────────────
    const retrieveStart = Date.now();
    const retrieval = await this.orchestrator.retrieve(userMessage);

    const retrieveStep: LoopStep = {
      type: "retrieve",
      input: userMessage,
      citations: retrieval.citations.map(c => ({
        shardId: c.shardId,
        source: c.source,
        hammingRatio: c.hammingRatio,
        preview: c.contentPreview
      })),
      silenced: retrieval.silenced,
      durationMs: Date.now() - retrieveStart
    };
    steps.push(retrieveStep);

    // ── Step 2: Silence gate ──────────────────────────────────────────────────
    if (retrieval.silenced && role.silencePolicy === "strict") {
      return {
        sessionId,
        role: role.id,
        sector: role.sector,
        steps,
        finalResponse: null,
        silenced: true,
        totalMs: Date.now() - totalStart
      };
    }

    // ── Step 3: Build response from verified sources ───────────────────────────
    let finalResponse: string | null = null;

    if (!retrieval.silenced && retrieval.sourceTexts.length > 0) {
      // Construct context block from verified source text
      const contextBlock = retrieval.sourceTexts
        .map((s, i) => `[Source ${i + 1} — ${s.source} / ${s.shardId}]\n${s.fullText}`)
        .join("\n\n");

      // If Ollama is available, synthesize. Otherwise return raw sources.
      try {
        const queryResult = await this.orchestrator.query(userMessage);
        if (queryResult.answer) {
          finalResponse = queryResult.answer;
        } else {
          // Fall back to returning the verified source text directly
          finalResponse = `Based on verified sources:\n\n${contextBlock}`;
        }
      } catch {
        finalResponse = `Based on verified sources:\n\n${contextBlock}`;
      }

      const respondStep: LoopStep = {
        type: "respond",
        input: userMessage,
        output: finalResponse,
        citations: retrieveStep.citations,
        silenced: false,
        durationMs: Date.now() - retrieveStart
      };
      steps.push(respondStep);
    }

    return {
      sessionId,
      role: role.id,
      sector: role.sector,
      steps,
      finalResponse,
      silenced: finalResponse === null,
      totalMs: Date.now() - totalStart
    };
  }
}
