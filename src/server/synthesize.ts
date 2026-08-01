import { rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { Exec } from "./exec.ts";
import type { LlmEngine, ThinkingConfig, EffortLevel } from "./engines/types.ts";
import type { PrRecord, Finding, ReadingPlan } from "../shared/types.ts";
import { getPr, updatePr, replaceFindings, listRejectedExamples } from "./db.ts";
import { getPinnedDiff } from "./diff.ts";
import { buildFinalizerPrompt, type PriorFinding } from "./prompts.ts";
import { parseAgentJson } from "./json.ts";
import { anchorableLines, isAnchorable } from "./diff-anchor.ts";
import { stageArtifactDir, writeArtifacts } from "./artifacts.ts";
import type { EngineModelOptions } from "./review-config.ts";

const finalSchema = z.object({
  verdict: z.string().optional(),
  findings: z.array(z.object({
    dimension: z.string(),
    severity: z.enum(["blocking", "serious", "moderate", "optional"]),
    impact: z.enum(["high", "medium", "low"]).optional(),
    file: z.string(),
    line: z.number().int().nullable(),
    side: z.enum(["LEFT", "RIGHT"]),
    what: z.string(),
    why: z.string(),
    suggestedFix: z.string(),
    sources: z.array(z.string()),
    agreement: z.boolean(),
  })),
});

export interface SynthesizeDeps {
  db: Database.Database;
  exec: Exec;
  finalizer: LlmEngine;
  dataDir: string;
  onUpdate: (pr: PrRecord) => void;
  onLog?: (prId: number, stage: string, chunk: string) => void;
  modelOptions?: EngineModelOptions;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Opt-in: inject past rejected findings for this repo into the finalizer. */
  feedbackEnabled?: boolean;
  // Extended thinking for the finalizer run (Claude only; see ReviewConfig.finalizerEffort).
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
}

// The plan stage's per-file classes, as compact context for impact scoring.
function parsePlanFiles(json: string | null): { path: string; class: string }[] | undefined {
  if (!json) return undefined;
  try {
    const plan = JSON.parse(json) as ReadingPlan;
    const files = plan?.cohorts?.flatMap((c) => c.files.map((f) => ({ path: f.path, class: f.class })));
    return files?.length ? files : undefined;
  } catch {
    return undefined;
  }
}

// Snapshot of the previous posted review (taken at re-run time); best-effort parse.
function parsePriorFindings(json: string | null): PriorFinding[] | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as PriorFinding[]) : undefined;
  } catch {
    return undefined;
  }
}

export async function runSynthesize(deps: SynthesizeDeps, prId: number, raw: Finding[]): Promise<PrRecord> {
  const { db, exec, finalizer, dataDir, onUpdate, onLog } = deps;
  const modelOptions = deps.modelOptions ?? { model: finalizer.name === "claude" ? "opus" : undefined };
  const pr = getPr(db, prId);
  if (!pr) throw new Error(`pr ${prId} not found`);
  onUpdate(updatePr(db, prId, { stage: "synthesize", status: "running", error: null }));

  // Findings the reviewer almost certainly wants posted start pre-selected;
  // the gate stays opt-out for those and opt-in for the rest.
  const preselect = (severity: string, agreement: boolean) =>
    severity === "blocking" || severity === "serious" || agreement;

  if (raw.length === 0) {
    replaceFindings(db, prId, []);
    const done = updatePr(db, prId, { stage: "ready", status: "done" });
    onUpdate(done);
    return done;
  }

  const dir = stageArtifactDir(dataDir, prId, "synthesize");
  // Pre-plan-stage runs wrote plan-coverage.txt here; a stale one reads as a
  // phantom gap to diagnostics (the live file now lives under plan/), so old
  // rows self-clean on their next re-run.
  rmSync(join(dir, "plan-coverage.txt"), { force: true });
  try {
    const diff = await getPinnedDiff(exec, dataDir, pr);
    const anchors = anchorableLines(diff);
    const { system, prompt } = buildFinalizerPrompt(raw, {
      goal: pr.goal ?? undefined,
      goalVerdict: pr.goal_verdict ?? undefined,
      ...(deps.feedbackEnabled ? { rejectedExamples: listRejectedExamples(db, pr.owner, pr.repo) } : {}),
      priorFindings: parsePriorFindings(pr.prior_findings),
      planFiles: parsePlanFiles(pr.reading_plan),
    });
    const res = await finalizer.run(
      {
        system, prompt, workdir: pr.worktree_path ?? dataDir, ...modelOptions,
        ...(deps.thinking ? { thinking: deps.thinking } : {}),
        ...(deps.effort ? { effort: deps.effort } : {}),
        maxTurns: 20, signal: deps.signal, timeoutMs: deps.timeoutMs,
      },
      (c) => onLog?.(prId, "synthesize", c),
    );
    writeArtifacts(dir, { "raw-findings.json": JSON.stringify(raw, null, 2), "finalizer-raw.txt": res.text });

    const parsed = parseAgentJson(res.text, finalSchema);
    if (!parsed.ok) {
      // Degrade: keep the raw pooled findings so nothing is lost.
      replaceFindings(db, prId, raw.map((f) => ({ ...f, engine: "multi", agreement: false, selected: preselect(f.severity, false) })));
      const degraded = updatePr(db, prId, {
        stage: "ready", status: "degraded",
        error: `finalizer JSON parse failed: ${parsed.error}`,
      });
      onUpdate(degraded);
      return degraded;
    }

    const finalFindings = parsed.value.findings.map((f) => {
      const agreement = f.agreement || f.sources.length >= 2;
      return {
        dimension: f.dimension, severity: f.severity, file: f.file, line: f.line, side: f.side,
        what: f.what, why: f.why, suggestedFix: f.suggestedFix,
        theme: null,
        impact: f.impact ?? null,
        engine: f.sources.length ? f.sources.join("+") : "final",
        agreement,
        anchorable: isAnchorable(anchors, f.file, f.line, f.side),
        // When the finalizer scored impact, that goal-aware judgment drives the
        // default selection; otherwise fall back to the severity/agreement rule.
        selected: f.impact ? f.impact === "high" || f.severity === "blocking" : preselect(f.severity, agreement),
      };
    });
    writeArtifacts(dir, { "findings.json": JSON.stringify(finalFindings, null, 2) });
    replaceFindings(db, prId, finalFindings);
    const done = updatePr(db, prId, {
      stage: "ready", status: "done",
      review_verdict: parsed.value.verdict?.trim() ? parsed.value.verdict : null,
    });
    onUpdate(done);
    return done;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onUpdate(updatePr(db, prId, { status: "failed", error: message }));
    throw err;
  }
}
