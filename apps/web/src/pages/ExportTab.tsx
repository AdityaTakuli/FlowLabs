import { useEffect, useState } from "react";
import { useApp } from "../context";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { Notice, Spinner, Switch } from "../components/ui";
import { bytes } from "../format";
import type { ExportResult } from "../types";
import { ModelChooser } from "./ModelChooser";
import type { ProjectApi } from "./ProjectPage";

const FILE_INFO: Record<string, string> = {
  "model.joblib": "the trained pipeline: raw rows in, predictions out",
  "flowlabs_runtime.py": "the small module the pipeline needs (no FlowLabs install)",
  "predict.py": "python predict.py new.csv → predictions.csv",
  "serve.py": "a tiny HTTP prediction server",
  "train.py": "the same training as an editable Python script",
  "schema.json": "input columns, types and allowed values",
  "example.csv": "five rows in the expected format",
  "requirements.txt": "packages pinned to the versions used",
  "MODEL_CARD.md": "what the model is and how well it does",
  "model.pt": "TorchScript network: torch.jit.load, no FlowLabs needed",
  "model.onnx": "ONNX network for onnxruntime, C++, C#, JavaScript, mobile",
  "labels.json": "class names in output order",
  "preprocess.json": "image size and normalisation",
};


export function ExportTab({ api }: { api: ProjectApi }) {
  const { engine, fail, notify } = useApp();
  const { run, project } = api;
  const [modelId, setModelId] = useState(run?.best_model_id ?? "");
  const [includeData, setIncludeData] = useState(false);
  const [built, setBuilt] = useState<ExportResult | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setModelId(run?.best_model_id ?? "");
    setBuilt(null);
  }, [run?.id, run?.best_model_id]);

  if (!run) return <div className="page"><div className="empty">Train a model first; then export it here.</div></div>;
  const record = run.models.find((m) => m.id === modelId);
  const image = project.kind === "image";

  const build = async () => {
    setBusy(true);
    try {
      const result = await engine.call<ExportResult>("export.build", { project_id: project.id, run_id: run.id, model_id: modelId, include_data: includeData });
      setBuilt(result);
      api.markExported();
      notify("Export ready.", "ok");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const python = image
    ? `import torch, json\nmodel = torch.jit.load("model.pt")\nlabels = json.load(open("labels.json"))\n# python predict.py photo.jpg`
    : `import joblib, pandas as pd\n\nmodel = joblib.load("model.joblib")   # keep flowlabs_runtime.py next to it\nrows = pd.read_csv("new_rows.csv")\nmodel.predict(rows)${run.task === "classification" ? "\nmodel.predict_proba(rows)          # one column per class" : ""}`;
  const shell = image
    ? `pip install -r requirements.txt\npython predict.py photo.jpg`
    : `pip install -r requirements.txt\npython predict.py example.csv -o predictions.csv\npython serve.py --port 8000\ncurl -X POST localhost:8000/predict -d '{"rows": [${JSON.stringify(Object.fromEntries((run.schema?.columns ?? []).filter((c) => c.used).slice(0, 2).map((c) => [c.name, c.example])))}]}'`;

  return (
    <div className="page col" style={{ gap: 16 }}>
      <div className="row">
        <h2>Export</h2>
        <ModelChooser run={run} value={modelId} onChange={(id) => { setModelId(id); setBuilt(null); }} />
      </div>
      <div className="grid2" style={{ alignItems: "start" }}>
        <div className="card">
          <div className="card-head"><Icon name="package" className="accent-text" /><h3>{record?.label}</h3></div>
          <p className="dim small" style={{ marginBottom: 12 }}>
            {image
              ? "A TorchScript network (and ONNX when available) with its labels, preprocessing settings, a prediction script and a model card."
              : "A folder that runs on any computer with Python: the whole pipeline (cleaning, transforms, model) in one file, scripts to predict and serve, the training as editable code, and a model card."}
          </p>
          {!image && <div className="field"><Switch on={includeData} onChange={setIncludeData} label="Include the training data (so train.py runs as is)" /></div>}
          <button className="primary" disabled={busy || !record} onClick={() => void build()}>
            {busy ? <Spinner /> : <Icon name="package" />} {built ? "Build again" : "Build export"}
          </button>
          {built && (
            <div className="col" style={{ marginTop: 16 }}>
              <button className="accent" style={{ whiteSpace: "normal", padding: "8px 14px" }} onClick={() => void engine.download(built.zip.path, built.zip.name).catch(fail)}>
                <Icon name="download" /> Download {built.zip.name} ({bytes(built.zip.size)})
              </button>
              {built.notes.map((n, i) => <Notice key={i} level="info">{n}</Notice>)}
              <div className="file-list">
                {built.files.map((f) => (
                  <div className="file" key={f.name}>
                    <Icon name="file" className="dim" />
                    <div style={{ minWidth: 0 }}>
                      <div className="mono small">{f.name}</div>
                      <div className="faint tiny">{FILE_INFO[f.name] ?? ""}</div>
                    </div>
                    <span className="dim tiny">{bytes(f.size)}</span>
                    <button className="ghost icon-only" onClick={() => void engine.download(f.path, f.name).catch(fail)} aria-label={`Download ${f.name}`}><Icon name="download" size={12} /></button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="col" style={{ gap: 12 }}>
          <div className="card">
            <h3 className="section-title">Use it from Python</h3>
            <pre className="code">{python}</pre>
          </div>
          <div className="card">
            <h3 className="section-title">Use it from a terminal</h3>
            <pre className="code">{shell}</pre>
          </div>
        </div>
      </div>
      {built && (
        <div className="card">
          <h3 className="section-title">Model card</h3>
          <Markdown text={built.model_card} />
        </div>
      )}
    </div>
  );
}
