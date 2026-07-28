export type LogSink = (chunk: string) => void;

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Claude's effort dial (SDK `effort` query option), which guides adaptive-thinking
 * depth. Distinct from ReasoningEffort (Codex): it includes "max" and omits "minimal".
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Claude extended-thinking config (SDK `thinking` query option). "adaptive" lets
 * the model decide when/how much to think (the mode on Opus 4.6+); "enabled" pins
 * a fixed budget for older models. Supersedes the deprecated maxThinkingTokens.
 */
export type ThinkingConfig =
  | { type: "adaptive" }
  | { type: "enabled"; budgetTokens: number }
  | { type: "disabled" };

export interface AgentRequest {
  system: string;
  prompt: string;
  workdir: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  // Claude-only (SDK) extended-thinking controls; the Codex engine ignores these
  // and uses reasoningEffort instead.
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  maxTurns?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AgentResult {
  text: string;
}

export interface LlmEngine {
  readonly name: string;
  run(req: AgentRequest, onLog: LogSink): Promise<AgentResult>;
}

// Minimal structural view of the SDK's message stream, so callers/tests never
// depend on the concrete SDK types.
export interface AgentMessage {
  type: string;
  message?: { content: Array<{ type: string; text?: string; name?: string; input?: unknown }> };
  subtype?: string;
  result?: string;
  is_error?: boolean;
  errors?: string[];
}

export type QueryFn = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<AgentMessage>;

export class AgentTimeoutError extends Error {
  constructor(message = "agent run timed out") {
    super(message);
    this.name = "AgentTimeoutError";
  }
}

export type CodexRunner = (input: {
  prompt: string;
  system: string;
  workdir: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
}) => Promise<{ text: string }>;
