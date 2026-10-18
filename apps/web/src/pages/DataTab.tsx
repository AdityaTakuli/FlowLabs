import { useMemo, useState } from "react";
import { useApp } from "../context";
import { Bars, CountUp, DotHistogram, Spark } from "../charts/charts";
import { ChartCard, ChartScopeContext } from "../charts/ChartFrame";
import { chartSpecs } from "../charts/registry";
import { Icon } from "../components/Icon";
import { KindBadge, Notice, Segmented, Spinner } from "../components/ui";
import { fmt } from "../format";
import type { ModelEntry, Step, Suggestion, Task } from "../types";
import type { ProjectApi } from "./ProjectPage";

const DEFAULTS: Record<Task, string[]> = {
  classification: ["baseline", "logistic_regression", "random_forest", "hist_gradient_boosting"],
  regression: ["baseline", "linear_regression", "random_forest", "hist_gradient_boosting"],
};

const FLAG_TEXT: Record<string, string> = {
  id_like: "looks like an ID",
  constant: "never changes",
  skewed: "skewed",
  outliers: "has outliers",
  inconsistent_text: "inconsistent spelling",
  numbers_as_text: "numbers stored as text",
  high_cardinality: "many categories",
  mostly_missing: "mostly empty",
};

/** One number column at a time, as dots or curves, split by the target's classes when it has a few. */
/** One number column at a time, as dots or curves, split by the target's classes when it has a few. */
function Distributions({ api }: { api: ProjectApi }) {
  const { project, profile, run } = api;
  const columns = profile?.columns ?? [];
  const numeric = columns.filter((c) => c.histogram && c.histogram.edges.length > 2 && c.name !== project.target);
  const [name, setName] = useState<string | null>(null);
  const [view, setView] = useState<"dots" | "curves">("dots");
  const specs = useMemo(() => chartSpecs({ project, profile, run, model: null }), [project, profile, run]);
  const column = numeric.find((c) => c.name === name) ?? numeric.find((c) => c.by_target) ?? numeric[0];
  if (!column) return null;
  const split = Boolean(column.by_target && column.by_target.length > 1);
  const spec = specs.find((s) => s.id === `${view === "curves" && split ? "data-density" : "data-dist"}-${column.name}`);
  if (!spec) return null;
  return (
    <ChartCard
      key={spec.id}
      spec={{ ...spec, title: `Distribution of ${column.name}`, sub: split ? `Split by ${project.target}. Columns whose classes sit apart are the ones a model can learn from.` : "All rows." }}
      extra={
        <div className="row wrap" style={{ gap: 8 }}>
          <select value={column.name} onChange={(e) => setName(e.target.value)} aria-label="Column">
            {numeric.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          {split && <Segmented value={view} onChange={setView} options={[{ value: "dots", label: "Dots" }, { value: "curves", label: "Curves" }]} />}
        </div>
      }
    />
  );
}

export function DataTab({ api }: { api: ProjectApi }) {
  const { engine, catalogue, fail, notify } = useApp();
  const { project, update, profile } = api;

  if (!profile) return <div className="page row"><Spinner /> Profiling the data…</div>;

  const applied = (s: Suggestion) => {
    if (!s.fix) return false;
    const list: Step[] = project[s.fix.stage];
    return list.some((step) => step.op === s.fix!.op && JSON.stringify(step.params.columns ?? null) === JSON.stringify(s.fix!.params.columns ?? null));
  };

  const addFix = async (s: Suggestion) => {
    if (!s.fix) return;
    try {
      const step = await engine.call<Step>("projects.new_step", { op: s.fix.op, params: s.fix.params });
      update((p) => ({ ...p, [s.fix!.stage]: [...p[s.fix!.stage], { ...step, note: s.message }] }));
      notify(`Added “${s.fix.label}” to the pipeline.`, "ok");
    } catch (error) {
      fail(error);
    }
  };

  const setTask = async (task: Task) => {
    const incompatible = project.models.some((m) => !catalogue.models.find((a) => a.id === m.algo)?.tasks.includes(task));
    let models = project.models;
    if (incompatible) {
      models = await Promise.all(DEFAULTS[task].map((algo) => engine.call<ModelEntry>("projects.new_model", { algo })));
      notify(`Switched to models that do ${task}.`);
    }
    update((p) => ({ ...p, task, models, metric: "auto" }));
  };

  if (profile.kind === "image") {
    return (
      <div className="page col" style={{ gap: 16 }}>
        <div className="stat-row">
          <div className="stat"><div className="value">{profile.rows.toLocaleString()}</div><div className="label">images</div></div>
          <div className="stat"><div className="value">{profile.classes?.length}</div><div className="label">classes</div></div>
          <div className="stat"><div className="value">{profile.image_size?.max.join("×")}</div><div className="label">largest image (px)</div></div>
        </div>
        {profile.suggestions.map((s) => <Notice key={s.id} level={s.level === "error" ? "error" : s.level === "warning" ? "warning" : "info"}>{s.message}</Notice>)}
        <div className="grid2" style={{ alignItems: "start" }}>
          <div className="card">
            <h2>Images per class</h2>
            <Bars items={(profile.classes ?? []).map((c) => ({ label: c.value, value: c.count }))} format={(v) => fmt(v)} />
          </div>
          <div className="card">
            <h2>Examples</h2>
            <div className="col">
              {Object.entries(profile.samples ?? {}).map(([label, images]) => (
                <div className="row" key={label}>
                  <span className="dim small ellipsis" style={{ width: 80 }}>{label}</span>
                  <div className="thumbs">{images.map((src, i) => <img key={i} src={src} alt={label} />)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const columns = profile.columns ?? [];
  const target = profile.target;
  const metrics = catalogue.metrics[project.task] ?? [];
  const corr = profile.correlations;
  return (
    <ChartScopeContext.Provider value={{ projectId: project.id, runId: api.run?.id }}>
    <div className="page col" style={{ gap: 18 }}>
      <div className="stat-row" data-section="Overview">
        <div className="stat"><CountUp className="value" value={profile.rows} format={(v) => Math.round(v).toLocaleString()} /><div className="label">rows{profile.sampled ? " (profiled on a sample)" : ""}</div></div>
        <div className="stat"><CountUp className="value" value={columns.length} format={(v) => String(Math.round(v))} /><div className="label">columns</div></div>
        <div className="stat"><CountUp className="value" value={profile.missing_cells_pct} format={(v) => `${v.toFixed(1)}%`} /><div className="label">cells missing</div></div>
        <div className="stat"><CountUp className="value" value={profile.duplicates} format={(v) => Math.round(v).toLocaleString()} /><div className="label">duplicate rows</div></div>
        <div className="stat"><CountUp className="value" value={profile.memory_mb} format={(v) => `${v.toFixed(1)} MB`} /><div className="label">in memory</div></div>
      </div>

      <div className="grid2" style={{ alignItems: "start" }} data-section="What to predict">
        <div className="card">
          <div className="card-head"><Icon name="target" className="accent-text" /><h2>What to predict</h2></div>
          <div className="field">
            <label>Target column</label>
            <select value={project.target} onChange={(e) => update((p) => ({ ...p, target: e.target.value }))}>
              {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Kind of problem</label>
            <Segmented<Task> value={project.task} onChange={(t) => void setTask(t)} options={[{ value: "classification", label: "Classification" }, { value: "regression", label: "Regression" }]} />
          </div>
          <div className="field">
            <label>Rank models by</label>
            <select value={project.metric} onChange={(e) => update((p) => ({ ...p, metric: e.target.value }))}>
              {metrics.map(([value, label]) => <option key={value} value={value}>{label}{value === "auto" ? (project.task === "classification" ? " (F1 macro)" : " (R²)") : ""}</option>)}
            </select>
          </div>
          {target?.classes && project.task === "classification" && (
            <>
              <h3 className="section-title">Classes</h3>
              <Bars items={target.classes.slice(0, 15).map((c) => ({ label: c.value, value: c.count }))} format={(v) => fmt(v)} colour="var(--signal)" />
            </>
          )}
          {target?.histogram && project.task === "regression" && <DotHistogram edges={target.histogram.edges} groups={[{ label: target.name, counts: target.histogram.counts, colour: "var(--signal)" }]} height={150} />}
        </div>
        <div className="card">
          <div className="card-head"><Icon name="sparkles" className="accent-text" /><h2>Suggested fixes</h2></div>
          {profile.suggestions.length === 0 && <p className="dim">This data looks clean. Nothing to fix.</p>}
          {profile.suggestions.map((s) => (
            <div className="suggestion" key={s.id}>
              <Icon name={s.level === "error" ? "error" : s.level === "warning" ? "warning" : "info"} className={s.level === "error" ? "error-text" : s.level === "warning" ? "warn-text" : "accent-text"} />
              <div style={{ flex: 1 }} className="small">{s.message}</div>
              {s.fix && (applied(s) ? <span className="badge ok"><Icon name="check" size={10} /> in pipeline</span> : <button className="small" onClick={() => void addFix(s)}><Icon name="plus" size={11} /> {s.fix.label}</button>)}
            </div>
          ))}
        </div>
      </div>

      <div data-section="Distribution">
        <Distributions api={api} />
      </div>

      <div className="card" data-section="Columns">
        <div className="card-head"><h2>Columns</h2><span className="dim small">click Drop to remove a column in the Clean stage</span></div>
        <div className="table-wrap columns-table" style={{ maxHeight: 520 }}>
          <table>
            <thead>
              <tr><th>Column</th><th>Type</th><th>Missing</th><th>Unique</th><th>Distribution</th><th>Summary</th><th>Notes</th><th /></tr>
            </thead>
            <tbody>
              {columns.map((c) => (
                <tr key={c.name}>
                  <td><b className={c.name === project.target ? "accent-text" : ""}>{c.name}</b>{c.name === project.target && <span className="badge" style={{ marginLeft: 6 }}>target</span>}</td>
                  <td><KindBadge kind={c.kind} /></td>
                  <td style={{ minWidth: 110 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <div style={{ width: 50 }} className={`bar ${c.missing_pct > 30 ? "red" : c.missing_pct > 5 ? "orange" : "green"}`}><span style={{ width: `${Math.max(c.missing_pct, c.missing ? 3 : 0)}%` }} /></div>
                      <span className="small num dim">{c.missing_pct}%</span>
                    </div>
                  </td>
                  <td className="num dim">{c.unique.toLocaleString()}</td>
                  <td>{c.histogram ? <Spark counts={c.histogram.counts} colour="var(--c-blue)" /> : c.top ? <Spark counts={c.top.slice(0, 10).map((t) => t.count)} colour="var(--c-purple)" /> : null}</td>
                  <td className="small dim">
                    {c.stats && "mean" in c.stats ? `${fmt(c.stats.min)} – ${fmt(c.stats.max)}, mean ${fmt(c.stats.mean)}` : c.top ? c.top.slice(0, 3).map((t) => `${t.value} (${t.count})`).join(", ") : c.stats ? `${String(c.stats.min ?? "").slice(0, 10)} → ${String(c.stats.max ?? "").slice(0, 10)}` : ""}
                  </td>
                  <td className="flag">{c.flags.map((f) => FLAG_TEXT[f] ?? f).join(", ")}</td>
                  <td>
                    {c.name !== project.target && (
                      <button className="ghost small" onClick={() => void addFix({ id: `drop-${c.name}`, level: "info", auto: false, message: `Dropped ${c.name} from the Data page.`, fix: { stage: "clean", op: "drop_columns", params: { columns: [c.name] }, label: "Drop" } })}>
                        Drop
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {corr && corr.columns.length > 1 && (
        <div className="bento" data-section="Correlations">
          {chartSpecs({ project, profile, run: api.run, model: null })
            .filter((spec) => spec.id === "data-corr" || spec.id === "data-links")
            .map((spec) => (
              <div key={spec.id} className={spec.id === "data-corr" ? "bento-l" : "bento-s"}>
                <ChartCard spec={spec} />
              </div>
            ))}
        </div>
      )}

      <div className="row" style={{ justifyContent: "center" }}>
        <button onClick={() => api.setTab("analyze")}>
          <Icon name="table" size={14} /> See every row, sort, search and query it in Analyze
        </button>
      </div>
    </div>
    </ChartScopeContext.Provider>
  );
}
