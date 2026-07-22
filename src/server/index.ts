import "dotenv/config";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { openDb, reconcileInterrupted } from "./db.ts";
import { realExec } from "./exec.ts";
import { WsHub } from "./ws.ts";
import { buildApp } from "./app.ts";
import { makeClaudeEngine } from "./engines/claude.ts";
import { makeCodexEngine } from "./engines/codex.ts";
import { loadReviewConfig } from "./review-config.ts";

// Claude auth precedence: an Anthropic API key is the primary path; the Claude
// Code OAuth token (or an inherited CLI login) is the fallback when no key is
// set. When both are present, drop the token so the choice is deterministic
// rather than left to however the SDK breaks ties.
if (process.env.ANTHROPIC_API_KEY) {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    console.log("claude auth: ANTHROPIC_API_KEY (ignoring CLAUDE_CODE_OAUTH_TOKEN)");
  } else {
    console.log("claude auth: ANTHROPIC_API_KEY");
  }
} else if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.log("claude auth: CLAUDE_CODE_OAUTH_TOKEN");
} else {
  console.log("claude auth: no key/token in env — relying on an inherited Claude Code login");
}

const here = fileURLToPath(new URL(".", import.meta.url));
const dataDir = join(here, "..", "..", "data");
const db = openDb(join(dataDir, "review-deck.db"));
const reconciled = reconcileInterrupted(db);
if (reconciled > 0) console.log(`reconciled ${reconciled} interrupted PR(s) → failed (retryable)`);
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
