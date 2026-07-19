import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, insertPr, getPr, updatePr } from "../src/server/db.ts";
import type { Exec } from "../src/server/exec.ts";
import type { LlmEngine } from "../src/server/engines/types.ts";
import { runTriage } from "../src/server/triage.ts";

// Isolated per-test artifact dir: stages read pinned artifacts by pr id, so a
// shared dataDir would leak artifacts across test files.
const freshDataDir = () => `${process.env.SCRATCH ?? "/tmp"}/triage-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function ghExec(): Exec {
  return async (cmd, args) => {
    if (cmd === "gh" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          title: "T", author: { login: "u" }, additions: 1, deletions: 0, changedFiles: 1,
        }),
        stderr: "",
      };
    }
    return { stdout: "diff --git a/x b/x\n+1", stderr: "" }; // gh diff
  };
}

function engineReturning(text: string): LlmEngine {
  return { name: "fake", run: async (_req, onLog) => { onLog("working"); return { text }; } };
}

function seedPrepared(db: ReturnType<typeof openDb>) {
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  return updatePr(db, pr.id, { stage: "triage", status: "pending", worktree_path: "/wt" });
}

test("runTriage persists summary/danger/focus and sets status done", async () => {
  const db = openDb(":memory:");
  const pr = seedPrepared(db);
  const good = JSON.stringify({
    summary: "Adds x.",
    danger: { level: "medium", reasons: ["shared util"], flags: ["api_contract"] },
    focusAreas: ["error handling"],
  });
  const updates: string[] = [];
  const logs: string[] = [];
  const result = await runTriage(
    {
      db, exec: ghExec(), engine: engineReturning(good), dataDir: freshDataDir(),
      onUpdate: (p) => updates.push(p.status),
      onLog: (_id, _stage, c) => logs.push(c),
    },
    pr.id,
  );
  assert.equal(result.status, "done");
  assert.equal(result.summary, "Adds x.");
  assert.equal(result.danger_level, "medium");
  assert.deepEqual(JSON.parse(result.danger_reasons!), ["shared util"]);
  assert.deepEqual(JSON.parse(result.focus_areas!), ["error handling"]);
  assert.deepEqual(JSON.parse(result.danger_flags!), ["api_contract"]);
  assert.ok(updates.includes("running"));
  assert.ok(logs.includes("working"));
});

test("runTriage persists goal + goalAssessment", async () => {
  const db = openDb(":memory:");
  const pr = seedPrepared(db);
  const good = JSON.stringify({
    goal: "Speed up the refresh path.",
    goalAssessment: { verdict: "partially", explanation: "Caches reads but not writes.", gaps: ["write path still slow"] },
    summary: "s",
    danger: { level: "low", reasons: [], flags: [] },
    focusAreas: [],
  });
  const result = await runTriage(
    { db, exec: ghExec(), engine: engineReturning(good), dataDir: freshDataDir(), onUpdate: () => {} },
    pr.id,
  );
  assert.equal(result.goal, "Speed up the refresh path.");
  assert.equal(result.goal_verdict, "partially");
  assert.equal(result.goal_explanation, "Caches reads but not writes.");
  assert.deepEqual(JSON.parse(result.goal_gaps!), ["write path still slow"]);
});

test("runTriage tolerates a response without goal fields (older prompt shape)", async () => {
  const db = openDb(":memory:");
  const pr = seedPrepared(db);
  const good = JSON.stringify({ summary: "s", danger: { level: "low", reasons: [], flags: [] }, focusAreas: [] });
  const result = await runTriage(
    { db, exec: ghExec(), engine: engineReturning(good), dataDir: freshDataDir(), onUpdate: () => {} },
    pr.id,
  );
  assert.equal(result.status, "done");
  assert.equal(result.goal, null);
  assert.equal(result.goal_verdict, null);
});

test("runTriage marks degraded (not failed) when the model returns non-JSON", async () => {
  const db = openDb(":memory:");
  const pr = seedPrepared(db);
  const result = await runTriage(
    {
      db, exec: ghExec(), engine: engineReturning("sorry, I can't do that"),
      dataDir: freshDataDir(), onUpdate: () => {},
    },
    pr.id,
  );
  assert.equal(result.status, "degraded");
  assert.match(result.error ?? "", /sorry, I can't do that/);
});

test("runTriage marks failed and rethrows when the engine throws", async () => {
  const db = openDb(":memory:");
  const pr = seedPrepared(db);
  const boom: LlmEngine = { name: "fake", run: async () => { throw new Error("engine boom"); } };
  await assert.rejects(
    runTriage(
      { db, exec: ghExec(), engine: boom, dataDir: freshDataDir(), onUpdate: () => {} },
      pr.id,
    ),
    /engine boom/,
  );
  assert.equal(getPr(db, pr.id)!.status, "failed");
});
