import type { StoredFinding, UserComment } from "../shared/types.ts";

// Default disclosure line; the effective marker is configurable in settings
// (review_config.robotMarker) and passed into buildReviewPayload.
export const ROBOT_MARKER =
  "🤖 The rest of this review is AI-generated — an automated review posted at the reviewer's request. It is not a human review.";

// Invisible HTML comment appended to everything we post, so a later triage of
// the same PR can recognize (and skip) our own output when it re-reads the
// discussion. Rendered markdown hides it completely.
export const BOT_SENTINEL = "<!-- review-deck:automated -->";

// True when a PR comment/review body was produced by this tool — either it
// carries the sentinel, or it matches the marker text from before the sentinel
// existed (legacy posts).
export function isBotAuthored(body: string): boolean {
  return (
    body.includes(BOT_SENTINEL) ||
    body.includes("The rest of this review is Claude-generated") ||
    body.includes("The rest of this review is AI-generated")
  );
}

function findingHeader(f: StoredFinding): string {
  const tag = f.agreement ? `${f.engine} 🤝` : f.engine;
  const loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
  return `**[${f.severity}]** ${loc} · _${tag}_`;
}

// Render a finding as several markdown paragraphs (header · what · why · fix)
// separated by blank lines, so GitHub shows readable, logically-broken-up text
// instead of one dense run-on line. what/why/fix are already markdown.
// A reviewer note, when present, leads in the reviewer's own voice with a
// disclaimer separating it from the AI-generated remainder.
function renderFinding(f: StoredFinding): string {
  const parts: string[] = [];
  if (f.reviewerNote?.trim()) {
    parts.push(f.reviewerNote.trim());
    parts.push("🤖 _AI-generated below this line:_");
  }
  parts.push(findingHeader(f));
  if (f.what?.trim()) parts.push(f.what.trim());
  if (f.why?.trim()) parts.push(f.why.trim());
  if (f.suggestedFix?.trim()) parts.push(`**Suggested fix:** ${f.suggestedFix.trim()}`);
  return parts.join("\n\n");
}

export function buildReviewPayload(
  preface: string,
  findings: StoredFinding[],
  marker: string = ROBOT_MARKER,
  userComments: UserComment[] = [],
): { body: string; comments: { path: string; line: number; side: "LEFT" | "RIGHT"; body: string }[] } {
  const selected = findings.filter((f) => f.selected);
  const inline = selected.filter((f) => f.anchorable && f.line !== null);
  const bodyFindings = selected.filter((f) => !f.anchorable || f.line === null);

  // The reviewer's own comments post verbatim, without the bot sentinel — they
  // are human-authored and should read (and later be re-ingested) as such.
  const anchoredUser = userComments.filter((c) => c.line !== null && c.body.trim());
  const bodyUser = userComments.filter((c) => c.line === null && c.body.trim());

  const comments = [
    ...anchoredUser.map((c) => ({
      path: c.file,
      line: c.line as number,
      side: c.side,
      body: c.body.trim(),
    })),
    ...inline.map((f) => ({
      path: f.file,
      line: f.line as number,
      side: f.side,
      body: `${renderFinding(f)}\n\n${BOT_SENTINEL}`,
    })),
  ];

  const parts = preface.trim() ? [preface.trim()] : [];
  if (bodyUser.length > 0) {
    parts.push(bodyUser.map((c) => `**Note on \`${c.file}\`:** ${c.body.trim()}`).join("\n\n"));
  }
  parts.push(marker);
  if (bodyFindings.length > 0) {
    parts.push("### Additional findings (not anchored to a diff line)");
    // Each finding is its own multi-paragraph block, separated by a rule so they
    // don't blur together.
    parts.push(bodyFindings.map(renderFinding).join("\n\n---\n\n"));
  }
  parts.push(BOT_SENTINEL);
  return { body: parts.join("\n\n"), comments };
}
