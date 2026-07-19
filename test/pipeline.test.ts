import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, insertPr, getPr, listFindings, listRuns, updatePr } from "../src/server/db.ts";
import type { Exec } from "../src/server/exec.ts";
import type { LlmEngine } from "../src/server/engines/types.ts";
import { WsHub } from "../src/server/ws.ts";
import { runPipeline } from "../src/server/pipeline.ts";
import { DEFAULT_REVIEW_CONFIG } from "../src/server/review-config.ts";
import { stageArtifactDir, writeArtifacts } from "../src/server/artifacts.ts";
import type { WsMessage } from "../src/shared/types.ts";

function ghExec(): Exec {
  return async (cmd, args) => {
    if (cmd === "gh" && args[1] === "view") {
      return { stdout: JSON.stringify({ title: "T", author: { login: "u" }, additions: 1, deletions: 0, changedFiles: 1 }), stderr: "" };
    }
    return { stdout: "diff --git a/x b/x\n+1", stderr: "" };
  };
}

test("runPipeline runs prepare then triage and broadcasts pr_updated + pr_log", async () => {
  const db = openDb(":memory:");
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  const findingsJson = JSON.stringify({ findings: [{ dimension: "correctness", severity: "moderate", file: "x", line: 1, side: "RIGHT", what: "w", why: "y", suggestedFix: "f" }] });
  const finalJson = JSON.stringify({ findings: [{ dimension: "correctness", severity: "moderate", file: "x", line: 1, side: "RIGHT", what: "w", why: "y", suggestedFix: "f", sources: ["claude"], agreement: false }] });
  const claude: LlmEngine = {
    name: "fake",
    run: async (req, onLog) => {
      if (req.system.includes("triaging")) {
        onLog("scanning diff");
        return { text: JSON.stringify({ summary: "s", danger: { level: "low", reasons: [], flags: [] }, focusAreas: [] }) };
      }
      if (req.system.includes("finalizing")) return { text: finalJson };
      return { text: findingsJson };
    },
  };
  const codex: LlmEngine = { name: "codex", run: async () => ({ text: findingsJson }) };
  const hub = new WsHub();
  const msgs: WsMessage[] = [];
  hub.add({ send: (d) => msgs.push(JSON.parse(d) as WsMessage) });

  await runPipeline(
    {
      db, exec: ghExec(), claude, codex,
      config: { ...DEFAULT_REVIEW_CONFIG, dimensions: [{ key: "correctness", guidance: "logic errors" }] },
      dataDir: process.env.SCRATCH ?? "/tmp", hub,
    },
    pr.id,
  );

  const row = getPr(db, pr.id)!;
  assert.equal(row.stage, "ready");
  assert.equal(row.status, "done");
  assert.equal(row.danger_level, "low");
  assert.ok(msgs.some((m) => m.type === "pr_log" && m.chunk.includes("scanning diff")));
  assert.ok(msgs.some((m) => m.type === "pr_updated" && m.pr.status === "done"));
});

test("runPipeline skips triage when prepare fails", async () => {
  const db = openDb(":memory:");
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  const failingExec: Exec = async () => { throw new Error("gh boom"); };
  const claude: LlmEngine = { name: "fake", run: async () => { throw new Error("triage should not run"); } };
  const codex: LlmEngine = { name: "codex", run: async () => { throw new Error("codex should not run"); } };
  const hub = new WsHub();
  await runPipeline(
    {
      db, exec: failingExec, claude, codex,
      config: { ...DEFAULT_REVIEW_CONFIG, dimensions: [{ key: "correctness", guidance: "logic errors" }] },
      dataDir: process.env.SCRATCH ?? "/tmp", hub,
    },
    pr.id,
  );
  const row = getPr(db, pr.id)!;
  assert.equal(row.status, "failed");        // prepare failed
  assert.equal(row.danger_level, null);      // triage never ran (would have set this)
});

