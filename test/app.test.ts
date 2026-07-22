import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { openDb, insertFinding, listFindings, getPr, updatePr, insertPr } from "../src/server/db.ts";
import type { Exec } from "../src/server/exec.ts";
import type { LlmEngine } from "../src/server/engines/types.ts";
import type { WsMessage } from "../src/shared/types.ts";
import { WsHub } from "../src/server/ws.ts";
import { buildApp } from "../src/server/app.ts";
import { DEFAULT_REVIEW_CONFIG } from "../src/server/review-config.ts";

const triageJson = JSON.stringify({ summary: "s", danger: { level: "low", reasons: [], flags: [] }, focusAreas: [] });
const findingsJson = JSON.stringify({ findings: [{ dimension: "correctness", severity: "moderate", file: "x", line: 1, side: "RIGHT", what: "w", why: "y", suggestedFix: "f" }] });
const finalJson = JSON.stringify({ findings: [{ dimension: "correctness", severity: "moderate", file: "x", line: 1, side: "RIGHT", what: "w", why: "y", suggestedFix: "f", sources: ["claude"], agreement: false }] });

function deps() {
  const exec: Exec = async (cmd, args) => {
    if (cmd === "gh" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          title: "T", author: { login: "u" },
          additions: 1, deletions: 0, changedFiles: 1,
        }),
        stderr: "",
      };
    }
    return { stdout: "diff --git a/x b/x\n+1", stderr: "" };
  };
  // Fakes return valid triage/findings/final JSON keyed on the system prompt.
  const claude: LlmEngine = {
    name: "claude",
    run: async (req) =>
      ({ text: req.system.includes("triaging") ? triageJson : req.system.includes("finalizing") ? finalJson : findingsJson }),
  };
  const codex: LlmEngine = {
    name: "codex",
    run: async (req) =>
      ({ text: req.system.includes("triaging") ? triageJson : req.system.includes("finalizing") ? finalJson : findingsJson }),
  };
  return {
    db: openDb(":memory:"), exec, claude, codex, config: DEFAULT_REVIEW_CONFIG,
    dataDir: process.env.SCRATCH ?? "/tmp", hub: new WsHub(),
  };
}

test("GET /api/health", async () => {
  const app = buildApp(deps());
  const res = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

test("POST /api/prs creates rows; GET /api/prs lists them", async () => {
  const app = buildApp(deps());
  const post = await app.inject({
    method: "POST",
    url: "/api/prs",
    payload: { urls: ["https://github.com/o/r/pull/5"] },
  });
  assert.equal(post.statusCode, 200);
  const created = post.json().created;
  assert.equal(created.length, 1);
  assert.equal(created[0].owner, "o");

  const list = await app.inject({ method: "GET", url: "/api/prs" });
  assert.equal(list.json().length, 1);
});

test("POST /api/prs with several urls creates all rows under the concurrency limit", async () => {
  const app = buildApp(deps());
  const res = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: [
    "https://github.com/o/r/pull/1","https://github.com/o/r/pull/2","https://github.com/o/r/pull/3" ] } });
  assert.equal(res.json().created.length, 3);
});

