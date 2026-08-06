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

// A stacked PR whose base branch was rebased after this branch forked: the
// merge-base diff carries the base branch's own work, the base-branch tip diff
// is the PR's actual change. plenful#7218 was 445 files vs 8.
function stackedExec(seen: string[][]): Exec {
  const HEAD = "dc15610ec6de113950d4d6ba0a8a0c4066c1a12b";
  const MERGE_BASE = "43717a84bd5152c4659f7e7150bfcd7b6db04037";
  const BASE_TIP = "52cfc030f8db2fd0c5249ab0eeee1626ef482187";
  const fileDiff = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => `diff --git a/${tag}${i}.py b/${tag}${i}.py\n--- a/${tag}${i}.py\n+++ b/${tag}${i}.py\n@@ -1 +1 @@\n-o\n+n`).join("\n");
  return async (cmd, args) => {
    seen.push([cmd, ...args]);
    if (cmd === "gh" && args.some((a) => a.includes("baseRefName"))) {
      return { stdout: JSON.stringify({
        title: "stacked", author: { login: "isabel" }, additions: 1656, deletions: 16,
        changedFiles: 11, baseRefName: "isabel/mfp-67-normalize-835-data",
      }), stderr: "" };
    }
    if (cmd === "gh") return { stdout: JSON.stringify({ state: "OPEN", mergeable: "CONFLICTING" }), stderr: "" };
    if (args.includes("rev-parse") && args.includes("FETCH_HEAD")) return { stdout: `${HEAD}\n`, stderr: "" };
    if (args.includes("merge-base")) return { stdout: `${MERGE_BASE}\n`, stderr: "" };
    if (args.includes("rev-parse")) return { stdout: `${BASE_TIP}\n`, stderr: "" };
    if (args.includes("diff")) {
      const range = args[args.length - 1];
      return { stdout: range.startsWith(BASE_TIP) ? fileDiff(8, "mfp") : fileDiff(445, "base"), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
}

test("runPrepare pins against the base branch tip when the base was rebased under a stacked PR", async () => {
  const db = openDb(":memory:");
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/7218", owner: "o", repo: "r", number: 7218 });
  const seen: string[][] = [];
  const result = await runPrepare(
    { db, exec: stackedExec(seen), dataDir: `${process.env.SCRATCH ?? "/tmp"}/prep-stacked-${Date.now()}`, onUpdate: () => {} },
    pr.id,
  );
  assert.equal(result.base_mode, "base-tip");
  assert.equal(result.base_sha, "52cfc030f8db2fd0c5249ab0eeee1626ef482187");
  // Both candidates were measured before choosing.
  const diffRanges = seen.filter((c) => c.includes("diff") && c[0] === "git").map((c) => c[c.length - 1]);
  assert.equal(diffRanges.length, 2);
});

test("runPrepare keeps the merge-base when the base branch merely advanced", async () => {
  const db = openDb(":memory:");
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/9", owner: "o", repo: "r", number: 9 });
  const base = stackedExec([]);
  // Same wiring, but now the tip diff is the larger of the two — an ordinary PR
  // against a branch that kept moving.
  const exec: Exec = async (cmd, args) => {
    const r = await base(cmd, args);
    if (cmd === "git" && args.includes("diff")) {
      const range = args[args.length - 1];
      const n = range.startsWith("52cfc030") ? 380 : 11;
      return { stdout: Array.from({ length: n }, (_, i) => `diff --git a/x${i}.py b/x${i}.py\n@@ -1 +1 @@\n+n`).join("\n"), stderr: "" };
    }
    return r;
  };
  const result = await runPrepare(
    { db, exec, dataDir: `${process.env.SCRATCH ?? "/tmp"}/prep-normal-${Date.now()}`, onUpdate: () => {} },
    pr.id,
  );
  assert.equal(result.base_mode, "merge-base");
  assert.equal(result.base_sha, "43717a84bd5152c4659f7e7150bfcd7b6db04037");
});
