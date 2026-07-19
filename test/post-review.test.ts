import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPayload, ROBOT_MARKER } from "../src/server/post-review.ts";
import type { StoredFinding } from "../src/shared/types.ts";

function f(over: Partial<StoredFinding>): StoredFinding {
  return { id: 1, pr_id: 1, engine: "claude", dimension: "correctness", severity: "serious",
    file: "x.ts", line: 3, side: "RIGHT", what: "w", why: "y", suggestedFix: "fix it",
    anchorable: true, agreement: false, selected: true, posted: false, reviewerNote: null, ...over };
}

test("a reviewer note leads the comment, above an AI disclaimer", () => {
  const p = buildReviewPayload("", [f({ reviewerNote: "This bit us in prod last quarter — please fix before merge." })]);
  const body = p.comments[0].body;
  const noteIdx = body.indexOf("bit us in prod");
  const disclaimerIdx = body.indexOf("AI-generated below this line");
  const whatIdx = body.indexOf("**[serious]**");
  assert.ok(noteIdx >= 0 && disclaimerIdx > noteIdx && whatIdx > disclaimerIdx, body);
});

test("findings without a reviewer note carry no disclaimer line", () => {
  const p = buildReviewPayload("", [f({})]);
  assert.doesNotMatch(p.comments[0].body, /AI-generated below this line/);
});

test("anchorable selected findings become inline comments", () => {
  const p = buildReviewPayload("Take a look:", [f({ id: 1, line: 3, anchorable: true })]);
  assert.equal(p.comments.length, 1);
  assert.equal(p.comments[0].path, "x.ts");
  assert.equal(p.comments[0].line, 3);
  assert.equal(p.comments[0].side, "RIGHT");
  assert.match(p.comments[0].body, /w/);
});

test("inline comment body breaks header/what/why/fix into separate paragraphs", () => {
  const p = buildReviewPayload("", [
    f({ id: 1, severity: "moderate", what: "The problem", why: "The impact", suggestedFix: "Do this" }),
  ]);
  const body = p.comments[0].body;
  // header: severity + backticked location + engine tag
  assert.match(body, /\*\*\[moderate\]\*\* `x\.ts:3`/);
  // paragraphs are blank-line separated, not run together
  assert.ok(body.includes("The problem\n\nThe impact"), body);
  assert.match(body, /\*\*Suggested fix:\*\* Do this/);
});

test("agreement findings get the 🤝 marker in the header", () => {
  const p = buildReviewPayload("", [f({ id: 1, agreement: true, engine: "claude+codex" })]);
  assert.match(p.comments[0].body, /claude\+codex 🤝/);
});

test("body has preface + robot marker; non-anchorable selected findings go in the body", () => {
  const p = buildReviewPayload("Take a look:", [f({ id: 2, anchorable: false, what: "orphan" })]);
  assert.match(p.body, /^Take a look:/);
  assert.ok(p.body.includes(ROBOT_MARKER));
  assert.match(p.body, /orphan/);
  assert.equal(p.comments.length, 0);
});

test("unselected findings are excluded entirely", () => {
  const p = buildReviewPayload("hi", [f({ id: 3, selected: false })]);
  assert.equal(p.comments.length, 0);
  assert.doesNotMatch(p.body, /Fix: fix it/);
});

function uc(over: Partial<import("../src/shared/types.ts").UserComment>): import("../src/shared/types.ts").UserComment {
  return { id: 1, pr_id: 1, file: "x.ts", line: 5, side: "RIGHT", body: "human note", posted: false, created_at: "", ...over };
}

test("anchored user comments post inline, verbatim, without the bot sentinel", () => {
  const p = buildReviewPayload("", [], undefined, [uc({ line: 5, body: "this races with the retry loop" })]);
  assert.equal(p.comments.length, 1);
  assert.equal(p.comments[0].path, "x.ts");
  assert.equal(p.comments[0].line, 5);
  assert.equal(p.comments[0].body, "this races with the retry loop"); // no sentinel — human words
});

test("file-level user comments land in the body before the robot marker", () => {
  const p = buildReviewPayload("Preface.", [], "🤖 marker", [uc({ line: null, body: "overall this file needs tests" })]);
  const noteIdx = p.body.indexOf("overall this file needs tests");
  const markerIdx = p.body.indexOf("🤖 marker");
  assert.ok(noteIdx >= 0 && markerIdx >= 0 && noteIdx < markerIdx, p.body);
});

test("a custom marker replaces the default", () => {
  const p = buildReviewPayload("", [f({})], "🤖 custom disclosure");
  assert.match(p.body, /🤖 custom disclosure/);
  assert.doesNotMatch(p.body, /at the reviewer's request/);
});
