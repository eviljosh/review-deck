import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./exec.ts";

export function cachePath(dataDir: string, owner: string, repo: string): string {
  return join(dataDir, "cache", owner, repo);
}

export function worktreePath(dataDir: string, prId: number): string {
  return join(dataDir, "worktrees", `pr-${prId}`);
}

// Per-repo mutex: concurrent prepareWorktree calls for the SAME repo (same
// cache path) must run one at a time, since they share a clone/fetch target
// and racing `git` invocations can corrupt the index/config lock or double
// clone. Different repos are independent and stay parallel.
const repoLocks = new Map<string, Promise<unknown>>();

async function withRepoLock<T>(key: string, body: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(key) ?? Promise.resolve();
  // Run after the prior op for this key settles, whether it resolved or
  // rejected — a failed clone/fetch for one PR must not deadlock the next.
  const run = previous.then(body, body);
  repoLocks.set(key, run);
  try {
    return await run;
  } finally {
    // Only the last waiter clears the entry, so a still-pending successor
    // isn't unlinked from the chain.
    if (repoLocks.get(key) === run) {
      repoLocks.delete(key);
    }
  }
}

export interface PreparedWorktree {
  path: string;
  headSha: string | null; // resolved PR head ("" from a failed rev-parse → null)
  baseSha: string | null; // merge-base against the PR's base branch, when known
}

export async function prepareWorktree(
  exec: Exec,
  opts: {
    dataDir: string;
    owner: string;
    repo: string;
    number: number;
    prId: number;
    baseRef?: string;
    fileExists?: (p: string) => boolean;
    onLog?: (chunk: string) => void;
  },
): Promise<PreparedWorktree> {
  const fileExists = opts.fileExists ?? existsSync;
  const cache = cachePath(opts.dataDir, opts.owner, opts.repo);
  const wt = worktreePath(opts.dataDir, opts.prId);
  const onLog = opts.onLog;
  const log = (msg: string) => onLog?.(msg);

  const body = async (): Promise<PreparedWorktree> => {
    if (!fileExists(cache)) {
      // Clone over SSH, not HTTPS: without a git credential helper configured,
      // an HTTPS clone prompts for a username/password on the server's stdin
      // (which nobody is watching) and hangs the pipeline. SSH reuses the user's
      // existing key — the same protocol `gh` is configured to use.
      log(`[prepare] cloning ${opts.owner}/${opts.repo} (first time — large repos can take a few minutes)…\n`);
      // Blobless partial clone: full history/trees but blobs fetched on demand —
      // much faster first clone and far less disk for large repos.
      await exec("git", [
        "clone",
        "--filter=blob:none",
        "--progress",
        `git@github.com:${opts.owner}/${opts.repo}.git`,
        cache,
      ], { onLog });
    }

    log(`[prepare] fetching latest + PR #${opts.number}…\n`);
    await exec("git", ["-C", cache, "fetch", "--prune", "--progress", "origin"], { onLog });
    await exec("git", ["-C", cache, "fetch", "--progress", "origin", `pull/${opts.number}/head`], { onLog });

    // Remove any stale worktree from a previous run; ignore failure.
    try {
      await exec("git", ["-C", cache, "worktree", "remove", "--force", wt]);
    } catch {
      // no prior worktree — fine
    }

    log(`[prepare] checking out PR into a throwaway worktree…\n`);
    await exec("git", ["-C", cache, "worktree", "add", "--detach", wt, "FETCH_HEAD"], { onLog });

    // Resolve the exact commits while we still hold the repo lock — FETCH_HEAD
    // and origin/<base> are repo-global and a concurrent prepare for another PR
    // would clobber them the moment we release it.
    let headSha: string | null = null;
    let baseSha: string | null = null;
    try {
      headSha = (await exec("git", ["-C", cache, "rev-parse", "FETCH_HEAD"])).stdout.trim() || null;
    } catch {
      // pinning is best-effort; stages fall back to live gh diffs
    }
    if (headSha && opts.baseRef) {
      try {
        baseSha = (await exec("git", ["-C", cache, "merge-base", `origin/${opts.baseRef}`, headSha])).stdout.trim() || null;
      } catch {
        // unknown base branch — leave null
      }
    }
    return { path: wt, headSha, baseSha };
  };

  return withRepoLock(cache, body);
}
