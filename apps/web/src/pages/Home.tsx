import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../context";
import { Icon, type IconName } from "../components/Icon";
import { SectionNav, TopBar } from "../components/TopBar";
import { Modal, Spinner } from "../components/ui";
import { ago, bytes, metricValue } from "../format";
import type { DatasetMeta, ProjectSummary } from "../types";
import { NewProject } from "./NewProject";

const ACCEPT = ".csv,.tsv,.txt,.xlsx,.xls,.parquet,.json,.jsonl,.zip";
const RECENT = 5;

/** Another top-level page (Sheets, Databases), the way the section switch opens it. */
function goPage(page: string) {
  window.history.pushState(null, "", `?page=${page}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function StartLink({ icon, label, keys, onClick }: { icon: IconName; label: string; keys?: string; onClick: () => void }) {
  return (
    <li>
      <button className="w-link" onClick={onClick}>
        <Icon name={icon} size={15} className="w-link-icon" />
        <span className="w-link-label">{label}</span>
        {keys && <kbd>{keys}</kbd>}
      </button>
    </li>
  );
}

export function Home({ open }: { open: (id: string) => void }) {
  const { engine, catalogue, fail, notify } = useApp();
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

  const [panel, setPanel] = useState<"samples" | "datasets" | null>(null);
  const shown = projects ? (allProjects ? projects : projects.slice(0, RECENT)) : [];

  const datasetRow = (d: DatasetMeta) => (
    <li key={d.id} className={`w-row ${exportMenu === d.id ? "menu-open" : ""}`}>
      <button className="w-row-main" onClick={() => { setPanel(null); setCreating({ dataset: d }); }} title={`New project from ${d.name}`}>
        <span className="w-row-name">{d.name}</span>
        <span className="w-row-meta">
          {d.kind === "image" ? `${d.rows.toLocaleString()} images` : `${d.rows.toLocaleString()} rows`}, {bytes(d.size)}
        </span>
      </button>
      <span className="w-row-actions">
        {d.kind === "tabular" && (
          <span className="db-menu-anchor">
            <button className="ghost small icon-only" onClick={() => setExportMenu(exportMenu === d.id ? null : d.id)} aria-expanded={exportMenu === d.id} aria-label={`Download ${d.name}`} title="Download" disabled={exporting === d.id}>
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
  );

  return (
    <div className="shell">
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
            <p>Data, SQL, spreadsheets and machine learning.</p>
          </header>

          <section className="w-section" aria-labelledby="w-start">
            <h2 id="w-start">Start</h2>
            <ul className="w-links">
              <StartLink icon="plus" label="New project" onClick={() => setCreating({})} />
              <StartLink icon="upload" label="Open a file" keys="Ctrl O" onClick={() => fileInput.current?.click()} />
              <StartLink icon="table" label="New sheet" onClick={() => goPage("sheets")} />
              <StartLink icon="server" label="Connect a database" onClick={() => goPage("databases")} />
            </ul>
            <input ref={fileInput} type="file" accept={ACCEPT} hidden onChange={(e) => e.target.files?.[0] && setCreating({ file: e.target.files[0] })} />
          </section>

          <section className="w-section" aria-labelledby="w-recent">
            <h2 id="w-recent">Recent</h2>
            {projects === null ? (
              <Spinner />
            ) : projects.length === 0 ? (
              <p className="w-empty">Nothing yet. Open a file, or try a sample.</p>
            ) : (
              <ul className="w-list">
                {shown.map((project) => {
                  const best = project.best;
                  return (
                    <li key={project.id} className="w-row">
                      <button className="w-row-main" onClick={() => open(project.id)} title={`${project.name}: predicts ${project.target}`}>
                        <span className="w-row-name">{project.name}</span>
                        <span className="w-row-meta">
                          {best && best.value !== null ? `${metricValue(best.metric, best.value)} ${best.metric_label}` : ago(project.updated)}
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
                {allProjects ? "Fewer" : `All ${projects.length} projects`}
              </button>
            )}
          </section>

          <nav className="w-browse" aria-label="More">
            <button className="link" onClick={() => setPanel("samples")}>
              Samples
            </button>
            {datasets.length > 0 && (
              <button className="link" onClick={() => setPanel("datasets")}>
                Datasets
              </button>
            )}
          </nav>
        </div>
        {dragging && (
          <div className="w-drop" aria-hidden>
            <Icon name="upload" size={26} />
            <b>Drop to start a project</b>
            <span>CSV, Excel, Parquet, JSON, or a zip of image folders</span>
          </div>
        )}
      </main>

      {panel && (
        <Modal title={panel === "samples" ? "Samples" : "Datasets"} onClose={() => setPanel(null)}>
          <p className="faint small" style={{ marginBottom: 10 }}>
            {panel === "samples" ? "Small datasets that open as a project, ready to train." : "Files you imported. Click one to start a project from it."}
          </p>
          <ul className="w-list w-panel">
            {panel === "samples"
              ? catalogue.samples.map((sample) => (
                  <li key={sample.id} className="w-row">
                    <button className="w-row-main" onClick={() => { setPanel(null); if (loadingSample === null) void startSample(sample.id); }} title={sample.description}>
                      <span className="w-row-name">{sample.name}</span>
                      <span className="w-row-meta">{loadingSample === sample.id ? <Spinner /> : sample.task}</span>
                    </button>
                  </li>
                ))
              : datasets.map(datasetRow)}
          </ul>
        </Modal>
      )}
      {creating && <NewProject initialDataset={creating.dataset} initialFile={creating.file} onClose={() => setCreating(null)} onCreated={(id) => open(id)} />}
    </div>
  );
}
