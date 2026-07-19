// Parse a unified diff → per-file set of new-side (RIGHT) line numbers that
// appear in a hunk (added or context). GitHub only accepts inline comments on
// lines present in the diff.
export function anchorableLines(diff: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  let file: string | null = null;
  let newLine = 0;
  let remaining = 0; // new-side lines left in the current hunk

  for (const raw of diff.split("\n")) {
    if (remaining > 0) {
      // Inside a hunk: classify strictly by the leading diff marker.
      if (raw.startsWith("+") || raw.startsWith(" ")) {
        if (file !== null) map.get(file)!.add(newLine);
        newLine++;
        remaining--;
      }
      // '-' (removed) consumes an old-side line only; '\ No newline' etc. ignored.
      continue;
    }
    // Between hunks: structural lines only.
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      remaining = hunk[2] === undefined ? 1 : Number(hunk[2]); // omitted count = 1
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      if (file && !map.has(file)) map.set(file, new Set());
    }
    // '--- ', 'diff --git', 'index …' etc. ignored between hunks.
  }
  return map;
}

export function isAnchorable(
  map: Map<string, Set<number>>,
  file: string,
  line: number | null,
  side: "LEFT" | "RIGHT",
): boolean {
  if (side !== "RIGHT" || line === null) return false;
  return map.get(file)?.has(line) ?? false;
}
