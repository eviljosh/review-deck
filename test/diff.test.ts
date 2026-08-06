import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, insertPr } from "../src/server/db.ts";
import type { Exec } from "../src/server/exec.ts";
import { getPinnedDiff, diffStats, pickPinnedBase, baseDriftFiles, dropDiffFiles, baseLabel, diffPaths } from "../src/server/diff.ts";
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

const basePickCases: [string, string, string | null, number, number, "merge-base" | "base-tip"][] = [
  // name,                                   mergeBase sha, baseTip sha, mbFiles, tipFiles, expected
  ["no base-tip candidate → merge-base",     "aaa",         null,        8,       0,        "merge-base"],
  ["base tip identical to merge-base",       "aaa",         "aaa",       8,       8,        "merge-base"],
  // A base branch that simply moved ahead re-adds its own work, inverted, so the
  // base-tip diff is the bigger one. Standard PR: keep the merge-base.
  ["base branch merely advanced",            "aaa",         "bbb",       11,      380,      "merge-base"],
  // plenful#7218: base branch rebased after this branch forked, so merge-base
  // swept in 437 files of the base's own work.
  ["base branch was rebased (stacked PR)",   "aaa",         "bbb",       445,     8,        "base-tip"],
  // Margin: smaller, but not by enough to be a rewritten base.
  ["difference under the 2x margin",         "aaa",         "bbb",       9,       6,        "merge-base"],
  ["2x but under the 5-file floor",          "aaa",         "bbb",       6,       3,        "merge-base"],
  // Nothing left to review against the tip — the head is already in the base.
  ["empty base-tip diff",                    "aaa",         "bbb",       12,      0,        "merge-base"],
];

for (const [name, mbSha, tipSha, mbFiles, tipFiles, expected] of basePickCases) {
  test(`pickPinnedBase: ${name}`, () => {
    const mergeBase = { sha: mbSha, files: mbFiles };
    const baseTip = tipSha === null ? null : { sha: tipSha, files: tipFiles };
    const picked = pickPinnedBase(mergeBase, baseTip);
    assert.equal(picked.mode, expected);
    assert.equal(picked.sha, (expected === "merge-base" ? mergeBase : baseTip!).sha);
  });
}

test("baseDriftFiles keeps files the PR also touched, drops the rest", () => {
  const baseOnly = "a.py\nb.py\nc.py\n";
  // The PR itself edited b.py, so its reversal noise is entangled with real
  // work and the file must survive; a.py/c.py are pure base drift.
  const prTouched = "b.py\nz.py\n";
  assert.deepEqual([...baseDriftFiles(baseOnly, prTouched)].sort(), ["a.py", "c.py"]);
});

test("baseDriftFiles is empty when the PR touched everything the base did", () => {
  assert.equal(baseDriftFiles("a.py\nb.py", "b.py\na.py\nc.py").size, 0);
});

test("dropDiffFiles removes only the named sections", () => {
  const diff = [
    "diff --git a/keep.py b/keep.py",
    "@@ -1 +1 @@",
    "+kept",
    "diff --git a/drop.py b/drop.py",
    "@@ -1 +1 @@",
    "+dropped",
    "diff --git a/also-keep.py b/also-keep.py",
    "@@ -1 +1 @@",
    "+kept too",
    "",
  ].join("\n");
  const out = dropDiffFiles(diff, new Set(["drop.py"]));
  assert.deepEqual(diffPaths(out), ["keep.py", "also-keep.py"]);
  assert.ok(!out.includes("dropped"));
  assert.ok(out.includes("kept too"));
});

test("dropDiffFiles returns the diff untouched when nothing is dropped", () => {
  const diff = "diff --git a/a.py b/a.py\n@@ -1 +1 @@\n+x\n";
  assert.equal(dropDiffFiles(diff, new Set()), diff);
});

test("baseLabel names the base the diff was taken against", () => {
  assert.equal(baseLabel({ base_mode: "base-tip", base_sha: "52cfc030f8db2fd0c" }), "the tip of the PR's base branch (`52cfc030`)");
  assert.equal(baseLabel({ base_mode: "merge-base", base_sha: "43717a84bd5152c4" }), "the merge-base with the PR's base branch (`43717a84`)");
  assert.equal(baseLabel({ base_mode: null, base_sha: null }), undefined);
});
