export type LogSink = (chunk: string) => void;

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AgentRequest {
  system: string;
  prompt: string;
  workdir: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
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
  message?: { content: Array<{ type: string; text?: string }> };
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
