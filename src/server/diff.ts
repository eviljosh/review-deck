import { existsSync } from "node:fs";
import type { Exec } from "./exec.ts";
import type { Finding, FindingSeverity, PrRecord } from "../shared/types.ts";
import type { LineageTip } from "./prompts.ts";
import { readArtifact } from "./artifacts.ts";
import { fetchPrDiff } from "./gh.ts";

// The diff every stage reviews against: the one pinned at prepare time
// (data/artifacts/<pr>/prepare/diff.patch), so triage, deep review, synthesis,
// and posting all see the same code even if the author pushes mid-review.
// Falls back to a live `gh pr diff` for rows prepared before pinning existed
// (or when the artifact write failed).
export async function getReviewDiff(
  exec: Exec, dataDir: string, pr: PrRecord,
): Promise<{ diff: string; fromPrepare: boolean }> {
  const pinned = readArtifact(dataDir, pr.id, "prepare", "diff.patch");
  if (pinned) return { diff: pinned, fromPrepare: true };
  return { diff: await fetchPrDiff(exec, pr.owner, pr.repo, pr.number), fromPrepare: false };
}

export async function getPinnedDiff(exec: Exec, dataDir: string, pr: PrRecord): Promise<string> {
  return (await getReviewDiff(exec, dataDir, pr)).diff;
}

/** New-side paths of every file a unified diff touches, in diff order. */
export function diffPaths(diff: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of diff.matchAll(/^diff --git a\/.* b\/(.+)$/gm)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

/**
 * Size of a unified diff, measured from the diff itself.
 *
 * GitHub's PR counters (`additions`/`deletions`/`changedFiles`) can describe a
 * different diff than the one under review: GitHub stops refreshing them while
 * a PR is conflicted, and a stacked branch that merges its base's ancestor
 * leaves them describing a long-gone state. Telling a reviewing agent "11 files"
 * while handing it 445 wastes its output budget on litigating the mismatch, so
 * every prompt sizes the diff it was actually given.
 */
export function diffStats(diff: string): { additions: number; deletions: number; changedFiles: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    // "+++"/"---" are file headers, not content lines. A content line whose
    // own text begins "++" or "--" is skipped too (git parses hunk structure
    // and would count it) — close enough for a prompt size hint, and the
    // mismatch note keys on diffPaths(), which only matches real headers.
    if (line.startsWith("+")) { if (!line.startsWith("+++")) additions++; }
    else if (line.startsWith("-")) { if (!line.startsWith("---")) deletions++; }
  }
  return { additions, deletions, changedFiles: diffPaths(diff).length };
}

export type BaseMode = "merge-base" | "base-tip";

export interface BaseCandidate {
  sha: string;
  /** How many files the candidate's diff touches. Counts only: the losing
   * candidate is often the huge one (a merely-advanced base makes the tip diff
   * the *larger* of the two), so callers measure with `--name-only` and fetch
   * full text for the winner alone. */
  files: number;
}

/**
 * Which base the pinned diff should be computed against.
 *
 * `merge-base` is the standard PR diff and the default: it excludes work the
 * base branch picked up after this branch forked, which is exactly what you
 * want when the base is a long-lived branch that keeps moving.
 *
 * It breaks down for a *stacked* PR whose base branch was rewritten — rebased
 * or force-pushed — after this branch forked off it. The head still carries the
 * base's pre-rebase commits, so the merge-base falls back to wherever the two
 * histories last agreed, and `merge-base..head` sweeps in the whole base branch's
 * work as if this PR had written it. plenful#7218 fed reviewers 445 files /
 * 1.9MB that way; against the base branch's tip the same PR is 8 files.
 *
 * Both failure modes are visible in the file counts, which is what this keys on:
 *   • base branch moved ahead normally → the base-tip diff is the *larger* of
 *     the two (it adds the base's new work back in, inverted) → keep merge-base.
 *   • base branch was rewritten → the base-tip diff is dramatically *smaller*
 *     (it drops the base's work, which was never this PR's) → use base-tip.
 * The margin (2x and at least 5 files) keeps small, ordinary differences from
 * flipping the choice; a rewritten base shows up as an order of magnitude.
 *
 * Caveat worth knowing when the base-tip diff wins: two-dot against the tip
 * renders base commits the head hasn't absorbed as reversals. That noise is
 * bounded by how far the base has moved, and it beats reviewing 437 files of
 * someone else's code.
 */
export function pickPinnedBase(
  mergeBase: BaseCandidate,
  baseTip: BaseCandidate | null,
): { sha: string; mode: BaseMode } {
  const chosen = { sha: mergeBase.sha, mode: "merge-base" as BaseMode };
  if (!baseTip || baseTip.sha === mergeBase.sha) return chosen;
  // An empty base-tip diff means the head is already contained in the base
  // branch: there'd be nothing left to review, so keep the merge-base diff.
  if (baseTip.files === 0) return chosen;
  if (mergeBase.files >= baseTip.files * 2 && mergeBase.files - baseTip.files >= 5) {
    return { sha: baseTip.sha, mode: "base-tip" };
  }
  return chosen;
}