test("POST /api/prs rejects an invalid url", async () => {
  const app = buildApp(deps());
  const res = await app.inject({
    method: "POST",
    url: "/api/prs",
    payload: { urls: ["https://github.com/o/r/issues/1"] },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/prs drives runPrepare to completion and broadcasts pr_updated over the hub", async () => {
  const d = deps();
  const app = buildApp(d);

  const received: WsMessage[] = [];
  d.hub.add({ send: (data: string) => received.push(JSON.parse(data) as WsMessage) });

  const post = await app.inject({
    method: "POST",
    url: "/api/prs",
    payload: { urls: ["https://github.com/o/r/pull/5"] },
  });
  assert.equal(post.statusCode, 200);
  const createdPr = post.json().created[0];

  // The prepare run is fire-and-forget; poll for the broadcast it emits once
  // it reaches the triage stage.
  let triageMsg: WsMessage | undefined;
  for (let waited = 0; waited < 1000; waited += 20) {
    triageMsg = received.find(
      (m) => m.type === "pr_updated" && m.pr.stage === "triage",
    );
    if (triageMsg) break;
    await setTimeout(20);
  }

  if (!triageMsg || triageMsg.type !== "pr_updated") {
    assert.fail("timed out waiting for pr_updated broadcast with stage 'triage'");
  }
  assert.equal(triageMsg.pr.stage, "triage");
  assert.equal(triageMsg.pr.status, "pending");
  assert.equal(triageMsg.pr.id, createdPr.id);
});

test("POST /api/prs dedupes by url and reports the existing record", async () => {
  const d = deps();
  const app = buildApp(d);
  const body = { urls: ["https://github.com/o/r/pull/5"] };
  const first = await app.inject({ method: "POST", url: "/api/prs", payload: body });
  assert.equal(first.json().created.length, 1);
  assert.equal(first.json().existing.length, 0);

  const second = await app.inject({ method: "POST", url: "/api/prs", payload: body });
  assert.equal(second.json().created.length, 0);
  assert.equal(second.json().existing.length, 1);
  assert.equal(second.json().existing[0].number, 5);

  const list = await app.inject({ method: "GET", url: "/api/prs" });
  assert.equal(list.json().length, 1); // still only one row
});

test("POST /api/prs/:id/retry returns ok for an existing pr", async () => {
  const app = buildApp(deps());
  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;
  const retry = await app.inject({ method: "POST", url: `/api/prs/${id}/retry` });
  assert.equal(retry.statusCode, 200);
  assert.deepEqual(retry.json(), { ok: true });
});

test("POST /api/prs/:id/retry 404s for a missing pr", async () => {
  const app = buildApp(deps());
  const retry = await app.inject({ method: "POST", url: "/api/prs/999/retry" });
  assert.equal(retry.statusCode, 404);
});

test("POST /api/prs/:id/retry 404s for a non-integer id", async () => {
  const app = buildApp(deps());
  const retry = await app.inject({ method: "POST", url: "/api/prs/abc/retry" });
  assert.equal(retry.statusCode, 404);
});

test("POST /api/prs/:id/retry on a posted PR wipes the old review, snapshots posted findings, re-reviews fresh", async () => {
  const d = deps();
  const app = buildApp(d);
  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;
  // let the creation-time pipeline finish before simulating the posted state
  for (let i = 0; i < 200 && getPr(d.db, id)!.status === "running"; i++) await setTimeout(10);
  updatePr(d.db, id, { stage: "posted", status: "done", review_verdict: "old verdict", file_guide: "[]" });
  d.db.prepare("UPDATE findings SET posted = 1, selected = 1 WHERE pr_id = ?").run(id);
  const oldWhat = listFindings(d.db, id)[0].what;

  const res = await app.inject({ method: "POST", url: `/api/prs/${id}/retry` });
  assert.equal(res.statusCode, 200);
  for (let i = 0; i < 200 && getPr(d.db, id)!.status === "running"; i++) await setTimeout(10);
  const pr = getPr(d.db, id)!;
  assert.equal(pr.stage, "ready");
  assert.equal(pr.status, "done");
  // old posted findings became the prior-review snapshot for the finalizer…
  assert.ok(pr.prior_findings && pr.prior_findings.includes(oldWhat), pr.prior_findings ?? "null");
  // …and the visible review is entirely the fresh run's output (no posted leftovers)
  assert.ok(listFindings(d.db, id).every((f) => !f.posted));
});

test("POST /api/prs/:id/findings/select-all flips every unposted finding", async () => {
  const d = deps();
  const app = buildApp(d);
  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;
  insertFinding(d.db, id, { engine: "claude", dimension: "correctness", severity: "serious", file: "x", line: 1, side: "RIGHT", what: "w", why: "y", suggestedFix: "f", anchorable: true, agreement: false });
  insertFinding(d.db, id, { engine: "codex", dimension: "tests", severity: "optional", file: "y", line: 2, side: "RIGHT", what: "w2", why: "y2", suggestedFix: "f2", anchorable: true, agreement: false });
  const on = await app.inject({ method: "POST", url: `/api/prs/${id}/findings/select-all`, payload: { selected: true } });
  assert.equal(on.statusCode, 200);
  assert.ok(listFindings(d.db, id).every((f) => f.selected));
  await app.inject({ method: "POST", url: `/api/prs/${id}/findings/select-all`, payload: { selected: false } });
  assert.ok(listFindings(d.db, id).every((f) => !f.selected));
});

test("PATCH /api/prs/:id/comments/:cid edits an unposted comment; posted ones 404", async () => {
  const d = deps();
  const app = buildApp(d);
  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;
  const add = await app.inject({ method: "POST", url: `/api/prs/${id}/comments`, payload: { file: "x.ts", line: 3, body: "first draft" } });
  const cid = add.json().id;

  const patch = await app.inject({ method: "PATCH", url: `/api/prs/${id}/comments/${cid}`, payload: { body: "polished version" } });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().body, "polished version");

  d.db.prepare("UPDATE comments SET posted = 1 WHERE id = ?").run(cid);
  const locked = await app.inject({ method: "PATCH", url: `/api/prs/${id}/comments/${cid}`, payload: { body: "nope" } });
  assert.equal(locked.statusCode, 404);
});

test("PATCH /api/prs/:id/findings/:fid stores and clears the reviewer note", async () => {
  const d = deps();
  const app = buildApp(d);
  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;
  const f = insertFinding(d.db, id, { engine: "claude", dimension: "correctness", severity: "serious", file: "x", line: 1, side: "RIGHT", what: "w", why: "y", suggestedFix: "f", anchorable: true, agreement: false });

  const set = await app.inject({ method: "PATCH", url: `/api/prs/${id}/findings/${f.id}`, payload: { reviewerNote: "my framing" } });
  assert.equal(set.json().reviewerNote, "my framing");

  const clear = await app.inject({ method: "PATCH", url: `/api/prs/${id}/findings/${f.id}`, payload: { reviewerNote: "   " } });
  assert.equal(clear.json().reviewerNote, null); // blank clears it
});

test("PATCH /api/prs/:id/findings/:fid edits text until posted, then 409s", async () => {
  const d = deps();
  const app = buildApp(d);
  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;
  const f = insertFinding(d.db, id, { engine: "claude", dimension: "correctness", severity: "serious", file: "x", line: 1, side: "RIGHT", what: "orig", why: "y", suggestedFix: "f", anchorable: true, agreement: false });

  const patch = await app.inject({ method: "PATCH", url: `/api/prs/${id}/findings/${f.id}`, payload: { what: "edited", suggestedFix: "better fix" } });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().what, "edited");
  const stored = listFindings(d.db, id)[0];
  assert.equal(stored.what, "edited");
  assert.equal(stored.suggestedFix, "better fix");
  assert.equal(stored.why, "y"); // untouched field preserved

  d.db.prepare("UPDATE findings SET posted = 1 WHERE id = ?").run(f.id);
  const locked = await app.inject({ method: "PATCH", url: `/api/prs/${id}/findings/${f.id}`, payload: { what: "nope" } });
  assert.equal(locked.statusCode, 409);
});

