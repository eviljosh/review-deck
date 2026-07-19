import { useEffect, useRef, useState } from "react";
import type { ChatMessage, PrRecord } from "../shared/types.ts";
import { clearChat, getChatHistory, sendChatMessage } from "./api.ts";
import type { ChatStream } from "./useLivePrs.ts";
import { Md } from "./bits.tsx";

/**
 * Live chat about one PR. The assistant runs with the PR's worktree, pinned
 * diff, triage, and findings as context; answers stream over the WebSocket
 * (chat state arrives via the `stream` prop from useLivePrs).
 */
export function ChatPane({ pr, stream }: { pr: PrRecord; stream: ChatStream | undefined }) {
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const streaming = stream?.streaming ?? "";
  const bump = stream?.bump ?? 0;

  useEffect(() => {
    getChatHistory(pr.id).then(setHistory).catch(() => {});
    setSending(false);
  }, [pr.id, bump]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, streaming]);

  async function send() {
    const message = input.trim();
    if (!message || sending) return;
    setSending(true);
    setInput("");
    // Optimistic echo of the user message; the server copy arrives on bump.
    setHistory((h) => [...h, { id: -Date.now(), pr_id: pr.id, role: "user", content: message, created_at: "" }]);
    const r = await sendChatMessage(pr.id, message).catch((e) => ({ error: String(e) }));
    if (r.error) {
      alert(r.error);
      setSending(false);
    }
  }

  const busy = sending || streaming.length > 0;

  return (
    <div className="chat-pane">
      <div className="chat-head">
        <span>💬 Ask about this PR</span>
        {history.length > 0 && (
          <button
            className="btn btn-sm btn-ghost"
            title="Clear chat history"
            onClick={() => clearChat(pr.id).then(() => setHistory([])).catch(() => {})}
          >
            clear
          </button>
        )}
      </div>
      <div className="chat-scroll" ref={scrollRef}>
        {history.length === 0 && !streaming && (
          <div className="chat-empty">
            Ask anything — “is finding #2 actually reachable?”, “walk me through the migration”,
            “what calls this function?”. The assistant can read the PR's checkout.
          </div>
        )}
        {history.map((m) => (
          <div key={m.id} className={`chat-msg chat-${m.role}`}>
            <Md>{m.content}</Md>
          </div>
        ))}
        {streaming && (
          <div className="chat-msg chat-assistant chat-streaming">
            <Md>{streaming}</Md>
          </div>
        )}
        {busy && !streaming && <div className="chat-thinking">thinking…</div>}
        {stream?.error && <div className="error-banner">{stream.error}</div>}
      </div>
      <div className="chat-input-row">
        <textarea
          value={input}
          placeholder="Ask about this PR… (↵ to send, shift-↵ for newline)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
            e.stopPropagation(); // don't trigger app-level j/k/esc shortcuts
          }}
        />
        <button className="btn btn-sm btn-primary" disabled={!input.trim() || busy} onClick={send}>
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