/**
 * Files a base-tip diff carries only because the base branch moved on.
 *
 * Diffing two-dot against the base branch tip renders base commits the head
 * never absorbed as *reversals*: the base's own work, played backwards, framed
 * as this PR's doing. On plenful#7218 that was 3 of 8 files, and a reviewer
 * dutifully filed a moderate finding accusing the PR of an "undescribed
 * behavior change" that was in fact one base commit inverted.
 *
 * A file is drift when both hold:
 *   • some base commit the head lacks touched it, and
 *   • the PR itself never touched it (unchanged between merge-base and head).
 * The second condition is what keeps real work from being filtered away when a
 * PR and its base edit the same file — then the reversal noise is entangled
 * with genuine changes and dropping the file would hide the PR's own edits.
 *
 * Both arguments are raw newline-separated `git` path output.
 */
export function baseDriftFiles(touchedByUnabsorbedBaseCommits: string, touchedByPr: string): Set<string> {
  const lines = (raw: string): string[] => raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const prTouched = new Set(lines(touchedByPr));
  return new Set(lines(touchedByUnabsorbedBaseCommits).filter((f) => !prTouched.has(f)));
}

/** `diff` with every section for a path in `drop` removed. */
export function dropDiffFiles(diff: string, drop: ReadonlySet<string>): string {
  if (drop.size === 0) return diff;
  return diff
    .split(/^(?=diff --git )/m)
    .filter((part) => {
      const m = /^diff --git a\/.* b\/(.+)$/m.exec(part);
      return !m || !drop.has(m[1]);
    })
    .join("");
}

/** How to describe, to a reviewing agent, the base a pinned diff was taken against. */
export function baseLabel(pr: Pick<PrRecord, "base_mode" | "base_sha">): string | undefined {
  if (!pr.base_sha) return undefined;
  const sha = pr.base_sha.slice(0, 8);
  return pr.base_mode === "base-tip"
    ? `the tip of the PR's base branch (\`${sha}\`)`
    : `the merge-base with the PR's base branch (\`${sha}\`)`;
}

/**
 * The lineage-tip checkout to hand a reviewing agent, or null when there isn't
 * a live one.
 *
 * The columns are written at prepare time, but the directory is shared across a
 * stack and reclaimed on archive — by the time a resumed run reaches deep
 * review it may be gone. Check the disk, not just the row: a tip path the agent
 * cannot read is worse than no tip, since the rule tells it to check there.
 */
export function liveLineageTip(
  pr: Pick<PrRecord, "lineage_tip_ref" | "lineage_tip_sha" | "lineage_tip_ahead" | "lineage_tip_path">,
  fileExists: (p: string) => boolean = existsSync,
): LineageTip | null {
  const path = pr.lineage_tip_path;
  const ref = pr.lineage_tip_ref;
  const sha = pr.lineage_tip_sha;
  const ahead = pr.lineage_tip_ahead;
  if (!path || !ref || !sha || !ahead || ahead <= 0) return null;
  return fileExists(path) ? { path, ref, sha, ahead } : null;
}

/** Per-file segments of a unified diff, keyed by new-side path. */
export function diffSections(diff: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of diff.split(/^(?=diff --git )/m)) {
    const m = /^diff --git a\/.* b\/(.+)$/m.exec(part);
    if (m && !map.has(m[1])) map.set(m[1], part);
  }
  return map;
}

export interface DiffEvidence {
  excerpts: string[];
  /**
   * Anchors left without an excerpt (no line, outside every hunk, or over the
   * byte budget), as `file:line` labels, so the finalizer knows which findings
   * it cannot check against the saved comparison.
   */
  missing: string[];
}

const MAX_EXCERPT_BYTES = 8 * 1024;
const MAX_EVIDENCE_BYTES = 16 * 1024;
/** Context lines kept on each side of the anchor when a whole hunk will not fit. */
const WINDOW_CONTEXT = [40, 20, 10, 5, 0];
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/;
const SEVERITY_RANK: Record<FindingSeverity, number> = { blocking: 0, serious: 1, moderate: 2, optional: 3 };

type EvidenceAnchor = Pick<Finding, "file" | "line" | "side"> & { severity?: FindingSeverity };

function anchorLabel({ file, line, side }: EvidenceAnchor): string {
  if (line === null) return `${file} (no line)`;
  return side === "LEFT" ? `${file}:${line} (old side)` : `${file}:${line}`;
}

/** Evidence for when no saved comparison exists: every anchor is missing. */
export function noDiffEvidence(findings: readonly EvidenceAnchor[]): DiffEvidence {
  return { excerpts: [], missing: [...new Set(findings.map(anchorLabel))] };
}

interface HunkLine { text: string; kind: " " | "-" | "+"; old: number; new: number }
interface ParsedHunk { raw: string; suffix: string; lines: HunkLine[] }
type LineRange = [number, number];

