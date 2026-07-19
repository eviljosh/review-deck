// Minimal Linear integration: find issue references in PR text and fetch their
// title/description/state via Linear's GraphQL API. Read-only, best-effort — used
// to give the triage summary the "what problem is this solving" context.
//
// Auth: a personal API key in LINEAR_API_KEY (Linear → Settings → Security &
// access → Personal API keys). Passed directly in the Authorization header (no
// "Bearer" prefix), per Linear's API.

export interface LinearIssue {
  identifier: string;
  title: string;
  description: string;
  state: string;
  url: string;
}

const LINEAR_URL_RE = /linear\.app\/[^\s/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/gi;
const BARE_ID_RE = /\b([A-Z]{2,}-\d+)\b/g;

// Common technical tokens that match the bare TEAM-123 shape but are never
// Linear issues (UTF-8, SHA-256, RFC-7231, …). Without this, junk matches can
// fill the id cap and crowd out the real ticket.
const NON_TICKET_PREFIXES = new Set([
  "UTF", "SHA", "ISO", "RFC", "CVE", "AES", "RSA", "TLS", "SSL",
  "GPT", "CRC", "MD", "IPV", "HTTP", "OAUTH", "UUID", "ASCII", "IEEE",
]);

/**
 * Extract Linear issue identifiers (e.g. "ENG-1234") from arbitrary PR text —
 * both linear.app issue URLs and bare identifiers. Deduped, URLs first, capped.
 */
export function extractLinearIssueIds(text: string, max = 3): string[] {
  const ids: string[] = [];
  const add = (id: string) => {
    const up = id.toUpperCase();
    if (!ids.includes(up)) ids.push(up);
  };
  for (const m of text.matchAll(LINEAR_URL_RE)) add(m[1]);
  for (const m of text.matchAll(BARE_ID_RE)) {
    if (!NON_TICKET_PREFIXES.has(m[1].split("-")[0])) add(m[1]);
  }
  return ids.slice(0, max);
}

type FetchFn = typeof fetch;

/** Fetch one Linear issue by identifier. Returns null on any error / not found. */
export async function fetchLinearIssue(
  id: string,
  apiKey: string,
  fetchImpl: FetchFn = fetch,
): Promise<LinearIssue | null> {
  const query = `query Issue($id: String!) {
    issue(id: $id) { identifier title description url state { name } }
  }`;
  try {
    const res = await fetchImpl("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: apiKey },
      body: JSON.stringify({ query, variables: { id } }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { issue?: { identifier: string; title: string; description?: string; url: string; state?: { name?: string } } };
    };
    const issue = json.data?.issue;
    if (!issue) return null;
    return {
      identifier: issue.identifier,
      title: issue.title,
      description: (issue.description ?? "").trim(),
      state: issue.state?.name ?? "",
      url: issue.url,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve every Linear issue referenced in `text` into a compact markdown block
 * for the triage prompt. Returns "" when no key is configured, nothing is
 * referenced, or nothing resolves.
 */
export async function fetchLinearContext(
  text: string,
  apiKey: string | undefined,
  fetchImpl: FetchFn = fetch,
): Promise<string> {
  if (!apiKey) return "";
  const ids = extractLinearIssueIds(text);
  if (ids.length === 0) return "";
  const issues = (await Promise.all(ids.map((id) => fetchLinearIssue(id, apiKey, fetchImpl)))).filter(
    (i): i is LinearIssue => i !== null,
  );
  if (issues.length === 0) return "";
  const CAP = 4000; // bound each description
  return issues
    .map((i) => {
      const desc = i.description.length > CAP ? i.description.slice(0, CAP) + "\n…(truncated)" : i.description;
      return `### ${i.identifier} — ${i.title} (${i.state})\n${i.url}\n\n${desc || "(no description)"}`;
    })
    .join("\n\n");
}
