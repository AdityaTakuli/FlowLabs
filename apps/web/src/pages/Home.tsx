import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../context";
import { Icon, type IconName } from "../components/Icon";
import { SectionNav, TopBar } from "../components/TopBar";
import { Spinner } from "../components/ui";
import { ago, bytes, metricValue } from "../format";
import type { DatasetMeta, ProjectSummary } from "../types";
import { NewProject } from "./NewProject";

const ACCEPT = ".csv,.tsv,.txt,.xlsx,.xls,.parquet,.json,.jsonl,.zip";
const RECENT = 7;

/** Another top-level page (Sheets, Databases), the way the section switch opens it. */
function goPage(page: string) {
  window.history.pushState(null, "", `?page=${page}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function StartLink({ icon, label, hint, keys, onClick }: { icon: IconName; label: string; hint?: string; keys?: string; onClick: () => void }) {
  return (
    <li>
      <button className="w-link" onClick={onClick}>
        <Icon name={icon} size={15} className="w-link-icon" />
        <span className="w-link-label">{label}</span>
        {hint && <span className="w-link-hint">{hint}</span>}
        {keys && <kbd>{keys}</kbd>}
      </button>
    </li>
  );
}

export function Home({ open }: { open: (id: string) => void }) {
  const { engine, info, catalogue, fail, openEngine, notify, openGuide } = useApp();
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

  const [exportMenu, setExportMenu] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const exportDataset = async (dataset: DatasetMeta, format: string) => {
    setExportMenu(null);
    setExporting(dataset.id);
    try {
      const written = await engine.call<{ path: string; name: string }>("datasets.export", { dataset_id: dataset.id, format });
      await engine.download(written.path, written.name);
    } catch (error) {
      fail(error);
    } finally {
      setExporting(null);
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

  // a file dropped anywhere on the page starts a project; Ctrl+O picks one
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "o" && !creating) {
        event.preventDefault();
        fileInput.current?.click();
      }
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [creating]);
  const [allProjects, setAllProjects] = useState(false);

  const gpu = info.gpus?.[0];
  const machine = engine.kind === "browser" ? "This browser" : engine.kind === "local" ? "This computer" : engine.label;
  const specs = [
    engine.kind === "browser" ? "Python in the page (Pyodide)" : `${info.cpus} CPU cores`,
    info.memory ? `${Math.round(info.memory.total_gb)} GB memory` : null,
    gpu ? `${gpu.name}${gpu.memory_gb ? `, ${Math.round(gpu.memory_gb)} GB` : ""}` : engine.kind === "browser" ? null : "no GPU",
  ].filter(Boolean);
  const shown = projects ? (allProjects ? projects : projects.slice(0, RECENT)) : [];
  const trained = projects?.filter((p) => p.best?.value != null).length ?? 0;

  return (
    <div className="shell with-status">
      <TopBar help="getting-started">
        <SectionNav current="projects" onProjects={() => undefined} />
      </TopBar>
      <main
        className="content"
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          depth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          depth.current = 0;
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) setCreating({ file });
        }}
      >
        <div className="welcome">
          <header className="welcome-head">
            <h1>FlowLabs</h1>
            <p>Data, SQL, spreadsheets and machine learning in one place.</p>
          </header>

          <div className="welcome-cols">
            <div className="welcome-col">
              <section className="w-section" aria-labelledby="w-start">
                <h2 id="w-start">Start</h2>
                <ul className="w-links">
                  <StartLink icon="plus" label="New project…" hint="from a file, a sample or a dataset" onClick={() => setCreating({})} />
                  <StartLink icon="upload" label="Open a file…" hint="CSV, Excel, Parquet, JSON, zip of images" keys="Ctrl O" onClick={() => fileInput.current?.click()} />
                  <StartLink icon="table" label="New sheet" hint="spreadsheets with formulas" onClick={() => goPage("sheets")} />
                  <StartLink icon="server" label="Connect a database" hint="PostgreSQL, MySQL, warehouses, cloud storage" onClick={() => goPage("databases")} />
                </ul>
                <input ref={fileInput} type="file" accept={ACCEPT} hidden onChange={(e) => e.target.files?.[0] && setCreating({ file: e.target.files[0] })} />
                <p className="w-note">Or drop a file anywhere on this page.</p>
              </section>

              <section className="w-section" aria-labelledby="w-recent">
                <div className="w-head">
                  <h2 id="w-recent">Recent</h2>
                  {projects && projects.length > 0 && (
                    <span className="w-count">
                      {projects.length} {projects.length === 1 ? "project" : "projects"}, {trained} trained
                    </span>
                  )}
                </div>
                {projects === null ? (
                  <Spinner />
                ) : projects.length === 0 ? (
                  <p className="w-empty">No projects yet. Open a file or a sample to start one.</p>
                ) : (
                  <ul className="w-list">
                    {shown.map((project) => {
                      const best = project.best;
                      return (
                        <li key={project.id} className="w-row">
                          <button className="w-row-main" onClick={() => open(project.id)} title={`Open ${project.name}`}>
                            <Icon name={project.kind === "image" ? "image" : "table"} size={14} className="w-row-icon" />
                            <span className="w-row-text">
                              <span className="w-row-name">{project.name}</span>
                              <span className="w-row-meta">
                                predicts {project.target}, {project.task}
                              </span>
                            </span>
                            <span className="w-row-side">
                              {best && best.value !== null ? (
                                <span className="w-score" title={`${best.metric_label}, ${best.label}`}>
                                  <b className="num">{metricValue(best.metric, best.value)}</b> <span>{best.metric_label}</span>
                                </span>
                              ) : (
                                <span className="w-faint">not trained</span>
                              )}
                              <span className="w-faint nowrap">{ago(project.updated)}</span>
                            </span>
                          </button>
                          <span className="w-row-actions">
                            <button className="ghost small icon-only" onClick={() => void remove(project)} aria-label={`Delete ${project.name}`} title="Delete">
                              <Icon name="trash" size={13} />
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {projects && projects.length > RECENT && (
                  <button className="link w-more" onClick={() => setAllProjects(!allProjects)}>
                    {allProjects ? "Show fewer" : `Show all ${projects.length}`}
                  </button>
                )}
              </section>

              <section className="w-section" aria-labelledby="w-learn">
                <h2 id="w-learn">Learn</h2>
                <ul className="w-links">
                  <StartLink icon="book" label="Getting started" hint="your first model in five minutes" onClick={() => openGuide("getting-started")} />
                  <StartLink icon="database" label="SQL and Ask AI" onClick={() => openGuide("sql")} />
                  <StartLink icon="package" label="Predict and export" onClick={() => openGuide("predict-export")} />
                </ul>
              </section>
            </div>

            <div className="welcome-col">
              <section className="w-section" aria-labelledby="w-samples">
                <div className="w-head">
                  <h2 id="w-samples">Samples</h2>
                  <span className="w-count">open as a project ready to train</span>
                </div>
                <ul className="w-list">
                  {catalogue.samples.map((sample) => (
                    <li key={sample.id} className="w-row">
                      <button className="w-row-main" onClick={() => loadingSample === null && void startSample(sample.id)} title={sample.description}>
                        <Icon name={sample.kind === "image" ? "image" : "table"} size={14} className="w-row-icon" />
                        <span className="w-row-text">
                          <span className="w-row-name">{sample.name}</span>
                          <span className="w-row-meta">{sample.description}</span>
                        </span>
                        <span className="w-row-side">{loadingSample === sample.id ? <Spinner /> : <span className="w-faint nowrap">{sample.task}</span>}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              {datasets.length > 0 && (
                <section className="w-section" aria-labelledby="w-datasets">
                  <div className="w-head">
                    <h2 id="w-datasets">Stored datasets</h2>
                    <span className="w-count">{bytes(datasets.reduce((total, d) => total + d.size, 0))}</span>
                  </div>
                  <ul className="w-list">
                    {datasets.map((d) => (
                      <li key={d.id} className={`w-row ${exportMenu === d.id ? "menu-open" : ""}`}>
                        <button className="w-row-main" onClick={() => setCreating({ dataset: d })} title={`New project from ${d.name}`}>
                          <Icon name={d.kind === "image" ? "image" : "table"} size={14} className="w-row-icon" />
                          <span className="w-row-text">
                            <span className="w-row-name">{d.name}</span>
                            <span className="w-row-meta">
                              {d.kind === "image" ? `${d.rows.toLocaleString()} images, ${d.columns} classes` : `${d.rows.toLocaleString()} rows, ${d.columns} columns`}
                              {d.sheet ? `, sheet ${d.sheet}` : ""}
                            </span>
                          </span>
                          <span className="w-row-side">
                            <span className="w-faint nowrap">{bytes(d.size)}</span>
                            <span className="w-faint nowrap">{ago(d.created)}</span>
                          </span>
                        </button>
                        <span className="w-row-actions">
                          {d.kind === "tabular" && (
                            <span className="db-menu-anchor">
                              <button className="ghost small icon-only" onClick={() => setExportMenu(exportMenu === d.id ? null : d.id)} aria-expanded={exportMenu === d.id} aria-label={`Download ${d.name}`} title="Download as CSV, Excel, Parquet or JSON" disabled={exporting === d.id}>
                                {exporting === d.id ? <Spinner /> : <Icon name="download" size={13} />}
                              </button>
                              {exportMenu === d.id && (
                                <div className="db-menu" role="menu" onMouseLeave={() => setExportMenu(null)}>
                                  {([["csv", "CSV"], ["xlsx", "Excel"], ["parquet", "Parquet"], ["json", "JSON"]] as const)
                                    .filter(([id]) => id !== "parquet" || engine.kind !== "browser")
                                    .map(([id, label]) => (
                                      <button key={id} role="menuitem" onClick={() => void exportDataset(d, id)}>
                                        {label}
                                      </button>
                                    ))}
                                </div>
                              )}
                            </span>
                          )}
                          <button className="ghost small icon-only" onClick={() => void removeDataset(d)} aria-label={`Delete ${d.name}`} title="Delete">
                            <Icon name="trash" size={13} />
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="w-section" aria-labelledby="w-engine">
                <div className="w-head">
                  <h2 id="w-engine">Engine</h2>
                  <button className="link w-head-action" onClick={openEngine}>
                    {engine.kind === "browser" ? "Use my computer's GPU" : "Change"}
                  </button>
                </div>
                <dl className="w-facts">
                  <dt>Runs on</dt>
                  <dd>
                    <span className="dot ok" /> {machine}
                  </dd>
                  <dt>Hardware</dt>
                  <dd>{specs.join(", ")}</dd>
                  {info.python && (
                    <>
                      <dt>Python</dt>
                      <dd>
                        {info.python}
                        {info.packages?.torch ? `, PyTorch ${info.packages.torch}` : ""}
                      </dd>
                    </>
                  )}
                  <dt>Workspace</dt>
                  <dd className="w-path" title={info.workspace}>
                    {engine.kind === "browser" ? "this browser's storage" : info.workspace ?? "kept by the engine"}
                  </dd>
                </dl>
              </section>

            </div>
          </div>
        </div>
        {dragging && (
          <div className="w-drop" aria-hidden>
            <Icon name="upload" size={26} />
            <b>Drop to start a project</b>
            <span>CSV, Excel, Parquet, JSON, or a zip with one image folder per class</span>
          </div>
        )}
      </main>
      <footer className="statusbar" aria-label="Status">
        <button className="status-item" onClick={openEngine} title="Change the engine">
          <span className="dot ok" /> {machine}
          {engine.kind !== "browser" && <span className="status-dim">{info.cpus} CPU{gpu ? ", GPU" : ""}</span>}
        </button>
        {info.workspace && engine.kind !== "browser" && (
          <span className="status-item status-path" title={info.workspace}>
            <Icon name="folder" size={11} /> {info.workspace}
          </span>
        )}
        <span className="spacer" />
        <span className="status-item">
          {projects?.length ?? 0} projects, {datasets.length} datasets
        </span>
        <span className="status-item">FlowLabs {info.flowlabs}</span>
      </footer>
      {creating && <NewProject initialDataset={creating.dataset} initialFile={creating.file} onClose={() => setCreating(null)} onCreated={(id) => open(id)} />}
    </div>
  );
}
