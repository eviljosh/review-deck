import {
  AgentTimeoutError,
  type AgentRequest,
  type AgentResult,
  type CodexRunner,
  type LlmEngine,
  type LogSink,
} from "./types.ts";
import { withTimeout } from "./with-timeout.ts";

const DEFAULT_TIMEOUT_MS = 180_000;

// Real adapter wrapping @openai/codex-sdk. The SDK shells out to the local
// `codex` CLI, which authenticates via the user's ChatGPT login (~/.codex/auth.json)
// and inherits its default model/reasoning-effort from ~/.codex/config.toml when
// we don't override them. Offline tests inject a fake runner instead.
const realCodexRun: CodexRunner = async (input) => {
  // Lazy import so the offline test suite (which injects a fake) never loads the SDK.
  const { Codex } = await import("@openai/codex-sdk");
  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: input.workdir,
    skipGitRepoCheck: true,
    // This is a reviewer: it must read the worktree but never modify it, and it
    // runs unattended in the server, so it can't block on an approval prompt.
    sandboxMode: "read-only",
    approvalPolicy: "never",
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { modelReasoningEffort: input.reasoningEffort } : {}),
  });
  const turn = await thread.run(
    `${input.system}\n\n${input.prompt}`,
    input.signal ? { signal: input.signal } : undefined,
  );
  return { text: turn.finalResponse ?? "" };
};

export function makeCodexEngine(runImpl: CodexRunner = realCodexRun): LlmEngine {
  return {
    name: "codex",
    async run(req: AgentRequest, onLog: LogSink): Promise<AgentResult> {
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const work = async (): Promise<AgentResult> => {
        onLog("[codex] reviewing diff...\n");
        const { text } = await runImpl({
          prompt: req.prompt,
          system: req.system,
          workdir: req.workdir,
          ...(req.model ? { model: req.model } : {}),
          ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}),
          ...(req.signal ? { signal: req.signal } : {}),
        });
        onLog(text);
        return { text };
      };
      return withTimeout(work, timeoutMs, () => new AgentTimeoutError("codex run timed out"));
    },
  };
}
