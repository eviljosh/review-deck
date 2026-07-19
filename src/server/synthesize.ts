import type Database from "better-sqlite3";
import { z } from "zod";
import type { Exec } from "./exec.ts";
import type { LlmEngine } from "./engines/types.ts";
import type { PrRecord, Finding } from "../shared/types.ts";
import { getPr, updatePr, replaceFindings, listRejectedExamples } from "./db.ts";
import { getPinnedDiff } from "./diff.ts";
import { buildFinalizerPrompt } from "./prompts.ts";
import { parseAgentJson } from "./json.ts";
import { anchorableLines, isAnchorable } from "./diff-anchor.ts";
import { stageArtifactDir, writeArtifacts } from "./artifacts.ts";
import type { EngineModelOptions } from "./review-config.ts";

const finalSchema = z.object({
  verdict: z.string().optional(),
  files: z.array(z.object({ path: z.string(), role: z.string(), walkthrough: z.string().optional() })).optional(),
  themes: z.array(z.object({ label: z.string(), summary: z.string() })).optional(),
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
    theme: z.string().optional(),
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
  try {
    const diff = await getPinnedDiff(exec, dataDir, pr);
    const anchors = anchorableLines(diff);
    const { system, prompt } = buildFinalizerPrompt(raw, {
      goal: pr.goal ?? undefined,
      goalVerdict: pr.goal_verdict ?? undefined,
      ...(deps.feedbackEnabled ? { rejectedExamples: listRejectedExamples(db, pr.owner, pr.repo) } : {}),
    });
    const res = await finalizer.run(
      { system, prompt, workdir: pr.worktree_path ?? dataDir, ...modelOptions, maxTurns: 20, signal: deps.signal, timeoutMs: deps.timeoutMs },
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

    // Keep only theme labels that findings actually reference.
    const usedThemes = new Set(parsed.value.findings.map((f) => f.theme?.trim()).filter(Boolean) as string[]);
    const themes = (parsed.value.themes ?? []).filter((t) => usedThemes.has(t.label.trim()));

    const finalFindings = parsed.value.findings.map((f) => {
      const agreement = f.agreement || f.sources.length >= 2;
      return {
        dimension: f.dimension, severity: f.severity, file: f.file, line: f.line, side: f.side,
        what: f.what, why: f.why, suggestedFix: f.suggestedFix,
        theme: f.theme?.trim() ? f.theme.trim() : null,
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
      finding_themes: themes.length ? JSON.stringify(themes) : null,
      file_guide: parsed.value.files?.length ? JSON.stringify(parsed.value.files) : null,
    });
    onUpdate(done);
    return done;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onUpdate(updatePr(db, prId, { status: "failed", error: message }));
    throw err;
  }
}
