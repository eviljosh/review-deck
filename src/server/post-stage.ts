import type Database from "better-sqlite3";
import type { Exec } from "./exec.ts";
import type { PrRecord } from "../shared/types.ts";
import { getPr, updatePr, listFindings, listComments, markCommentsPosted, recordFindingFeedback, getSetting, DEFAULT_PREFACE_KEY } from "./db.ts";
import { postPrReview } from "./gh.ts";
import { buildReviewPayload } from "./post-review.ts";
import { stageArtifactDir } from "./artifacts.ts";

export interface PostDeps {
  db: Database.Database;
  exec: Exec;
  dataDir: string;
  onUpdate: (pr: PrRecord) => void;
  /** Disclosure line for the posted review; defaults to the built-in marker. */
  marker?: string;
  /** Opt-in: record accepted/rejected finding decisions for the feedback loop. */
  feedbackEnabled?: boolean;
}

export async function runPost(deps: PostDeps, prId: number): Promise<PrRecord> {
  const { db, exec, dataDir, onUpdate } = deps;
  const pr = getPr(db, prId);
  if (!pr) throw new Error(`pr ${prId} not found`);
  if (pr.stage === "posted") return pr; // already posted — idempotent fast path
  // Atomic claim: exactly one concurrent caller may proceed to post. better-sqlite3
  // is synchronous, so this conditional UPDATE is the serialization point — a second
  // concurrent runPost sees status='running' and bails without posting.
  const claim = db
    .prepare("UPDATE prs SET status = 'running', error = NULL WHERE id = ? AND stage = 'ready' AND status <> 'running'")
    .run(prId);
  if (claim.changes === 0) return getPr(db, prId)!; // another caller is posting, or not in a postable state
  onUpdate(getPr(db, prId)!);
  try {
    const preface = pr.preface ?? getSetting(db, DEFAULT_PREFACE_KEY) ?? "";
    const findings = listFindings(db, prId);
    const userComments = listComments(db, prId).filter((c) => !c.posted);
    if (!findings.some((f) => f.selected) && userComments.length === 0 && !preface.trim()) {
      throw new Error("nothing to post — select a finding, add a comment, or write a preface");
    }
    const { body, comments } = buildReviewPayload(preface, findings, deps.marker, userComments);
    // Anchor the review to the commit the findings were computed against, so
    // inline comments land on the right lines even if the author has pushed.
    await postPrReview(
      exec, pr.owner, pr.repo, pr.number,
      { body, event: "COMMENT", comments, ...(pr.head_sha ? { commit_id: pr.head_sha } : {}) },
      stageArtifactDir(dataDir, prId, "post"),
    );
    // Atomically mark posted + advance stage, immediately after the POST, so a
    // failure here can't leave stage un-flipped and let a retry double-post.
    const done = db.transaction(() => {
      // Post-time selections are the ground truth for the feedback loop:
      // selected → accepted, unselected → rejected (fed back to the finalizer).
      // Only recorded when the opt-in setting is on.
      if (deps.feedbackEnabled) recordFindingFeedback(db, prId);
      db.prepare("UPDATE findings SET posted = 1 WHERE pr_id = ? AND selected = 1").run(prId);
      markCommentsPosted(db, prId);
      return updatePr(db, prId, { stage: "posted", status: "done" });
    })();
    onUpdate(done);
    return done;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onUpdate(updatePr(db, prId, { status: "failed", error: message }));
    throw err;
  }
}
