import type Database from "better-sqlite3";
import type { ReasoningEffort } from "./engines/types.ts";
import { getSetting, setSetting } from "./db.ts";

/** One Claude review dimension: a short key plus the guidance the reviewer gets. */
export interface DimensionDef {
  key: string;
  guidance: string;
}

/** One triage risk surface: a short key plus what it covers. */
export interface RiskFlagDef {
  key: string;
  description: string;
}

export interface ReviewConfig {
  engines: { claude: boolean; codex: boolean };
  dimensions: DimensionDef[];
  riskFlags: RiskFlagDef[];
  finalizerEngine: "claude" | "codex";
  maxConcurrentReviews: number;
  maxConcurrentPipelines: number;
  /** Claude model alias passed to the agent SDK (e.g. "opus", "sonnet"). */
  claudeModel: string;
  /**
   * Transport for Claude calls. "sdk" (default) runs through the bundled
   * Agent SDK; "cli" spawns the locally installed `claude` CLI (`claude -p`)
   * with settings isolation. The CLI path exists mainly for accounts whose
   * contractual terms (e.g. BAA/ZDR) cover CLI or API-key usage but not an
   * OAuth token through the SDK.
   */
  claudeTransport: "sdk" | "cli";
  /**
   * CLI-transport credentials. "env" follows normal precedence (API key →
   * OAuth token → stored login); "stored-login" scrubs credential env vars
   * from the spawned CLI so runs always use the machine's `claude /login`
   * session — a leftover token in .env can never silently take over.
   */
  claudeCliAuth: "env" | "stored-login";
  /**
   * Codex model + reasoning effort. Leave undefined to inherit whatever the
   * local `codex` CLI has configured in ~/.codex/config.toml.
   */
  codexModel?: string;
  codexReasoningEffort?: ReasoningEffort;
  /**
   * Per-engine-call timeout (ms). Deep-review calls can be slow — Codex on high
   * reasoning over a full diff, or a Claude dimension that explores the worktree
   * — and a too-short timeout silently drops that engine's findings. 10 min is a
   * generous default; raise it if you still see "[skip] … timed out".
   */
  engineTimeoutMs: number;
  /** Disclosure line prepended to every posted review. */
  robotMarker: string;
  /**
   * Feedback loop: record which findings you accept/reject at post time and
   * feed recent rejections back to the finalizer so similar findings get
   * deprioritized on later reviews of the same repo. Off by default — the
   * injected examples steer the model, so opt in deliberately.
   */
  feedbackLoop: boolean;
}

export const DEFAULT_DIMENSIONS: DimensionDef[] = [
  { key: "correctness", guidance: "logic errors, edge cases, off-by-one, error/exception handling, concurrency, regressions" },
  { key: "intent", guidance: "does the code do what the PR description claims; flag described-but-missing or out-of-scope changes" },
  { key: "maintainability", guidance: "readability, naming, dead code, duplication, complexity, consistency with nearby code" },
  { key: "tests", guidance: "are changed behaviors covered by new/updated tests; untested edge cases (do NOT run tests)" },
  { key: "security", guidance: "injection, authz/authn gaps, secrets, unsafe deserialization, sensitive-data handling, destructive/irreversible ops" },
];

export const DEFAULT_RISK_FLAGS: RiskFlagDef[] = [
  { key: "db_migration", description: "schema/data migration, esp. breaking or irreversible" },
  { key: "api_contract", description: "public API or contract change" },
  { key: "auth_security", description: "authentication/authorization or security-sensitive code" },
  { key: "data_privacy", description: "handling of sensitive personal data" },
  { key: "infra", description: "infrastructure, config, or deployment changes" },
];

