import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../context";
import { Icon } from "../components/Icon";
import { SectionNav, TopBar } from "../components/TopBar";
import { Spinner } from "../components/ui";
import { ago, bytes, metricValue } from "../format";
import type { DatasetMeta, ProjectSummary } from "../types";
import { NewProject } from "./NewProject";

const ACCEPT = ".csv,.tsv,.txt,.xlsx,.xls,.parquet,.json,.jsonl,.zip";

/** A few real rows of the churn sample: the column to predict is marked, the way FlowLabs sets a project up. */
const GRID = {
  columns: ["tenure_months", "monthly_charges", "plan_type", "contract", "support_calls", "churned"],
  rows: [
    ["14", "50.13", "plus", "month_to_month", "0", "false"],
    ["38", "52.69", "plus", "two_year", "2", "false"],
    ["3", "89.20", "premium", "month_to_month", "5", "true"],
    ["61", "24.75", "basic", "one_year", "1", "false"],
    ["", "71.40", "plus", "month_to_month", "3", "true"],
  ],
};

/** The home page's drop target, drawn as the spreadsheet you are about to bring. */
function DataGrid({ onFile, onBrowse }: { onFile: (file: File) => void; onBrowse: () => void }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const target = GRID.columns.length - 1;
  return (
    <div
      className={`data-grid ${over ? "over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
    >
      <div className="grid-scroll" aria-hidden>
        <table>
          <thead>
            <tr>
              <th className="row-no" />
              {GRID.columns.map((c, i) => (
                <th key={c} className={i === target ? "target" : ""}>
                  {c}
                  {i === target && <span className="target-tag">to predict</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {GRID.rows.map((row, r) => (
              <tr key={r}>
                <td className="row-no">{r + 1}</td>
                {row.map((v, i) => (
                  <td key={i} className={`${i === target ? "target" : ""} ${v === "" ? "gap" : ""} ${/^[\d.]+$/.test(v) ? "num" : ""}`}>{v === "" ? "empty" : v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid-drop">
        <Icon name="upload" size={18} />
        <span>Drop a CSV, Excel, Parquet or JSON file here, or a zip with one image folder per class.</span>
        <button className="primary" onClick={() => input.current?.click()}>
          Choose a file
        </button>
        <button className="ghost" onClick={onBrowse}>
          Use a stored dataset
        </button>
        <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      </div>
    </div>
  );
}

export function Home({ open, openSql }: { open: (id: string) => void; openSql: () => void }) {
  const { engine, info, catalogue, fail, openEngine, notify } = useApp();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [creating, setCreating] = useState<{ dataset?: DatasetMeta; file?: File } | null>(null);
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
      setCreating({ dataset: await engine.call<DatasetMeta>("datasets.import_sample", { sample_id: sampleId }) });
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
      notify("Dataset deleted.", "ok");
      void reload();
    } catch (error) {
      fail(error);
    }
  };

  const gpu = info.gpus?.[0];
  const where = engine.kind === "browser" ? "Training in this browser. Your data stays on this device." : `Training on ${engine.kind === "local" ? "this computer" : engine.label}, with ${info.cpus} CPU cores${gpu ? ` and ${gpu.name}` : ""}.`;
  return (
    <div className="shell">
      <TopBar>
        <SectionNav current="projects" onProjects={() => undefined} onSql={openSql} />
      </TopBar>
      <main className="content">
        <div className="page home">
          <section className="intro">
            <div className="intro-copy">
              <h1>Train a model from a spreadsheet.</h1>
              <p className="lead">
                Bring a table or a folder of images. Clean it, train several models side by side, see which one predicts best on rows it never saw, and export it as Python that runs anywhere.
              </p>
              <p className="engine-line">
                <span className="dot ok" />
                {where}
                <button className="link" onClick={openEngine}>
                  {engine.kind === "browser" ? "Use my computer's GPU" : "Change"}
                </button>
              </p>
            </div>
            <DataGrid onFile={(file) => setCreating({ file })} onBrowse={() => setCreating({})} />
          </section>

          <section className="block">
            <div className="section-head">
              <h2>Your projects</h2>
              {projects && projects.length > 0 && (
                <button className="small" onClick={() => setCreating({})}>
                  <Icon name="plus" size={13} /> New project
                </button>
              )}
            </div>
            {projects === null ? (
              <Spinner />
            ) : projects.length === 0 ? (
              <p className="empty-line">No projects yet. Drop a file above, or start from one of the samples below.</p>
            ) : (
              <div className="table-wrap">
                <table className="list-table">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Predicts</th>
                      <th className="score-col">Best score</th>
                      <th>Updated</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((project) => {
                      const best = project.best;
                      const share = best && best.value !== null && best.value >= 0 && best.value <= 1 ? best.value : null;
                      return (
                        <tr key={project.id} className="clickable" onClick={() => open(project.id)}>
                          <td>
                            <span className="row">
                              <Icon name={project.kind === "image" ? "image" : "table"} size={14} className="faint" />
                              <b>{project.name}</b>
                            </span>
                          </td>
                          <td className="dim">
                            {project.target} <span className="faint">({project.task})</span>
                          </td>
                          <td className="score-col">
                            {best && best.value !== null ? (
                              <span className="score-cell">
                                <b className="num">{metricValue(best.metric, best.value)}</b>
                                {share !== null && (
                                  <span className="score-bar">
                                    <span style={{ width: `${share * 100}%` }} />
                                  </span>
                                )}
                                <span className="faint tiny ellipsis">
                                  {best.metric_label}, {best.label}
                                </span>
                              </span>
                            ) : (
                              <span className="faint">Not trained, {project.models} models set up</span>
                            )}
                          </td>
                          <td className="dim nowrap">{ago(project.updated)}</td>
                          <td className="actions">
                            <button
                              className="ghost small icon-only"
                              onClick={(e) => {
                                e.stopPropagation();
                                void remove(project);
                              }}
                              aria-label={`Delete ${project.name}`}
                            >
                              <Icon name="trash" size={13} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="block">
            <div className="section-head">
              <h2>Samples</h2>
              <span className="dim small">Small datasets that open as a project ready to train.</span>
            </div>
            <div className="table-wrap">
              <table className="list-table">
                <thead>
                  <tr>
                    <th>Dataset</th>
                    <th>Predicts</th>
                    <th>What it is</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {catalogue.samples.map((sample) => (
                    <tr key={sample.id} className="clickable" onClick={() => loadingSample === null && void startSample(sample.id)}>
                      <td>
                        <span className="row">
                          <Icon name={sample.kind === "image" ? "image" : "table"} size={14} className="faint" />
                          <b>{sample.name}</b>
                        </span>
                      </td>
                      <td className="dim nowrap">
                        {sample.target} <span className="faint">({sample.task})</span>
                      </td>
                      <td className="dim wrap-cell">{sample.description}</td>
                      <td className="actions">{loadingSample === sample.id ? <Spinner /> : <span className="open-link">Open</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {datasets.length > 0 && (
            <section className="block">
              <div className="section-head">
                <h2>Stored datasets</h2>
                <span className="dim small">Kept {engine.kind === "browser" ? "in this browser" : info.workspace ? `in ${info.workspace}` : "by this engine"}.</span>
                <button className="small" onClick={openSql}>
                  <Icon name="database" size={13} /> Query with SQL
                </button>
              </div>
              <div className="table-wrap">
                <table className="list-table">
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
                        <td className="dim">{d.kind === "image" ? `${d.rows.toLocaleString()} images in ${d.columns} classes` : `${d.rows.toLocaleString()} rows, ${d.columns} columns`}</td>
                        <td className="dim num">{bytes(d.size)}</td>
                        <td className="dim nowrap">{ago(d.created)}</td>
                        <td className="actions">
                          <button className="small" onClick={() => setCreating({ dataset: d })}>
                            New project
                          </button>
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
      {creating && <NewProject initialDataset={creating.dataset} initialFile={creating.file} onClose={() => setCreating(null)} onCreated={(id) => open(id)} />}
    </div>
  );
}