test("archive removes the worktree and clears worktree_path", async () => {
  const d = deps();
  const calls: string[][] = [];
  d.exec = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: "", stderr: "" }; };
  const app = buildApp(d);
  const pr = insertPr(d.db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  updatePr(d.db, pr.id, { status: "done", worktree_path: "/data/worktrees/pr-1" });

  const res = await app.inject({ method: "POST", url: `/api/prs/${pr.id}/archive` });
  assert.equal(res.statusCode, 200);
  assert.ok(calls.some((c) => c.join(" ").includes("worktree remove --force /data/worktrees/pr-1")));
  assert.equal(getPr(d.db, pr.id)!.worktree_path, null);
});

test("POST /api/prs/:id/retry 409s when the PR is already running", async () => {
  const d = deps();
  const app = buildApp(d);
  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;
  updatePr(d.db, id, { status: "running" });
  const res = await app.inject({ method: "POST", url: `/api/prs/${id}/retry` });
  assert.equal(res.statusCode, 409);
});

test("POST /api/prs/:id/cancel marks the pr cancelled and broadcasts", async () => {
  const d = deps();
  const app = buildApp(d);
  const received: WsMessage[] = [];
  d.hub.add({ send: (data: string) => received.push(JSON.parse(data) as WsMessage) });
  const pr = insertPr(d.db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  updatePr(d.db, pr.id, { status: "running" });

  const res = await app.inject({ method: "POST", url: `/api/prs/${pr.id}/cancel` });
  assert.equal(res.statusCode, 200);
  assert.equal(getPr(d.db, pr.id)!.status, "cancelled");
  assert.ok(received.some((m) => m.type === "pr_updated" && m.pr.id === pr.id && m.pr.status === "cancelled"));
});

test("POST /api/prs/:id/cancel 404s for a missing pr", async () => {
  const res = await buildApp(deps()).inject({ method: "POST", url: "/api/prs/9999/cancel" });
  assert.equal(res.statusCode, 404);
});

test("DELETE /api/prs/:id removes the pr and broadcasts pr_deleted", async () => {
  const d = deps();
  const app = buildApp(d);
  const received: WsMessage[] = [];
  d.hub.add({ send: (data: string) => received.push(JSON.parse(data) as WsMessage) });
  const pr = insertPr(d.db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });

  const res = await app.inject({ method: "DELETE", url: `/api/prs/${pr.id}` });
  assert.equal(res.statusCode, 200);
  assert.equal(getPr(d.db, pr.id), undefined);
  assert.ok(received.some((m) => m.type === "pr_deleted" && m.prId === pr.id));
});

