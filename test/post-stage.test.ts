import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb, insertPr, updatePr, insertFinding, listFindings, setSetting, getPr, DEFAULT_PREFACE_KEY } from "../src/server/db.ts";
import type { Exec } from "../src/server/exec.ts";
import { runPost } from "../src/server/post-stage.ts";

function readyPr(db: ReturnType<typeof openDb>) {
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  return updatePr(db, pr.id, { stage: "ready", status: "done", preface: "Take a look:" });
}
const okExec: Exec = async () => ({ stdout: "{}", stderr: "" });

test("runPost posts, marks selected findings posted, advances to posted", async () => {
  const db = openDb(":memory:");
  const pr = readyPr(db);
  const f = insertFinding(db, pr.id, { engine: "claude", dimension: "correctness", severity: "serious",
    file: "x.ts", line: 3, side: "RIGHT", what: "w", why: "y", suggestedFix: "f", anchorable: true, agreement: false });
  await import("../src/server/db.ts").then((m) => m.setFindingSelected(db, f.id, true));
  const result = await runPost({ db, exec: okExec, dataDir: process.env.SCRATCH ?? "/tmp", onUpdate: () => {} }, pr.id);
  assert.equal(result.stage, "posted");
  assert.equal(listFindings(db, pr.id)[0].posted, true);
});

test("runPost pins the review to head_sha via commit_id", async () => {
  const db = openDb(":memory:");
  const pr = readyPr(db);
  updatePr(db, pr.id, { head_sha: "abc123def" });
  let inputFile = "";
  const capturingExec: Exec = async (cmd, args) => {
    const i = args.indexOf("--input");
    if (i >= 0) inputFile = args[i + 1];
    return { stdout: "{}", stderr: "" };
  };
  await runPost({ db, exec: capturingExec, dataDir: process.env.SCRATCH ?? "/tmp", onUpdate: () => {} }, pr.id);
  const payload = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(inputFile, "utf8")));
  assert.equal(payload.commit_id, "abc123def");
});

test("runPost is idempotent — a posted PR does not re-post", async () => {
  const db = openDb(":memory:");
  const pr = updatePr(db, readyPr(db).id, { stage: "posted" });
  let calls = 0;
  const countingExec: Exec = async () => { calls++; return { stdout: "{}", stderr: "" }; };
  await runPost({ db, exec: countingExec, dataDir: process.env.SCRATCH ?? "/tmp", onUpdate: () => {} }, pr.id);
  assert.equal(calls, 0); // never invoked gh
});

test("runPost that fails to POST leaves stage un-posted so retry is allowed", async () => {
  const db = openDb(":memory:");
  const pr = readyPr(db);
  const failingExec: Exec = async () => { throw new Error("gh api failed"); };
  await assert.rejects(runPost({ db, exec: failingExec, dataDir: process.env.SCRATCH ?? "/tmp", onUpdate: () => {} }, pr.id), /gh api failed/);
  const row = getPr(db, pr.id)!;
  assert.equal(row.status, "failed");
  assert.notEqual(row.stage, "posted"); // POST didn't happen → retry is safe
});

test("runPost merges unposted user comments and marks them posted", async () => {
  const db = openDb(":memory:");
  const pr = readyPr(db);
  const { insertComment, listComments } = await import("../src/server/db.ts");
  insertComment(db, pr.id, { file: "x.ts", line: 3, body: "my inline note" });
  let inputFile = "";
  const capturingExec: Exec = async (cmd, args) => {
    const i = args.indexOf("--input");
    if (i >= 0) inputFile = args[i + 1];
    return { stdout: "{}", stderr: "" };
  };
  await runPost({ db, exec: capturingExec, dataDir: process.env.SCRATCH ?? "/tmp", onUpdate: () => {} }, pr.id);
  const payload = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(inputFile, "utf8")));
  assert.ok(payload.comments.some((c: { body: string }) => c.body === "my inline note"));
  assert.ok(listComments(db, pr.id).every((c) => c.posted));
});

test("runPost records accepted/rejected feedback per finding when the feedback loop is on", async () => {
  const db = openDb(":memory:");
  const pr = readyPr(db);
  const { setFindingSelected, listRejectedExamples } = await import("../src/server/db.ts");
  const kept = insertFinding(db, pr.id, { engine: "claude", dimension: "correctness", severity: "serious", file: "x.ts", line: 3, side: "RIGHT", what: "real bug", why: "y", suggestedFix: "f", anchorable: true, agreement: false });
  insertFinding(db, pr.id, { engine: "claude", dimension: "maintainability", severity: "optional", file: "x.ts", line: 4, side: "RIGHT", what: "naming nit", why: "y", suggestedFix: "f", anchorable: true, agreement: false });
  setFindingSelected(db, kept.id, true);
  await runPost({ db, exec: okExec, dataDir: process.env.SCRATCH ?? "/tmp", feedbackEnabled: true, onUpdate: () => {} }, pr.id);

  const rejected = listRejectedExamples(db, "o", "r");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /naming nit/);
  assert.match(rejected[0], /optional\/maintainability/);
});

function payloadCapture(): { exec: Exec; read: () => any } {
  let inputFile = "";
  const exec: Exec = async (cmd, args) => {
    const i = args.indexOf("--input");
    if (i >= 0) inputFile = args[i + 1];
    return { stdout: "{}", stderr: "" };
  };
  return { exec, read: () => JSON.parse(readFileSync(inputFile, "utf8")) };
}

test("runPost defaults to a COMMENT review", async () => {
  const db = openDb(":memory:");
  const pr = readyPr(db);
  const cap = payloadCapture();
  await runPost({ db, exec: cap.exec, dataDir: process.env.SCRATCH ?? "/tmp", onUpdate: () => {} }, pr.id);
  assert.equal(cap.read().event, "COMMENT");
});

test("runPost passes an explicit APPROVE / REQUEST_CHANGES event through to GitHub", async () => {
  const db = openDb(":memory:");
  const pr = readyPr(db);
  const cap = payloadCapture();
  await runPost({ db, exec: cap.exec, dataDir: process.env.SCRATCH ?? "/tmp", onUpdate: () => {} }, pr.id, "REQUEST_CHANGES");
  assert.equal(cap.read().event, "REQUEST_CHANGES");
});

test("a bare APPROVE with no findings, comments, or preface is allowed", async () => {
  const db = openDb(":memory:");
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/6", owner: "o", repo: "r", number: 6 });
  updatePr(db, pr.id, { stage: "ready", status: "done", preface: "" });
  const cap = payloadCapture();
  const result = await runPost({ db, exec: cap.exec, dataDir: process.env.SCRATCH ?? "/tmp", onUpdate: () => {} }, pr.id, "APPROVE");
  assert.equal(result.stage, "posted");
  assert.equal(cap.read().event, "APPROVE");
});

test("concurrent runPost posts exactly once (atomic claim)", async () => {
  const db = openDb(":memory:");
  const pr = readyPr(db);
  let calls = 0;
  const slowExec: Exec = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { stdout: "{}", stderr: "" }; };
  await Promise.all([
    runPost({ db, exec: slowExec, dataDir: process.env.SCRATCH ?? "/tmp", onUpdate: () => {} }, pr.id),
    runPost({ db, exec: slowExec, dataDir: process.env.SCRATCH ?? "/tmp", onUpdate: () => {} }, pr.id),
  ]);
  assert.equal(calls, 1);                       // exactly one actually posted
  assert.equal(getPr(db, pr.id)!.stage, "posted");
});
