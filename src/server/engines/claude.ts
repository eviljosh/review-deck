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
// ReportFindings is denied, not because it writes anything, but because its
// schema is not ours: an agent that reports through it emits `summary`/
// `failure_scenario` and no `side`, which used to fail the parse and drop every
// finding in that lane. The prompts forbid it too, and the parser normalizes it
// if one slips through — this is the first of the three lines of defense.
const DENY_TOOLS = ["Edit", "Write", "Bash(git push *)", "ReportFindings"];
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
        const toolPayloads: string[] = [];
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
            // Extended thinking: `thinking` turns it on (adaptive), `effort` guides
            // its depth. Omitted unless the caller asked, so most runs keep SDK defaults.
            ...(req.thinking ? { thinking: req.thinking } : {}),
            ...(req.effort ? { effort: req.effort } : {}),
            ...(req.maxTurns ? { maxTurns: req.maxTurns } : {}),
          },
        });
        for await (const msg of iterable) {
          if (msg.type === "assistant" && msg.message) {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) onLog(block.text);
              // Surface tool activity so long "silent" stretches (the agent
              // grepping/reading the worktree) still show progress in the log.
              // Keep the FULL input too (see AgentResult.toolPayloads) — the log
              // preview is clipped for readability, but an agent that reported
              // its findings through a tool call has its only copy of them here.
              else if (block.type === "tool_use" && block.name) {
                let detail = "";
                try {
                  const serialized = JSON.stringify(block.input ?? {});
                  toolPayloads.push(serialized);
                  detail = serialized.slice(0, 140);
                } catch { /* unserializable input — name alone is fine */ }
                onLog(`\n[tool] ${block.name} ${detail}\n`);
              }
            }
          } else if (msg.type === "result") {
            if (msg.subtype && msg.subtype !== "success") {
              const detail = msg.errors?.length ? `: ${msg.errors.join("; ")}` : "";
              throw new Error(`agent run failed (${msg.subtype})${detail}`);
            }
            finalText = msg.result ?? "";
          }
        }
        return { text: finalText, toolPayloads };
      };

      return withTimeout(consume, timeoutMs, () => new AgentTimeoutError());
    },
  };
}
