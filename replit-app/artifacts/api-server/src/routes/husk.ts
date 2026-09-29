import { Router } from "express";
import { createHash } from "node:crypto";
import { desc } from "drizzle-orm";
import { db, shardsTable, decisionLogsTable } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { simhash128, rankCandidates } from "../lib/simhash";
import { SILENCE_THRESHOLD, evaluateGate, type GateDecision } from "../lib/gate";
import { ensureSeeded, loadVault, type VaultShard } from "../lib/seed";

const router = Router();

const MAX_TURNS = 6;

// --- Agent loop ------------------------------------------------------------

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "search_vault",
      description:
        "Fingerprint a search phrase with SimHash-128 and return the closest shards with normalized Hamming distances. Use short, concept-rich phrases.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search phrase to fingerprint" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_shard",
      description: "Retrieve the full verified text of a shard by id.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer", description: "Shard id from search results" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "abstain",
      description:
        "End the loop with deliberate silence. Call this when no shard clears the distance threshold or the query is outside the vault.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Why the agent is staying silent" },
        },
        required: ["reason"],
        additionalProperties: false,
      },
    },
  },
];

interface AgentOutcome {
  action: "answer" | "abstain";
  shardId?: number;
  reason?: string;
  turns: number;
  toolCalls: string[];
  // Closest distance the agent achieved across its search_vault calls.
  // The gate uses min(raw query distance, these) — the agent's reformulated
  // search phrases are the query-understanding step of the retrieval engine.
  bestSearchDistance: number | null;
  searchBestByShard: Map<number, number>;
  // Every search phrase the agent tried — the gate's lexical-overlap check
  // credits these as query expansion alongside the raw query.
  searchPhrases: string[];
}

async function runAgentLoop(userQuery: string, vault: VaultShard[]): Promise<AgentOutcome> {
  const toolCalls: string[] = [];
  let bestSearchDistance: number | null = null;
  const searchBestByShard = new Map<number, number>();
  const searchPhrases: string[] = [];
  const systemPrompt = `You are HUSK, a silence-first retrieval agent. You NEVER generate medical content yourself. You may only speak by returning verified shard text from the vault.

Protocol:
1. Call search_vault with a concept-rich phrase derived from the user's query. You may search more than once with different phrasings.
2. Inspect the returned distances. The silence threshold is ${SILENCE_THRESHOLD} (normalized Hamming). Only a shard at or below it may be spoken.
3. If a candidate has withinThreshold: true AND its concept is semantically relevant to the user's question, call get_shard to confirm the text, then reply with exactly: ANSWER: <shard_id>
4. Otherwise call abstain with a reason.

Abstain when no within-threshold shard is relevant — for example the query is outside the vault's medical emergency scope, or every candidate is unrelated to the query's intent. But do NOT abstain out of excess caution when a relevant shard has cleared the gate: shard text is verified, so speaking it is grounded by construction. Silence is a feature — false silence is a bug.`;

  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userQuery },
  ];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.6-luna",
      max_completion_tokens: 500,
      reasoning_effort: "none",
      messages: messages as never,
      tools: TOOLS,
    });

    const choice = completion.choices[0];
    const msg = choice?.message;

    if (msg?.tool_calls?.length) {
      messages.push(msg as never);
      for (const call of msg.tool_calls) {
        if (call.type !== "function") continue;
        const name = call.function.name;
        toolCalls.push(name);
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = {};
        }

        if (name === "search_vault") {
          const phrase = String(args.query ?? userQuery);
          searchPhrases.push(phrase);
          const fp = simhash128(phrase);
          const candidates = rankCandidates(fp, vault, 3);
          for (const c of candidates) {
            const prev = searchBestByShard.get(c.id);
            if (prev === undefined || c.distance < prev) searchBestByShard.set(c.id, c.distance);
            if (bestSearchDistance === null || c.distance < bestSearchDistance) {
              bestSearchDistance = c.distance;
            }
          }
          const ranked = candidates.map((c) => {
            const shard = vault.find((s) => s.id === c.id)!;
            return {
              id: shard.id,
              concept: shard.concept,
              distance: Number(c.distance.toFixed(3)),
              withinThreshold: c.distance <= SILENCE_THRESHOLD,
            };
          });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ candidates: ranked, threshold: SILENCE_THRESHOLD }),
          });
        } else if (name === "get_shard") {
          const shard = vault.find((s) => s.id === Number(args.id));
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: shard
              ? JSON.stringify({ id: shard.id, concept: shard.concept, text: shard.text, source: shard.source })
              : JSON.stringify({ error: "shard not found" }),
          });
        } else if (name === "abstain") {
          return {
            action: "abstain",
            reason: String(args.reason ?? "no shard within threshold"),
            turns: turn,
            toolCalls,
            bestSearchDistance,
            searchBestByShard,
            searchPhrases,
          };
        } else {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ error: `unknown tool: ${name}` }),
          });
        }
      }
      continue;
    }

    // No tool call: expect "ANSWER: <id>"
    const content = msg?.content?.trim() ?? "";
    const match = /^ANSWER:\s*(\d+)/i.exec(content);
    if (match) {
      return {
        action: "answer",
        shardId: Number(match[1]),
        turns: turn,
        toolCalls,
        bestSearchDistance,
        searchBestByShard,
        searchPhrases,
      };
    }
    // Model neither called a tool nor answered properly — treat as abstain.
    return {
      action: "abstain",
      reason: "agent produced no valid terminal action",
      turns: turn,
      toolCalls,
      bestSearchDistance,
      searchBestByShard,
      searchPhrases,
    };
  }

  return {
    action: "abstain",
    reason: "turn budget exhausted",
    turns: MAX_TURNS,
    toolCalls,
    bestSearchDistance,
    searchBestByShard,
    searchPhrases,
  };
}

