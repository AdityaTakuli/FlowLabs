import { useEffect, useMemo, useState } from "react";
import { Bars, Heatmap, Histogram, LineChart, Scatter, type Series } from "../charts/charts";
import { Icon } from "../components/Icon";
import { Notice, Segmented, Spinner } from "../components/ui";
import { ago, duration, fmt, LOWER_IS_BETTER, metricValue } from "../format";
import type { EpochPoint, ModelResult, RunResult } from "../types";
import type { ProjectApi } from "./ProjectPage";
import type { LiveModel, Training } from "./useTraining";

const COLUMNS = {
  classification: ["accuracy", "balanced_accuracy", "f1_macro", "roc_auc", "log_loss"],
  regression: ["r2", "rmse", "mae", "mape"],
};
const LABELS: Record<string, string> = {
  accuracy: "Accuracy", balanced_accuracy: "Balanced acc.", f1_macro: "F1", roc_auc: "ROC AUC", log_loss: "Log loss",
  r2: "R²", rmse: "RMSE", mae: "MAE", mape: "MAPE", f1_weighted: "F1 (weighted)", precision_macro: "Precision", recall_macro: "Recall",
};
const EXPLAIN: Record<string, string> = {
  accuracy: "Share of test rows predicted correctly.",
  balanced_accuracy: "Accuracy averaged over classes, so rare classes count as much as common ones.",
  f1_macro: "Balance of precision and recall, averaged over classes. Robust when classes are uneven.",
  roc_auc: "How well the model ranks positives above negatives: 0.5 is guessing, 1 is perfect.",
  log_loss: "Penalises confident wrong answers. Lower is better.",
  r2: "Share of the target's variation explained: 0 is guessing the average, 1 is perfect.",
  rmse: "Typical error, in the target's units. Lower is better.",
  mae: "Average absolute error, in the target's units. Lower is better.",
  mape: "Average error as a percentage of the true value. Lower is better.",
};

function curves(history: EpochPoint[]): { loss: Series[]; score: Series[] } {
  const pick = (key: string) => history.filter((h) => typeof h[key] === "number").map((h) => [h.epoch, h[key]!] as [number, number]);
  const loss: Series[] = [{ name: "training loss", points: pick("loss") }, { name: "validation loss", points: pick("val_loss"), colour: "#f472b6" }].filter((s) => s.points.length);
  const score: Series[] = ["val_accuracy", "val_r2"].map((k) => ({ name: k.replace("val_", "validation "), points: pick(k), colour: "#86efac" })).filter((s) => s.points.length);
  return { loss, score };
}

function TrainingPanel({ training }: { training: Training }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!training.running) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [training.running]);
  const withCurves = training.models.filter((m) => m.epochs.length > 0);
  const status = (m: LiveModel) =>
    m.status === "done" ? <Icon name="check" className="ok-text" /> : m.status === "failed" ? <Icon name="error" className="error-text" /> : m.status === "running" || m.status === "explaining" ? <Spinner /> : m.status === "cancelled" ? <Icon name="stop" className="dim" /> : <Icon name="dot" className="faint" />;
  return (
    <div className="card training-panel">
      <div className="card-head">
        {training.running ? <Spinner /> : training.error ? <Icon name="error" className="error-text" /> : training.cancelled ? <Icon name="stop" /> : <Icon name="check" className="ok-text" />}
        <h2>{training.running ? "Training" : training.error ? "Training failed" : training.cancelled ? "Training stopped" : "Training finished"}</h2>
        <span className="dim small">{training.stage}</span>
        <span className="spacer" />
        <span className="dim small num">{duration((now - training.startedAt) / 1000)}</span>
      </div>
      {training.error && <Notice level="error">{training.error}</Notice>}
      <div>
        {training.models.map((m) => (
          <div className="train-model" key={m.id}>
            {status(m)}
            <div style={{ minWidth: 0 }}>
              <div className="row">
                <b>{m.label}</b>
                {m.trial && m.status === "running" && <span className="dim small">tuning {m.trial.trial}/{m.trial.of}</span>}
                {m.totalEpochs && m.status === "running" && <span className="dim small">epoch {m.epochs.at(-1)?.epoch ?? 0}/{m.totalEpochs}</span>}
                {m.status === "explaining" && <span className="dim small">measuring feature importance</span>}
              </div>
              {(m.status === "running" || m.status === "explaining") && m.progress !== undefined && <div className="bar" style={{ marginTop: 4 }}><span style={{ width: `${m.progress * 100}%` }} /></div>}
              {m.error && <div className="error-text small">{m.error}</div>}
            </div>
            <span className="small num">{m.metrics ? Object.entries(m.metrics).slice(0, 2).map(([k, v]) => `${LABELS[k] ?? k} ${metricValue(k, v)}`).join(" · ") : ""}</span>
          </div>
        ))}
      </div>
      {withCurves.length > 0 && (
        <div className="chart-grid">
          {withCurves.map((m) => {
            const { loss, score } = curves(m.epochs);
            return (
              <div className="chart-card" key={m.id}>
                <h3>{m.label}: loss per epoch</h3>
                <LineChart series={loss} xLabel="epoch" />
                {score.length > 0 && <LineChart series={score} height={120} xLabel="epoch" />}
              </div>
            );
          })}
        </div>
      )}
      {training.log.length > 0 && <div className="log">{training.log.slice(-60).join("\n")}</div>}
    </div>
  );
}