function parseHunk(raw: string): ParsedHunk | null {
  const m = HUNK_HEADER.exec(raw);
  if (!m) return null;
  // A zero-count side's start names the line *before* the hunk.
  let oldNo = Number(m[1]) + (m[2] === "0" ? 1 : 0);
  let newNo = Number(m[3]) + (m[4] === "0" ? 1 : 0);
  const body = raw.slice(raw.indexOf("\n") + 1).split("\n");
  if (body.at(-1) === "") body.pop();
  const lines: HunkLine[] = [];
  for (const text of body) {
    if (text.startsWith("\\")) {
      // "\ No newline at end of file" belongs to the line before it.
      if (lines.length) lines[lines.length - 1].text += "\n" + text;
      continue;
    }
    const kind = text[0] === "-" || text[0] === "+" ? text[0] : " ";
    lines.push({ text, kind, old: oldNo, new: newNo });
    if (kind !== "+") oldNo++;
    if (kind !== "-") newNo++;
  }
  return { raw, suffix: m[5], lines };
}

function anchorIndex(hunk: ParsedHunk, line: number, side: "LEFT" | "RIGHT"): number {
  return hunk.lines.findIndex((l) =>
    side === "LEFT" ? l.kind !== "+" && l.old === line : l.kind !== "-" && l.new === line);
}

/** The hunk cut to `context` lines around `index`, with a header that matches the cut. */
function hunkWindow(
  hunk: ParsedHunk, index: number, context: number,
): { text: string; left: LineRange; right: LineRange } {
  const from = Math.max(0, index - context);
  const to = Math.min(hunk.lines.length, index + context + 1);
  const slice = hunk.lines.slice(from, to);
  const oldCount = slice.filter((l) => l.kind !== "+").length;
  const newCount = slice.filter((l) => l.kind !== "-").length;
  const left: LineRange = [slice[0].old, slice[0].old + oldCount - 1];
  const right: LineRange = [slice[0].new, slice[0].new + newCount - 1];
  if (from === 0 && to === hunk.lines.length) return { text: hunk.raw, left, right };
  const range = (start: number, count: number) =>
    count === 1 ? `${start}` : `${count === 0 ? start - 1 : start},${count}`;
  const header = `@@ -${range(slice[0].old, oldCount)} +${range(slice[0].new, newCount)} @@${hunk.suffix}`;
  return { text: [header, ...slice.map((l) => l.text)].join("\n") + "\n", left, right };
}

/**
 * Hunks at candidate anchors, including the lines that were removed.
 *
 * Anchors are served most-severe first so the byte budget goes to the findings
 * that matter. A hunk too large for what is left of the budget (a new file is
 * one hunk) is cut to a window around the anchor rather than dropped.
 */
export function findingDiffEvidence(diff: string, findings: readonly EvidenceAnchor[]): DiffEvidence {
  const rightSections = diffSections(diff);
  const leftSections = new Map<string, string>();
  for (const section of rightSections.values()) {
    const oldPath = /^--- a\/(.+)$/m.exec(section)?.[1].trimEnd();
    if (oldPath) leftSections.set(oldPath, section);
  }
  const rank = (f: EvidenceAnchor) => SEVERITY_RANK[f.severity ?? "moderate"];
  const ordered = [...findings].sort((a, b) => rank(a) - rank(b));

  const excerpts: string[] = [];
  const shown: { section: string; left: LineRange; right: LineRange }[] = [];
  const missing = new Set<string>();
  let bytes = 0;
  for (const finding of ordered) {
    const { file, line, side } = finding;
    const section = (side === "LEFT" ? leftSections : rightSections).get(file);
    if (!section || line === null) {
      missing.add(anchorLabel(finding));
      continue;
    }
    const alreadyShown = shown.some((s) => {
      const [lo, hi] = side === "LEFT" ? s.left : s.right;
      return s.section === section && line >= lo && line <= hi;
    });
    if (alreadyShown) continue;

    const [headers, ...hunkTexts] = section.split(/^(?=@@ )/m);
    let found: { hunk: ParsedHunk; index: number } | undefined;
    for (const text of hunkTexts) {
      const hunk = parseHunk(text);
      const index = hunk ? anchorIndex(hunk, line, side) : -1;
      if (hunk && index >= 0) {
        found = { hunk, index };
        break;
      }
    }
    if (!found) {
      missing.add(anchorLabel(finding));
      continue;
    }

    const separator = excerpts.length > 0 ? 1 : 0;
    let picked = false;
    for (const context of [Infinity, ...WINDOW_CONTEXT]) {
      const window = hunkWindow(found.hunk, found.index, context);
      const excerpt = headers + window.text;
      const size = Buffer.byteLength(excerpt);
      if (size > MAX_EXCERPT_BYTES || bytes + separator + size > MAX_EVIDENCE_BYTES) continue;
      excerpts.push(excerpt);
      shown.push({ section, left: window.left, right: window.right });
      bytes += separator + size;
      picked = true;
      break;
    }
    if (!picked) missing.add(anchorLabel(finding));
  }
  return { excerpts, missing: [...missing] };
}
