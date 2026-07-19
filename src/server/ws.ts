import type { WsMessage } from "../shared/types.ts";

export interface WsSocket {
  send: (data: string) => void;
}

export class WsHub {
  private sockets = new Set<WsSocket>();

  add(socket: WsSocket): void {
    this.sockets.add(socket);
  }

  remove(socket: WsSocket): void {
    this.sockets.delete(socket);
  }

  broadcast(msg: WsMessage): void {
    const data = JSON.stringify(msg);
    for (const s of [...this.sockets]) {
      try {
        s.send(data);
      } catch {
        this.sockets.delete(s);
      }
    }
  }
}
