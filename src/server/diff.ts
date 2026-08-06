import type { Exec } from "./exec.ts";
import type { PrRecord } from "../shared/types.ts";
import { readArtifact } from "./artifacts.ts";
import { fetchPrDiff } from "./gh.ts";

// The diff every stage reviews against: the one pinned at prepare time
// (data/artifacts/<pr>/prepare/diff.patch), so triage, deep review, synthesis,
// and posting all see the same code even if the author pushes mid-review.
// Falls back to a live `gh pr diff` for rows prepared before pinning existed
// (or when the artifact write failed).
export async function getPinnedDiff(exec: Exec, dataDir: string, pr: PrRecord): Promise<string> {
  const pinned = readArtifact(dataDir, pr.id, "prepare", "diff.patch");
  if (pinned) return pinned;
  return fetchPrDiff(exec, pr.owner, pr.repo, pr.number);
}

/** New-side paths of every file a unified diff touches, in diff order. */
export function diffPaths(diff: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of diff.matchAll(/^diff --git a\/.* b\/(.+)$/gm)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

/**
 * Size of a unified diff, measured from the diff itself.
 *
 * GitHub's PR counters (`additions`/`deletions`/`changedFiles`) can describe a
 * different diff than the one under review: GitHub stops refreshing them while
 * a PR is conflicted, and a stacked branch that merges its base's ancestor
 * leaves them describing a long-gone state. Telling a reviewing agent "11 files"
 * while handing it 445 wastes its output budget on litigating the mismatch, so
 * every prompt sizes the diff it was actually given.
 */
export function diffStats(diff: string): { additions: number; deletions: number; changedFiles: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    // "+++"/"---" are file headers, not content lines. A content line whose
    // own text begins "++" or "--" is skipped too (git parses hunk structure
    // and would count it) — close enough for a prompt size hint, and the
    // mismatch note keys on diffPaths(), which only matches real headers.
    if (line.startsWith("+")) { if (!line.startsWith("+++")) additions++; }
    else if (line.startsWith("-")) { if (!line.startsWith("---")) deletions++; }
  }
  return { additions, deletions, changedFiles: diffPaths(diff).length };
}

export type BaseMode = "merge-base" | "base-tip";

export interface BaseCandidate {
  sha: string;
  diff: string;
}

/**
 * Which base the pinned diff should be computed against.
 *
 * `merge-base` is the standard PR diff and the default: it excludes work the
 * base branch picked up after this branch forked, which is exactly what you
 * want when the base is a long-lived branch that keeps moving.
 *
 * It breaks down for a *stacked* PR whose base branch was rewritten — rebased
 * or force-pushed — after this branch forked off it. The head still carries the
 * base's pre-rebase commits, so the merge-base falls back to wherever the two
 * histories last agreed, and `merge-base..head` sweeps in the whole base branch's
 * work as if this PR had written it. plenful#7218 fed reviewers 445 files /
 * 1.9MB that way; against the base branch's tip the same PR is 8 files.
 *
 * Both failure modes are visible in the file counts, which is what this keys on:
 *   • base branch moved ahead normally → the base-tip diff is the *larger* of
 *     the two (it adds the base's new work back in, inverted) → keep merge-base.
 *   • base branch was rewritten → the base-tip diff is dramatically *smaller*
 *     (it drops the base's work, which was never this PR's) → use base-tip.
 * The margin (2x and at least 5 files) keeps small, ordinary differences from
 * flipping the choice; a rewritten base shows up as an order of magnitude.
 *
 * Caveat worth knowing when the base-tip diff wins: two-dot against the tip
 * renders base commits the head hasn't absorbed as reversals. That noise is
 * bounded by how far the base has moved, and it beats reviewing 437 files of
 * someone else's code.
 */
export function pickPinnedBase(
  mergeBase: BaseCandidate,
  baseTip: BaseCandidate | null,
): { sha: string; diff: string; mode: BaseMode } {
  const chosen = { sha: mergeBase.sha, diff: mergeBase.diff, mode: "merge-base" as BaseMode };
  if (!baseTip || baseTip.sha === mergeBase.sha) return chosen;
  const tipFiles = diffPaths(baseTip.diff).length;
  const mergeBaseFiles = diffPaths(mergeBase.diff).length;
  // An empty base-tip diff means the head is already contained in the base
  // branch: there'd be nothing left to review, so keep the merge-base diff.
  if (tipFiles === 0) return chosen;
  if (mergeBaseFiles >= tipFiles * 2 && mergeBaseFiles - tipFiles >= 5) {
    return { sha: baseTip.sha, diff: baseTip.diff, mode: "base-tip" };
  }
  return chosen;
}

/**
 * Files a base-tip diff carries only because the base branch moved on.
 *
 * Diffing two-dot against the base branch tip renders base commits the head
 * never absorbed as *reversals*: the base's own work, played backwards, framed
 * as this PR's doing. On plenful#7218 that was 3 of 8 files, and a reviewer
 * dutifully filed a moderate finding accusing the PR of an "undescribed
 * behavior change" that was in fact one base commit inverted.
 *
 * A file is drift when both hold:
 *   • some base commit the head lacks touched it, and
 *   • the PR itself never touched it (unchanged between merge-base and head).
 * The second condition is what keeps real work from being filtered away when a
 * PR and its base edit the same file — then the reversal noise is entangled
 * with genuine changes and dropping the file would hide the PR's own edits.
 *
 * Both arguments are raw newline-separated `git` path output.
 */
export function baseDriftFiles(touchedByUnabsorbedBaseCommits: string, touchedByPr: string): Set<string> {
  const lines = (raw: string): string[] => raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const prTouched = new Set(lines(touchedByPr));
  return new Set(lines(touchedByUnabsorbedBaseCommits).filter((f) => !prTouched.has(f)));
}

/** `diff` with every section for a path in `drop` removed. */
export function dropDiffFiles(diff: string, drop: ReadonlySet<string>): string {
  if (drop.size === 0) return diff;
  return diff
    .split(/^(?=diff --git )/m)
    .filter((part) => {
      const m = /^diff --git a\/.* b\/(.+)$/m.exec(part);
      return !m || !drop.has(m[1]);
    })
    .join("");
}

/** How to describe, to a reviewing agent, the base a pinned diff was taken against. */
export function baseLabel(pr: Pick<PrRecord, "base_mode" | "base_sha">): string | undefined {
  if (!pr.base_sha) return undefined;
  const sha = pr.base_sha.slice(0, 8);
  return pr.base_mode === "base-tip"
    ? `the tip of the PR's base branch (\`${sha}\`)`
    : `the merge-base with the PR's base branch (\`${sha}\`)`;
}

/** Per-file segments of a unified diff, keyed by new-side path. */
export function diffSections(diff: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of diff.split(/^(?=diff --git )/m)) {
    const m = /^diff --git a\/.* b\/(.+)$/m.exec(part);
    if (m && !map.has(m[1])) map.set(m[1], part);
  }
  return map;
}
