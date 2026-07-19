import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCodexEngine } from "../src/server/engines/codex.ts";
import { AgentTimeoutError, type CodexRunner } from "../src/server/engines/types.ts";

test("codex engine returns the runner text and logs it", async () => {
  const runner: CodexRunner = async () => ({ text: '{"findings":[]}' });
  const engine = makeCodexEngine(runner);
  const logs: string[] = [];
  const res = await engine.run({ system: "s", prompt: "p", workdir: "/wt" }, (c) => logs.push(c));
  assert.equal(res.text, '{"findings":[]}');
  assert.equal(engine.name, "codex");
  assert.ok(logs.join("").length > 0);
});

test("codex engine passes system/prompt/workdir/model/reasoningEffort to the runner", async () => {
  let captured: Record<string, unknown> = {};
  const runner: CodexRunner = async (input) => { captured = input; return { text: "ok" }; };
  const engine = makeCodexEngine(runner);
  await engine.run({ system: "sys", prompt: "pr", workdir: "/wt", model: "gpt-5.6", reasoningEffort: "high" }, () => {});
  assert.equal(captured.system, "sys");
  assert.equal(captured.prompt, "pr");
  assert.equal(captured.workdir, "/wt");
  assert.equal(captured.model, "gpt-5.6");
  assert.equal(captured.reasoningEffort, "high");
});

test("codex engine omits model/reasoningEffort when unset (inherits CLI config)", async () => {
  let captured: Record<string, unknown> = {};
  const runner: CodexRunner = async (input) => { captured = input; return { text: "ok" }; };
  const engine = makeCodexEngine(runner);
  await engine.run({ system: "s", prompt: "p", workdir: "/wt" }, () => {});
  assert.ok(!("model" in captured));
  assert.ok(!("reasoningEffort" in captured));
});

test("codex engine times out when the runner hangs", async () => {
  const runner: CodexRunner = () => new Promise((r) => setTimeout(() => r({ text: "late" }), 1000));
  const engine = makeCodexEngine(runner);
  await assert.rejects(
    engine.run({ system: "s", prompt: "p", workdir: "/wt", timeoutMs: 30 }, () => {}),
    AgentTimeoutError,
  );
});
