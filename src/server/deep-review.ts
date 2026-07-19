import type Database from "better-sqlite3";
import pLimit from "p-limit";
import { z } from "zod";
import type { Exec } from "./exec.ts";
import type { LlmEngine, LogSink } from "./engines/types.ts";
import type { PrRecord, Finding } from "../shared/types.ts";
import { findingSchema } from "../shared/types.ts";
import { engineModelOptions, parseDimensions, type ReviewConfig } from "./review-config.ts";
import { getPr, getRepoConfig, updatePr, startRun, finishRun } from "./db.ts";
import { fetchPrMeta } from "./gh.ts";
import { getPinnedDiff } from "./diff.ts";
import { buildDimensionReviewPrompt, buildFullDiffReviewPrompt } from "./prompts.ts";
import { parseAgentJson } from "./json.ts";
import { stageArtifactDir, writeArtifacts } from "./artifacts.ts";

const rawFindingsSchema = z.object({
  findings: z.array(findingSchema.omit({ engine: true, anchorable: true })),
});

export interface DeepReviewDeps {
  db: Database.Database;
  exec: Exec;
  claude: LlmEngine;
  codex: LlmEngine;
  config: ReviewConfig;
  dataDir: string;
  onUpdate: (pr: PrRecord) => void;
  onLog?: (prId: number, stage: string, chunk: string) => void;
  signal?: AbortSignal;
}

interface ReviewTask {
  engine: LlmEngine;
  engineName: string;
  dimension: string;
  system: string;
  prompt: string;
}

export async function runDeepReview(deps: DeepReviewDeps, prId: number): Promise<Finding[]> {
  const { db, exec, claude, codex, config, dataDir, onUpdate, onLog } = deps;
  const pr = getPr(db, prId);
  if (!pr) throw new Error(`pr ${prId} not found`);
  onUpdate(updatePr(db, prId, { stage: "deep_review", status: "running", error: null }));

  try {
    const meta = await fetchPrMeta(exec, pr.owner, pr.repo, pr.number);
    const diff = await getPinnedDiff(exec, dataDir, pr);
    const workdir = pr.worktree_path ?? dataDir;
    const dir = stageArtifactDir(dataDir, prId, "deep_review");

    // Triage's distilled goal, so each reviewer can judge findings against what
    // the change is actually trying to do.
    const intent = pr.goal
      ? [pr.goal, pr.goal_verdict ? `Triage's verdict on whether the diff achieves it: ${pr.goal_verdict}` : ""].filter(Boolean).join("\n")
      : undefined;

    // Per-repo overrides: custom dimensions and freeform guidance from the DB.
    const repoCfg = getRepoConfig(db, pr.owner, pr.repo);
    const dimensions = parseDimensions(repoCfg?.dimensions) ?? config.dimensions;
    const guidance = repoCfg?.guidance?.trim() || undefined;

    const tasks: ReviewTask[] = [];
    if (config.engines.claude) {
      for (const dim of dimensions) {
        const { system, prompt } = buildDimensionReviewPrompt(dim, meta, diff, intent, guidance);
        tasks.push({ engine: claude, engineName: "claude", dimension: dim.key, system, prompt });
      }
    }
    if (config.engines.codex) {
      const { system, prompt } = buildFullDiffReviewPrompt(meta, diff, intent, guidance);
      tasks.push({ engine: codex, engineName: "codex", dimension: "full", system, prompt });
    }

    const log: LogSink = (chunk) => onLog?.(prId, "deep_review", chunk);
    const limit = pLimit(config.maxConcurrentReviews);
    const settled = await Promise.allSettled(
      tasks.map((t) => limit(async () => {
        // Record each engine/dimension task as its own run so the timeline shows
        // exactly what ran, how long it took, and whether it timed out.
        const rid = startRun(db, prId, `deep_review · ${t.engineName}/${t.dimension}`);
        log(`[${t.engineName}/${t.dimension}] starting…\n`);
        try {
          const res = await t.engine.run(
            { system: t.system, prompt: t.prompt, workdir, ...engineModelOptions(config, t.engineName), maxTurns: 30, timeoutMs: config.engineTimeoutMs, signal: deps.signal },
            log,
          );
          writeArtifacts(dir, { [`${t.engineName}-${t.dimension}.txt`]: res.text });
          const parsed = parseAgentJson(res.text, rawFindingsSchema);
          if (!parsed.ok) throw new Error(`parse failed (${t.engineName}/${t.dimension}): ${parsed.error}`);
          const found = parsed.value.findings.map((f): Finding => ({ ...f, engine: t.engineName, anchorable: false }));
          finishRun(db, rid, "done");
          log(`[${t.engineName}/${t.dimension}] done — ${found.length} finding(s)\n`);
          return found;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          finishRun(db, rid, "failed", message);
          throw err;
        }
      })),
    );

    const findings: Finding[] = [];
    let anyOk = 0;
    const skipped: string[] = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") { anyOk++; findings.push(...r.value); }
      else {
        skipped.push(`${tasks[i].engineName}/${tasks[i].dimension}`);
        log(`[skip] ${tasks[i].engineName}/${tasks[i].dimension}: ${r.reason}\n`);
      }
    });
    log(`[deep_review] ${anyOk}/${tasks.length} review task(s) succeeded${skipped.length ? `; skipped: ${skipped.join(", ")}` : ""}\n`);

    if (anyOk === 0) throw new Error("deep review: all engines failed");
    // Persist the pooled raw findings so a later retry can resume straight at
    // synthesize without re-running the (expensive) review fan-out.
    writeArtifacts(dir, { "raw-findings.json": JSON.stringify(findings, null, 2) });
    onUpdate(updatePr(db, prId, { status: "done" }));
    return findings;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onUpdate(updatePr(db, prId, { status: "failed", error: message }));
    throw err;
  }
}
