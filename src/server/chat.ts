import { join } from "node:path";
import type Database from "better-sqlite3";
import type { LlmEngine } from "./engines/types.ts";
import type { WsHub } from "./ws.ts";
import type { PrRecord, StoredFinding } from "../shared/types.ts";
import { getPr, listFindings, listChatMessages, insertChatMessage } from "./db.ts";
import { stageArtifactDir } from "./artifacts.ts";
import { PROMPT_INJECTION_GUARD } from "./prompts.ts";
import type { EngineModelOptions } from "./review-config.ts";

// Keep the prompt bounded: only the most recent turns go into context.
const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_CHARS = 24_000;

function findingLine(f: StoredFinding): string {
  const loc = f.line ? `${f.file}:${f.line}` : f.file;
  return `- [${f.severity}${f.impact ? `/${f.impact}` : ""}] ${loc} — ${f.what}`;
}

export function buildChatSystemPrompt(pr: PrRecord, findings: StoredFinding[], diffPath: string): string {
  return [
    PROMPT_INJECTION_GUARD, "",
    "You are pair-reviewing a GitHub pull request with a human reviewer. Answer their questions",
    "about this PR: what the code does, whether a concern is real, how pieces connect, what to",
    "check next. Be concrete and concise; cite files/lines in `backticks`. If you are unsure,",
    "read the code before answering.",
    "",
    "Your working directory is a checkout of the PR's head commit — you may Read/Grep/Glob it.",
    `The exact reviewed diff is at: ${diffPath}`,
    "Do not modify anything. Answer in GitHub-flavored markdown.",
    "",
    `PR: #${pr.number} "${pr.title ?? ""}" by ${pr.author ?? "?"} (${pr.owner}/${pr.repo})`,
    ...(pr.goal ? [`Goal: ${pr.goal}`] : []),
    ...(pr.goal_verdict ? [`Triage's goal verdict: ${pr.goal_verdict}`] : []),
    ...(pr.summary ? [`Summary: ${pr.summary}`] : []),
    ...(pr.review_verdict ? [`Review bottom line: ${pr.review_verdict}`] : []),
    ...(findings.length > 0
      ? ["", `Findings from the automated review (${findings.length}):`, ...findings.map(findingLine)]
      : []),
  ].join("\n");
}

export interface ChatDeps {
  db: Database.Database;
  engine: LlmEngine;
  dataDir: string;
  hub: WsHub;
  modelOptions?: EngineModelOptions;
  timeoutMs?: number;
}

/**
 * One chat turn: persist the user message, stream the assistant's answer over
 * the hub (chat_chunk → chat_done / chat_error), persist the final answer.
 * The caller is responsible for serializing turns per PR.
 */
export async function runChatTurn(deps: ChatDeps, prId: number, message: string): Promise<void> {
  const { db, engine, dataDir, hub } = deps;
  const pr = getPr(db, prId);
  if (!pr) throw new Error(`pr ${prId} not found`);

  insertChatMessage(db, prId, "user", message);
  const findings = listFindings(db, prId);
  const diffPath = join(stageArtifactDir(dataDir, prId, "prepare"), "diff.patch");
  const system = buildChatSystemPrompt(pr, findings, diffPath);

  // Rebuild the conversation as a transcript (bounded), newest last.
  const history = listChatMessages(db, prId).slice(-MAX_HISTORY_MESSAGES);
  let transcript = history
    .map((m) => `${m.role === "user" ? "Reviewer" : "You"}: ${m.content}`)
    .join("\n\n");
  if (transcript.length > MAX_HISTORY_CHARS) transcript = transcript.slice(-MAX_HISTORY_CHARS);
  const prompt = [
    "Conversation so far (you are \"You\"):", "", transcript, "",
    "Reply to the reviewer's last message.",
  ].join("\n");

  try {
    const res = await engine.run(
      {
        system, prompt,
        workdir: pr.worktree_path ?? dataDir,
        ...(deps.modelOptions ?? {}),
        maxTurns: 25,
        timeoutMs: deps.timeoutMs,
      },
      (chunk) => hub.broadcast({ type: "chat_chunk", prId, chunk }),
    );
    const answer = res.text.trim() || "(no answer)";
    insertChatMessage(db, prId, "assistant", answer);
    hub.broadcast({ type: "chat_done", prId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    hub.broadcast({ type: "chat_error", prId, error: msg });
    throw err;
  }
}
