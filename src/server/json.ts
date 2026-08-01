import type { ZodType } from "zod";

export function parseAgentJson<T>(
  raw: string,
  schema: ZodType<T>,
): { ok: true; value: T } | { ok: false; error: string } {
  for (const candidates of [jsonObjectCandidates(raw), repairedCandidates(raw)]) {
    for (const candidate of candidates) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        continue;
      }
      const result = schema.safeParse(parsed);
      if (result.success) return { ok: true, value: result.data };
    }
  }
  return { ok: false, error: "no JSON object matching the schema found in agent output" };
}

// Yield every balanced {...} substring, starting at each '{' in the text, so a
// stray/template/prose brace before the real payload doesn't hide it.
function* jsonObjectCandidates(raw: string): Generator<string> {
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    const end = matchBalanced(raw, start);
    if (end !== -1) yield raw.slice(start, end + 1);
  }
}

// Fallback for truncated output: a model that stops mid-structure (or just
// miscounts) usually omits only trailing closers. Rebuild them from the
// open-bracket stack and let the schema gate the result — this recovers the
// "missing final brace" failure without ever accepting garbage.
function* repairedCandidates(raw: string): Generator<string> {
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    let mismatched = false;
    for (let i = start; i < raw.length && !mismatched && !(stack.length === 0 && i > start); i++) {
      const ch = raw[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") stack.push("}");
      else if (ch === "[") stack.push("]");
      else if (ch === "}" || ch === "]") {
        if (stack[stack.length - 1] !== ch) mismatched = true;
        else stack.pop();
      }
    }
    // Balanced candidates were already tried by the main path; only yield when
    // the structure ran off the end of the text still open.
    if (!mismatched && stack.length > 0) {
      yield raw.slice(start) + (inString ? '"' : "") + stack.reverse().join("");
    }
  }
}

// Index of the '}' that closes the '{' at `start`, or -1 if never balanced.
// String- and escape-aware so braces inside string values don't miscount.
function matchBalanced(raw: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
