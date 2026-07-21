import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./exec.ts";
import type { GhComment, GhConversation, GhInlineThread, GhOverallComment, ReviewEvent } from "../shared/types.ts";
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

// The PR's existing conversation as structured data (the text-transcript
// variant above feeds triage; this one feeds the walkthrough UI). Inline
// review comments are grouped into threads by their reply chain; issue
// comments and review submissions land in `overall`. Best-effort: any gh or
// parse error yields an empty conversation.
export async function fetchPrConversation(
  exec: Exec,
  owner: string,
  repo: string,
  number: number,
): Promise<GhConversation> {
  const threads: GhInlineThread[] = [];
  const overall: GhOverallComment[] = [];

  try {
    const { stdout } = await exec("gh", [
      "api", `repos/${owner}/${repo}/pulls/${number}/comments`, "--paginate",
    ]);
    const arr = JSON.parse(stdout) as {
      id: number; user?: { login?: string }; body?: string; path?: string;
      line?: number | null; original_line?: number | null; side?: string | null;
      in_reply_to_id?: number; created_at?: string;
    }[];
    if (Array.isArray(arr)) {
      const byId = new Map(arr.map((c) => [c.id, c]));
      const rootOf = (c: (typeof arr)[number]): number => {
        let cur = c;
        // Follow the reply chain to the thread root (GitHub normally points
        // replies straight at the root; the loop covers older nested data).
        for (let hops = 0; cur.in_reply_to_id && byId.has(cur.in_reply_to_id) && hops < 50; hops++) {
          cur = byId.get(cur.in_reply_to_id)!;
        }
        return cur.id;
      };
      const grouped = new Map<number, (typeof arr)[number][]>();
      for (const c of arr) {
        const root = rootOf(c);
        if (!grouped.has(root)) grouped.set(root, []);
        grouped.get(root)!.push(c);
      }
      for (const [rootId, cs] of grouped) {
        cs.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
        const root = byId.get(rootId) ?? cs[0];
        const comments: GhComment[] = cs
          .filter((c) => (c.body ?? "").trim())
          .map((c) => ({
            id: c.id,
            author: c.user?.login ?? "unknown",
            body: (c.body ?? "").trim(),
            createdAt: c.created_at ?? "",
            bot: isBotAuthored(c.body ?? ""),
          }));
        // A thread that is only this tool's own posted findings duplicates the
        // finding cards — skip it. Any human participation keeps the thread.
        if (comments.length === 0 || comments.every((c) => c.bot)) continue;
        threads.push({
          rootId,
          path: root.path ?? "",
          line: root.line ?? null,
          side: root.side === "LEFT" ? "LEFT" : "RIGHT",
          originalLine: root.original_line ?? root.line ?? null,
          comments,
        });
      }
    }
  } catch {
    // no inline comments available — fine
  }

  try {
    const { stdout } = await exec("gh", [
      "pr", "view", String(number), "--repo", `${owner}/${repo}`, "--json", "reviews,comments",
    ]);
    const j = JSON.parse(stdout) as {
      reviews?: { id?: number; author?: { login?: string }; body?: string; state?: string; submittedAt?: string }[];
      comments?: { id?: number; author?: { login?: string }; body?: string; createdAt?: string }[];
    };
    for (const r of j.reviews ?? []) {
      const body = (r.body ?? "").trim();
      // Same rule as the triage transcript: keep decisions and bodies, skip
      // empty COMMENTED shells and this tool's own posted reviews.
      if (!body && (!r.state || r.state === "COMMENTED")) continue;
      if (isBotAuthored(body)) continue;
      overall.push({
        id: r.id ?? 0,
        author: r.author?.login ?? "unknown",
        body,
        createdAt: r.submittedAt ?? "",
        bot: false,
        ...(r.state && r.state !== "COMMENTED" ? { state: r.state } : {}),
      });
    }
    for (const c of j.comments ?? []) {
      const body = (c.body ?? "").trim();
      if (!body || isBotAuthored(body)) continue;
      overall.push({ id: c.id ?? 0, author: c.author?.login ?? "unknown", body, createdAt: c.createdAt ?? "", bot: false });
    }
    overall.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    // no reviews/comments available — fine
  }

  return { threads, overall };
}

/** Immediate threaded reply to an inline review comment (not batched with a review). */
export async function replyToReviewComment(
  exec: Exec,
  owner: string,
  repo: string,
  number: number,
  commentId: number,
  body: string,
): Promise<void> {
  await exec("gh", [
    "api", `repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`,
    "--method", "POST", "-f", `body=${body}`,
  ]);
}

/** Immediate PR-level (issue) comment. */
export async function postIssueComment(
  exec: Exec,
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<void> {
  await exec("gh", [
    "api", `repos/${owner}/${repo}/issues/${number}/comments`,
    "--method", "POST", "-f", `body=${body}`,
  ]);
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
