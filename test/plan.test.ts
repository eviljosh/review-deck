import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDb, insertPr, updatePr, getPr } from "../src/server/db.ts";
import type { Exec } from "../src/server/exec.ts";
import type { LlmEngine, AgentRequest } from "../src/server/engines/types.ts";
import { runPlan } from "../src/server/plan.ts";
import { diffPaths, diffSections } from "../src/server/diff.ts";
import { stageArtifactDir } from "../src/server/artifacts.ts";

const freshDataDir = () => `${process.env.SCRATCH ?? "/tmp"}/plan-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const DIFF = [
  "diff --git a/x.ts b/x.ts",
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -1,1 +1,2 @@",
  " const a=1;",
  "+const b=2;",
  "diff --git a/y.ts b/y.ts",
  "--- a/y.ts",
  "+++ b/y.ts",
  "@@ -0,0 +1,1 @@",
  "+export const c=3;",
  "",
].join("\n");

function diffExec(): Exec {
  return async () => ({ stdout: DIFF, stderr: "" });
}

function seedTriaged(db: ReturnType<typeof openDb>) {
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  return updatePr(db, pr.id, { title: "T", additions: 3, deletions: 0, worktree_path: "/wt", goal: "Ship the thing." });
}

test("diffPaths and diffSections split a multi-file diff", () => {
  assert.deepEqual(diffPaths(DIFF), ["x.ts", "y.ts"]);
  const sections = diffSections(DIFF);
  assert.match(sections.get("x.ts")!, /\+const b=2;/);
  assert.match(sections.get("y.ts")!, /\+export const c=3;/);
  assert.doesNotMatch(sections.get("y.ts")!, /const b=2/);
});

test("runPlan persists a full-coverage plan in one pass (no retry, no coverage artifact)", async () => {
  const db = openDb(":memory:");
  const pr = seedTriaged(db);
  const dataDir = freshDataDir();
  const calls: AgentRequest[] = [];
  const engine: LlmEngine = { name: "claude", run: async (req) => {
    calls.push(req);
    return { text: JSON.stringify({ cohorts: [
      { label: "Core", why: "The change.", files: [
        { path: "x.ts", class: "crux", role: "r1", walkthrough: "- `b` added." },
        { path: "y.ts", role: "r2" }, // missing class → normalized to substantive
      ] },
      { label: "Empty", why: "dropped", files: [] },
    ] }) };
  } };
  await runPlan({ db, exec: diffExec(), engine, dataDir, onUpdate: () => {} }, pr.id);

  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /READING PLAN/);
  assert.match(calls[0].prompt, /Changed files \(2/);
  assert.match(calls[0].prompt, /1\. x\.ts/);
  const plan = JSON.parse(getPr(db, pr.id)!.reading_plan!);
  assert.equal(plan.cohorts.length, 1); // empty cohort dropped
  assert.equal(plan.cohorts[0].files[1].class, "substantive");
  assert.deepEqual(JSON.parse(getPr(db, pr.id)!.file_guide!).map((f: { path: string }) => f.path), ["x.ts", "y.ts"]);
  assert.ok(!existsSync(join(stageArtifactDir(dataDir, pr.id, "plan"), "plan-coverage.txt")));
});

test("runPlan runs a completeness pass for missed files and merges them into a trailing cohort", async () => {
  const db = openDb(":memory:");
  const pr = seedTriaged(db);
  const dataDir = freshDataDir();
  const calls: AgentRequest[] = [];
  const engine: LlmEngine = { name: "claude", run: async (req) => {
    calls.push(req);
    if (calls.length === 1) {
      return { text: JSON.stringify({ cohorts: [{ label: "Core", why: "", files: [{ path: "x.ts", class: "crux", role: "r1" }] }] }) };
    }
    return { text: JSON.stringify({ files: [{ path: "y.ts", class: "mechanical", role: "re-export only" }] }) };
  } };
  const logs: string[] = [];
  await runPlan({ db, exec: diffExec(), engine, dataDir, onUpdate: () => {}, onLog: (_i, _s, c) => logs.push(c) }, pr.id);

  assert.equal(calls.length, 2);
  assert.match(calls[1].system, /MISSED/);
  assert.match(calls[1].prompt, /File: y\.ts/);
  assert.match(calls[1].prompt, /\+export const c=3;/); // the missed file's own diff section
  assert.doesNotMatch(calls[1].prompt, /const b=2/);    // not the whole diff again
  const plan = JSON.parse(getPr(db, pr.id)!.reading_plan!);
  assert.equal(plan.cohorts.length, 2);
  assert.equal(plan.cohorts[1].label, "Additional files");
  assert.equal(plan.cohorts[1].files[0].path, "y.ts");
  assert.equal(plan.cohorts[1].files[0].class, "mechanical");
  assert.ok(logs.some((l) => l.includes("completeness pass")));
  assert.ok(!existsSync(join(stageArtifactDir(dataDir, pr.id, "plan"), "plan-coverage.txt")));
});

test("runPlan reports residual coverage gaps when the completeness pass also misses", async () => {
  const db = openDb(":memory:");
  const pr = seedTriaged(db);
  const dataDir = freshDataDir();
  let calls = 0;
  const engine: LlmEngine = { name: "claude", run: async () => {
    calls++;
    if (calls === 1) return { text: JSON.stringify({ cohorts: [{ label: "Core", why: "", files: [{ path: "x.ts", class: "crux", role: "r1" }] }] }) };
    return { text: JSON.stringify({ files: [] }) }; // retry recovers nothing
  } };
  const logs: string[] = [];
  await runPlan({ db, exec: diffExec(), engine, dataDir, onUpdate: () => {}, onLog: (_i, _s, c) => logs.push(c) }, pr.id);

  // The partial plan still persists — a gap degrades, it doesn't destroy.
  const plan = JSON.parse(getPr(db, pr.id)!.reading_plan!);
  assert.equal(plan.cohorts.length, 1);
  assert.ok(logs.some((l) => l.includes("plan coverage gap") && l.includes("y.ts")));
  assert.ok(existsSync(join(stageArtifactDir(dataDir, pr.id, "plan"), "plan-coverage.txt")));
});

test("runPlan throws when the first pass returns unparseable output", async () => {
  const db = openDb(":memory:");
  const pr = seedTriaged(db);
  const engine: LlmEngine = { name: "claude", run: async () => ({ text: "sorry, no" }) };
  await assert.rejects(
    runPlan({ db, exec: diffExec(), engine, dataDir: freshDataDir(), onUpdate: () => {} }, pr.id),
    /plan JSON parse failed/,
  );
  assert.equal(getPr(db, pr.id)!.reading_plan, null);
});
