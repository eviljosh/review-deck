import { useEffect, useState } from "react";
import type { FindingTheme, PrRecord, RunRecord, StoredFinding } from "../shared/types.ts";
import {
  archivePr,
  cancelPr,
  deletePr,
  getDefaultPreface,
  listComments,
  getFindings,
  getRuns,
  postReview,
  refreshStatus,
  retryPr,
  setAllFindingsSelected,
  setDefaultPreface,
  setFindingSelected,
  setPrPreface,
  unarchivePr,
} from "./api.ts";
import { DangerBadge, DiffStat, Md, StageBadge, StatusBadges, StatusPill } from "./bits.tsx";
import { Walkthrough } from "./Walkthrough.tsx";
import { ChatPane } from "./ChatPane.tsx";
import { buildReviewMarkdown } from "../shared/review-markdown.ts";
import type { ChatStream } from "./useLivePrs.ts";

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function parseThemes(json: string | null): FindingTheme[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as FindingTheme[]) : [];
  } catch {
    return [];
  }
}

const SEV_RANK: Record<string, number> = { blocking: 0, serious: 1, moderate: 2, optional: 3 };
// Goal-aware impact (when the finalizer scored it) decides what shows unfolded;
// severity is the fallback for findings without one.
const isMajor = (f: StoredFinding) =>
  f.impact ? f.impact === "high" : f.severity === "blocking" || f.severity === "serious";

const GOAL_VERDICT_LABEL: Record<string, { label: string; cls: string }> = {
  achieves: { label: "achieves goal", cls: "b-ok" },
  partially: { label: "partially achieves", cls: "b-warn" },
  "does-not": { label: "misses goal", cls: "b-bad" },
  unclear: { label: "goal unclear", cls: "b-neutral" },
};

interface FindingGroup {
  theme: FindingTheme | null;
  items: StoredFinding[];
}

// Cluster findings under their finalizer-assigned themes (worst-severity first),
// with anything unthemed collected into a trailing "Other" group.
function groupFindings(findings: StoredFinding[], themes: FindingTheme[]): FindingGroup[] {
  if (themes.length === 0) return [{ theme: null, items: findings }];
  const byLabel = new Map<string, StoredFinding[]>(themes.map((t) => [t.label, []]));
  const other: StoredFinding[] = [];
  for (const f of findings) {
    if (f.theme && byLabel.has(f.theme)) byLabel.get(f.theme)!.push(f);
    else other.push(f);
  }
  const worst = (items: StoredFinding[]) => Math.min(...items.map((f) => SEV_RANK[f.severity] ?? 9));
  const groups: FindingGroup[] = themes
    .map((t) => ({ theme: t, items: byLabel.get(t.label)! }))
    .filter((g) => g.items.length > 0);
  if (other.length) groups.push({ theme: { label: "Other", summary: "" }, items: other });
  return groups.sort((a, b) => worst(a.items) - worst(b.items));
}

function toIso(sqliteDatetime: string): string {
  // sqlite's datetime('now','subsec') yields "YYYY-MM-DD HH:MM:SS.SSS" (UTC, no offset).
  return `${sqliteDatetime.replace(" ", "T")}Z`;
}

function formatDuration(startedAt: string, endedAt: string | null): string | null {
  if (!endedAt) return null;
  const ms = new Date(toIso(endedAt)).getTime() - new Date(toIso(startedAt)).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return `${(ms / 1000).toFixed(1)}s`;
}

function liveElapsed(startedAt: string, now: number): string {
  const ms = now - new Date(toIso(startedAt)).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  return `${Math.floor(ms / 1000)}s`;
}

function Finding({
  f,
  posted,
  onToggle,
}: {
  f: StoredFinding;
  posted: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <div className={`finding sev-${f.severity}`}>
      <input
        type="checkbox"
        checked={f.selected}
        disabled={posted}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <div className="f-body">
        <div className="f-head">
          {f.impact && <span className={`impact-pill impact-${f.impact}`} title="priority relative to the PR's goal">{f.impact}</span>}
          <span className={`sev-pill sev-${f.severity}`}>{f.severity}</span>
          <span className="f-loc">
            {f.file}
            {f.line ? `:${f.line}` : ""}
          </span>
          {f.agreement && <span title="both engines flagged this">🤝</span>}
          <span className="f-engine">{f.engine}</span>
        </div>
        <div className="f-what"><Md inline>{f.what}</Md></div>
        {f.why && <div className="f-why"><Md inline>{f.why}</Md></div>}
        {f.suggestedFix && <div className="f-fix">Fix: <Md inline>{f.suggestedFix}</Md></div>}
        {!f.anchorable && <div className="f-warn">⚠ not anchorable to a diff line (posts in body)</div>}
      </div>
    </div>
  );
}

