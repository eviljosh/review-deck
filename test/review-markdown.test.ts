import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, insertPr, updatePr, insertFinding, listFindings } from "../src/server/db.ts";
import { buildReviewMarkdown } from "../src/shared/review-markdown.ts";

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
    discussion: "@alice pushed back on the retry cap; unresolved.",
    flow_delta: JSON.stringify({ mermaid: "flowchart LR\n  A --> B", caption: "B now retries." }),
    reading_plan: JSON.stringify({ cohorts: [
      { label: "Core logic", why: "Where the behavior changes.", files: [
        { path: "src/retry.ts", class: "crux", role: "The retry wrapper itself.", ripple: "`src/jobs.ts:88` still assumes fetch throws on first failure." },
      ] },
      { label: "Mechanical", why: "", files: [
        { path: "src/index.ts", class: "mechanical", role: "Re-export only." },
      ] },
    ] }),
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
  assert.match(md, /## Discussion so far/);
  assert.match(md, /@alice pushed back on the retry cap/);
  assert.match(md, /## Flow delta/);
  assert.match(md, /```mermaid\nflowchart LR/);
  assert.match(md, /B now retries\./);
  assert.match(md, /## Reading plan/);
  assert.match(md, /### Core logic/);
  assert.match(md, /`src\/retry\.ts` _\(crux\)_ — The retry wrapper itself\./);
  assert.match(md, /⚠ ripple: `src\/jobs\.ts:88` still assumes fetch throws on first failure\./);
  assert.match(md, /`src\/index\.ts` _\(mechanical\)_ — Re-export only\./);
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

test("the Size line reports the diff that was reviewed, not GitHub's counters", () => {
  const db = openDb(":memory:");
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/7218", owner: "o", repo: "r", number: 7218 });
  // GitHub's counters describe a different change: they froze while the PR was
  // conflicted, and prepare pinned against the base branch tip instead.
  const updated = updatePr(db, pr.id, {
    title: "stacked", stage: "ready", status: "done",
    additions: 1656, deletions: 16, changed_files: 11,
    head_sha: "dc15610ec6de1139", base_sha: "52cfc030f8db2fd0", base_mode: "base-tip",
    reviewed_size: JSON.stringify({ additions: 764, deletions: 23, changedFiles: 8 }),
  });
  const md = buildReviewMarkdown(updated, listFindings(db, pr.id));
  assert.ok(md.includes("- Size: +764/-23 across 8 file(s)"), md.slice(0, 400));
  assert.ok(!md.includes("1656"));
  assert.ok(md.includes("base branch tip `52cfc030f8db`"));
});

test("the Size line falls back to GitHub's counters for rows with no reviewed size", () => {
  const db = openDb(":memory:");
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  const updated = updatePr(db, pr.id, { stage: "ready", status: "done", additions: 40, deletions: 8, changed_files: 3 });
  const md = buildReviewMarkdown(updated, listFindings(db, pr.id));
  assert.ok(md.includes("- Size: +40/-8 across 3 file(s)"));
});