export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  engines: { claude: true, codex: true },
  dimensions: DEFAULT_DIMENSIONS,
  riskFlags: DEFAULT_RISK_FLAGS,
  finalizerEngine: "claude",
  // NOTE: 4×4 = up to 16 concurrent LLM calls at full saturation. If a burst of
  // PRs trips subscription rate limits, lower maxConcurrentPipelines (2–3).
  maxConcurrentReviews: 4,
  maxConcurrentPipelines: 4,
  claudeModel: "opus",
  claudeTransport: "sdk",
  claudeCliAuth: "env",
  // codexModel unset → inherit the CLI's configured model. Reasoning effort
  // pinned to "medium" for faster review passes; bump to "high" for deeper
  // analysis at the cost of latency.
  codexReasoningEffort: "medium",
  engineTimeoutMs: 600_000,
  robotMarker:
    "🤖 The rest of this review is AI-generated — an automated review posted at the reviewer's request. It is not a human review.",
  feedbackLoop: false,
};

export const REVIEW_CONFIG_KEY = "review_config";

/**
 * Effective config: code defaults overlaid with whatever the user saved in the
 * settings table. Loaded fresh at each pipeline launch, so settings edits apply
 * without a restart (concurrency limits are the exception — read at boot).
 */
export function loadReviewConfig(db: Database.Database): ReviewConfig {
  const raw = getSetting(db, REVIEW_CONFIG_KEY);
  if (!raw) return DEFAULT_REVIEW_CONFIG;
  try {
    const stored = JSON.parse(raw) as Partial<ReviewConfig>;
    const merged = {
      ...DEFAULT_REVIEW_CONFIG,
      ...stored,
      engines: { ...DEFAULT_REVIEW_CONFIG.engines, ...(stored.engines ?? {}) },
    };
    // Enum fields: coerce anything unexpected back to the safe default.
    if (merged.claudeTransport !== "cli") merged.claudeTransport = "sdk";
    if (merged.claudeCliAuth !== "stored-login") merged.claudeCliAuth = "env";
    return merged;
  } catch {
    return DEFAULT_REVIEW_CONFIG;
  }
}

/** Persist a settings patch (merged over any previously saved patch). */
export function saveReviewConfig(db: Database.Database, patch: Partial<ReviewConfig>): ReviewConfig {
  const raw = getSetting(db, REVIEW_CONFIG_KEY);
  let stored: Partial<ReviewConfig> = {};
  if (raw) {
    try { stored = JSON.parse(raw) as Partial<ReviewConfig>; } catch { /* start fresh */ }
  }
  const next = { ...stored, ...patch };
  setSetting(db, REVIEW_CONFIG_KEY, JSON.stringify(next));
  return loadReviewConfig(db);
}

/** Parse a JSON-encoded per-repo DimensionDef[] override; null = inherit global. */
export function parseDimensions(json: string | null | undefined): DimensionDef[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as DimensionDef[];
    const valid = Array.isArray(parsed)
      ? parsed.filter((d) => d && typeof d.key === "string" && d.key.trim() && typeof d.guidance === "string")
      : [];
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

/** Parse a JSON-encoded per-repo RiskFlagDef[] override; null = inherit global. */
export function parseRiskFlags(json: string | null | undefined): RiskFlagDef[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as RiskFlagDef[];
    const valid = Array.isArray(parsed)
      ? parsed.filter((f) => f && typeof f.key === "string" && f.key.trim() && typeof f.description === "string")
      : [];
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

export interface EngineModelOptions {
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

/**
 * Per-engine model + reasoning-effort to pass to an agent run, derived from
 * config. Claude gets an explicit model alias; Codex gets whatever is configured
 * (or nothing, to inherit the CLI's ~/.codex/config.toml defaults).
 */
export function engineModelOptions(config: ReviewConfig, engineName: string): EngineModelOptions {
  if (engineName === "claude") return { model: config.claudeModel };
  if (engineName === "codex") {
    return {
      ...(config.codexModel ? { model: config.codexModel } : {}),
      ...(config.codexReasoningEffort ? { reasoningEffort: config.codexReasoningEffort } : {}),
    };
  }
  return {};
}
