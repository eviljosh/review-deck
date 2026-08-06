import { z } from "zod";

export type Stage =
  | "prepare"
  | "triage"
  | "deep_review"
  | "synthesize"
  | "ready"
  | "posted";

export type RunStatus = "pending" | "running" | "done" | "failed" | "degraded" | "cancelled";

export type DangerLevel = "low" | "medium" | "high";

// Risk-surface keys are configurable (global defaults + per-repo overrides in
// the DB), so this is an open string rather than a closed enum.
export type RiskSurface = string;

export interface DangerRating {
  level: DangerLevel;
  reasons: string[];
  flags: RiskSurface[];
}

export type GoalVerdict = "achieves" | "partially" | "does-not" | "unclear";

export interface GoalAssessment {
  verdict: GoalVerdict;
  explanation?: string;
  gaps?: string[]; // promised-but-missing behavior, or notable out-of-scope changes
}

/**
 * A delta flow diagram: ONE small Mermaid picture of the major code/data flow
 * with the PR's change overlaid (added paths green, removed paths red-dashed).
 * Only produced when the PR changes the flow's topology — null for
 * broad-but-shallow changes.
 */
export interface FlowDelta {
  mermaid: string;
  caption: string; // 1–2 sentences: what the flow did before vs. now
}

export interface TriageResult {
  headline?: string;
  goal?: string;                  // the problem being solved / functionality added
  goalAssessment?: GoalAssessment;// does the diff actually accomplish the goal?
  summary: string;
  danger: DangerRating;
  discussion?: string;
  flowDelta?: FlowDelta | null;
}

/** One entry of the walkthrough reading order: a changed file + its role in the change. */
export interface FileGuideEntry {
  path: string;
  role: string;         // one sentence, shown in the file header
  walkthrough?: string; // short markdown tour: major functions/classes, purpose, problems found
}

/**
 * How much reviewer attention a changed file needs. crux/substantive render as
 * full diffs; boilerplate/mechanical collapse into skim drawers (still one
 * click from visible — the tag is advisory, never a hard hide).
 */
export type ChangeClass = "crux" | "substantive" | "boilerplate" | "mechanical";

export interface PlanFile extends FileGuideEntry {
  class: ChangeClass;
  /** Out-of-diff impact: un-updated callers of changed signatures, broken contract assumptions. */
  ripple?: string;
}

/** An ordered conceptual group of files, read foundation-first. */
export interface PlanCohort {
  label: string;
  why: string; // one line: what question reading this cohort answers
  files: PlanFile[];
}

/** The finalizer's structured reading plan — supersedes the flat FileGuideEntry[] guide. */
export interface ReadingPlan {
  cohorts: PlanCohort[];
}

/** A reviewer-authored comment anchored to a diff line, merged into the posted review. */
/** GitHub review verdict. COMMENT is the default; the others gate the merge. */
export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** One comment fetched from the PR's existing GitHub conversation. */
export interface GhComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  /** Authored by this tool (recognized via the bot sentinel). */
  bot: boolean;
}

/** An inline review-comment thread, anchored to a diff position when possible. */
export interface GhInlineThread {
  rootId: number;
  path: string;
  /** Line in the diff against the current head; null when the code has since changed. */
  line: number | null;
  side: "LEFT" | "RIGHT";
  /** Best-known line for display when `line` is null (the original anchor). */
  originalLine: number | null;
  comments: GhComment[];
}

/** PR-level conversation item: an issue comment or a review body. */
export interface GhOverallComment extends GhComment {
  /** APPROVED / CHANGES_REQUESTED for review submissions; absent for plain comments. */
  state?: string;
}

export interface GhConversation {
  threads: GhInlineThread[];
  overall: GhOverallComment[];
}

export interface UserComment {
  id: number;
  pr_id: number;
  file: string;
  line: number | null;
  side: "LEFT" | "RIGHT";
  body: string;
  posted: boolean;
  created_at: string;
}

export interface PrRecord {
  id: number;
  url: string;
  owner: string;
  repo: string;
  number: number;
  title: string | null;
  author: string | null;
  headline: string | null;        // one-line verdict from triage
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  stage: Stage;
  status: RunStatus;
  error: string | null;
  worktree_path: string | null;
  summary: string | null;
  danger_level: DangerLevel | null;
  danger_reasons: string | null; // JSON-encoded string[]
  focus_areas: string | null;    // legacy (no longer written): JSON string[] from old triage runs
  danger_flags: string | null;   // JSON-encoded RiskSurface[]
  discussion: string | null;     // markdown summary of existing PR review activity
  finding_themes: string | null; // legacy (no longer written): JSON theme clusters from old runs
  preface: string | null;
  archived_at: string | null;    // set when archived; null = active
  seen_at: string | null;        // last time the user opened it; drives unseen marks
  pr_state: string | null;       // OPEN | MERGED | CLOSED
  mergeable: string | null;      // MERGEABLE | CONFLICTING | UNKNOWN
  review_decision: string | null;// APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
  checks: string | null;         // passing | failing | pending | none
  head_sha: string | null;       // PR head commit the review was pinned to (set at prepare)
  base_sha: string | null;       // base commit the pinned diff was computed against (see base_mode)
  base_mode: string | null;      // "merge-base" (normal) | "base-tip" (base branch was rebased under a stacked PR)
  latest_sha: string | null;     // most recently observed remote head (staleness signal)
  goal: string | null;           // triage: what problem / functionality this PR targets
  goal_verdict: string | null;   // triage: achieves | partially | does-not | unclear
  goal_explanation: string | null;
  goal_gaps: string | null;      // JSON-encoded string[]
  review_verdict: string | null; // finalizer: 1–2 sentence bottom line for the reviewer
  file_guide: string | null;     // JSON-encoded FileGuideEntry[] — flat reading order (kept for old rows)
  reading_plan: string | null;   // JSON-encoded ReadingPlan — cohorts + per-file attention class
  reviewed_files: string | null; // JSON-encoded string[] — files the reviewer marked done in the walkthrough
  flow_delta: string | null;     // JSON-encoded FlowDelta — triage's before/after flow diagram (null: no topology change)
  prior_findings: string | null; // JSON snapshot of the last POSTED review's findings, taken at re-run
  claude_transport: string | null; // provenance: Claude transport used by the most recent run (e.g. "sdk", "cli (stored login)")
  created_at: string;
  updated_at: string;
}

