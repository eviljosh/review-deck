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
