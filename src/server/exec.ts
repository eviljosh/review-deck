import { spawn } from "node:child_process";

export type Exec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; onLog?: (chunk: string) => void; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

// Spawn-based so long-running commands (a fresh `git clone` of a large repo can
// take minutes) can stream progress live via opts.onLog instead of going silent
// until they finish. Output is still aggregated and returned for callers that
// parse it (e.g. gh --json).
export const realExec: Exec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    console.log(`[exec] ${cmd} ${args.join(" ")}${opts?.cwd ? `  (cwd: ${opts.cwd})` : ""}`);
    if (opts?.signal?.aborted) {
      reject(new Error(`${cmd} aborted before start`));
      return;
    }
    const child = spawn(cmd, args, { cwd: opts?.cwd, signal: opts?.signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      opts?.onLog?.(s);
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      opts?.onLog?.(s); // git/gh write progress + diagnostics to stderr
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}: ${stderr.trim().slice(-800)}`));
    });
  });
