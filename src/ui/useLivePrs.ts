import { useEffect, useState } from "react";
import type { PrRecord, WsMessage } from "../shared/types.ts";
import { listPrs } from "./api.ts";

export interface ChatStream {
  streaming: string;      // accumulating assistant answer for the in-flight turn
  bump: number;           // increments when a turn finishes → refetch history
  error: string | null;
}

export function useLivePrs(): {
  prs: PrRecord[];
  logs: Record<number, string>;
  findingsBump: Record<number, number>;
  chat: Record<number, ChatStream>;
} {
  const [prs, setPrs] = useState<PrRecord[]>([]);
  const [logs, setLogs] = useState<Record<number, string>>({});
  const [findingsBump, setFindingsBump] = useState<Record<number, number>>({});
  const [chat, setChat] = useState<Record<number, ChatStream>>({});

  useEffect(() => {
    let ws: WebSocket | null = null;
    let disposed = false;
    let retryMs = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      // Re-fetch on every (re)connect so state changed while disconnected
      // (e.g. across a server restart) is picked up.
      listPrs().then(setPrs).catch(() => {});
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => { retryMs = 1000; };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as WsMessage;
        if (msg.type === "pr_updated") {
          setPrs((prev) => [msg.pr, ...prev.filter((p) => p.id !== msg.pr.id)].sort((a, b) => b.id - a.id));
        } else if (msg.type === "pr_log") {
          setLogs((prev) => ({ ...prev, [msg.prId]: (prev[msg.prId] ?? "") + msg.chunk }));
        } else if (msg.type === "findings_updated") {
          setFindingsBump((prev) => ({ ...prev, [msg.prId]: (prev[msg.prId] ?? 0) + 1 }));
        } else if (msg.type === "pr_log_reset") {
          setLogs((prev) => { const next = { ...prev }; delete next[msg.prId]; return next; });
        } else if (msg.type === "pr_deleted") {
          setPrs((prev) => prev.filter((p) => p.id !== msg.prId));
          setLogs((prev) => { const next = { ...prev }; delete next[msg.prId]; return next; });
        } else if (msg.type === "chat_chunk") {
          setChat((prev) => {
            const cur = prev[msg.prId] ?? { streaming: "", bump: 0, error: null };
            return { ...prev, [msg.prId]: { ...cur, streaming: cur.streaming + msg.chunk, error: null } };
          });
        } else if (msg.type === "chat_done") {
          setChat((prev) => {
            const cur = prev[msg.prId] ?? { streaming: "", bump: 0, error: null };
            return { ...prev, [msg.prId]: { streaming: "", bump: cur.bump + 1, error: null } };
          });
        } else if (msg.type === "chat_error") {
          setChat((prev) => {
            const cur = prev[msg.prId] ?? { streaming: "", bump: 0, error: null };
            return { ...prev, [msg.prId]: { streaming: "", bump: cur.bump + 1, error: msg.error } };
          });
        }
      };
      // Reconnect with backoff when the connection drops (server restart, sleep).
      ws.onclose = () => {
        if (disposed) return;
        timer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 15_000);
      };
    }

    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return { prs, logs, findingsBump, chat };
}
