import { useEffect, useState } from "react";
import type { FlowDelta as FlowDeltaData, PrRecord } from "../shared/types.ts";
import { Md } from "./bits.tsx";

export function parseFlowDelta(pr: PrRecord): FlowDeltaData | null {
  if (!pr.flow_delta) return null;
  try {
    const parsed = JSON.parse(pr.flow_delta) as FlowDeltaData;
    return parsed?.mermaid?.trim() ? { mermaid: parsed.mermaid, caption: parsed.caption ?? "" } : null;
  } catch {
    return null;
  }
}

// Mermaid is ~1MB minified — loaded on demand the first time a diagram renders
// so PRs without one never pay for it.
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", fontFamily: "inherit" });
      return m.default;
    });
  }
  return mermaidPromise;
}

let renderSeq = 0;

/**
 * Triage's delta flow diagram: the major code/data flow with this PR's change
 * overlaid (added = green, removed = red-dashed). Model-written Mermaid can be
 * invalid — a failed render degrades to the caption plus the source in a fold,
 * never a blank box.
 */
export function FlowDelta({ flow }: { flow: FlowDeltaData }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setSvg(null);
    setFailed(false);
    loadMermaid()
      .then((mermaid) => mermaid.render(`flow-delta-${renderSeq++}`, flow.mermaid))
      .then((r) => { if (alive) setSvg(r.svg); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [flow.mermaid]);

  return (
    <div className="flow-delta">
      {/* mermaid escapes/sanitizes under securityLevel "strict", so its SVG output is safe to inject */}
      {svg && <div className="flow-delta-svg" dangerouslySetInnerHTML={{ __html: svg }} />}
      {!svg && !failed && <div className="wt-quiet">Rendering diagram…</div>}
      {failed && (
        <details className="fold">
          <summary>diagram failed to render — show source</summary>
          <pre className="log">{flow.mermaid}</pre>
        </details>
      )}
      {flow.caption && <div className="flow-delta-caption"><Md inline>{flow.caption}</Md></div>}
      <div className="flow-delta-legend">
        <span className="flow-legend-added">■ added</span>
        <span className="flow-legend-removed">□ removed</span>
        <span>■ unchanged</span>
      </div>
    </div>
  );
}
