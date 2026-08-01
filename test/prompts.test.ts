import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTriagePrompt, buildDimensionReviewPrompt, buildFullDiffReviewPrompt, buildFinalizerPrompt, buildPlanPrompt, buildPlanRetryPrompt, PROMPT_INJECTION_GUARD } from "../src/server/prompts.ts";

test("buildTriagePrompt embeds rubric, JSON contract, metadata, and diff", () => {
  const { system, prompt } = buildTriagePrompt(
    { title: "Add retry", author: "octocat", additions: 10, deletions: 2, changedFiles: 3 },
    "diff --git a/x b/x\n+retry",
  );
  // rubric axes + JSON contract live in the system prompt
  assert.match(system, /blast radius/i);
  assert.match(system, /db_migration/);
  assert.match(system, /summary/);
  // focusAreas was deprecated in favor of the finalizer's reading plan
  assert.doesNotMatch(system, /focusAreas/);
  // metadata + diff live in the user prompt
  assert.match(prompt, /Add retry/);
  assert.match(prompt, /octocat/);
  assert.match(prompt, /diff --git/);
  // no discussion → the prompt shows the (none) fallback and asks for a discussion field
  assert.match(system, /discussion/i);
  assert.match(prompt, /\(none\)/);
});

test("buildTriagePrompt embeds existing review activity when provided", () => {
  const { prompt } = buildTriagePrompt(
    { title: "T", author: "u", additions: 1, deletions: 0, changedFiles: 1 },
    "diff --git a b",
    "Review by alice [CHANGES_REQUESTED]: fix the migration",
  );
  assert.match(prompt, /Existing review activity/);
  assert.match(prompt, /CHANGES_REQUESTED/);
});

test("buildTriagePrompt asks for a headline and embeds PR body + Linear context", () => {
  const { system, prompt } = buildTriagePrompt(
    { title: "T", author: "u", body: "This fixes the slow refresh path.", additions: 1, deletions: 0, changedFiles: 1 },
    "diff --git a b",
    "",
    "### ENG-42 — Speed up refresh (In Progress)\nRefresh is slow.",
  );
  assert.match(system, /headline/);
  assert.match(prompt, /PR description:/);
  assert.match(prompt, /slow refresh path/);
  assert.match(prompt, /Linked Linear ticket/);
  assert.match(prompt, /ENG-42/);
});

