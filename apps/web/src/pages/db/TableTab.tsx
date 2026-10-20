// A table or view: its rows (editable when it has a primary key), columns, keys and indexes, and CREATE script.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../../context";
import { CodeEditor } from "../../components/LazyCodeEditor";
import { Icon } from "../../components/Icon";
import { Modal, Notice, Segmented, Spinner } from "../../components/ui";
import type { DatasetMeta, DbExport, DbFlavor, DbRows, DbTableInfo } from "../../types";
import { dialectOf, qualified } from "./common";

export interface TableTabState {
  kind: "table";
  id: string;
  connection_id: string;
  database: string;
  schema: string | null;
  name: string;
  title: string;
}

type Part = "data" | "columns" | "keys" | "sql";
type Values = Record<string, unknown>;
const PAGE = 200;

function shown(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** Copy a FlowLabs dataset into a database table. */
export function ImportDialog({ connectionId, database, schema, table, onClose, onDone }: { connectionId: string; database: string; schema: string | null; table?: string; onClose: () => void; onDone: (table: string) => void }) {
  const { engine, fail, notify } = useApp();
  const [list, setList] = useState<DatasetMeta[] | null>(null);
  const [datasetId, setDatasetId] = useState("");
  const [name, setName] = useState(table ?? "");
  const [mode, setMode] = useState<"create" | "append" | "replace">(table ? "append" : "create");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    engine.call<DatasetMeta[]>("datasets.list").then((all) => {
      const tables = all.filter((d) => d.kind !== "image");
      setList(tables);
      if (tables[0]) {
        setDatasetId(tables[0].id);
        if (!table) setName(tables[0].name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_|_$/g, ""));
      }
    }, fail);
  }, [engine, fail, table]);
  const go = async () => {
    setBusy(true);
    try {
      const done = await engine.call<{ table: string; rows: number }>("db.import", { connection_id: connectionId, database, schema, name, dataset_id: datasetId, mode });
      notify(`Copied ${done.rows.toLocaleString()} rows into ${done.table}.`, "ok");
      onDone(done.table);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={table ? `Import rows into ${table}` : "Import a dataset as a table"}
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={() => void go()} disabled={busy || !datasetId || !name.trim()}>
            {busy ? <Spinner /> : <Icon name="upload" size={13} />} Import
          </button>
        </>
      }
    >
      {list === null ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Notice>There are no table datasets yet. Add a file on the Projects page first.</Notice>
      ) : (
        <>
          <div className="field">
            <label htmlFor="imp-ds">Dataset</label>
            <select id="imp-ds" value={datasetId} onChange={(e) => setDatasetId(e.target.value)}>
              {list.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.rows?.toLocaleString()} rows)
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="imp-name">Table</label>
            <input id="imp-name" value={name} onChange={(e) => setName(e.target.value)} disabled={Boolean(table)} spellCheck={false} />
          </div>
          <div className="field">
            <span className="field-label">If the table already exists</span>
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                ...(table ? [] : [{ value: "create" as const, label: "Stop" }]),
                { value: "append" as const, label: "Add the rows" },
                { value: "replace" as const, label: "Replace the table" },
              ]}
            />
            <span className="help">
              {mode === "replace" ? "The table is dropped and created again from the dataset's columns." : mode === "append" ? "The dataset's columns must match the table's." : "A new table is created; nothing existing is touched."}
            </span>
          </div>
        </>
      )}
    </Modal>
  );
}

