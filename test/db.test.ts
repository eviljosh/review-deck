import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, insertPr, getPr, listPrs, updatePr, findPrByUrl, migrate, insertFinding, listFindings, replaceFindings, getSetting, setSetting, setFindingSelected, startRun, finishRun, listRuns, reconcileInterrupted, setArchived, listArchivedOlderThan, markSeen } from "../src/server/db.ts";
import type { PrRecord } from "../src/shared/types.ts";

function seed() {
  const db = openDb(":memory:");
  const pr = insertPr(db, {
    url: "https://github.com/o/r/pull/1",
    owner: "o",
    repo: "r",
    number: 1,
  });
  return { db, pr };
}

test("insertPr creates a pending prepare row", () => {
  const { pr } = seed();
  assert.equal(pr.stage, "prepare");
  assert.equal(pr.status, "pending");
  assert.equal(pr.owner, "o");
  assert.ok(pr.id > 0);
});

test("getPr returns the row", () => {
  const { db, pr } = seed();
  assert.deepEqual(getPr(db, pr.id), pr);
});

test("reconcileInterrupted flips orphaned running rows to failed (retryable)", () => {
  const { db, pr } = seed();
  updatePr(db, pr.id, { stage: "prepare", status: "running" });
  const rid = startRun(db, pr.id, "prepare"); // leaves an open run row
  const other = insertPr(db, { url: "https://github.com/o/r/pull/2", owner: "o", repo: "r", number: 2 });
  updatePr(db, other.id, { stage: "ready", status: "done" });

  const count = reconcileInterrupted(db);

  assert.equal(count, 1);
  assert.equal(getPr(db, pr.id)!.status, "failed");
  assert.match(getPr(db, pr.id)!.error!, /interrupted/);
  assert.equal(getPr(db, other.id)!.status, "done"); // untouched
  assert.equal(listRuns(db, pr.id).find((r) => r.id === rid)!.status, "failed");
});

test("setArchived toggles archived_at; listArchivedOlderThan respects the age cutoff", () => {
  const { db, pr } = seed();
  assert.equal(getPr(db, pr.id)!.archived_at, null);

  assert.ok(setArchived(db, pr.id, true).archived_at); // archived now
  assert.equal(listArchivedOlderThan(db, 30).length, 0); // too fresh to purge

  // backdate the archive to 40 days ago
  db.prepare("UPDATE prs SET archived_at = datetime('now','-40 days') WHERE id = ?").run(pr.id);
  const stale = listArchivedOlderThan(db, 30);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].id, pr.id);

  assert.equal(setArchived(db, pr.id, false).archived_at, null); // unarchive clears it
  assert.equal(listArchivedOlderThan(db, 30).length, 0);
});

test("markSeen sets seen_at without bumping updated_at", () => {
  const { db, pr } = seed();
  const before = getPr(db, pr.id)!;
  assert.equal(before.seen_at, null);
  const after = markSeen(db, pr.id);
  assert.ok(after.seen_at);
  assert.equal(after.updated_at, before.updated_at); // seeing is not a change
  assert.ok(after.seen_at! >= after.updated_at); // so it now reads as "seen"
});

test("reconcileInterrupted preserves an existing error message", () => {
  const { db, pr } = seed();
  updatePr(db, pr.id, { status: "running", error: "boom" });
  reconcileInterrupted(db);
  assert.equal(getPr(db, pr.id)!.error, "boom");
});

test("updatePr patches columns and bumps updated_at", async () => {
  const { db, pr } = seed();
  await new Promise((r) => setTimeout(r, 5));
  const updated = updatePr(db, pr.id, { status: "done", title: "Hello", additions: 5 });
  assert.equal(updated.status, "done");
  assert.equal(updated.title, "Hello");
  assert.equal(updated.additions, 5);
  assert.notEqual(updated.updated_at, pr.updated_at);
});

test("updatePr throws on an unknown column", () => {
  const { db, pr } = seed();
  assert.throws(() => updatePr(db, pr.id, { owner: "x" } as Partial<PrRecord>));
});

test("findPrByUrl finds by url", () => {
  const { db, pr } = seed();
  assert.equal(findPrByUrl(db, pr.url)?.id, pr.id);
  assert.equal(findPrByUrl(db, "https://github.com/x/y/pull/9"), undefined);
});

