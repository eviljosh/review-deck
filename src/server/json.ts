import type { ZodType } from "zod";

export function parseAgentJson<T>(
  raw: string,
  schema: ZodType<T>,
): { ok: true; value: T } | { ok: false; error: string } {
  for (const candidate of jsonObjectCandidates(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = schema.safeParse(parsed);
    if (result.success) return { ok: true, value: result.data };
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
