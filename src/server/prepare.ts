import type Database from "better-sqlite3";
import type { Exec } from "./exec.ts";
import type { PrRecord } from "../shared/types.ts";
import { getPr, updatePr } from "./db.ts";
import { fetchPrMeta, fetchPrDiff, fetchPrStatus } from "./gh.ts";
import { cachePath, prepareWorktree } from "./repos.ts";
import { stageArtifactDir, writeArtifacts } from "./artifacts.ts";

export interface PrepareDeps {
  db: Database.Database;
  exec: Exec;
  dataDir: string;
  onUpdate: (pr: PrRecord) => void;
  onLog?: (prId: number, stage: string, chunk: string) => void;
}

export async function runPrepare(deps: PrepareDeps, prId: number): Promise<PrRecord> {
  const { db, exec, dataDir, onUpdate, onLog } = deps;
  const pr = getPr(db, prId);
  if (!pr) throw new Error(`pr ${prId} not found`);

  onUpdate(updatePr(db, prId, { stage: "prepare", status: "running", error: null }));
  // git streams progress with carriage returns ("Receiving objects: 5%\r6%\r…").
  // Buffer by line and, for each completed line, keep only the text after the
  // last \r — i.e. the final state of that progress phase — so the live log
  // shows a few "…100%, done." summaries instead of hundreds of percent ticks.
  let buf = "";
  const log = (chunk: string) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const collapsed = line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line;
      onLog?.(prId, "prepare", collapsed + "\n");
    }
  };

  try {
    log(`[prepare] ${pr.owner}/${pr.repo}#${pr.number} — fetching PR metadata…\n`);
    const meta = await fetchPrMeta(exec, pr.owner, pr.repo, pr.number);
    log(`[prepare] "${meta.title}" by ${meta.author} · +${meta.additions}/-${meta.deletions}, ${meta.changedFiles} file(s)\n`);
    const worktree = await prepareWorktree(exec, {
      dataDir,
      owner: pr.owner,
      repo: pr.repo,
      number: pr.number,
      prId,
      baseRef: meta.baseRef,
      onLog: log,
    });
    log(`[prepare] worktree ready at ${worktree.path}\n`);

    // Pin the diff to the exact commits just resolved so every later stage
    // (and the final post) reviews the same code even if the author pushes.
    // Best-effort: on any failure the stages fall back to a live `gh pr diff`.
    let diff = "";
    if (worktree.headSha && worktree.baseSha) {
      try {
        diff = (await exec("git", ["-C", cachePath(dataDir, pr.owner, pr.repo), "diff", `${worktree.baseSha}..${worktree.headSha}`])).stdout;
        log(`[prepare] pinned diff at ${worktree.headSha.slice(0, 8)} (base ${worktree.baseSha.slice(0, 8)})\n`);
      } catch {
        log(`[prepare] local diff failed — will fall back to gh pr diff\n`);
      }
    }
    if (!diff) {
      try {
        diff = await fetchPrDiff(exec, pr.owner, pr.repo, pr.number);
      } catch {
        // stages will fetch live
      }
    }
    if (diff) {
      try {
        writeArtifacts(stageArtifactDir(dataDir, prId, "prepare"), { "diff.patch": diff });
      } catch {
        log(`[prepare] could not persist pinned diff — stages will fetch live\n`);
      }
    }

    const status = await fetchPrStatus(exec, pr.owner, pr.repo, pr.number);
    const done = updatePr(db, prId, {
      title: meta.title,
      author: meta.author,
      additions: meta.additions,
      deletions: meta.deletions,
      changed_files: meta.changedFiles,
      pr_state: status.state,
      mergeable: status.mergeable,
      review_decision: status.reviewDecision,
      checks: status.checks,
      worktree_path: worktree.path,
      head_sha: worktree.headSha,
      base_sha: worktree.baseSha,
      latest_sha: status.headSha || worktree.headSha,
      stage: "triage",
      status: "pending",
    });
    onUpdate(done);
    return done;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onUpdate(updatePr(db, prId, { status: "failed", error: message }));
    throw err;
  }
}
