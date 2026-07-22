import { readFileSync, existsSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import pLimit from "p-limit";
import type Database from "better-sqlite3";
import type { Exec } from "./exec.ts";
import type { WsHub } from "./ws.ts";
import type { LlmEngine } from "./engines/types.ts";
import { engineModelOptions, loadReviewConfig, saveReviewConfig, type ReviewConfig } from "./review-config.ts";
import { runChatTurn } from "./chat.ts";
import { createPrBodySchema, type PrRecord, type ReviewEvent, type Stage } from "../shared/types.ts";
import { findPrByUrl, getPr, insertPr, listPrs, listFindings, listRuns, getSetting, setSetting, setFindingSelected, setAllFindingsSelected, updateFindingText, DEFAULT_PREFACE_KEY, updatePr, deletePr, setArchived, listArchivedOlderThan, markSeen, listRepoConfigs, getRepoConfig, upsertRepoConfig, insertComment, listComments, deleteComment, updateCommentBody, listChatMessages, clearChatMessages, replaceFindings } from "./db.ts";
import { getPinnedDiff } from "./diff.ts";
import { removeArtifacts } from "./artifacts.ts";
import { buildReviewMarkdown } from "../shared/review-markdown.ts";
import { fetchPrConversation, fetchPrStatus, postIssueComment, replyToReviewComment } from "./gh.ts";
import { parsePrUrl } from "./parse-url.ts";
import { runPipeline } from "./pipeline.ts";
import { runPost } from "./post-stage.ts";
import { firePipeline } from "./fire-pipeline.ts";
import { cachePath } from "./repos.ts";

export interface AppDeps {
  db: Database.Database;
  exec: Exec;
  claude: LlmEngine;
  codex: LlmEngine;
  config: ReviewConfig;
  dataDir: string;
  hub: WsHub;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { db, exec, claude, codex, config, dataDir, hub } = deps;
  const app = Fastify({ logger: false });
  const pipelineLimit = pLimit(config.maxConcurrentPipelines);

  // Live pipelines keyed by PR id, so /cancel can abort an in-flight (or queued) run.
  const running = new Map<number, AbortController>();
  function launch(prId: number, label: string, resumeFrom?: Stage): void {
    const controller = new AbortController();
    running.set(prId, controller);
    // Load settings fresh per launch so edits in the settings UI apply without
    // a restart (concurrency limits are boot-time — they live in the limiter).
    const liveConfig = loadReviewConfig(db);
    firePipeline(
      () =>
        pipelineLimit(() => runPipeline({ db, exec, claude, codex, config: liveConfig, dataDir, hub }, prId, controller.signal, resumeFrom)).finally(() => {
          // Only clear if this is still the current controller (a fast retry may
          // have replaced it).
          if (running.get(prId) === controller) running.delete(prId);
        }),
      label,
    );
  }

  // Drop a PR's throwaway worktree from disk (best-effort).
  async function removeWorktree(pr: PrRecord): Promise<void> {
    if (!pr.worktree_path) return;
    try {
      await exec("git", ["-C", cachePath(dataDir, pr.owner, pr.repo), "worktree", "remove", "--force", pr.worktree_path]);
    } catch {
      // worktree already gone / repo not cloned — fine
    }
  }

  // Fully remove a PR: stop any live run, drop its throwaway worktree and its
  // artifacts on disk, delete the row (findings/runs/comments/chat cascade),
  // and tell clients to drop it.
  async function removePr(pr: PrRecord): Promise<void> {
    running.get(pr.id)?.abort();
    await removeWorktree(pr);
    removeArtifacts(dataDir, pr.id);
    deletePr(db, pr.id);
    hub.broadcast({ type: "pr_deleted", prId: pr.id });
  }

  const ARCHIVE_PURGE_DAYS = 30;

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/prs", async () => listPrs(db));

  app.post("/api/prs", async (req, reply) => {
    const parsed = createPrBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const created: PrRecord[] = [];
    const existing: PrRecord[] = [];
    for (const url of parsed.data.urls) {
      const already = findPrByUrl(db, url);
      if (already) {
        existing.push(already);
        continue;
      }
      const { owner, repo, number } = parsePrUrl(url);
      const pr = insertPr(db, { url, owner, repo, number });
      created.push(pr);
      // Fire-and-forget; progress streams over WS.
      launch(pr.id, `pipeline failed for ${url}`);
    }
    return { created, existing };
  });

  app.post<{ Params: { id: string } }>("/api/prs/:id/retry", async (req, reply) => {
    const id = Number(req.params.id);
    const pr = Number.isInteger(id) ? getPr(db, id) : undefined;
    if (!pr) {
      return reply.code(404).send({ error: "pr not found" });
    }
    const claim = db.prepare("UPDATE prs SET status = 'running', error = NULL WHERE id = ? AND status <> 'running'").run(id);
    if (claim.changes === 0) return reply.code(409).send({ error: "already running" });
    // A PR that died mid-pipeline resumes at the stage it was in; completed
    // ones (ready, and posted — e.g. re-reviewing after the author pushed)
    // re-run from the top as a fresh review. Re-posting after a posted re-run
    // adds a second review on GitHub; the UI confirms before retrying those.
    const midPipeline: Stage[] = ["prepare", "triage", "deep_review", "synthesize"];
    const resumeFrom = midPipeline.includes(pr.stage) ? pr.stage : undefined;
    if (!resumeFrom) {
      // Fresh re-run: snapshot what the last posted review said (the finalizer
      // checks the new diff against it), then clear the old review outright so
      // stale findings/summaries never linger in the UI, survive a failed
      // re-run, or get merged into the next posted review.
      const postedFindings = listFindings(db, id).filter((f) => f.posted);
      const snapshot = postedFindings.length > 0
        ? JSON.stringify(postedFindings.map((f) => ({
            file: f.file, line: f.line, severity: f.severity, what: f.what, suggestedFix: f.suggestedFix,
          })))
        : pr.prior_findings; // nothing newly posted — keep the older snapshot, if any
      replaceFindings(db, id, []);
      updatePr(db, id, {
        prior_findings: snapshot ?? null,
        summary: null, headline: null, danger_level: null, danger_reasons: null,
        focus_areas: null, danger_flags: null, finding_themes: null,
        goal: null, goal_verdict: null, goal_explanation: null, goal_gaps: null,
        review_verdict: null, file_guide: null,
      });
      hub.broadcast({ type: "findings_updated", prId: id });
    }
    hub.broadcast({ type: "pr_log_reset", prId: id });
    hub.broadcast({ type: "pr_updated", pr: getPr(db, id)! });
    launch(id, `retry pipeline failed for ${id}`, resumeFrom);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/prs/:id/cancel", async (req, reply) => {
    const id = Number(req.params.id);
    const pr = Number.isInteger(id) ? getPr(db, id) : undefined;
    if (!pr) return reply.code(404).send({ error: "pr not found" });
    // Only running work is cancellable — don't clobber a done/ready/posted PR.
    if (pr.status !== "running") return reply.code(409).send({ error: "not running" });
    running.get(id)?.abort();
    // Mark cancelled even if no controller is registered (e.g. a stale 'running'
    // row) so the UI reflects it immediately; the pipeline, if live, will also
    // settle to cancelled as it unwinds.
    hub.broadcast({ type: "pr_updated", pr: updatePr(db, id, { status: "cancelled", error: "cancelled by user" }) });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/prs/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const pr = Number.isInteger(id) ? getPr(db, id) : undefined;
    if (!pr) return reply.code(404).send({ error: "pr not found" });
    await removePr(pr);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/prs/:id/seen", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !getPr(db, id)) return reply.code(404).send({ error: "pr not found" });
    hub.broadcast({ type: "pr_updated", pr: markSeen(db, id) });
    return { ok: true };
  });

  // Re-fetch state/mergeability/review-decision/CI without re-running the pipeline.
  app.post<{ Params: { id: string } }>("/api/prs/:id/refresh-status", async (req, reply) => {
    const id = Number(req.params.id);
    const pr = Number.isInteger(id) ? getPr(db, id) : undefined;
    if (!pr) return reply.code(404).send({ error: "pr not found" });
    const status = await fetchPrStatus(exec, pr.owner, pr.repo, pr.number);
    const updated = updatePr(db, id, {
      pr_state: status.state, mergeable: status.mergeable,
      review_decision: status.reviewDecision, checks: status.checks,
      ...(status.headSha ? { latest_sha: status.headSha } : {}),
    });
    hub.broadcast({ type: "pr_updated", pr: updated });
    return { ok: true, status };
  });

  app.post<{ Params: { id: string } }>("/api/prs/:id/archive", async (req, reply) => {
    const id = Number(req.params.id);
    const pr = Number.isInteger(id) ? getPr(db, id) : undefined;
    if (!pr) return reply.code(404).send({ error: "pr not found" });
    let archived = setArchived(db, id, true);
    // Reclaim disk: an archived review doesn't need its checkout anymore (a
    // later retry re-creates it). Skip while running — engines may be using it.
    if (pr.worktree_path && pr.status !== "running") {
      await removeWorktree(pr);
      archived = updatePr(db, id, { worktree_path: null });
    }
    hub.broadcast({ type: "pr_updated", pr: archived });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/prs/:id/unarchive", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !getPr(db, id)) return reply.code(404).send({ error: "pr not found" });
    hub.broadcast({ type: "pr_updated", pr: setArchived(db, id, false) });
    return { ok: true };
  });

  // Delete every archived PR whose archive is older than ARCHIVE_PURGE_DAYS.
  app.post("/api/prs/purge-archived", async () => {
    const stale = listArchivedOlderThan(db, ARCHIVE_PURGE_DAYS);
    for (const pr of stale) await removePr(pr);
    return { deleted: stale.length, olderThanDays: ARCHIVE_PURGE_DAYS };
  });

  app.post<{ Params: { id: string }; Body: { event?: string } | null }>("/api/prs/:id/post", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !getPr(db, id)) return reply.code(404).send({ error: "pr not found" });
    const event = (req.body?.event ?? "COMMENT") as ReviewEvent;
    if (!["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(event)) {
      return reply.code(400).send({ error: `invalid review event: ${event}` });
    }
    try {
      const cfg = loadReviewConfig(db);
      const pr = await runPost({ db, exec, dataDir, marker: cfg.robotMarker, feedbackEnabled: cfg.feedbackLoop, onUpdate: (p) => hub.broadcast({ type: "pr_updated", pr: p }) }, id, event);
      hub.broadcast({ type: "findings_updated", prId: id });
      return { ok: true, stage: pr.stage };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/prs/:id/findings", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !getPr(db, id)) return reply.code(404).send({ error: "pr not found" });
    return listFindings(db, id);
  });

  app.get<{ Params: { id: string } }>("/api/prs/:id/runs", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !getPr(db, id)) return reply.code(404).send({ error: "pr not found" });
    return listRuns(db, id);
  });

  // Persisted output of a single run (e.g. a failed deep-review engine task),
  // for debugging from the runs timeline.
  app.get<{ Params: { id: string; rid: string } }>("/api/prs/:id/runs/:rid/output", async (req, reply) => {
    const id = Number(req.params.id), rid = Number(req.params.rid);
    if (!Number.isInteger(id) || !getPr(db, id)) return reply.code(404).send({ error: "pr not found" });
    const run = listRuns(db, id).find((r) => r.id === rid);
    if (!run) return reply.code(404).send({ error: "run not found" });
    let output: string | null = null;
    if (run.artifact_path) {
      try {
        output = readFileSync(run.artifact_path, "utf8");
      } catch {
        // artifact purged/moved — fall through with error text only
      }
    }
    return { stage: run.stage, status: run.status, error: run.error, output };
  });

  // A file's full content at the reviewed commit (for expanding diff context in
  // the walkthrough). Served from the repo cache via the pinned SHA so it works
  // even after the worktree is reclaimed; falls back to the worktree checkout.
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/prs/:id/file", async (req, reply) => {
    const id = Number(req.params.id);
    const pr = Number.isInteger(id) ? getPr(db, id) : undefined;
    if (!pr) return reply.code(404).send({ error: "pr not found" });
    const path = String(req.query?.path ?? "");
    if (!path || path.startsWith("/") || path.split("/").includes("..")) {
      return reply.code(400).send({ error: "invalid path" });
    }
    if (pr.head_sha) {
      try {
        const { stdout } = await exec("git", ["-C", cachePath(dataDir, pr.owner, pr.repo), "show", `${pr.head_sha}:${path}`]);
        return { content: stdout };
      } catch {
        // cache missing / path not in that commit — try the worktree below
      }
    }
    if (pr.worktree_path && existsSync(`${pr.worktree_path}/${path}`)) {
      try {
        return { content: readFileSync(`${pr.worktree_path}/${path}`, "utf8") };
      } catch {
        // unreadable — fall through
      }
    }
    return reply.code(404).send({ error: "file not available at the reviewed commit" });
  });

  // The whole review as a self-contained markdown brief — pipe it straight
  // into a CLI agent session: curl -s localhost:3001/api/prs/12/review.md | claude
  app.get<{ Params: { id: string } }>("/api/prs/:id/review.md", async (req, reply) => {
    const id = Number(req.params.id);
    const pr = Number.isInteger(id) ? getPr(db, id) : undefined;
    if (!pr) return reply.code(404).send({ error: "pr not found" });
    reply.type("text/markdown; charset=utf-8");
    return buildReviewMarkdown(pr, listFindings(db, id), listComments(db, id));
  });

  // The pinned diff the review was computed against (falls back to live gh).
  app.get<{ Params: { id: string } }>("/api/prs/:id/diff", async (req, reply) => {
    const id = Number(req.params.id);
    const pr = Number.isInteger(id) ? getPr(db, id) : undefined;
    if (!pr) return reply.code(404).send({ error: "pr not found" });
    try {
      return { diff: await getPinnedDiff(exec, dataDir, pr) };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // The PR's existing GitHub conversation — inline review-comment threads plus
  // PR-level comments/review bodies — for display in the walkthrough.
  app.get<{ Params: { id: string } }>("/api/prs/:id/conversation", async (req, reply) => {
    const id = Number(req.params.id);
    const pr = Number.isInteger(id) ? getPr(db, id) : undefined;
    if (!pr) return reply.code(404).send({ error: "pr not found" });
    return fetchPrConversation(exec, pr.owner, pr.repo, pr.number);
  });

  // Reply into the conversation. Unlike review findings/comments (batched until
  // Post), these go to GitHub immediately: a threaded reply when inReplyTo is
  // given, otherwise a new PR-level comment.
  app.post<{ Params: { id: string }; Body: { body?: string; inReplyTo?: number } }>(
    "/api/prs/:id/conversation/reply",
    async (req, reply) => {
      const id = Number(req.params.id);
      const pr = Number.isInteger(id) ? getPr(db, id) : undefined;
      if (!pr) return reply.code(404).send({ error: "pr not found" });
      const body = (req.body?.body ?? "").trim();
      if (!body) return reply.code(400).send({ error: "reply body is required" });
      const inReplyTo = req.body?.inReplyTo;
      if (inReplyTo !== undefined && !Number.isInteger(inReplyTo)) {
        return reply.code(400).send({ error: "inReplyTo must be a comment id" });
      }
      try {
        if (inReplyTo !== undefined) await replyToReviewComment(exec, pr.owner, pr.repo, pr.number, inReplyTo, body);
        else await postIssueComment(exec, pr.owner, pr.repo, pr.number, body);
        return { ok: true };
      } catch (err) {
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // Reviewer comments: anchored to diff lines in the walkthrough, merged into
  // the posted review alongside the selected findings.
  app.get<{ Params: { id: string } }>("/api/prs/:id/comments", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !getPr(db, id)) return reply.code(404).send({ error: "pr not found" });
    return listComments(db, id);
  });
  app.post<{ Params: { id: string }; Body: { file: string; line: number | null; side?: "LEFT" | "RIGHT"; body: string } }>(
    "/api/prs/:id/comments", async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || !getPr(db, id)) return reply.code(404).send({ error: "pr not found" });
      const b = req.body ?? ({} as never);
      if (!b.file || typeof b.file !== "string") return reply.code(400).send({ error: "file required" });
      if (!b.body?.trim()) return reply.code(400).send({ error: "comment body required" });
      const line = b.line === null || b.line === undefined ? null : Number(b.line);
      return insertComment(db, id, { file: b.file, line: Number.isInteger(line as number) ? line : null, side: b.side === "LEFT" ? "LEFT" : "RIGHT", body: b.body.trim() });
    });
  app.patch<{ Params: { id: string; cid: string }; Body: { body?: string } }>(
    "/api/prs/:id/comments/:cid", async (req, reply) => {
      const id = Number(req.params.id), cid = Number(req.params.cid);
      if (!Number.isInteger(id) || !getPr(db, id)) return reply.code(404).send({ error: "pr not found" });
      const body = String(req.body?.body ?? "").trim();
      if (!body) return reply.code(400).send({ error: "comment body required" });
      try {
        return updateCommentBody(db, id, cid, body);
      } catch (err) {
        return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  app.delete<{ Params: { id: string; cid: string } }>("/api/prs/:id/comments/:cid", async (req, reply) => {
    const id = Number(req.params.id), cid = Number(req.params.cid);
    if (!Number.isInteger(id) || !getPr(db, id)) return reply.code(404).send({ error: "pr not found" });
    try {
      deleteComment(db, id, cid);
      return { ok: true };
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Per-PR chat: history, one streaming turn at a time, clear.
  const chatBusy = new Set<number>();
  app.get<{ Params: { id: string } }>("/api/prs/:id/chat", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !getPr(db, id)) return reply.code(404).send({ error: "pr not found" });
    return listChatMessages(db, id);
  });
  app.post<{ Params: { id: string }; Body: { message: string } }>("/api/prs/:id/chat", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !getPr(db, id)) return reply.code(404).send({ error: "pr not found" });
    const message = String(req.body?.message ?? "").trim();
    if (!message) return reply.code(400).send({ error: "message required" });
    if (chatBusy.has(id)) return reply.code(409).send({ error: "chat is already answering" });
    chatBusy.add(id);
    const cfg = loadReviewConfig(db);
    // Fire-and-forget; the answer streams over the WebSocket.
    void runChatTurn(
      { db, engine: claude, dataDir, hub, modelOptions: engineModelOptions(cfg, claude.name), timeoutMs: cfg.engineTimeoutMs },
      id, message,
    ).catch((err) => console.error(`chat turn failed for pr ${id}`, err))
      .finally(() => chatBusy.delete(id));
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>("/api/prs/:id/chat", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !getPr(db, id)) return reply.code(404).send({ error: "pr not found" });
    clearChatMessages(db, id);
    return { ok: true };
  });

  // Global review settings (engines, models, marker, dimensions, risk flags).
  app.get("/api/settings", async () => loadReviewConfig(db));
  app.put<{ Body: Partial<ReviewConfig> }>("/api/settings", async (req) => {
    const patch = (req.body ?? {}) as Partial<ReviewConfig>;
    return saveReviewConfig(db, patch);
  });

  // Per-repo review configuration (guidance + optional dimension/flag overrides).
  app.get("/api/repos", async () => listRepoConfigs(db));
  app.put<{ Params: { owner: string; repo: string }; Body: { guidance?: string; dimensions?: string | null; riskFlags?: string | null } }>(
    "/api/repos/:owner/:repo", async (req) => {
      const { owner, repo } = req.params;
      const b = req.body ?? {};
      return upsertRepoConfig(db, owner, repo, {
        ...(b.guidance !== undefined ? { guidance: String(b.guidance) } : {}),
        ...(b.dimensions !== undefined ? { dimensions: b.dimensions === null || b.dimensions === "" ? null : String(b.dimensions) } : {}),
        ...(b.riskFlags !== undefined ? { risk_flags: b.riskFlags === null || b.riskFlags === "" ? null : String(b.riskFlags) } : {}),
      });
    });
  app.get<{ Params: { owner: string; repo: string } }>("/api/repos/:owner/:repo", async (req, reply) => {
    const row = getRepoConfig(db, req.params.owner, req.params.repo);
    if (!row) return reply.code(404).send({ error: "repo not found" });
    return row;
  });

  app.get("/api/preface", async () => ({ default: getSetting(db, DEFAULT_PREFACE_KEY) ?? "" }));
  app.put<{ Body: { preface: string } }>("/api/preface", async (req) => {
    setSetting(db, DEFAULT_PREFACE_KEY, String(req.body?.preface ?? ""));
    return { ok: true };
  });
  app.put<{ Params: { id: string }; Body: { preface: string } }>("/api/prs/:id/preface", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !getPr(db, id)) return reply.code(404).send({ error: "pr not found" });
    updatePr(db, id, { preface: String(req.body?.preface ?? "") });
    return { ok: true };
  });
  app.post<{ Params: { id: string; fid: string }; Body: { selected: boolean } }>(
    "/api/prs/:id/findings/:fid/select", async (req, reply) => {
      const id = Number(req.params.id), fid = Number(req.params.fid);
      if (!Number.isInteger(id) || !getPr(db, id)) return reply.code(404).send({ error: "pr not found" });
      if (!listFindings(db, id).some((f) => f.id === fid)) return reply.code(404).send({ error: "finding not found" });
      setFindingSelected(db, fid, !!req.body?.selected);
      return { ok: true };
    });
  // Edit a finding's text (and your note) before posting.
  app.patch<{ Params: { id: string; fid: string }; Body: { what?: string; why?: string; suggestedFix?: string; reviewerNote?: string | null } }>(
    "/api/prs/:id/findings/:fid", async (req, reply) => {
      const id = Number(req.params.id), fid = Number(req.params.fid);
      if (!Number.isInteger(id) || !getPr(db, id)) return reply.code(404).send({ error: "pr not found" });
      const finding = listFindings(db, id).find((f) => f.id === fid);
      if (!finding) return reply.code(404).send({ error: "finding not found" });
      if (finding.posted) return reply.code(409).send({ error: "finding already posted" });
      const b = req.body ?? {};
      try {
        return updateFindingText(db, fid, {
          ...(b.what !== undefined ? { what: String(b.what) } : {}),
          ...(b.why !== undefined ? { why: String(b.why) } : {}),
          ...(b.suggestedFix !== undefined ? { suggestedFix: String(b.suggestedFix) } : {}),
          ...(b.reviewerNote !== undefined ? { reviewerNote: b.reviewerNote === null ? null : String(b.reviewerNote) } : {}),
        });
      } catch (err) {
        return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  app.post<{ Params: { id: string }; Body: { selected: boolean } }>(
    "/api/prs/:id/findings/select-all", async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || !getPr(db, id)) return reply.code(404).send({ error: "pr not found" });
      setAllFindingsSelected(db, id, !!req.body?.selected);
      return { ok: true };
    });

  return app;
}
