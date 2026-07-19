import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, insertPr, updatePr, insertFinding, listFindings } from "../src/server/db.ts";
import { buildReviewMarkdown } from "../src/ui/reviewMarkdown.ts";

function seedReviewed() {
  const db = openDb(":memory:");
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  updatePr(db, pr.id, {
    title: "Add retries", author: "octocat", additions: 40, deletions: 8, changed_files: 3,
    stage: "ready", status: "done", head_sha: "abc123def4567890", base_sha: "0000111122223333",
    goal: "Make the refresh path resilient to transient failures.",
    goal_verdict: "partially", goal_explanation: "Retries reads but not writes.",
    goal_gaps: JSON.stringify(["write path still fails hard"]),
    summary: "Adds a retry wrapper around fetches.",
    review_verdict: "Sound approach; the unbounded retry loop is the main risk.",
    danger_level: "medium",
    danger_reasons: JSON.stringify(["touches a shared util"]),
    danger_flags: JSON.stringify(["api_contract"]),
    focus_areas: JSON.stringify(["verify backoff cap"]),
  });
  insertFinding(db, pr.id, {
    engine: "claude+codex", dimension: "correctness", severity: "serious", file: "src/retry.ts", line: 12,
    side: "RIGHT", what: "retry loop has no upper bound", why: "a permanent failure spins forever",
    suggestedFix: "cap attempts at 5", anchorable: true, agreement: true, impact: "high", selected: true,
  });
  insertFinding(db, pr.id, {
    engine: "claude", dimension: "maintainability", severity: "optional", file: "src/retry.ts", line: 30,
    side: "RIGHT", what: "naming nit", why: "", suggestedFix: "", anchorable: true, agreement: false, impact: "low",
  });
  return { db, pr: updatePr(db, pr.id, {}), findings: listFindings(db, pr.id) };
}

test("buildReviewMarkdown includes header, goal+verdict+gaps, bottom line, rating, and findings", () => {
  const { pr, findings } = seedReviewed();
  const md = buildReviewMarkdown(pr, findings);
  assert.match(md, /# Code review: Add retries \(o\/r#5\)/);
  assert.match(md, /Reviewed at commit `abc123def4567890`/);
  assert.match(md, /## Goal/);
  assert.match(md, /partially achieves the goal — Retries reads but not writes\./);
  assert.match(md, /write path still fails hard/);
  assert.match(md, /## Bottom line/);
  assert.match(md, /unbounded retry loop/);
  assert.match(md, /## Why the medium rating/);
  assert.match(md, /touches a shared util/);
  assert.match(md, /## Findings \(2\)/);
  assert.match(md, /`src\/retry\.ts:12` — retry loop has no upper bound/);
  assert.match(md, /impact: high · serious · claude\+codex · cross-model agreement/);
  assert.match(md, /deselected by reviewer/); // the unselected nit is marked
  assert.match(md, /gh pr checkout 5 --repo o\/r/);
});

test("buildReviewMarkdown includes the reviewer's own comments when present", () => {
  const { pr, findings } = seedReviewed();
  const md = buildReviewMarkdown(pr, findings, [
    { id: 1, pr_id: pr.id, file: "src/retry.ts", line: 20, side: "RIGHT", body: "double-check jitter here", posted: false, created_at: "" },
  ]);
  assert.match(md, /## Reviewer's own comments \(1\)/);
  assert.match(md, /`src\/retry\.ts:20` — double-check jitter here/);
});

test("buildReviewMarkdown degrades gracefully with a sparse record", () => {
  const db = openDb(":memory:");
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/9", owner: "o", repo: "r", number: 9 });
  const md = buildReviewMarkdown(pr, []);
  assert.match(md, /# Code review: PR #9/);
  assert.doesNotMatch(md, /## Goal|## Findings|## Bottom line/);
});
