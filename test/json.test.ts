import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { agentJsonSources, parseAgentJson } from "../src/server/json.ts";

const schema = z.object({ a: z.number() });

test("parses a bare JSON object", () => {
  const r = parseAgentJson('{"a": 1}', schema);
  assert.deepEqual(r, { ok: true, value: { a: 1 } });
});

test("parses JSON inside a ```json fence with surrounding prose", () => {
  const raw = 'Here is the result:\n```json\n{"a": 2}\n```\nDone.';
  const r = parseAgentJson(raw, schema);
  assert.deepEqual(r, { ok: true, value: { a: 2 } });
});

test("parses JSON with leading prose and no fence", () => {
  const r = parseAgentJson('Sure. {"a": 3} hope that helps', schema);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.value.a, 3);
});

test("returns ok:false on malformed JSON, does not throw", () => {
  const r = parseAgentJson("not json at all", schema);
  assert.equal(r.ok, false);
});

test("returns ok:false when JSON is valid but fails the schema", () => {
  const r = parseAgentJson('{"a": "str"}', schema);
  assert.equal(r.ok, false);
});

test("skips a stray unmatched leading brace and finds the real fenced object", () => {
  const raw = 'Note: { unmatched. Result:\n```json\n{"a":1}\n```';
  assert.deepEqual(parseAgentJson(raw, schema), { ok: true, value: { a: 1 } });
});
test("skips a coincidental prose {} and finds the real object", () => {
  assert.deepEqual(parseAgentJson('The syntax "{}" is empty. Real: {"a":1}', schema), { ok: true, value: { a: 1 } });
});
test("skips template {{...}} braces and finds the real object", () => {
  assert.deepEqual(parseAgentJson('Use {{name}} then:\n```json\n{"a":1}\n```', schema), { ok: true, value: { a: 1 } });
});
test("handles nested objects and braces inside string values", () => {
  const nested = z.object({ a: z.object({ b: z.number() }), s: z.string() });
  const r = parseAgentJson('{"a":{"b":1},"s":"has } brace"}', nested);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.value.a.b, 1);
});

test("repairs output truncated before the final closing brace", () => {
  // Observed in the wild: a complete plan missing only the root '}'.
  const nested = z.object({ cohorts: z.array(z.object({ label: z.string(), files: z.array(z.object({ path: z.string() })) })) });
  const r = parseAgentJson('{"cohorts":[{"label":"Core","files":[{"path":"x.ts"}]}]', nested);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.value.cohorts[0].files[0].path, "x.ts");
});

test("repairs output truncated mid-array with several closers missing", () => {
  const nested = z.object({ items: z.array(z.object({ n: z.number() })) });
  const r = parseAgentJson('prose first {"items":[{"n":1},{"n":2}', nested);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.value.items.length, 2);
});

test("repairs output truncated inside a string value", () => {
  const s = z.object({ msg: z.string() });
  const r = parseAgentJson('{"msg":"cut off here', s);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.value.msg, "cut off here");
});

test("repair does not resurrect mismatched-bracket garbage", () => {
  assert.equal(parseAgentJson('{"a": [1}', z.object({ a: z.array(z.number()) })).ok, false);
});

// Tool-payload sources: an agent that answers through a tool call (the
// harness's ReportFindings) leaves its final message as prose only.
test("finds the object in a tool payload when the final message is prose only", () => {
  const r = parseAgentJson(["I reviewed this and found one issue.", '{"a":7}'], schema);
  assert.deepEqual(r, { ok: true, value: { a: 7 } });
});

test("prefers the final message over a tool payload when both match", () => {
  const r = parseAgentJson(['{"a":1}', '{"a":2}'], schema);
  assert.equal(r.ok && r.value.a, 1);
});

test("a complete tool payload beats a truncated object in the final message", () => {
  // the final message would only parse via the trailing-closer repair path, so
  // the already-complete payload has to win
  const r = parseAgentJson(['Here it is: {"a":5', '{"a":9}'], schema);
  assert.equal(r.ok && r.value.a, 9);
});

test("still repairs a truncated final message when no tool payload matches", () => {
  const r = parseAgentJson(['Here it is: {"a":5', '{"unrelated":true}'], schema);
  assert.equal(r.ok && r.value.a, 5);
});

test("a later tool payload beats an earlier one (re-report after a rejected call)", () => {
  const sources = agentJsonSources({ text: "prose only", toolPayloads: ['{"a":1}', '{"a":2}'] });
  const r = parseAgentJson(sources, schema);
  assert.equal(r.ok && r.value.a, 2);
});

test("the final message still beats any tool payload", () => {
  const sources = agentJsonSources({ text: '{"a":0}', toolPayloads: ['{"a":1}', '{"a":2}'] });
  const r = parseAgentJson(sources, schema);
  assert.equal(r.ok && r.value.a, 0);
});

test("failure names how many tool payloads were searched", () => {
  const r = parseAgentJson(["prose", "{}", "{}"], schema);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.error : "", /final message \+ 2 tool payload\(s\)/);
});
