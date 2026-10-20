// A query tab: an editor with its own database session, results, messages, plans and history.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../context";
import { EngineError } from "../../engine/engine";
import { CodeEditor } from "../../components/LazyCodeEditor";
import { Icon } from "../../components/Icon";
import { Modal, Notice, Spinner, Switch } from "../../components/ui";
import { ago } from "../../format";
import type { DatasetMeta, DbExport, DbOverview, DbPlan, DbRun, DbSession } from "../../types";
import { dialectOf, ms, PlanView, ResultGrid, useRemembered } from "./common";

export interface QueryTabState {
  kind: "query";
  id: string;
  connection_id: string;
  database: string | null;
  title: string;
}

interface HistoryItem {
  sql: string;
  at: string;
  database: string | null;
  ok: boolean;
  ms: number;
}

type Place = { from: number; to: number; head: number };
type View = { kind: "result"; index: number } | { kind: "messages" } | { kind: "plan" };

const LIMITS = [100, 500, 1000, 5000, 10000];

function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

export function QueryTab({ tab, overview, onChange, onDatasetSaved }: {
  tab: QueryTabState;
  overview: DbOverview | null;
  onChange: (tab: QueryTabState) => void;
  onDatasetSaved?: (dataset: DatasetMeta) => void;
}) {
  const { engine, fail, notify } = useApp();
  const [sql, setSql] = useRemembered<string>(`flowlabs-db-sql:${tab.id}`, "");
  const [limit, setLimit] = useRemembered<number>("flowlabs-db-limit", 500);
  const [history, setHistory] = useRemembered<HistoryItem[]>(`flowlabs-db-history:${tab.connection_id}`, []);
  const [editorHeight, setEditorHeight] = useRemembered<number>("flowlabs-db-editor-height", 220);
  const [session, setSession] = useState<DbSession | null>(null);
  const sessionRef = useRef<DbSession | null>(null);
  const [running, setRunning] = useState<"run" | "explain" | "export" | null>(null);
  const [run, setRun] = useState<DbRun | null>(null);
  const [plan, setPlan] = useState<DbPlan | null>(null);
  const [view, setView] = useState<View>({ kind: "messages" });
  const [errorLine, setErrorLine] = useState<number | null>(null);
  const [completion, setCompletion] = useState<Record<string, string[]> | undefined>(undefined);
  const [menu, setMenu] = useState<"export" | "history" | null>(null);
  const [saveName, setSaveName] = useState<string | null>(null);
  const place = useRef<Place>({ from: 0, to: 0, head: 0 });
  const flavor = overview?.flavor;
  const database = tab.database ?? overview?.default ?? null;

  // the session belongs to this tab; it closes with the tab or when the database changes
  useEffect(() => {
    return () => {
      const open = sessionRef.current;
      if (open) void engine.call("db.session_close", { session_id: open.session_id }).catch(() => undefined);
      sessionRef.current = null;
    };
  }, [engine, tab.connection_id, database]);

  const schemaName = session?.schema ?? (flavor === "postgresql" ? "public" : database);
  useEffect(() => {
    if (!database) return;
    let stale = false;
    engine
      .call<Record<string, string[]>>("db.columns", { connection_id: tab.connection_id, database, schema: schemaName })
      .then((found) => !stale && setCompletion(found), () => undefined);
    return () => {
      stale = true;
    };
  }, [engine, tab.connection_id, database, schemaName]);

  const open = useCallback(async (): Promise<DbSession> => {
    if (sessionRef.current) return sessionRef.current;
    const made = await engine.call<DbSession>("db.session_open", { connection_id: tab.connection_id, database });
    sessionRef.current = made;
    setSession(made);
    return made;
  }, [engine, tab.connection_id, database]);

  /** A call in this tab's session; a session the engine closed (idle, restarted) is opened again once. */
  const inSession = useCallback(
    async <T,>(method: string, params: Record<string, unknown>): Promise<T> => {
      const current = await open();
      try {
        return await engine.call<T>(method, { session_id: current.session_id, ...params });
      } catch (error) {
        const code = (error as EngineError).details && ((error as EngineError).details as { code?: string }).code;
        if (code !== "session_gone") throw error;
        const hadTransaction = current.in_transaction;
        sessionRef.current = null;
        setSession(null);
        const fresh = await open();
        if (hadTransaction) notify("The connection had closed, so its open transaction was rolled back.", "error");
        return engine.call<T>(method, { session_id: fresh.session_id, ...params });
      }
    },
    [engine, open, notify],
  );

  /** What Run works on: the selection, the statement under the cursor, or (all) the whole script. */
  const target = (all: boolean, text = sql) => {
    const { from, to, head } = place.current;
    if (!all && from !== to) return { script: text.slice(Math.min(from, to), Math.max(from, to)), offset: Math.min(from, to), cursor: undefined };
    return { script: text, offset: 0, cursor: all ? undefined : head };
  };

  const execute = async (all: boolean, text = sql) => {
    if (!text.trim() || running) return;
    const { script, offset, cursor } = target(all, text);
    setRunning("run");
    setErrorLine(null);
    setPlan(null);
    const started = Date.now();
    try {
      const outcome = await inSession<DbRun>("db.execute", { sql: script, limit, cursor });
      sessionRef.current = outcome.session;
      setSession(outcome.session);
      setRun(outcome);
      const first = outcome.results.findIndex((r) => r.columns);
      setView(outcome.error || first < 0 ? { kind: "messages" } : { kind: "result", index: first });
      if (outcome.error) setErrorLine(lineAt(text, offset) + outcome.error.line - 1);
      // remember the text of the statements that ran (and the one that failed)
      const spans: [number, number][] = [...outcome.results.map((r): [number, number] => [r.start, r.end]), ...(outcome.error ? [[outcome.error.start, outcome.error.end] as [number, number]] : [])];
      const ran = (spans.length ? script.slice(Math.min(...spans.map((s) => s[0])), Math.max(...spans.map((s) => s[1]))) : script).trim().slice(0, 4000);
      const item: HistoryItem = { sql: ran, at: new Date().toISOString(), database: outcome.session.database, ok: !outcome.error, ms: Date.now() - started };
      setHistory((old) => [item, ...old.filter((h) => h.sql !== ran)].slice(0, 200));
    } catch (error) {
      setRun(null);
      fail(error);
    } finally {
      setRunning(null);
    }
  };

  const stop = async () => {
    const current = sessionRef.current;
    if (!current) return;
    try {
      await engine.call("db.cancel", { session_id: current.session_id });
    } catch (error) {
      fail(error);
    }
  };

  const explain = async (analyze: boolean) => {
    if (!sql.trim() || running) return;
    const { script, offset, cursor } = target(false);
    setRunning("explain");
    setErrorLine(null);
    try {
      setPlan(await inSession<DbPlan>("db.explain", { sql: script, analyze, cursor }));
      setView({ kind: "plan" });
    } catch (error) {
      const line = ((error as EngineError).details as { line?: number } | undefined)?.line;
      if (line) setErrorLine(lineAt(sql, offset) + line - 1);
      fail(error);
    } finally {
      setRunning(null);
    }
  };

  const transaction = async (method: "db.commit" | "db.rollback") => {
    try {
      const next = await inSession<DbSession>(method, {});
      sessionRef.current = next;
      setSession(next);
      notify(method === "db.commit" ? "Committed." : "Rolled back.", "ok");
    } catch (error) {
      fail(error);
    }
  };

  const setAutocommit = async (on: boolean) => {
    try {
      const next = await inSession<DbSession>("db.autocommit", { on });
      sessionRef.current = next;
      setSession(next);
    } catch (error) {
      fail(error);
    }
  };

  const exportAs = async (format: string) => {
    setMenu(null);
    const { script, cursor } = target(false);
    setRunning("export");
    try {
      const written = await engine.call<DbExport>("db.export", { connection_id: tab.connection_id, database: session?.database ?? database, sql: script, format, name: tab.title, cursor });
      await engine.download(written.path, written.name);
      notify(`Exported ${written.rows.toLocaleString()} rows to ${written.name}.`, "ok");
    } catch (error) {
      fail(error);
    } finally {
      setRunning(null);
    }
  };

  const saveDataset = async (name: string) => {
    const { script, cursor } = target(false);
    setSaveName(null);
    setRunning("export");
    try {
      const meta = await engine.call<DatasetMeta>("db.save_dataset", { connection_id: tab.connection_id, database: session?.database ?? database, sql: script, name, cursor });
      notify(`Saved ${meta.rows?.toLocaleString() ?? ""} rows as the dataset ${meta.name}. Start a project from it on the Projects page.`, "ok");
      onDatasetSaved?.(meta);
    } catch (error) {
      fail(error);
    } finally {
      setRunning(null);
    }
  };

  const drag = (event: React.PointerEvent) => {
    const startY = event.clientY;
    const startHeight = editorHeight;
    const move = (e: PointerEvent) => setEditorHeight(Math.max(90, Math.min(window.innerHeight - 220, startHeight + e.clientY - startY)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const results = useMemo(() => run?.results.filter((r) => r.columns) ?? [], [run]);
  const shown = view.kind === "result" ? results[view.index] : undefined;
  const databases = overview?.databases ?? [];
  const busy = running !== null;

  return (
    <div className="db-query">
      <div className="db-toolbar" role="toolbar" aria-label="Query">
        {running === "run" ? (
          <button className="danger" onClick={() => void stop()} title="Ask the server to stop the query">
            <Icon name="stop" /> Stop
          </button>
        ) : (
          <button className="primary" onClick={() => void execute(false)} disabled={busy || !sql.trim()} title="Run the selection, or the statement under the cursor (Ctrl+Enter)">
            <Icon name="play" /> Run
          </button>
        )}
        <button onClick={() => void execute(true)} disabled={busy || !sql.trim()} title="Run every statement (Shift+Ctrl+Enter)">
          Run all
        </button>
        <span className="db-divider" />
        <button className="ghost" onClick={() => void explain(false)} disabled={busy || !sql.trim()} title="Show how the database plans to run the statement under the cursor">
          {running === "explain" ? <Spinner /> : <Icon name="tree" />} Explain
        </button>
        <button className="ghost" onClick={() => void explain(true)} disabled={busy || !sql.trim()} title="Run the statement and show what it really did; changes are rolled back">
          Explain and run
        </button>
        {databases.length > 0 && (
          <label className="db-where">
            <Icon name="database" size={13} />
            <span className="visually-hidden">Database</span>
            <select
              value={database ?? ""}
              onChange={(e) => {
                if (session?.in_transaction && !window.confirm("Switching the database ends this tab's open transaction (it is rolled back). Switch?")) return;
                onChange({ ...tab, database: e.target.value });
                setSession(null);
              }}
              disabled={busy}
              aria-label="Database"
            >
              {databases.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
            {flavor === "postgresql" && session?.schema && <span className="faint small">schema {session.schema}</span>}
          </label>
        )}
        <span className="spacer" />
        {session?.in_transaction && (
          <span className="db-txn" role="status">
            <span className="badge warning">Transaction open</span>
            <button className="small" onClick={() => void transaction("db.commit")} disabled={busy}>
              Commit
            </button>
            <button className="small ghost" onClick={() => void transaction("db.rollback")} disabled={busy}>
              Roll back
            </button>
          </span>
        )}
        {!overview?.read_only && (
          <span title="On: each statement is saved as it runs. Off: changes wait for Commit.">
            <Switch on={session ? session.autocommit : true} onChange={(on) => void setAutocommit(on)} label="Auto-commit" disabled={busy || (Boolean(session?.in_transaction) && !session?.autocommit)} />
          </span>
        )}
        <label className="db-where" title="How many rows each result shows; export gets them all">
          <span className="faint small">Rows</span>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label="Rows to show">
            {LIMITS.map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        <div className="db-menu-anchor">
          <button className="ghost icon-only" onClick={() => setMenu(menu === "history" ? null : "history")} aria-label="History" title="Queries run on this connection" aria-expanded={menu === "history"}>
            <Icon name="clock" />
          </button>
          {menu === "history" && (
            <div className="db-menu wide" role="menu">
              <div className="db-menu-head">
                History <span className="spacer" />
                {history.length > 0 && (
                  <button className="ghost small" onClick={() => setHistory([])}>
                    Clear
                  </button>
                )}
              </div>
              {history.length === 0 && <p className="faint small db-menu-empty">Queries you run here appear here.</p>}
              {history.slice(0, 60).map((item, i) => (
                <button key={i} role="menuitem" className="db-history" onClick={() => { setSql(item.sql); setMenu(null); }} title="Put this query in the editor">
                  <span className={`dot ${item.ok ? "ok" : "bad"}`} />
                  <span className="db-history-sql mono">{item.sql.split("\n").find((l) => l.trim()) ?? item.sql}</span>
                  <span className="faint tiny nowrap">{ago(item.at)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="db-menu-anchor">
          <button className="ghost" onClick={() => setMenu(menu === "export" ? null : "export")} disabled={busy || !sql.trim()} aria-expanded={menu === "export"} title="Run the query in full and save its result">
            {running === "export" ? <Spinner /> : <Icon name="download" />} Export
          </button>
          {menu === "export" && (
            <div className="db-menu" role="menu">
              {([["csv", "CSV"], ["xlsx", "Excel"], ["json", "JSON"], ["parquet", "Parquet"]] as const).map(([id, label]) => (
                <button key={id} role="menuitem" onClick={() => void exportAs(id)}>
                  {label}
                </button>
              ))}
              <div className="db-menu-sep" />
              <button role="menuitem" onClick={() => { setMenu(null); setSaveName(tab.title.replace(/^Query\b.*/, "") || "query result"); }}>
                Save as a dataset for a project…
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="db-editor" style={{ height: editorHeight }}>
        <CodeEditor
          value={sql}
          onChange={setSql}
          label="SQL query"
          language="sql"
          dialect={dialectOf(flavor)}
          schema={completion}
          errorAt={errorLine}
          minLines={4}
          onPlace={(p) => (place.current = p)}
          onRun={(text, p, all) => {
            place.current = p;
            void execute(all, text);
          }}
        />
      </div>
      <div className="db-splitter" onPointerDown={drag} role="separator" aria-orientation="horizontal" aria-label="Drag to resize the editor" />

      <div className="db-output">
        <div className="db-output-tabs" role="tablist">
          {results.map((result, i) => (
            <button key={i} role="tab" aria-selected={view.kind === "result" && view.index === i} className={view.kind === "result" && view.index === i ? "active" : ""} onClick={() => setView({ kind: "result", index: i })}>
              {results.length > 1 ? `Result ${i + 1}` : "Result"}
              <span className="tab-count">{result.rows!.length.toLocaleString()}{result.truncated ? "+" : ""}</span>
            </button>
          ))}
          {plan && (
            <button role="tab" aria-selected={view.kind === "plan"} className={view.kind === "plan" ? "active" : ""} onClick={() => setView({ kind: "plan" })}>
              Plan
            </button>
          )}
          <button role="tab" aria-selected={view.kind === "messages"} className={view.kind === "messages" ? "active" : ""} onClick={() => setView({ kind: "messages" })}>
            Messages
            {run?.error && <span className="tab-count error">1</span>}
          </button>
          <span className="spacer" />
          {running === "run" && (
            <span className="dim small row">
              <Spinner /> Running…
            </span>
          )}
          {run && !running && <span className="faint small">{ms(run.elapsed_ms)}</span>}
        </div>
        <div className="db-output-body">
          {view.kind === "result" && shown ? (
            <ResultGrid columns={shown.columns!} types={shown.types!} rows={shown.rows!} truncated={shown.truncated} note={shown.truncated ? `First ${shown.rows!.length.toLocaleString()} rows. Export for all of them.` : undefined} />
          ) : view.kind === "plan" && plan ? (
            <PlanView plan={plan} />
          ) : run ? (
            <ol className="db-messages">
              {run.results.map((r, i) => (
                <li key={i}>
                  <Icon name="check" size={12} className="ok-text" />
                  <span className="mono db-message-sql">{r.sql.split("\n").find((l) => l.trim())}</span>
                  <span>{r.columns ? `${r.rows!.length.toLocaleString()}${r.truncated ? "+" : ""} rows` : r.message}</span>
                  <span className="faint tiny num">{ms(r.elapsed_ms)}</span>
                </li>
              ))}
              {run.error && (
                <li className="error">
                  <Icon name={run.error.cancelled ? "stop" : "error"} size={12} className="error-text" />
                  <span className="mono db-message-sql">{sql.slice(run.error.start, run.error.end).split("\n").find((l) => l.trim()) ?? ""}</span>
                  <span className="error-text">
                    {run.error.cancelled ? "Stopped. Nothing after it ran." : run.error.message}
                    {!run.error.cancelled && <span className="faint"> (line {errorLine ?? run.error.line})</span>}
                  </span>
                </li>
              )}
            </ol>
          ) : (
            <div className="db-hint">
              <p>
                <kbd>Ctrl</kbd> <kbd>Enter</kbd> runs the statement under the cursor (or the selection). <kbd>Shift</kbd> <kbd>Ctrl</kbd> <kbd>Enter</kbd> runs them all.
              </p>
              <p className="faint">
                This tab keeps its own connection, so SET, USE, temporary tables and transactions last from one run to the next.
                {overview?.read_only ? " The connection is read-only." : ""}
              </p>
            </div>
          )}
        </div>
      </div>

      {saveName !== null && (
        <Modal
          title="Save as a dataset"
          onClose={() => setSaveName(null)}
          footer={
            <>
              <button className="ghost" onClick={() => setSaveName(null)}>
                Cancel
              </button>
              <button className="primary" onClick={() => void saveDataset(saveName)} disabled={!saveName.trim()}>
                Save dataset
              </button>
            </>
          }
        >
          <Notice>The query runs in full and its result becomes a dataset, so you can train models on it or open it in a project.</Notice>
          <div className="field">
            <label htmlFor="db-save-name">Dataset name</label>
            <input id="db-save-name" value={saveName} onChange={(e) => setSaveName(e.target.value)} autoFocus />
          </div>
        </Modal>
      )}
    </div>
  );
}