test("listPrs returns newest first", () => {
  const { db } = seed();
  insertPr(db, { url: "https://github.com/o/r/pull/2", owner: "o", repo: "r", number: 2 });
  const rows = listPrs(db);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].number, 2);
});

test("migrate is idempotent — re-running does not throw or duplicate columns", () => {
  const db = openDb(":memory:"); // migrate already ran once inside openDb
  assert.doesNotThrow(() => { migrate(db); migrate(db); }); // re-runs are safe
  const cols = (db.prepare("PRAGMA table_info(prs)").all() as { name: string }[]).map((c) => c.name);
  for (const c of ["summary", "danger_level", "danger_reasons", "focus_areas", "danger_flags"]) {
    assert.ok(cols.includes(c), `missing column ${c}`);
  }
});

test("updatePr can set the new triage columns", () => {
  const { db, pr } = seed();
  const updated = updatePr(db, pr.id, {
    summary: "S",
    danger_level: "high",
    danger_reasons: JSON.stringify(["r1"]),
    focus_areas: JSON.stringify(["f1"]),
    danger_flags: JSON.stringify(["auth_security"]),
  });
  assert.equal(updated.summary, "S");
  assert.equal(updated.danger_level, "high");
  assert.equal(JSON.parse(updated.danger_reasons!)[0], "r1");
  assert.equal(JSON.parse(updated.danger_flags!)[0], "auth_security");
});

function aFinding(over: Partial<import("../src/shared/types.ts").Finding> = {}) {
  return {
    engine: "claude", dimension: "correctness", severity: "serious" as const,
    file: "x.ts", line: 1, side: "RIGHT" as const,
    what: "w", why: "y", suggestedFix: "f", anchorable: true, agreement: false, ...over,
  };
}

test("insertFinding + listFindings round-trip, ordered by severity", () => {
  const { db, pr } = seed();
  insertFinding(db, pr.id, aFinding({ severity: "moderate" }));
  insertFinding(db, pr.id, aFinding({ severity: "blocking" }));
  const rows = listFindings(db, pr.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].severity, "blocking"); // blocking sorts first
  assert.equal(rows[0].selected, false);
});

test("replaceFindings clears prior findings for the pr", () => {
  const { db, pr } = seed();
  insertFinding(db, pr.id, aFinding());
  replaceFindings(db, pr.id, [aFinding({ what: "new one" })]);
  const rows = listFindings(db, pr.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].what, "new one");
});

test("settings get/set upserts", () => {
  const db = openDb(":memory:");
  assert.equal(getSetting(db, "default_preface"), null);
  setSetting(db, "default_preface", "Please take a look:");
  assert.equal(getSetting(db, "default_preface"), "Please take a look:");
  setSetting(db, "default_preface", "Updated");
  assert.equal(getSetting(db, "default_preface"), "Updated");
});

test("updatePr can set preface", () => {
  const { db, pr } = seed();
  assert.equal(updatePr(db, pr.id, { preface: "hi" }).preface, "hi");
});

test("setFindingSelected toggles the flag", () => {
  const { db, pr } = seed();
  const f = insertFinding(db, pr.id, aFinding());
  setFindingSelected(db, f.id, true);
  assert.equal(listFindings(db, pr.id)[0].selected, true);
});

test("startRun/finishRun/listRuns record a stage run", () => {
  const { db, pr } = seed();
  const rid = startRun(db, pr.id, "triage");
  finishRun(db, rid, "done");
  const runs = listRuns(db, pr.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].stage, "triage");
  assert.equal(runs[0].status, "done");
  assert.ok(runs[0].ended_at);
});

test("finishRun records an error message on failure", () => {
  const { db, pr } = seed();
  const rid = startRun(db, pr.id, "deep_review");
  finishRun(db, rid, "failed", "boom");
  const runs = listRuns(db, pr.id);
  assert.equal(runs[0].status, "failed");
  assert.equal(runs[0].error, "boom");
});

test("listRuns returns runs in chronological order", () => {
  const { db, pr } = seed();
  const r1 = startRun(db, pr.id, "prepare");
  finishRun(db, r1, "done");
  const r2 = startRun(db, pr.id, "triage");
  finishRun(db, r2, "done");
  const runs = listRuns(db, pr.id);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].stage, "prepare");
  assert.equal(runs[1].stage, "triage");
});