test("runPipeline runs prepare->triage->deep_review->synthesize to ready", async () => {
  const db = openDb(":memory:");
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  const triageJson = JSON.stringify({ summary: "s", danger: { level: "low", reasons: [], flags: [] }, focusAreas: [] });
  const findingsJson = JSON.stringify({ findings: [{ dimension: "correctness", severity: "moderate", file: "x", line: 1, side: "RIGHT", what: "w", why: "y", suggestedFix: "f" }] });
  const finalJson = JSON.stringify({ findings: [{ dimension: "correctness", severity: "moderate", file: "x", line: 1, side: "RIGHT", what: "w", why: "y", suggestedFix: "f", sources: ["claude"], agreement: false }] });
  // one engine that returns triage-shaped, findings-shaped, and final-shaped by call order is fragile;
  // instead use distinct stubs: claude returns triage then findings then final based on the system prompt.
  const claude: LlmEngine = { name: "claude", run: async (req) =>
    ({ text: req.system.includes("triaging") ? triageJson : req.system.includes("finalizing") ? finalJson : findingsJson }) };
  const codex: LlmEngine = { name: "codex", run: async () => ({ text: findingsJson }) };
  const hub = new WsHub();
  await runPipeline({ db, exec: ghExec(), claude, codex, config: { ...DEFAULT_REVIEW_CONFIG, dimensions: [{ key: "correctness", guidance: "logic errors" }] }, dataDir: process.env.SCRATCH ?? "/tmp", hub }, pr.id);
  const row = getPr(db, pr.id)!;
  assert.equal(row.stage, "ready");
  assert.equal(row.status, "done");
  assert.ok(listFindings(db, pr.id).length >= 1);

  const runs = listRuns(db, pr.id);
  const byStage = Object.fromEntries(runs.map((r) => [r.stage, r]));
  for (const stage of ["prepare", "triage", "deep_review", "synthesize"]) {
    assert.equal(byStage[stage]?.status, "done", `${stage} run should be done`);
    assert.ok(byStage[stage]?.ended_at, `${stage} run should have ended_at`);
  }
});

test("runPipeline records a failed run for the stage that throws", async () => {
  const db = openDb(":memory:");
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  const failingExec: Exec = async () => { throw new Error("gh boom"); };
  const claude: LlmEngine = { name: "fake", run: async () => { throw new Error("triage should not run"); } };
  const codex: LlmEngine = { name: "codex", run: async () => { throw new Error("codex should not run"); } };
  const hub = new WsHub();
  await runPipeline(
    {
      db, exec: failingExec, claude, codex,
      config: { ...DEFAULT_REVIEW_CONFIG, dimensions: [{ key: "correctness", guidance: "logic errors" }] },
      dataDir: process.env.SCRATCH ?? "/tmp", hub,
    },
    pr.id,
  );
  const runs = listRuns(db, pr.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].stage, "prepare");
  assert.equal(runs[0].status, "failed");
  assert.equal(runs[0].error, "gh boom");
});

const CONFIG = { ...DEFAULT_REVIEW_CONFIG, dimensions: [{ key: "correctness", guidance: "logic errors" }] };
const FINDINGS_JSON = JSON.stringify({ findings: [{ dimension: "correctness", severity: "moderate", file: "x", line: 1, side: "RIGHT", what: "w", why: "y", suggestedFix: "f" }] });
const FINAL_JSON = JSON.stringify({ findings: [{ dimension: "correctness", severity: "moderate", file: "x", line: 1, side: "RIGHT", what: "w", why: "y", suggestedFix: "f", sources: ["claude"], agreement: false }] });
const RAW_FINDINGS = [{ engine: "claude", dimension: "correctness", severity: "serious", file: "x", line: 1, side: "RIGHT", what: "w", why: "y", suggestedFix: "f", anchorable: false }];

