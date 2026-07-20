import { useEffect, useState } from "react";
import type { PrRecord, ReviewEvent } from "../shared/types.ts";
import { getDefaultPreface, postReview, refreshStatus, setPrPreface } from "./api.ts";

/**
 * The PR's top-level review comment: the stored per-PR value, falling back to
 * the saved default for PRs that never set one. `persist` saves on blur.
 */
export function usePreface(pr: PrRecord): [string, (v: string) => void, () => void] {
  const [preface, setPreface] = useState("");
  useEffect(() => {
    if (pr.preface != null) setPreface(pr.preface);
    else getDefaultPreface().then((d) => setPreface((cur) => cur || d));
  }, [pr.id, pr.preface]);
  const persist = () => { setPrPreface(pr.id, preface).catch(() => {}); };
  return [preface, setPreface, persist];
}

function postLabel(event: ReviewEvent, nFindings: number, nComments: number): string {
  const content =
    nFindings === 0 && nComments === 0
      ? ""
      : ` ${nFindings} finding${nFindings === 1 ? "" : "s"}${nComments > 0 ? ` + ${nComments} comment${nComments === 1 ? "" : "s"}` : ""}`;
  if (event === "APPROVE") return content ? `Approve +${content}` : "Approve PR";
  if (event === "REQUEST_CHANGES") return content ? `Request changes +${content}` : "Request changes";
  return `Post${content} to GitHub`;
}

/**
 * The verdict selector + post button, shared by the detail view and the
 * walkthrough header. Awaits the GitHub POST; onPosted fires only on success.
 */
export function PostControls({
  pr,
  selectedCount,
  commentCount,
  preface,
  compact,
  onPosted,
}: {
  pr: PrRecord;
  selectedCount: number;
  commentCount: number;
  preface: string;
  compact?: boolean;
  onPosted?: () => void;
}) {
  const posted = pr.stage === "posted";
  const [posting, setPosting] = useState(false);
  const [event, setEvent] = useState<ReviewEvent>("COMMENT");
  const empty = selectedCount === 0 && commentCount === 0 && !preface.trim();

  async function post() {
    setPosting(true);
    try {
      // Staleness check: if the author pushed since this review was pinned,
      // confirm before posting. Best-effort — a failed status fetch never
      // blocks posting.
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
      const r = await postReview(pr.id, event);
      if (!r.ok) alert(r.error);
      else onPosted?.();
    } finally {
      setPosting(false);
    }
  }

  return (
    <>
      <select
        className={`post-event-select ${compact ? "post-event-compact" : ""}`}
        value={event}
        disabled={posted || posting}
        title="How the review lands on GitHub — comment only (default), approve, or request changes"
        onChange={(e) => setEvent(e.target.value as ReviewEvent)}
      >
        <option value="COMMENT">Comment only</option>
        <option value="APPROVE">Approve ✓</option>
        <option value="REQUEST_CHANGES">Request changes ✗</option>
      </select>
      <button
        className={`btn btn-primary ${compact ? "btn-sm" : ""}`}
        disabled={posted || posting || (event !== "APPROVE" && empty)}
        title={empty && event !== "APPROVE" ? "Select a finding, add a comment, or write a preface" : undefined}
        onClick={post}
      >
        {posted ? "Posted ✓" : posting ? "Posting…" : postLabel(event, selectedCount, commentCount)}
      </button>
    </>
  );
}