test("buildPlanPrompt asks for cohorts with attention classes over an explicit file list", () => {
  const { system, prompt } = buildPlanPrompt(
    { title: "Add retries", additions: 40, deletions: 8 },
    "diff --git a/x.ts b/x.ts\n+1",
    ["x.ts", "y.ts"],
    "Ship the retry path",
  );
  assert.match(system, /READING PLAN/);
  assert.match(system, /cohorts/i);
  assert.match(system, /"class": "crux"\|"substantive"\|"boilerplate"\|"mechanical"/);
  // conservative-classification guardrail
  assert.match(system, /never mechanical/i);
  // the file list is authoritative — classify every path, invent none
  assert.match(system, /Classify EVERY/);
  assert.match(system, /Do NOT include any path that is not on the list/);
  // ripple notes: out-of-diff caller impact, explicitly optional
  assert.match(system, /"ripple"/);
  assert.match(system, /OUTSIDE this diff/);
  assert.match(system, /OMIT the/);
  // the prompt carries the numbered list, the intent, and the diff
  assert.match(prompt, /Changed files \(2/);
  assert.match(prompt, /1\. x\.ts/);
  assert.match(prompt, /2\. y\.ts/);
  assert.match(prompt, /Ship the retry path/);
  assert.match(prompt, /diff --git/);
});

test("buildPlanRetryPrompt targets only the missed files with their diff sections", () => {
  const { system, prompt } = buildPlanRetryPrompt([
    { path: "y.ts", diff: "diff --git a/y.ts b/y.ts\n+export const c=3;" },
  ]);
  assert.match(system, /MISSED/);
  assert.match(system, /Every listed path must appear exactly once/);
  assert.match(prompt, /File: y\.ts/);
  assert.match(prompt, /export const c=3/);
});

test("buildFinalizerPrompt no longer asks for the reading plan (owned by the plan stage)", () => {
  const { system } = buildFinalizerPrompt([]);
  assert.doesNotMatch(system, /"plan"/);
  assert.doesNotMatch(system, /"cohorts"/);
  assert.doesNotMatch(system, /"themes"/);
  assert.doesNotMatch(system, /"theme": string/);
});

test("buildFinalizerPrompt embeds the plan's classes as impact context when provided", () => {
  const { system } = buildFinalizerPrompt([], {
    planFiles: [
      { path: "a.ts", class: "crux" },
      { path: "b.ts", class: "mechanical" },
    ],
  });
  assert.match(system, /reading plan/i);
  assert.match(system, /crux: a\.ts/);
  assert.match(system, /mechanical: b\.ts/);
  assert.doesNotMatch(buildFinalizerPrompt([]).system, /reading plan/i);
});

test("every review/triage/finalizer prompt carries the prompt-injection guard", () => {
  const meta = { title: "T", author: "u", additions: 1, deletions: 0, changedFiles: 1 };
  const guardHead = PROMPT_INJECTION_GUARD.split("\n")[0];
  assert.ok(buildTriagePrompt(meta, "d").system.includes(guardHead));
  assert.ok(buildDimensionReviewPrompt({ key: "security", guidance: "injection, authz gaps, data loss" }, meta, "d").system.includes(guardHead));
  assert.ok(buildFullDiffReviewPrompt(meta, "d").system.includes(guardHead));
  assert.ok(buildFinalizerPrompt([]).system.includes(guardHead));
});

test("buildDimensionReviewPrompt embeds the dimension focus + findings contract + diff", () => {
  const meta = { title: "T", author: "u", additions: 1, deletions: 0, changedFiles: 1 };
  const { system, prompt } = buildDimensionReviewPrompt({ key: "security", guidance: "injection, authz gaps, data loss" }, meta, "diff --git a b");
  assert.match(system, /security|data.loss/i);
  assert.match(system, /"severity"/);
  assert.match(system, /blocking|serious|moderate|optional/);
  assert.match(prompt, /diff --git/);
});

test("buildFullDiffReviewPrompt embeds the findings contract + diff", () => {
  const meta = { title: "T", author: "u", additions: 1, deletions: 0, changedFiles: 1 };
  const { system, prompt } = buildFullDiffReviewPrompt(meta, "diff --git a b");
  assert.match(system, /"file"/);
  assert.match(prompt, /diff --git/);
});

test("buildFinalizerPrompt is source-blind and embeds the raw findings", () => {
  const { system, prompt } = buildFinalizerPrompt([
    { engine: "claude", dimension: "correctness", severity: "serious", file: "x", line: 1, side: "RIGHT", what: "w", why: "y", suggestedFix: "f", anchorable: true },
  ]);
  assert.match(system, /agree|both|confidence/i);
  assert.doesNotMatch(system, /prefer (claude|codex)/i); // source-blind
  assert.match(prompt, /"what": ?"w"|"what":"w"/);
});

test("buildFinalizerPrompt asks for per-finding source engines", () => {
  const { system } = buildFinalizerPrompt([]);
  assert.match(system, /"sources"/);
  assert.match(system, /which engines|source engine/i);
});

test("buildTriagePrompt asks for an optional delta flow diagram", () => {
  const { system } = buildTriagePrompt(
    { title: "T", author: "u", additions: 1, deletions: 0, changedFiles: 1 },
    "d",
  );
  assert.match(system, /flowDelta/);
  assert.match(system, /TOPOLOGY/);
  assert.match(system, /classDef added/);
  assert.match(system, /classDef removed/);
  // null-by-default framing — most PRs need no diagram
  assert.match(system, /null for MOST PRs/i);
});

test("buildTriagePrompt asks for goal and goalAssessment", () => {
  const { system } = buildTriagePrompt(
    { title: "T", author: "u", additions: 1, deletions: 0, changedFiles: 1 },
    "d",
  );
  assert.match(system, /"goal": string/);
  assert.match(system, /goalAssessment/);
  assert.match(system, /achieves.*partially.*does-not.*unclear/s);
  assert.match(system, /gaps/);
});

test("review prompts embed the distilled intent when provided", () => {
  const meta = { title: "T", author: "u", additions: 1, deletions: 0, changedFiles: 1 };
  const dim = buildDimensionReviewPrompt({ key: "security", guidance: "injection" }, meta, "d", "Fix the slow refresh path");
  assert.match(dim.prompt, /Distilled intent/);
  assert.match(dim.prompt, /slow refresh path/);
  const full = buildFullDiffReviewPrompt(meta, "d", "Fix the slow refresh path");
  assert.match(full.prompt, /Distilled intent/);
  // and is omitted when absent
  assert.doesNotMatch(buildFullDiffReviewPrompt(meta, "d").prompt, /Distilled intent/);
});

test("buildFinalizerPrompt embeds past rejected examples as deprioritization guidance", () => {
  const { system } = buildFinalizerPrompt([], { rejectedExamples: ["[optional/maintainability] naming nit"] });
  assert.match(system, /chose NOT to post/);
  assert.match(system, /naming nit/);
  assert.doesNotMatch(buildFinalizerPrompt([]).system, /chose NOT to post/);
});

test("buildFinalizerPrompt asks for impact + verdict and embeds the goal context", () => {
  const { system } = buildFinalizerPrompt([], { goal: "Ship retries", goalVerdict: "partially" });
  assert.match(system, /"impact": "high"\|"medium"\|"low"/);
  assert.match(system, /"verdict": string/);
  assert.match(system, /Ship retries/);
  assert.match(system, /partially/);
  // goal block omitted without context
  assert.doesNotMatch(buildFinalizerPrompt([]).system, /distilled goal/);
});

test("buildFinalizerPrompt embeds prior-review findings with reconcile instructions", () => {
  const { system } = buildFinalizerPrompt([], {
    priorFindings: [{ file: "a.ts", line: 12, severity: "serious", what: "races with retry loop", suggestedFix: "lock it" }],
  });
  assert.match(system, /PREVIOUS review of an EARLIER commit/);
  assert.match(system, /\[serious\] a\.ts:12 — races with retry loop/);
  assert.match(system, /do NOT re-report/);
  assert.match(system, /what improved and what remains open/);
  assert.doesNotMatch(buildFinalizerPrompt([]).system, /PREVIOUS review/);
});
