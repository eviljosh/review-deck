import { test } from "node:test";
import assert from "node:assert/strict";
import type { Exec } from "../src/server/exec.ts";
import { fetchPrMeta, fetchPrDiff, postPrReview, fetchPrDiscussion, fetchPrStatus } from "../src/server/gh.ts";

test("fetchPrMeta calls gh pr view and maps json", async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    return {
      stdout: JSON.stringify({
        title: "Fix thing",
        author: { login: "octocat" },
        body: "Closes ENG-42",
        additions: 10,
        deletions: 2,
        changedFiles: 3,
      }),
      stderr: "",
    };
  };
  const meta = await fetchPrMeta(exec, "o", "r", 5);
  assert.deepEqual(meta, {
    title: "Fix thing",
    author: "octocat",
    body: "Closes ENG-42",
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    baseRef: "",
  });
  assert.equal(calls[0].cmd, "gh");
  assert.deepEqual(calls[0].args, [
    "pr", "view", "5", "--repo", "o/r",
    "--json", "title,author,body,additions,deletions,changedFiles,baseRefName",
  ]);
});

test("fetchPrDiff calls gh pr diff and returns raw diff text", async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: "diff --git a b\n", stderr: "" };
  };
  assert.equal(await fetchPrDiff(exec, "o", "r", 5), "diff --git a b\n");
  assert.equal(calls[0].cmd, "gh");
  assert.deepEqual(calls[0].args, ["pr", "diff", "5", "--repo", "o/r"]);
});

test("fetchPrMeta maps a null author to empty string", async () => {
  const exec: Exec = async () => ({
    stdout: JSON.stringify({
      title: "T", author: null, additions: 0, deletions: 0, changedFiles: 1,
    }),
    stderr: "",
  });
  const meta = await fetchPrMeta(exec, "o", "r", 5);
  assert.equal(meta.author, "");
});

test("fetchPrDiscussion flattens reviews, comments, and inline threads chronologically", async () => {
  const exec: Exec = async (cmd, args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          reviews: [
            { author: { login: "alice" }, body: "Please fix the migration", state: "CHANGES_REQUESTED", submittedAt: "2026-07-10T10:00:00Z" },
            { author: { login: "bob" }, body: "", state: "COMMENTED", submittedAt: "2026-07-10T09:00:00Z" }, // dropped (empty + COMMENTED)
          ],
          comments: [{ author: { login: "carol" }, body: "Do we need a rollback plan?", createdAt: "2026-07-10T11:00:00Z" }],
        }),
        stderr: "",
      };
    }
    // gh api inline comments
    return {
      stdout: JSON.stringify([
        { user: { login: "dave" }, body: "this line races", path: "src/x.ts", line: 44, created_at: "2026-07-10T08:00:00Z" },
      ]),
      stderr: "",
    };
  };
  const out = await fetchPrDiscussion(exec, "o", "r", 5);
  // chronological order: dave (08:00) → alice (10:00) → carol (11:00)
  const order = ["dave", "alice", "carol"].map((n) => out.indexOf(n));
  assert.ok(order[0] < order[1] && order[1] < order[2], out);
  assert.ok(out.includes("[CHANGES_REQUESTED]"));
  assert.ok(out.includes("src/x.ts:44"));
  assert.ok(!out.includes("bob")); // empty COMMENTED review dropped
});

test("fetchPrDiscussion drops the tool's own previously-posted reviews and comments", async () => {
  const exec: Exec = async (cmd, args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          reviews: [
            { author: { login: "bot" }, body: "Preface\n\n🤖 The rest of this review is Claude-generated — an automated review posted at Josh's request. It is not a human review.", state: "COMMENTED", submittedAt: "2026-07-10T10:00:00Z" },
            { author: { login: "alice" }, body: "real feedback", state: "APPROVED", submittedAt: "2026-07-10T11:00:00Z" },
          ],
          comments: [{ author: { login: "bot" }, body: "some finding\n\n<!-- review-deck:automated -->", createdAt: "2026-07-10T12:00:00Z" }],
        }),
        stderr: "",
      };
    }
    return {
      stdout: JSON.stringify([
        { user: { login: "bot" }, body: "**[serious]** `x.ts:1`\n\nw\n\n<!-- review-deck:automated -->", path: "x.ts", line: 1, created_at: "2026-07-10T13:00:00Z" },
      ]),
      stderr: "",
    };
  };
  const out = await fetchPrDiscussion(exec, "o", "r", 5);
  assert.ok(out.includes("alice"));
  assert.ok(!out.includes("Claude-generated"), out);
  assert.ok(!out.includes("review-deck:automated"), out);
});

