import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PrRecord } from "../shared/types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT,
  author TEXT,
  additions INTEGER,
  deletions INTEGER,
  changed_files INTEGER,
  stage TEXT NOT NULL DEFAULT 'prepare',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  worktree_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','subsec')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','subsec'))
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_id INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  artifact_path TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now','subsec')),
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_id INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL,
  severity TEXT NOT NULL,
  file TEXT,
  line INTEGER,
  side TEXT,
  what TEXT NOT NULL,
  why TEXT,
  suggested_fix TEXT,
  theme TEXT,
  anchorable INTEGER NOT NULL DEFAULT 0,
  selected INTEGER NOT NULL DEFAULT 0,
  posted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_id INTEGER REFERENCES prs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','subsec'))
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_id INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  line INTEGER,
  side TEXT NOT NULL DEFAULT 'RIGHT',
  body TEXT NOT NULL,
  posted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','subsec'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_id INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','subsec'))
);

CREATE TABLE IF NOT EXISTS finding_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  dimension TEXT,
  severity TEXT,
  impact TEXT,
  what TEXT NOT NULL,
  decision TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','subsec'))
);

CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  guidance TEXT NOT NULL DEFAULT '',
  dimensions TEXT,
  risk_flags TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','subsec')),
  UNIQUE(owner, repo)
);
`;

const NEW_PR_COLUMNS: [string, string][] = [
  ["summary", "TEXT"],
  ["danger_level", "TEXT"],
  ["danger_reasons", "TEXT"],
  ["focus_areas", "TEXT"],
  ["danger_flags", "TEXT"],
  ["discussion", "TEXT"],
  ["headline", "TEXT"],
  ["finding_themes", "TEXT"],
  ["preface", "TEXT"],
  ["archived_at", "TEXT"],
  ["seen_at", "TEXT"],
  ["pr_state", "TEXT"],
  ["mergeable", "TEXT"],
  ["review_decision", "TEXT"],
  ["checks", "TEXT"],
  ["head_sha", "TEXT"],
  ["base_sha", "TEXT"],
  ["latest_sha", "TEXT"],
  ["goal", "TEXT"],
  ["goal_verdict", "TEXT"],
  ["goal_explanation", "TEXT"],
  ["goal_gaps", "TEXT"],
  ["review_verdict", "TEXT"],
  ["file_guide", "TEXT"],
];

export function migrate(db: Database.Database): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(prs)").all() as { name: string }[]).map((c) => c.name),
  );
  for (const [name, type] of NEW_PR_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE prs ADD COLUMN ${name} ${type}`);
    }
  }

  const findingCols = new Set(
    (db.prepare("PRAGMA table_info(findings)").all() as { name: string }[]).map((c) => c.name),
  );
  for (const [name, type] of [["engine", "TEXT"], ["agreement", "INTEGER DEFAULT 0"], ["theme", "TEXT"], ["impact", "TEXT"]] as [string, string][]) {
    if (!findingCols.has(name)) db.exec(`ALTER TABLE findings ADD COLUMN ${name} ${type}`);
  }
}

