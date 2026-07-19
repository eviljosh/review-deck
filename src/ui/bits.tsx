import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PrRecord } from "../shared/types.ts";

function ExtLink({ href, children }: { href?: string; children?: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

// Render LLM/markdown text as sanitized React elements (react-markdown does not
// execute raw HTML, so model output can't inject scripts). `inline` unwraps the
// paragraph so it flows inside an existing line (e.g. a finding title).
export function Md({ children, inline = false }: { children: string | null | undefined; inline?: boolean }) {
  if (!children) return null;
  const components = inline
    ? { p: ({ children }: { children?: ReactNode }) => <>{children}</>, a: ExtLink }
    : { a: ExtLink };
  return (
    <span className={inline ? "md md-inline" : "md"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{children}</ReactMarkdown>
    </span>
  );
}

export const STAGE_LABEL: Record<string, string> = {
  prepare: "Prepare",
  triage: "Triage",
  deep_review: "Deep review",
  synthesize: "Synthesize",
  ready: "Ready",
  posted: "Posted",
};

export const DANGER_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };

export function dangerClass(level: string | null): string {
  return level ? `danger-${level}` : "";
}

/** Animated status indicator: spinner while running, colored dot otherwise. */
export function StatusPill({ status }: { status: string }) {
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span className={`status ${status}`}>
      {status === "running" ? <span className="spinner" aria-hidden /> : <span className="status-dot" aria-hidden />}
      {label}
    </span>
  );
}

export function StageBadge({ stage }: { stage: string }) {
  return <span className="badge stage">{STAGE_LABEL[stage] ?? stage}</span>;
}

export function DangerBadge({ level }: { level: string | null }) {
  if (!level) return null;
  return <span className={`badge danger-${level}`}>{DANGER_LABEL[level] ?? level}</span>;
}

export const DANGER_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

// A PR is "unseen" if never opened, or if it changed since it was last opened.
export function isUnseen(pr: PrRecord): boolean {
  return !pr.seen_at || pr.seen_at < pr.updated_at;
}

// GitHub state badges for the queue: merge state, CI rollup, conflicts, review decision.
export function StatusBadges({ pr }: { pr: PrRecord }) {
  return (
    <>
      {pr.pr_state === "MERGED" && <span className="badge b-merged">merged</span>}
      {pr.pr_state === "CLOSED" && <span className="badge b-bad">closed</span>}
      {pr.checks === "passing" && <span className="badge b-ok" title="CI passing">✓ CI</span>}
      {pr.checks === "failing" && <span className="badge b-bad" title="CI failing">✗ CI</span>}
      {pr.checks === "pending" && <span className="badge b-warn" title="CI running">◔ CI</span>}
      {pr.mergeable === "CONFLICTING" && <span className="badge b-bad" title="merge conflicts">conflicts</span>}
      {pr.review_decision === "APPROVED" && <span className="badge b-ok">approved</span>}
      {pr.review_decision === "CHANGES_REQUESTED" && <span className="badge b-warn">changes req</span>}
      {pr.head_sha && pr.latest_sha && pr.head_sha !== pr.latest_sha && (
        <span className="badge b-warn" title={`reviewed at ${pr.head_sha.slice(0, 8)}, remote head is now ${pr.latest_sha.slice(0, 8)} — retry to re-review`}>
          ⇡ new commits
        </span>
      )}
    </>
  );
}

export function DiffStat({ pr }: { pr: PrRecord }) {
  if (pr.additions == null && pr.deletions == null) return null;
  return (
    <span className="diffstat">
      <span className="add">+{pr.additions ?? 0}</span>{" "}
      <span className="del">−{pr.deletions ?? 0}</span>
      {pr.changed_files != null ? ` · ${pr.changed_files} file${pr.changed_files === 1 ? "" : "s"}` : ""}
    </span>
  );
}