test("DELETE /api/prs/:id removes the worktree when one exists", async () => {
  const d = deps();
  const calls: string[][] = [];
  d.exec = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: "", stderr: "" }; };
  const app = buildApp(d);
  const pr = insertPr(d.db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  updatePr(d.db, pr.id, { worktree_path: "/data/worktrees/pr-1" });

  const res = await app.inject({ method: "DELETE", url: `/api/prs/${pr.id}` });
  assert.equal(res.statusCode, 200);
  assert.ok(calls.some((c) => c.join(" ").includes("worktree remove --force /data/worktrees/pr-1")));
});

test("DELETE /api/prs/:id removes the PR's artifacts directory", async () => {
  const d = deps();
  const { mkdtempSync, existsSync } = await import("node:fs");
  d.dataDir = mkdtempSync(`${process.env.SCRATCH ?? "/tmp"}/art-del-`);
  const app = buildApp(d);
  const pr = insertPr(d.db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  const { stageArtifactDir, writeArtifacts } = await import("../src/server/artifacts.ts");
  const dir = stageArtifactDir(d.dataDir, pr.id, "triage");
  writeArtifacts(dir, { "raw.txt": "model output" });
  assert.ok(existsSync(dir));

  const res = await app.inject({ method: "DELETE", url: `/api/prs/${pr.id}` });
  assert.equal(res.statusCode, 200);
  assert.ok(!existsSync(dir), "artifacts dir should be removed with the PR");
});

test("DELETE /api/prs/:id 404s for a missing pr", async () => {
  const res = await buildApp(deps()).inject({ method: "DELETE", url: "/api/prs/9999" });
  assert.equal(res.statusCode, 404);
});

test("POST /api/prs/:id/seen marks the pr seen and broadcasts", async () => {
  const d = deps();
  const app = buildApp(d);
  const received: WsMessage[] = [];
  d.hub.add({ send: (data: string) => received.push(JSON.parse(data) as WsMessage) });
  const pr = insertPr(d.db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });

  const res = await app.inject({ method: "POST", url: `/api/prs/${pr.id}/seen` });
  assert.equal(res.statusCode, 200);
  assert.ok(getPr(d.db, pr.id)!.seen_at);
  assert.ok(received.some((m) => m.type === "pr_updated" && m.pr.id === pr.id && m.pr.seen_at));
});

test("POST /api/prs/:id/refresh-status updates CI / mergeability / review fields", async () => {
  const d = deps();
  d.exec = async (cmd, args) => {
    if (cmd === "gh" && args.some((a) => a.includes("statusCheckRollup"))) {
      return { stdout: JSON.stringify({ state: "OPEN", mergeable: "CONFLICTING", reviewDecision: "APPROVED", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }), stderr: "" };
    }
    return { stdout: "{}", stderr: "" };
  };
  const app = buildApp(d);
  const pr = insertPr(d.db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });

  const res = await app.inject({ method: "POST", url: `/api/prs/${pr.id}/refresh-status` });
  assert.equal(res.statusCode, 200);
  const updated = getPr(d.db, pr.id)!;
  assert.equal(updated.mergeable, "CONFLICTING");
  assert.equal(updated.review_decision, "APPROVED");
  assert.equal(updated.checks, "passing");
});

