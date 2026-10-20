// Back up a database or schema to a .sql file, and restore one (ours, pg_dump's or mysqldump's).
import { useEffect, useRef, useState } from "react";
import { useApp } from "../../context";
import { Icon } from "../../components/Icon";
import { Bar, Modal, Notice, Segmented, Spinner, Switch } from "../../components/ui";
import { bytes } from "../../format";
import type { DbObjects, DbOverview } from "../../types";

type Progress = { done: number; total: number; message: string };
type Finished = { stage: "done" | "error" | "cancelled"; message?: string; result?: Record<string, unknown> };

/** Start a background task (db.backup, db.restore) and follow its events. */
function useTask() {
  const { engine, fail } = useApp();
  const [taskId, setTaskId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [finished, setFinished] = useState<Finished | null>(null);
  const idRef = useRef<string | null>(null);
  useEffect(
    () =>
      engine.subscribe((event) => {
        if (event.type !== "db_task" || event.task_id !== idRef.current) return;
        if (event.stage === "progress") setProgress({ done: event.done ?? 0, total: event.total ?? 1, message: event.message ?? "" });
        else {
          setFinished({ stage: event.stage, message: event.message, result: event.result });
          setTaskId(null);
        }
      }),
    [engine],
  );
  const start = async (method: string, params: Record<string, unknown>) => {
    setFinished(null);
    setProgress({ done: 0, total: 1, message: "Starting…" });
    try {
      const started = await engine.call<{ task_id: string }>(method, params);
      idRef.current = started.task_id;
      setTaskId(started.task_id);
    } catch (error) {
      setProgress(null);
      fail(error);
    }
  };
  const cancel = () => taskId && void engine.call("db.task_cancel", { task_id: taskId }).catch(fail);
  return { running: taskId !== null, progress, finished, start, cancel, reset: () => { setFinished(null); setProgress(null); } };
}

function Running({ progress, onCancel }: { progress: Progress; onCancel: () => void }) {
  const fraction = progress.total > 0 ? progress.done / progress.total : 0;
  return (
    <div className="col db-task" role="status">
      <Bar value={fraction} />
      <div className="row">
        <Spinner />
        <span className="dim small">{progress.message}</span>
        <span className="spacer" />
        <button className="ghost small" onClick={onCancel}>
          Stop
        </button>
      </div>
    </div>
  );
}

export function BackupDialog({ connectionId, overview, database, schema, onClose }: { connectionId: string; overview: DbOverview; database: string; schema: string | null; onClose: () => void }) {
  const { engine, fail } = useApp();
  const task = useTask();
  const [what, setWhat] = useState<"both" | "structure" | "data">("both");
  const [drop, setDrop] = useState(true);
  const [definers, setDefiners] = useState(false);
  const [method, setMethod] = useState<"builtin" | "tool">("builtin");
  const [tools, setTools] = useState<Record<string, string | null>>({});
  const [tables, setTables] = useState<string[] | null>(null);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const tool = overview.flavor === "postgresql" ? "pg_dump" : overview.flavor === "mysql" ? "mysqldump" : null;
  useEffect(() => {
    engine.call<Record<string, string | null>>("db.backup_tools").then(setTools, () => setTools({}));
    engine.call<DbObjects>("db.objects", { connection_id: connectionId, database, schema }).then((found) => setTables(found.tables.map((t) => t.name)), fail);
  }, [engine, fail, connectionId, database, schema]);
  useEffect(() => {
    const result = task.finished?.result as { path?: string; name?: string } | undefined;
    if (task.finished?.stage === "done" && result?.path) void engine.download(result.path, result.name ?? "backup.sql").catch(fail);
  }, [task.finished, engine, fail]);

  const go = () =>
    void task.start("db.backup", {
      connection_id: connectionId,
      database,
      schema,
      options: { method, structure: what !== "data", data: what !== "structure", drop, definers, tables: chosen ? [...chosen] : null },
    });
  const result = task.finished?.result as { name?: string; bytes?: number; rows?: number; tables?: number; views?: number; functions?: number; tool?: string; path?: string } | undefined;
  const where = overview.schemas && schema ? `${database}.${schema}` : database;

  return (
    <Modal
      title={`Back up ${where}`}
      onClose={onClose}
      footer={
        task.finished?.stage === "done" ? (
          <>
            {result?.path && (
              <button className="ghost" onClick={() => void engine.download(result.path!, result.name ?? "backup.sql").catch(fail)}>
                <Icon name="download" size={13} /> Download again
              </button>
            )}
            <button className="primary" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <>
            <button className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" onClick={go} disabled={task.running || (chosen !== null && chosen.size === 0)}>
              {task.running ? <Spinner /> : <Icon name="download" size={13} />} Back up
            </button>
          </>
        )
      }
    >
      {task.finished?.stage === "done" && result ? (
        <Notice level="ok">
          <p>
            <strong>{result.name}</strong> ({bytes(result.bytes ?? 0)}) is in your downloads.
            {result.tool ? ` Made with ${result.tool}.` : ` ${result.tables ?? 0} tables, ${(result.rows ?? 0).toLocaleString()} rows${result.views ? `, ${result.views} views` : ""}${result.functions ? `, ${result.functions} functions` : ""}.`}
          </p>
          <p className="small dim" style={{ marginTop: 6 }}>Restore it here with Restore, or with psql or the mysql client.</p>
        </Notice>
      ) : (
        <>
          {task.finished && task.finished.stage !== "done" && <Notice level="error">{task.finished.message}</Notice>}
          <div className="field">
            <span className="field-label">What to save</span>
            <Segmented value={what} onChange={setWhat} options={[{ value: "both", label: "Structure and rows" }, { value: "structure", label: "Structure only" }, { value: "data", label: "Rows only" }]} />
          </div>
          <div className="field">
            <span className="field-label">Tables</span>
            {tables === null ? (
              <Spinner />
            ) : (
              <>
                <Segmented value={chosen === null ? "all" : "some"} onChange={(v) => setChosen(v === "all" ? null : new Set(tables))} options={[{ value: "all", label: `Everything (${tables.length} tables, views, functions)` }, { value: "some", label: "Some tables" }]} />
                {chosen !== null && (
                  <div className="db-checklist">
                    {tables.map((name) => (
                      <label key={name}>
                        <input type="checkbox" checked={chosen.has(name)} onChange={(e) => setChosen((old) => { const next = new Set(old); if (e.target.checked) next.add(name); else next.delete(name); return next; })} /> {name}
                      </label>
                    ))}
                  </div>
                )}
                {chosen !== null && <span className="help">Only these tables, their rows, indexes and triggers. Views and functions are left out.</span>}
              </>
            )}
          </div>
          {what !== "data" && <Switch on={drop} onChange={setDrop} label="Drop each object first when restoring (DROP … IF EXISTS)" />}
          {overview.flavor === "mysql" && what !== "data" && method === "builtin" && (
            <div style={{ marginTop: 10 }}>
              <Switch on={definers} onChange={setDefiners} label="Keep DEFINER on views, procedures and triggers" />
              <p className="help">Off restores them as whoever runs the restore, which works on another server.</p>
            </div>
          )}
          {tool && (
            <div className="field" style={{ marginTop: 16 }}>
              <span className="field-label">Made by</span>
              <Segmented value={method} onChange={setMethod} options={[{ value: "builtin", label: "FlowLabs" }, { value: "tool", label: tool }]} />
              <span className="help">
                {method === "tool"
                  ? tools[tool]
                    ? `${tool} on the engine's computer (${tools[tool]}). Its version must be the server's or newer.`
                    : `${tool} is not installed on the engine's computer.`
                  : "Works anywhere, nothing to install. Tables, rows, keys, indexes, views, functions, triggers and sequences."}
              </span>
            </div>
          )}
          {task.progress && task.running && <Running progress={task.progress} onCancel={task.cancel} />}
        </>
      )}
    </Modal>
  );
}

interface RestoreResult {
  statements: number | null;
  errors: { line: number | null; sql: string; message: string }[];
  error_count: number;
  skipped: string[];
  rolled_back: boolean;
  stopped: boolean;
  tool?: string;
}

export function RestoreDialog({ connectionId, overview, database: initial, onClose, onDone }: { connectionId: string; overview: DbOverview; database: string; onClose: () => void; onDone: () => void }) {
  const { engine, fail } = useApp();
  const task = useTask();
  const [database, setDatabase] = useState(initial);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState<number | null>(null);
  const [whole, setWhole] = useState(true);
  const [stop, setStop] = useState(true);
  const postgres = overview.flavor === "postgresql";

  const go = async () => {
    if (!file) return;
    setUploading(0);
    try {
      const stored = await engine.uploadFile(file, setUploading);
      setUploading(null);
      await task.start("db.restore", { connection_id: connectionId, database, path: stored.path, options: { one_transaction: postgres && whole, stop_on_error: stop } });
    } catch (error) {
      setUploading(null);
      fail(error);
    }
  };
  useEffect(() => {
    if (task.finished?.stage === "done") onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.finished]);
  const result = task.finished?.result as RestoreResult | undefined;

  if (overview.read_only)
    return (
      <Modal title="Restore" onClose={onClose} footer={<button className="primary" onClick={onClose}>Close</button>}>
        <Notice level="warning">This connection is read-only. Edit it and allow changes to restore into it.</Notice>
      </Modal>
    );
  return (
    <Modal
      title="Restore a backup"
      onClose={onClose}
      footer={
        task.finished?.stage === "done" ? (
          <button className="primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" onClick={() => void go()} disabled={!file || task.running || uploading !== null}>
              {task.running || uploading !== null ? <Spinner /> : <Icon name="upload" size={13} />} Restore
            </button>
          </>
        )
      }
    >
      {task.finished?.stage === "done" && result ? (
        <>
          <Notice level={result.error_count ? (result.rolled_back ? "error" : "warning") : "ok"}>
            {result.rolled_back
              ? "It stopped at an error, and everything it had done was rolled back. Nothing changed."
              : result.error_count
                ? `Ran ${result.statements?.toLocaleString() ?? ""} statements; ${result.error_count} failed${result.stopped ? ", and it stopped at the first" : ""}.`
                : `Restored: ${result.statements?.toLocaleString() ?? "all"} statements ran${result.tool ? ` (with ${result.tool})` : ""}.`}
          </Notice>
          {result.errors.length > 0 && (
            <ol className="db-messages">
              {result.errors.map((e, i) => (
                <li key={i} className="error">
                  <Icon name="error" size={12} className="error-text" />
                  <span className="mono db-message-sql">{e.line ? `line ${e.line}: ` : ""}{e.sql.split("\n").find((l) => l.trim() && !l.startsWith("--"))}</span>
                  <span className="error-text">{e.message}</span>
                  <span />
                </li>
              ))}
            </ol>
          )}
          {result.skipped.length > 0 && <p className="faint small" style={{ marginTop: 8 }}>Skipped {result.skipped.length} psql commands ({result.skipped.slice(0, 2).join(", ").slice(0, 80)}…): the restore runs in the database you chose.</p>}
        </>
      ) : (
        <>
          {task.finished && task.finished.stage !== "done" && <Notice level="error">{task.finished.message}</Notice>}
          <div className="field">
            <label htmlFor="restore-file">Backup file</label>
            <input id="restore-file" type="file" accept=".sql,.gz,.dump,.backup,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <span className="help">A .sql file from FlowLabs, pg_dump or mysqldump (gzipped is fine). pg_dump's custom format (.dump) needs pg_restore on the engine's computer.</span>
          </div>
          <div className="field">
            <label htmlFor="restore-db">Into the database</label>
            <select id="restore-db" value={database} onChange={(e) => setDatabase(e.target.value)}>
              {overview.databases.filter((d) => !d.system).map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
            {!postgres && <span className="help">A MySQL dump may name its own database with USE; it then goes there.</span>}
          </div>
          {postgres && (
            <div className="field">
              <Switch on={whole} onChange={setWhole} label="All or nothing" />
              <span className="help">In one transaction: if anything fails, nothing changes.</span>
            </div>
          )}
          {!(postgres && whole) && (
            <div className="field">
              <Switch on={stop} onChange={setStop} label="Stop at the first error" />
              <span className="help">{stop ? "What ran before the error stays." : "Errors are listed at the end; everything else runs."}</span>
            </div>
          )}
          {uploading !== null && (
            <div className="col db-task">
              <Bar value={uploading} />
              <span className="dim small">Sending the file to the engine…</span>
            </div>
          )}
          {task.progress && task.running && <Running progress={task.progress} onCancel={task.cancel} />}
        </>
      )}
    </Modal>
  );
}
