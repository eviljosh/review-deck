import type Database from "better-sqlite3";
import type { Exec } from "./exec.ts";
import type { PrRecord } from "../shared/types.ts";
import { getPr, updatePr } from "./db.ts";
import { fetchPrMeta, fetchPrDiff, fetchPrStatus } from "./gh.ts";
import { cachePath, prepareWorktree } from "./repos.ts";
import { stageArtifactDir, writeArtifacts } from "./artifacts.ts";
import { baseDriftFiles, diffPaths, diffStats, dropDiffFiles, pickPinnedBase, type BaseCandidate, type BaseMode } from "./diff.ts";

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
    let baseSha = worktree.baseSha;
    let baseMode: BaseMode | null = null;
    if (worktree.headSha && worktree.baseSha) {
      const cache = cachePath(dataDir, pr.owner, pr.repo);
      const head = worktree.headSha;
      const diffFrom = async (base: string): Promise<string> =>
        (await exec("git", ["-C", cache, "diff", `${base}..${head}`])).stdout;
      // File count only: the tip candidate usually loses (a base branch that
      // merely advanced makes the tip diff the *larger* of the two), and its
      // full text can run to tens of MB on a busy base — never materialize a
      // diff we would throw away unread.
      const filesTouchedFrom = async (base: string): Promise<number> =>
        (await exec("git", ["-C", cache, "diff", "--name-only", `${base}..${head}`])).stdout
          .split("\n").filter(Boolean).length;
      try {
        const mergeBaseDiff = await diffFrom(worktree.baseSha);
        const mergeBase: BaseCandidate = { sha: worktree.baseSha, files: diffPaths(mergeBaseDiff).length };
        // Measure the base branch's tip as well, so pickPinnedBase() can catch a
        // stacked PR whose base was rebased out from under it.
        let baseTip: BaseCandidate | null = null;
        if (worktree.baseTipSha && worktree.baseTipSha !== worktree.baseSha) {
          try {
            baseTip = { sha: worktree.baseTipSha, files: await filesTouchedFrom(worktree.baseTipSha) };
          } catch {
            // tip unreachable (shallow/pruned ref) — merge-base is all we have
          }
        }
        const picked = pickPinnedBase(mergeBase, baseTip);
        diff = picked.mode === "base-tip" ? await diffFrom(picked.sha) : mergeBaseDiff;
        baseSha = picked.sha;
        baseMode = picked.mode;
        if (baseTip) {
          log(`[prepare] base candidates: merge-base ${mergeBase.sha.slice(0, 8)} → ${mergeBase.files} file(s); `
            + `base tip ${baseTip.sha.slice(0, 8)} → ${baseTip.files} file(s)\n`);
        }
        if (picked.mode === "base-tip") {
          log("[prepare] using the base branch tip: its merge-base diff carries the base branch's own work, "
            + "which means the base was rebased after this branch forked\n");
          // Two-dot against the tip shows base commits the head never absorbed
          // as reversals. Strip the files that are only in the diff for that
          // reason, so nobody reviews the base branch's work played backwards.
          try {
            const baseOnly = (await exec("git", ["-C", cache, "log", "--format=", "--name-only", picked.sha, `^${head}`])).stdout;
            const prTouched = (await exec("git", ["-C", cache, "diff", "--name-only", mergeBase.sha, head])).stdout;
            const drift = baseDriftFiles(baseOnly, prTouched);
            if (drift.size > 0) {
              diff = dropDiffFiles(diff, drift);
              log(`[prepare] dropped ${drift.size} base-drift file(s) the PR never touched: ${[...drift].join(", ")}\n`);
            }
          } catch {
            // Best-effort: an unfiltered base-tip diff still beats the merge-base one.
            log("[prepare] could not compute base drift — keeping the unfiltered base-tip diff\n");
          }
        }
        log(`[prepare] pinned diff at ${head.slice(0, 8)} (${picked.mode} ${picked.sha.slice(0, 8)}) — `
          + `${diffPaths(diff).length} file(s)\n`);
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
      base_sha: baseSha,
      base_mode: baseMode,
      // What was actually reviewed. GitHub's counters describe a different
      // change whenever they go stale or we pick a different base, and the
      // review brief should quote the diff the review was done on.
      reviewed_size: diff ? JSON.stringify(diffStats(diff)) : null,
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