test("fetchPrDiscussion returns empty string when there is no activity", async () => {
  const exec: Exec = async (cmd, args) =>
    args[0] === "pr" ? { stdout: JSON.stringify({ reviews: [], comments: [] }), stderr: "" } : { stdout: "[]", stderr: "" };
  assert.equal(await fetchPrDiscussion(exec, "o", "r", 5), "");
});

test("fetchPrDiscussion tolerates gh errors (returns empty)", async () => {
  const exec: Exec = async () => { throw new Error("gh boom"); };
  assert.equal(await fetchPrDiscussion(exec, "o", "r", 5), "");
});

function statusExec(rollup: unknown[], extra: Record<string, unknown> = {}): Exec {
  return async () => ({
    stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: rollup, ...extra }),
    stderr: "",
  });
}

test("fetchPrStatus rolls CI up to failing when any check fails", async () => {
  const s = await fetchPrStatus(statusExec([
    { status: "COMPLETED", conclusion: "SUCCESS" },
    { status: "COMPLETED", conclusion: "FAILURE" },
  ]), "o", "r", 5);
  assert.equal(s.checks, "failing");
});

test("fetchPrStatus is pending when a check is still running", async () => {
  const s = await fetchPrStatus(statusExec([
    { status: "COMPLETED", conclusion: "SUCCESS" },
    { status: "IN_PROGRESS" },
  ]), "o", "r", 5);
  assert.equal(s.checks, "pending");
});

test("fetchPrStatus passes when all checks succeed, none when empty", async () => {
  assert.equal((await fetchPrStatus(statusExec([{ status: "COMPLETED", conclusion: "SUCCESS" }]), "o", "r", 5)).checks, "passing");
  assert.equal((await fetchPrStatus(statusExec([]), "o", "r", 5)).checks, "none");
});

test("fetchPrStatus handles StatusContext state + maps fields", async () => {
  const s = await fetchPrStatus(statusExec([{ state: "FAILURE" }], { mergeable: "CONFLICTING", reviewDecision: "APPROVED" }), "o", "r", 5);
  assert.equal(s.checks, "failing");
  assert.equal(s.mergeable, "CONFLICTING");
  assert.equal(s.reviewDecision, "APPROVED");
});

test("fetchPrStatus degrades gracefully on gh error", async () => {
  const s = await fetchPrStatus(async () => { throw new Error("boom"); }, "o", "r", 5);
  assert.deepEqual(s, { state: "OPEN", mergeable: "UNKNOWN", reviewDecision: "", checks: "none", headSha: "" });
});

test("fetchPrStatus surfaces the remote head oid", async () => {
  const s = await fetchPrStatus(statusExec([], { headRefOid: "abc123" }), "o", "r", 5);
  assert.equal(s.headSha, "abc123");
});

test("postPrReview calls gh reviews API with --input and event COMMENT", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: "{}", stderr: "" }; };
  const tmp = `${process.env.SCRATCH ?? "/tmp"}/rd-post-${Date.now()}`;
  await import("node:fs").then((fs) => fs.mkdirSync(tmp, { recursive: true }));
  await postPrReview(exec, "o", "r", 5, { body: "b", event: "COMMENT", comments: [] }, tmp);
  const c = calls[0];
  assert.equal(c[0], "gh");
  assert.ok(c.includes("repos/o/r/pulls/5/reviews"));
  assert.ok(c.includes("--input"));
  const file = c[c.indexOf("--input") + 1];
  const written = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8")));
  assert.equal(written.event, "COMMENT");
});

// ---------- fetchPrConversation ----------

import { fetchPrConversation, replyToReviewComment, postIssueComment } from "../src/server/gh.ts";
import { BOT_SENTINEL } from "../src/server/post-review.ts";

function convoExec(inline: unknown[], view: unknown): Exec {
  return async (cmd, args) => {
    if (args.includes("--paginate")) return { stdout: JSON.stringify(inline), stderr: "" };
    return { stdout: JSON.stringify(view), stderr: "" };
  };
}

