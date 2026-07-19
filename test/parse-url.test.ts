import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrUrl } from "../src/server/parse-url.ts";

test("parses owner/repo/number", () => {
  assert.deepEqual(parsePrUrl("https://github.com/plenful/plenful/pull/6727"), {
    owner: "plenful",
    repo: "plenful",
    number: 6727,
  });
});

test("tolerates trailing path/query/fragment", () => {
  assert.deepEqual(parsePrUrl("https://github.com/o/r/pull/12/files?w=1"), {
    owner: "o",
    repo: "r",
    number: 12,
  });
});

test("throws on non-PR url", () => {
  assert.throws(() => parsePrUrl("https://github.com/o/r/issues/1"));
});
