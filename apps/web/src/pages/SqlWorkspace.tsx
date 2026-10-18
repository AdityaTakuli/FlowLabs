// A project's SQL workspace: query its data (the table `data`), your other datasets (DuckDB) or a
// database you already have; ask AI to write the query; keep a result as a dataset or as the
// project's own data.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../context";
import { CodeEditor } from "../components/LazyCodeEditor";
import type { SqlDialect } from "../components/CodeEditor";
import { Icon } from "../components/Icon";
import { Modal, Notice, Spinner, Switch } from "../components/ui";
import { EngineError } from "../engine/engine";
import type { AiStatus, DatasetMeta, SqlConnection, SqlKind, SqlResult, SqlTable } from "../types";
import type { ProjectApi } from "./ProjectPage";

const LOCAL = "local";
const DRAFT_KEY = "flowlabs-sql-draft:";
const DIALECT: Record<SqlKind["id"], SqlDialect> = { postgresql: "postgresql", mysql: "mysql", sqlite: "sqlite", duckdb: "postgresql", url: "standard" };

function readDraft(source: string): string | null {
  try {
    return localStorage.getItem(DRAFT_KEY + source);
  } catch {
    return null;
  }
}

function writeDraft(source: string, sql: string) {
  try {
    localStorage.setItem(DRAFT_KEY + source, sql);
  } catch {
    /* not remembered: the query still runs */
  }
}

function starter(tables: SqlTable[]): string {
  const first = tables[0];
  return first ? `select *\nfrom ${first.name}\nlimit 100` : "select 42 as answer";
}

