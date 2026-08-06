import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, insertPr } from "../src/server/db.ts";
import type { Exec } from "../src/server/exec.ts";
import { getPinnedDiff, diffStats } from "../src/server/diff.ts";
import { stageArtifactDir, writeArtifacts } from "../src/server/artifacts.ts";

function seed() {
  const db = openDb(":memory:");
  return insertPr(db, { url: "https://github.com/o/r/pull/5", owner: "o", repo: "r", number: 5 });
}

test("getPinnedDiff returns the prepare-stage artifact when present", async () => {
  const pr = seed();
  const dataDir = `${process.env.SCRATCH ?? "/tmp"}/diff-a-${Date.now()}`;
  writeArtifacts(stageArtifactDir(dataDir, pr.id, "prepare"), { "diff.patch": "pinned diff content" });
  const exec: Exec = async () => { throw new Error("gh should not be called"); };
  assert.equal(await getPinnedDiff(exec, dataDir, pr), "pinned diff content");
});

test("getPinnedDiff falls back to gh pr diff when no artifact exists", async () => {
  const pr = seed();
  const dataDir = `${process.env.SCRATCH ?? "/tmp"}/diff-b-${Date.now()}`;
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: "live diff", stderr: "" }; };
  assert.equal(await getPinnedDiff(exec, dataDir, pr), "live diff");
  assert.deepEqual(calls[0], ["gh", "pr", "diff", "5", "--repo", "o/r"]);
});

test("diffStats counts content lines and files, ignoring +++/--- headers", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "index 1111111..2222222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,3 @@",
    " context",
    "-gone",
    "+added one",
    "+added two",
    "diff --git a/b.ts b/b.ts",
    "--- /dev/null",
    "+++ b/b.ts",
    "@@ -0,0 +1 @@",
    "+only line",
  ].join("\n");
  assert.deepEqual(diffStats(diff), { additions: 3, deletions: 1, changedFiles: 2 });
});

test("diffStats of an empty diff is all zeros", () => {
  assert.deepEqual(diffStats(""), { additions: 0, deletions: 0, changedFiles: 0 });
});
