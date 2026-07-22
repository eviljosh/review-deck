import { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  AgentTimeoutError,
  type AgentMessage,
  type AgentRequest,
  type AgentResult,
  type LlmEngine,
  type LogSink,
} from "./types.ts";
import { withTimeout } from "./with-timeout.ts";

// Same read-only tool policy as the SDK engine — the two transports must stay
// behaviorally interchangeable.
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash(gh pr *)"];
const DENY_TOOLS = ["Edit", "Write", "Bash(git push *)"];
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Minimum `claude` CLI version for the flags this engine relies on
 * (--system-prompt, --setting-sources, stream-json output). Probed once per
 * engine instance; failures surface as a clear per-run error instead of a
 * cryptic flag-parse failure.
 */
export const MIN_CLI_VERSION = "2.1.0";

/**
 * CLI-transport credential handling:
 *  - "env": normal CLI precedence — ANTHROPIC_API_KEY, then
 *    CLAUDE_CODE_OAUTH_TOKEN, then the machine's stored `/login` session.
 *  - "stored-login": scrub credential env vars from the child so every run is
 *    guaranteed to use the stored `/login` session (the compliance switch: a
 *    leftover token in .env can never silently take over).
 */
export type ClaudeCliAuth = "env" | "stored-login";

// Minimal structural view of a spawned process, so tests can inject fakes.
export interface CliChild {
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream | null;
  stdin?: { write(data: string): unknown; end(): unknown } | null;
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "close", cb: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) => CliChild;

const realSpawn: SpawnFn = (cmd, args, opts) =>
  nodeSpawn(cmd, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] }) as unknown as CliChild;

function notFoundError(): Error {
  return new Error(
    "claude CLI not found on PATH — install Claude Code, or switch the Claude transport back to SDK in ⚙ Settings",
  );
}

function parseVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function versionAtLeast(v: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i] > min[i]) return true;
    if (v[i] < min[i]) return false;
  }
  return true;
}

function probeCliVersion(spawnImpl: SpawnFn): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = "";
    let child: CliChild;
    try {
      child = spawnImpl("claude", ["--version"], {});
    } catch {
      return reject(notFoundError());
    }
    child.stdout.on("data", (d: Buffer | string) => { out += String(d); });
    child.on("error", (err: NodeJS.ErrnoException) =>
      reject(err.code === "ENOENT" ? notFoundError() : err));
    child.on("close", () => {
      const v = parseVersion(out);
      if (!v) return reject(new Error(`could not parse \`claude --version\` output: ${out.trim() || "(empty)"}`));
      const min = parseVersion(MIN_CLI_VERSION)!;
      if (!versionAtLeast(v, min)) {
        return reject(new Error(
          `claude CLI ${v.join(".")} is older than the ${MIN_CLI_VERSION} required for CLI transport — ` +
          "update Claude Code, or switch the Claude transport back to SDK in ⚙ Settings",
        ));
      }
      resolve();
    });
  });
}

export function makeClaudeCliEngine(
  opts: { auth?: ClaudeCliAuth; spawnImpl?: SpawnFn } = {},
): LlmEngine {
  const auth = opts.auth ?? "env";
  const spawnImpl = opts.spawnImpl ?? realSpawn;
  // One probe per engine instance; every run awaits the same promise.
  let versionOk: Promise<void> | null = null;

  return {
    name: "claude",
    async run(req: AgentRequest, onLog: LogSink): Promise<AgentResult> {
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      versionOk ??= probeCliVersion(spawnImpl);
      await versionOk;

      const env: NodeJS.ProcessEnv = { ...process.env };
      if (auth === "stored-login") {
        delete env.ANTHROPIC_API_KEY;
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
        delete env.ANTHROPIC_AUTH_TOKEN;
      }

      const args = [
        "-p",
        // stream-json (line-delimited events, same shapes as the SDK stream)
        // for live logs; print mode requires --verbose to allow it.
        "--output-format", "stream-json", "--verbose",
        // Clean room: no user/project/local settings — parity with the SDK
        // engine, and it keeps a malicious PR's CLAUDE.md out of the reviewer's
        // context. (Enterprise managed settings still apply by design.)
        "--setting-sources", "",
        "--system-prompt", req.system,
        "--allowedTools", READ_ONLY_TOOLS.join(","),
        "--disallowedTools", DENY_TOOLS.join(","),
        ...(req.model ? ["--model", req.model] : []),
      ];

      const child = spawnImpl("claude", args, { cwd: req.workdir, env });
      const kill = () => {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        const hardKill = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 5000);
        hardKill.unref?.();
      };
      if (req.signal) {
        if (req.signal.aborted) kill();
        else req.signal.addEventListener("abort", kill, { once: true });
      }

      const work = () => new Promise<AgentResult>((resolve, reject) => {
        let finalText = "";
        let sawSuccess = false;
        let stderrBuf = "";
        child.stderr?.on("data", (d: Buffer | string) => { stderrBuf += String(d); });

        const rl = createInterface({ input: child.stdout });
        rl.on("line", (line) => {
          if (!line.trim()) return;
          let msg: AgentMessage;
          try {
            msg = JSON.parse(line) as AgentMessage;
          } catch {
            return; // non-JSON noise on stdout — ignore
          }
          if (msg.type === "assistant" && msg.message) {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) onLog(block.text);
              else if (block.type === "tool_use" && block.name) {
                let detail = "";
                try {
                  detail = JSON.stringify(block.input ?? {}).slice(0, 140);
                } catch { /* unserializable input — name alone is fine */ }
                onLog(`\n[tool] ${block.name} ${detail}\n`);
              }
            }
          } else if (msg.type === "result") {
            if (msg.is_error || (msg.subtype && msg.subtype !== "success")) {
              const detail = msg.result ? `: ${String(msg.result).slice(0, 400)}` : "";
              reject(new Error(`claude CLI run failed (${msg.subtype ?? "error"})${detail}`));
            } else {
              sawSuccess = true;
              finalText = msg.result ?? "";
            }
          }
        });

        child.on("error", (err: NodeJS.ErrnoException) =>
          reject(err.code === "ENOENT" ? notFoundError() : err));
        child.on("close", (code: number | null) => {
          if (sawSuccess) return resolve({ text: finalText });
          // If the result event already rejected, this is a no-op.
          const detail = stderrBuf.trim() ? `: ${stderrBuf.trim().slice(0, 400)}` : "";
          reject(new Error(`claude CLI exited (code ${code ?? "killed"}) without a result${detail}`));
        });

        // Prompt via stdin — big diffs would blow past argv limits as a flag.
        child.stdin?.write(req.prompt);
        child.stdin?.end();
      });

      return withTimeout(work, timeoutMs, () => {
        kill();
        return new AgentTimeoutError("claude CLI run timed out");
      });
    },
  };
}