function FindingList({
  items,
  posted,
  onToggle,
}: {
  items: StoredFinding[];
  posted: boolean;
  onToggle: (f: StoredFinding, checked: boolean) => void;
}) {
  const major = items.filter(isMajor);
  const minor = items.filter((f) => !isMajor(f));
  const render = (f: StoredFinding) => (
    <Finding key={f.id} f={f} posted={posted} onToggle={(c) => onToggle(f, c)} />
  );
  return (
    <>
      {major.map(render)}
      {minor.length > 0 && (
        <details className="fold">
          <summary>
            Show {minor.length} lower-priority finding{minor.length === 1 ? "" : "s"}
          </summary>
          <div className="fold-body">{minor.map(render)}</div>
        </details>
      )}
    </>
  );
}

export function PrDetail({
  pr,
  log,
  findingsBump,
  chat,
  onClose,
}: {
  pr: PrRecord;
  log: string;
  findingsBump: number | undefined;
  chat: ChatStream | undefined;
  onClose: () => void;
}) {
  const reasons = parseList(pr.danger_reasons);
  const focus = parseList(pr.focus_areas);
  const flags = parseList(pr.danger_flags);
  const goalGaps = parseList(pr.goal_gaps);
  const goalVerdict = pr.goal_verdict ? GOAL_VERDICT_LABEL[pr.goal_verdict] : null;

  const [findings, setFindings] = useState<StoredFinding[]>([]);
  useEffect(() => {
    getFindings(pr.id).then(setFindings).catch(() => {});
  }, [pr.id, findingsBump]);

  const [walkthrough, setWalkthrough] = useState(false);
  // Unposted walkthrough comments count toward what the Post button ships.
  const [commentCount, setCommentCount] = useState(0);
  useEffect(() => {
    listComments(pr.id).then((cs) => setCommentCount(cs.filter((c) => !c.posted).length)).catch(() => {});
  }, [pr.id, findingsBump, walkthrough]);

  // Selections/edits made inside the walkthrough must show when it closes.
  useEffect(() => {
    if (!walkthrough) getFindings(pr.id).then(setFindings).catch(() => {});
  }, [walkthrough, pr.id]);

  // Copy the whole review as a markdown brief — for pasting into a CLI agent
  // session (Claude Code / Codex / …) to continue with fixes or experiments.
  const [copied, setCopied] = useState(false);
  async function copyReview() {
    try {
      const cs = await listComments(pr.id).catch(() => []);
      await navigator.clipboard.writeText(buildReviewMarkdown(pr, findings, cs));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      alert(`copy failed: ${String(e)}`);
    }
  }

  const [runs, setRuns] = useState<RunRecord[]>([]);
  useEffect(() => {
    getRuns(pr.id).then(setRuns).catch(() => {});
  }, [pr.id, findingsBump]);

  const [preface, setPreface] = useState("");
  useEffect(() => {
    if (pr.preface != null) setPreface(pr.preface);
    else getDefaultPreface().then((d) => setPreface((cur) => cur || d));
  }, [pr.id, pr.preface]);

  const posted = pr.stage === "posted";
  const showGate = pr.stage === "ready" || posted;
  const [posting, setPosting] = useState(false);
  const selectedCount = findings.filter((f) => f.selected).length;

  const themes = parseThemes(pr.finding_themes);
  const groups = groupFindings(findings, themes);
  const toggleFinding = (f: StoredFinding, checked: boolean) => {
    setFindingSelected(pr.id, f.id, checked);
    setFindings((fs) => fs.map((x) => (x.id === f.id ? { ...x, selected: checked } : x)));
  };
  const toggleAll = (checked: boolean) => {
    setAllFindingsSelected(pr.id, checked).catch(() => {});
    setFindings((fs) => fs.map((x) => (x.posted ? x : { ...x, selected: checked })));
  };

  // Tick every second while the PR is running so elapsed times advance live.
  const isRunning = pr.status === "running";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning]);
  const runningRun = runs.find((r) => r.status === "running");

  return (
    <div className="detail">
      {walkthrough && <Walkthrough pr={pr} chat={chat} onClose={() => setWalkthrough(false)} />}
      <div className="detail-header">
        <div className="titleblock">
          <h2>
            <a href={pr.url} target="_blank" rel="noopener noreferrer" title="Open PR on GitHub">
              #{pr.number}
            </a>{" "}
            {pr.title ?? ""}
          </h2>
          <span className="repo">
            {pr.owner}/{pr.repo}
            {pr.author ? <> · by {pr.author}</> : null} · <DiffStat pr={pr} /> ·{" "}
            <a href={pr.url} target="_blank" rel="noopener noreferrer">View on GitHub ↗</a>
          </span>
        </div>
        <div className="detail-actions">
          {(pr.stage === "ready" || posted || findings.length > 0) && (
            <button className="btn btn-sm btn-primary" onClick={() => setWalkthrough(true)}>
              ⧉ Walkthrough
            </button>
          )}
          {(pr.summary || findings.length > 0) && (
            <button className="btn btn-sm" title="Copy the full review as markdown (for a CLI agent session)" onClick={copyReview}>
              {copied ? "Copied ✓" : "⎘ Copy review"}
            </button>
          )}
          {pr.status === "running" ? (
            <button className="btn btn-sm" onClick={() => cancelPr(pr.id).catch((e) => alert(String(e)))}>
              ⊘ Cancel
            </button>
          ) : (
            <button className="btn btn-sm" onClick={() => retryPr(pr.id).catch((e) => alert(String(e)))}>
              ↻ Retry
            </button>
          )}
          {pr.archived_at ? (
            <button className="btn btn-sm" onClick={() => unarchivePr(pr.id).catch((e) => alert(String(e)))}>
              ↩ Unarchive
            </button>
          ) : (
            <button className="btn btn-sm" onClick={() => archivePr(pr.id).catch((e) => alert(String(e)))}>
              🗄 Archive
            </button>
          )}
          <button
            className="btn btn-sm btn-danger"
            onClick={() => {
              if (confirm(`Delete review of #${pr.number}? This removes its findings and history.`)) {
                deletePr(pr.id)
                  .then(onClose)
                  .catch((e) => alert(String(e)));
              }
            }}
          >
            🗑 Delete
          </button>
          <button className="btn btn-sm btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>

      <div className="detail-body">
        <div className="section">
          <div className="tagrow">
            <StageBadge stage={pr.stage} />
            <StatusPill status={pr.status} />
            {isRunning && runningRun && (
              <span className="run-dur">running {liveElapsed(runningRun.started_at, now)}</span>
            )}
            <DangerBadge level={pr.danger_level} />
            <StatusBadges pr={pr} />
            <button
              className="btn btn-sm btn-ghost status-refresh"
              title="Refresh CI / mergeability / review status"
              onClick={() => refreshStatus(pr.id).catch((e) => alert(String(e)))}
            >
              ⟳
            </button>
          </div>
          {pr.error && (
            <div className="error-banner" style={{ marginTop: 10 }}>
              {pr.error}
            </div>
          )}
          {pr.headline && (
            <div className="headline"><Md inline>{pr.headline}</Md></div>
          )}
        </div>

        {flags.length > 0 && (
          <div className="section">
            <h3>Risk flags</h3>
            <div className="tagrow">
              {flags.map((f, i) => (
                <span key={i} className="badge flag">
                  {f}
                </span>
              ))}
            </div>
          </div>
        )}

        {pr.review_verdict && (
          <div className="section">
            <div className="review-verdict">
              <span className="verdict-label">Bottom line</span>
              <Md>{pr.review_verdict}</Md>
            </div>
          </div>
        )}

        {pr.goal && (
          <div className="section goal-section">
            <h3>
              🎯 Goal
              {goalVerdict && <span className={`badge ${goalVerdict.cls}`}>{goalVerdict.label}</span>}
            </h3>
            <Md>{pr.goal}</Md>
            {pr.goal_explanation && <div className="goal-explanation"><Md>{pr.goal_explanation}</Md></div>}
            {goalGaps.length > 0 && (
              <div className="goal-gaps">
                <div className="goal-gaps-title">Gaps / out-of-scope</div>
                <ul>
                  {goalGaps.map((g, i) => (
                    <li key={i}><Md inline>{g}</Md></li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {pr.summary && (
          <div className="section">
            <h3>Summary</h3>
            <Md>{pr.summary}</Md>
          </div>
        )}

        {pr.discussion && (
          <div className="section">
            <h3>💬 Discussion so far</h3>
            <Md>{pr.discussion}</Md>
          </div>
        )}

        {reasons.length > 0 && (
          <div className="section">
            <details className="fold fold-cta">
              <summary>
                <span className="fold-title">Why this rating</span>
                <span className="fold-hint">{reasons.length} reason{reasons.length === 1 ? "" : "s"} · click to view</span>
              </summary>
              <ul className="fold-body">
                {reasons.map((r, i) => (
                  <li key={i}><Md inline>{r}</Md></li>
                ))}
              </ul>
            </details>
          </div>
        )}

        {focus.length > 0 && (
          <div className="section">
            <details className="fold fold-cta">
              <summary>
                <span className="fold-title">Focus your review on</span>
                <span className="fold-hint">{focus.length} area{focus.length === 1 ? "" : "s"} · click to view</span>
              </summary>
              <ul className="fold-body">
                {focus.map((f, i) => (
                  <li key={i}><Md inline>{f}</Md></li>
                ))}
              </ul>
            </details>
          </div>
        )}

        {showGate && (
          <div className="section">
            <h3>Preface</h3>
            <textarea
              className="preface-textarea"
              value={preface}
              onChange={(e) => setPreface(e.target.value)}
              onBlur={() => setPrPreface(pr.id, preface)}
              disabled={posted}
            />
            {!posted && (
              <div style={{ marginTop: 6 }}>
                <button className="btn btn-sm" onClick={() => setDefaultPreface(preface).catch(() => {})}>
                  Save as default
                </button>
              </div>
            )}
          </div>
        )}

        {findings.length > 0 && (
          <div className="section">
            <h3>
              Findings ({findings.length}){showGate ? ` · ${selectedCount} selected` : ""}
              {showGate && !posted && (
                <span className="select-toggles">
                  <button className="btn btn-sm btn-ghost" onClick={() => toggleAll(true)}>select all</button>
                  <button className="btn btn-sm btn-ghost" onClick={() => toggleAll(false)}>none</button>
                </span>
              )}
            </h3>
            {groups.length === 1 && groups[0].theme === null ? (
              <FindingList items={groups[0].items} posted={posted} onToggle={toggleFinding} />
            ) : (
              groups.map((g) => (
                <div key={g.theme!.label} className="theme-group">
                  <div className="theme-head">
                    <span className="theme-label">{g.theme!.label}</span>
                    <span className="theme-count">{g.items.length}</span>
                  </div>
                  {g.theme!.summary && <div className="theme-summary"><Md inline>{g.theme!.summary}</Md></div>}
                  <FindingList items={g.items} posted={posted} onToggle={toggleFinding} />
                </div>
              ))
            )}
          </div>
        )}

        {showGate && (
          <div className="section">
            <button
              className="btn btn-primary"
              disabled={posted || posting || (selectedCount === 0 && commentCount === 0 && !preface.trim())}
              title={selectedCount === 0 && commentCount === 0 && !preface.trim() ? "Select a finding, add a comment, or write a preface" : undefined}
              onClick={async () => {
                setPosting(true);
                try {
                  // Staleness check: if the author pushed since this review was
                  // pinned, confirm before posting. Best-effort — a failed
                  // status fetch never blocks posting.
                  if (pr.head_sha) {
                    const remote = await refreshStatus(pr.id).catch(() => null);
                    if (remote?.headSha && remote.headSha !== pr.head_sha) {
                      const ok = confirm(
                        `The author pushed new commits since this review ` +
                        `(reviewed ${pr.head_sha.slice(0, 8)}, head is now ${remote.headSha.slice(0, 8)}).\n\n` +
                        `Comments will still anchor to the reviewed commit — lines that changed since ` +
                        `will show as "outdated" on GitHub.\n\n` +
                        `Post anyway? (Cancel to keep editing; use ↻ Retry to re-review the new head.)`,
                      );
                      if (!ok) return;
                    }
                  }
                  const r = await postReview(pr.id);
                  if (!r.ok) alert(r.error);
                } finally {
                  setPosting(false);
                }
              }}
            >
              {posted
                ? "Posted ✓"
                : posting
                  ? "Posting…"
                  : `Post ${selectedCount} finding${selectedCount === 1 ? "" : "s"}${commentCount > 0 ? ` + ${commentCount} comment${commentCount === 1 ? "" : "s"}` : ""} to GitHub`}
            </button>
          </div>
        )}

        {pr.worktree_path && (pr.stage === "ready" || pr.stage === "posted" || pr.stage === "synthesize" || pr.stage === "deep_review") && (
          <div className="section">
            <ChatPane pr={pr} stream={chat} />
          </div>
        )}

        {runs.length > 0 && (
          <div className="section">
            <h3>Runs</h3>
            <ul className="runs">
              {runs.map((r) => {
                const duration = formatDuration(r.started_at, r.ended_at);
                return (
                  <li key={r.id} className="run-item">
                    <StatusPill status={r.status} />
                    <span className="run-stage">{r.stage}</span>
                    {duration ? (
                      <span className="run-dur">{duration}</span>
                    ) : r.status === "running" ? (
                      <span className="run-dur">{liveElapsed(r.started_at, now)}</span>
                    ) : null}
                    {r.error && <span className="run-dur" title={r.error}>⚠</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="section">
          <h3>Live log</h3>
          <pre className={`log ${log ? "" : "empty"}`}>{log || "(no output yet)"}</pre>
        </div>
      </div>
    </div>
  );
}
