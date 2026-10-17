import { useEffect, useState } from "react";
import { useApp } from "../context";
import { Bars, Heatmap, Histogram, Spark } from "../charts/charts";
import { Icon } from "../components/Icon";
import { KindBadge, Notice, Segmented, Spinner } from "../components/ui";
import { cell, fmt } from "../format";
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

export function DataTab({ api }: { api: ProjectApi }) {
  const { engine, catalogue, fail, notify } = useApp();
  const { project, update, profile } = api;
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<{ columns: string[]; rows: unknown[][]; total: number } | null>(null);

  useEffect(() => {
    if (project.kind !== "tabular") return;
    engine
      .call<{ columns: string[]; rows: unknown[][]; total: number }>("datasets.preview", { dataset_id: project.dataset_id, offset: page * 50, limit: 50 })
      .then(setRows)
      .catch(fail);
  }, [engine, project.dataset_id, project.kind, page, fail]);

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
    <div className="page col" style={{ gap: 18 }}>
      <div className="stat-row">
        <div className="stat"><div className="value">{profile.rows.toLocaleString()}</div><div className="label">rows{profile.sampled ? " (profiled on a sample)" : ""}</div></div>
        <div className="stat"><div className="value">{columns.length}</div><div className="label">columns</div></div>
        <div className="stat"><div className="value">{profile.missing_cells_pct}%</div><div className="label">cells missing</div></div>
        <div className="stat"><div className="value">{profile.duplicates}</div><div className="label">duplicate rows</div></div>
        <div className="stat"><div className="value">{profile.memory_mb} MB</div><div className="label">in memory</div></div>
      </div>

      <div className="grid2" style={{ alignItems: "start" }}>
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
              <Bars items={target.classes.slice(0, 15).map((c) => ({ label: c.value, value: c.count }))} format={(v) => fmt(v)} colour="var(--c-orange)" />
            </>
          )}
          {target?.histogram && project.task === "regression" && <Histogram edges={target.histogram.edges} counts={target.histogram.counts} colour="var(--c-orange)" />}
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

      <div className="card">
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
                  <td>{c.histogram ? <Spark counts={c.histogram.counts} /> : c.top ? <Spark counts={c.top.slice(0, 10).map((t) => t.count)} colour="var(--c-purple)" /> : null}</td>
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
        <div className="grid2" style={{ alignItems: "start" }}>
          <div className="card">
            <h2>How numbers move together</h2>
            <p className="dim small" style={{ marginBottom: 8 }}>Correlation from −1 (opposite) to 1 (together). Very high values mean two columns carry the same information.</p>
            <Heatmap labels={corr.columns.slice(0, 16)} matrix={corr.matrix.slice(0, 16).map((r) => r.slice(0, 16))} diverging format={(v) => v.toFixed(2)} />
          </div>
          {corr.with_target && corr.with_target.length > 0 && (
            <div className="card">
              <h2>Strongest links to {project.target}</h2>
              <p className="dim small" style={{ marginBottom: 8 }}>Absolute correlation with the target. Only a first hint: models also find non-linear patterns.</p>
              <Bars items={corr.with_target.slice(0, 12).map((c) => ({ label: c.column, value: c.value }))} max={1} format={(v) => v.toFixed(2)} />
            </div>
          )}
        </div>
      )}

      {rows && (
        <div className="card">
          <div className="card-head">
            <h2>Rows</h2>
            <span className="dim small">{(page * 50 + 1).toLocaleString()}–{Math.min(rows.total, page * 50 + 50).toLocaleString()} of {rows.total.toLocaleString()}</span>
            <span className="spacer" />
            <button className="small" disabled={page === 0} onClick={() => setPage(page - 1)}><Icon name="arrowLeft" size={12} /></button>
            <button className="small" disabled={(page + 1) * 50 >= rows.total} onClick={() => setPage(page + 1)}><Icon name="arrowRight" size={12} /></button>
          </div>
          <div className="table-wrap" style={{ maxHeight: 420 }}>
            <table>
              <thead><tr>{rows.columns.map((c) => <th key={c} style={c === project.target ? { color: "var(--accent)" } : undefined}>{c}</th>)}</tr></thead>
              <tbody>
                {rows.rows.map((row, i) => (
                  <tr key={i}>{row.map((v, j) => <td key={j} className={v === null ? "cell-null" : ""}>{v === null ? "empty" : cell(v)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