function ModelDetail({ run, model, api }: { run: RunResult; model: ModelResult; api: ProjectApi }) {
  const [normalized, setNormalized] = useState(false);
  const [importanceKind, setImportanceKind] = useState<"permutation" | "native">("permutation");
  if (model.status !== "done") {
    return <Notice level="error">{model.label} did not finish: {model.error ?? model.status}</Notice>;
  }
  const d = model.details ?? {};
  const metrics = COLUMNS[run.task].filter((m) => model.metrics?.[m] !== undefined);
  const importance = importanceKind === "permutation" ? model.importance?.permutation : model.importance?.native;
  const { loss, score } = curves(model.history ?? []);
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="card-head" style={{ marginBottom: 0 }}>
        <h2>{model.label}</h2>
        <span className="badge">{model.family}</span>
        {model.device && <span className="badge">{model.backend} · {model.device}</span>}
        {model.parameters && <span className="badge">{model.parameters.toLocaleString()} parameters</span>}
        <span className="spacer" />
        <button onClick={() => api.setTab("predict")}><Icon name="target" /> Try it</button>
        <button className="primary" onClick={() => api.setTab("export")}><Icon name="package" /> Export</button>
      </div>
      <div className="stat-row">
        {metrics.map((name) => (
          <div className="stat" key={name} title={EXPLAIN[name]}>
            <div className="value">{metricValue(name, model.metrics?.[name])}</div>
            <div className="label">{LABELS[name]} {name === run.metric && <span className="accent-text">· ranking</span>}</div>
            {model.train_metrics?.[name] !== undefined && <div className="faint tiny">training rows: {metricValue(name, model.train_metrics[name])}</div>}
          </div>
        ))}
        <div className="stat"><div className="value">{duration(model.fit_seconds)}</div><div className="label">to train</div><div className="faint tiny">{model.size_kb} KB on disk</div></div>
      </div>
      {model.cv && model.cv.mean !== null && (
        <Notice level="info">
          {model.cv.folds.length}-fold cross-validation ({LABELS[model.cv.metric] ?? model.cv.metric}): <b>{metricValue(model.cv.metric, model.cv.mean)}</b> ± {fmt(model.cv.std)} across folds{" "}
          <span className="dim">({model.cv.folds.map((f) => metricValue(model.cv!.metric, f)).join(", ")})</span>
        </Notice>
      )}
      <div className="chart-grid">
        {d.confusion && (
          <div className="chart-card">
            <div className="row" style={{ marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>Confusion matrix</h3>
              <span className="spacer" />
              <Segmented value={normalized ? "share" : "count"} onChange={(v) => setNormalized(v === "share")} options={[{ value: "count", label: "Counts" }, { value: "share", label: "Row %" }]} />
            </div>
            <p className="dim tiny" style={{ marginBottom: 6 }}>Rows: true class. Columns: predicted. The diagonal is correct.</p>
            <Heatmap labels={d.confusion.labels} matrix={d.confusion.matrix} normalizeRows={normalized} format={(v) => (normalized ? `${Math.round(v * 100)}` : fmt(v))} title={(r, c) => `true ${r}, predicted ${c}`} />
          </div>
        )}
        {d.roc && (
          <div className="chart-card">
            <h3>ROC curve · AUC {metricValue("roc_auc", model.metrics?.roc_auc)}</h3>
            <LineChart series={[{ name: `positive = ${d.positive_class}`, points: d.roc }]} diagonal domain={{ x: [0, 1], y: [0, 1] }} xLabel="false positive rate" area />
          </div>
        )}
        {d.pr && (
          <div className="chart-card">
            <h3>Precision vs recall</h3>
            <LineChart series={[{ name: "precision", points: d.pr, colour: "#c4b5fd" }]} domain={{ x: [0, 1], y: [0, 1] }} xLabel="recall" />
          </div>
        )}
        {d.calibration && d.calibration.length > 2 && (
          <div className="chart-card">
            <h3>Are probabilities honest?</h3>
            <LineChart series={[{ name: "observed share", points: d.calibration.map(([p, o]) => [p, o] as [number, number]), colour: "#fbbf24" }]} diagonal domain={{ x: [0, 1], y: [0, 1] }} xLabel="predicted probability" />
          </div>
        )}
        {d.scatter && (
          <div className="chart-card">
            <h3>Predicted vs actual</h3>
            <Scatter points={d.scatter} range={d.range} xLabel={`actual ${run.target}`} yLabel="predicted" />
          </div>
        )}
        {d.residual_histogram && (
          <div className="chart-card">
            <h3>Errors (actual − predicted)</h3>
            <Histogram edges={d.residual_histogram.edges} counts={d.residual_histogram.counts} colour="#f472b6" height={160} />
          </div>
        )}
        {importance && importance.length > 0 && (
          <div className="chart-card">
            <div className="row" style={{ marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>What drives predictions</h3>
              <span className="spacer" />
              {model.importance?.native?.length ? (
                <Segmented value={importanceKind} onChange={setImportanceKind} options={[{ value: "permutation", label: "Inputs" }, { value: "native", label: "Model's own" }]} />
              ) : null}
            </div>
            <p className="dim tiny" style={{ marginBottom: 6 }}>
              {importanceKind === "permutation" ? "How much the score drops when an input column is shuffled." : "The model's internal weights or split importance, per prepared feature."}
            </p>
            <Bars items={importance.slice(0, 15).map((f) => ({ label: f.feature, value: f.value }))} format={(v) => fmt(v)} signed />
          </div>
        )}
        {loss.length > 0 && (
          <div className="chart-card">
            <h3>Training curves</h3>
            <LineChart series={loss} xLabel="epoch" />
            {score.length > 0 && <LineChart series={score} height={110} xLabel="epoch" />}
          </div>
        )}
      </div>
      {d.per_class && d.per_class.length > 0 && (
        <div className="card">
          <h2>Per class</h2>
          <div className="table-wrap" style={{ maxHeight: 300 }}>
            <table>
              <thead><tr><th>Class</th><th>Precision</th><th>Recall</th><th>F1</th><th>Test rows</th></tr></thead>
              <tbody>
                {d.per_class.map((c) => (
                  <tr key={c.label}><td><b>{c.label}</b></td><td>{metricValue("accuracy", c.precision)}</td><td>{metricValue("accuracy", c.recall)}</td><td>{metricValue("accuracy", c.f1)}</td><td className="dim">{c.support}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {d.mistakes && d.mistakes.length > 0 && (
        <div className="card">
          <h2>Mistakes on test images</h2>
          <div className="mistakes">
            {d.mistakes.map((m, i) => (
              <figure key={i}>
                <img src={m.image} alt={`true ${m.true}`} />
                <figcaption><span className="error-text">{m.predicted}</span> <span className="dim">({Math.round(m.confidence * 100)}%)</span><br /><span className="faint">true: {m.true}</span></figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}
      {model.trials && model.trials.length > 0 && (
        <div className="card">
          <h2>Tuning trials</h2>
          <div className="table-wrap" style={{ maxHeight: 260 }}>
            <table>
              <thead><tr><th>#</th>{Object.keys(model.trials[0]!.params).map((k) => <th key={k}>{k}</th>)}<th>CV {LABELS[run.metric] ?? run.metric}</th></tr></thead>
              <tbody>
                {model.trials.map((t, i) => {
                  const best = JSON.stringify(t.params) === JSON.stringify(model.best_params);
                  return (
                    <tr key={i} className={best ? "selected" : ""}><td>{i + 1}</td>{Object.values(t.params).map((v, j) => <td key={j}>{String(v)}</td>)}<td>{metricValue(run.metric, t.score)} {best && <span className="badge ok">best</span>}</td></tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <details className="card">
        <summary className="dim">Settings used</summary>
        <pre className="code" style={{ marginTop: 10 }}>{JSON.stringify({ ...model.params, ...(model.best_params ?? {}) }, null, 2)}</pre>
      </details>
    </div>
  );
}

export function ResultsTab({ api, training, onTrain, trainable }: { api: ProjectApi; training: Training | null; onTrain: () => void; trainable: boolean }) {
  const { run, runs, openRun } = api;
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSelected(run?.best_model_id ?? null), [run?.id, run?.best_model_id]);
  const ranked = useMemo(() => {
    if (!run) return [];
    const better = (a: number | undefined, b: number | undefined) => {
      if (a === undefined) return 1;
      if (b === undefined) return -1;
      return LOWER_IS_BETTER.has(run.metric) ? a - b : b - a;
    };
    return [...run.models].sort((a, b) => better(a.metrics?.[run.metric], b.metrics?.[run.metric]));
  }, [run]);
  const model = run?.models.find((m) => m.id === selected) ?? null;
  const best = run?.models.find((m) => m.id === run.best_model_id);
  const columns = run ? COLUMNS[run.task] : [];

  return (
    <div className="page col" style={{ gap: 16 }}>
      {training && (training.running || training.error || !run || training.runId !== run.id) && <TrainingPanel training={training} />}
      {!run && !training && (
        <div className="empty">
          <Icon name="trophy" size={26} />
          <p style={{ marginTop: 8 }}>No results yet. Train the pipeline to compare models.</p>
          <button className="accent" style={{ marginTop: 12 }} disabled={!trainable} onClick={onTrain}><Icon name="play" /> Train now</button>
        </div>
      )}
      {run && (
        <>
          <div className="row">
            <h2>Results</h2>
            <select value={run.id} onChange={(e) => void openRun(e.target.value)} style={{ marginLeft: 8 }}>
              {runs.map((r) => <option key={r.id} value={r.id}>{ago(r.finished)} · {r.best_label ?? "no model"} {r.best_value !== null ? `(${metricValue(r.metric, r.best_value)})` : ""}</option>)}
            </select>
            <span className="dim small">{duration(run.seconds)} · {run.data.train_rows.toLocaleString()} training rows · {run.data.test_rows.toLocaleString()} test rows{run.data.features_out ? ` · ${run.data.features_in} inputs → ${run.data.features_out} features` : ""}</span>
          </div>
          {best && (
            <div className="notice ok">
              <Icon name="trophy" className="ok-text icon" />
              <div>
                <b>{best.label}</b> is the best model: {run.metric_label} <b>{metricValue(run.metric, best.metrics?.[run.metric])}</b> on rows it never saw.{" "}
                <span className="dim">{EXPLAIN[run.metric]}</span>
              </div>
            </div>
          )}
          {run.warnings.map((w, i) => <Notice key={i} level="warning">{w}</Notice>)}
          {run.data.row_steps && <Notice level="info">{run.data.row_steps}</Notice>}
          <div className="card">
            <h2>Leaderboard</h2>
            <div className="table-wrap leaderboard">
              <table>
                <thead>
                  <tr>
                    <th />
                    <th>Model</th>
                    {columns.map((c) => <th key={c} title={EXPLAIN[c]} style={c === run.metric ? { color: "var(--accent)" } : undefined}>{LABELS[c]}</th>)}
                    <th title="Cross-validation on training rows">CV</th>
                    <th title="Score on the rows it learned from: a big gap means overfitting">Train score</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((m, i) => (
                    <tr key={m.id} className={`clickable ${m.id === selected ? "selected" : ""}`} onClick={() => setSelected(m.id)}>
                      <td><span className={`rank ${m.id === run.best_model_id ? "first" : ""}`}>{m.status === "done" ? i + 1 : "–"}</span></td>
                      <td><b>{m.label}</b> <span className="faint tiny">{m.family}</span>{m.status === "failed" && <span className="badge error" style={{ marginLeft: 6 }}>failed</span>}</td>
                      {columns.map((c) => <td key={c} className={c === run.metric ? "accent-text" : ""}>{metricValue(c, m.metrics?.[c])}</td>)}
                      <td className="dim">{m.cv?.mean !== undefined && m.cv?.mean !== null ? `${metricValue(m.cv.metric, m.cv.mean)} ± ${fmt(m.cv.std, 2)}` : "–"}</td>
                      <td className="dim">{metricValue(run.metric, m.train_metrics?.[run.metric])}</td>
                      <td className="dim">{duration(m.fit_seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {model && <ModelDetail run={run} model={model} api={api} />}
          {run.data.auto_prep && run.data.auto_prep.length > 0 && (
            <details className="card">
              <summary className="dim">What Auto-prep did</summary>
              <div style={{ marginTop: 8 }}>{run.data.auto_prep.map((r) => <div key={r.column} className="small"><b>{r.column}</b>: <span className="dim">{r.detail}</span></div>)}</div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