test("fetchPrConversation groups inline replies into one thread at the root's anchor", async () => {
  const exec = convoExec(
    [
      { id: 1, user: { login: "alice" }, body: "root question", path: "a.ts", line: 12, side: "RIGHT", created_at: "2026-01-01" },
      { id: 2, user: { login: "bob" }, body: "reply", path: "a.ts", line: 12, side: "RIGHT", in_reply_to_id: 1, created_at: "2026-01-02" },
    ],
    { reviews: [], comments: [] },
  );
  const c = await fetchPrConversation(exec, "o", "r", 5);
  assert.equal(c.threads.length, 1);
  assert.equal(c.threads[0].rootId, 1);
  assert.equal(c.threads[0].path, "a.ts");
  assert.equal(c.threads[0].line, 12);
  assert.deepEqual(c.threads[0].comments.map((x) => x.author), ["alice", "bob"]);
});

test("fetchPrConversation drops threads that are only this tool's own comments, keeps ones with human replies", async () => {
  const exec = convoExec(
    [
      { id: 1, user: { login: "app" }, body: `bot finding ${BOT_SENTINEL}`, path: "a.ts", line: 3, side: "RIGHT", created_at: "2026-01-01" },
      { id: 2, user: { login: "app" }, body: `other bot finding ${BOT_SENTINEL}`, path: "b.ts", line: 8, side: "RIGHT", created_at: "2026-01-01" },
      { id: 3, user: { login: "author" }, body: "actually this is intended", path: "b.ts", line: 8, side: "RIGHT", in_reply_to_id: 2, created_at: "2026-01-02" },
    ],
    { reviews: [], comments: [] },
  );
  const c = await fetchPrConversation(exec, "o", "r", 5);
  assert.equal(c.threads.length, 1);
  assert.equal(c.threads[0].rootId, 2);
  assert.equal(c.threads[0].comments[0].bot, true);
  assert.equal(c.threads[0].comments[1].bot, false);
});

test("fetchPrConversation marks outdated comments with null line and keeps original_line", async () => {
  const exec = convoExec(
    [{ id: 1, user: { login: "alice" }, body: "old note", path: "a.ts", line: null, original_line: 40, side: "LEFT", created_at: "2026-01-01" }],
    { reviews: [], comments: [] },
  );
  const c = await fetchPrConversation(exec, "o", "r", 5);
  assert.equal(c.threads[0].line, null);
  assert.equal(c.threads[0].originalLine, 40);
  assert.equal(c.threads[0].side, "LEFT");
});

test("fetchPrConversation collects review decisions and issue comments, filtering bot reviews", async () => {
  const exec = convoExec(
    [],
    {
      reviews: [
        { id: 10, author: { login: "carol" }, body: "ship it", state: "APPROVED", submittedAt: "2026-01-02" },
        { id: 11, author: { login: "app" }, body: `posted review ${BOT_SENTINEL}`, state: "COMMENTED", submittedAt: "2026-01-03" },
        { id: 12, author: { login: "dan" }, body: "", state: "COMMENTED", submittedAt: "2026-01-04" },
      ],
      comments: [{ id: 20, author: { login: "erin" }, body: "when does this land?", createdAt: "2026-01-01" }],
    },
  );
  const c = await fetchPrConversation(exec, "o", "r", 5);
  assert.deepEqual(c.overall.map((x) => x.author), ["erin", "carol"]); // chronological
  assert.equal(c.overall[1].state, "APPROVED");
});

test("fetchPrConversation degrades to an empty conversation on gh errors", async () => {
  const c = await fetchPrConversation(async () => { throw new Error("boom"); }, "o", "r", 5);
  assert.deepEqual(c, { threads: [], overall: [] });
});

test("replyToReviewComment and postIssueComment hit the right endpoints", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: "{}", stderr: "" }; };
  await replyToReviewComment(exec, "o", "r", 5, 42, "sounds good");
  await postIssueComment(exec, "o", "r", 5, "overall note");
  assert.ok(calls[0].includes("repos/o/r/pulls/5/comments/42/replies"));
  assert.ok(calls[0].includes("body=sounds good"));
  assert.ok(calls[1].includes("repos/o/r/issues/5/comments"));
  assert.ok(calls[1].includes("body=overall note"));
});
