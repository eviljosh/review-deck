import { useEffect, useState } from "react";
import type { PrRecord } from "../shared/types.ts";
import { createPrs, markSeen, purgeArchived } from "./api.ts";
import { useLivePrs } from "./useLivePrs.ts";
import { PrDetail } from "./PrDetail.tsx";
import { Settings } from "./Settings.tsx";
import { DANGER_RANK, DangerBadge, DiffStat, StageBadge, StatusBadges, StatusPill, dangerClass, isUnseen } from "./bits.tsx";

type SortKey = "danger" | "recent" | "repo";

function PrCard({ pr, selected, onSelect }: { pr: PrRecord; selected: boolean; onSelect: () => void }) {
  const unseen = isUnseen(pr);
  return (
    <div
      className={`pr-card ${dangerClass(pr.danger_level)} ${selected ? "selected" : ""} ${unseen ? "unseen" : ""}`}
      onClick={onSelect}
    >
      <div className="pr-title-row">
        {unseen && <span className="unseen-dot" title="new / changed since you last looked" />}
        <span className="pr-num">#{pr.number}</span>
        <span className="pr-title">{pr.title ?? "(loading…)"}</span>
      </div>
      <div className="pr-meta">
        {pr.owner}/{pr.repo}
        {pr.author ? ` · ${pr.author}` : ""} · <DiffStat pr={pr} />
      </div>
      <div className="pr-tags">
        <DangerBadge level={pr.danger_level} />
        <StageBadge stage={pr.stage} />
        <StatusPill status={pr.status} />
        <StatusBadges pr={pr} />
      </div>
    </div>
  );
}

function sortPrs(prs: PrRecord[], key: SortKey): PrRecord[] {
  const byId = (a: PrRecord, b: PrRecord) => b.id - a.id;
  const copy = [...prs];
  if (key === "recent") return copy.sort(byId);
  if (key === "repo") return copy.sort((a, b) => `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`) || byId(a, b));
  // danger: high → medium → low → untriaged, newest first within a tier
  const rank = (p: PrRecord) => (p.danger_level ? DANGER_RANK[p.danger_level] ?? 3 : 3);
  return copy.sort((a, b) => rank(a) - rank(b) || byId(a, b));
}

function hashPrId(): number | null {
  const m = /^#pr-(\d+)$/.exec(location.hash);
  return m ? Number(m[1]) : null;
}

export function App() {
  const { prs, logs, findingsBump, chat } = useLivePrs();
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sort, setSort] = useState<SortKey>("recent");
  // Selection is deep-linked in the URL hash (#pr-<id>) so it survives reload
  // and can be bookmarked/shared.
  const [selected, setSelected] = useState<number | null>(hashPrId);

  function select(id: number) {
    setSelected(id);
    history.replaceState(null, "", `#pr-${id}`);
    markSeen(id).catch(() => {}); // opening clears the unseen mark
  }
  function deselect() {
    setSelected(null);
    history.replaceState(null, "", location.pathname + location.search);
  }

  async function submit() {
    const urls = text.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    if (urls.length === 0) return;
    try {
      const { created, existing } = await createPrs(urls);
      setText("");
      if (existing.length > 0) {
        const desc = existing.map((p) => `#${p.number}${p.archived_at ? " (archived)" : ""}`).join(", ");
        const n = existing.length;
        setNotice(`Already tracked, not re-added: ${desc}. ${created.length > 0 ? `Added ${created.length} new. ` : ""}Showing the existing record${n > 1 ? "s" : ""}.`);
        // Reveal the first existing record so you can see its state/findings.
        const first = existing[0];
        setShowArchived(!!first.archived_at);
        select(first.id);
      } else {
        setNotice(null);
      }
    } catch (e) {
      alert(String(e));
    }
  }

  const active = prs.filter((p) => !p.archived_at);
  const archived = prs.filter((p) => p.archived_at);
  const visible = sortPrs(showArchived ? archived : active, sort);

  const sel = prs.find((p) => p.id === selected) ?? null;

  // Keyboard queue nav: j/k move through the visible list, o opens on GitHub,
  // Escape closes the detail. Ignored while typing in a field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "Escape") { deselect(); return; }
      if (visible.length === 0) return;
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const idx = visible.findIndex((p) => p.id === selected);
        const next = e.key === "j"
          ? Math.min(visible.length - 1, idx < 0 ? 0 : idx + 1)
          : Math.max(0, idx < 0 ? 0 : idx - 1);
        select(visible[next].id);
      } else if (e.key === "o") {
        const cur = visible.find((p) => p.id === selected);
        if (cur) window.open(cur.url, "_blank", "noopener");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function purge() {
    if (!confirm(`Delete all archived reviews older than 30 days? This can't be undone.`)) return;
    try {
      const r = await purgeArchived();
      alert(r.deleted === 0 ? "Nothing to purge — no archived reviews older than 30 days." : `Deleted ${r.deleted} archived review(s).`);
    } catch (e) {
      alert(String(e));
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>review-deck</h1>
        <span className="subtitle">parallel PR review · Claude + Codex</span>
        <button className="btn btn-sm btn-ghost settings-btn" onClick={() => setShowSettings((s) => !s)}>
          ⚙ Settings
        </button>
      </header>

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}

      <div className="composer">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
          placeholder="Paste GitHub PR URLs (one per line)…"
        />
        <div className="composer-actions">
          <span className="hint">⌘↵ to add</span>
          <button className="btn btn-primary" onClick={submit}>
            Add PRs
          </button>
        </div>
      </div>

      <div className="shortcuts">
        <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>o</kbd> open on GitHub · <kbd>esc</kbd> close
      </div>

      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button className="btn btn-sm btn-ghost" onClick={() => setNotice(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      <div className="tabs">
        <button className={`tab ${showArchived ? "" : "active"}`} onClick={() => setShowArchived(false)}>
          Active <span className="tab-count">{active.length}</span>
        </button>
        <button className={`tab ${showArchived ? "active" : ""}`} onClick={() => setShowArchived(true)}>
          Archived <span className="tab-count">{archived.length}</span>
        </button>
        <div className="tabs-right">
          {showArchived && archived.length > 0 && (
            <button className="btn btn-sm btn-danger" onClick={purge} title="Delete archived reviews older than 30 days">
              🗑 Purge &gt; 30 days
            </button>
          )}
          <label className="sort-control">
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="recent">Recent</option>
              <option value="danger">Danger</option>
              <option value="repo">Repo</option>
            </select>
          </label>
        </div>
      </div>

      <div className={`layout ${sel ? "" : "solo"}`}>
        <div className="pr-list">
          {visible.length === 0 ? (
            <div className="empty-state">
              {showArchived
                ? "No archived reviews."
                : prs.length === 0
                  ? "No PRs yet. Paste a GitHub PR URL above to start a review."
                  : "No active reviews — check the Archived tab."}
            </div>
          ) : (
            visible.map((pr) => (
              <PrCard key={pr.id} pr={pr} selected={pr.id === selected} onSelect={() => select(pr.id)} />
            ))
          )}
        </div>

        {sel && (
          <PrDetail
            pr={sel}
            log={logs[sel.id] ?? ""}
            findingsBump={findingsBump[sel.id]}
            chat={chat[sel.id]}
            onClose={deselect}
          />
        )}
      </div>
    </div>
  );
}
