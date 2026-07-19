import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./exec.ts";
import type { ReviewEvent } from "../shared/types.ts";
import { isBotAuthored } from "./post-review.ts";

export type PrMeta = {
  title: string;
  author: string;
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  baseRef: string;
};

export async function fetchPrMeta(
  exec: Exec,
  owner: string,
  repo: string,
  number: number,
): Promise<PrMeta> {
  const { stdout } = await exec("gh", [
    "pr", "view", String(number), "--repo", `${owner}/${repo}`,
    "--json", "title,author,body,additions,deletions,changedFiles,baseRefName",
  ]);
  const j = JSON.parse(stdout) as {
    title: string;
    author: { login: string } | null;
    body: string | null;
    additions: number;
    deletions: number;
    changedFiles: number;
    baseRefName?: string;
  };
  return {
    title: j.title,
    author: j.author?.login ?? "",
    body: (j.body ?? "").trim(),
    additions: j.additions,
    deletions: j.deletions,
    changedFiles: j.changedFiles,
    baseRef: j.baseRefName ?? "",
  };
}

// Existing review activity on the PR — reviews (with decision state), issue
// comments, and inline review comments — flattened into a chronological text
// transcript for the triage model to summarize. Best-effort: returns "" if
// nothing (or on any gh error), so triage never fails on this.
export async function fetchPrDiscussion(
  exec: Exec,
  owner: string,
  repo: string,
  number: number,
): Promise<string> {
  const entries: { at: string; text: string }[] = [];

  try {
    const { stdout } = await exec("gh", [
      "pr", "view", String(number), "--repo", `${owner}/${repo}`, "--json", "reviews,comments",
    ]);
    const j = JSON.parse(stdout) as {
      reviews?: { author?: { login?: string }; body?: string; state?: string; submittedAt?: string }[];
      comments?: { author?: { login?: string }; body?: string; createdAt?: string }[];
    };
    for (const r of j.reviews ?? []) {
      const body = (r.body ?? "").trim();
      // Skip empty plain COMMENTED reviews (usually just inline-comment wrappers);
      // keep anything with a body or a decision (APPROVED / CHANGES_REQUESTED).
      if (!body && (!r.state || r.state === "COMMENTED")) continue;
      // Skip our own previously-posted reviews — otherwise a re-review would
      // summarize the tool's earlier output as if it were human discussion.
      if (isBotAuthored(body)) continue;
      const state = r.state && r.state !== "COMMENTED" ? ` [${r.state}]` : "";
      entries.push({ at: r.submittedAt ?? "", text: `Review by ${r.author?.login ?? "unknown"}${state}: ${body || "(no body)"}` });
    }
    for (const c of j.comments ?? []) {
      const body = (c.body ?? "").trim();
      if (body && !isBotAuthored(body)) entries.push({ at: c.createdAt ?? "", text: `Comment by ${c.author?.login ?? "unknown"}: ${body}` });
    }
  } catch {
    // no reviews/comments available — fine
  }

  try {
    const { stdout } = await exec("gh", [
      "api", `repos/${owner}/${repo}/pulls/${number}/comments`, "--paginate",
    ]);
    const arr = JSON.parse(stdout) as {
      user?: { login?: string }; body?: string; path?: string; line?: number; original_line?: number; created_at?: string;
    }[];
    if (Array.isArray(arr)) {
      for (const c of arr) {
        const body = (c.body ?? "").trim();
        if (!body || isBotAuthored(body)) continue;
        const loc = c.path ? ` on ${c.path}:${c.line ?? c.original_line ?? "?"}` : "";
        entries.push({ at: c.created_at ?? "", text: `Inline comment by ${c.user?.login ?? "unknown"}${loc}: ${body}` });
      }
    }
  } catch {
    // no inline comments — fine
  }

  entries.sort((a, b) => a.at.localeCompare(b.at));
  let out = entries.map((e) => e.text).join("\n\n");
  const CAP = 8000; // bound the prompt; long threads get truncated
  if (out.length > CAP) out = out.slice(0, CAP) + "\n\n…(older activity truncated)";
  return out;
}

export type PrStatus = {
  state: string;          // OPEN | MERGED | CLOSED
  mergeable: string;      // MERGEABLE | CONFLICTING | UNKNOWN
  reviewDecision: string; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
  checks: string;         // passing | failing | pending | none
  headSha: string;        // current remote head oid ("" when unavailable)
};

type RollupItem = { status?: string; conclusion?: string; state?: string };

function deriveChecks(rollup: RollupItem[]): string {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let pending = false;
  let failing = false;
  const FAIL = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"];
  for (const c of rollup) {
    if (c.state) {
      // StatusContext: state is SUCCESS | FAILURE | ERROR | PENDING | EXPECTED
      if (c.state === "FAILURE" || c.state === "ERROR") failing = true;
      else if (c.state === "PENDING" || c.state === "EXPECTED") pending = true;
    } else if (c.status && c.status !== "COMPLETED") {
      pending = true; // CheckRun still running (QUEUED / IN_PROGRESS)
    } else if (c.conclusion && FAIL.includes(c.conclusion)) {
      failing = true;
    }
  }
  if (failing) return "failing";
  if (pending) return "pending";
  return "passing";
}

// PR state, mergeability, review decision, and a rolled-up CI status for the
// review queue. Best-effort: returns UNKNOWN/none on any gh/parse error.
export async function fetchPrStatus(
  exec: Exec,
  owner: string,
  repo: string,
  number: number,
): Promise<PrStatus> {
  try {
    const { stdout } = await exec("gh", [
      "pr", "view", String(number), "--repo", `${owner}/${repo}`,
      "--json", "state,mergeable,reviewDecision,statusCheckRollup,headRefOid",
    ]);
    const j = JSON.parse(stdout) as {
      state?: string; mergeable?: string; reviewDecision?: string; statusCheckRollup?: RollupItem[]; headRefOid?: string;
    };
    return {
      state: j.state ?? "OPEN",
      mergeable: j.mergeable ?? "UNKNOWN",
      reviewDecision: j.reviewDecision ?? "",
      checks: deriveChecks(j.statusCheckRollup ?? []),
      headSha: j.headRefOid ?? "",
    };
  } catch {
    return { state: "OPEN", mergeable: "UNKNOWN", reviewDecision: "", checks: "none", headSha: "" };
  }
}

export async function fetchPrDiff(
  exec: Exec,
  owner: string,
  repo: string,
  number: number,
): Promise<string> {
  const { stdout } = await exec("gh", [
    "pr", "diff", String(number), "--repo", `${owner}/${repo}`,
  ]);
  return stdout;
}

export async function postPrReview(
  exec: Exec,
  owner: string,
  repo: string,
  number: number,
  payload: { body: string; event: ReviewEvent; comments: { path: string; line: number; side: string; body: string }[]; commit_id?: string },
  tmpDir: string,
): Promise<void> {
  mkdirSync(tmpDir, { recursive: true });
  const file = join(tmpDir, `review-${number}.json`);
  writeFileSync(file, JSON.stringify(payload));
  await exec("gh", ["api", `repos/${owner}/${repo}/pulls/${number}/reviews`, "--method", "POST", "--input", file]);
}
