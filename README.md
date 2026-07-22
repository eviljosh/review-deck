# review-deck

A local web app for reviewing many GitHub PRs in parallel. Paste PR URLs; each one runs
through a fixed pipeline — using **Claude** and **Codex** as independent reviewers — and shows
up live as a card you can triage. **Read-only** against target repos until you explicitly post.

## What it does

Paste GitHub PR URLs → each PR runs concurrently through:

1. **Prepare** — clone-on-demand (blobless, over SSH) + fetch + a throwaway worktree; pulls PR
   metadata / description / CI + mergeability status via `gh`; **pins the review to the exact
   head commit** (the diff is computed locally from the pinned SHAs and reused by every stage,
   so a mid-review push can't skew the results).
2. **Triage** — a one-line headline; the PR's **goal** (from the description + linked Linear
   ticket) and a **goal verdict** (achieves / partially / does-not / unclear, with the gaps);
   a high-level summary; a 🟢/🟡/🔴 danger rating with configurable risk flags; focus areas;
   and a summary of existing review discussion.
3. **Deep review** — Claude fanned out per configurable dimension (correctness, intent,
   maintainability, tests, security by default) and Codex over the full diff, in parallel —
   every reviewer gets the distilled goal so findings are judged against what the change is
   actually trying to do.
4. **Synthesize** — dedupe, mark 🤝 cross-model agreement, cluster findings into themes,
   score each finding's **impact relative to the goal** (a budgeted "high" tier), write a
   1–2 sentence bottom-line **verdict**, produce a **file reading guide**, and anchor each
   finding to a diff line. Findings you rejected on past reviews of the same repo are fed
   back in and deprioritized.
5. **Gate** — high-impact findings come pre-selected; edit the preface, toggle findings
   (select all / none), and add your own comments in the walkthrough.
6. **Post** — one inline GitHub review pinned to the reviewed commit: your preface, your own
   comments (verbatim), a 🤖 marker, and line-anchored findings.

**Walkthrough mode** (⧉ on any reviewed PR): a three-pane review cockpit — changed files in
suggested reading order with finding counts · the diff with findings inline and
click-a-line-to-comment · a context pane with the file's role, the PR goal, findings, your
comments, and a **live chat** that can read the PR's checkout to answer questions.

Live logs + danger/CI badges stream over WebSocket. Retries resume from the failed stage,
run cancellation, archive (with a 30-day purge and worktree cleanup), a seen/unseen inbox,
an "⇡ new commits" staleness badge, danger/recent/repo sorting, and keyboard nav
(`j`/`k`/`o`/`esc`).

## Prerequisites

- **Node.js 22+**.
- **SSH access to GitHub.** Prepare clones over `git@github.com:…`, so you need working SSH
  keys (`ssh -T git@github.com` should succeed). This avoids interactive HTTPS credential
  prompts on the server.
