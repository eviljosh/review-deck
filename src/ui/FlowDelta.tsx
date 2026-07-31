import { useEffect, useRef, useState } from "react";
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

// Mermaid caps its SVG at the diagram's natural size via an inline max-width;
// small flowcharts end up postage-stamp sized. Read the natural width from the
// viewBox so the frame can render the diagram at 1.5× (still capped to the
// column width — overflow scrolls).
const SIZE_BOOST = 1.5;
function naturalWidth(svg: string): number | null {
  const m = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) [\d.]+"/.exec(svg);
  return m ? Number.parseFloat(m[1]) : null;
}

/**
 * Full-screen inspection of the rendered diagram: drag to pan, wheel or the
 * ＋/− buttons to zoom. Closes on ✕ or Escape (capture phase, so an Escape in
 * the lightbox doesn't also close the panel or detail view underneath).
 */
function FlowLightbox({ svg, onClose }: { svg: string; onClose: () => void }) {
  const [view, setView] = useState({ tx: 0, ty: 0, scale: 1.5 * SIZE_BOOST });
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const zoomBy = (f: number) => setView((v) => ({ ...v, scale: Math.min(6, Math.max(0.2, v.scale * f)) }));

  return (
    <div className="flow-lightbox">
      <div className="flow-lightbox-tools">
        <button className="btn btn-sm" title="Zoom in" onClick={() => zoomBy(1.25)}>＋</button>
        <button className="btn btn-sm" title="Zoom out" onClick={() => zoomBy(1 / 1.25)}>−</button>
        <button className="btn btn-sm" onClick={() => setView({ tx: 0, ty: 0, scale: 1.5 * SIZE_BOOST })}>reset</button>
        <button className="btn btn-sm btn-ghost" onClick={onClose}>✕ (esc)</button>
      </div>
      <div
        className="flow-lightbox-canvas"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setView((v) => ({ ...v, tx: d.tx + e.clientX - d.x, ty: d.ty + e.clientY - d.y }));
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onWheel={(e) => zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1)}
      >
        <div
          className="flow-lightbox-inner"
          style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}

/**
 * Triage's delta flow diagram: the major code/data flow with this PR's change
 * overlaid (added = green, removed = red-dashed). Model-written Mermaid can be
 * invalid — a failed render degrades to the caption plus the source in a fold,
 * never a blank box. Click the diagram (or ⤢) for a pannable, zoomable
 * full-screen view.
 */
export function FlowDelta({ flow }: { flow: FlowDeltaData }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);

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
      {svg && (
        <div className="flow-delta-frame" title="Click to expand — pan and zoom" onClick={() => setExpanded(true)}>
          <div className="flow-delta-svg">
            <div
              style={naturalWidth(svg) !== null ? { width: Math.round(naturalWidth(svg)! * SIZE_BOOST), maxWidth: "100%" } : undefined}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
          <button className="flow-delta-expand" title="Expand — pan and zoom">⤢</button>
        </div>
      )}
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
      {expanded && svg && <FlowLightbox svg={svg} onClose={() => setExpanded(false)} />}
    </div>
  );
}
