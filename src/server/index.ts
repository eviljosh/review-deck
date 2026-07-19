import "dotenv/config";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { openDb, reconcileInterrupted } from "./db.ts";
import { purgeOrphanWorktrees } from "./cleanup.ts";
import { realExec } from "./exec.ts";
import { WsHub } from "./ws.ts";
import { buildApp } from "./app.ts";
import { makeClaudeEngine } from "./engines/claude.ts";
import { makeCodexEngine } from "./engines/codex.ts";
import { loadReviewConfig } from "./review-config.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const dataDir = join(here, "..", "..", "data");
const db = openDb(join(dataDir, "review-deck.db"));
const reconciled = reconcileInterrupted(db);
if (reconciled > 0) console.log(`reconciled ${reconciled} interrupted PR(s) → failed (retryable)`);
const purged = purgeOrphanWorktrees(db, dataDir);
if (purged > 0) console.log(`purged ${purged} orphaned worktree(s) from data/worktrees`);
const hub = new WsHub();
const app = buildApp({
  db, exec: realExec, dataDir, hub,
  // Settings live in the DB (editable in the UI); this boot-time load seeds
  // the concurrency limiters — per-run knobs are re-read at each launch.
  claude: makeClaudeEngine(), codex: makeCodexEngine(), config: loadReviewConfig(db),
});

await app.register(fastifyWebsocket);
app.register(async (scoped) => {
  scoped.get("/ws", { websocket: true }, (socket) => {
    hub.add(socket);
    socket.send(JSON.stringify({ type: "hello" }));
    socket.on("close", () => hub.remove(socket));
  });
});

if (process.env.NODE_ENV === "production") {
  await app.register(fastifyStatic, {
    root: join(here, "..", "..", "dist", "ui"),
  });
}

const port = Number(process.env.PORT ?? 3001);
app
  .listen({ port, host: "127.0.0.1" })
  .then(() => console.log(`review-deck server on http://127.0.0.1:${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