function AiSettings({ status, onClose, onSaved }: { status: AiStatus; onClose: () => void; onSaved: (status: AiStatus) => void }) {
  const { engine, fail } = useApp();
  const [key, setKey] = useState("");
  const [model, setModel] = useState(status.model);
  const [busy, setBusy] = useState(false);
  const save = async (remove = false) => {
    setBusy(true);
    try {
      onSaved(await engine.call<AiStatus>("ai.configure", { key: remove ? "" : key || null, model }));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Ask AI"
      onClose={onClose}
      footer={
        <>
          {status.source === "saved" && (
            <button className="danger" onClick={() => void save(true)} disabled={busy}>
              Remove the key
            </button>
          )}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void save()} disabled={busy || (!key && !status.configured)}>
            {busy ? <Spinner /> : null} Save
          </button>
        </>
      }
    >
      <p className="dim" style={{ marginBottom: 14 }}>
        Ask AI turns questions in plain English into SQL, using a model on Groq. Get a free key at{" "}
        <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">
          console.groq.com/keys
        </a>
        .
      </p>
      {status.source === "environment" ? (
        <Notice level="ok">The key comes from the GROQ_API_KEY environment variable.</Notice>
      ) : (
        <div className="field">
          <label htmlFor="ai-key">Groq API key</label>
          <input id="ai-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={status.configured ? "Saved. Paste a new one to replace it." : "gsk_…"} autoComplete="off" />
        </div>
      )}
      <div className="field">
        <label htmlFor="ai-model">Model</label>
        <input id="ai-model" list="ai-models" value={model} onChange={(e) => setModel(e.target.value)} />
        <datalist id="ai-models">
          {status.models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
      <p className="faint small">
        Sent to Groq: your question, table and column names with their types, and a few common values of category columns. Rows of data are never sent. The key is saved on the
        engine, in a file only you can read.
      </p>
    </Modal>
  );
}

function cell(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString() : String(Number(value.toPrecision(8)));
  return String(value);
}

function Schema({ tables, onPick, empty }: { tables: SqlTable[] | null; onPick: (text: string) => void; empty: string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (tables === null) return <Spinner />;
  if (tables.length === 0) return <p className="faint small sql-empty">{empty}</p>;
  return (
    <ul className="sql-tables">
      {tables.map((table) => (
        <li key={table.name}>
          <div className="sql-table">
            <button className="ghost icon-only small" onClick={() => setOpen(open === table.name ? null : table.name)} aria-label={`${open === table.name ? "Hide" : "Show"} the columns of ${table.name}`} aria-expanded={open === table.name}>
              <Icon name={open === table.name ? "chevronDown" : "chevronRight"} size={12} />
            </button>
            <button className="sql-name" onClick={() => onPick(table.name)} title={`Insert ${table.name} into the query`}>
              {table.name}
            </button>
            {table.rows !== undefined && <span className="faint tiny num">{table.rows.toLocaleString()}</span>}
          </div>
          {open === table.name && (
            <ul className="sql-columns">
              {table.columns.map((column) => (
                <li key={column.name}>
                  <button className="sql-name" onClick={() => onPick(column.name)} title={`Insert ${column.name}`}>
                    {column.name}
                  </button>
                  <span className="faint tiny">{column.type}</span>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function Result({ result }: { result: SqlResult }) {
  if (result.message) return <Notice level="ok">{result.message}</Notice>;
  if (result.columns.length === 0) return <p className="dim">The query returned no columns.</p>;
  return (
    <div className="table-wrap sql-result">
      <table>
        <thead>
          <tr>
            <th className="row-no" />
            {result.columns.map((column, i) => (
              <th key={i} className={result.types[i] === "integer" || result.types[i] === "number" ? "num" : ""}>
                {column}
                <span className="sql-type">{result.types[i]}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, r) => (
            <tr key={r}>
              <td className="row-no">{r + 1}</td>
              {row.map((value, c) => (
                <td key={c} className={value === null ? "cell-null" : typeof value === "number" ? "num" : ""}>
                  {value === null ? "empty" : cell(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {result.rows.length === 0 && <p className="dim sql-no-rows">No rows match.</p>}
    </div>
  );
}

function rowsLine(result: SqlResult): string {
  const shown = result.rows.length;
  const time = result.elapsed_ms < 1000 ? `${result.elapsed_ms} ms` : `${(result.elapsed_ms / 1000).toFixed(1)} s`;
  if (!result.truncated) return `${shown.toLocaleString()} ${shown === 1 ? "row" : "rows"} in ${time}`;
  if (result.total !== null) return `First ${shown.toLocaleString()} of ${result.total.toLocaleString()} rows, in ${time}`;
  return `First ${shown.toLocaleString()} rows, in ${time}`;
}

type Draft = Partial<SqlConnection> & { kind: SqlKind["id"]; password?: string };

// Until the Connect form is drawn from each source's fields (Phase 1, in progress), this dialog offers
// the sources it was built for, and reads the engine's source descriptions in the old shape.
const CLASSIC = new Set(["postgresql", "mysql", "sqlite", "duckdb", "url"]);

function classic(described: (SqlKind & { fields?: { name: string; kind: string; default: unknown }[] })[]): SqlKind[] {
  return described
    .filter((k) => CLASSIC.has(k.id))
    .map((k) => ({
      ...k,
      port: k.port ?? ((k.fields?.find((f) => f.name === "port")?.default as number | undefined) ?? null),
      file: k.file ?? Boolean(k.fields?.some((f) => f.kind === "path")),
    }));
}

function ConnectionDialog({ kinds: described, initial, onClose, onSaved }: { kinds: SqlKind[]; initial: SqlConnection | null; onClose: () => void; onSaved: (connection: SqlConnection) => void }) {
  const { engine, fail, openGuide } = useApp();
  const kinds = classic(described);
  const [draft, setDraft] = useState<Draft>(initial ? { ...initial, ...((initial as { values?: Partial<Draft> }).values ?? {}) } : { kind: "postgresql", port: 5432, allow_changes: false });
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const kind = kinds.find((k) => k.id === draft.kind);
  const set = (change: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...change }));
    setTest(null);
  };

  const check = async () => {
    setBusy("test");
    try {
      setTest(await engine.call<{ ok: boolean; message: string }>("sql.connection_test", { connection: draft }));
    } catch (error) {
      setTest({ ok: false, message: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy("save");
    try {
      onSaved(await engine.call<SqlConnection>("sql.connection_save", { connection: draft }));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      title={initial ? `Edit ${initial.name}` : "Connect a database"}
      onClose={onClose}
      footer={
        <>
          {test && (
            <span className={`small ${test.ok ? "ok-text" : "error-text"} sql-test`}>
              <Icon name={test.ok ? "check" : "error"} size={13} /> {test.message}
            </span>
          )}
          <span className="spacer" />
          <button onClick={() => void check()} disabled={busy !== null}>
            {busy === "test" ? <Spinner /> : <Icon name="bolt" size={13} />} Test
          </button>
          <button className="primary" onClick={() => void save()} disabled={busy !== null}>
            {busy === "save" ? <Spinner /> : null} {initial ? "Save changes" : "Save connection"}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="sql-kind">Database</label>
        <select id="sql-kind" value={draft.kind} onChange={(e) => {
          const next = kinds.find((k) => k.id === e.target.value);
          set({ kind: e.target.value as SqlKind["id"], port: next?.port ?? undefined });
        }}>
          {kinds.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
      </div>
      {draft.kind === "url" ? (
        <div className="field">
          <label htmlFor="sql-url">Database URL</label>
          <input id="sql-url" value={draft.url ?? ""} onChange={(e) => set({ url: e.target.value })} placeholder="mssql+pyodbc://user:password@host/db?driver=ODBC+Driver+18+for+SQL+Server" spellCheck={false} />
          <span className="help">Any SQLAlchemy URL. Install the database's Python driver in the engine first.</span>
        </div>
      ) : kind?.file ? (
        <div className="field">
          <label htmlFor="sql-file">File on {engine.kind === "remote" ? "the engine's computer" : "this computer"}</label>
          <input id="sql-file" value={draft.database ?? ""} onChange={(e) => set({ database: e.target.value })} placeholder={draft.kind === "sqlite" ? "/home/me/data/shop.sqlite" : "/home/me/data/warehouse.duckdb"} spellCheck={false} />
        </div>
      ) : (
        <>
          <div className="sql-form-row">
            <div className="field grow">
              <label htmlFor="sql-host">Host</label>
              <input id="sql-host" value={draft.host ?? ""} onChange={(e) => set({ host: e.target.value })} placeholder="localhost" spellCheck={false} />
            </div>
            <div className="field port">
              <label htmlFor="sql-port">Port</label>
              <input id="sql-port" type="number" value={draft.port ?? ""} onChange={(e) => set({ port: e.target.value ? Number(e.target.value) : undefined })} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="sql-db">Database name</label>
            <input id="sql-db" value={draft.database ?? ""} onChange={(e) => set({ database: e.target.value })} spellCheck={false} />
          </div>
          <div className="sql-form-row">
            <div className="field grow">
              <label htmlFor="sql-user">User</label>
              <input id="sql-user" value={draft.user ?? ""} onChange={(e) => set({ user: e.target.value })} autoComplete="off" spellCheck={false} />
            </div>
            <div className="field grow">
              <label htmlFor="sql-password">Password</label>
              <input id="sql-password" type="password" value={draft.password ?? ""} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" placeholder={initial?.password_set ? "Unchanged" : ""} />
            </div>
          </div>
        </>
      )}
      <div className="field">
        <label htmlFor="sql-name">Name in FlowLabs</label>
        <input id="sql-name" value={draft.name ?? ""} onChange={(e) => set({ name: e.target.value })} placeholder="Defaults to the database name" />
      </div>
      <div className="field">
        <Switch on={Boolean(draft.allow_changes)} onChange={(on) => set({ allow_changes: on })} label="Allow changes to this database" />
        <span className="help">
          {draft.allow_changes
            ? "INSERT, UPDATE, DELETE and other statements that write run and are committed."
            : "Read-only: statements that write are refused, and anything a query ran is rolled back."}
        </span>
      </div>
      <p className="faint small">
        The connection, password included, is saved in the engine's workspace in a file only you can read. Queries run on the computer the engine runs on.{" "}
        <button className="link" onClick={() => openGuide("sql#connect-a-database")}>
          More about connections
        </button>
      </p>
    </Modal>
  );
}

export function SqlWorkspace({ api, seed }: { api: ProjectApi; seed?: string | null }) {
  const { engine, fail, notify } = useApp();
  const datasetId = api.project.dataset_id;
  const draftKey = (name: string) => `${api.project.id}:${name}`;
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [tables, setTables] = useState<SqlTable[] | null>(null);
  const [connections, setConnections] = useState<SqlConnection[]>([]);
  const [kinds, setKinds] = useState<SqlKind[]>([]);
  const [source, setSource] = useState(LOCAL);
  const [sourceTables, setSourceTables] = useState<SqlTable[] | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [query, setQueryState] = useState<string>(() => seed ?? readDraft(`${api.project.id}:${LOCAL}`) ?? "");
  const latest = useRef(query); // the editor's text right now, ahead of the next render
  const setQuery = useCallback((next: string | ((previous: string) => string)) => {
    setQueryState((previous) => {
      const value = typeof next === "function" ? next(previous) : next;
      latest.current = value;
      return value;
    });
  }, []);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<{ message: string; line: number | null } | null>(null);
  const [running, setRunning] = useState(false);
  const [insert, setInsert] = useState<{ text: string; n: number } | undefined>();
  const [editing, setEditing] = useState<SqlConnection | "new" | null>(null);
  const [saveName, setSaveName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<DatasetMeta | null>(null);
  const inBrowser = engine.kind === "browser";
  const connection = connections.find((c) => c.id === source) ?? null;

  const loadTables = useCallback(async () => {
    try {
      const next = await engine.call<SqlTable[]>("sql.tables", { dataset_id: datasetId });
      setTables(next);
      return next;
    } catch (error) {
      fail(error);
      setTables([]);
      return [];
    }
  }, [engine, fail, datasetId]);

  useEffect(() => {
    void loadTables().then((next) => setQuery((q) => q || starter(next)));
    if (!inBrowser) {
      engine.call<SqlConnection[]>("sql.connections").then(setConnections, fail);
      engine.call<SqlKind[]>("sql.kinds").then(setKinds, fail);
      engine.call<AiStatus>("ai.status").then(setAi, () => setAi(null));
    }
  }, [engine, fail, inBrowser, loadTables]);

  useEffect(() => {
    if (source === LOCAL) return;
    setSourceTables(null);
    setSourceError(null);
    engine.call<SqlTable[]>("sql.connection_tables", { connection_id: source }).then(setSourceTables, (error: Error) => {
      setSourceTables([]);
      setSourceError(error.message);
    });
  }, [engine, source]);

  const choose = (next: string) => {
    if (next === source) return;
    writeDraft(draftKey(source), query);
    setSource(next);
    setResult(null);
    setError(null);
    setSaved(null);
    setExplanation(null);
    setQuery(readDraft(draftKey(next)) ?? (next === LOCAL ? starter(tables ?? []) : "select 1"));
  };

  const shown = source === LOCAL ? tables : sourceTables;
  const schema = useMemo(() => Object.fromEntries((shown ?? []).map((t) => [t.name, t.columns.map((c) => c.name)])), [shown]);

  const run = useCallback(async (text: string = latest.current) => {
    if (running) return;
    writeDraft(draftKey(source), text);
    setRunning(true);
    setError(null);
    setSaved(null);
    try {
      setResult(await engine.call<SqlResult>("sql.run", { sql: text, connection_id: source === LOCAL ? null : source, limit: 500, dataset_id: datasetId }));
    } catch (failure) {
      const details = (failure instanceof EngineError ? failure.details : null) as { line?: number } | null;
      setResult(null);
      setError({ message: (failure as Error).message, line: details?.line ?? null });
    } finally {
      setRunning(false);
    }
  }, [engine, running, source, datasetId]);

  /** Plain English (or a failed query) to SQL, then run it. */
  const ask = async (fix = false) => {
    if (!ai?.configured) {
      setAiOpen(true);
      return;
    }
    setAsking(true);
    try {
      const answer = await engine.call<{ sql: string; explanation: string }>("ai.sql", {
        question: fix ? "" : question,
        connection_id: source === LOCAL ? null : source,
        dataset_id: datasetId,
        sql: fix ? latest.current : "",
        error: fix ? error?.message : null,
      });
      setExplanation(answer.explanation || null);
      if (answer.sql) {
        setQuery(answer.sql);
        latest.current = answer.sql;
        await run(answer.sql);
      }
    } catch (failure) {
      fail(failure);
    } finally {
      setAsking(false);
    }
  };

  const useAsProjectData = (meta: DatasetMeta) => {
    if (!window.confirm(`Train this project on “${meta.name}” (${meta.rows.toLocaleString()} rows) instead of its current data? The old dataset is kept, and you can switch back on the Data page.`)) return;
    api.update((p) => ({ ...p, dataset_id: meta.id }));
    notify(`This project now uses ${meta.name}.`, "ok");
  };

  const saveResult = async () => {
    if (saveName === null) return;
    setSaving(true);
    try {
      const meta = await engine.call<DatasetMeta>("sql.save", { sql: latest.current, name: saveName, connection_id: source === LOCAL ? null : source, dataset_id: datasetId });
      setSaved(meta);
      setSaveName(null);
      notify(`Saved ${meta.rows.toLocaleString()} rows as the dataset ${meta.name}.`, "ok");
      void loadTables();
    } catch (failure) {
      fail(failure);
    } finally {
      setSaving(false);
    }
  };

  const removeConnection = async (target: SqlConnection) => {
    if (!window.confirm(`Remove the connection “${target.name}”? The database itself is not touched.`)) return;
    try {
      await engine.call("sql.connection_delete", { connection_id: target.id });
      setConnections((list) => list.filter((c) => c.id !== target.id));
      if (source === target.id) choose(LOCAL);
    } catch (failure) {
      fail(failure);
    }
  };

  const suggestedName = () => {
    const match = /\bfrom\s+([A-Za-z_][\w.]*)/i.exec(query);
    const table = (match?.[1] ?? "").split(".").pop();
    return table && table !== "data" ? `${table} query` : `${api.project.name} query`;
  };

  return (
    <>
      <div className="sql-layout in-project">
        <aside className="sql-side" aria-label="Tables">
          <section>
            <button className={`sql-source ${source === LOCAL ? "active" : ""}`} onClick={() => choose(LOCAL)} aria-pressed={source === LOCAL}>
              <Icon name="table" size={14} />
              <span className="sql-source-text">
                <b>This project</b>
                <span className="faint tiny">data, and your other datasets</span>
              </span>
            </button>
            {source === LOCAL && <Schema tables={tables} onPick={(text) => setInsert({ text, n: Date.now() })} empty="No tables yet. Import a CSV, Excel or Parquet file on the home page." />}
          </section>
          <section>
            <h3 className="sql-side-head">Databases</h3>
            {inBrowser ? (
              <p className="faint small sql-empty">The browser cannot reach a database server. Use the desktop app, or connect this page to `flowlabs engine` from the engine menu.</p>
            ) : (
              <>
                {connections.map((c) => (
                  <div key={c.id} className="sql-connection">
                    <button className={`sql-source ${source === c.id ? "active" : ""}`} onClick={() => choose(c.id)} aria-pressed={source === c.id}>
                      <Icon name="database" size={14} />
                      <span className="sql-source-text">
                        <b className="ellipsis">{c.name}</b>
                        <span className="faint tiny">
                          {c.kind_label}, {c.allow_changes ? "changes allowed" : "read-only"}
                        </span>
                      </span>
                    </button>
                    <button className="ghost icon-only small" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>
                      <Icon name="edit" size={12} />
                    </button>
                    <button className="ghost icon-only small" onClick={() => void removeConnection(c)} aria-label={`Remove ${c.name}`}>
                      <Icon name="trash" size={12} />
                    </button>
                    {source === c.id && (
                      <div className="sql-connection-tables">
                        {sourceError ? <p className="error-text small sql-empty">{sourceError}</p> : <Schema tables={sourceTables} onPick={(text) => setInsert({ text, n: Date.now() })} empty="This database has no tables." />}
                      </div>
                    )}
                  </div>
                ))}
                <button className="small sql-connect" onClick={() => setEditing("new")}>
                  <Icon name="plus" size={12} /> Connect a database
                </button>
              </>
            )}
          </section>
        </aside>

        <main className="sql-main">
          <div className="sql-bar">
            <div className="sql-where">
              <Icon name={connection ? "database" : "table"} size={14} className="faint" />
              <span>
                {connection ? (
                  <>
                    Querying <b>{connection.name}</b>
                    {!connection.allow_changes && (
                      <span className="badge sql-ro">
                        <Icon name="lock" size={10} /> read-only
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <b>data</b> is this project's table; other datasets are tables too. Your files never change.
                  </>
                )}
              </span>
            </div>
            <span className="spacer" />
            <span className="faint tiny sql-keys">Ctrl+Enter runs</span>
            <button className="primary" onClick={() => void run()} disabled={running}>
              {running ? <Spinner /> : <Icon name="play" size={13} />} Run
            </button>
          </div>
          {!inBrowser && (
            <form
              className="ask-ai"
              onSubmit={(e) => {
                e.preventDefault();
                void ask();
              }}
            >
              <Icon name="sparkles" size={15} className="accent-text" />
              <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask in plain English, e.g. churn rate by contract type" aria-label="Ask AI" />
              <button type="submit" className="small" disabled={asking || (!question.trim() && Boolean(ai?.configured))}>
                {asking ? <Spinner /> : null} {ai?.configured ? "Write SQL" : "Set up Ask AI"}
              </button>
              <button type="button" className="ghost icon-only small" onClick={() => setAiOpen(true)} title="Ask AI settings" aria-label="Ask AI settings">
                <Icon name="gear" size={13} />
              </button>
            </form>
          )}
          {explanation && (
            <p className="ai-explanation">
              <Icon name="sparkles" size={12} /> {explanation}
            </p>
          )}
          <CodeEditor
            value={query}
            onChange={(code) => {
              latest.current = code;
              setQuery(code);
            }}
            label="SQL query"
            language="sql"
            dialect={connection ? DIALECT[connection.kind] : "postgresql"}
            schema={schema}
            onRun={(code) => {
              setQuery(code);
              void run(code);
            }}
            insert={insert}
            minLines={7}
            errorAt={error?.line ?? null}
          />

          {error && (
            <Notice level="error">
              <div className="row wrap" style={{ justifyContent: "space-between" }}>
                <span>
                  {error.line ? `Line ${error.line}: ` : ""}
                  {error.message}
                </span>
                {ai?.configured && (
                  <button className="small" onClick={() => void ask(true)} disabled={asking}>
                    {asking ? <Spinner /> : <Icon name="sparkles" size={12} />} Fix with AI
                  </button>
                )}
              </div>
            </Notice>
          )}

          {result && (
            <section className="sql-output">
              {!result.message && (
                <div className="sql-result-head">
                  <span className="dim small">{rowsLine(result)}</span>
                  <span className="spacer" />
                  {saved ? (
                    <>
                      <span className="small ok-text">
                        <Icon name="check" size={12} /> Saved as {saved.name}
                      </span>
                      <button className="small" onClick={() => useAsProjectData(saved)}>
                        Use as this project's data
                      </button>
                    </>
                  ) : (
                    result.columns.length > 0 && (
                      <button className="small" onClick={() => setSaveName(suggestedName())}>
                        <Icon name="download" size={12} /> Save as dataset
                      </button>
                    )
                  )}
                </div>
              )}
              <Result result={result} />
            </section>
          )}
          {!result && !error && !running && (
            <p className="faint small sql-hint">
              Write a query, or ask AI, and press Run. Click a table or column on the left to insert its name. To train on a result, save it as a dataset and use it as this project's data.
            </p>
          )}
        </main>
      </div>

      {editing && (
        <ConnectionDialog
          kinds={kinds}
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setConnections((list) => [...list.filter((c) => c.id !== saved.id), saved]);
            setEditing(null);
            if (source === saved.id) {
              setSourceTables(null);
              engine.call<SqlTable[]>("sql.connection_tables", { connection_id: saved.id }).then(setSourceTables, (e: Error) => setSourceError(e.message));
            } else {
              choose(saved.id);
            }
          }}
        />
      )}
      {saveName !== null && (
        <Modal
          title="Save the result as a dataset"
          onClose={() => setSaveName(null)}
          footer={
            <>
              <span className="spacer" />
              <button onClick={() => setSaveName(null)}>Cancel</button>
              <button className="primary" disabled={saving || !saveName.trim()} onClick={() => void saveResult()}>
                {saving ? <Spinner /> : null} Save dataset
              </button>
            </>
          }
        >
          <div className="field">
            <label htmlFor="sql-save-name">Dataset name</label>
            <input id="sql-save-name" value={saveName} onChange={(e) => setSaveName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void saveResult()} autoFocus />
            <span className="help">The query runs again in full, so every row is saved, not only the {result?.rows.length ?? 500} shown.</span>
          </div>
        </Modal>
      )}
      {aiOpen && ai && (
        <AiSettings
          status={ai}
          onClose={() => setAiOpen(false)}
          onSaved={(next) => {
            setAi(next);
            setAiOpen(false);
          }}
        />
      )}
    </>
  );
}
