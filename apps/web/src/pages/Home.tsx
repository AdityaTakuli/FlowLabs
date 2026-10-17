import { useCallback, useEffect, useState } from "react";
import { useApp } from "../context";
import { Icon } from "../components/Icon";
import { TopBar } from "../components/TopBar";
import { Spinner } from "../components/ui";
import { ago, bytes } from "../format";
import type { DatasetMeta, ProjectSummary } from "../types";
import { NewProject } from "./NewProject";

const STAGES = ["Data", "Clean", "Split", "Transform", "Train", "Evaluate", "Export"];

export function Home({ open }: { open: (id: string) => void }) {
  const { engine, info, fail, openEngine, notify } = useApp();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [creating, setCreating] = useState<DatasetMeta | true | null>(null);

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

  return (
    <div className="shell">
      <TopBar />
      <div className="content">
        <div className="page">
          <div className="hero">
            <div>
              <h1 style={{ fontSize: 30 }}>Machine learning, without writing code.</h1>
              <p className="lead">
                Bring a table or a folder of images. Clean and prepare it, train and compare models (from linear regression to neural networks you design layer by
                layer), then export a model that runs anywhere.
              </p>
              <div className="flow-strip">
                {STAGES.map((stage, i) => (
                  <span key={stage} className="row" style={{ gap: 6 }}>
                    <span className="stage">{stage}</span>
                    {i < STAGES.length - 1 && <Icon name="chevronRight" size={12} className="faint" />}
                  </span>
                ))}
              </div>
              <div className="row" style={{ marginTop: 20 }}>
                <button className="primary" onClick={() => setCreating(true)}>
                  <Icon name="plus" /> New project
                </button>
                <a className="row small" href="https://github.com/AdityaTakuli/Synapse" target="_blank" rel="noreferrer" style={{ marginLeft: 8 }}>
                  <Icon name="github" /> Open source
                </a>
              </div>
            </div>
            <div className="card">
              <div className="card-head">
                <Icon name={engine.kind === "browser" ? "globe" : "cpu"} />
                <h3>{engine.kind === "browser" ? "Running in your browser" : engine.kind === "local" ? "Running on this computer" : engine.label}</h3>
              </div>
              <p className="dim small">
                Python {info.python} · {info.cpus} CPU cores
                {info.memory ? ` · ${info.memory.total_gb} GB RAM` : ""}
                {info.gpus?.length ? ` · ${info.gpus.map((g) => g.name).join(", ")}` : ""}
              </p>
              <p className="dim small" style={{ marginTop: 8 }}>
                {engine.kind === "browser"
                  ? "Your data stays on this device. For GPUs, PyTorch and large datasets, connect an engine running on your computer or a server."
                  : "Training uses this machine's Python environment, CPU cores and GPU, like a Jupyter kernel."}
              </p>
              <button style={{ marginTop: 12 }} onClick={openEngine}>
                <Icon name="gear" /> Engine settings
              </button>
            </div>
          </div>

          <div className="card-head">
            <h2>Projects</h2>
          </div>
          {projects === null ? (
            <Spinner />
          ) : projects.length === 0 ? (
            <div className="empty">
              <p>No projects yet.</p>
              <button className="primary" style={{ marginTop: 12 }} onClick={() => setCreating(true)}>
                <Icon name="plus" /> Start with a sample dataset
              </button>
            </div>
          ) : (
            <div className="project-grid">
              {projects.map((project) => (
                <div key={project.id} style={{ position: "relative" }}>
                  <button className="project-card" style={{ width: "100%" }} onClick={() => open(project.id)}>
                    <div className="row">
                      <Icon name={project.kind === "image" ? "image" : "table"} className="accent-text" />
                      <span className="name ellipsis">{project.name}</span>
                    </div>
                    <span className="dim small">
                      Predict <b>{project.target}</b> · {project.task}
                    </span>
                    <div className="row small">
                      <span className="badge">{project.models} models</span>
                      {project.last_run ? <span className="badge ok">trained</span> : <span className="badge">not trained</span>}
                      <span className="spacer" />
                      <span className="faint tiny">{ago(project.updated)}</span>
                    </div>
                  </button>
                  <button className="ghost icon-only" style={{ position: "absolute", top: 8, right: 8 }} onClick={() => void remove(project)} aria-label="Delete project">
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {datasets.length > 0 && (
            <>
              <div className="card-head" style={{ marginTop: 32 }}>
                <h2>Datasets</h2>
                <span className="dim small">stored by this engine{engine.kind === "browser" ? " in your browser" : info.workspace ? ` in ${info.workspace}` : ""}</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Kind</th>
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
                          <button className="ghost icon-only" onClick={() => void removeDataset(d)} aria-label="Delete dataset">
                            <Icon name="trash" size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
      {creating && <NewProject initialDataset={creating === true ? undefined : creating} onClose={() => setCreating(null)} onCreated={(id) => open(id)} />}
    </div>
  );
}
