import { Fragment, useEffect, useMemo, useState } from "react";
import type { FileGuideEntry, PrRecord, StoredFinding, UserComment } from "../shared/types.ts";
import { addComment, getDiff, getFindings, listComments, removeComment } from "./api.ts";
import { parseUnifiedDiff, type DiffFile } from "./diffParse.ts";
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

function FindingCard({ f }: { f: StoredFinding }) {
  return (
    <div className={`wt-finding sev-${f.severity}`}>
      <div className="f-head">
        {f.impact && <span className={`impact-pill impact-${f.impact}`}>{f.impact}</span>}
        <span className={`sev-pill sev-${f.severity}`}>{f.severity}</span>
        {f.agreement && <span title="both engines flagged this">🤝</span>}
        <span className="f-engine">{f.engine}</span>
        {f.theme && <span className="wt-theme" title="theme">{f.theme}</span>}
      </div>
      <div className="f-what"><Md inline>{f.what}</Md></div>
      {f.why && <div className="f-why"><Md inline>{f.why}</Md></div>}
      {f.suggestedFix && <div className="f-fix">Fix: <Md inline>{f.suggestedFix}</Md></div>}
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
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Line the comment composer is open on (RIGHT-side line number), if any.
  const [composerLine, setComposerLine] = useState<number | null>(null);

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
  const current = files.find((f) => f.path === selectedPath) ?? files[0] ?? null;
  const roleOf = (path: string) => guide.find((g) => g.path === path)?.role ?? null;

  const findingsByFile = useMemo(() => {
    const m = new Map<string, StoredFinding[]>();
    for (const f of findings) {
      if (!m.has(f.file)) m.set(f.file, []);
      m.get(f.file)!.push(f);
    }
    return m;
  }, [findings]);

  const fileFindings = current ? findingsByFile.get(current.path) ?? [] : [];
  const fileComments = current ? comments.filter((c) => c.file === current.path) : [];
  // Anchored AI findings render inline at their line; the rest go in the side pane.
  const inlineFindings = new Map<number, StoredFinding[]>();
  for (const f of fileFindings) {
    if (f.line !== null && f.side === "RIGHT") {
      if (!inlineFindings.has(f.line)) inlineFindings.set(f.line, []);
      inlineFindings.get(f.line)!.push(f);
    }
  }
  const unanchored = fileFindings.filter((f) => f.line === null || f.side !== "RIGHT");
  const posted = pr.stage === "posted";

  async function submitComment(line: number | null, body: string) {
    if (!current) return;
    try {
      const created = await addComment(pr.id, { file: current.path, line, body });
      setComments((cs) => [...cs, created]);
      setComposerLine(null);
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

  return (
    <div className="walkthrough-overlay">
      <div className="wt-header">
        <div className="wt-title">
          <strong>#{pr.number}</strong> {pr.title ?? ""}
          <span className="wt-repo">{pr.owner}/{pr.repo}</span>
        </div>
        <div className="wt-header-right">
          {pr.review_verdict && <span className="wt-verdict"><Md inline>{pr.review_verdict}</Md></span>}
          <button className="btn btn-sm btn-ghost" onClick={onClose}>✕ Close (esc)</button>
        </div>
      </div>

      {diffError && <div className="error-banner">{diffError}</div>}
      {diffText === null && !diffError && <div className="empty-state">Loading diff…</div>}

      {diffText !== null && files.length === 0 && <div className="empty-state">No parseable diff for this PR.</div>}

      {current && (
        <div className="wt-body">
          <div className="wt-files">
            {files.map((f, i) => {
              const ffs = findingsByFile.get(f.path) ?? [];
              const worst = ffs.some((x) => x.severity === "blocking" || x.severity === "serious");
              const ccount = comments.filter((c) => c.file === f.path).length;
              return (
                <div
                  key={f.path}
                  className={`wt-file ${f.path === current.path ? "selected" : ""}`}
                  onClick={() => { setSelectedPath(f.path); setComposerLine(null); }}
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

          <div className="wt-diff">
            <div className="wt-diff-filehead">
              {current.status !== "modified" && <span className={`badge wt-status-${current.status}`}>{current.status}</span>}
              <span className="wt-diff-path">{current.path}</span>
            </div>
            <table className="difftable">
              <tbody>
                {current.lines.map((l, i) => (
                  l.kind === "hunk" ? (
                    <tr key={i} className="dl-hunk"><td className="dl-no" /><td className="dl-no" /><td className="dl-text">{l.text}</td></tr>
                  ) : (
                    <Fragment key={i}>
                      <tr className={`dl-${l.kind}`}>
                        <td className="dl-no">{l.oldNo ?? ""}</td>
                        <td className="dl-no dl-no-new" onClick={() => { if (l.newNo !== null && !posted) setComposerLine(l.newNo); }}
                          title={l.newNo !== null && !posted ? "Comment on this line" : undefined}>
                          {l.newNo ?? ""}
                          {l.newNo !== null && !posted && <span className="dl-plus">＋</span>}
                        </td>
                        <td className="dl-text">
                          <span className="dl-marker">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
                          {l.text}
                        </td>
                      </tr>
                      {l.newNo !== null && inlineFindings.has(l.newNo) &&
                        inlineFindings.get(l.newNo)!.map((f) => (
                          <tr key={`f-${f.id}`} className="dl-widget"><td colSpan={3}><FindingCard f={f} /></td></tr>
                        ))}
                      {l.newNo !== null && fileComments.filter((c) => c.line === l.newNo).map((c) => (
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
                      {composerLine !== null && l.newNo === composerLine && (
                        <tr className="dl-widget">
                          <td colSpan={3}>
                            <CommentComposer onSubmit={(b) => submitComment(composerLine, b)} onCancel={() => setComposerLine(null)} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                ))}
              </tbody>
            </table>
          </div>

          <div className="wt-context">
            {roleOf(current.path) && (
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
              <h4>Findings here ({fileFindings.length})</h4>
              {fileFindings.length === 0 && <div className="wt-quiet">None in this file.</div>}
              {unanchored.map((f) => <FindingCard key={f.id} f={f} />)}
              {fileFindings.filter((f) => !unanchored.includes(f)).map((f) => (
                <div key={f.id} className="wt-mini-finding">
                  {f.impact && <span className={`impact-pill impact-${f.impact}`}>{f.impact}</span>}
                  <span className="wt-mini-line">:{f.line}</span> <Md inline>{f.what}</Md>
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
