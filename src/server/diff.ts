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
    // "+++"/"---" are file headers, not content lines — same rule `git
    // diff --shortstat` applies, so these totals match what git reports.
    if (line.startsWith("+")) { if (!line.startsWith("+++")) additions++; }
    else if (line.startsWith("-")) { if (!line.startsWith("---")) deletions++; }
  }
  return { additions, deletions, changedFiles: diffPaths(diff).length };
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