test("archive then unarchive toggles archived_at and broadcasts", async () => {
  const d = deps();
  const app = buildApp(d);
  const received: WsMessage[] = [];
  d.hub.add({ send: (data: string) => received.push(JSON.parse(data) as WsMessage) });
  const pr = insertPr(d.db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });

  await app.inject({ method: "POST", url: `/api/prs/${pr.id}/archive` });
  assert.ok(getPr(d.db, pr.id)!.archived_at, "archived_at should be set");
  assert.ok(received.some((m) => m.type === "pr_updated" && m.pr.id === pr.id && m.pr.archived_at));

  await app.inject({ method: "POST", url: `/api/prs/${pr.id}/unarchive` });
  assert.equal(getPr(d.db, pr.id)!.archived_at, null);
});

test("POST /api/prs/:id/archive 404s for a missing pr", async () => {
  const res = await buildApp(deps()).inject({ method: "POST", url: "/api/prs/9999/archive" });
  assert.equal(res.statusCode, 404);
});

test("purge-archived deletes only archives older than 30 days", async () => {
  const d = deps();
  const app = buildApp(d);
  const stale = insertPr(d.db, { url: "https://github.com/o/r/pull/1", owner: "o", repo: "r", number: 1 });
  const fresh = insertPr(d.db, { url: "https://github.com/o/r/pull/2", owner: "o", repo: "r", number: 2 });
  const active = insertPr(d.db, { url: "https://github.com/o/r/pull/3", owner: "o", repo: "r", number: 3 });
  d.db.prepare("UPDATE prs SET archived_at = datetime('now','-40 days') WHERE id = ?").run(stale.id);
  d.db.prepare("UPDATE prs SET archived_at = datetime('now') WHERE id = ?").run(fresh.id);

  const res = await app.inject({ method: "POST", url: "/api/prs/purge-archived" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().deleted, 1);
  assert.equal(getPr(d.db, stale.id), undefined); // old archive purged
  assert.ok(getPr(d.db, fresh.id)); // recent archive kept
  assert.ok(getPr(d.db, active.id)); // never-archived kept
});

test("GET /api/prs/:id/findings 404s for a missing pr", async () => {
  const app = buildApp(deps());
  const res = await app.inject({ method: "GET", url: "/api/prs/999/findings" });
  assert.equal(res.statusCode, 404);
});

test("GET /api/prs/:id/findings 404s for a non-integer id", async () => {
  const app = buildApp(deps());
  const res = await app.inject({ method: "GET", url: "/api/prs/abc/findings" });
  assert.equal(res.statusCode, 404);
});

test("GET /api/prs/:id/findings returns findings once the pipeline reaches ready", async () => {
  const d = deps();
  const app = buildApp(d);
  const received: WsMessage[] = [];
  d.hub.add({ send: (data: string) => received.push(JSON.parse(data) as WsMessage) });

  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;

  let sawFindingsUpdated = false;
  for (let waited = 0; waited < 2000; waited += 20) {
    sawFindingsUpdated = received.some((m) => m.type === "findings_updated" && m.prId === id);
    if (sawFindingsUpdated) break;
    await setTimeout(20);
  }
  assert.ok(sawFindingsUpdated, "timed out waiting for findings_updated broadcast");

  const res = await app.inject({ method: "GET", url: `/api/prs/${id}/findings` });
  assert.equal(res.statusCode, 200);
  const findings = res.json();
  assert.ok(Array.isArray(findings));
  assert.ok(findings.length >= 1);
});

test("comments CRUD: add, list, delete; GET /api/prs/:id/diff serves the diff", async () => {
  const d = deps();
  const app = buildApp(d);
  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;

  const add = await app.inject({ method: "POST", url: `/api/prs/${id}/comments`, payload: { file: "x.ts", line: 3, body: "note" } });
  assert.equal(add.statusCode, 200);
  const cid = add.json().id;

  const list = await app.inject({ method: "GET", url: `/api/prs/${id}/comments` });
  assert.equal(list.json().length, 1);
  assert.equal(list.json()[0].body, "note");

  const bad = await app.inject({ method: "POST", url: `/api/prs/${id}/comments`, payload: { file: "x.ts", line: 3, body: "  " } });
  assert.equal(bad.statusCode, 400);

  const del = await app.inject({ method: "DELETE", url: `/api/prs/${id}/comments/${cid}` });
  assert.equal(del.statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/api/prs/${id}/comments` })).json().length, 0);

  const diff = await app.inject({ method: "GET", url: `/api/prs/${id}/diff` });
  assert.equal(diff.statusCode, 200);
  assert.match(diff.json().diff, /diff --git/);
});

test("GET /api/prs/:id/review.md serves the review brief as markdown", async () => {
  const d = deps();
  const app = buildApp(d);
  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;
  updatePr(d.db, id, { title: "Add retries", summary: "Adds a retry wrapper.", review_verdict: "Solid." });
  insertFinding(d.db, id, { engine: "claude", dimension: "correctness", severity: "serious", file: "x.ts", line: 3, side: "RIGHT", what: "unbounded loop", why: "y", suggestedFix: "cap it", anchorable: true, agreement: false });

  const res = await app.inject({ method: "GET", url: `/api/prs/${id}/review.md` });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /text\/markdown/);
  assert.match(res.body, /# Code review: Add retries/);
  assert.match(res.body, /## Bottom line/);
  assert.match(res.body, /unbounded loop/);
  assert.match(res.body, /gh pr checkout 5 --repo o\/r/);

  const missing = await app.inject({ method: "GET", url: "/api/prs/999/review.md" });
  assert.equal(missing.statusCode, 404);
});

test("GET /api/prs/:id/file serves pinned file content and rejects bad paths", async () => {
  const d = deps();
  const calls: string[][] = [];
  const baseExec = d.exec;
  d.exec = async (cmd, args, opts) => { calls.push([cmd, ...args]); return baseExec(cmd, args, opts); };
  const app = buildApp(d);
  const pr = insertPr(d.db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  updatePr(d.db, pr.id, { head_sha: "abc123" });

  const res = await app.inject({ method: "GET", url: `/api/prs/${pr.id}/file?path=src/x.ts` });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().content.length > 0);
  assert.ok(calls.some((c) => c.join(" ").includes("show abc123:src/x.ts")));

  const bad = await app.inject({ method: "GET", url: `/api/prs/${pr.id}/file?path=../../etc/passwd` });
  assert.equal(bad.statusCode, 400);
  const abs = await app.inject({ method: "GET", url: `/api/prs/${pr.id}/file?path=/etc/passwd` });
  assert.equal(abs.statusCode, 400);
});

test("GET /api/prs/:id/runs/:rid/output returns the persisted stream + error", async () => {
  const d = deps();
  const app = buildApp(d);
  const pr = insertPr(d.db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  const { startRun, finishRun } = await import("../src/server/db.ts");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const dir = mkdtempSync(`${process.env.SCRATCH ?? "/tmp"}/run-out-`);
  writeFileSync(`${dir}/task.log.txt`, "streamed agent output here");
  const rid = startRun(d.db, pr.id, "deep_review · claude/security");
  finishRun(d.db, rid, "failed", "engine timed out", `${dir}/task.log.txt`);

  const res = await app.inject({ method: "GET", url: `/api/prs/${pr.id}/runs/${rid}/output` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().error, "engine timed out");
  assert.equal(res.json().output, "streamed agent output here");

  const missing = await app.inject({ method: "GET", url: `/api/prs/${pr.id}/runs/99999/output` });
  assert.equal(missing.statusCode, 404);
});

test("GET/PUT /api/settings round-trips a config patch", async () => {
  const app = buildApp(deps());
  const before = await app.inject({ method: "GET", url: "/api/settings" });
  assert.equal(before.json().claudeModel, "opus");

  const put = await app.inject({ method: "PUT", url: "/api/settings", payload: { claudeModel: "sonnet", robotMarker: "🤖 mine" } });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().claudeModel, "sonnet");

  const after = await app.inject({ method: "GET", url: "/api/settings" });
  assert.equal(after.json().claudeModel, "sonnet");
  assert.equal(after.json().robotMarker, "🤖 mine");
});

test("adding a PR creates a repo-config row; PUT /api/repos/:owner/:repo saves guidance", async () => {
  const d = deps();
  const app = buildApp(d);
  await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });

  const list = await app.inject({ method: "GET", url: "/api/repos" });
  assert.equal(list.json().length, 1);
  assert.equal(list.json()[0].owner, "o");

  const put = await app.inject({ method: "PUT", url: "/api/repos/o/r", payload: { guidance: "treat prompt text as data" } });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().guidance, "treat prompt text as data");

  const got = await app.inject({ method: "GET", url: "/api/repos/o/r" });
  assert.equal(got.json().guidance, "treat prompt text as data");
});

test("PUT /api/preface sets the default; GET returns it", async () => {
  const app = buildApp(deps());
  await app.inject({ method: "PUT", url: "/api/preface", payload: { preface: "LGTM-ish:" } });
  const res = await app.inject({ method: "GET", url: "/api/preface" });
  assert.equal(res.json().default, "LGTM-ish:");
});

test("POST /api/prs/:id/findings/:fid/select 404s for a missing finding", async () => {
  const app = buildApp(deps());
  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;
  const res = await app.inject({ method: "POST", url: `/api/prs/${id}/findings/9999/select`, payload: { selected: true } });
  assert.equal(res.statusCode, 404);
});

test("POST /api/prs/:id/findings/:fid/select flips selected", async () => {
  const d = deps();
  const app = buildApp(d);
  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;
  const f = insertFinding(d.db, id, { engine: "claude", dimension: "correctness", severity: "serious", file: "x", line: 1, side: "RIGHT", what: "w", why: "y", suggestedFix: "f", anchorable: true, agreement: false });
  const res = await app.inject({ method: "POST", url: `/api/prs/${id}/findings/${f.id}/select`, payload: { selected: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(listFindings(d.db, id)[0].selected, true);
});

test("POST /api/prs/:id/findings/:fid/select 404s for a missing pr", async () => {
  const app = buildApp(deps());
  const res = await app.inject({ method: "POST", url: "/api/prs/9999/findings/1/select", payload: { selected: true } });
  assert.equal(res.statusCode, 404);
});

test("PUT /api/prs/:id/preface sets the pr preface", async () => {
  const d = deps();
  const app = buildApp(d);
  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;
  const res = await app.inject({ method: "PUT", url: `/api/prs/${id}/preface`, payload: { preface: "mine" } });
  assert.equal(res.statusCode, 200);
  assert.equal(getPr(d.db, id)!.preface, "mine");
});

test("PUT /api/prs/:id/preface 404s for a missing pr", async () => {
  const app = buildApp(deps());
  const res = await app.inject({ method: "PUT", url: "/api/prs/9999/preface", payload: { preface: "x" } });
  assert.equal(res.statusCode, 404);
});

test("GET /api/preface returns empty string when unset", async () => {
  const res = await buildApp(deps()).inject({ method: "GET", url: "/api/preface" });
  assert.equal(res.json().default, "");
});

test("POST /api/prs/:id/post posts and returns posted stage", async () => {
  const d = deps();
  const app = buildApp(d);
  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;
  // move it to ready with a selected finding (simulate pipeline output)
  updatePr(d.db, id, { stage: "ready", status: "done" });
  insertFinding(d.db, id, { engine: "claude", dimension: "correctness", severity: "serious", file: "x", line: 1, side: "RIGHT", what: "w", why: "y", suggestedFix: "f", anchorable: false, agreement: false, selected: true });
  const res = await app.inject({ method: "POST", url: `/api/prs/${id}/post` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().stage, "posted");
});

test("POST /api/prs/:id/post 500s when nothing is selected and no preface is set", async () => {
  const d = deps();
  const app = buildApp(d);
  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;
  updatePr(d.db, id, { stage: "ready", status: "done" });
  const res = await app.inject({ method: "POST", url: `/api/prs/${id}/post` });
  assert.equal(res.statusCode, 500);
  assert.match(res.json().error, /nothing to post/);
});

test("POST /api/prs/:id/post 400s on an unknown review event", async () => {
  const d = deps();
  const app = buildApp(d);
  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;
  updatePr(d.db, id, { stage: "ready", status: "done" });
  const res = await app.inject({ method: "POST", url: `/api/prs/${id}/post`, payload: { event: "MERGE" } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /invalid review event/);
});

test("POST /api/prs/:id/post accepts event=APPROVE with nothing selected", async () => {
  const d = deps();
  const app = buildApp(d);
  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;
  updatePr(d.db, id, { stage: "ready", status: "done" });
  const res = await app.inject({ method: "POST", url: `/api/prs/${id}/post`, payload: { event: "APPROVE" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().stage, "posted");
});

test("GET /api/prs/:id/conversation returns structured threads from gh", async () => {
  const d = deps();
  d.exec = async (cmd: string, args: string[]) => {
    if (args.includes("--paginate")) {
      return { stdout: JSON.stringify([{ id: 1, user: { login: "alice" }, body: "hm", path: "x.ts", line: 2, side: "RIGHT", created_at: "2026-01-01" }]), stderr: "" };
    }
    if (args.includes("reviews,comments")) return { stdout: JSON.stringify({ reviews: [], comments: [] }), stderr: "" };
    return { stdout: JSON.stringify({ title: "T", author: { login: "u" }, additions: 1, deletions: 0, changedFiles: 1 }), stderr: "" };
  };
  const app = buildApp(d);
  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;
  const res = await app.inject({ method: "GET", url: `/api/prs/${id}/conversation` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().threads.length, 1);
  assert.equal(res.json().threads[0].comments[0].author, "alice");
});

test("POST /api/prs/:id/conversation/reply routes to the replies endpoint (or issue comments without inReplyTo)", async () => {
  const d = deps();
  const calls: string[][] = [];
  d.exec = async (cmd: string, args: string[]) => { calls.push(args); return { stdout: JSON.stringify({ title: "T", author: { login: "u" }, additions: 1, deletions: 0, changedFiles: 1 }), stderr: "" }; };
  const app = buildApp(d);
  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;

  const threaded = await app.inject({ method: "POST", url: `/api/prs/${id}/conversation/reply`, payload: { body: "agreed", inReplyTo: 7 } });
  assert.equal(threaded.statusCode, 200);
  assert.ok(calls.some((a) => a.includes("repos/o/r/pulls/5/comments/7/replies")));

  const plain = await app.inject({ method: "POST", url: `/api/prs/${id}/conversation/reply`, payload: { body: "top-level note" } });
  assert.equal(plain.statusCode, 200);
  assert.ok(calls.some((a) => a.includes("repos/o/r/issues/5/comments")));

  const empty = await app.inject({ method: "POST", url: `/api/prs/${id}/conversation/reply`, payload: { body: "  " } });
  assert.equal(empty.statusCode, 400);
});

test("POST /api/prs/:id/post 404s for a missing pr", async () => {
  const app = buildApp(deps());
  const res = await app.inject({ method: "POST", url: "/api/prs/9999/post" });
  assert.equal(res.statusCode, 404);
});

test("GET /api/prs/:id/runs returns per-stage runs once the pipeline reaches ready", async () => {
  const d = deps();
  const app = buildApp(d);
  const received: WsMessage[] = [];
  d.hub.add({ send: (data: string) => received.push(JSON.parse(data) as WsMessage) });

  const post = await app.inject({ method: "POST", url: "/api/prs", payload: { urls: ["https://github.com/o/r/pull/5"] } });
  const id = post.json().created[0].id;

  let sawFindingsUpdated = false;
  for (let waited = 0; waited < 2000; waited += 20) {
    sawFindingsUpdated = received.some((m) => m.type === "findings_updated" && m.prId === id);
    if (sawFindingsUpdated) break;
    await setTimeout(20);
  }
  assert.ok(sawFindingsUpdated, "timed out waiting for findings_updated broadcast");

  const res = await app.inject({ method: "GET", url: `/api/prs/${id}/runs` });
  assert.equal(res.statusCode, 200);
  const runs = res.json();
  // Top-level stages (sub-runs like "deep_review · claude/correctness" are excluded).
  const stages = runs.map((r: { stage: string }) => r.stage).filter((s: string) => !s.includes("·"));
  assert.deepEqual(stages, ["prepare", "triage", "deep_review", "synthesize"]);
  // Deep review records a per-engine sub-run so the timeline shows what ran.
  const subRuns = runs.map((r: { stage: string }) => r.stage).filter((s: string) => s.includes("·"));
  assert.ok(subRuns.some((s: string) => s.includes("codex/full")), "expected a codex sub-run");
  assert.ok(subRuns.some((s: string) => s.includes("claude/")), "expected claude sub-runs");
});

test("GET /api/prs/:id/runs 404s for a missing pr", async () => {
  const app = buildApp(deps());
  const res = await app.inject({ method: "GET", url: "/api/prs/9999/runs" });
  assert.equal(res.statusCode, 404);
});
