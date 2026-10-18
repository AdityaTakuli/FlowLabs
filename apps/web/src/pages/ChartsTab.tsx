// Every chart of a project in one place: browser-style tabs on top (Overview, Data, Model, Compare,
// All), a 12-column grid below. Each chart expands or opens in its own window.
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState, type KeyboardEvent } from "react";
import { ChartGrid, ChartScopeContext } from "../charts/ChartFrame";
import { chartSpecs, OVERVIEW, type Category, type ChartSpec } from "../charts/registry";
import { Icon, type IconName } from "../components/Icon";
import type { ProjectApi } from "./ProjectPage";

type TabId = "overview" | Category | "all";

const TABS: { id: TabId; label: string; icon: IconName }[] = [
  { id: "overview", label: "Overview", icon: "sparkles" },
  { id: "data", label: "Data", icon: "table" },
  { id: "model", label: "Model", icon: "model" },
  { id: "compare", label: "Compare", icon: "trophy" },
  { id: "all", label: "All charts", icon: "layers" },
];

export function ChartsTab({ api }: { api: ProjectApi }) {
  const { project, profile, run } = api;
  const [tab, setTab] = useState<TabId>("overview");
  const [modelId, setModelId] = useState<string | null>(null);
  const done = run?.models.filter((m) => m.status === "done") ?? [];
  const model = done.find((m) => m.id === modelId) ?? run?.models.find((m) => m.id === run.best_model_id) ?? done[0] ?? null;
  const specs = useMemo(() => chartSpecs({ project, profile, run, model }).filter((s) => !s.hidden), [project, profile, run, model]);
  const lists: Record<TabId, ChartSpec[]> = {
    overview: OVERVIEW.map((id) => specs.find((s) => s.id === id)).filter((s): s is ChartSpec => Boolean(s)),
    data: specs.filter((s) => s.category === "data"),
    model: specs.filter((s) => s.category === "model"),
    compare: specs.filter((s) => s.category === "compare"),
    all: specs,
  };
  const shown = lists[tab];
  const keys = (event: KeyboardEvent) => {
    const index = TABS.findIndex((t) => t.id === tab);
    const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = TABS[(next + TABS.length) % TABS.length]!;
    setTab(target.id);
    document.getElementById(`charts-tab-${target.id}`)?.focus();
  };

  return (
    <ChartScopeContext.Provider value={{ projectId: project.id, runId: run?.id, modelId: model?.id }}>
      <div className="charts-page">
        <div className="tabstrip" role="tablist" aria-label="Chart categories" onKeyDown={keys}>
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`charts-tab-${t.id}`}
              role="tab"
              aria-selected={tab === t.id}
              tabIndex={tab === t.id ? 0 : -1}
              className={`tab ${tab === t.id ? "active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {tab === t.id && <motion.span layoutId="charts-tab" className="tab-surface" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
              <Icon name={t.icon} size={14} />
              <span>{t.label}</span>
              <span className="tab-count">{lists[t.id].length}</span>
            </button>
          ))}
          <span className="tabstrip-fill" />
          {done.length > 1 && (tab === "model" || tab === "overview" || tab === "all") && (
            <label className="tab-tool">
              <span className="dim small">Model</span>
              <select value={model?.id ?? ""} onChange={(e) => setModelId(e.target.value)}>
                {done.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                    {m.id === run?.best_model_id ? " (best)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="tab-panel" role="tabpanel" aria-labelledby={`charts-tab-${tab}`}>
          <AnimatePresence mode="wait">
            <motion.div key={`${tab}-${model?.id ?? ""}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.1 } }} transition={{ duration: 0.2 }}>
              {shown.length ? (
                <ChartGrid specs={shown} />
              ) : (
                <div className="empty">
                  <Icon name="chart" size={26} />
                  <p style={{ marginTop: 8 }}>{tab === "model" || tab === "compare" ? "Train the pipeline to see these charts." : "No charts here yet."}</p>
                  {(tab === "model" || tab === "compare") && (
                    <button className="accent" style={{ marginTop: 12 }} onClick={() => api.setTab("results")}>
                      <Icon name="play" /> Go to Results
                    </button>
                  )}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </ChartScopeContext.Provider>
  );
}
