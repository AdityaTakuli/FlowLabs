import { useCallback, useEffect, useState } from "react";
import { useApp } from "../context";
import { Icon } from "../components/Icon";
import { TopBar } from "../components/TopBar";
import { Spinner } from "../components/ui";
import { ago, bytes, metricValue } from "../format";
import type { DatasetMeta, ProjectSummary } from "../types";
import { NewProject } from "./NewProject";

const QUICK = ["churn", "iris", "diabetes", "digits"];

/** The pipeline idea in one picture: data flows through stages into competing models. */
function HeroArt() {
  const stages = [
    { x: 40, y: 150, label: "Data", colour: "#7dd3fc" },
    { x: 150, y: 150, label: "Clean", colour: "#fbbf24" },
    { x: 260, y: 150, label: "Transform", colour: "#86efac" },
  ];
  const models = [
    { y: 70, label: "Forest", score: "91%" },
    { y: 150, label: "Network", score: "94%", best: true },
    { y: 230, label: "Boosting", score: "92%" },
  ];
  return (
    <div className="hero-art" aria-hidden>
      <svg viewBox="0 0 560 300">
        <defs>
          <linearGradient id="brand" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#7dd3fc" />
            <stop offset="1" stopColor="#a78bfa" />
          </linearGradient>
        </defs>
        {stages.slice(0, -1).map((s, i) => (
          <line key={s.label} className="flow-line" x1={s.x + 40} y1={s.y} x2={stages[i + 1]!.x - 40} y2={s.y} stroke="#4b525d" strokeWidth="2" />
        ))}
        {models.map((m) => (
          <path key={m.label} className="flow-line" d={`M300 150 C 340 150, 340 ${m.y}, 380 ${m.y}`} fill="none" stroke={m.best ? "url(#brand)" : "#4b525d"} strokeWidth="2" />
        ))}
        {stages.map((s) => (
          <g key={s.label}>
            <rect x={s.x - 40} y={s.y - 24} width="80" height="48" rx="12" fill="#0e1013" stroke="#343a44" />
            <rect x={s.x - 30} y={s.y - 8} width="16" height="16" rx="5" fill={s.colour} opacity="0.85" />
            <text x={s.x - 8} y={s.y + 4} fill="#eef0f3" fontSize="11" fontWeight="600" fontFamily="Inter Variable, sans-serif">
              {s.label}
            </text>
          </g>
        ))}
        {models.map((m) => (
          <g key={m.label}>
            <rect x="380" y={m.y - 26} width="150" height="52" rx="12" fill="#0e1013" stroke={m.best ? "url(#brand)" : "#343a44"} strokeWidth={m.best ? 2 : 1} />
            <text x="396" y={m.y - 4} fill="#a2a9b4" fontSize="11" fontFamily="Inter Variable, sans-serif">
              {m.label}
            </text>
            <text x="396" y={m.y + 15} fill={m.best ? "#86efac" : "#eef0f3"} fontSize="16" fontWeight="700" fontFamily="Inter Variable, sans-serif">
              {m.score}
            </text>
            {m.best && (
              <text x="470" y={m.y + 15} fill="#7dd3fc" fontSize="10" fontWeight="700" fontFamily="Inter Variable, sans-serif">
                BEST
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

export function Home({ open }: { open: (id: string) => void }) {
  const { engine, info, catalogue, fail, openEngine, notify } = useApp();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [creating, setCreating] = useState<DatasetMeta | true | null>(null);
  const [loadingSample, setLoadingSample] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([engine.call<ProjectSummary[]>("projects.list"), engine.call<DatasetMeta[]>("datasets.list")]);
      setProjects(p);
      setDatasets(d);
    } catch (error) {
      fail(error);
    }
  }, [engine, fail]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const startSample = async (sampleId: string) => {
    setLoadingSample(sampleId);
    try {
      setCreating(await engine.call<DatasetMeta>("datasets.import_sample", { sample_id: sampleId }));
    } catch (error) {
      fail(error);
    } finally {
      setLoadingSample(null);
    }
  };

  const remove = async (project: ProjectSummary) => {
    if (!window.confirm(`Delete “${project.name}” and its trained models?`)) return;
    try {
      await engine.call("projects.delete", { project_id: project.id });
      notify("Project deleted.", "ok");
      void reload();
    } catch (error) {
      fail(error);
    }
  };

  const removeDataset = async (dataset: DatasetMeta) => {
    if (!window.confirm(`Delete the dataset “${dataset.name}”? Projects using it will stop working.`)) return;
    try {
      await engine.call("datasets.delete", { dataset_id: dataset.id });
      void reload();
    } catch (error) {
      fail(error);
    }
  };

  const samples = QUICK.map((id) => catalogue.samples.find((s) => s.id === id)).filter((s) => s !== undefined);
  const gpu = info.gpus?.[0];
  return (
    <div className="shell">
      <TopBar />
      <main className="content">
        <div className="page">
          <section className="hero">
            <div>
              <span className="badge ok" style={{ marginBottom: 16 }}>
                <Icon name="sparkles" size={11} /> Open source · no code
              </span>
              <h1>
                Train machine learning models <span className="gradient-text">without writing code.</span>
              </h1>
              <p className="lead">
                Bring a table or a folder of images. Clean it, train and compare models, from linear regression to neural networks you design layer by layer, then export one that runs anywhere.
              </p>
              <div className="hero-actions">
                <button className="primary" onClick={() => setCreating(true)}>
                  <Icon name="plus" /> New project
                </button>
                <button onClick={() => setCreating(true)}>
                  <Icon name="upload" /> Upload data
                </button>
              </div>
              <div className="engine-line">
                <span className="dot ok" />
                {engine.kind === "browser" ? "Running in your browser: your data stays on this device." : `Running on ${engine.kind === "local" ? "this computer" : engine.label}`}
                <span className="faint">
                  · {info.cpus} CPU{gpu ? ` · ${gpu.name}` : ""}
                </span>
                <button className="ghost small" onClick={openEngine}>
                  {engine.kind === "browser" ? "Use my GPU" : "Change"}
                </button>
              </div>
            </div>
            <HeroArt />
          </section>

          <section style={{ marginBottom: 40 }}>
            <div className="section-head">
              <h2>Start from a sample</h2>
              <span className="dim small">one click to a ready-to-train project</span>
            </div>
            <div className="sample-grid">
              {samples.map((sample) => (
                <button key={sample.id} className="sample" disabled={loadingSample !== null} onClick={() => void startSample(sample.id)}>
                  <div className="row">
                    <span className={`kind-icon ${sample.kind === "image" ? "image" : ""}`}>
                      {loadingSample === sample.id ? <Spinner /> : <Icon name={sample.kind === "image" ? "image" : "table"} size={16} />}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <b className="ellipsis" style={{ display: "block" }}>
                        {sample.name}
                      </b>
                      <span className="faint tiny">{sample.task}</span>
                    </div>
                  </div>
                  <span className="dim small">{sample.description}</span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="section-head">
              <h2>Your projects</h2>
              {projects && projects.length > 0 && <span className="dim small">{projects.length}</span>}
            </div>
            {projects === null ? (
              <Spinner />
            ) : projects.length === 0 ? (
              <div className="empty">
                <div className="icon-ring">
                  <Icon name="layers" size={22} />
                </div>
                <p>No projects yet. Pick a sample above, or bring your own data.</p>
                <button className="primary" style={{ marginTop: 16 }} onClick={() => setCreating(true)}>
                  <Icon name="plus" /> New project
                </button>
              </div>
            ) : (
              <div className="project-grid">
                {projects.map((project) => (
                  <div key={project.id} style={{ position: "relative" }}>
                    <button className="project-card" onClick={() => open(project.id)}>
                      <div className="row">
                        <span className={`kind-icon ${project.kind === "image" ? "image" : ""}`}>
                          <Icon name={project.kind === "image" ? "image" : "table"} size={16} />
                        </span>
                        <div style={{ minWidth: 0, flex: 1, paddingRight: 28 }}>
                          <div className="name ellipsis">{project.name}</div>
                          <div className="faint tiny">
                            predict {project.target} · {project.task}
                          </div>
                        </div>
                      </div>
                      {project.best && project.best.value !== null ? (
                        <div className="row" style={{ alignItems: "baseline" }}>
                          <span className="score">{metricValue(project.best.metric, project.best.value)}</span>
                          <span className="dim small ellipsis">
                            {project.best.metric_label} · {project.best.label}
                          </span>
                        </div>
                      ) : (
                        <div className="dim small">Not trained yet · {project.models} models ready</div>
                      )}
                      <div className="faint tiny">updated {ago(project.updated)}</div>
                    </button>
                    <button className="ghost small icon-only" style={{ position: "absolute", top: 12, right: 10 }} onClick={() => void remove(project)} aria-label={`Delete ${project.name}`}>
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {datasets.length > 0 && (
            <section style={{ marginTop: 40 }}>
              <div className="section-head">
                <h2>Datasets</h2>
                <span className="dim small">stored by this engine{engine.kind === "browser" ? " in your browser" : info.workspace ? ` in ${info.workspace}` : ""}</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Contents</th>
                      <th>Size</th>
                      <th>Added</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {datasets.map((d) => (
                      <tr key={d.id}>
                        <td>
                          <b>{d.name}</b>
                        </td>
                        <td className="dim">{d.kind === "image" ? `${d.rows.toLocaleString()} images · ${d.columns} classes` : `${d.rows.toLocaleString()} rows × ${d.columns} columns`}</td>
                        <td className="dim">{bytes(d.size)}</td>
                        <td className="dim">{ago(d.created)}</td>
                        <td style={{ textAlign: "right" }}>
                          <button className="small" onClick={() => setCreating(d)}>
                            New project
                          </button>{" "}
                          <button className="ghost small icon-only" onClick={() => void removeDataset(d)} aria-label={`Delete ${d.name}`}>
                            <Icon name="trash" size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </main>
      {creating && <NewProject initialDataset={creating === true ? undefined : creating} onClose={() => setCreating(null)} onCreated={(id) => open(id)} />}
    </div>
  );
}
