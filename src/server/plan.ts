import type Database from "better-sqlite3";
import { z } from "zod";
import type { Exec } from "./exec.ts";
import type { LlmEngine } from "./engines/types.ts";
import type { PlanFile, PrRecord, ReadingPlan } from "../shared/types.ts";
import { getPr, getRepoConfig, updatePr } from "./db.ts";
import { getPinnedDiff, diffPaths, diffSections } from "./diff.ts";
import { buildPlanPrompt, buildPlanRetryPrompt } from "./prompts.ts";
import { parseAgentJson } from "./json.ts";
import { stageArtifactDir, writeArtifacts } from "./artifacts.ts";
import type { EngineModelOptions } from "./review-config.ts";

const planFileSchema = z.object({
  path: z.string(),
  // Tolerate a missing class (normalized to "substantive" — the safe default).
  class: z.enum(["crux", "substantive", "boilerplate", "mechanical"]).optional(),
  role: z.string(),
  walkthrough: z.string().optional(),
  ripple: z.string().optional(),
});

const planSchema = z.object({
  cohorts: z.array(z.object({ label: z.string(), why: z.string().optional(), files: z.array(planFileSchema) })),
});

const retrySchema = z.object({ files: z.array(planFileSchema) });

export interface PlanDeps {
  db: Database.Database;
  exec: Exec;
  engine: LlmEngine;
  dataDir: string;
  onUpdate: (pr: PrRecord) => void;
  onLog?: (prId: number, stage: string, chunk: string) => void;
  modelOptions?: EngineModelOptions;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function normalizeFile(f: z.infer<typeof planFileSchema>): PlanFile {
  return {
    path: f.path,
    class: f.class ?? "substantive",
    role: f.role,
    ...(f.walkthrough?.trim() ? { walkthrough: f.walkthrough } : {}),
    ...(f.ripple?.trim() ? { ripple: f.ripple } : {}),
  };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n…(truncated)" : s);

/**
 * The reading-plan stage. Runs beside deep review with its own agent — the
 * plan used to be folded into the finalizer, which starved it of both input
 * (it never saw the diff) and output budget (findings competed with the plan
 * in one response); coverage collapsed to 18% on a 57-file PR. Here the
 * changed-file list is an explicit input, and a deterministic completeness
 * pass re-asks for anything the first response missed.
 *
 * Non-fatal by design: the pipeline treats a plan failure as a degraded UI,
 * never a failed review. This stage does not touch pr.stage/status.
 */
export async function runPlan(deps: PlanDeps, prId: number): Promise<void> {
  const { db, exec, engine, dataDir, onUpdate, onLog } = deps;
  const modelOptions = deps.modelOptions ?? { model: "opus" };
  const pr = getPr(db, prId);
  if (!pr) throw new Error(`pr ${prId} not found`);

  const dir = stageArtifactDir(dataDir, prId, "plan");
  const diff = await getPinnedDiff(exec, dataDir, pr);
  const changed = diffPaths(diff);
  if (changed.length === 0) throw new Error("plan: no files in the pinned diff");

  const intent = pr.goal
    ? [pr.goal, pr.goal_verdict ? `Triage's verdict on whether the diff achieves it: ${pr.goal_verdict}` : ""].filter(Boolean).join("\n")
    : undefined;
  const guidance = getRepoConfig(db, pr.owner, pr.repo)?.guidance?.trim() || undefined;

  const { system, prompt } = buildPlanPrompt(
    { title: pr.title ?? "", additions: pr.additions ?? 0, deletions: pr.deletions ?? 0 },
    diff, changed, intent, guidance,
  );

  let log = "";
  const sink = (chunk: string) => {
    log += chunk;
    onLog?.(prId, "plan", chunk);
  };
  const res = await engine.run(
    { system, prompt, workdir: pr.worktree_path ?? dataDir, ...modelOptions, maxTurns: 30, signal: deps.signal, timeoutMs: deps.timeoutMs },
    sink,
  );
  writeArtifacts(dir, { "prompt.md": `# system\n\n${system}\n\n# prompt\n\n${prompt}`, "raw.txt": res.text });

  const parsed = parseAgentJson(res.text, planSchema);
  if (!parsed.ok) {
    writeArtifacts(dir, { "log.txt": log });
    throw new Error(`plan JSON parse failed: ${parsed.error}`);
  }

  let plan: ReadingPlan = {
    cohorts: parsed.value.cohorts
      .filter((c) => c.files.length > 0)
      .map((c) => ({ label: c.label, why: c.why ?? "", files: c.files.map(normalizeFile) })),
  };

  // Completeness pass: one retry asking to classify exactly the missed files,
  // each with its own diff section. Recovered files land in a labeled trailing
  // cohort so the plan stays honest about what came from the second pass.
  const plannedPaths = () => new Set(plan.cohorts.flatMap((c) => c.files.map((f) => f.path)));
  let missing = changed.filter((p) => !plannedPaths().has(p));
  if (missing.length > 0) {
    onLog?.(prId, "plan", `[plan] first pass missed ${missing.length} of ${changed.length} file(s) — running completeness pass\n`);
    const sections = diffSections(diff);
    const retry = buildPlanRetryPrompt(missing.map((p) => ({ path: p, diff: clip(sections.get(p) ?? "", 4000) })));
    try {
      const r2 = await engine.run(
        { system: retry.system, prompt: retry.prompt, workdir: pr.worktree_path ?? dataDir, ...modelOptions, maxTurns: 20, signal: deps.signal, timeoutMs: deps.timeoutMs },
        sink,
      );
      writeArtifacts(dir, { "retry-raw.txt": r2.text });
      const p2 = parseAgentJson(r2.text, retrySchema);
      if (p2.ok) {
        const missingSet = new Set(missing);
        const extras = p2.value.files.filter((f) => missingSet.has(f.path)).map(normalizeFile);
        if (extras.length > 0) {
          plan = { cohorts: [...plan.cohorts, { label: "Additional files", why: "Classified in a completeness pass — the first pass missed these.", files: extras }] };
        }
      } else {
        onLog?.(prId, "plan", `[plan] completeness pass parse failed — leaving gaps: ${p2.error}\n`);
      }
    } catch (err) {
      onLog?.(prId, "plan", `[plan] completeness pass failed — leaving gaps: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    missing = changed.filter((p) => !plannedPaths().has(p));
  }

  // Residual coverage telemetry: with the file list as explicit input and a
  // retry behind it, any remaining gap is a real reliability signal.
  const changedSet = new Set(changed);
  const invented = [...plannedPaths()].filter((p) => !changedSet.has(p));
  if (missing.length > 0 || invented.length > 0) {
    const parts = [`plan coverage gap after completeness pass (${plannedPaths().size} planned / ${changed.length} changed)`];
    if (missing.length) parts.push(`missing from plan: ${missing.join(", ")}`);
    if (invented.length) parts.push(`not in diff: ${invented.join(", ")}`);
    const report = parts.join(" — ");
    onLog?.(prId, "plan", `[plan] ⚠ ${report}\n`);
    writeArtifacts(dir, { "plan-coverage.txt": report });
  }

  // Flat guide kept in sync for old-row consumers (walkthrough fallback path).
  const flatGuide = plan.cohorts.flatMap((c) => c.files.map(({ path, role, walkthrough }) => ({ path, role, ...(walkthrough ? { walkthrough } : {}) })));
  writeArtifacts(dir, { "result.json": JSON.stringify(plan, null, 2), "log.txt": log });
  onUpdate(updatePr(db, prId, {
    reading_plan: JSON.stringify(plan),
    file_guide: flatGuide.length > 0 ? JSON.stringify(flatGuide) : null,
  }));
}
