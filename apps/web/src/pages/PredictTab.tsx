import { useEffect, useRef, useState } from "react";
import { useApp } from "../context";
import { Icon } from "../components/Icon";
import { Bar, KindBadge, Notice, Spinner } from "../components/ui";
import { cell, fmt, pct } from "../format";
import type { DatasetMeta, SchemaColumn } from "../types";
import { DropZone } from "./NewProject";
import { ModelChooser } from "./ModelChooser";
import type { ProjectApi } from "./ProjectPage";

interface Answer {
  predictions: unknown[];
  classes?: string[];
  probabilities?: number[][];
}

function initial(columns: SchemaColumn[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const c of columns) {
    if (!c.used) continue;
    if (c.kind === "numeric") values[c.name] = c.median !== undefined ? String(c.integer ? Math.round(c.median) : Number(c.median.toPrecision(4))) : "";
    else if (c.values?.length) values[c.name] = c.values[0]!;
    else values[c.name] = c.example === null || c.example === undefined ? "" : String(c.example);
  }
  return values;
}

function Probabilities({ classes, values }: { classes: string[]; values: number[] }) {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]).slice(0, 10);
  return (
    <div>
      {order.map(([v, i]) => (
        <div className="prob-row" key={classes[i]}>
          <span className="ellipsis">{classes[i]}</span>
          <Bar value={v} />
          <span className="num small" style={{ textAlign: "right" }}>{pct(v)}</span>
        </div>
      ))}
    </div>
  );
}

