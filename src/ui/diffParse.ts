// Client-side unified-diff parser for the walkthrough diff viewer. Mirrors the
// server's diff-anchor semantics: RIGHT line numbers come from hunk headers and
// advance on '+' and context lines.

export interface DiffLine {
  kind: "context" | "add" | "del" | "hunk";
  oldNo: number | null;
  newNo: number | null;
  text: string; // without the leading diff marker (hunk lines keep the @@ header)
}

export interface DiffFile {
  path: string;        // new path (b/), or old path for deletions
  oldPath: string | null;
  status: "modified" | "added" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  const strip = (p: string) => p.replace(/^[ab]\//, "");

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      file = null; // headers follow; created on --- / +++
      inHunk = false;
      continue;
    }
    if (raw.startsWith("--- ")) {
      const p = raw.slice(4).trim();
      file = {
        path: "", oldPath: p === "/dev/null" ? null : strip(p),
        status: "modified", additions: 0, deletions: 0, lines: [],
      };
      inHunk = false;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      if (!file) continue;
      const p = raw.slice(4).trim();
      if (p === "/dev/null") {
        file.path = file.oldPath ?? "";
        file.status = "deleted";
      } else {
        file.path = strip(p);
        if (file.oldPath === null) file.status = "added";
        else if (file.oldPath !== file.path) file.status = "renamed";
      }
      files.push(file);
      continue;
    }
    if (!file) continue;

    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      file.lines.push({ kind: "hunk", oldNo: null, newNo: null, text: raw });
      continue;
    }
    if (!inHunk) continue;

    if (raw.startsWith("+")) {
      file.lines.push({ kind: "add", oldNo: null, newNo, text: raw.slice(1) });
      file.additions++;
      newNo++;
    } else if (raw.startsWith("-")) {
      file.lines.push({ kind: "del", oldNo, newNo: null, text: raw.slice(1) });
      file.deletions++;
      oldNo++;
    } else if (raw.startsWith(" ") || raw === "") {
      file.lines.push({ kind: "context", oldNo, newNo, text: raw.slice(1) });
      oldNo++;
      newNo++;
    }
    // '\ No newline at end of file' etc. ignored
  }
  return files.filter((f) => f.path);
}
