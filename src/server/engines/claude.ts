import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import {
  AgentTimeoutError,
  type AgentMessage,
  type AgentRequest,
  type AgentResult,
  type LlmEngine,
  type LogSink,
  type QueryFn,
} from "./types.ts";
import { withTimeout } from "./with-timeout.ts";

const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash(gh pr *)"];
const DENY_TOOLS = ["Edit", "Write", "Bash(git push *)"];
const DEFAULT_TIMEOUT_MS = 180_000;

// Adapt the real SDK query to our structural QueryFn.
const realQuery: QueryFn = (args) =>
  sdkQuery(args as never) as unknown as AsyncIterable<AgentMessage>;

export function makeClaudeEngine(queryImpl: QueryFn = realQuery): LlmEngine {
  return {
    name: "claude",
    async run(req: AgentRequest, onLog: LogSink): Promise<AgentResult> {
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      // Bridge the caller's AbortSignal to the SDK's AbortController so a cancel
      // actually tears down the underlying query subprocess.
      const abortController = new AbortController();
      if (req.signal) {
        if (req.signal.aborted) abortController.abort();
        else req.signal.addEventListener("abort", () => abortController.abort(), { once: true });
      }

      const consume = async (): Promise<AgentResult> => {
        let finalText = "";
        const iterable = queryImpl({
          prompt: req.prompt,
          options: {
            systemPrompt: req.system,
            cwd: req.workdir,
            allowedTools: READ_ONLY_TOOLS,
            disallowedTools: DENY_TOOLS,
            permissionMode: "dontAsk",
            abortController,
            ...(req.model ? { model: req.model } : {}),
            ...(req.maxTurns ? { maxTurns: req.maxTurns } : {}),
          },
        });
        for await (const msg of iterable) {
          if (msg.type === "assistant" && msg.message) {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) onLog(block.text);
            }
          } else if (msg.type === "result") {
            if (msg.subtype && msg.subtype !== "success") {
              const detail = msg.errors?.length ? `: ${msg.errors.join("; ")}` : "";
              throw new Error(`agent run failed (${msg.subtype})${detail}`);
            }
            finalText = msg.result ?? "";
          }
        }
        return { text: finalText };
      };

      return withTimeout(consume, timeoutMs, () => new AgentTimeoutError());
    },
  };
}
