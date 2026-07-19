import type Database from "better-sqlite3";
import type { Exec } from "./exec.ts";
import type { LlmEngine } from "./engines/types.ts";
import type { PrRecord } from "../shared/types.ts";
import { triageResultSchema } from "../shared/types.ts";
import { getPr, getRepoConfig, updatePr } from "./db.ts";
import { parseRiskFlags, DEFAULT_RISK_FLAGS, type RiskFlagDef } from "./review-config.ts";
import { fetchPrMeta, fetchPrDiscussion } from "./gh.ts";
import { getPinnedDiff } from "./diff.ts";
import { fetchLinearContext } from "./linear.ts";
import { buildTriagePrompt } from "./prompts.ts";
import { parseAgentJson } from "./json.ts";
import { stageArtifactDir, writeArtifacts } from "./artifacts.ts";
import type { EngineModelOptions } from "./review-config.ts";

export interface TriageDeps {
  db: Database.Database;
  exec: Exec;
  engine: LlmEngine;
  dataDir: string;
  onUpdate: (pr: PrRecord) => void;
  onLog?: (prId: number, stage: string, chunk: string) => void;
  modelOptions?: EngineModelOptions;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Global risk-flag defs; per-repo DB overrides still win. */
  riskFlags?: RiskFlagDef[];
}

export async function runTriage(deps: TriageDeps, prId: number): Promise<PrRecord> {
  const { db, exec, engine, dataDir, onUpdate, onLog } = deps;
  const modelOptions = deps.modelOptions ?? { model: "opus" };
  const pr = getPr(db, prId);
  if (!pr) throw new Error(`pr ${prId} not found`);

  onUpdate(updatePr(db, prId, { stage: "triage", status: "running", error: null }));

  const dir = stageArtifactDir(dataDir, prId, "triage");
  try {
    const meta = await fetchPrMeta(exec, pr.owner, pr.repo, pr.number);
    const diff = await getPinnedDiff(exec, dataDir, pr);
    // Best-effort: existing reviews/comments so the summary can flag ongoing
    // discussion the reviewer should read before approving.
    let discussion = "";
    try {
      discussion = await fetchPrDiscussion(exec, pr.owner, pr.repo, pr.number);
      if (discussion) onLog?.(prId, "triage", `[triage] found existing review activity (${discussion.length} chars)\n`);
    } catch {
      // non-critical — proceed without discussion context
    }
    // Best-effort: pull linked Linear ticket(s) from the PR body + comments so
    // the summary can explain the problem being solved and how. Needs LINEAR_API_KEY.
    let linear = "";
    try {
      linear = await fetchLinearContext(`${meta.body}\n\n${discussion}`, process.env.LINEAR_API_KEY);
      if (linear) onLog?.(prId, "triage", `[triage] pulled linked Linear ticket context\n`);
    } catch {
      // non-critical — proceed without Linear context
    }
    const repoCfg = getRepoConfig(db, pr.owner, pr.repo);
    const riskFlags = parseRiskFlags(repoCfg?.risk_flags) ?? deps.riskFlags ?? DEFAULT_RISK_FLAGS;
    const guidance = repoCfg?.guidance?.trim() || undefined;
    const { system, prompt } = buildTriagePrompt(meta, diff, discussion, linear, riskFlags, guidance);

    let log = "";
    const result = await engine.run(
      { system, prompt, workdir: pr.worktree_path ?? dataDir, ...modelOptions, maxTurns: 30, signal: deps.signal, timeoutMs: deps.timeoutMs },
      (chunk) => {
        log += chunk;
        onLog?.(prId, "triage", chunk);
      },
    );

    writeArtifacts(dir, {
      "prompt.md": `# system\n\n${system}\n\n# prompt\n\n${prompt}`,
      "raw.txt": result.text,
      "log.txt": log,
    });

    const parsed = parseAgentJson(result.text, triageResultSchema);
    if (!parsed.ok) {
      const degraded = updatePr(db, prId, {
        status: "degraded",
        error: `triage JSON parse failed: ${parsed.error}\n\n--- raw model output ---\n${result.text}`,
      });
      onUpdate(degraded);
      return degraded;
    }

    writeArtifacts(dir, { "result.json": JSON.stringify(parsed.value, null, 2) });
    const ga = parsed.value.goalAssessment;
    const done = updatePr(db, prId, {
      status: "done",
      error: null,
      headline: parsed.value.headline?.trim() ? parsed.value.headline : null,
      goal: parsed.value.goal?.trim() ? parsed.value.goal : null,
      goal_verdict: ga?.verdict ?? null,
      goal_explanation: ga?.explanation?.trim() ? ga.explanation : null,
      goal_gaps: ga?.gaps?.length ? JSON.stringify(ga.gaps) : null,
      summary: parsed.value.summary,
      danger_level: parsed.value.danger.level,
      danger_reasons: JSON.stringify(parsed.value.danger.reasons),
      danger_flags: JSON.stringify(parsed.value.danger.flags),
      focus_areas: JSON.stringify(parsed.value.focusAreas),
      discussion: parsed.value.discussion?.trim() ? parsed.value.discussion : null,
    });
    onUpdate(done);
    return done;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onUpdate(updatePr(db, prId, { status: "failed", error: message }));
    throw err;
  }
}
