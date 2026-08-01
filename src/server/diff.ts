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

/** Per-file segments of a unified diff, keyed by new-side path. */
export function diffSections(diff: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of diff.split(/^(?=diff --git )/m)) {
    const m = /^diff --git a\/.* b\/(.+)$/m.exec(part);
    if (m && !map.has(m[1])) map.set(m[1], part);
  }
  return map;
}