function ImagePredict({ api, modelId }: { api: ProjectApi; modelId: string }) {
  const { engine, fail } = useApp();
  const [results, setResults] = useState<{ name: string; image: string; prediction: string; probabilities: { label: string; value: number }[] }[]>([]);
  const [busy, setBusy] = useState(false);
  const predict = async (file: File) => {
    setBusy(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const answer = await engine.call<{ prediction: string; image: string; probabilities: { label: string; value: number }[] }>("predict.image", {
        project_id: api.project.id, run_id: api.run!.id, model_id: modelId, image: data,
      });
      setResults((list) => [{ name: file.name, ...answer }, ...list].slice(0, 12));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="col" style={{ gap: 14 }}>
      <DropZone accept="image/*" label="Drop an image to classify it, or click to choose one" onFile={(f) => void predict(f)} />
      {busy && <div className="row"><Spinner /> Classifying…</div>}
      <div className="chart-grid">
        {results.map((r, i) => (
          <div className="chart-card row top" key={i} style={{ gap: 14 }}>
            <img src={r.image} alt={r.name} style={{ width: 96, height: 96, borderRadius: 6, border: "1px solid var(--border)", imageRendering: "pixelated" }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="faint tiny ellipsis">{r.name}</div>
              <div className="big-answer">{r.prediction}</div>
              <Probabilities classes={r.probabilities.map((p) => p.label)} values={r.probabilities.map((p) => p.value)} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PredictTab({ api }: { api: ProjectApi }) {
  const { engine, fail } = useApp();
  const { run, project } = api;
  const [modelId, setModelId] = useState(run?.best_model_id ?? "");
  const columns = (run?.schema?.columns ?? []).filter((c) => c.used);
  const [values, setValues] = useState<Record<string, string>>(() => initial(columns));
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [batch, setBatch] = useState<{ path: string; name: string; rows: number; header: string[]; preview: unknown[][] } | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setModelId(run?.best_model_id ?? ""), [run?.id, run?.best_model_id]);
  useEffect(() => setValues(initial((run?.schema?.columns ?? []).filter((c) => c.used))), [run?.id, run?.schema]);
  useEffect(() => {
    engine.call<DatasetMeta[]>("datasets.list").then((d) => setDatasets(d.filter((x) => x.kind === "tabular"))).catch(fail);
  }, [engine, fail]);

  useEffect(() => {
    if (!run || project.kind !== "tabular" || !modelId) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setBusy(true);
      engine
        .call<Answer>("predict.rows", { project_id: project.id, run_id: run.id, model_id: modelId, rows: [values] })
        .then(setAnswer)
        .catch(fail)
        .finally(() => setBusy(false));
    }, 250);
  }, [engine, run, project.id, project.kind, modelId, values, fail]);

  if (!run) return <div className="page"><div className="empty">Train a model first; then try it here.</div></div>;

  const scoreDataset = async (datasetId: string) => {
    setBatchBusy(true);
    try {
      setBatch(await engine.call("predict.dataset", { project_id: project.id, run_id: run.id, model_id: modelId, dataset_id: datasetId }));
    } catch (error) {
      fail(error);
    } finally {
      setBatchBusy(false);
    }
  };
  const uploadAndScore = async (file: File) => {
    setBatchBusy(true);
    try {
      const meta = await engine.upload(file);
      setDatasets((d) => [meta, ...d]);
      await scoreDataset(meta.id);
    } catch (error) {
      fail(error);
      setBatchBusy(false);
    }
  };

  return (
    <div className="page col" style={{ gap: 16 }}>
      <div className="row">
        <h2>Try the model</h2>
        <ModelChooser run={run} value={modelId} onChange={setModelId} />
      </div>
      {project.kind === "image" ? (
        <ImagePredict api={api} modelId={modelId} />
      ) : (
        <>
          <div className="grid2" style={{ gridTemplateColumns: "minmax(0, 1.6fr) minmax(0, 1fr)", alignItems: "start" }}>
            <div className="card">
              <div className="card-head">
                <h3>Inputs</h3>
                <span className="dim small">change any value: the prediction updates</span>
                <span className="spacer" />
                <button className="small" onClick={() => setValues(initial(columns))}>Reset</button>
              </div>
              <div className="predict-form">
                {columns.map((c) => (
                  <div className="field" key={c.name}>
                    <label>{c.name} <KindBadge kind={c.kind} /></label>
                    {c.values && c.values.length > 0 ? (
                      <select value={values[c.name] ?? ""} onChange={(e) => setValues({ ...values, [c.name]: e.target.value })}>
                        <option value="">(missing)</option>
                        {c.values.map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    ) : (
                      <input
                        type={c.kind === "numeric" ? "number" : "text"}
                        value={values[c.name] ?? ""}
                        placeholder={c.kind === "numeric" ? `${fmt(c.min)} – ${fmt(c.max)}` : String(c.example ?? "")}
                        onChange={(e) => setValues({ ...values, [c.name]: e.target.value })}
                      />
                    )}
                    {c.kind === "numeric" && c.min !== undefined && <span className="help">seen {fmt(c.min)} to {fmt(c.max)}</span>}
                  </div>
                ))}
              </div>
            </div>
            <div className="card" style={{ position: "sticky", top: 16 }}>
              <div className="card-head"><h3>Prediction for {run.target}</h3>{busy && <Spinner />}</div>
              {answer && (
                <>
                  <div className="big-answer">{answer.classes ? String(answer.predictions[0]) : fmt(answer.predictions[0] as number, 4)}</div>
                  {answer.classes && answer.probabilities && (
                    <div style={{ marginTop: 10 }}>
                      <Probabilities classes={answer.classes} values={answer.probabilities[0]!} />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><Icon name="table" /><h3>Score a whole file</h3><span className="dim small">adds predicted_{run.target}{run.task === "classification" ? " and probability columns" : ""}</span></div>
            <div className="grid2">
              <DropZone accept=".csv,.tsv,.txt,.xlsx,.xls,.parquet,.json,.jsonl" label="Drop a file with the same columns" onFile={(f) => void uploadAndScore(f)} />
              <div className="col">
                <span className="dim small">or pick a dataset in this engine:</span>
                <div className="row wrap">
                  {datasets.map((d) => <button key={d.id} className="small" disabled={batchBusy} onClick={() => void scoreDataset(d.id)}>{d.name}</button>)}
                </div>
              </div>
            </div>
            {batchBusy && <div className="row" style={{ marginTop: 10 }}><Spinner /> Scoring…</div>}
            {batch && (
              <div className="col" style={{ marginTop: 12 }}>
                <div className="row">
                  <Notice level="ok">Scored {batch.rows.toLocaleString()} rows.</Notice>
                  <button className="primary" onClick={() => void engine.download(batch.path, batch.name).catch(fail)}><Icon name="download" /> Download CSV</button>
                </div>
                <div className="table-wrap" style={{ maxHeight: 300 }}>
                  <table>
                    <thead><tr>{batch.header.map((h) => <th key={h} className={h.startsWith("predicted_") || h.startsWith("probability_") ? "added" : ""}>{h}</th>)}</tr></thead>
                    <tbody>{batch.preview.slice(0, 20).map((row, i) => <tr key={i}>{row.map((v, j) => <td key={j} className={batch.header[j]!.startsWith("predicted_") ? "added" : ""}>{cell(v)}</td>)}</tr>)}</tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
