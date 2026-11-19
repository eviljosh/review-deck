import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, insertPr } from "../src/server/db.ts";
import type { Exec } from "../src/server/exec.ts";
import { getPinnedDiff, diffStats, pickPinnedBase, baseDriftFiles, dropDiffFiles, baseLabel, diffPaths, findingDiffEvidence } from "../src/server/diff.ts";
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

test("findingDiffEvidence matches both sides of a renamed file and deduplicates the hunk", () => {
  const headers = "diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n";
  const first = "@@ -8,2 +9,2 @@\n-old value\n+new value\n context\n";
  const second = "@@ -27 +28,0 @@\n-removed elsewhere\n";
  const diff = headers + first + second;

  assert.deepEqual(findingDiffEvidence(diff, [
    { file: "new.ts", line: 10, side: "RIGHT" },
    { file: "old.ts", line: 8, side: "LEFT" },
  ]), { excerpts: [headers + first], missing: [] });

  assert.deepEqual(findingDiffEvidence(diff, [
    { file: "new.ts", line: 28, side: "RIGHT" },
    { file: "other.ts", line: 9, side: "RIGHT" },
    { file: "new.ts", line: null, side: "RIGHT" },
    { file: "old.ts", line: 99, side: "LEFT" },
  ]), { excerpts: [], missing: ["new.ts:28", "other.ts:9", "new.ts (no line)", "old.ts:99 (old side)"] });
});

test("findingDiffEvidence reports anchors it cannot fit even as a one-line window", () => {
  const file = (path: string, added: string) =>
    `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${added}\n`;
  const oversized = file("oversized.ts", "é".repeat(4500));
  const large = ["a.ts", "b.ts", "c.ts"].map((path) => file(path, "x".repeat(6000)));
  const small = file("small.ts", "small");
  const evidence = findingDiffEvidence(
    oversized + large.join("") + small,
    ["oversized.ts", "a.ts", "b.ts", "c.ts", "small.ts"].map((path) =>
      ({ file: path, line: 1, side: "RIGHT" })),
  );
  assert.deepEqual(evidence, {
    excerpts: [...large.slice(0, 2), small],
    missing: ["oversized.ts:1", "c.ts:1"],
  });
});

test("findingDiffEvidence cuts a hunk too large to send whole to a window around the anchor", () => {
  const headers = "diff --git a/big.ts b/big.ts\nnew file mode 100644\n--- /dev/null\n+++ b/big.ts\n";
  const lines = Array.from({ length: 600 }, (_, i) => `+const line${i + 1} = "${"x".repeat(30)}";`);
  const diff = headers + "@@ -0,0 +1,600 @@\n" + lines.join("\n") + "\n";

  const evidence = findingDiffEvidence(diff, [
    { file: "big.ts", line: 300, side: "RIGHT" },
    { file: "big.ts", line: 320, side: "RIGHT" }, // inside the first window: not sent twice
  ]);
  assert.deepEqual(evidence, {
    excerpts: [headers + "@@ -0,0 +260,81 @@\n" + lines.slice(259, 340).join("\n") + "\n"],
    missing: [],
  });
});

test("findingDiffEvidence windows removed lines with an old-side header", () => {
  const headers = "diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ b/gone.ts\n";
  const lines = Array.from({ length: 400 }, (_, i) => `-const removed${i + 1} = "${"y".repeat(30)}";`);
  const diff = headers + "@@ -1,400 +0,0 @@\n" + lines.join("\n") + "\n";

  assert.deepEqual(findingDiffEvidence(diff, [{ file: "gone.ts", line: 10, side: "LEFT" }]), {
    excerpts: [headers + "@@ -1,50 +0,0 @@\n" + lines.slice(0, 50).join("\n") + "\n"],
    missing: [],
  });
});

test("findingDiffEvidence spends the byte budget on the most severe findings first", () => {
  const file = (path: string) =>
    `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${"x".repeat(6000)}\n`;
  const evidence = findingDiffEvidence(file("a.ts") + file("b.ts") + file("c.ts"), [
    { file: "a.ts", line: 1, side: "RIGHT", severity: "optional" },
    { file: "b.ts", line: 1, side: "RIGHT", severity: "optional" },
    { file: "c.ts", line: 1, side: "RIGHT", severity: "blocking" },
  ]);
  assert.deepEqual(evidence, { excerpts: [file("c.ts"), file("a.ts")], missing: ["b.ts:1"] });
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
