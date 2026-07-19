import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, insertPr } from "../src/server/db.ts";
import type { Exec } from "../src/server/exec.ts";
import { getPinnedDiff } from "../src/server/diff.ts";
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
