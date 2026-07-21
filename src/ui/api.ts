import type { ChatMessage, GhConversation, PrRecord, ReviewEvent, RunRecord, StoredFinding, UserComment } from "../shared/types.ts";

export interface DimensionDef { key: string; guidance: string }
export interface RiskFlagDef { key: string; description: string }
export interface ReviewSettings {
  engines: { claude: boolean; codex: boolean };
  dimensions: DimensionDef[];
  riskFlags: RiskFlagDef[];
  finalizerEngine: "claude" | "codex";
  maxConcurrentReviews: number;
  maxConcurrentPipelines: number;
  claudeModel: string;
  codexModel?: string;
  codexReasoningEffort?: string;
  engineTimeoutMs: number;
  robotMarker: string;
  feedbackLoop: boolean;
}
export interface RepoConfig {
  id: number;
  owner: string;
  repo: string;
  guidance: string;
  dimensions: string | null;
  risk_flags: string | null;
}

export async function listPrs(): Promise<PrRecord[]> {
  const res = await fetch("/api/prs");
  return res.json();
}

export async function createPrs(urls: string[]): Promise<{ created: PrRecord[]; existing: PrRecord[] }> {
  const res = await fetch("/api/prs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ urls }),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  return res.json();
}

export async function retryPr(id: number): Promise<void> {
  const res = await fetch(`/api/prs/${id}/retry`, { method: "POST" });
  if (!res.ok) throw new Error(`retry failed: ${res.status}`);
}

export async function cancelPr(id: number): Promise<void> {
  const res = await fetch(`/api/prs/${id}/cancel`, { method: "POST" });
  if (!res.ok) throw new Error(`cancel failed: ${res.status}`);
}

export async function deletePr(id: number): Promise<void> {
  const res = await fetch(`/api/prs/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed: ${res.status}`);
}

export async function archivePr(id: number): Promise<void> {
  const res = await fetch(`/api/prs/${id}/archive`, { method: "POST" });
  if (!res.ok) throw new Error(`archive failed: ${res.status}`);
}

export async function unarchivePr(id: number): Promise<void> {
  const res = await fetch(`/api/prs/${id}/unarchive`, { method: "POST" });
  if (!res.ok) throw new Error(`unarchive failed: ${res.status}`);
}

export async function purgeArchived(): Promise<{ deleted: number; olderThanDays: number }> {
  const res = await fetch("/api/prs/purge-archived", { method: "POST" });
  if (!res.ok) throw new Error(`purge failed: ${res.status}`);
  return res.json();
}

export async function markSeen(id: number): Promise<void> {
  await fetch(`/api/prs/${id}/seen`, { method: "POST" });
}

export interface PrRemoteStatus {
  state: string;
  mergeable: string;
  reviewDecision: string;
  checks: string;
  headSha: string;
}
export async function refreshStatus(id: number): Promise<PrRemoteStatus> {
  const res = await fetch(`/api/prs/${id}/refresh-status`, { method: "POST" });
  if (!res.ok) throw new Error(`refresh failed: ${res.status}`);
  return (await res.json()).status;
}

export async function getFindings(id: number): Promise<StoredFinding[]> {
  const res = await fetch(`/api/prs/${id}/findings`);
  if (!res.ok) return [];
  return res.json();
}

export async function getDefaultPreface(): Promise<string> {
  const res = await fetch("/api/preface"); if (!res.ok) return ""; return (await res.json()).default ?? "";
}
export async function setDefaultPreface(preface: string): Promise<void> {
  await fetch("/api/preface", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ preface }) });
}
export async function setPrPreface(id: number, preface: string): Promise<void> {
  await fetch(`/api/prs/${id}/preface`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ preface }) });
}
export async function setFindingSelected(prId: number, fid: number, selected: boolean): Promise<void> {
  await fetch(`/api/prs/${prId}/findings/${fid}/select`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selected }) });
}
export async function setAllFindingsSelected(prId: number, selected: boolean): Promise<void> {
  await fetch(`/api/prs/${prId}/findings/select-all`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selected }) });
}
export async function updateFinding(
  prId: number,
  fid: number,
  patch: { what?: string; why?: string; suggestedFix?: string; reviewerNote?: string | null },
): Promise<StoredFinding> {
  const res = await fetch(`/api/prs/${prId}/findings/${fid}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`finding update failed: ${res.status}`);
  return res.json();
}
export async function postReview(id: number, event: ReviewEvent = "COMMENT"): Promise<{ ok: boolean; stage?: string; error?: string }> {
  const res = await fetch(`/api/prs/${id}/post`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event }),
  });
  return res.json();
}
export async function getConversation(id: number): Promise<GhConversation> {
  const res = await fetch(`/api/prs/${id}/conversation`);
  if (!res.ok) return { threads: [], overall: [] };
  return res.json();
}
export async function replyToConversation(id: number, body: string, inReplyTo?: number): Promise<void> {
  const res = await fetch(`/api/prs/${id}/conversation/reply`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body, inReplyTo }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? `reply failed: ${res.status}`);
}
export async function getRuns(id: number): Promise<RunRecord[]> {
  const res = await fetch(`/api/prs/${id}/runs`);
  if (!res.ok) return [];
  return res.json();
}

export interface RunOutput {
  stage: string;
  status: string;
  error: string | null;
  output: string | null;
}
export async function getRunOutput(prId: number, rid: number): Promise<RunOutput> {
  const res = await fetch(`/api/prs/${prId}/runs/${rid}/output`);
  if (!res.ok) throw new Error(`run output failed: ${res.status}`);
  return res.json();
}

export async function getFileContent(prId: number, path: string): Promise<string> {
  const res = await fetch(`/api/prs/${prId}/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`file load failed: ${res.status}`);
  return (await res.json()).content ?? "";
}

