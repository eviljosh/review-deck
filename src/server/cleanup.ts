import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { listPrs } from "./db.ts";

/**
 * Startup disk cleanup: remove worktrees under data/worktrees that no active
 * PR references anymore — leftovers from deleted PRs, crashes, or manual db
 * edits. A worktree is kept while its PR is still being worked on; anything
 * else is safe to reclaim because prepare re-creates worktrees on demand.
 */
export function purgeOrphanWorktrees(db: Database.Database, dataDir: string): number {
  const root = join(dataDir, "worktrees");
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0; // no worktrees dir yet — nothing to clean
  }

  const referenced = new Set(
    listPrs(db)
      .filter((p) => p.status === "running")
      .map((p) => p.worktree_path)
      .filter((w): w is string => !!w),
  );

  let purged = 0;
  for (const entry of entries) {
    const full = join(root, entry);
    if (referenced.has(full)) continue;
    rmSync(full, { recursive: true, force: true });
    purged++;
  }
  return purged;
}
