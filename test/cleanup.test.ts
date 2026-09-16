import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, insertPr, updatePr } from "../src/server/db.ts";
import { purgeOrphanWorktrees } from "../src/server/cleanup.ts";

function freshDataDir(): string {
  const dir = join(process.env.SCRATCH ?? "/tmp", `cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "worktrees"), { recursive: true });
  return dir;
}

function mkWorktree(dataDir: string, name: string): string {
  const p = join(dataDir, "worktrees", name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "file.txt"), "x");
  return p;
}

test("purgeOrphanWorktrees removes unreferenced worktrees", () => {
  const db = openDb(":memory:");
  const dataDir = freshDataDir();
  const orphan = mkWorktree(dataDir, "pr-99");
  assert.equal(purgeOrphanWorktrees(db, dataDir), 1);
  assert.ok(!existsSync(orphan));
});

test("purgeOrphanWorktrees keeps the worktree of a running PR", () => {
  const db = openDb(":memory:");
  const dataDir = freshDataDir();
  const kept = mkWorktree(dataDir, "pr-1");
  const orphan = mkWorktree(dataDir, "pr-2");
  const pr = insertPr(db, { url: "https://github.com/o/r/pull/1", owner: "o", repo: "r", number: 1 });
  updatePr(db, pr.id, { status: "running", worktree_path: kept });
  assert.equal(purgeOrphanWorktrees(db, dataDir), 1);
  assert.ok(existsSync(kept));
  assert.ok(!existsSync(orphan));
});

test("purgeOrphanWorktrees is a no-op when the worktrees dir does not exist", () => {
  const db = openDb(":memory:");
  assert.equal(purgeOrphanWorktrees(db, join(process.env.SCRATCH ?? "/tmp", "nope-does-not-exist")), 0);
});
