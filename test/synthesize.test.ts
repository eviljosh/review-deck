import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, insertPr, updatePr, listFindings, getPr } from "../src/server/db.ts";
import type { Exec } from "../src/server/exec.ts";
import type { LlmEngine } from "../src/server/engines/types.ts";
import type { Finding } from "../src/shared/types.ts";
import { runSynthesize } from "../src/server/synthesize.ts";

// Isolated per-test artifact dir: stages read pinned artifacts by pr id, so a
// shared dataDir would leak artifacts across test files.
const freshDataDir = () => `${process.env.SCRATCH ?? "/tmp"}/synth-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const DIFF = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,2 @@\n const a=1;\n+const b=2;\n";
function diffExec(): Exec { return async () => ({ stdout: DIFF, stderr: "" }); }
function seedDeepReviewed(db: ReturnType<typeof openDb>) {
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  return updatePr(db, pr.id, { stage: "deep_review", status: "done", worktree_path: "/wt" });
}
const raw: Finding[] = [
  { engine: "claude", dimension: "correctness", severity: "serious", file: "x.ts", line: 2, side: "RIGHT", what: "w", why: "y", suggestedFix: "f", anchorable: false },
  { engine: "codex", dimension: "full", severity: "serious", file: "x.ts", line: 2, side: "RIGHT", what: "w", why: "y", suggestedFix: "f", anchorable: false },
];

test("runSynthesize persists finalized findings, marks anchorable, advances to ready", async () => {
  const db = openDb(":memory:");
  const pr = seedDeepReviewed(db);
  const finalizer: LlmEngine = { name: "claude", run: async () => ({ text: JSON.stringify({ findings: [
    { dimension: "correctness", severity: "serious", file: "x.ts", line: 2, side: "RIGHT", what: "w", why: "y", suggestedFix: "f", sources: ["claude", "codex"], agreement: true },
  ] }) }) };
  const result = await runSynthesize(
    { db, exec: diffExec(), finalizer, dataDir: freshDataDir(), onUpdate: () => {} },
    pr.id, raw,
  );
  assert.equal(result.stage, "ready");
  assert.equal(result.status, "done");
  const findings = listFindings(db, pr.id);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].engine, "claude+codex");
  assert.equal(findings[0].agreement, true);
  assert.equal(findings[0].anchorable, true); // line 2 is in the diff
  assert.equal(findings[0].selected, true); // serious + agreement → pre-selected
});

test("runSynthesize persists the cohort reading plan and a flattened file_guide", async () => {
  const db = openDb(":memory:");
  const pr = seedDeepReviewed(db);
  const finalizer: LlmEngine = { name: "claude", run: async () => ({ text: JSON.stringify({
    plan: { cohorts: [
      { label: "Core logic", why: "Where the behavior changes.", files: [
        { path: "x.ts", class: "crux", role: "The decision.", walkthrough: "- `run()` drives the retry loop." },
      ] },
      { label: "Mechanical", why: "Renames only.", files: [
        { path: "y.ts", class: "mechanical", role: "Rename `Foo`→`Bar` — no logic change." },
      ] },
      { label: "Empty", why: "dropped", files: [] },
    ] },
    findings: [
      { dimension: "security", severity: "blocking", file: "x.ts", line: 2, side: "RIGHT", what: "w", why: "y", suggestedFix: "f", sources: ["claude"], agreement: false },
    ],
  }) }) };
  const result = await runSynthesize(
    { db, exec: diffExec(), finalizer, dataDir: freshDataDir(), onUpdate: () => {} },
    pr.id, raw,
  );
  assert.equal(result.stage, "ready");
  const plan = JSON.parse(result.reading_plan!);
  assert.equal(plan.cohorts.length, 2); // empty cohort dropped
  assert.equal(plan.cohorts[0].label, "Core logic");
  assert.equal(plan.cohorts[0].files[0].class, "crux");
  assert.equal(plan.cohorts[1].files[0].class, "mechanical");
  // flat guide mirrors the plan order for anything still reading file_guide
  assert.deepEqual(JSON.parse(result.file_guide!).map((f: { path: string }) => f.path), ["x.ts", "y.ts"]);
});

test("runSynthesize defaults a missing class to substantive (never auto-collapse unclassified)", async () => {
  const db = openDb(":memory:");
  const pr = seedDeepReviewed(db);
  const finalizer: LlmEngine = { name: "claude", run: async () => ({ text: JSON.stringify({
    plan: { cohorts: [{ label: "All", why: "", files: [{ path: "x.ts", role: "r" }] }] },
    findings: [
      { dimension: "correctness", severity: "serious", file: "x.ts", line: 2, side: "RIGHT", what: "w", why: "y", suggestedFix: "f", sources: ["claude"], agreement: false },
    ],
  }) }) };
  const result = await runSynthesize(
    { db, exec: diffExec(), finalizer, dataDir: freshDataDir(), onUpdate: () => {} },
    pr.id, raw,
  );
  assert.equal(JSON.parse(result.reading_plan!).cohorts[0].files[0].class, "substantive");
});

test("runSynthesize stores impact, verdict, and impact-driven selection", async () => {
  const db = openDb(":memory:");
  const pr = seedDeepReviewed(db);
  updatePr(db, pr.id, { goal: "Ship the retry path", goal_verdict: "partially" });
  let seenSystem = "";
  const finalizer: LlmEngine = { name: "claude", run: async (req) => {
    seenSystem = req.system;
    return { text: JSON.stringify({
      verdict: "Achieves the goal; the unbounded retry loop is the one thing to check.",
      findings: [
        { dimension: "correctness", severity: "serious", impact: "high", file: "x.ts", line: 2, side: "RIGHT", what: "w1", why: "y", suggestedFix: "f", sources: ["claude"], agreement: false },
        { dimension: "maintainability", severity: "serious", impact: "low", file: "x.ts", line: 2, side: "RIGHT", what: "w2", why: "y", suggestedFix: "f", sources: ["codex"], agreement: false },
      ],
    }) };
  } };
  const result = await runSynthesize(
    { db, exec: diffExec(), finalizer, dataDir: freshDataDir(), onUpdate: () => {} },
    pr.id, raw,
  );
  assert.match(result.review_verdict!, /unbounded retry loop/);
  assert.match(seenSystem, /Ship the retry path/); // goal fed to the finalizer
  const findings = listFindings(db, pr.id);
  assert.equal(findings[0].impact, "high");
  assert.equal(findings[0].selected, true);   // high impact → pre-selected
  assert.equal(findings[1].impact, "low");
  assert.equal(findings[1].selected, false);  // impact overrides the severity rule
});

test("runSynthesize degrades a legacy flat files guide into a single-cohort plan", async () => {
  const db = openDb(":memory:");
  const pr = seedDeepReviewed(db);
  const finalizer: LlmEngine = { name: "claude", run: async () => ({ text: JSON.stringify({
    files: [{ path: "x.ts", role: "Core logic of the change.", walkthrough: "- `run()` drives the retry loop — unbounded, see finding 1." }],
    findings: [
      { dimension: "correctness", severity: "serious", file: "x.ts", line: 2, side: "RIGHT", what: "w", why: "y", suggestedFix: "f", sources: ["claude"], agreement: false },
    ],
  }) }) };
  const result = await runSynthesize(
    { db, exec: diffExec(), finalizer, dataDir: freshDataDir(), onUpdate: () => {} },
    pr.id, raw,
  );
  assert.deepEqual(JSON.parse(result.file_guide!), [
    { path: "x.ts", role: "Core logic of the change.", walkthrough: "- `run()` drives the retry loop — unbounded, see finding 1." },
  ]);
  const plan = JSON.parse(result.reading_plan!);
  assert.equal(plan.cohorts.length, 1);
  assert.equal(plan.cohorts[0].files[0].class, "substantive"); // legacy entries never auto-collapse
});

test("runSynthesize feeds past rejected examples into the finalizer only when enabled", async () => {
  const db = openDb(":memory:");
  const pr = seedDeepReviewed(db);
  db.prepare(
    "INSERT INTO finding_feedback (owner, repo, dimension, severity, what, decision) VALUES ('o','r','tests','optional','missing test for logging','rejected')",
  ).run();
  let seenSystem = "";
  const finalizer: LlmEngine = { name: "claude", run: async (req) => {
    seenSystem = req.system;
    return { text: JSON.stringify({ findings: [] }) };
  } };
  await runSynthesize(
    { db, exec: diffExec(), finalizer, dataDir: freshDataDir(), feedbackEnabled: true, onUpdate: () => {} },
    pr.id, raw,
  );
  assert.match(seenSystem, /missing test for logging/);

  // default (flag off): the stored examples are NOT injected
  seenSystem = "";
  await runSynthesize(
    { db, exec: diffExec(), finalizer, dataDir: freshDataDir(), onUpdate: () => {} },
    pr.id, raw,
  );
  assert.doesNotMatch(seenSystem, /missing test for logging/);
});

test("runSynthesize forwards extended-thinking to the finalizer only when provided", async () => {
  const db = openDb(":memory:");
  const pr = seedDeepReviewed(db);
  let seenThinking: unknown;
  let seenEffort: unknown;
  const finalizer: LlmEngine = { name: "claude", run: async (req) => {
    seenThinking = req.thinking;
    seenEffort = req.effort;
    return { text: JSON.stringify({ findings: [] }) };
  } };

  await runSynthesize(
    { db, exec: diffExec(), finalizer, dataDir: freshDataDir(), thinking: { type: "adaptive" }, effort: "xhigh", onUpdate: () => {} },
    pr.id, raw,
  );
  assert.deepEqual(seenThinking, { type: "adaptive" });
  assert.equal(seenEffort, "xhigh");

  // not provided → the finalizer request carries neither
  seenThinking = "sentinel";
  seenEffort = "sentinel";
  await runSynthesize(
    { db, exec: diffExec(), finalizer, dataDir: freshDataDir(), onUpdate: () => {} },
    pr.id, raw,
  );
  assert.equal(seenThinking, undefined);
  assert.equal(seenEffort, undefined);
});

test("runSynthesize with empty raw findings advances to ready with none", async () => {
  const db = openDb(":memory:");
  const pr = seedDeepReviewed(db);
  const finalizer: LlmEngine = { name: "claude", run: async () => { throw new Error("should not be called"); } };
  const result = await runSynthesize(
    { db, exec: diffExec(), finalizer, dataDir: freshDataDir(), onUpdate: () => {} },
    pr.id, [],
  );
  assert.equal(result.stage, "ready");
  assert.equal(listFindings(db, pr.id).length, 0);
});

test("runSynthesize degrades (keeps raw) when finalizer returns bad JSON", async () => {
  const db = openDb(":memory:");
  const pr = seedDeepReviewed(db);
  const finalizer: LlmEngine = { name: "claude", run: async () => ({ text: "not json" }) };
  const result = await runSynthesize(
    { db, exec: diffExec(), finalizer, dataDir: freshDataDir(), onUpdate: () => {} },
    pr.id, raw,
  );
  assert.equal(result.status, "degraded");
  const kept = listFindings(db, pr.id);
  assert.equal(kept.length, 2); // raw pooled findings kept
  assert.ok(kept.every((f) => f.selected)); // serious raw findings stay pre-selected
});

test("runSynthesize feeds the prior_findings snapshot into the finalizer prompt", async () => {
  const db = openDb(":memory:");
  const pr = seedDeepReviewed(db);
  updatePr(db, pr.id, {
    prior_findings: JSON.stringify([{ file: "a.ts", line: 3, severity: "serious", what: "old bug", suggestedFix: "fix" }]),
  });
  let seenSystem = "";
  const finalizer: LlmEngine = {
    name: "claude",
    run: async (req) => {
      seenSystem = req.system;
      return { text: JSON.stringify({ findings: [] }) };
    },
  };
  await runSynthesize({ db, exec: diffExec(), finalizer, dataDir: freshDataDir(), onUpdate: () => {} }, pr.id, raw);
  assert.match(seenSystem, /PREVIOUS review/);
  assert.match(seenSystem, /old bug/);
});
