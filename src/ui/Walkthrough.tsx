import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { FileGuideEntry, PrRecord, StoredFinding, UserComment } from "../shared/types.ts";
import { addComment, getDiff, getFindings, listComments, removeComment, setFindingSelected, updateFinding } from "./api.ts";
import { parseUnifiedDiff, type DiffFile } from "./diffParse.ts";
import { buildReviewMarkdown } from "../shared/review-markdown.ts";
import { Md } from "./bits.tsx";
import { ChatPane } from "./ChatPane.tsx";
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

const SEV_DOT: Record<string, string> = { blocking: "●", serious: "●", moderate: "○", optional: "○" };

/** Order diff files by the finalizer's reading guide, unguided files last in diff order. */
function orderFiles(files: DiffFile[], guide: FileGuideEntry[]): DiffFile[] {
  if (guide.length === 0) return files;
  const rank = new Map(guide.map((g, i) => [g.path, i]));
  return [...files].sort((a, b) => (rank.get(a.path) ?? 999) - (rank.get(b.path) ?? 999));
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
  onSave: (fid: number, patch: { what: string; why: string; suggestedFix: string }) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [what, setWhat] = useState(f.what);
  const [why, setWhy] = useState(f.why);
  const [fix, setFix] = useState(f.suggestedFix);
  const [saving, setSaving] = useState(false);

  function startEdit() {
    setWhat(f.what);
    setWhy(f.why);
    setFix(f.suggestedFix);
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    try {
      await onSave(f.id, { what, why, suggestedFix: fix });
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
        {f.impact && <span className={`impact-pill impact-${f.impact}`}>{f.impact}</span>}
        <span className={`sev-pill sev-${f.severity}`}>{f.severity}</span>
        {f.agreement && <span title="both engines flagged this">🤝</span>}
        <span className="f-engine">{f.engine}</span>
        {f.theme && <span className="wt-theme" title="theme">{f.theme}</span>}
        {!posted && !editing && (
          <button className="btn btn-sm btn-ghost wt-edit-btn" title="Edit before posting" onClick={startEdit}>✎</button>
        )}
      </div>
      {editing ? (
        <div className="wt-finding-editor">
          <label>What
            <textarea value={what} onChange={(e) => setWhat(e.target.value)} />
          </label>
          <label>Why
            <textarea value={why} onChange={(e) => setWhy(e.target.value)} />
          </label>
          <label>Suggested fix
            <textarea value={fix} onChange={(e) => setFix(e.target.value)} />
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
          <div className="f-what"><Md inline>{f.what}</Md></div>
          {f.why && <div className="f-why"><Md inline>{f.why}</Md></div>}
          {f.suggestedFix && <div className="f-fix">Fix: <Md inline>{f.suggestedFix}</Md></div>}
        </>
      )}
    </div>
  );
}

function CommentComposer({
  onSubmit,
  onCancel,
}: {
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  return (
    <div className="wt-composer">
      <textarea
        autoFocus
        placeholder="Write a review comment… (posted to GitHub with the review)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && body.trim()) onSubmit(body.trim());
          if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
        }}
      />
      <div className="wt-composer-actions">
        <button className="btn btn-sm btn-primary" disabled={!body.trim()} onClick={() => onSubmit(body.trim())}>
          Add comment
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onCancel}>Cancel</button>
        <span className="hint">⌘↵</span>
      </div>
    </div>
  );
}