export interface RunRecord {
  id: number;
  pr_id: number;
  stage: string;
  status: string;
  error: string | null;
  artifact_path: string | null; // streamed output persisted for debugging
  started_at: string;
  ended_at: string | null;
}

const GH_PR_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#].*)?$/;

export const prUrlSchema = z
  .string()
  .trim()
  .refine((s) => GH_PR_RE.test(s), { message: "not a GitHub PR URL" });

export const dangerRatingSchema = z.object({
  level: z.enum(["low", "medium", "high"]),
  reasons: z.array(z.string()),
  flags: z.array(z.string()),
});

export const goalAssessmentSchema = z.object({
  verdict: z.enum(["achieves", "partially", "does-not", "unclear"]),
  explanation: z.string().optional(),
  gaps: z.array(z.string()).optional(),
});

export const triageResultSchema = z.object({
  headline: z.string().optional(),
  goal: z.string().optional(),
  goalAssessment: goalAssessmentSchema.optional(),
  summary: z.string(),
  danger: dangerRatingSchema,
  discussion: z.string().optional(),
  flowDelta: z.object({ mermaid: z.string(), caption: z.string().optional() }).nullable().optional(),
});

export const createPrBodySchema = z.object({
  urls: z.array(prUrlSchema).min(1),
});

export type WsMessage =
  | { type: "pr_updated"; pr: PrRecord }
  | { type: "pr_log"; prId: number; stage: string; chunk: string }
  | { type: "findings_updated"; prId: number }
  | { type: "pr_log_reset"; prId: number }
  | { type: "pr_deleted"; prId: number }
  | { type: "hello" };

export type FindingSeverity = "blocking" | "serious" | "moderate" | "optional";
export type FindingImpact = "high" | "medium" | "low";
// Dimensions are configurable (global defaults + per-repo overrides in the DB).
export type ReviewDimension = string;

export interface Finding {
  engine: string;
  dimension: string;
  severity: FindingSeverity;
  file: string;
  line: number | null;
  side: "LEFT" | "RIGHT";
  what: string;
  why: string;
  suggestedFix: string;
  anchorable: boolean;
  theme?: string | null;
  impact?: FindingImpact | null; // finalizer's goal-relative priority
}

export interface StoredFinding extends Finding {
  id: number;
  pr_id: number;
  agreement: boolean;
  selected: boolean;
  posted: boolean;
  /** The reviewer's own words, posted above the finding with an AI disclaimer between. */
  reviewerNote: string | null;
}

export const findingSchema = z.object({
  engine: z.string(),
  dimension: z.string(),
  severity: z.enum(["blocking", "serious", "moderate", "optional"]),
  file: z.string(),
  line: z.number().int().nullable(),
  side: z.enum(["LEFT", "RIGHT"]),
  what: z.string(),
  why: z.string(),
  suggestedFix: z.string(),
  anchorable: z.boolean(),
});

export const findingsArraySchema = z.array(findingSchema);

/**
 * Normalize one agent-authored finding before schema validation.
 *
 * A reviewing agent that reports through the harness's `ReportFindings` tool
 * instead of the prompt's JSON contract emits *that* tool's schema, which has
 * no `side`, `what`, `why`, or `suggestedFix` — it uses `summary`,
 * `failure_scenario`, and `category`. Such a payload can never satisfy
 * `findingSchema`, so before this the whole lane failed to parse and every
 * finding in it was dropped (plenful#7218: one correctness + four tests
 * findings lost while the run reported "done"). We also deny the tool and tell
 * agents not to call it, but a reviewer that finds real bugs and describes them
 * in the wrong field names should not be silently discarded.
 *
 * Only fills gaps — a field the agent did supply always wins.
 */
export function normalizeAgentFinding(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const f: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (typeof f.what !== "string" && typeof f.summary === "string") f.what = f.summary;
  if (typeof f.why !== "string" && typeof f.failure_scenario === "string") f.why = f.failure_scenario;
  if (typeof f.dimension !== "string" && typeof f.category === "string") f.dimension = f.category;
  if (f.suggestedFix === undefined) f.suggestedFix = "";
  // `ReportFindings` has no line/side. Absent line means "no anchor" (null);
  // absent side means the new side, which is what a reviewer means unless they
  // are pointing at a deleted line. A wrong guess costs an inline anchor (the
  // comment degrades to file-level), not the finding.
  if (f.line === undefined) f.line = null;
  if (f.side === undefined) f.side = "RIGHT";
  // Severity has no counterpart in that tool's schema. Land in the middle:
  // high enough to survive triage, low enough not to auto-select for posting.
  if (f.severity === undefined) f.severity = "moderate";
  return f;
}

/** `schema` with agent field-name/omission drift normalized away first. */
export function lenientFinding<T extends z.ZodTypeAny>(
  schema: T,
): z.ZodType<z.output<T>, z.ZodTypeDef, unknown> {
  return z.preprocess(normalizeAgentFinding, schema);
}