function Data({ tab, flavor, onQuery }: { tab: TableTabState; flavor: DbFlavor; onQuery: (sql: string) => void }) {
  const { engine, fail, notify } = useApp();
  const [data, setData] = useState<DbRows | null>(null);
  const [offset, setOffset] = useState(0);
  const [order, setOrder] = useState<{ column: string; desc: boolean } | null>(null);
  const [where, setWhere] = useState("");
  const [applied, setApplied] = useState("");
  const [loading, setLoading] = useState(false);
  const [edits, setEdits] = useState<Record<number, Values>>({});
  const [deletes, setDeletes] = useState<Set<number>>(new Set());
  const [inserts, setInserts] = useState<Values[]>([]);
  const [editing, setEditing] = useState<{ row: number; column: string; insert: boolean; text: string } | null>(null);
  const [review, setReview] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await engine.call<DbRows>("db.rows", { connection_id: tab.connection_id, database: tab.database, schema: tab.schema, name: tab.name, offset, limit: PAGE, order: order ? [order] : [], where: applied || null }));
      setEdits({});
      setDeletes(new Set());
      setInserts([]);
    } catch (error) {
      fail(error);
    } finally {
      setLoading(false);
    }
  }, [engine, fail, tab, offset, order, applied]);
  useEffect(() => {
    void load();
  }, [load]);

  const pending = Object.keys(edits).length + deletes.size + inserts.length;
  const keyOf = (row: unknown[] = []) => Object.fromEntries(data!.primary_key.map((k) => [k, row[data!.columns.findIndex((c) => c.name === k)]]));
  const changes = () => ({
    updates: Object.entries(edits).filter(([i]) => !deletes.has(Number(i))).map(([i, values]) => ({ key: keyOf(data!.rows[Number(i)]), values })),
    inserts: inserts.map((row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined))),
    deletes: [...deletes].map((i) => ({ key: keyOf(data!.rows[i]) })),
  });
  const preview = async () => {
    try {
      const shownSql = await engine.call<{ sql: string[] }>("db.apply", { connection_id: tab.connection_id, database: tab.database, schema: tab.schema, name: tab.name, changes: changes(), preview: true });
      setReview(shownSql.sql);
    } catch (error) {
      fail(error);
    }
  };
  const save = async () => {
    setSaving(true);
    try {
      const done = await engine.call<{ saved: Record<string, number> }>("db.apply", { connection_id: tab.connection_id, database: tab.database, schema: tab.schema, name: tab.name, changes: changes() });
      const s = done.saved;
      notify(`Saved: ${[s.update && `${s.update} changed`, s.insert && `${s.insert} added`, s.delete && `${s.delete} deleted`].filter(Boolean).join(", ")}.`, "ok");
      setReview(null);
      await load();
    } catch (error) {
      fail(error);
    } finally {
      setSaving(false);
    }
  };
  const exportTable = async () => {
    try {
      const written = await engine.call<DbExport>("db.export", { connection_id: tab.connection_id, database: tab.database, sql: `select * from ${qualified(flavor, tab.schema, tab.name)}${applied ? ` where ${applied}` : ""}`, format: "csv", name: tab.name });
      await engine.download(written.path, written.name);
      notify(`Exported ${written.rows.toLocaleString()} rows.`, "ok");
    } catch (error) {
      fail(error);
    }
  };

  const commit = () => {
    if (!editing || !data) return;
    const value = editing.text;
    if (editing.insert) setInserts((rows) => rows.map((r, i) => (i === editing.row ? { ...r, [editing.column]: value } : r)));
    else {
      const original = data.rows[editing.row]?.[data.columns.findIndex((c) => c.name === editing.column)];
      setEdits((all) => {
        const row = { ...(all[editing.row] ?? {}) };
        if (shown(original) === value && original !== null) delete row[editing.column];
        else row[editing.column] = value;
        const next = { ...all, [editing.row]: row };
        if (Object.keys(row).length === 0) delete next[editing.row];
        return next;
      });
    }
    setEditing(null);
  };
  const setNull = () => {
    if (!editing) return;
    if (editing.insert) setInserts((rows) => rows.map((r, i) => (i === editing.row ? { ...r, [editing.column]: null } : r)));
    else setEdits((all) => ({ ...all, [editing.row]: { ...(all[editing.row] ?? {}), [editing.column]: null } }));
    setEditing(null);
  };

  const cellEditor = (row: number, column: string, insert: boolean) =>
    editing && editing.row === row && editing.column === column && editing.insert === insert ? (
      <span className="db-cell-edit">
        <input
          autoFocus
          value={editing.text}
          onChange={(e) => setEditing({ ...editing, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(null);
          }}
          onBlur={commit}
          aria-label={`New value for ${column}`}
        />
        <button className="ghost small" onMouseDown={(e) => e.preventDefault()} onClick={setNull} title="Set to NULL">
          NULL
        </button>
      </span>
    ) : null;

  if (!data) return <div className="db-pad">{loading ? <Spinner /> : null}</div>;
  const why = data.read_only ? "This connection is read-only. Edit it and allow changes to edit rows." : data.primary_key.length === 0 ? "This table has no primary key, so rows cannot be told apart for editing. Change it with SQL." : null;
  const end = Math.min(data.offset + data.rows.length, data.total);

  return (
    <div className="db-data">
      <div className="db-grid-bar">
        <span className="db-search wide">
          <span className="faint small mono">WHERE</span>
          <input
            value={where}
            onChange={(e) => setWhere(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setOffset(0);
                setApplied(where.trim());
              }
            }}
            placeholder="a condition, e.g. city = 'Pune' (Enter)"
            aria-label="Filter rows with a SQL condition"
            spellCheck={false}
          />
        </span>
        <button className="ghost small" onClick={() => void load()} disabled={loading} title="Load the rows again">
          {loading ? <Spinner /> : <Icon name="refresh" size={12} />} Refresh
        </button>
        {data.editable && (
          <button className="ghost small" onClick={() => setInserts((rows) => [...rows, {}])}>
            <Icon name="plus" size={12} /> Add row
          </button>
        )}
        <span className="spacer" />
        <button className="ghost small" onClick={() => onQuery(`select *\nfrom ${qualified(flavor, tab.schema, tab.name)}${applied ? `\nwhere ${applied}` : ""}\nlimit 100;`)}>
          <Icon name="code" size={12} /> Query
        </button>
        <button className="ghost small" onClick={() => void exportTable()}>
          <Icon name="download" size={12} /> CSV
        </button>
        {!data.read_only && (
          <button className="ghost small" onClick={() => setImporting(true)}>
            <Icon name="upload" size={12} /> Import
          </button>
        )}
      </div>
      {why && <p className="faint small db-why">{why}</p>}
      <div className="table-wrap db-grid">
        <table>
          <thead>
            <tr>
              <th className="row-no" aria-label="Row" />
              {data.columns.map((column) => (
                <th key={column.name} aria-sort={order?.column === column.name ? (order.desc ? "descending" : "ascending") : "none"}>
                  <button
                    className="db-sort"
                    onClick={() => {
                      setOffset(0);
                      setOrder(order?.column === column.name ? (order.desc ? null : { column: column.name, desc: true }) : { column: column.name, desc: false });
                    }}
                    title="Sort the table by this column"
                  >
                    {column.key && <Icon name="key" size={11} className="accent-text" />}
                    {column.name}
                    {order?.column === column.name && <Icon name={order.desc ? "arrowDown" : "arrowUp"} size={11} />}
                  </button>
                  <span className="sql-type">{column.type.toLowerCase()}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {inserts.map((row, r) => (
              <tr key={`new-${r}`} className="db-row-new">
                <td className="row-no">
                  <button className="ghost icon-only small" onClick={() => setInserts((rows) => rows.filter((_, i) => i !== r))} aria-label="Remove this new row">
                    <Icon name="close" size={11} />
                  </button>
                </td>
                {data.columns.map((column) => (
                  <td key={column.name} className="added" onDoubleClick={() => setEditing({ row: r, column: column.name, insert: true, text: row[column.name] == null ? "" : String(row[column.name]) })}>
                    {cellEditor(r, column.name, true) ?? (row[column.name] === undefined ? <span className="faint">{column.default ? "default" : ""}</span> : <span className={row[column.name] === null ? "cell-null" : ""}>{shown(row[column.name])}</span>)}
                  </td>
                ))}
              </tr>
            ))}
            {data.rows.map((row, r) => {
              const gone = deletes.has(r);
              return (
                <tr key={r} className={gone ? "db-row-deleted" : ""}>
                  <td className="row-no">
                    {data.editable ? (
                      <button
                        className="ghost icon-only small"
                        onClick={() => setDeletes((all) => {
                          const next = new Set(all);
                          if (next.has(r)) next.delete(r);
                          else next.add(r);
                          return next;
                        })}
                        aria-label={gone ? "Keep this row" : "Delete this row"}
                        title={gone ? "Keep this row" : "Delete this row"}
                      >
                        <Icon name={gone ? "refresh" : "trash"} size={11} />
                      </button>
                    ) : (
                      data.offset + r + 1
                    )}
                  </td>
                  {row.map((value, c) => {
                    const column = data.columns[c]?.name ?? "";
                    const edited = edits[r];
                    const changed = Boolean(edited && column in edited);
                    const now = edited && changed ? edited[column] : value;
                    return (
                      <td
                        key={c}
                        className={`${changed ? "changed" : ""} ${now === null ? "cell-null" : ""}`}
                        onDoubleClick={() => data.editable && !gone && setEditing({ row: r, column, insert: false, text: now === null ? "" : shown(now) })}
                        title={data.editable ? "Double-click to edit" : undefined}
                      >
                        {cellEditor(r, column, false) ?? shown(now)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {data.rows.length === 0 && inserts.length === 0 && <p className="dim sql-no-rows">No rows{applied ? " match" : ""}.</p>}
      </div>
      <div className="db-grid-bar db-pager">
        <span className="dim small num">
          {data.total === 0 ? "No rows" : `${(data.offset + 1).toLocaleString()}–${end.toLocaleString()} of ${data.exact ? "" : "about "}${data.total.toLocaleString()}`}
        </span>
        <button className="ghost small icon-only" onClick={() => setOffset(Math.max(0, offset - PAGE))} disabled={offset === 0 || loading} aria-label="Previous rows">
          <Icon name="arrowLeft" size={12} />
        </button>
        <button className="ghost small icon-only" onClick={() => setOffset(offset + PAGE)} disabled={end >= data.total || loading} aria-label="Next rows">
          <Icon name="arrowRight" size={12} />
        </button>
        <span className="spacer" />
        {pending > 0 && (
          <span className="db-pending" role="status">
            <span className="small">
              {pending} {pending === 1 ? "change" : "changes"} not saved
            </span>
            <button className="ghost small" onClick={() => { setEdits({}); setDeletes(new Set()); setInserts([]); }}>
              Discard
            </button>
            <button className="primary small" onClick={() => void preview()}>
              Review and save
            </button>
          </span>
        )}
      </div>
      {review && (
        <Modal
          title="Save these changes?"
          onClose={() => setReview(null)}
          footer={
            <>
              <button className="ghost" onClick={() => setReview(null)}>
                Keep editing
              </button>
              <button className="primary" onClick={() => void save()} disabled={saving}>
                {saving ? <Spinner /> : null} Save {pending} {pending === 1 ? "change" : "changes"}
              </button>
            </>
          }
        >
          <p className="dim small" style={{ marginBottom: 10 }}>
            They run together in one transaction. If any row was changed by someone else since you loaded it, nothing is saved.
          </p>
          <pre className="code">{review.join("\n")}</pre>
        </Modal>
      )}
      {importing && <ImportDialog connectionId={tab.connection_id} database={tab.database} schema={tab.schema} table={tab.name} onClose={() => setImporting(false)} onDone={() => { setImporting(false); void load(); }} />}
    </div>
  );
}

export function TableTab({ tab, flavor, onQuery }: { tab: TableTabState; flavor: DbFlavor; onQuery: (sql: string) => void }) {
  const { engine, fail } = useApp();
  const [part, setPart] = useState<Part>("data");
  const [info, setInfo] = useState<DbTableInfo | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    engine.call<DbTableInfo>("db.table", { connection_id: tab.connection_id, database: tab.database, schema: tab.schema, name: tab.name }).then(setInfo, fail);
  }, [engine, fail, tab]);
  const keys = useMemo(() => info && [...info.foreign_keys.map((f) => ({ kind: "Foreign key", name: f.name, text: `(${f.columns.join(", ")}) → ${f.references} (${f.referred_columns.join(", ")})${f.on_delete ? ` on delete ${f.on_delete.toLowerCase()}` : ""}` })), ...info.uniques.map((u) => ({ kind: "Unique", name: u.name, text: `(${u.columns.join(", ")})` })), ...info.checks.map((c) => ({ kind: "Check", name: c.name, text: c.sql }))], [info]);

  return (
    <div className="db-object">
      <div className="db-object-head">
        <Icon name={info?.view ? "eye" : "table"} size={16} />
        <h2>{tab.name}</h2>
        {info && <span className="badge">{info.view ? "view" : "table"}</span>}
        {info?.comment && <span className="dim small">{info.comment}</span>}
        <span className="spacer" />
        <Segmented<Part>
          value={part}
          onChange={setPart}
          options={[
            { value: "data", label: "Data" },
            { value: "columns", label: `Columns${info ? ` ${info.columns.length}` : ""}` },
            { value: "keys", label: "Keys and indexes" },
            { value: "sql", label: "SQL" },
          ]}
        />
      </div>
      {part === "data" ? (
        <Data tab={tab} flavor={flavor} onQuery={onQuery} />
      ) : !info ? (
        <div className="db-pad">
          <Spinner />
        </div>
      ) : part === "columns" ? (
        <div className="db-pad">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Type</th>
                  <th>Empty allowed</th>
                  <th>Default</th>
                  <th>Comment</th>
                </tr>
              </thead>
              <tbody>
                {info.columns.map((c) => (
                  <tr key={c.name}>
                    <td>
                      <span className="row" style={{ gap: 6 }}>
                        <strong>{c.name}</strong>
                        {c.key && <span className="badge solid" title="Primary key"><Icon name="key" size={10} /> key</span>}
                        {c.foreign && <span className="badge" title="Refers to another table">foreign</span>}
                        {c.auto && <span className="badge">auto</span>}
                      </span>
                    </td>
                    <td className="mono">{c.type.toLowerCase()}</td>
                    <td>{c.nullable ? "Yes" : "No"}</td>
                    <td className="mono">{c.default ?? ""}</td>
                    <td className="dim">{c.comment ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : part === "keys" ? (
        <div className="db-pad db-keys">
          <h3>Primary key</h3>
          <p className={info.primary_key.length ? "mono" : "dim"}>{info.primary_key.length ? info.primary_key.join(", ") : "None. Rows cannot be edited in the grid."}</p>
          <h3>Indexes</h3>
          {info.indexes.length === 0 ? (
            <p className="dim">None besides the primary key.</p>
          ) : (
            <ul>
              {info.indexes.map((ix, i) => (
                <li key={i}>
                  <span className="mono">{ix.name}</span> on <span className="mono">({ix.columns.join(", ")})</span> {ix.unique && <span className="badge">unique</span>}
                </li>
              ))}
            </ul>
          )}
          <h3>Constraints</h3>
          {keys && keys.length > 0 ? (
            <ul>
              {keys.map((k, i) => (
                <li key={i}>
                  <span className="badge">{k.kind}</span> <span className="mono">{k.name}</span> <span className="mono dim">{k.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="dim">No foreign keys, unique constraints or checks.</p>
          )}
        </div>
      ) : (
        <div className="db-pad">
          <div className="db-grid-bar">
            <span className="dim small">Rebuilt from what the database reports.</span>
            <span className="spacer" />
            <button className="ghost small" onClick={() => { void navigator.clipboard.writeText(info.ddl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
              <Icon name={copied ? "check" : "copy"} size={12} /> {copied ? "Copied" : "Copy"}
            </button>
            <button className="ghost small" onClick={() => onQuery(info.ddl)}>
              <Icon name="code" size={12} /> Open in a query tab
            </button>
          </div>
          <CodeEditor value={info.ddl} readOnly label={`CREATE statement of ${tab.name}`} language="sql" dialect={dialectOf(flavor)} minLines={6} />
        </div>
      )}
    </div>
  );
}

/** A function, procedure, trigger or sequence: its CREATE statement. */
export interface DefinitionTabState {
  kind: "definition";
  id: string;
  connection_id: string;
  database: string;
  schema: string | null;
  name: string;
  object: string;
  signature?: string;
  table?: string;
  title: string;
}

export function DefinitionTab({ tab, flavor, onQuery }: { tab: DefinitionTabState; flavor: DbFlavor; onQuery: (sql: string) => void }) {
  const { engine, fail } = useApp();
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    engine.call<string>("db.ddl", { connection_id: tab.connection_id, database: tab.database, schema: tab.schema, name: tab.name, kind: tab.object, signature: tab.signature, table: tab.table }).then(setText, fail);
  }, [engine, fail, tab]);
  return (
    <div className="db-object">
      <div className="db-object-head">
        <Icon name={tab.object === "sequence" ? "hash" : tab.object === "trigger" ? "bolt" : "function"} size={16} />
        <h2>
          {tab.name}
          {tab.signature !== undefined && <span className="dim mono small">({tab.signature})</span>}
        </h2>
        <span className="badge">{tab.object}</span>
        {tab.table && <span className="dim small">on {tab.table}</span>}
        <span className="spacer" />
        {text && (
          <button className="ghost small" onClick={() => onQuery(text)}>
            <Icon name="code" size={12} /> Open in a query tab
          </button>
        )}
      </div>
      <div className="db-pad">{text === null ? <Spinner /> : <CodeEditor value={text} readOnly label={`Definition of ${tab.name}`} language="sql" dialect={dialectOf(flavor)} minLines={8} />}</div>
    </div>
  );
}
