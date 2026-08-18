import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./exec.ts";

export function cachePath(dataDir: string, owner: string, repo: string): string {
  return join(dataDir, "cache", owner, repo);
}

export function worktreePath(dataDir: string, prId: number): string {
  return join(dataDir, "worktrees", `pr-${prId}`);
}

/**
 * The lineage-tip checkout, keyed by the tip commit rather than by PR: every PR
 * in a stack resolves to the same tip, and at ~96 MB a worktree (data/worktrees
 * is 2.4 GB across 25 of them) a per-PR copy of identical content is not worth
 * the disk.
 */
export function tipWorktreePath(dataDir: string, owner: string, repo: string, tipSha: string): string {
  return join(dataDir, "worktrees", "tips", owner, repo, tipSha.slice(0, 12));
}

/**
 * Guards on the lineage search. A head that is already on the default branch
 * makes `--contains` return every branch cut since (175 refs, measured, with
 * origin/main itself 300 commits "ahead") — the ancestor check below catches
 * the common case and these catch the rest. Anything past a cap means we are
 * not looking at a stack, so we look at nothing.
 */
export const MAX_TIP_CANDIDATES = 60;
export const MAX_TIP_AHEAD = 100;

export interface LineageTipCandidate {
  sha: string;
  ref: string;
  ahead: number; // commits between the PR head and this ref
}

/**
 * The furthest-ahead candidate, or null when none qualifies. Ties break on the
 * lexicographically smallest ref purely for determinism — real repos carry
 * duplicate branches at one commit (`…-automation` and `…-automation-core`),
 * and which of the two we name must not depend on ref-iteration order.
 */
export function pickLineageTip(candidates: LineageTipCandidate[]): LineageTipCandidate | null {
  let best: LineageTipCandidate | null = null;
  for (const c of candidates) {
    // ahead <= 0: the ref IS the head (a standalone PR). Over the cap: not a
    // stack — most likely a long-lived branch that happens to contain the head.
    if (c.ahead <= 0 || c.ahead > MAX_TIP_AHEAD) continue;
    if (!best || c.ahead > best.ahead || (c.ahead === best.ahead && c.ref < best.ref)) best = c;
  }
  return best;
}

/**
 * Tip of the branch lineage the PR head sits on: the furthest-ahead remote
 * branch that contains it.
 *
 * A deep-review agent works in a worktree pinned at the PR head, so on a
 * stacked series everything the later PRs add is literally not on disk. Agents
 * grep for a caller or a test, find none, and report an absence: on a real
 * 21-PR stack that was 15 of 168 findings ("not tested", "dead code",
 * "unused"). The tip is what lets them check before they claim.
 *
 * Entirely best-effort: every failure path returns null and the review runs
 * exactly as it did before.
 */
