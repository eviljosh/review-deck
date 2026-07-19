import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClaudeEngine } from "../src/server/engines/claude.ts";
import { AgentTimeoutError, type AgentMessage, type QueryFn } from "../src/server/engines/types.ts";

function fakeQuery(messages: AgentMessage[], opts?: { hangMs?: number }): QueryFn {
  return async function* () {
    for (const m of messages) yield m;
    if (opts?.hangMs) await new Promise((r) => setTimeout(r, opts.hangMs));
  };
}

test("engine streams assistant text to onLog and returns the result text", async () => {
  const q = fakeQuery([
    { type: "assistant", message: { content: [{ type: "text", text: "thinking..." }] } },
    { type: "result", subtype: "success", result: '{"ok":true}' },
  ]);
  const engine = makeClaudeEngine(q);
  const logs: string[] = [];
  const res = await engine.run(
    { system: "s", prompt: "p", workdir: "/wt" },
    (c) => logs.push(c),
  );
  assert.equal(res.text, '{"ok":true}');
  assert.ok(logs.join("").includes("thinking..."));
  assert.equal(engine.name, "claude");
});

test("engine rejects with AgentTimeoutError when no result arrives in time", async () => {
  // yields an assistant chunk then hangs without ever emitting a result
  const q = fakeQuery(
    [{ type: "assistant", message: { content: [{ type: "text", text: "..." }] } }],
    { hangMs: 1000 },
  );
  const engine = makeClaudeEngine(q);
  await assert.rejects(
    engine.run({ system: "s", prompt: "p", workdir: "/wt", timeoutMs: 30 }, () => {}),
    AgentTimeoutError,
  );
});

test("engine throws when the result message is an error subtype", async () => {
  const q = fakeQuery([
    { type: "assistant", message: { content: [{ type: "text", text: "trying" }] } },
    { type: "result", subtype: "error_max_turns", errors: ["hit max turns"] },
  ]);
  const engine = makeClaudeEngine(q);
  await assert.rejects(
    engine.run({ system: "s", prompt: "p", workdir: "/wt" }, () => {}),
    /error_max_turns/,
  );
});

test("engine passes read-only options and model to the query fn", async () => {
  let captured: Record<string, unknown> = {};
  const q: QueryFn = ({ options }) => {
    captured = options;
    return (async function* () {
      yield { type: "result", subtype: "success", result: "ok" } as AgentMessage;
    })();
  };
  const engine = makeClaudeEngine(q);
  await engine.run({ system: "sys", prompt: "p", workdir: "/wt", model: "opus", maxTurns: 5 }, () => {});
  assert.equal(captured.permissionMode, "dontAsk");
  assert.equal(captured.model, "opus");
  assert.equal(captured.maxTurns, 5);
  assert.deepEqual(captured.allowedTools, ["Read", "Grep", "Glob", "Bash(gh pr *)"]);
  assert.equal(captured.cwd, "/wt");
  assert.equal(captured.systemPrompt, "sys");
});
