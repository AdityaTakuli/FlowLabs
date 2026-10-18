// One chart filling its own window (opened from a chart's "Open in a new window"). The chart can be
// zoomed and panned, and the menu switches to any other chart of the same project.
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../context";
import { chartSpecs, CATEGORY_LABELS, type Category } from "../charts/registry";
import { Spinner } from "../components/ui";
import { LogoMark } from "../components/TopBar";
import type { Profile, Project, RunResult } from "../types";

export function ChartWindow({ projectId, runId, modelId, chartId }: { projectId: string; runId?: string; modelId?: string; chartId: string }) {
  const { engine, fail } = useApp();
  const [project, setProject] = useState<Project | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [run, setRun] = useState<RunResult | null>(null);
  const [chart, setChart] = useState(chartId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const p = await engine.call<Project>("projects.get", { project_id: projectId });
        setProject(p);
        const [prof, r] = await Promise.all([
          engine.call<Profile>("datasets.profile", { dataset_id: p.dataset_id, target: p.target }),
          runId || p.last_run ? engine.call<RunResult>("runs.get", { project_id: projectId, run_id: runId || p.last_run }) : Promise.resolve(null),
        ]);
        setProfile(prof);
        setRun(r);
      } catch (failure) {
        setError((failure as Error).message);
        fail(failure);
      }
    })();
  }, [engine, projectId, runId, fail]);

  const model = run?.models.find((m) => m.id === modelId) ?? run?.models.find((m) => m.id === run.best_model_id) ?? null;
  const specs = useMemo(() => (project ? chartSpecs({ project, profile, run, model }) : []), [project, profile, run, model]);
  const spec = specs.find((s) => s.id === chart);
  useEffect(() => {
    if (spec) document.title = `${spec.title} - FlowLabs`;
  }, [spec]);

  return (
    <div className="chart-window">
      <header className="topbar">
        <span className="brand">
          <LogoMark />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="chart-window-title ellipsis">{spec?.title ?? "Chart"}</div>
          <div className="faint tiny ellipsis">
            {project?.name}
            {model ? `, ${model.label}` : ""}
          </div>
        </div>
        <span className="spacer" />
        {specs.length > 0 && (
          <select value={chart} onChange={(e) => setChart(e.target.value)} aria-label="Chart">
            {(["data", "model", "compare"] as Category[]).map((category) => (
              <optgroup key={category} label={CATEGORY_LABELS[category]}>
                {specs
                  .filter((s) => s.category === category)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        )}
      </header>
      <main className="chart-window-body">
        {error ? (
          <p className="error-text">{error}</p>
        ) : !project ? (
          <div className="row">
            <Spinner /> Loading…
          </div>
        ) : spec ? (
          <>
            {spec.sub && <p className="chart-sub">{spec.sub}</p>}
            {spec.render("large")}
          </>
        ) : (
          <p className="dim">This chart is not available for this project{run ? "" : " until it is trained"}.</p>
        )}
      </main>
    </div>
  );
}
