import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { parseAgentJson } from "../src/server/json.ts";

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
