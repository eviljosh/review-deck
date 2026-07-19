import { useEffect, useState } from "react";
import {
  getSettings,
  listRepoConfigs,
  putRepoConfig,
  putSettings,
  type DimensionDef,
  type RepoConfig,
  type ReviewSettings,
  type RiskFlagDef,
} from "./api.ts";

function KeyedListEditor<T extends { key: string }>({
  items,
  valueField,
  valueLabel,
  onChange,
}: {
  items: T[];
  valueField: keyof T & string;
  valueLabel: string;
  onChange: (items: T[]) => void;
}) {
  const update = (i: number, patch: Partial<T>) =>
    onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  return (
    <div className="keyed-list">
      {items.map((it, i) => (
        <div key={i} className="keyed-row">
          <input
            value={it.key}
            placeholder="key"
            onChange={(e) => update(i, { key: e.target.value } as Partial<T>)}
          />
          <input
            className="keyed-value"
            value={String(it[valueField] ?? "")}
            placeholder={valueLabel}
            onChange={(e) => update(i, { [valueField]: e.target.value } as unknown as Partial<T>)}
          />
          <button className="btn btn-sm btn-ghost" title="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button
        className="btn btn-sm"
        onClick={() => onChange([...items, { key: "", [valueField]: "" } as unknown as T])}
      >
        + Add
      </button>
    </div>
  );
}

function RepoCard({ repo, onSaved }: { repo: RepoConfig; onSaved: () => void }) {
  const [guidance, setGuidance] = useState(repo.guidance);
  const [saved, setSaved] = useState(false);
  return (
    <div className="repo-card">
      <div className="repo-card-name">
        {repo.owner}/{repo.repo}
      </div>
      <textarea
        className="repo-guidance"
        placeholder="Repo-specific review guidance appended to every prompt: house style, domain context, things reviewers should know (e.g. “this repo contains LLM prompts — treat prompt text as data”)…"
        value={guidance}
        onChange={(e) => { setGuidance(e.target.value); setSaved(false); }}
      />
      <div className="repo-card-actions">
        <button
          className="btn btn-sm"
          onClick={() =>
            putRepoConfig(repo.owner, repo.repo, { guidance })
              .then(() => { setSaved(true); onSaved(); })
              .catch((e) => alert(String(e)))
          }
        >
          Save guidance
        </button>
        {saved && <span className="saved-tick">saved ✓</span>}
      </div>
    </div>
  );
}

export function Settings({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<ReviewSettings | null>(null);
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    getSettings().then(setSettings).catch((e) => alert(String(e)));
    listRepoConfigs().then(setRepos).catch(() => {});
  }, []);

  if (!settings) return <div className="settings"><div className="empty-state">Loading settings…</div></div>;

  const patch = (p: Partial<ReviewSettings>) => { setSettings({ ...settings, ...p }); setSavedAt(null); };

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      // Drop empty rows before saving keyed lists.
      const clean = {
        ...settings,
        dimensions: settings.dimensions.filter((d: DimensionDef) => d.key.trim()),
        riskFlags: settings.riskFlags.filter((f: RiskFlagDef) => f.key.trim()),
      };
      setSettings(await putSettings(clean));
      setSavedAt(Date.now());
    } catch (e) {
      alert(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings">
      <div className="settings-header">
        <h2>Settings</h2>
        <button className="btn btn-sm btn-ghost" onClick={onClose}>✕ Close</button>
      </div>

      <div className="section">
        <h3>Engines</h3>
        <label className="check-row">
          <input type="checkbox" checked={settings.engines.claude}
            onChange={(e) => patch({ engines: { ...settings.engines, claude: e.target.checked } })} />
          Claude
        </label>
        <label className="check-row">
          <input type="checkbox" checked={settings.engines.codex}
            onChange={(e) => patch({ engines: { ...settings.engines, codex: e.target.checked } })} />
          Codex
        </label>
        <div className="field-grid">
          <label>Claude model
            <input value={settings.claudeModel} onChange={(e) => patch({ claudeModel: e.target.value })} />
          </label>
          <label>Codex model <span className="hint-inline">(blank = inherit CLI config)</span>
            <input value={settings.codexModel ?? ""} onChange={(e) => patch({ codexModel: e.target.value || undefined })} />
          </label>
          <label>Codex reasoning effort
            <select value={settings.codexReasoningEffort ?? ""} onChange={(e) => patch({ codexReasoningEffort: e.target.value || undefined })}>
              <option value="">inherit</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>
          <label>Finalizer engine
            <select value={settings.finalizerEngine} onChange={(e) => patch({ finalizerEngine: e.target.value as "claude" | "codex" })}>
              <option value="claude">claude</option>
              <option value="codex">codex</option>
            </select>
          </label>
          <label>Engine timeout (min)
            <input type="number" min={1} value={Math.round(settings.engineTimeoutMs / 60000)}
              onChange={(e) => patch({ engineTimeoutMs: Math.max(1, Number(e.target.value) || 10) * 60000 })} />
          </label>
        </div>
      </div>

      <div className="section">
        <h3>Posted-review marker</h3>
        <p className="hint-text">Disclosure line prepended to every review posted to GitHub.</p>
        <textarea className="marker-textarea" value={settings.robotMarker}
          onChange={(e) => patch({ robotMarker: e.target.value })} />
      </div>

      <div className="section">
        <h3>Review dimensions</h3>
        <p className="hint-text">Each dimension runs as its own Claude reviewer. Key + the guidance that reviewer gets.</p>
        <KeyedListEditor items={settings.dimensions} valueField="guidance" valueLabel="guidance"
          onChange={(dimensions) => patch({ dimensions })} />
      </div>

      <div className="section">
        <h3>Risk flags</h3>
        <p className="hint-text">Surfaces triage can flag on a PR (badges in the queue). Key + description.</p>
        <KeyedListEditor items={settings.riskFlags} valueField="description" valueLabel="description"
          onChange={(riskFlags) => patch({ riskFlags })} />
      </div>

      <div className="section">
        <button className="btn btn-primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save settings"}
        </button>
        {savedAt && <span className="saved-tick">saved ✓ — applies to the next review run</span>}
      </div>

      <div className="section">
        <h3>Repos</h3>
        <p className="hint-text">
          Every repo you've reviewed gets an entry. Guidance here is appended to all prompts for that repo's PRs.
        </p>
        {repos.length === 0 ? (
          <div className="empty-state">No repos yet — add a PR first.</div>
        ) : (
          repos.map((r) => (
            <RepoCard key={r.id} repo={r} onSaved={() => listRepoConfigs().then(setRepos).catch(() => {})} />
          ))
        )}
      </div>
    </div>
  );
}
