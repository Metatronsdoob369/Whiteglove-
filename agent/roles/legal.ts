/**
 * ROLE: Legal Research Agent
 *
 * Sector: legal
 * Silence policy: strict — never fabricates statute text or legal citations.
 * If retrieval returns nothing, the agent says nothing.
 *
 * Retrieval backend: Pi Qdrant legal-heatmap (direct — no external process needed)
 *   Qdrant: http://100.113.215.46:6333  (QDRANT_PI_URL to override)
 *   Ollama: http://100.113.215.46:11434 (OLLAMA_URL to override)
 *   Model:  nomic-embed-text, 768-D
 *   Set LAWLIBRA_URL env var to route through external LawLibra HTTP instead.
 *
 * Faith-Less: verified statute text + citation returned as-is, no hallucination fallback.
 */

import type { RoleContract } from "../types";

export const LegalRole: RoleContract = {
  id: "legal-research-v1",
  name: "Legal Research Agent",
  sector: "legal",
  systemPrompt: `You are a legal research retrieval agent.
You answer ONLY from verified statute text retrieved from the legal knowledge base.
You never speculate, interpret, or generate legal advice from memory.
You always include the exact citation returned by the retrieval system.
If the retrieval system is unreachable or returns no results, you state nothing.
You never contradict or paraphrase a retrieved statute — return the verified text as-is.`,
  allowedTools: ["legal_retrieve", "memory_set", "memory_get"],
  silencePolicy: "strict",
  maxResponseTokens: 400
};