export async function getDiff(id: number): Promise<string> {
  const res = await fetch(`/api/prs/${id}/diff`);
  if (!res.ok) throw new Error(`diff load failed: ${res.status}`);
  return (await res.json()).diff ?? "";
}
export async function listComments(id: number): Promise<UserComment[]> {
  const res = await fetch(`/api/prs/${id}/comments`);
  if (!res.ok) return [];
  return res.json();
}
export async function addComment(
  id: number,
  c: { file: string; line: number | null; side?: "LEFT" | "RIGHT"; body: string },
): Promise<UserComment> {
  const res = await fetch(`/api/prs/${id}/comments`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c),
  });
  if (!res.ok) throw new Error(`comment failed: ${res.status}`);
  return res.json();
}
export async function removeComment(id: number, cid: number): Promise<void> {
  const res = await fetch(`/api/prs/${id}/comments/${cid}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete comment failed: ${res.status}`);
}
export async function updateComment(id: number, cid: number, body: string): Promise<UserComment> {
  const res = await fetch(`/api/prs/${id}/comments/${cid}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`comment update failed: ${res.status}`);
  return res.json();
}

export async function getChatHistory(id: number): Promise<ChatMessage[]> {
  const res = await fetch(`/api/prs/${id}/chat`);
  if (!res.ok) return [];
  return res.json();
}
export async function sendChatMessage(id: number, message: string): Promise<{ ok?: boolean; error?: string }> {
  const res = await fetch(`/api/prs/${id}/chat`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }),
  });
  return res.json();
}
export async function clearChat(id: number): Promise<void> {
  await fetch(`/api/prs/${id}/chat`, { method: "DELETE" });
}

export async function getSettings(): Promise<ReviewSettings> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error(`settings load failed: ${res.status}`);
  return res.json();
}
export async function putSettings(patch: Partial<ReviewSettings>): Promise<ReviewSettings> {
  const res = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  if (!res.ok) throw new Error(`settings save failed: ${res.status}`);
  return res.json();
}
export async function listRepoConfigs(): Promise<RepoConfig[]> {
  const res = await fetch("/api/repos");
  if (!res.ok) return [];
  return res.json();
}
export async function putRepoConfig(
  owner: string,
  repo: string,
  patch: { guidance?: string; dimensions?: string | null; riskFlags?: string | null },
): Promise<RepoConfig> {
  const res = await fetch(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`repo config save failed: ${res.status}`);
  return res.json();
}
