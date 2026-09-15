import type { GraphWarning, KernelInfo, ProjectInfo, Resources } from "../types";

export type KernelAction = "start" | "stop" | "restart" | "interrupt" | "clean";

interface SidebarProps {
  project: ProjectInfo | null;
  file: string | null;
  onOpen: (file: string) => void;
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

export function Sidebar({ project, file, onOpen, kernel, resources, hidden, onKernel }: SidebarProps) {
  const used = resources ? Math.max(0, Math.min(100, 100 - (resources.ram_available_mb / resources.ram_total_mb) * 100)) : 0;
  const orphans = hidden.find((w) => w.code === "ORPHAN_VARIABLES");
  return (
    <aside className="sidebar">
      <section>
        <h2 title={project?.root}>{project?.name ?? "Project"}</h2>
        <ul className="file-list">
          {project?.files.map((f) => (
            <li key={f}>
              <button className={f === file ? "active" : ""} onClick={() => onOpen(f)} title={f}>
                <span className="file-icon" aria-hidden>
                  {f.endsWith(".ipynb") ? "📓" : "🐍"}
                </span>
                <span className="file-name">{f}</span>
                {project.sessions.includes(f) && <span className="dot" title="kernel running" />}
              </button>
            </li>
          ))}
          {project && project.files.length === 0 && <li className="dim">No .py or .ipynb files</li>}
        </ul>
      </section>

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
            {kernel.memory_mb !== undefined && kernel.memory_mb !== null && (
              <div className="small dim">Kernel {kernel.memory_mb.toFixed(0)} MB</div>
            )}
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
