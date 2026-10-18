// A chart's card: title, explanation, and two ways to see it bigger: Expand (full screen, zoom and
// pan) and Open in a new window (a second native window in the desktop app).
import { AnimatePresence, motion } from "motion/react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useApp } from "../context";
import { Icon } from "../components/Icon";
import type { Engine } from "../engine/engine";
import type { ChartSpec } from "./registry";

/** Which project, run and model the charts on screen describe, for opening one in a new window. */
export interface ChartScope {
  projectId: string;
  runId?: string | null;
  modelId?: string | null;
}

export const ChartScopeContext = createContext<ChartScope | null>(null);

type Desktop = { pywebview?: { api?: { open_window?: (url: string, title: string) => Promise<unknown> } } };

export function chartUrl(scope: ChartScope, chartId: string, engine: Engine): string {
  const query = new URLSearchParams({ page: "chart", project: scope.projectId, chart: chartId });
  if (scope.runId) query.set("run", scope.runId);
  if (scope.modelId) query.set("model", scope.modelId);
  if (engine.kind === "local") {
    const token = sessionStorage.getItem("flowlabs.token");
    if (token) query.set("token", token);
  }
  return `${location.origin}${location.pathname}?${query}`;
}

/** The desktop app opens a second native window; a browser opens a new window. */
export function openChartWindow(scope: ChartScope, spec: ChartSpec, engine: Engine) {
  const url = chartUrl(scope, spec.id, engine);
  const api = (window as unknown as Desktop).pywebview?.api;
  if (api?.open_window) {
    void api.open_window(url, `${spec.title} - FlowLabs`);
    return;
  }
  window.open(url, `flowlabs-chart-${spec.id}`, "popup,width=1180,height=820");
}

function Actions({ spec, onExpand }: { spec: ChartSpec; onExpand?: () => void }) {
  const { engine } = useApp();
  const scope = useContext(ChartScopeContext);
  return (
    <div className="chart-actions">
      {onExpand && (
        <button className="ghost icon-only small" onClick={onExpand} title="Expand" aria-label={`Expand ${spec.title}`}>
          <Icon name="expand" size={13} />
        </button>
      )}
      {scope && (
        <button className="ghost icon-only small" onClick={() => openChartWindow(scope, spec, engine)} title="Open in a new window" aria-label={`Open ${spec.title} in a new window`}>
          <Icon name="external" size={13} />
        </button>
      )}
    </div>
  );
}

export function ChartCard({ spec, className = "", extra }: { spec: ChartSpec; className?: string; extra?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <section className={`chart-card ${className}`} data-chart={spec.id}>
        <header className="chart-card-head">
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3>{spec.title}</h3>
            {spec.sub && <p className="chart-sub">{spec.sub}</p>}
          </div>
          {extra}
          <Actions spec={spec} onExpand={() => setOpen(true)} />
        </header>
        {spec.render("card")}
      </section>
      <AnimatePresence>{open && <ExpandedChart spec={spec} onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  );
}

export function ExpandedChart({ spec, onClose }: { spec: ChartSpec; onClose: () => void }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <motion.div
      className="overlay chart-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <motion.section
        className="chart-expanded"
        role="dialog"
        aria-modal="true"
        aria-label={spec.title}
        initial={{ opacity: 0, scale: 0.94, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 10, transition: { duration: 0.15 } }}
        transition={{ type: "spring", stiffness: 380, damping: 32 }}
      >
        <header className="chart-card-head">
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2>{spec.title}</h2>
            {spec.sub && <p className="chart-sub">{spec.sub}</p>}
          </div>
          <Actions spec={spec} />
          <button className="ghost icon-only" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="chart-expanded-body">{spec.render("large")}</div>
      </motion.section>
    </motion.div>
  );
}

/** Charts on a 12-column grid: each takes a third, half, two thirds or the full width. */
export function ChartGrid({ specs }: { specs: ChartSpec[] }) {
  return (
    <div className="bento">
      {specs.map((spec, i) => (
        <motion.div
          key={spec.id}
          className={`bento-${spec.span}`}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: Math.min(i * 0.04, 0.4), duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        >
          <ChartCard spec={spec} />
        </motion.div>
      ))}
    </div>
  );
}