// --- Routes ------------------------------------------------------------------

router.post("/husk/query", async (req, res) => {
  const { query } = req.body as { query: string };

  if (!query?.trim()) {
    res.status(400).json({ error: "query is required" });
    return;
  }

  try {
    await ensureSeeded((msg) => req.log.info(msg));
    const vault = await loadVault();
    const queryFingerprint = simhash128(query);
    const ranked = rankCandidates(queryFingerprint, vault, 1);
    const rawBestDistance = ranked.length > 0 ? ranked[0].distance : null;

    const outcome = await runAgentLoop(query, vault);

    let verdict: "answered" | "silenced" = "silenced";
    let shard: VaultShard | null = null;
    let distance: number | null = null;
    let gate: GateDecision | null = null;

    if (outcome.action === "answer" && outcome.shardId != null) {
      const candidate = vault.find((s) => s.id === outcome.shardId);
      if (candidate) {
        // Gate enforcement: the measured distance + lexical overlap decide,
        // not the model.
        gate = evaluateGate({
          queryFingerprint,
          rawQuery: query,
          candidateFingerprint: candidate.fingerprint,
          candidateSearchText: candidate.searchText,
          searchBestDistance: outcome.searchBestByShard.get(candidate.id),
        });
        distance = gate.distance;
        if (gate.allows) {
          verdict = "answered";
          shard = candidate;
        }
      }
    }

    if (verdict === "silenced") {
      const observed = [rawBestDistance, outcome.bestSearchDistance].filter(
        (d): d is number => d != null,
      );
      distance = observed.length > 0 ? Math.min(...observed) : null;
    }

    await db.insert(decisionLogsTable).values({
      query,
      fingerprint: queryFingerprint,
      bestDistance: distance != null ? distance.toFixed(4) : null,
      threshold: SILENCE_THRESHOLD.toString(),
      verdict,
      concept: shard?.concept ?? null,
      toolCalls: JSON.stringify(outcome.toolCalls),
    });

    if (verdict === "answered" && shard) {
      res.json({
        query,
        silenced: false,
        verdict,
        text: shard.text,
        citations: `shard #${shard.id} • ${shard.source} • hamming ${distance!.toFixed(3)}`,
        concept: shard.concept,
        distance: Number(distance!.toFixed(4)),
        threshold: SILENCE_THRESHOLD,
        fingerprint: queryFingerprint,
        turns: outcome.turns,
      });
    } else {
      res.json({
        query,
        silenced: true,
        verdict,
        text: null,
        citations: null,
        concept: null,
        distance: distance != null ? Number(distance.toFixed(4)) : null,
        threshold: SILENCE_THRESHOLD,
        // Non-null when the model tried to answer and the gate vetoed it;
        // null when the model itself abstained. Lets the UI distinguish
        // "rejected by the gate" from "the agent chose silence".
        gateVeto: gate?.veto ?? null,
        sharedTokens: gate?.sharedTokens ?? null,
        fingerprint: queryFingerprint,
        turns: outcome.turns,
      });
    }
  } catch (err) {
    req.log.error({ err }, "husk query failed");
    res.status(500).json({ error: "internal error" });
  }
});

router.get("/husk/shards", async (req, res) => {
  try {
    await ensureSeeded((msg) => req.log.info(msg));
    const rows = await db.select().from(shardsTable);
    res.json(
      rows.map((r) => ({
        id: r.id,
        concept: r.concept,
        source: r.source,
        text: r.text,
        fingerprint: r.fingerprint,
        createdAt: r.createdAt.toISOString(),
      })),
    );
  } catch (err) {
    req.log.error({ err }, "husk shards failed");
    res.status(500).json({ error: "internal error" });
  }
});

router.get("/husk/log", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(decisionLogsTable)
      .orderBy(desc(decisionLogsTable.id))
      .limit(50);
    res.json(
      rows.map((r) => ({
        id: r.id,
        // Raw queries stay in the database for audit, but are never served
        // over the API — they can contain sensitive medical context.
        query: `sha256:${createHash("sha256").update(r.query).digest("hex").slice(0, 12)}`,
        fingerprint: r.fingerprint,
        bestDistance: r.bestDistance,
        threshold: r.threshold,
        verdict: r.verdict,
        concept: r.concept,
        toolCalls: r.toolCalls,
        createdAt: r.createdAt.toISOString(),
      })),
    );
  } catch (err) {
    req.log.error({ err }, "husk log failed");
    res.status(500).json({ error: "internal error" });
  }
});

export default router;