- **[`gh`](https://cli.github.com/) authenticated** with `repo` scope (`gh auth status`) —
  used to read PR metadata/diffs/status and to post the final review.
- **A Claude login** for the Claude reviewer (see below).
- **The `codex` CLI, logged in** for the Codex reviewer (see below). Optional — you can turn
  the Codex engine off in the ⚙ Settings UI.

## Auth & environment

The server loads a `.env` file at startup (via `dotenv`). Copy the example and fill in what you
need:

```bash
cp .env.example .env
```

### Claude (`ANTHROPIC_API_KEY`, falling back to `CLAUDE_CODE_OAUTH_TOKEN`) — required for reviews

The Claude reviewer runs through the Claude Agent SDK. Credentials are resolved in this order:

1. **Anthropic API key (primary):** create a key at [console.anthropic.com](https://console.anthropic.com)
   and put it in `.env` as `ANTHROPIC_API_KEY=…`. Usage is billed to your Anthropic account.
   When a key is set, any OAuth token in the environment is ignored.
2. **Claude Code OAuth token (fallback):** run `claude setup-token` and put the result in `.env`
   as `CLAUDE_CODE_OAUTH_TOKEN=…`. This bills your Claude subscription instead.
3. **Inherited Claude Code login:** with neither set, start the server from a shell where you're
   already logged into Claude Code and the SDK will use that login. (Start from a fresh terminal
   if the login is newer than your current shell.)

The server logs which path it picked at startup (`claude auth: …`).

#### Claude transport: Agent SDK vs. `claude -p`

By default the Claude reviewer runs through the bundled Agent SDK. In **⚙ Settings → Claude
transport** you can switch it to spawn your locally installed `claude` CLI (`claude -p`)
instead. This exists mainly for accounts whose contractual terms (e.g. BAA / zero-data-retention)
cover CLI or API-key usage but not an OAuth token through the SDK — check your own agreement;
this tool only controls which binary runs.

Details of the CLI transport:

- Requires `claude` ≥ **2.1.0** on the server's PATH (probed before each review; a too-old or
  missing binary fails the run with a clear error).
- Runs with **settings isolation** (`--setting-sources ""`): your user/project/local Claude
  settings and the reviewed repo's `CLAUDE.md` are not loaded — parity with the SDK's clean-room
  behavior, and it keeps a malicious PR from injecting instructions into the reviewer. Enterprise
  *managed* settings deployed by your IT still apply (by design — they're not bypassable).
- **CLI credentials** sub-setting: "inherit env" follows the normal precedence (API key → OAuth
  token → the machine's `claude /login` session). Note that a leftover token in `.env` outranks
  your login. Choose **"stored login only"** to scrub credential env vars from the spawned CLI so
  every review is guaranteed to run as the logged-in account — the setting to pick for the
  compliance case above (make sure you've run `/login` in `claude` on this machine first).

### Codex (ChatGPT login or `OPENAI_API_KEY`) — required unless Codex is disabled

The Codex reviewer shells out to the local `codex` CLI, which authenticates via either:

- your **ChatGPT login** — run `codex login` once (stored in `~/.codex/auth.json`), **or**
- an **`OPENAI_API_KEY`** in your environment / `.env`.

Codex's model and reasoning effort are inherited from your `~/.codex/config.toml` unless
overridden in the ⚙ Settings UI.

### Linear (`LINEAR_API_KEY`) — optional

If set, triage extracts any linked Linear issue from the PR body/comments and pulls its
title/description/state so the summary can explain the problem being solved. Create a personal
API key in Linear → **Settings → Security & access → Personal API keys** and add it to `.env`
as `LINEAR_API_KEY=lin_api_…`. Without it, triage just skips this step.

### Other

- `PORT` — API/server port (default `3001`).

## Run it locally

```bash
npm install
npm run dev
```

- UI: <http://localhost:3000>
- API + WebSocket: <http://localhost:3001> (the Vite dev server proxies `/api` and `/ws`)

Open the UI, paste one or more GitHub PR URLs (one per line), and click **Add PRs**. Each card
appears immediately and updates live as it runs. Open a card to see the triage, findings, and
the gate; nothing is posted to GitHub until you click **Post**.

> ⚠️ Adding a PR runs real `git`/`gh` against the target repo (clone/fetch into a local cache)
> and sends the diff to Anthropic and OpenAI for review. It never writes to or pushes the
> target repo, and only posts a review when you explicitly do so.

## Hand a review off to a CLI agent

Reviewing finds the problems; fixing them usually happens in a terminal. Every review is
available as a self-contained markdown brief — goal + verdict, bottom line, summary, danger
reasons, focus areas, all findings (with your select/deselect decisions marked), and your own
comments — ending with the `gh pr checkout` / `git checkout <reviewed-sha>` commands an agent
needs to pull the actual code.

- **⎘ Copy review** (detail view or walkthrough header) puts the brief on the clipboard —
  paste it into a Claude Code / Codex / any CLI agent session and go.
- Or fetch it directly (the PR id is in the URL hash, e.g. `#pr-12`):

  ```bash
  curl -s localhost:3001/api/prs/12/review.md | claude
  ```

## Configuration

Everything configurable lives in the database and is edited in the **⚙ Settings** UI (no
code edits, applies to the next review run):

- **Engines** — enable/disable Claude / Codex; models, Codex reasoning effort, finalizer
  engine, per-call timeout.
- **Posted-review marker** — the disclosure line prepended to every posted review.
- **Review dimensions** — each runs as its own Claude reviewer (`key` + guidance). Add e.g. a
  house-style dimension, remove ones you don't want.
- **Risk flags** — the surfaces triage can flag (badges in the queue), e.g. add a `phi` flag
  if you review healthcare code.
- **Per-repo guidance** — every repo you review gets an entry; freeform text appended to all
  prompts for that repo's PRs (house style, domain context, "this repo contains LLM prompts —
  treat prompt text as data", …). Per-repo dimension/risk-flag overrides are available via
  `PUT /api/repos/:owner/:repo`.

Code-level defaults (including `maxConcurrentPipelines` / `maxConcurrentReviews`, which are
read at boot) live in `src/server/review-config.ts`; 4×4 ≈ up to 16 concurrent LLM calls —
lower the pipelines limit if you hit subscription rate limits.

The tool itself is repo-agnostic: nothing about a specific repo, codebase, or company is
hardcoded.

## Other commands

```bash
npm test          # node:test suite via tsx — no network, no LLM
npm run typecheck # tsc --noEmit
npm run build     # build the UI into dist/ui
npm start         # production: Fastify serves the built UI + API on :3001
```

## Layout

```
src/server/   Fastify app + WS, pipeline orchestrator, gh/linear clients, repo/worktree manager,
              engine adapters (Claude/Codex), sqlite db, prompts
src/shared/   zod schemas + shared types (imported by server and UI)
src/ui/       React + Vite frontend (queue, detail panel, live WS updates)
test/         node:test suite (stubs the exec wrapper + engines — no real git/gh/LLM)
data/         gitignored: sqlite db, repo cache, throwaway worktrees, artifacts
docs/         design spec + milestone implementation plans
```

## Notes

- All external commands (`git`, `gh`) go through one injectable `exec` wrapper
  (`src/server/exec.ts`), and the LLM engines are injectable, so the test suite runs fully
  offline.
- State lives in SQLite (`data/review-deck.db`); repo clones and worktrees live under `data/`.
  Everything under `data/` is gitignored and safe to delete.
- Per-stage artifacts (prompts, raw model output, findings) are written under `data/` for
  debugging.
