import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrBodySchema, prUrlSchema, dangerRatingSchema, triageResultSchema, findingSchema, findingsArraySchema } from "../src/shared/types.ts";

test("prUrlSchema accepts a valid PR url", () => {
  const r = prUrlSchema.safeParse("https://github.com/plenful/plenful/pull/6727");
  assert.equal(r.success, true);
});

test("prUrlSchema rejects a non-PR github url", () => {
  const r = prUrlSchema.safeParse("https://github.com/plenful/plenful/issues/1");
  assert.equal(r.success, false);
});

test("prUrlSchema accepts PR urls with trailing path/query/fragment suffixes", () => {
  const accept = [
    "https://github.com/o/r/pull/1/",
    "https://github.com/o/r/pull/1/files",
    "https://github.com/o/r/pull/1?diff=split",
    "https://github.com/o/r/pull/1#issuecomment-1",
  ];
  for (const url of accept) {
    assert.equal(prUrlSchema.safeParse(url).success, true, url);
  }
});

test("prUrlSchema rejects malformed PR urls", () => {
  const reject = [
    "https://github.com/o/r/pull/abc",
    "https://github.com/o/r/pull",
    "http://github.com/o/r/pull/1",
  ];
  for (const url of reject) {
    assert.equal(prUrlSchema.safeParse(url).success, false, url);
  }
});

test("createPrBodySchema requires a non-empty urls array", () => {
  assert.equal(createPrBodySchema.safeParse({ urls: [] }).success, false);
  assert.equal(
    createPrBodySchema.safeParse({ urls: ["https://github.com/o/r/pull/1"] }).success,
    true,
  );
});

test("triageResultSchema accepts a well-formed triage result", () => {
  const r = triageResultSchema.safeParse({
    summary: "Adds a retry helper.",
    danger: { level: "medium", reasons: ["touches shared util"], flags: ["api_contract"] },
    focusAreas: ["error handling", "the retry backoff"],
  });
  assert.equal(r.success, true);
});

test("dangerRatingSchema rejects an unknown level", () => {
  assert.equal(
    dangerRatingSchema.safeParse({ level: "spicy", reasons: [], flags: [] }).success,
    false,
  );
});

test("dangerRatingSchema accepts arbitrary flag keys (flags are config-driven)", () => {
  assert.equal(
    dangerRatingSchema.safeParse({ level: "low", reasons: [], flags: ["phi", "custom_flag"] }).success,
    true,
  );
});

test("findingSchema accepts a well-formed finding", () => {
  assert.equal(findingSchema.safeParse({
    engine: "claude", dimension: "correctness", severity: "serious",
    file: "src/x.ts", line: 42, side: "RIGHT",
    what: "off-by-one", why: "loops one past end", suggestedFix: "use <", anchorable: true,
  }).success, true);
});

test("findingSchema rejects an unknown severity", () => {
  assert.equal(findingSchema.safeParse({
    engine: "claude", dimension: "correctness", severity: "spicy",
    file: "x", line: null, side: "RIGHT", what: "w", why: "y", suggestedFix: "f", anchorable: false,
  }).success, false);
});