export function openDb(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Reset orphaned in-flight work left by a previous crash/kill. A freshly started
 * process has no pipelines running, so any row still at status='running' can
 * never complete — and the retry-in-flight guard (409) would refuse it forever.
 * Mark such PRs (and their open run rows) failed so they become retryable.
 * Returns the number of PRs reconciled.
 */
export function reconcileInterrupted(db: Database.Database): number {
  const info = db
    .prepare(
      "UPDATE prs SET status='failed', error=COALESCE(error, 'interrupted — server restarted while running'), updated_at=datetime('now','subsec') WHERE status='running'",
    )
    .run();
  db.prepare(
    "UPDATE runs SET status='failed', error=COALESCE(error, 'interrupted'), ended_at=datetime('now','subsec') WHERE status='running'",
  ).run();
  return info.changes;
}

export function insertPr(
  db: Database.Database,
  p: { url: string; owner: string; repo: string; number: number },
): PrRecord {
  const info = db
    .prepare("INSERT INTO prs (url, owner, repo, number) VALUES (?, ?, ?, ?)")
    .run(p.url, p.owner, p.repo, p.number);
  // Every reviewed repo gets a config row so it shows up in the settings UI.
  ensureRepoConfig(db, p.owner, p.repo);
  return getPr(db, Number(info.lastInsertRowid))!;
}

// ---------- per-repo review configuration ----------

/**
 * Per-repo review settings stored as data, not code: freeform prompt guidance
 * (house style, domain context) and optional overrides of the global review
 * dimensions / risk flags (JSON-encoded DimensionDef[] / RiskFlagDef[];
 * null = inherit global).
 */
export interface RepoConfigRow {
  id: number;
  owner: string;
  repo: string;
  guidance: string;
  dimensions: string | null;
  risk_flags: string | null;
  created_at: string;
}

export function ensureRepoConfig(db: Database.Database, owner: string, repo: string): void {
  db.prepare("INSERT OR IGNORE INTO repos (owner, repo) VALUES (?, ?)").run(owner, repo);
}

export function getRepoConfig(db: Database.Database, owner: string, repo: string): RepoConfigRow | undefined {
  return db.prepare("SELECT * FROM repos WHERE owner = ? AND repo = ?").get(owner, repo) as RepoConfigRow | undefined;
}

export function listRepoConfigs(db: Database.Database): RepoConfigRow[] {
  return db.prepare("SELECT * FROM repos ORDER BY owner, repo").all() as RepoConfigRow[];
}

export function upsertRepoConfig(
  db: Database.Database,
  owner: string,
  repo: string,
  patch: { guidance?: string; dimensions?: string | null; risk_flags?: string | null },
): RepoConfigRow {
  ensureRepoConfig(db, owner, repo);
  const sets: string[] = [];
  const params: Record<string, unknown> = { owner, repo };
  for (const key of ["guidance", "dimensions", "risk_flags"] as const) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      params[key] = patch[key];
    }
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE repos SET ${sets.join(", ")} WHERE owner = @owner AND repo = @repo`).run(params);
  }
  return getRepoConfig(db, owner, repo)!;
}

export function getPr(db: Database.Database, id: number): PrRecord | undefined {
  return db.prepare("SELECT * FROM prs WHERE id = ?").get(id) as PrRecord | undefined;
}

export function findPrByUrl(db: Database.Database, url: string): PrRecord | undefined {
  return db.prepare("SELECT * FROM prs WHERE url = ?").get(url) as PrRecord | undefined;
}

// Hard-delete a PR and its dependent rows (findings/runs cascade via FK).
export function deletePr(db: Database.Database, id: number): void {
  db.prepare("DELETE FROM prs WHERE id = ?").run(id);
}

// Mark a PR seen "now". We deliberately do NOT bump updated_at, so a later
// change (updated_at > seen_at) re-surfaces it as unseen — an inbox signal.
export function markSeen(db: Database.Database, id: number): PrRecord {
  db.prepare("UPDATE prs SET seen_at = datetime('now','subsec') WHERE id = ?").run(id);
  return getPr(db, id)!;
}

// Archive (hide) or restore a PR. archived_at doubles as the archive timestamp
// used by the age-based purge.
export function setArchived(db: Database.Database, id: number, archived: boolean): PrRecord {
  db.prepare(
    `UPDATE prs SET archived_at = ${archived ? "datetime('now','subsec')" : "NULL"}, updated_at = datetime('now','subsec') WHERE id = ?`,
  ).run(id);
  return getPr(db, id)!;
}

// Archived PRs whose archived_at is older than `days` days — candidates for purge.
export function listArchivedOlderThan(db: Database.Database, days: number): PrRecord[] {
  return db
    .prepare("SELECT * FROM prs WHERE archived_at IS NOT NULL AND archived_at <= datetime('now', ?) ORDER BY id ASC")
    .all(`-${days} days`) as PrRecord[];
}

export function listPrs(db: Database.Database): PrRecord[] {
  return db.prepare("SELECT * FROM prs ORDER BY id DESC").all() as PrRecord[];
}

const PR_COLUMNS = new Set([
  "title", "author", "additions", "deletions", "changed_files",
  "stage", "status", "error", "worktree_path",
  "summary", "danger_level", "danger_reasons", "focus_areas", "danger_flags", "discussion",
  "headline", "finding_themes", "preface",
  "pr_state", "mergeable", "review_decision", "checks",
  "head_sha", "base_sha", "latest_sha",
  "goal", "goal_verdict", "goal_explanation", "goal_gaps", "review_verdict",
  "file_guide",
]);

export function updatePr(
  db: Database.Database,
  id: number,
  patch: Partial<PrRecord>,
): PrRecord {
  const keys = Object.keys(patch);
  const bad = keys.filter((k) => !PR_COLUMNS.has(k));
  if (bad.length > 0) {
    throw new Error(`updatePr: unknown column(s): ${bad.join(", ")}`);
  }
  if (keys.length > 0) {
    const set = keys.map((k) => `${k} = @${k}`).join(", ");
    const params: Record<string, unknown> = {};
    for (const k of keys) params[k] = (patch as Record<string, unknown>)[k];
    db.prepare(
      `UPDATE prs SET ${set}, updated_at = datetime('now','subsec') WHERE id = @id`,
    ).run({ ...params, id });
  }
  return getPr(db, id)!;
}

const SEVERITY_RANK: Record<string, number> = { blocking: 0, serious: 1, moderate: 2, optional: 3 };
// Goal-relative priority beats raw severity; findings without an impact (older
// rows, degraded synthesize) sort by severity alone among the mediums.
const IMPACT_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

export function insertFinding(
  db: Database.Database,
  prId: number,
  f: import("../shared/types.ts").Finding & { agreement: boolean; selected?: boolean },
): import("../shared/types.ts").StoredFinding {
  const info = db.prepare(
    `INSERT INTO findings (pr_id, engine, dimension, severity, file, line, side, what, why, suggested_fix, theme, impact, anchorable, agreement, selected)
     VALUES (@pr_id,@engine,@dimension,@severity,@file,@line,@side,@what,@why,@suggested_fix,@theme,@impact,@anchorable,@agreement,@selected)`,
  ).run({
    pr_id: prId, engine: f.engine, dimension: f.dimension, severity: f.severity,
    file: f.file, line: f.line, side: f.side, what: f.what, why: f.why,
    suggested_fix: f.suggestedFix, theme: f.theme ?? null, impact: f.impact ?? null,
    anchorable: f.anchorable ? 1 : 0, agreement: f.agreement ? 1 : 0,
    selected: f.selected ? 1 : 0,
  });
  return getFinding(db, Number(info.lastInsertRowid))!;
}

function rowToFinding(r: Record<string, unknown>): import("../shared/types.ts").StoredFinding {
  return {
    id: r.id as number, pr_id: r.pr_id as number, engine: r.engine as string,
    dimension: r.dimension as string, severity: r.severity as never,
    file: r.file as string, line: (r.line as number) ?? null, side: r.side as never,
    what: r.what as string, why: r.why as string, suggestedFix: (r.suggested_fix as string) ?? "",
    theme: (r.theme as string) ?? null,
    impact: (r.impact as never) ?? null,
    anchorable: !!r.anchorable, agreement: !!r.agreement, selected: !!r.selected, posted: !!r.posted,
  };
}

function getFinding(db: Database.Database, id: number) {
  const r = db.prepare("SELECT * FROM findings WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? rowToFinding(r) : undefined;
}

export function listFindings(db: Database.Database, prId: number) {
  const rows = db.prepare("SELECT * FROM findings WHERE pr_id = ?").all(prId) as Record<string, unknown>[];
  return rows.map(rowToFinding).sort((a, b) =>
    (IMPACT_RANK[a.impact ?? "medium"] ?? 1) - (IMPACT_RANK[b.impact ?? "medium"] ?? 1) ||
    (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || a.id - b.id);
}

export function replaceFindings(
  db: Database.Database,
  prId: number,
  findings: (import("../shared/types.ts").Finding & { agreement: boolean; selected?: boolean })[],
): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM findings WHERE pr_id = ?").run(prId);
    for (const f of findings) insertFinding(db, prId, f);
  });
  tx();
}

export const DEFAULT_PREFACE_KEY = "default_preface";

export function getSetting(db: Database.Database, key: string): string | null {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function setFindingSelected(db: Database.Database, findingId: number, selected: boolean): void {
  const info = db.prepare("UPDATE findings SET selected = ? WHERE id = ?").run(selected ? 1 : 0, findingId);
  if (info.changes === 0) throw new Error(`finding ${findingId} not found`);
}

export function setAllFindingsSelected(db: Database.Database, prId: number, selected: boolean): void {
  db.prepare("UPDATE findings SET selected = ? WHERE pr_id = ? AND posted = 0").run(selected ? 1 : 0, prId);
}

// ---------- finding feedback (what the reviewer accepted vs. rejected) ----------

/**
 * Record the reviewer's post-time decisions for a PR: every selected finding is
 * an "accepted" example, every unselected one a "rejected" example. Rejected
 * examples are later fed back to the finalizer so it learns, per repo, which
 * kinds of findings this reviewer doesn't want to see prioritized.
 */
export function recordFindingFeedback(db: Database.Database, prId: number): number {
  const pr = getPr(db, prId);
  if (!pr) return 0;
  const findings = listFindings(db, prId);
  const insert = db.prepare(
    "INSERT INTO finding_feedback (owner, repo, dimension, severity, impact, what, decision) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  let n = 0;
  for (const f of findings) {
    insert.run(pr.owner, pr.repo, f.dimension, f.severity, f.impact ?? null, f.what.slice(0, 300), f.selected ? "accepted" : "rejected");
    n++;
  }
  return n;
}

/** Recent rejected-finding examples for a repo, newest first, rendered as one-liners. */
export function listRejectedExamples(db: Database.Database, owner: string, repo: string, limit = 12): string[] {
  const rows = db
    .prepare(
      "SELECT severity, dimension, what FROM finding_feedback WHERE owner = ? AND repo = ? AND decision = 'rejected' ORDER BY id DESC LIMIT ?",
    )
    .all(owner, repo, limit) as { severity: string | null; dimension: string | null; what: string }[];
  return rows.map((r) => `[${r.severity ?? "?"}${r.dimension ? `/${r.dimension}` : ""}] ${r.what}`);
}

// ---------- per-PR chat ----------

export function insertChatMessage(
  db: Database.Database,
  prId: number,
  role: "user" | "assistant",
  content: string,
): import("../shared/types.ts").ChatMessage {
  const info = db.prepare("INSERT INTO chat_messages (pr_id, role, content) VALUES (?, ?, ?)").run(prId, role, content);
  return db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(Number(info.lastInsertRowid)) as import("../shared/types.ts").ChatMessage;
}

export function listChatMessages(db: Database.Database, prId: number): import("../shared/types.ts").ChatMessage[] {
  return db.prepare("SELECT * FROM chat_messages WHERE pr_id = ? ORDER BY id ASC").all(prId) as import("../shared/types.ts").ChatMessage[];
}

export function clearChatMessages(db: Database.Database, prId: number): void {
  db.prepare("DELETE FROM chat_messages WHERE pr_id = ?").run(prId);
}

// ---------- reviewer comments (merged into the posted review) ----------

function rowToComment(r: Record<string, unknown>): import("../shared/types.ts").UserComment {
  return {
    id: r.id as number, pr_id: r.pr_id as number, file: r.file as string,
    line: (r.line as number) ?? null, side: (r.side as never) ?? "RIGHT",
    body: r.body as string, posted: !!r.posted, created_at: r.created_at as string,
  };
}

export function insertComment(
  db: Database.Database,
  prId: number,
  c: { file: string; line: number | null; side?: "LEFT" | "RIGHT"; body: string },
): import("../shared/types.ts").UserComment {
  const info = db.prepare(
    "INSERT INTO comments (pr_id, file, line, side, body) VALUES (?, ?, ?, ?, ?)",
  ).run(prId, c.file, c.line, c.side ?? "RIGHT", c.body);
  const row = db.prepare("SELECT * FROM comments WHERE id = ?").get(Number(info.lastInsertRowid)) as Record<string, unknown>;
  return rowToComment(row);
}

export function listComments(db: Database.Database, prId: number): import("../shared/types.ts").UserComment[] {
  const rows = db.prepare("SELECT * FROM comments WHERE pr_id = ? ORDER BY id ASC").all(prId) as Record<string, unknown>[];
  return rows.map(rowToComment);
}

export function deleteComment(db: Database.Database, prId: number, commentId: number): void {
  const info = db.prepare("DELETE FROM comments WHERE id = ? AND pr_id = ? AND posted = 0").run(commentId, prId);
  if (info.changes === 0) throw new Error(`comment ${commentId} not found (or already posted)`);
}

export function markCommentsPosted(db: Database.Database, prId: number): void {
  db.prepare("UPDATE comments SET posted = 1 WHERE pr_id = ? AND posted = 0").run(prId);
}

export function startRun(db: Database.Database, prId: number, stage: string): number {
  const info = db.prepare("INSERT INTO runs (pr_id, stage, status) VALUES (?, ?, 'running')").run(prId, stage);
  return Number(info.lastInsertRowid);
}
export function finishRun(db: Database.Database, runId: number, status: string, error?: string): void {
  db.prepare("UPDATE runs SET status = ?, error = ?, ended_at = datetime('now','subsec') WHERE id = ?").run(status, error ?? null, runId);
}
export function listRuns(db: Database.Database, prId: number): import("../shared/types.ts").RunRecord[] {
  return db.prepare("SELECT * FROM runs WHERE pr_id = ? ORDER BY id ASC").all(prId) as import("../shared/types.ts").RunRecord[];
}
