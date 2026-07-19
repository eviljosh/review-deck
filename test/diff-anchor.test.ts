import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorableLines, isAnchorable } from "../src/server/diff-anchor.ts";

const DIFF = [
  "diff --git a/src/x.ts b/src/x.ts",
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "@@ -10,3 +10,4 @@ function f() {",
  " const a = 1;",   // context → RIGHT line 10
  "-const b = 2;",   // removed → not a RIGHT line
  "+const b = 3;",   // added → RIGHT line 11
  "+const c = 4;",   // added → RIGHT line 12
  " return a;",      // context → RIGHT line 13
].join("\n");

test("anchorableLines maps added/context lines on the RIGHT side", () => {
  const map = anchorableLines(DIFF);
  const lines = map.get("src/x.ts")!;
  assert.ok(lines.has(11) && lines.has(12)); // added
  assert.ok(lines.has(10) && lines.has(13)); // context
});

test("isAnchorable is false for a line not in the diff", () => {
  const map = anchorableLines(DIFF);
  assert.equal(isAnchorable(map, "src/x.ts", 11, "RIGHT"), true);
  assert.equal(isAnchorable(map, "src/x.ts", 99, "RIGHT"), false);
  assert.equal(isAnchorable(map, "other.ts", 11, "RIGHT"), false);
});

test("isAnchorable is false for LEFT side even when the line is in the diff", () => {
  const map = anchorableLines(DIFF);
  assert.equal(isAnchorable(map, "src/x.ts", 11, "RIGHT"), true);
  assert.equal(isAnchorable(map, "src/x.ts", 11, "LEFT"), false);
});

test("does not mistake an added line starting with ++ for a file header", () => {
  const d = ["--- a/notes.txt","+++ b/notes.txt","@@ -1,2 +1,3 @@"," line one","+++ marker line"," line two"].join("\n");
  const map = anchorableLines(d);
  const lines = map.get("notes.txt")!;
  // Hunk declares 3 new-side lines (+1,3): context, the added "++ …" line, context.
  assert.ok(lines.has(1) && lines.has(2) && lines.has(3));
  assert.equal(lines.has(4), false); // no 4th new-side line in this hunk
  assert.equal(map.has("marker line"), false);
});
test("handles multiple hunks in one file with independent counters", () => {
  const d = ["+++ b/x.ts","@@ -1,1 +1,2 @@"," a","+b","@@ -10,1 +20,2 @@"," c","+d"].join("\n");
  const lines = anchorableLines(d).get("x.ts")!;
  assert.ok(lines.has(1) && lines.has(2) && lines.has(20) && lines.has(21));
});
test("handles multiple files", () => {
  const d = ["+++ b/a.ts","@@ -1,0 +1,1 @@","+aa","diff --git a/b.ts b/b.ts","+++ b/b.ts","@@ -1,0 +1,1 @@","+bb"].join("\n");
  const map = anchorableLines(d);
  assert.ok(map.get("a.ts")!.has(1) && map.get("b.ts")!.has(1));
});
