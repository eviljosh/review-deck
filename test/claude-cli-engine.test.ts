import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { makeClaudeCliEngine, MIN_CLI_VERSION, type CliChild, type SpawnFn } from "../src/server/engines/claude-cli.ts";
import type { AgentRequest } from "../src/server/engines/types.ts";

class FakeChild extends EventEmitter implements CliChild {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdinData = "";
  kills: string[] = [];
  stdin = {
    write: (d: string) => { this.stdinData += d; return true; },
    end: () => {},
  };
  kill(signal?: NodeJS.Signals) {
    this.kills.push(signal ?? "SIGTERM");
    this.emit("close", null);
    return true;
  }
  /** Emit stream-json lines then exit cleanly. */
  finish(lines: object[], code = 0) {
    setImmediate(() => {
      for (const l of lines) this.stdout.write(JSON.stringify(l) + "\n");
      this.stdout.end();
      this.emit("close", code);
    });
  }
}

// A spawn fake: first call answers the version probe, later calls run the review.
function fakeSpawn(version: string): { spawn: SpawnFn; calls: { cmd: string; args: string[]; opts: { cwd?: string; env?: NodeJS.ProcessEnv } }[]; children: FakeChild[] } {
  const calls: { cmd: string; args: string[]; opts: { cwd?: string; env?: NodeJS.ProcessEnv } }[] = [];
  const children: FakeChild[] = [];
  const spawn: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new FakeChild();
    children.push(child);
    if (args[0] === "--version") {
      setImmediate(() => {
        child.stdout.write(`${version} (Claude Code)\n`);
        child.stdout.end();
        child.emit("close", 0);
      });
    }
    return child;
  };
  return { spawn, calls, children };
}

const req: AgentRequest = { system: "sys prompt", prompt: "the diff", workdir: "/wt", model: "opus" };
const RESULT = { type: "result", subtype: "success", is_error: false, result: "final answer" };

test("happy path: flags, stdin prompt, streamed logs, final text", async () => {
  const f = fakeSpawn("2.1.217");
  const engine = makeClaudeCliEngine({ spawnImpl: f.spawn });
  const logs: string[] = [];
  const resP = engine.run(req, (c) => logs.push(c));
  // wait for the run child (call 1 after the probe) to exist
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const child = f.children[1];
  child.finish([
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "text", text: "thinking…" }, { type: "tool_use", name: "Grep", input: { pattern: "x" } }] } },
    RESULT,
  ]);
  const res = await resP;
  assert.equal(res.text, "final answer");
  assert.ok(logs.some((l) => l.includes("thinking…")));
  assert.ok(logs.some((l) => l.includes("[tool] Grep")));

  const runCall = f.calls[1];
  assert.equal(runCall.cmd, "claude");
  assert.equal(child.stdinData, "the diff"); // prompt via stdin, not argv
  assert.equal(runCall.opts.cwd, "/wt");
  const a = runCall.args;
  assert.ok(a.includes("-p"));
  assert.equal(a[a.indexOf("--output-format") + 1], "stream-json");
  assert.ok(a.includes("--verbose"));
  assert.equal(a[a.indexOf("--setting-sources") + 1], ""); // clean room
  assert.equal(a[a.indexOf("--system-prompt") + 1], "sys prompt");
  assert.match(a[a.indexOf("--allowedTools") + 1], /Read,Grep,Glob/);
  assert.match(a[a.indexOf("--disallowedTools") + 1], /Edit,Write/);
  assert.equal(a[a.indexOf("--model") + 1], "opus");
});

test("env auth mode passes credentials through; stored-login scrubs them", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok-test";
  try {
    for (const [auth, expectPresent] of [["env", true], ["stored-login", false]] as const) {
      const f = fakeSpawn("2.1.0");
      const engine = makeClaudeCliEngine({ auth, spawnImpl: f.spawn });
      const resP = engine.run(req, () => {});
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      f.children[1].finish([RESULT]);
      await resP;
      const env = f.calls[1].opts.env!;
      assert.equal("ANTHROPIC_API_KEY" in env, expectPresent, `auth=${auth}`);
      assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in env, expectPresent, `auth=${auth}`);
    }
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
});

test("a too-old CLI fails with a descriptive version error", async () => {
  const f = fakeSpawn("1.0.88");
  const engine = makeClaudeCliEngine({ spawnImpl: f.spawn });
  await assert.rejects(engine.run(req, () => {}), (e: Error) => {
    assert.match(e.message, /1\.0\.88/);
    assert.match(e.message, new RegExp(MIN_CLI_VERSION.replace(/\./g, "\\.")));
    return true;
  });
});

test("a missing claude binary fails with an install hint", async () => {
  const spawn: SpawnFn = () => {
    const child = new FakeChild();
    setImmediate(() => {
      const err = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      child.emit("error", err);
    });
    return child;
  };
  const engine = makeClaudeCliEngine({ spawnImpl: spawn });
  await assert.rejects(engine.run(req, () => {}), /claude CLI not found on PATH/);
});

test("an error result rejects with the CLI's detail", async () => {
  const f = fakeSpawn("2.1.0");
  const engine = makeClaudeCliEngine({ spawnImpl: f.spawn });
  const resP = engine.run(req, () => {});
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  f.children[1].finish([{ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }], 1);
  await assert.rejects(resP, /claude CLI run failed \(error_during_execution\): boom/);
});

test("exit without a result surfaces stderr", async () => {
  const f = fakeSpawn("2.1.0");
  const engine = makeClaudeCliEngine({ spawnImpl: f.spawn });
  const resP = engine.run(req, () => {});
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const child = f.children[1];
  setImmediate(() => {
    child.stderr.write("Invalid API key");
    child.stdout.end();
    child.emit("close", 1);
  });
  await assert.rejects(resP, /exited \(code 1\).*Invalid API key/s);
});

test("abort signal kills the child", async () => {
  const f = fakeSpawn("2.1.0");
  const engine = makeClaudeCliEngine({ spawnImpl: f.spawn });
  const ac = new AbortController();
  const resP = engine.run({ ...req, signal: ac.signal }, () => {});
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  ac.abort();
  await assert.rejects(resP);
  assert.ok(f.children[1].kills.length > 0);
});
