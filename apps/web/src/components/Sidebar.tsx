import type { GraphWarning, KernelInfo, ProjectInfo, Resources } from "../types";
import { languageIcon, type FileKind, type LanguageSummary } from "../structure/types";

export type KernelAction = "start" | "stop" | "restart" | "interrupt" | "clean";

interface SidebarProps {
  project: ProjectInfo | null;
  file: string | null;
  files: string[];
  fileInfo: Record<string, FileKind>;
  languages: LanguageSummary[];
  language: string;
  onLanguage: (language: string) => void;
  onOpen: (file: string) => void;
  showKernel: boolean;
  kernel: KernelInfo;
  resources: Resources | null;
  hidden: GraphWarning[];
  onKernel: (action: KernelAction) => void;
}

const KERNEL_LABEL: Record<KernelInfo["status"], string> = {
  none: "No kernel",
  starting: "Starting…",
  idle: "Idle",
  busy: "Running",
  dead: "Dead",
};

export function Sidebar({ project, file, files, fileInfo, languages, language, onLanguage, onOpen, showKernel, kernel, resources, hidden, onKernel }: SidebarProps) {
  const used = resources ? Math.max(0, Math.min(100, 100 - (resources.ram_available_mb / resources.ram_total_mb) * 100)) : 0;
  const orphans = hidden.find((w) => w.code === "ORPHAN_VARIABLES");
  const total = languages.reduce((sum, l) => sum + l.files, 0);
  return (
    <aside className="sidebar">
      <section>
        <h2 title={project?.root}>{project?.name ?? "Project"}</h2>
        {languages.length > 0 && (
          <label className="language-picker" title="Languages found in this project, most used first">
            <span className="small dim">Language</span>
            <select value={language} onChange={(e) => onLanguage(e.target.value)} aria-label="Show files of one language">
              <option value="all">All languages ({total})</option>
              {languages.map((l, i) => (
                <option key={l.name} value={l.name}>
                  {l.name} ({l.files}){i === 0 && languages.length > 1 ? " · primary" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <ul className="file-list">
          {files.map((f) => {
            const info = fileInfo[f];
            return (
              <li key={f}>
                <button className={f === file ? "active" : ""} onClick={() => onOpen(f)} title={`${f}${info ? ` · ${info.reason}` : ""}`}>
                  <span className="file-icon lang-icon" aria-hidden>
                    {languageIcon(info?.language_name, f)}
                  </span>
                  <span className="file-name">{f}</span>
                  {info && (
                    <span className={`workspace-tag ws-${info.workspace}`} title={info.workspace === "cells" ? "Opens as runnable cells (data analysis / ML)" : "Opens as a structure graph (functions and calls)"}>
                      {info.workspace === "cells" ? "cells" : "graph"}
                    </span>
                  )}
                  {project?.sessions.includes(f) && <span className="dot" title="kernel running" />}
                </button>
              </li>
            );
          })}
          {project && files.length === 0 && <li className="dim">No source files{language !== "all" ? ` in ${language}` : ""}</li>}
        </ul>
      </section>

      {showKernel ? (
        <section className="kernel-panel">
          <h2>Kernel</h2>
          <div className={`kernel-status status-${kernel.status}`}>
            <span aria-hidden>●</span> {KERNEL_LABEL[kernel.status]}
            {kernel.running && <span className="dim"> · {kernel.running}</span>}
          </div>
          {kernel.python && (
            <div className="dim small">
              Python {kernel.python} · pid {kernel.pid} · {kernel.packages} packages
            </div>
          )}
          <div className="button-row">
            {kernel.status === "none" || kernel.status === "starting" ? (
              <button className="primary" disabled={!file || kernel.status === "starting"} onClick={() => onKernel("start")}>
                Start kernel
              </button>
            ) : (
              <>
                <button disabled={kernel.status !== "busy"} onClick={() => onKernel("interrupt")}>
                  ■ Interrupt
                </button>
                <button disabled={kernel.status === "busy"} onClick={() => onKernel("restart")}>
                  Restart
                </button>
                <button onClick={() => onKernel("stop")}>Stop</button>
              </>
            )}
          </div>
          {orphans && (
            <div className="hidden-state">
              <div className="small">{orphans.message}</div>
              <button onClick={() => onKernel("clean")} disabled={kernel.status !== "idle"}>
                Clean kernel
              </button>
            </div>
          )}
        </section>
      ) : (
        <section className="kernel-panel">
          <h2>Kernel</h2>
          <div className="dim small">Application code is not run cell by cell. Kernels and cells are for data analysis and ML files (marked “cells”).</div>
        </section>
      )}

      <section className="resources">
        <h2>Machine</h2>
        {resources ? (
          <>
            <div className="gauge" role="meter" aria-valuenow={Math.round(used)} aria-valuemin={0} aria-valuemax={100} aria-label="RAM used">
              <div className={`gauge-fill ${used > 85 ? "hot" : used > 65 ? "warm" : ""}`} style={{ width: `${used}%` }} />
            </div>
            <div className="small">
              RAM {Math.round(used)}% · {(resources.ram_available_mb / 1024).toFixed(1)} GB free of {(resources.ram_total_mb / 1024).toFixed(1)} GB
            </div>
            {kernel.memory_mb !== undefined && kernel.memory_mb !== null && <div className="small dim">Kernel {kernel.memory_mb.toFixed(0)} MB</div>}
            <div className="small dim">
              CPU {resources.cpu_percent.toFixed(0)}% of {resources.cpu_count} cores · disk {(resources.disk_free_mb / 1024).toFixed(0)} GB free
            </div>
          </>
        ) : (
          <div className="dim small">…</div>
        )}
      </section>

      {project && (
        <section className="privacy">
          <div className={`badge ${project.config.local_only ? "local" : ""}`}>{project.config.local_only ? "🔒 Local-only" : "Previews enabled"}</div>
          <div className="small dim">Runs on this machine. Nothing is uploaded by this canvas.</div>
        </section>
      )}
    </aside>
  );
}
