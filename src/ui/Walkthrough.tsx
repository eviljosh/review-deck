import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type TextareaHTMLAttributes } from "react";
import type { FileGuideEntry, GhConversation, GhInlineThread, PlanFile, PrRecord, ReadingPlan, StoredFinding, UserComment } from "../shared/types.ts";
import { addComment, getConversation, getDiff, getFileContent, getFindings, listComments, removeComment, replyToConversation, setFileReviewed, setFindingSelected, updateComment, updateFinding } from "./api.ts";
import { parseUnifiedDiff, type DiffFile, type DiffLine } from "./diffParse.ts";
import { highlightLine, langForPath } from "./highlight.ts";
import { buildReviewMarkdown } from "../shared/review-markdown.ts";
import { Md } from "./bits.tsx";
import { ChatPane } from "./ChatPane.tsx";
import { PostControls, usePreface } from "./PostControls.tsx";
import type { ChatStream } from "./useLivePrs.ts";

function parseGuide(json: string | null): FileGuideEntry[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as FileGuideEntry[]) : [];
  } catch {
    return [];
  }
}

// The finalizer's reading plan; old rows that only have the flat file_guide
// degrade to a single unlabeled cohort where every file gets full treatment
// (nothing auto-collapses without a real plan behind the classification).
function parseReadingPlan(pr: PrRecord): ReadingPlan | null {
  if (pr.reading_plan) {
    try {
      const parsed = JSON.parse(pr.reading_plan) as ReadingPlan;
      if (Array.isArray(parsed?.cohorts) && parsed.cohorts.length > 0) return parsed;
    } catch {
      // fall through to the flat guide
    }
  }
  const guide = parseGuide(pr.file_guide);
  return guide.length > 0
    ? { cohorts: [{ label: "", why: "", files: guide.map((g) => ({ ...g, class: "substantive" as const })) }] }
    : null;
}

function parseReviewedFiles(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

const SEV_DOT: Record<string, string> = { blocking: "●", serious: "●", moderate: "○", optional: "○" };

const EXPAND_STEP = 20;

/** One line of code, syntax-highlighted when the file's language is known. */
function CodeText({ text, lang }: { text: string; lang: string | null }) {
  const html = highlightLine(text, lang);
  // highlight.js escapes its input, so its output is safe to inject.
  if (html === null) return <>{text}</>;
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Textarea that grows to fit its content (used by the finding/comment editors). */
function AutoTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + 2}px`;
    }
  }, [props.value]);
  return <textarea ref={ref} {...props} />;
}

// Display rows for one file's diff: the parsed diff lines, plus GitHub-style
// expanders for the context gaps between/around hunks and the lines revealed
// by clicking them (sourced from the file at the reviewed commit).
type DiffRow =
  | { kind: "line"; line: DiffLine; idx: number }
  | { kind: "expanded"; oldNo: number | null; newNo: number; text: string }
  | { kind: "expander"; dir: "up" | "tail"; key: string; remaining: number };

function buildDiffRows(
  file: DiffFile,
  content: string[] | null | undefined, // undefined = not loaded yet, null = unavailable
  revealUp: Record<string, number>,
  revealTail: Record<string, number>,
): DiffRow[] {
  const rows: DiffRow[] = [];
  let lastNew = 0;   // last new-side line number emitted
  let lastDelta = 0; // old-minus-new offset of the most recent hunk

  file.lines.forEach((l, idx) => {
    if (l.kind === "hunk") {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l.text);
      const newStart = m ? Number(m[2]) : 0;
      const delta = m ? Number(m[1]) - Number(m[2]) : 0;
      const gapStart = lastNew + 1;
      const gapEnd = newStart - 1;
      const gap = gapEnd - gapStart + 1;
      if (gap > 0 && content !== null) {
        const key = `${file.path}@${idx}`;
        const revealed = Math.min(revealUp[key] ?? 0, gap);
        if (gap - revealed > 0) rows.push({ kind: "expander", dir: "up", key, remaining: gap - revealed });
        if (revealed > 0 && content) {
          // reveal upward from the hunk: the bottom `revealed` lines of the gap
          for (let n = gapEnd - revealed + 1; n <= gapEnd; n++) {
            rows.push({ kind: "expanded", oldNo: n + delta, newNo: n, text: content[n - 1] ?? "" });
          }
        }
      }
      lastDelta = delta;
      rows.push({ kind: "line", line: l, idx });
    } else {
      rows.push({ kind: "line", line: l, idx });
      if (l.newNo !== null) lastNew = l.newNo;
    }
  });

  // Trailing context after the last hunk (not for deletions — no new side).
  if (file.status !== "deleted" && content !== null) {
    const revealed = revealTail[file.path] ?? 0;
    if (content) {
      const avail = Math.max(0, content.length - lastNew);
      const shown = Math.min(revealed, avail);
      for (let n = lastNew + 1; n <= lastNew + shown; n++) {
        rows.push({ kind: "expanded", oldNo: n + lastDelta, newNo: n, text: content[n - 1] ?? "" });
      }
      if (avail - shown > 0) rows.push({ kind: "expander", dir: "tail", key: file.path, remaining: avail - shown });
    } else {
      // Not loaded yet — offer the expander; it disappears if nothing's there.
      rows.push({ kind: "expander", dir: "tail", key: file.path, remaining: 0 });
    }
  }
  return rows;
}

/** Order diff files by the reading plan (cohorts flattened), unplanned files last in diff order. */
function orderFiles(files: DiffFile[], planFiles: PlanFile[]): DiffFile[] {
  if (planFiles.length === 0) return files;
  const rank = new Map(planFiles.map((g, i) => [g.path, i]));
  return [...files].sort((a, b) => (rank.get(a.path) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.path) ?? Number.MAX_SAFE_INTEGER));
}

function FindingCard({
  f,
  posted,
  onToggle,
  onSave,
}: {
  f: StoredFinding;
  posted: boolean;
  onToggle: (f: StoredFinding, checked: boolean) => void;
  onSave: (fid: number, patch: { what: string; why: string; suggestedFix: string; reviewerNote: string | null }) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(f.reviewerNote ?? "");
  const [what, setWhat] = useState(f.what);
  const [why, setWhy] = useState(f.why);
  const [fix, setFix] = useState(f.suggestedFix);
  const [saving, setSaving] = useState(false);

  function startEdit() {
    setNote(f.reviewerNote ?? "");
    setWhat(f.what);
    setWhy(f.why);
    setFix(f.suggestedFix);
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    try {
      await onSave(f.id, { what, why, suggestedFix: fix, reviewerNote: note.trim() ? note : null });
      setEditing(false);
    } catch (e) {
      alert(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`wt-finding sev-${f.severity} ${f.selected ? "" : "wt-finding-off"}`}>
      <div className="f-head">
        <input
          type="checkbox"
          checked={f.selected}
          disabled={posted}
          title={f.selected ? "Will be posted — uncheck to drop" : "Check to include in the posted review"}
          onChange={(e) => onToggle(f, e.target.checked)}
        />
        {f.impact ? (
          <span className={`impact-pill impact-${f.impact}`} title={`priority relative to the PR's goal (engine rated: ${f.severity})`}>{f.impact}</span>
        ) : (
          <span className={`sev-pill sev-${f.severity}`}>{f.severity}</span>
        )}
        {f.agreement && <span title="both engines flagged this">🤝</span>}
        <span className="f-engine">{f.engine}</span>
        {!posted && !editing && (
          <button className="btn btn-sm btn-ghost wt-edit-btn" title="Edit before posting" onClick={startEdit}>✎</button>
        )}
      </div>
      {editing ? (
        <div className="wt-finding-editor">
          <label>Your note <span className="wt-note-hint">(posted first, in your voice, above a 🤖 disclaimer — optional)</span>
            <AutoTextarea value={note} placeholder="e.g. This one matters — it bit us in prod last quarter." onChange={(e) => setNote(e.target.value)} />
          </label>
          <label>What
            <AutoTextarea value={what} onChange={(e) => setWhat(e.target.value)} />
          </label>
          <label>Why
            <AutoTextarea value={why} onChange={(e) => setWhy(e.target.value)} />
          </label>
          <label>Suggested fix
            <AutoTextarea value={fix} onChange={(e) => setFix(e.target.value)} />
          </label>
          <div className="wt-composer-actions">
            <button className="btn btn-sm btn-primary" disabled={saving || !what.trim()} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          {f.reviewerNote && (
            <div className="wt-reviewer-note">
              <span className="wt-note-tag">👤 you</span> <Md inline>{f.reviewerNote}</Md>
            </div>
          )}
          <div className="f-what"><Md inline>{f.what}</Md></div>
          {f.why && <div className="f-why"><Md inline>{f.why}</Md></div>}
          {f.suggestedFix && <div className="f-fix">Fix: <Md inline>{f.suggestedFix}</Md></div>}
        </>
      )}
    </div>
  );
}

