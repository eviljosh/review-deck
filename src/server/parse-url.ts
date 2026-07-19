const RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export function parsePrUrl(url: string): {
  owner: string;
  repo: string;
  number: number;
} {
  const m = RE.exec(url.trim());
  if (!m) throw new Error(`not a GitHub PR URL: ${url}`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}
