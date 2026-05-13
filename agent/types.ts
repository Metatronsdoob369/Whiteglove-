/**
 * WHITEGOLVE AGENT FRAMEWORK — Core Types
 *
 * Sector-agnostic. The agent doesn't know what domain it's in.
 * The role contract tells it what to do. The vault tells it what to say.
 * The tool registry tells it what it can touch.
 */

// ─── Tool Definition ─────────────────────────────────────────────────────────

export interface ToolParam {
  name: string;
  type: "string" | "number" | "boolean" | "object";
  description: string;
  required: boolean;
}

export interface Tool<TInput = Record<string, unknown>, TOutput = unknown> {
  name: string;
  description: string;
  params: ToolParam[];
  execute: (input: TInput, context: AgentContext) => Promise<ToolResult<TOutput>>;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ─── Role Contract ────────────────────────────────────────────────────────────

/**
 * A Role defines what the agent IS in a given sector.
 * Swap the role → same engine, different domain.
 */
export interface RoleContract {
  id: string;
  name: string;
  sector: string;           // "medical" | "legal" | "racing" | "construction" | ...
  systemPrompt: string;     // What the agent says it is
  allowedTools: string[];   // Tool names this role can invoke
  silencePolicy: "strict" | "permissive";
  // strict = silence if vault has nothing. permissive = allow LLM fallback.
  maxResponseTokens: number;
}

// ─── Agent Context ────────────────────────────────────────────────────────────

export interface AgentContext {
  role: RoleContract;
  sessionId: string;
  turn: number;
  memory: Record<string, unknown>;  // Ephemeral session state
  vaultPath: string;
}

// ─── Message Types ────────────────────────────────────────────────────────────

export type MessageRole = "user" | "agent" | "tool" | "system";

export interface Message {
  role: MessageRole;
  content: string;
  toolCall?: {
    tool: string;
    input: Record<string, unknown>;
    result?: ToolResult;
  };
  citations?: Citation[];
  silenced?: boolean;
  timestamp: string;
}

export interface Citation {
  shardId: string;
  source: string;
  hammingRatio: number;
  preview: string;
}

// ─── Agent Loop Step ──────────────────────────────────────────────────────────

export type StepType = "retrieve" | "tool_call" | "respond" | "silence";

export interface LoopStep {
  type: StepType;
  input: string;
  output?: string;
  citations?: Citation[];
  toolName?: string;
  toolResult?: ToolResult;
  silenced: boolean;
  durationMs: number;
}

// ─── Agent Run Result ─────────────────────────────────────────────────────────

export interface AgentRunResult {
  sessionId: string;
  role: string;
  sector: string;
  steps: LoopStep[];
  finalResponse: string | null;
  silenced: boolean;
  totalMs: number;
}