/** "3d ago" for the past week, then "Jul 18" (year added when not current). */
function prettyDate(iso: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const min = Math.round((Date.now() - d.getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days}d ago`;
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

/** Author (+ optional review verdict) left, timestamp right — tops every comment card. */
function CommentHead({ author, createdAt, bot, state }: { author: string; createdAt: string; bot?: boolean; state?: string }) {
  const when = prettyDate(createdAt);
  return (
    <div className="wt-comment-head">
      <span className="wt-thread-author">
        {bot ? "🤖 " : ""}{author}
        {state && <span className={`wt-review-state wt-review-${state.toLowerCase()}`}> {state.toLowerCase().replace("_", " ")}</span>}
      </span>
      {when && <span className="wt-comment-date" title={new Date(createdAt).toLocaleString()}>{when}</span>}
    </div>
  );
}

/**
 * An existing GitHub review-comment thread. Replies go to GitHub immediately
 * (they are not batched with the pending review, matching GitHub's own flow).
 */
function ThreadCard({
  thread,
  prId,
  onReplied,
}: {
  thread: GhInlineThread;
  prId: number;
  onReplied: (rootId: number, body: string) => void;
}) {
  const [replying, setReplying] = useState(false);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    setSending(true);
    try {
      await replyToConversation(prId, body.trim(), thread.rootId);
      onReplied(thread.rootId, body.trim());
      setBody("");
      setReplying(false);
    } catch (e) {
      alert(String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="wt-thread">
      {thread.comments.map((c) => (
        <div key={c.id} className="wt-thread-comment">
          <CommentHead author={c.author} createdAt={c.createdAt} bot={c.bot} />
          <Md>{c.body}</Md>
        </div>
      ))}
      {replying ? (
        <div className="wt-composer">
          <AutoTextarea
            autoFocus
            value={body}
            placeholder="Reply on GitHub…"
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && body.trim() && !sending) send();
              if (e.key === "Escape") { e.stopPropagation(); setReplying(false); }
            }}
          />
          <div className="wt-composer-actions">
            <button className="btn btn-sm btn-primary" disabled={sending || !body.trim()} onClick={send}>
              {sending ? "Replying…" : "Reply"}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setReplying(false)}>Cancel</button>
            <span className="hint">posts to GitHub immediately</span>
          </div>
        </div>
      ) : (
        <button className="btn btn-sm btn-ghost wt-thread-reply" onClick={() => setReplying(true)}>↩ Reply</button>
      )}
    </div>
  );
}

// Text state stays local so keystrokes never re-render the (large) diff tree.
function CommentComposer({
  initial = "",
  placeholder = "Write a review comment… (posted to GitHub with the review)",
  submitLabel = "Add comment",
  hint = "⌘↵",
  onSubmit,
  onCancel,
}: {
  initial?: string;
  placeholder?: string;
  submitLabel?: string;
  hint?: string;
  onSubmit: (body: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const v = body.trim();
    if (!v || busy) return;
    setBusy(true);
    try {
      await onSubmit(v);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="wt-composer">
      <AutoTextarea
        autoFocus
        placeholder={placeholder}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
        }}
      />
      <div className="wt-composer-actions">
        <button className="btn btn-sm btn-primary" disabled={busy || !body.trim()} onClick={submit}>
          {busy ? "…" : submitLabel}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onCancel}>Cancel</button>
        <span className="hint">{hint}</span>
      </div>
    </div>
  );
}

/** Preface editor with a local draft — commits (and persists) on blur only. */
function PrefaceEditor({ value, disabled, onCommit }: { value: string; disabled?: boolean; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <AutoTextarea
      value={draft}
      disabled={disabled}
      placeholder="e.g. Overall this looks solid — a couple of things to address before merge."
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== value) onCommit(draft); }}
    />
  );
}

/**
 * Collapsed row for a file the plan classifies as skimmable (mechanical /
 * boilerplate). Collapsed is never hidden: the model's one-line justification
 * shows in place of the diff, and one click expands the real thing. Files with
 * findings, comments, or threads never render as this (see `skimmable`).
 */
function SkimSection({ file, plan, onOpen }: { file: DiffFile; plan: PlanFile; onOpen: (path: string) => void }) {
  return (
    <section data-path={file.path} className="wt-filesection wt-skim">
      <div
        className="wt-diff-filehead wt-skim-head"
        title="Collapsed — the review classified this as needing only a skim. Click to show the full diff."
        onClick={() => onOpen(file.path)}
      >
        {file.status !== "modified" && <span className={`badge wt-status-${file.status}`}>{file.status}</span>}
        <span className="wt-diff-path">{file.path}</span>
        <span className={`class-chip class-${plan.class}`}>{plan.class}</span>
        <span className="wt-skim-meta">
          <span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span>
        </span>
        <span className="wt-skim-cta">▸ show diff</span>
      </div>
      {plan.role && <div className="wt-skim-role"><Md inline>{plan.role}</Md></div>}
    </section>
  );
}

// One file's diff table. Memoized so top-level state changes (chat chunks,
// scroll tracking, panel toggles) don't reconcile thousands of unrelated rows —
// with 2k+ line PRs the whole-tree re-render made even typing feel sluggish.
// Every callback prop must be useCallback-stable and every array/map prop must
// be referentially stable for the memo to hold.
const FileSection = memo(function FileSection({
  file,
  prId,
  posted,
  findings,
  fComments,
  threads,
  content,
  revealUp,
  revealTail,
  composerLine,
  editingId,
  reviewed,
  onToggleReviewed,
  onExpand,
  onOpenComposer,
  onCloseComposer,
  onSubmitComment,
  onToggleFinding,
  onSaveFinding,
  onThreadReply,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDropComment,
}: {
  file: DiffFile;
  prId: number;
  posted: boolean;
  findings: StoredFinding[];
  fComments: UserComment[];
  threads: GhInlineThread[];
  content: string[] | null | undefined;
  revealUp: Record<string, number>;
  revealTail: Record<string, number>;
  composerLine: number | null;
  editingId: number | null;
  reviewed: boolean;
  onToggleReviewed: (path: string, reviewed: boolean) => void;
  onExpand: (path: string, row: { dir: "up" | "tail"; key: string }) => void;
  onOpenComposer: (file: string, line: number) => void;
  onCloseComposer: () => void;
  onSubmitComment: (file: string, line: number, body: string) => Promise<void>;
  onToggleFinding: (f: StoredFinding, checked: boolean) => void;
  onSaveFinding: (fid: number, patch: { what: string; why: string; suggestedFix: string; reviewerNote: string | null }) => Promise<void>;
  onThreadReply: (rootId: number, body: string) => void;
  onStartEdit: (id: number) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: number, body: string) => Promise<void>;
  onDropComment: (id: number) => void;
}) {
  const inline = new Map<number, StoredFinding[]>();
  for (const f of findings) {
    if (f.line !== null && f.side === "RIGHT") {
      if (!inline.has(f.line)) inline.set(f.line, []);
      inline.get(f.line)!.push(f);
    }
  }
  // Existing GitHub threads anchored by (side, line) — RIGHT lines match
  // newNo, LEFT lines match oldNo.
  const rThreads = new Map<number, GhInlineThread[]>();
  const lThreads = new Map<number, GhInlineThread[]>();
  for (const t of threads) {
    if (t.line === null) continue;
    const m = t.side === "LEFT" ? lThreads : rThreads;
    if (!m.has(t.line)) m.set(t.line, []);
    m.get(t.line)!.push(t);
  }
  const lang = langForPath(file.path);
  return (
    <section data-path={file.path} className="wt-filesection">
      <div className="wt-diff-filehead">
        {file.status !== "modified" && <span className={`badge wt-status-${file.status}`}>{file.status}</span>}
        <span className="wt-diff-path">{file.path}</span>
        <button
          className={`wt-reviewed-btn ${reviewed ? "wt-reviewed-on" : ""}`}
          title={reviewed ? "Marked reviewed — click to unmark" : "Mark this file reviewed (progress persists across sessions)"}
          onClick={() => onToggleReviewed(file.path, !reviewed)}
        >
          {reviewed ? "✓ reviewed" : "✓ mark reviewed"}
        </button>
      </div>
      <table className="difftable">
        <tbody>
          {buildDiffRows(file, content, revealUp, revealTail).map((row, ri) => {
            if (row.kind === "expander") {
              return (
                <tr key={`x-${ri}`} className="dl-expander" onClick={() => onExpand(file.path, row)}>
                  <td className="dl-no" colSpan={2}>{row.dir === "up" ? "⇡" : "⇣"}</td>
                  <td className="dl-text">
                    ⋯ expand {row.remaining > 0 ? `${Math.min(EXPAND_STEP, row.remaining)} of ${row.remaining} hidden lines` : "lines below"}
                  </td>
                </tr>
              );
            }
            if (row.kind === "expanded") {
              return (
                <tr key={`e-${row.newNo}`} className="dl-context dl-revealed" title="context at the reviewed commit (not part of the diff — can't take comments)">
                  <td className="dl-no">{row.oldNo ?? ""}</td>
                  <td className="dl-no">{row.newNo}</td>
                  <td className="dl-text"><span className="dl-marker"> </span><CodeText text={row.text} lang={lang} /></td>
                </tr>
              );
            }
            const l = row.line;
            const i = row.idx;
            return l.kind === "hunk" ? (
              <tr key={i} className="dl-hunk"><td className="dl-no" /><td className="dl-no" /><td className="dl-text">{l.text}</td></tr>
            ) : (
              <Fragment key={i}>
                <tr className={`dl-${l.kind}`}>
                  <td className="dl-no">{l.oldNo ?? ""}</td>
                  <td className="dl-no dl-no-new" onClick={() => { if (l.newNo !== null && !posted) onOpenComposer(file.path, l.newNo); }}
                    title={l.newNo !== null && !posted ? "Comment on this line" : undefined}>
                    {l.newNo ?? ""}
                    {l.newNo !== null && !posted && <span className="dl-plus">＋</span>}
                  </td>
                  <td className="dl-text">
                    <span className="dl-marker">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
                    <CodeText text={l.text} lang={lang} />
                  </td>
                </tr>
                {l.newNo !== null && inline.has(l.newNo) &&
                  inline.get(l.newNo)!.map((f) => (
                    <tr key={`f-${f.id}`} className="dl-widget">
                      <td colSpan={3}><FindingCard f={f} posted={posted} onToggle={onToggleFinding} onSave={onSaveFinding} /></td>
                    </tr>
                  ))}
                {l.newNo !== null && rThreads.has(l.newNo) &&
                  rThreads.get(l.newNo)!.map((t) => (
                    <tr key={`t-${t.rootId}`} className="dl-widget">
                      <td colSpan={3}><ThreadCard thread={t} prId={prId} onReplied={onThreadReply} /></td>
                    </tr>
                  ))}
                {l.oldNo !== null && lThreads.has(l.oldNo) &&
                  lThreads.get(l.oldNo)!.map((t) => (
                    <tr key={`t-${t.rootId}`} className="dl-widget">
                      <td colSpan={3}><ThreadCard thread={t} prId={prId} onReplied={onThreadReply} /></td>
                    </tr>
                  ))}
                {l.newNo !== null && fComments.filter((c) => c.line === l.newNo).map((c) => (
                  <tr key={`c-${c.id}`} className="dl-widget">
                    <td colSpan={3}>
                      {editingId === c.id ? (
                        <CommentComposer
                          initial={c.body}
                          submitLabel="Save"
                          onSubmit={(b) => onSaveEdit(c.id, b)}
                          onCancel={onCancelEdit}
                        />
                      ) : (
                        <div className="wt-comment">
                          <span className="wt-comment-tag">
                            💬 you{c.posted ? " · posted" : ""}{prettyDate(c.created_at) ? ` · ${prettyDate(c.created_at)}` : ""}
                          </span>
                          <Md inline>{c.body}</Md>
                          {!c.posted && (
                            <span className="wt-comment-actions">
                              <button className="btn btn-sm btn-ghost" title="Edit comment" onClick={() => onStartEdit(c.id)}>✎</button>
                              <button className="btn btn-sm btn-ghost" title="Delete comment" onClick={() => onDropComment(c.id)}>✕</button>
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {composerLine !== null && l.newNo === composerLine && (
                  <tr className="dl-widget">
                    <td colSpan={3}>
                      <CommentComposer onSubmit={(b) => onSubmitComment(file.path, composerLine, b)} onCancel={onCloseComposer} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
});

const NO_FINDINGS: StoredFinding[] = [];
const NO_COMMENTS: UserComment[] = [];
const NO_THREADS: GhInlineThread[] = [];

export function Walkthrough({ pr, chat, onClose, onPosted }: { pr: PrRecord; chat: ChatStream | undefined; onClose: () => void; onPosted?: () => void }) {
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [findings, setFindings] = useState<StoredFinding[]>([]);
  const [comments, setComments] = useState<UserComment[]>([]);
  // File the context pane describes: the one clicked, or the one scrolled into view.
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  // Where the comment composer is open, if anywhere.
  const [composer, setComposer] = useState<{ file: string; line: number } | null>(null);
  const diffScrollRef = useRef<HTMLDivElement>(null);

  // Context expansion: full file content at the reviewed commit (lazy), plus
  // how many lines have been revealed above each hunk / after the last one.
  const [fileContents, setFileContents] = useState<Record<string, string[] | null>>({});
  const [revealUp, setRevealUp] = useState<Record<string, number>>({});
  const [revealTail, setRevealTail] = useState<Record<string, number>>({});

  // Ref mirror so `expand` can stay referentially stable (it's a memo prop on
  // every FileSection) while still reading the latest loaded contents.
  const fileContentsRef = useRef(fileContents);
  fileContentsRef.current = fileContents;

  const expand = useCallback(async (path: string, row: { dir: "up" | "tail"; key: string }) => {
    let lines = fileContentsRef.current[path];
    if (lines === undefined) {
      try {
        const raw = await getFileContent(pr.id, path);
        lines = raw.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      } catch {
        lines = null;
      }
      const loaded = lines;
      setFileContents((m) => ({ ...m, [path]: loaded }));
    }
    if (!lines) return; // unavailable — the expanders for this file disappear
    if (row.dir === "up") setRevealUp((m) => ({ ...m, [row.key]: (m[row.key] ?? 0) + EXPAND_STEP }));
    else setRevealTail((m) => ({ ...m, [row.key]: (m[row.key] ?? 0) + EXPAND_STEP }));
  }, [pr.id]);

  useEffect(() => {
    getDiff(pr.id).then(setDiffText).catch((e) => setDiffError(String(e)));
    getFindings(pr.id).then(setFindings).catch(() => {});
    listComments(pr.id).then(setComments).catch(() => {});
  }, [pr.id]);

  // The PR's existing GitHub conversation — fetched live on open, refreshable.
  const [convo, setConvo] = useState<GhConversation>({ threads: [], overall: [] });
  const [convoLoading, setConvoLoading] = useState(false);
  // Unread signal: the first fetch is the baseline; anything a later ↻ refresh
  // brings in that we haven't marked seen counts as new. Keys are prefixed so
  // thread-comment and PR-level ids can't collide.
  const seenIds = useRef<Set<string> | null>(null);
  const [unread, setUnread] = useState(0);
  const convoKeys = (v: GhConversation) => [
    ...v.threads.flatMap((t) => t.comments.map((c) => `t${c.id}`)),
    ...v.overall.map((c) => `o${c.id}`),
  ];
  const loadConvo = () => {
    setConvoLoading(true);
    getConversation(pr.id)
      .then((v) => {
        setConvo(v);
        if (seenIds.current === null) seenIds.current = new Set(convoKeys(v));
        else setUnread(convoKeys(v).filter((k) => !seenIds.current!.has(k)).length);
      })
      .catch(() => {})
      .finally(() => setConvoLoading(false));
  };
  useEffect(() => {
    seenIds.current = null;
    setUnread(0);
    loadConvo();
  }, [pr.id]);

  const appendThreadReply = useCallback((rootId: number, body: string) => {
    const c = { id: -Date.now(), author: "you", body, createdAt: new Date().toISOString(), bot: false };
    seenIds.current?.add(`t${c.id}`); // our own reply is never "unread"
    setConvo((v) => ({ ...v, threads: v.threads.map((t) => (t.rootId === rootId ? { ...t, comments: [...t.comments, c] } : t)) }));
  }, []);
  function appendOverall(body: string) {
    const c = { id: -Date.now(), author: "you", body, createdAt: new Date().toISOString(), bot: false };
    seenIds.current?.add(`o${c.id}`);
    setConvo((v) => ({ ...v, overall: [...v.overall, c] }));
  }

  // The Discussion panel: PR-level comments plus threads with no diff anchor.
  const [discussionOpen, setDiscussionOpen] = useState(false);

  // Capture-phase Escape: close the discussion panel if open, else the
  // walkthrough — without letting the app-level handler also close the whole
  // detail view.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        if (discussionOpen) setDiscussionOpen(false);
        else onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const plan = useMemo(() => parseReadingPlan(pr), [pr.reading_plan, pr.file_guide]);
  const planFiles = useMemo(() => plan?.cohorts.flatMap((c) => c.files) ?? [], [plan]);
  const planByPath = useMemo(() => new Map(planFiles.map((f) => [f.path, f])), [planFiles]);
  const files = useMemo(
    () => (diffText === null ? [] : orderFiles(parseUnifiedDiff(diffText), planFiles)),
    [diffText, planFiles],
  );

  // All files render stacked in one scroll; track which one is at the top of
  // the viewport so the context pane follows along.
  useEffect(() => {
    const rootEl = diffScrollRef.current;
    if (!rootEl || files.length === 0) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const path = (visible[0]?.target as HTMLElement | undefined)?.dataset.path;
        if (path) setCurrentPath(path);
      },
      // A section counts as "current" while its top edge is in the upper third.
      { root: rootEl, rootMargin: "0px 0px -66% 0px" },
    );
    for (const el of rootEl.querySelectorAll("[data-path]")) obs.observe(el);
    return () => obs.disconnect();
  }, [files]);

  const current = files.find((f) => f.path === currentPath) ?? files[0] ?? null;
  const planOf = (path: string) => planByPath.get(path);

  const findingsByFile = useMemo(() => {
    const m = new Map<string, StoredFinding[]>();
    for (const f of findings) {
      if (!m.has(f.file)) m.set(f.file, []);
      m.get(f.file)!.push(f);
    }
    return m;
  }, [findings]);

  const posted = pr.stage === "posted";

  const commentsByFile = useMemo(() => {
    const m = new Map<string, UserComment[]>();
    for (const c of comments) {
      if (!m.has(c.file)) m.set(c.file, []);
      m.get(c.file)!.push(c);
    }
    return m;
  }, [comments]);

  const threadsByFile = useMemo(() => {
    const m = new Map<string, GhInlineThread[]>();
    for (const t of convo.threads) {
      if (!m.has(t.path)) m.set(t.path, []);
      m.get(t.path)!.push(t);
    }
    return m;
  }, [convo.threads]);

  // A file may collapse to a skim row only when the plan tags it low-attention
  // AND nothing anchored to it demands a look — findings, your comments, or
  // GitHub threads always force the full diff (evidence beats the model's tag).
  const skimmable = useCallback(
    (path: string) => {
      const p = planByPath.get(path);
      if (!p || (p.class !== "mechanical" && p.class !== "boilerplate")) return false;
      return !findingsByFile.has(path) && !commentsByFile.has(path) && !threadsByFile.has(path);
    },
    [planByPath, findingsByFile, commentsByFile, threadsByFile],
  );
  // Skim files the reviewer explicitly expanded (per session, reset per PR).
  const [openSkims, setOpenSkims] = useState<Set<string>>(new Set());
  useEffect(() => setOpenSkims(new Set()), [pr.id]);
  const openSkim = useCallback((path: string) => setOpenSkims((s) => new Set(s).add(path)), []);

  // Per-file done state — persisted server-side so multi-day reviews keep
  // their place. Optimistic local set; the server broadcast confirms it.
  const [reviewed, setReviewed] = useState<Set<string>>(() => new Set(parseReviewedFiles(pr.reviewed_files)));
  useEffect(() => setReviewed(new Set(parseReviewedFiles(pr.reviewed_files))), [pr.id]);
  const toggleReviewed = useCallback((path: string, value: boolean) => {
    setReviewed((s) => {
      const n = new Set(s);
      if (value) n.add(path);
      else n.delete(path);
      return n;
    });
    setFileReviewed(pr.id, path, value).catch(() => {});
  }, [pr.id]);

  // Attention stat: changed lines in files needing a real read (crux/substantive
  // + anything unplanned) vs. the whole diff. Computed from the parsed diff —
  // the model classifies, it never counts.
  const attentionStat = useMemo(() => {
    if (!plan) return null;
    const lines = (f: DiffFile) => f.additions + f.deletions;
    const total = files.reduce((n, f) => n + lines(f), 0);
    const attention = files.reduce((n, f) => {
      const c = planByPath.get(f.path)?.class;
      return c === "mechanical" || c === "boilerplate" ? n : n + lines(f);
    }, 0);
    return attention < total ? { attention, total } : null;
  }, [plan, files, planByPath]);

  // Review progress, measured in substantive lines: reading 41 rename files
  // isn't progress, so skimmable files count toward neither side.
  const progress = useMemo(() => {
    if (!plan) return null;
    const lines = (f: DiffFile) => f.additions + f.deletions;
    const attention = files.filter((f) => {
      const c = planByPath.get(f.path)?.class;
      return c !== "mechanical" && c !== "boilerplate";
    });
    const total = attention.reduce((n, f) => n + lines(f), 0);
    if (total === 0) return null;
    const done = attention.filter((f) => reviewed.has(f.path)).reduce((n, f) => n + lines(f), 0);
    return { done, total, pct: Math.round((done / total) * 100) };
  }, [plan, files, planByPath, reviewed]);

  // Left-rail structure: the plan's cohorts mapped onto files actually present
  // in the diff, plus a trailing group for anything the plan missed.
  const railCohorts = useMemo(() => {
    if (!plan) return [{ label: "", why: "", files }];
    const byPath = new Map(files.map((f) => [f.path, f]));
    const used = new Set<string>();
    const cohorts = plan.cohorts
      .map((c) => ({
        label: c.label,
        why: c.why,
        files: c.files
          .map((pf) => {
            used.add(pf.path);
            return byPath.get(pf.path);
          })
          .filter((x): x is DiffFile => x !== undefined),
      }))
      .filter((c) => c.files.length > 0);
    const leftover = files.filter((f) => !used.has(f.path));
    if (leftover.length > 0) {
      cohorts.push({ label: cohorts.some((c) => c.label) ? "Other changes" : "", why: "", files: leftover });
    }
    return cohorts;
  }, [plan, files]);
  const orderNo = useMemo(() => new Map(files.map((f, i) => [f.path, i + 1])), [files]);

  const fileFindings = current ? findingsByFile.get(current.path) ?? NO_FINDINGS : NO_FINDINGS;
  const fileComments = current ? commentsByFile.get(current.path) ?? NO_COMMENTS : NO_COMMENTS;
  // Threads that can't anchor to any rendered diff row — outdated (line=null),
  // pointing at a line our pinned diff doesn't have, or on a file outside the
  // diff. These surface in the Discussion panel instead of inline.
  const unanchoredThreads = useMemo(
    () =>
      convo.threads.filter((t) => {
        if (t.line === null) return true;
        const f = files.find((x) => x.path === t.path);
        return !f || !f.lines.some((l) => (t.side === "LEFT" ? l.oldNo === t.line : l.newNo === t.line));
      }),
    [convo.threads, files],
  );
  const discussionCount = convo.overall.length + unanchoredThreads.length;

  const toggleFinding = useCallback((f: StoredFinding, checked: boolean) => {
    setFindingSelected(pr.id, f.id, checked).catch(() => {});
    setFindings((fs) => fs.map((x) => (x.id === f.id ? { ...x, selected: checked } : x)));
  }, [pr.id]);
  const saveFinding = useCallback(async (fid: number, patch: { what: string; why: string; suggestedFix: string; reviewerNote: string | null }) => {
    const saved = await updateFinding(pr.id, fid, patch);
    setFindings((fs) => fs.map((x) => (x.id === fid ? saved : x)));
  }, [pr.id]);

  // In-place editing of your own (unposted) comments. Only the id lives here;
  // the draft text is local to the composer so keystrokes stay cheap.
  const [editingId, setEditingId] = useState<number | null>(null);
  const startEdit = useCallback((id: number) => setEditingId(id), []);
  const cancelEdit = useCallback(() => setEditingId(null), []);
  const saveEdit = useCallback(async (id: number, body: string) => {
    try {
      const saved = await updateComment(pr.id, id, body.trim());
      setComments((cs) => cs.map((c) => (c.id === saved.id ? saved : c)));
      setEditingId(null);
    } catch (e) {
      alert(String(e));
    }
  }, [pr.id]);

  function scrollToFile(path: string) {
    setCurrentPath(path);
    setComposer(null);
    const el = diffScrollRef.current?.querySelector(`[data-path="${CSS.escape(path)}"]`);
    el?.scrollIntoView({ block: "start" });
  }

  const openComposer = useCallback((file: string, line: number) => setComposer({ file, line }), []);
  const closeComposer = useCallback(() => setComposer(null), []);
  const submitComment = useCallback(async (file: string, line: number, body: string) => {
    try {
      const created = await addComment(pr.id, { file, line, body });
      setComments((cs) => [...cs, created]);
      setComposer(null);
    } catch (e) {
      alert(String(e));
    }
  }, [pr.id]);

  const dropComment = useCallback(async (cid: number) => {
    try {
      await removeComment(pr.id, cid);
      setComments((cs) => cs.filter((c) => c.id !== cid));
    } catch (e) {
      alert(String(e));
    }
  }, [pr.id]);

  const selectedCount = findings.filter((f) => f.selected).length;
  const unpostedComments = comments.filter((c) => !c.posted).length;
  const [preface, setPreface, persistPreface] = usePreface(pr);
  const [showPreface, setShowPreface] = useState(false);

  // PR-level comment composer (posts to GitHub immediately, like a thread reply).
  const [prCommentOpen, setPrCommentOpen] = useState(false);
  async function sendPrComment(body: string) {
    try {
      await replyToConversation(pr.id, body);
      appendOverall(body);
      setPrCommentOpen(false);
    } catch (e) {
      alert(String(e));
    }
  }

  const [copied, setCopied] = useState(false);
  async function copyReview() {
    try {
      await navigator.clipboard.writeText(buildReviewMarkdown(pr, findings, comments));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      alert(`copy failed: ${String(e)}`);
    }
  }

  return (
    <div className="walkthrough-overlay">
      <div className="wt-header">
        <div className="wt-title">
          <strong>#{pr.number}</strong> {pr.title ?? ""}
          <span className="wt-repo">{pr.owner}/{pr.repo}</span>
          <span className="wt-selcount">{selectedCount} finding{selectedCount === 1 ? "" : "s"} selected</span>
        </div>
        <div className="wt-header-right">
          <button
            className={`btn btn-sm ${discussionOpen ? "btn-active" : ""} ${unread > 0 ? "wt-unread" : ""}`}
            title={unread > 0
              ? `${unread} new comment${unread === 1 ? "" : "s"} since you last looked (inline threads included)`
              : "PR-level comments, review verdicts, and threads without a diff line"}
            onClick={() => {
              setDiscussionOpen((s) => !s);
              seenIds.current = new Set(convoKeys(convo));
              setUnread(0);
            }}
          >
            💬 Discussion{discussionCount > 0 ? ` (${discussionCount})` : ""}{unread > 0 ? ` · ${unread} new` : ""}
          </button>
          <button className="btn btn-sm" title="Re-fetch comments and threads from GitHub" onClick={loadConvo} disabled={convoLoading}>
            {convoLoading ? "↻ Refreshing…" : "↻ Comments"}
          </button>
          <button className="btn btn-sm" title="Copy the full review as markdown (for a CLI agent session)" onClick={copyReview}>
            {copied ? "Copied ✓" : "⎘ Copy review"}
          </button>
          {(pr.stage === "ready" || posted) && (
            <>
              <button
                className={`btn btn-sm ${showPreface ? "btn-active" : ""}`}
                title="Edit the top-level review comment posted above the findings"
                onClick={() => setShowPreface((s) => !s)}
              >
                Preface{preface.trim() ? " ✓" : ""}
              </button>
              <PostControls pr={pr} selectedCount={selectedCount} commentCount={unpostedComments} preface={preface} compact onPosted={onPosted} />
            </>
          )}
          <button className="btn btn-sm btn-ghost" onClick={onClose}>✕ Close (esc)</button>
        </div>
      </div>

      {showPreface && (
        <div className="wt-preface">
          <label>Top-level review comment <span className="wt-note-hint">(leads the posted review; saved when you click away)</span>
            <PrefaceEditor value={preface} disabled={posted} onCommit={(v) => { setPreface(v); persistPreface(v); }} />
          </label>
        </div>
      )}

      {discussionOpen && (
        <div className="wt-discussion">
          <div className="wt-discussion-head">
            <h4>PR discussion</h4>
            <button className="btn btn-sm btn-ghost" onClick={() => setDiscussionOpen(false)}>✕</button>
          </div>
          <div className="wt-discussion-body">
            {pr.discussion && (
              <div className="wt-discussion-summary">
                <div className="wt-discussion-divider">Triage's read on the discussion</div>
                <Md>{pr.discussion}</Md>
              </div>
            )}
            {pr.discussion && <div className="wt-discussion-divider">Comments</div>}
            {discussionCount === 0 && <div className="wt-quiet">No PR-level comments yet.</div>}
            {convo.overall.map((c, i) => (
              <div key={`${c.id}-${i}`} className="wt-thread-comment">
                <CommentHead author={c.author} createdAt={c.createdAt} bot={c.bot} state={c.state} />
                <Md>{c.body}</Md>
              </div>
            ))}
            {unanchoredThreads.length > 0 && (
              <>
                <div className="wt-discussion-divider">Threads without a current diff line</div>
                {unanchoredThreads.map((t) => (
                  <div key={t.rootId}>
                    <span className="wt-mini-line">{t.path}:{t.originalLine ?? "?"}</span>
                    <ThreadCard thread={t} prId={pr.id} onReplied={appendThreadReply} />
                  </div>
                ))}
              </>
            )}
            {prCommentOpen ? (
              <CommentComposer
                placeholder="Comment on the PR…"
                submitLabel="Comment"
                hint="posts to GitHub immediately"
                onSubmit={sendPrComment}
                onCancel={() => setPrCommentOpen(false)}
              />
            ) : (
              <button className="btn btn-sm" onClick={() => setPrCommentOpen(true)}>＋ Comment on PR</button>
            )}
          </div>
        </div>
      )}

      {diffError && <div className="error-banner">{diffError}</div>}
      {diffText === null && !diffError && <div className="empty-state">Loading diff…</div>}
      {diffText !== null && files.length === 0 && <div className="empty-state">No parseable diff for this PR.</div>}

      {files.length > 0 && (
        <div className="wt-body">
          <div className="wt-left">
          {(attentionStat || progress) && (
            <div className="wt-attention">
              {attentionStat && (
                <div title="changed lines in crux/substantive files vs. the whole diff — the rest is collapsed as skimmable (mechanical/boilerplate)">
                  ~{attentionStat.attention.toLocaleString()} of {attentionStat.total.toLocaleString()} lines need full attention
                </div>
              )}
              {progress && (
                <div className="wt-progress" title={`${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} substantive lines in files you've marked reviewed`}>
                  <div className="wt-progress-bar"><div className="wt-progress-fill" style={{ width: `${progress.pct}%` }} /></div>
                  <span className="wt-progress-label">{progress.pct}%</span>
                </div>
              )}
            </div>
          )}
          <div className="wt-files">
            {railCohorts.map((cohort, ci) => (
              <Fragment key={cohort.label || `c${ci}`}>
                {cohort.label && (
                  <div className="wt-cohort" title={cohort.why || undefined}>
                    <span className="wt-cohort-label">{cohort.label}</span>
                    {cohort.why && <span className="wt-cohort-why">{cohort.why}</span>}
                  </div>
                )}
                {cohort.files.map((f) => {
                  const ffs = findingsByFile.get(f.path) ?? [];
                  const worst = ffs.some((x) => x.severity === "blocking" || x.severity === "serious");
                  const ccount = comments.filter((c) => c.file === f.path).length;
                  const cls = planByPath.get(f.path)?.class;
                  const skim = cls === "mechanical" || cls === "boilerplate";
                  const done = reviewed.has(f.path);
                  return (
                    <div
                      key={f.path}
                      className={`wt-file ${current && f.path === current.path ? "selected" : ""} ${skim ? "wt-file-skim" : ""} ${done ? "wt-file-reviewed" : ""}`}
                      onClick={() => scrollToFile(f.path)}
                    >
                      <span className="wt-file-order">{done ? "✓" : plan ? orderNo.get(f.path) : ""}</span>
                      <span className="wt-file-path" title={f.path}>{f.path}</span>
                      <span className="wt-file-meta">
                        {cls === "crux" && <span className="class-chip class-crux">crux</span>}
                        {skim && <span className={`class-chip class-${cls}`}>{cls === "mechanical" ? "mech" : "boiler"}</span>}
                        <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
                        {ffs.length > 0 && (
                          <span className={`wt-file-findings ${worst ? "hot" : ""}`} title={`${ffs.length} finding(s)`}>
                            {SEV_DOT[worst ? "blocking" : "moderate"]} {ffs.length}
                          </span>
                        )}
                        {ccount > 0 && <span className="wt-file-comments" title={`${ccount} of your comment(s)`}>💬{ccount}</span>}
                      </span>
                    </div>
                  );
                })}
              </Fragment>
            ))}
          </div>
          <div className="wt-left-chat">
            <ChatPane pr={pr} stream={chat} startCollapsed />
          </div>
          </div>

          <div className="wt-diff" ref={diffScrollRef}>
            {files.map((file) => {
              if (skimmable(file.path) && !openSkims.has(file.path)) {
                return <SkimSection key={file.path} file={file} plan={planByPath.get(file.path)!} onOpen={openSkim} />;
              }
              const fComments = commentsByFile.get(file.path) ?? NO_COMMENTS;
              return (
                <FileSection
                  key={file.path}
                  file={file}
                  prId={pr.id}
                  posted={posted}
                  findings={findingsByFile.get(file.path) ?? NO_FINDINGS}
                  fComments={fComments}
                  threads={threadsByFile.get(file.path) ?? NO_THREADS}
                  content={fileContents[file.path]}
                  revealUp={revealUp}
                  revealTail={revealTail}
                  composerLine={composer !== null && composer.file === file.path ? composer.line : null}
                  editingId={editingId !== null && fComments.some((c) => c.id === editingId) ? editingId : null}
                  reviewed={reviewed.has(file.path)}
                  onToggleReviewed={toggleReviewed}
                  onExpand={expand}
                  onOpenComposer={openComposer}
                  onCloseComposer={closeComposer}
                  onSubmitComment={submitComment}
                  onToggleFinding={toggleFinding}
                  onSaveFinding={saveFinding}
                  onThreadReply={appendThreadReply}
                  onStartEdit={startEdit}
                  onCancelEdit={cancelEdit}
                  onSaveEdit={saveEdit}
                  onDropComment={dropComment}
                />
              );
            })}
          </div>

          <div className="wt-context">
            {current && planOf(current.path) && (
              <div className="wt-section">
                <h4>
                  This file
                  {planOf(current.path)!.class !== "substantive" && (
                    <span className={`class-chip class-${planOf(current.path)!.class}`}>{planOf(current.path)!.class}</span>
                  )}
                </h4>
                {planOf(current.path)!.role && (
                  <div className="wt-file-role"><Md>{planOf(current.path)!.role}</Md></div>
                )}
                {planOf(current.path)!.walkthrough?.trim() && (
                  <Md>{planOf(current.path)!.walkthrough!}</Md>
                )}
              </div>
            )}
            <div className="wt-section">
              <h4>Findings in {current ? current.path.split("/").pop() : "file"} ({fileFindings.length})</h4>
              {fileFindings.length === 0 && <div className="wt-quiet">None in this file.</div>}
              {fileFindings.map((f) => (
                <div key={f.id} className="wt-mini-finding">
                  <input type="checkbox" checked={f.selected} disabled={posted} onChange={(e) => toggleFinding(f, e.target.checked)} />
                  {f.impact && <span className={`impact-pill impact-${f.impact}`}>{f.impact}</span>}
                  <span className="wt-mini-line">{f.line !== null ? `:${f.line}` : ""}</span> <Md inline>{f.what}</Md>
                </div>
              ))}
            </div>
            <div className="wt-section">
              <h4>Your comments ({fileComments.length})</h4>
              {fileComments.length === 0 && (
                <div className="wt-quiet">Click a new-side line number in the diff to comment. Comments post to GitHub with the review.</div>
              )}
              {fileComments.map((c) => (
                <div key={c.id} className="wt-mini-finding">
                  <span className="wt-mini-line">{c.line !== null ? `:${c.line}` : "(file)"}</span> <Md inline>{c.body}</Md>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