test("runPipeline resuming at synthesize reuses the raw-findings artifact and skips earlier stages", async () => {
  const db = openDb(":memory:");
  const dataDir = `${process.env.SCRATCH ?? "/tmp"}/resume-a-${Date.now()}`;
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  // Simulate a run that died in synthesize: worktree on disk + raw findings persisted.
  updatePr(db, pr.id, { stage: "synthesize", status: "failed", worktree_path: process.env.SCRATCH ?? "/tmp" });
  writeArtifacts(stageArtifactDir(dataDir, pr.id, "deep_review"), { "raw-findings.json": JSON.stringify(RAW_FINDINGS) });

  const claude: LlmEngine = { name: "claude", run: async (req) => {
    if (!req.system.includes("finalizing")) throw new Error(`unexpected non-finalizer call: ${req.system.slice(0, 60)}`);
    return { text: FINAL_JSON };
  } };
  const codex: LlmEngine = { name: "codex", run: async () => { throw new Error("codex should not run on resume"); } };
  await runPipeline({ db, exec: ghExec(), claude, codex, config: CONFIG, dataDir, hub: new WsHub() }, pr.id, undefined, "synthesize");

  const row = getPr(db, pr.id)!;
  assert.equal(row.stage, "ready");
  assert.equal(row.status, "done");
  assert.equal(listFindings(db, pr.id).length, 1);
  // Neither prepare, triage, nor deep_review re-ran.
  assert.deepEqual(listRuns(db, pr.id).map((r) => r.stage), ["synthesize"]);
});

test("runPipeline resuming at synthesize without the artifact falls back to a live deep review", async () => {
  const db = openDb(":memory:");
  const dataDir = `${process.env.SCRATCH ?? "/tmp"}/resume-b-${Date.now()}`;
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  updatePr(db, pr.id, { stage: "synthesize", status: "failed", worktree_path: process.env.SCRATCH ?? "/tmp" });

  const claude: LlmEngine = { name: "claude", run: async (req) => {
    if (req.system.includes("triaging")) throw new Error("triage should not run on resume");
    return { text: req.system.includes("finalizing") ? FINAL_JSON : FINDINGS_JSON };
  } };
  const codex: LlmEngine = { name: "codex", run: async () => ({ text: FINDINGS_JSON }) };
  await runPipeline({ db, exec: ghExec(), claude, codex, config: CONFIG, dataDir, hub: new WsHub() }, pr.id, undefined, "synthesize");

  const row = getPr(db, pr.id)!;
  assert.equal(row.stage, "ready");
  assert.equal(row.status, "done");
  const stages = listRuns(db, pr.id).map((r) => r.stage).filter((s) => !s.includes("·"));
  assert.deepEqual(stages, ["deep_review", "synthesize"]);
});

test("runPipeline resuming at deep_review skips triage but re-runs prepare when the worktree is gone", async () => {
  const db = openDb(":memory:");
  const dataDir = `${process.env.SCRATCH ?? "/tmp"}/resume-c-${Date.now()}`;
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  updatePr(db, pr.id, { stage: "deep_review", status: "failed", worktree_path: `${dataDir}/gone` });

  const claude: LlmEngine = { name: "claude", run: async (req) => {
    if (req.system.includes("triaging")) throw new Error("triage should not run on resume");
    return { text: req.system.includes("finalizing") ? FINAL_JSON : FINDINGS_JSON };
  } };
  const codex: LlmEngine = { name: "codex", run: async () => ({ text: FINDINGS_JSON }) };
  await runPipeline({ db, exec: ghExec(), claude, codex, config: CONFIG, dataDir, hub: new WsHub() }, pr.id, undefined, "deep_review");

  const row = getPr(db, pr.id)!;
  assert.equal(row.stage, "ready");
  assert.equal(row.status, "done");
  const stages = listRuns(db, pr.id).map((r) => r.stage).filter((s) => !s.includes("·"));
  assert.deepEqual(stages, ["prepare", "deep_review", "synthesize"]);
});
