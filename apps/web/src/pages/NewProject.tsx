import { useEffect, useRef, useState } from "react";
import { useApp } from "../context";
import { Icon } from "../components/Icon";
import { KindBadge, Modal, Notice, Segmented, Spinner } from "../components/ui";
import { bytes, cell } from "../format";
import type { DatasetMeta, ModelEntry, Profile, Project, Task } from "../types";

const DEFAULTS: Record<Task, string[]> = {
  classification: ["baseline", "logistic_regression", "random_forest", "hist_gradient_boosting"],
  regression: ["baseline", "linear_regression", "random_forest", "hist_gradient_boosting"],
};

export function DropZone({ onFile, accept, label }: { onFile: (file: File) => void; accept: string; label: string }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`dropzone ${over ? "over" : ""}`}
      onClick={() => input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const file = e.dataTransfer.files[0];
        if (file) onFile(file);
      }}
      role="button"
      tabIndex={0}
    >
      <Icon name="upload" size={22} />
      <div style={{ marginTop: 8 }}>{label}</div>
      <input ref={input} type="file" accept={accept} style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
    </div>
  );
}

export function NewProject({ onClose, onCreated, initialDataset }: { onClose: () => void; onCreated: (id: string) => void; initialDataset?: DatasetMeta }) {
  const { engine, catalogue, fail } = useApp();
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [dataset, setDataset] = useState<DatasetMeta | null>(initialDataset ?? null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [preview, setPreview] = useState<{ columns: string[]; rows: unknown[][] } | null>(null);
  const [target, setTarget] = useState("");
  const [task, setTask] = useState<Task>("classification");
  const [name, setName] = useState("");

  useEffect(() => {
    engine.call<DatasetMeta[]>("datasets.list").then(setDatasets).catch(fail);
  }, [engine, fail]);

  useEffect(() => {
    if (!dataset) return;
    setBusy("Reading the data…");
    setName(dataset.name);
    Promise.all([
      engine.call<Profile>("datasets.profile", { dataset_id: dataset.id }),
      dataset.kind === "tabular" ? engine.call<{ columns: string[]; rows: unknown[][] }>("datasets.preview", { dataset_id: dataset.id, limit: 6 }) : Promise.resolve(null),
    ])
      .then(([loaded, rows]) => {
        setProfile(loaded);
        setPreview(rows);
        setTarget(loaded.suggested_target);
        if (loaded.target) setTask(loaded.target.task);
      })
      .catch(fail)
      .finally(() => setBusy(null));
  }, [dataset, engine, fail]);

  const changeTarget = async (column: string) => {
    if (!dataset) return;
    setTarget(column);
    try {
      const loaded = await engine.call<Profile>("datasets.profile", { dataset_id: dataset.id, target: column });
      setProfile(loaded);
      if (loaded.target) setTask(loaded.target.task);
    } catch (error) {
      fail(error);
    }
  };

  const importSample = async (sampleId: string) => {
    setBusy("Preparing the sample…");
    try {
      setDataset(await engine.call<DatasetMeta>("datasets.import_sample", { sample_id: sampleId }));
    } catch (error) {
      fail(error);
      setBusy(null);
    }
  };

  const upload = async (file: File) => {
    setBusy(`Uploading ${file.name} (${bytes(file.size)})…`);
    try {
      setDataset(await engine.upload(file));
    } catch (error) {
      fail(error);
      setBusy(null);
    }
  };

  const create = async () => {
    if (!dataset) return;
    setBusy("Creating the project…");
    try {
      let project = await engine.call<Project>("projects.create", { dataset_id: dataset.id, name, target });
      if (project.kind === "tabular" && project.task !== task) {
        const models = await Promise.all(DEFAULTS[task].map((algo) => engine.call<ModelEntry>("projects.new_model", { algo })));
        project = await engine.call<Project>("projects.save", { project: { ...project, task, models } });
      }
      onCreated(project.id);
    } catch (error) {
      fail(error);
      setBusy(null);
    }
  };

  const imageEngine = Boolean(engine.kind !== "browser");
  return (
    <Modal
      title={dataset ? "Set up the project" : "New project: choose data"}
      onClose={onClose}
      wide
      footer={
        dataset ? (
          <>
            <button onClick={() => { setDataset(null); setProfile(null); }}>
              <Icon name="arrowLeft" /> Other data
            </button>
            <span className="spacer" />
            <button className="primary" disabled={!profile || busy !== null || (profile.kind === "tabular" && !target)} onClick={() => void create()}>
              Create project <Icon name="arrowRight" />
            </button>
          </>
        ) : undefined
      }
    >
      {busy && (
        <div className="row" style={{ marginBottom: 12 }}>
          <Spinner /> {busy}
        </div>
      )}
      {!dataset && (
        <div className="col" style={{ gap: 18 }}>
          <DropZone onFile={(f) => void upload(f)} accept=".csv,.tsv,.txt,.xlsx,.xls,.parquet,.json,.jsonl,.zip" label="Drop a CSV, Excel, Parquet or JSON file, or a zip of image folders (one folder per class). Click to browse." />
          <div>
            <h3 className="section-title">Or start from a sample</h3>
            <div className="sample-grid">
              {catalogue.samples.map((sample) => (
                <button key={sample.id} className="sample" disabled={busy !== null} onClick={() => void importSample(sample.id)}>
                  <div className="row">
                    <Icon name={sample.kind === "image" ? "image" : "table"} />
                    <b>{sample.name}</b>
                  </div>
                  <span className="dim small">{sample.description}</span>
                  <div className="row">
                    <span className="badge">{sample.task}</span>
                    {sample.kind === "image" && !imageEngine && <span className="badge warning">needs an engine with PyTorch</span>}
                  </div>
                </button>
              ))}
            </div>
          </div>
          {datasets.length > 0 && (
            <div>
              <h3 className="section-title">Or reuse a dataset</h3>
              <div className="row wrap">
                {datasets.map((d) => (
                  <button key={d.id} onClick={() => setDataset(d)}>
                    <Icon name={d.kind === "image" ? "image" : "table"} /> {d.name} <span className="dim small">{d.rows.toLocaleString()} {d.kind === "image" ? "images" : "rows"}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {dataset && profile && (
        <div className="col" style={{ gap: 16 }}>
          <div className="row">
            <div className="field" style={{ flex: 1, marginBottom: 0 }}>
              <label>Project name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>
          <div className="stat-row">
            <div className="stat">
              <div className="value">{profile.rows.toLocaleString()}</div>
              <div className="label">{profile.kind === "image" ? "images" : "rows"}</div>
            </div>
            <div className="stat">
              <div className="value">{profile.kind === "image" ? profile.classes?.length : profile.columns?.length}</div>
              <div className="label">{profile.kind === "image" ? "classes" : "columns"}</div>
            </div>
            {profile.kind === "tabular" && (
              <div className="stat">
                <div className="value">{profile.missing_cells_pct}%</div>
                <div className="label">cells missing</div>
              </div>
            )}
          </div>
          {profile.kind === "tabular" ? (
            <>
              <div className="grid2">
                <div className="field">
                  <label>What should the model predict? (target column)</label>
                  <select value={target} onChange={(e) => void changeTarget(e.target.value)}>
                    {profile.columns?.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name} ({c.kind}, {c.unique} values)
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Kind of problem</label>
                  <Segmented<Task>
                    value={task}
                    onChange={setTask}
                    options={[
                      { value: "classification", label: "Classification (pick a category)" },
                      { value: "regression", label: "Regression (predict a number)" },
                    ]}
                  />
                </div>
              </div>
              {profile.target?.classes && task === "classification" && (
                <div className="row wrap small">
                  <span className="dim">Classes:</span>
                  {profile.target.classes.slice(0, 12).map((c) => (
                    <span key={c.value} className="badge solid">
                      {c.value} · {c.count}
                    </span>
                  ))}
                </div>
              )}
              {preview && (
                <div className="table-wrap" style={{ maxHeight: 220 }}>
                  <table>
                    <thead>
                      <tr>
                        {preview.columns.map((c) => (
                          <th key={c} style={c === target ? { color: "var(--accent)" } : undefined}>
                            {c} {profile.columns && <KindBadge kind={profile.columns.find((x) => x.name === c)?.kind ?? ""} />}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row, i) => (
                        <tr key={i}>
                          {row.map((v, j) => (
                            <td key={j} className={v === null ? "cell-null" : ""}>
                              {v === null ? "empty" : cell(v)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {profile.suggestions.some((s) => s.auto && s.fix?.stage === "clean") && (
                <Notice level="ok" icon="sparkles">
                  <b>Synapse will add these fixes for you</b> (you can remove them):
                  <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                    {profile.suggestions
                      .filter((s) => s.auto && s.fix?.stage === "clean")
                      .map((s) => (
                        <li key={s.id} className="small">
                          <b>{s.fix!.label}:</b> <span className="dim">{s.message}</span>
                        </li>
                      ))}
                  </ul>
                </Notice>
              )}
            </>
          ) : (
            <>
              <div className="row wrap">
                {profile.classes?.map((c) => (
                  <span key={c.value} className="badge solid">
                    {c.value} · {c.count}
                  </span>
                ))}
              </div>
              {profile.samples && (
                <div className="col">
                  {Object.entries(profile.samples)
                    .slice(0, 4)
                    .map(([label, images]) => (
                      <div className="row" key={label}>
                        <span className="dim small" style={{ width: 70 }}>
                          {label}
                        </span>
                        <div className="thumbs">
                          {images.slice(0, 6).map((src, i) => (
                            <img key={i} src={src} alt={label} />
                          ))}
                        </div>
                      </div>
                    ))}
                </div>
              )}
              {!imageEngine && <Notice level="warning">Image models need PyTorch, which the browser engine does not have. You can set up the project now and connect an engine (Engine menu) to train.</Notice>}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