async function resolveLineageTip(exec: Exec, cache: string, headSha: string): Promise<LineageTipCandidate | null> {
  try {
    // Merged PRs have no lineage worth following — their head is on the default
    // branch, so "contained by" degenerates into "every branch cut since". If
    // origin/HEAD is missing we cannot run the guard; the caps below are the
    // backstop. A non-zero --is-ancestor (the normal case) throws and falls
    // through to the search.
    try {
      const defaultBranch = (
        await exec("git", ["-C", cache, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
      ).stdout.trim();
      if (defaultBranch) {
        await exec("git", ["-C", cache, "merge-base", "--is-ancestor", headSha, defaultBranch]);
        return null;
      }
    } catch {
      // not merged, or no origin/HEAD — either way, keep looking
    }

    // for-each-ref over branch -r: it yields the commit and the ref name in one
    // pass (so duplicates collapse for free) and skips the origin/HEAD symref.
    const listed = (
      await exec("git", [
        "-C", cache, "for-each-ref", "--contains", headSha, "refs/remotes/origin",
        "--format=%(objectname) %(refname:short)",
      ])
    ).stdout;
    const bySha = new Map<string, string>();
    for (const line of listed.split("\n")) {
      const [sha, ref] = line.trim().split(/\s+/);
      // A ref sitting exactly on the head is this PR's own branch: nothing ahead.
      if (!sha || !ref || sha === headSha) continue;
      const prev = bySha.get(sha);
      if (prev === undefined || ref < prev) bySha.set(sha, ref);
    }
    // One rev-list per distinct commit is the cost here (~20 ms each), so refuse
    // outright rather than measure a field that can't be a stack.
    if (bySha.size === 0 || bySha.size > MAX_TIP_CANDIDATES) return null;

    const candidates: LineageTipCandidate[] = [];
    for (const [sha, ref] of bySha) {
      const out = (await exec("git", ["-C", cache, "rev-list", "--count", `${headSha}..${sha}`])).stdout.trim();
      const ahead = Number.parseInt(out, 10);
      if (Number.isFinite(ahead)) candidates.push({ sha, ref, ahead });
    }
    return pickLineageTip(candidates);
  } catch {
    // shallow clone, pruned ref, an unexpected git version — no tip.
    return null;
  }
}

/**
 * The shared checkout at `tipSha`, created once per stack.
 *
 * An existing path is reused AS-IS — never removed and re-added, because a
 * sibling PR's review may be reading it right now. It cannot go stale in place:
 * the path is derived from the commit, so a branch that moves resolves to a new
 * path rather than dirtying this one.
 */
async function ensureTipWorktree(
  exec: Exec,
  cache: string,
  tipPath: string,
  tipSha: string,
  fileExists: (p: string) => boolean,
): Promise<boolean> {
  if (fileExists(tipPath)) return true;
  try {
    await exec("git", ["-C", cache, "worktree", "add", "--detach", tipPath, tipSha]);
    return true;
  } catch {
    // Usually a stale administrative entry left behind when a purge deleted the
    // directory but not git's record of it. Prune and try once more.
    try {
      await exec("git", ["-C", cache, "worktree", "prune"]);
      await exec("git", ["-C", cache, "worktree", "add", "--detach", tipPath, tipSha]);
      return true;
    } catch {
      return false;
    }
  }
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
  baseTipSha: string | null; // current tip of the PR's base branch, when known
  // Read-only checkout at the tip of this branch's lineage (see resolveLineageTip);
  // null whenever there isn't one, which is the no-op state everywhere downstream.
  lineageTip: (LineageTipCandidate & { path: string }) | null;
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
    /** Resolve + check out the lineage tip (default true; the config kill switch). */
    lineageTip?: boolean;
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
    let baseTipSha: string | null = null;
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
      // The tip too: for a stacked PR whose base branch was rebased after this
      // branch forked, the merge-base is a bad base and the tip is the right one.
      // pickPinnedBase() decides between them; resolve both under the repo lock.
      try {
        baseTipSha = (await exec("git", ["-C", cache, "rev-parse", `origin/${opts.baseRef}`])).stdout.trim() || null;
      } catch {
        // unknown base branch — leave null
      }
    }

    // Still under the repo lock, deliberately: a 21-PR stack all resolves to
    // one tip, and holding the lock is what makes them create it exactly once
    // instead of racing 21 `worktree add`s at the same path.
    let lineageTip: PreparedWorktree["lineageTip"] = null;
    if (headSha && (opts.lineageTip ?? true)) {
      const found = await resolveLineageTip(exec, cache, headSha);
      if (found) {
        const tipPath = tipWorktreePath(opts.dataDir, opts.owner, opts.repo, found.sha);
        if (await ensureTipWorktree(exec, cache, tipPath, found.sha, fileExists)) {
          lineageTip = { ...found, path: tipPath };
        }
      }
    }
    return { path: wt, headSha, baseSha, baseTipSha, lineageTip };
  };

  return withRepoLock(cache, body);
}
