import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, insertPr, getPr } from "../src/server/db.ts";
import type { Exec } from "../src/server/exec.ts";
import { runPrepare } from "../src/server/prepare.ts";

function ghExec(): Exec {
  return async (cmd, args) => {
    if (cmd === "gh" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          title: "Fix thing",
          author: { login: "octocat" },
          additions: 10,
          deletions: 2,
          changedFiles: 3,
        }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" }; // gh diff + all git commands
  };
}

test("runPrepare fills metadata, sets worktree, advances to triage/pending", async () => {
  const db = openDb(":memory:");
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  const updates: string[] = [];
  const result = await runPrepare(
    {
      db,
      exec: ghExec(),
      dataDir: "/data",
      onUpdate: (p) => updates.push(`${p.stage}:${p.status}`),
    },
    pr.id,
  );
  assert.equal(result.title, "Fix thing");
  assert.equal(result.author, "octocat");
  assert.equal(result.additions, 10);
  assert.equal(result.worktree_path, "/data/worktrees/pr-" + pr.id);
  assert.equal(result.stage, "triage");
  assert.equal(result.status, "pending");
  assert.ok(updates.includes("prepare:running"));
  assert.ok(updates.includes("triage:pending"));
});

test("runPrepare records failure and rethrows", async () => {
  const db = openDb(":memory:");
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
  const failing: Exec = async () => {
    throw new Error("gh boom");
  };
  const emitted: string[] = [];
  await assert.rejects(
    runPrepare({ db, exec: failing, dataDir: "/data", onUpdate: (p) => emitted.push(p.status) }, pr.id),
    /gh boom/,
  );
  assert.ok(emitted.includes("failed"));
  const row = getPr(db, pr.id)!;
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /gh boom/);
});