export function Walkthrough({ pr, chat, onClose }: { pr: PrRecord; chat: ChatStream | undefined; onClose: () => void }) {
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [findings, setFindings] = useState<StoredFinding[]>([]);
  const [comments, setComments] = useState<UserComment[]>([]);
  // File the context pane describes: the one clicked, or the one scrolled into view.
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  // Where the comment composer is open, if anywhere.
  const [composer, setComposer] = useState<{ file: string; line: number } | null>(null);
  const diffScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getDiff(pr.id).then(setDiffText).catch((e) => setDiffError(String(e)));
    getFindings(pr.id).then(setFindings).catch(() => {});
    listComments(pr.id).then(setComments).catch(() => {});
  }, [pr.id]);

  // Capture-phase Escape: close the walkthrough without letting the app-level
  // handler also close the whole detail view.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const guide = parseGuide(pr.file_guide);
  const files = useMemo(
    () => (diffText === null ? [] : orderFiles(parseUnifiedDiff(diffText), guide)),
    [diffText, pr.file_guide],
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
  const roleOf = (path: string) => guide.find((g) => g.path === path)?.role ?? null;

  const findingsByFile = useMemo(() => {
    const m = new Map<string, StoredFinding[]>();
    for (const f of findings) {
      if (!m.has(f.file)) m.set(f.file, []);
      m.get(f.file)!.push(f);
    }
    return m;
  }, [findings]);

  const posted = pr.stage === "posted";
  const fileFindings = current ? findingsByFile.get(current.path) ?? [] : [];
  const fileComments = current ? comments.filter((c) => c.file === current.path) : [];

  const toggleFinding = (f: StoredFinding, checked: boolean) => {
    setFindingSelected(pr.id, f.id, checked).catch(() => {});
    setFindings((fs) => fs.map((x) => (x.id === f.id ? { ...x, selected: checked } : x)));
  };
  const saveFinding = async (fid: number, patch: { what: string; why: string; suggestedFix: string }) => {
    const saved = await updateFinding(pr.id, fid, patch);
    setFindings((fs) => fs.map((x) => (x.id === fid ? saved : x)));
  };

  function scrollToFile(path: string) {
    setCurrentPath(path);
    setComposer(null);
    const el = diffScrollRef.current?.querySelector(`[data-path="${CSS.escape(path)}"]`);
    el?.scrollIntoView({ block: "start" });
  }

  async function submitComment(file: string, line: number, body: string) {
    try {
      const created = await addComment(pr.id, { file, line, body });
      setComments((cs) => [...cs, created]);
      setComposer(null);
    } catch (e) {
      alert(String(e));
    }
  }

  async function dropComment(cid: number) {
    try {
      await removeComment(pr.id, cid);
      setComments((cs) => cs.filter((c) => c.id !== cid));
    } catch (e) {
      alert(String(e));
    }
  }

  const selectedCount = findings.filter((f) => f.selected).length;

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
          {pr.review_verdict && <span className="wt-verdict"><Md inline>{pr.review_verdict}</Md></span>}
          <button className="btn btn-sm" title="Copy the full review as markdown (for a CLI agent session)" onClick={copyReview}>
            {copied ? "Copied ✓" : "⎘ Copy review"}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={onClose}>✕ Close (esc)</button>
        </div>
      </div>

      {diffError && <div className="error-banner">{diffError}</div>}
      {diffText === null && !diffError && <div className="empty-state">Loading diff…</div>}
      {diffText !== null && files.length === 0 && <div className="empty-state">No parseable diff for this PR.</div>}

      {files.length > 0 && (
        <div className="wt-body">
          <div className="wt-files">
            {files.map((f, i) => {
              const ffs = findingsByFile.get(f.path) ?? [];
              const worst = ffs.some((x) => x.severity === "blocking" || x.severity === "serious");
              const ccount = comments.filter((c) => c.file === f.path).length;
              return (
                <div
                  key={f.path}
                  className={`wt-file ${current && f.path === current.path ? "selected" : ""}`}
                  onClick={() => scrollToFile(f.path)}
                >
                  <span className="wt-file-order">{guide.length > 0 ? i + 1 : ""}</span>
                  <span className="wt-file-path" title={f.path}>{f.path}</span>
                  <span className="wt-file-meta">
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
          </div>

          <div className="wt-diff" ref={diffScrollRef}>
            {files.map((file) => {
              const inline = new Map<number, StoredFinding[]>();
              for (const f of findingsByFile.get(file.path) ?? []) {
                if (f.line !== null && f.side === "RIGHT") {
                  if (!inline.has(f.line)) inline.set(f.line, []);
                  inline.get(f.line)!.push(f);
                }
              }
              const fComments = comments.filter((c) => c.file === file.path);
              return (
                <section key={file.path} data-path={file.path} className="wt-filesection">
                  <div className="wt-diff-filehead">
                    {file.status !== "modified" && <span className={`badge wt-status-${file.status}`}>{file.status}</span>}
                    <span className="wt-diff-path">{file.path}</span>
                    {roleOf(file.path) && <span className="wt-filehead-role" title={roleOf(file.path)!}>{roleOf(file.path)}</span>}
                  </div>
                  <table className="difftable">
                    <tbody>
                      {file.lines.map((l, i) => (
                        l.kind === "hunk" ? (
                          <tr key={i} className="dl-hunk"><td className="dl-no" /><td className="dl-no" /><td className="dl-text">{l.text}</td></tr>
                        ) : (
                          <Fragment key={i}>
                            <tr className={`dl-${l.kind}`}>
                              <td className="dl-no">{l.oldNo ?? ""}</td>
                              <td className="dl-no dl-no-new" onClick={() => { if (l.newNo !== null && !posted) setComposer({ file: file.path, line: l.newNo }); }}
                                title={l.newNo !== null && !posted ? "Comment on this line" : undefined}>
                                {l.newNo ?? ""}
                                {l.newNo !== null && !posted && <span className="dl-plus">＋</span>}
                              </td>
                              <td className="dl-text">
                                <span className="dl-marker">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
                                {l.text}
                              </td>
                            </tr>
                            {l.newNo !== null && inline.has(l.newNo) &&
                              inline.get(l.newNo)!.map((f) => (
                                <tr key={`f-${f.id}`} className="dl-widget">
                                  <td colSpan={3}><FindingCard f={f} posted={posted} onToggle={toggleFinding} onSave={saveFinding} /></td>
                                </tr>
                              ))}
                            {l.newNo !== null && fComments.filter((c) => c.line === l.newNo).map((c) => (
                              <tr key={`c-${c.id}`} className="dl-widget">
                                <td colSpan={3}>
                                  <div className="wt-comment">
                                    <span className="wt-comment-tag">💬 you{c.posted ? " · posted" : ""}</span>
                                    <Md inline>{c.body}</Md>
                                    {!c.posted && (
                                      <button className="btn btn-sm btn-ghost" onClick={() => dropComment(c.id)}>✕</button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ))}
                            {composer !== null && composer.file === file.path && l.newNo === composer.line && (
                              <tr className="dl-widget">
                                <td colSpan={3}>
                                  <CommentComposer onSubmit={(b) => submitComment(file.path, composer.line, b)} onCancel={() => setComposer(null)} />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      ))}
                    </tbody>
                  </table>
                </section>
              );
            })}
          </div>

          <div className="wt-context">
            {current && roleOf(current.path) && (
              <div className="wt-section">
                <h4>This file's role</h4>
                <Md>{roleOf(current.path)!}</Md>
              </div>
            )}
            {pr.goal && (
              <div className="wt-section">
                <h4>PR goal</h4>
                <Md>{pr.goal}</Md>
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
            <div className="wt-section wt-chat">
              <ChatPane pr={pr} stream={chat} />
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
