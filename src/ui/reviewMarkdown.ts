import type { PrRecord, StoredFinding, UserComment } from "../shared/types.ts";

function parseJsonList(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

const GOAL_VERDICT_TEXT: Record<string, string> = {
  achieves: "achieves the goal",
  partially: "partially achieves the goal",
  "does-not": "does not achieve the goal",
  unclear: "goal unclear",
};

/**
 * Render one PR's full review as a self-contained markdown brief — everything a
 * CLI agent (or human) needs to pick up where the review left off, minus the
 * diff itself (the checkout hint at the bottom covers that).
 */
export function buildReviewMarkdown(
  pr: PrRecord,
  findings: StoredFinding[],
  comments: UserComment[] = [],
): string {
  const lines: string[] = [];
  const reasons = parseJsonList(pr.danger_reasons);
  const flags = parseJsonList(pr.danger_flags);
  const focus = parseJsonList(pr.focus_areas);
  const gaps = parseJsonList(pr.goal_gaps);

  lines.push(`# Code review: ${pr.title ?? `PR #${pr.number}`} (${pr.owner}/${pr.repo}#${pr.number})`);
  lines.push("");
  lines.push(`- PR: ${pr.url}`);
  if (pr.author) lines.push(`- Author: ${pr.author}`);
  if (pr.additions != null || pr.deletions != null) {
    lines.push(`- Size: +${pr.additions ?? 0}/-${pr.deletions ?? 0} across ${pr.changed_files ?? "?"} file(s)`);
  }
  if (pr.head_sha) lines.push(`- Reviewed at commit \`${pr.head_sha}\`${pr.base_sha ? ` (merge-base \`${pr.base_sha.slice(0, 12)}\`)` : ""}`);
  if (pr.danger_level) lines.push(`- Danger: **${pr.danger_level}**${flags.length ? ` — flags: ${flags.join(", ")}` : ""}`);
  lines.push("");
  lines.push("This is the output of an automated multi-model review (review-deck). Treat the findings");
  lines.push("as leads to verify against the code, not ground truth.");

  if (pr.goal) {
    lines.push("", "## Goal", "", pr.goal);
    if (pr.goal_verdict) {
      lines.push("", `**Verdict:** ${GOAL_VERDICT_TEXT[pr.goal_verdict] ?? pr.goal_verdict}${pr.goal_explanation ? ` — ${pr.goal_explanation}` : ""}`);
    }
    if (gaps.length > 0) {
      lines.push("", "**Gaps / out-of-scope:**");
      for (const g of gaps) lines.push(`- ${g}`);
    }
  }

  if (pr.review_verdict) lines.push("", "## Bottom line", "", pr.review_verdict);
  if (pr.summary) lines.push("", "## Summary", "", pr.summary);

  if (reasons.length > 0) {
    lines.push("", `## Why the ${pr.danger_level ?? ""} rating`.replace("  ", " "), "");
    for (const r of reasons) lines.push(`- ${r}`);
  }

  if (focus.length > 0) {
    lines.push("", "## Focus areas", "");
    for (const f of focus) lines.push(`- ${f}`);
  }

  if (findings.length > 0) {
    lines.push("", `## Findings (${findings.length})`);
    findings.forEach((f, i) => {
      const loc = f.line !== null ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
      const tags = [
        f.impact ? `impact: ${f.impact}` : null,
        f.severity,
        f.engine,
        f.agreement ? "cross-model agreement" : null,
        f.theme ? `theme: ${f.theme}` : null,
        !f.selected ? "deselected by reviewer" : null,
      ].filter(Boolean).join(" · ");
      lines.push("", `### ${i + 1}. ${loc} — ${f.what}`, "", `_${tags}_`);
      if (f.why?.trim()) lines.push("", f.why.trim());
      if (f.suggestedFix?.trim()) lines.push("", `**Suggested fix:** ${f.suggestedFix.trim()}`);
    });
  }

  const notable = comments.filter((c) => c.body.trim());
  if (notable.length > 0) {
    lines.push("", `## Reviewer's own comments (${notable.length})`);
    for (const c of notable) {
      lines.push("", `- \`${c.file}${c.line !== null ? `:${c.line}` : ""}\` — ${c.body.trim()}${c.posted ? " _(posted)_" : ""}`);
    }
  }

  lines.push(
    "", "---", "",
    `To get the code: \`gh pr checkout ${pr.number} --repo ${pr.owner}/${pr.repo}\``,
    ...(pr.head_sha ? [`To pin to the reviewed revision: \`git checkout ${pr.head_sha}\``] : []),
    `To see the diff: \`gh pr diff ${pr.number} --repo ${pr.owner}/${pr.repo}\``,
  );

  return lines.join("\n");
}
