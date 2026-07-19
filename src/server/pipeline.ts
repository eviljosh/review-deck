import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import type { Exec } from "./exec.ts";
import type { LlmEngine } from "./engines/types.ts";
import type { WsHub } from "./ws.ts";
import type { Finding, PrRecord, Stage } from "../shared/types.ts";
import { findingsArraySchema } from "../shared/types.ts";
import { engineModelOptions, type ReviewConfig } from "./review-config.ts";
import { runPrepare } from "./prepare.ts";
import { runTriage } from "./triage.ts";
import { runDeepReview } from "./deep-review.ts";
import { runSynthesize } from "./synthesize.ts";
import { startRun, finishRun, updatePr, getPr } from "./db.ts";
import { readArtifact } from "./artifacts.ts";

export interface PipelineDeps {
  db: Database.Database;
  exec: Exec;
  claude: LlmEngine;
  codex: LlmEngine;
  config: ReviewConfig;
  dataDir: string;
  hub: WsHub;
}

async function recordStage<T>(
  db: Database.Database,
  prId: number,
  stage: string,
  aborted: () => boolean,
  fn: () => Promise<T>,
  onLog?: (prId: number, stage: string, chunk: string) => void,
): Promise<T> {
  const rid = startRun(db, prId, stage);
  const t0 = Date.now();
  console.log(`[pr ${prId}] ${stage} — started`);
  // Mirror stage transitions into the live log so the UI always shows
  // progress, even before an engine emits its first token.
  onLog?.(prId, stage, `[pipeline] ${stage} — started\n`);
  try {
    const r = await fn();
    finishRun(db, rid, "done");
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[pr ${prId}] ${stage} — done (${secs}s)`);
    onLog?.(prId, stage, `[pipeline] ${stage} — done (${secs}s)\n`);
    return r;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = aborted() ? "cancelled" : "failed";
    finishRun(db, rid, status, message);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`[pr ${prId}] ${stage} — ${status} (${secs}s): ${message}`);
    onLog?.(prId, stage, `[pipeline] ${stage} — ${status} (${secs}s): ${message}\n`);
    throw err;
  }
}

// Pipeline stages in execution order; used to compute where a resume starts.
const STAGE_ORDER: Stage[] = ["prepare", "triage", "deep_review", "synthesize"];

// Pooled raw deep-review findings persisted by a previous run, or null if the
// artifact is missing/invalid (in which case deep review must re-run).
function loadRawFindings(dataDir: string, prId: number): Finding[] | null {
  const text = readArtifact(dataDir, prId, "deep_review", "raw-findings.json");
  if (!text) return null;
  try {
    const parsed = findingsArraySchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function runPipeline(deps: PipelineDeps, prId: number, signal?: AbortSignal, resumeFrom?: Stage): Promise<void> {
  const { db, exec: baseExec, claude, codex, config, dataDir, hub } = deps;
  const onUpdate = (pr: PrRecord) => hub.broadcast({ type: "pr_updated", pr });
  const onLog = (id: number, stage: string, chunk: string) => hub.broadcast({ type: "pr_log", prId: id, stage, chunk });
  const aborted = () => signal?.aborted ?? false;

  // Where to start: a retry of a PR that failed/cancelled mid-pipeline resumes
  // at the stage it died in; everything else runs from the top. Skipped stages'
  // outputs (triage columns, raw-findings artifact) were persisted by the
  // earlier run.
  const resumeIdx = resumeFrom ? Math.max(0, STAGE_ORDER.indexOf(resumeFrom)) : 0;

  // Wrap exec so every git/gh child process is bound to the pipeline's signal and
  // gets killed on cancel; engines receive the signal directly via their requests.
  const exec: Exec = (cmd, args, opts) => baseExec(cmd, args, { ...opts, signal });

  // Cancel between stages (or if cancelled while queued): mark cancelled + stop.
  const checkpoint = (): boolean => {
    if (!aborted()) return false;
    console.log(`[pr ${prId}] cancelled`);
    onUpdate(updatePr(db, prId, { status: "cancelled", error: "cancelled by user" }));
    return true;
  };
  // When a stage throws because of a cancel, its own catch already set status;
  // normalize to the cancelled message and stop the pipeline.
  const onStageError = (stage: string, err: unknown): void => {
    if (aborted()) {
      onUpdate(updatePr(db, prId, { status: "cancelled", error: "cancelled by user" }));
      console.log(`[pr ${prId}] cancelled during ${stage}`);
    } else {
      console.error(`pipeline: ${stage} failed for pr ${prId}`, err);
    }
  };

  if (checkpoint()) return;
  // Re-run prepare on a plain run, and on any resume whose worktree has since
  // been removed (archived, purged) — later stages need the checkout on disk.
  const existing = getPr(db, prId);
  const needPrepare = resumeIdx <= 0 || !existing?.worktree_path || !existsSync(existing.worktree_path);
  if (needPrepare) {
    try {
      await recordStage(db, prId, "prepare", aborted, () => runPrepare({ db, exec, dataDir, onUpdate, onLog }, prId), onLog);
    } catch (err) { onStageError("prepare", err); return; }
  } else {
    onLog(prId, resumeFrom!, `[pipeline] resuming from ${resumeFrom} — reusing earlier prepare\n`);
  }

  if (checkpoint()) return;
  if (resumeIdx <= 1) {
    try {
      await recordStage(db, prId, "triage", aborted, () => runTriage({ db, exec, engine: claude, dataDir, onUpdate, onLog, modelOptions: engineModelOptions(config, claude.name), signal, timeoutMs: config.engineTimeoutMs, riskFlags: config.riskFlags }, prId), onLog);
    } catch (err) { onStageError("triage", err); return; }
  }

  if (checkpoint()) return;
  // Resuming at synthesize reuses the persisted raw findings when available;
  // otherwise (artifact missing/invalid) fall back to a live deep review.
  let raw = resumeIdx >= 3 ? loadRawFindings(dataDir, prId) : null;
  if (raw) {
    onLog(prId, "synthesize", `[pipeline] reusing ${raw.length} raw finding(s) from the previous deep review\n`);
  } else {
    try {
      raw = await recordStage(db, prId, "deep_review", aborted, () => runDeepReview({ db, exec, claude, codex, config, dataDir, onUpdate, onLog, signal }, prId), onLog);
    } catch (err) { onStageError("deep review", err); return; }
  }

  if (checkpoint()) return;
  const finalizer = config.finalizerEngine === "codex" ? codex : claude;
  try {
    await recordStage(db, prId, "synthesize", aborted, () => runSynthesize({ db, exec, finalizer, dataDir, onUpdate, onLog, modelOptions: engineModelOptions(config, finalizer.name), signal, timeoutMs: config.engineTimeoutMs, feedbackEnabled: config.feedbackLoop }, prId, raw), onLog);
    hub.broadcast({ type: "findings_updated", prId });
  } catch (err) { onStageError("synthesize", err); return; }
}
