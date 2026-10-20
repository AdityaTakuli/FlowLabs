// The table designer: columns, keys, indexes, foreign keys and checks in a form. "Review changes"
// shows the SQL that turns the table into the design (core/design.py); nothing runs before that.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../../context";
import { CodeEditor } from "../../components/LazyCodeEditor";
import { Icon } from "../../components/Icon";
import { Modal, Notice, Spinner } from "../../components/ui";
import type { DbFlavor } from "../../types";
import { dialectOf } from "./common";

export interface DesignTabState {
  kind: "design";
  id: string;
  connection_id: string;
  database: string;
  schema: string | null;
  /** The table being changed; null for a new one. */
  name: string | null;
  title: string;
}

interface Column { was: string | null; name: string; type: string; nullable: boolean; default: string | null; primary: boolean; auto: boolean; comment: string | null; generated?: boolean }
interface Index { was: string | null; name: string; columns: string[]; unique: boolean; expression?: boolean; constraint?: boolean }
interface ForeignKey { was: string | null; name: string; columns: string[]; references: string; referred_columns: string[]; on_delete: string | null; on_update: string | null }
interface Check { was: string | null; name: string; sql: string }
interface Design { name: string; comment: string | null; columns: Column[]; indexes: Index[]; foreign_keys: ForeignKey[]; checks: Check[]; read_only?: boolean }

const TYPES: Record<string, string[]> = {
  postgresql: ["integer", "bigint", "smallint", "numeric(10,2)", "real", "double precision", "boolean", "text", "varchar(255)", "char(10)", "date", "timestamp", "timestamp with time zone", "time", "interval", "uuid", "jsonb", "json", "bytea", "inet", "text[]", "integer[]"],
  mysql: ["int", "bigint", "smallint", "tinyint", "decimal(10,2)", "float", "double", "tinyint(1)", "varchar(255)", "char(10)", "text", "mediumtext", "longtext", "date", "datetime", "timestamp", "time", "year", "json", "blob", "longblob", "enum('a','b')"],
  sqlite: ["INTEGER", "REAL", "NUMERIC", "TEXT", "BLOB", "BOOLEAN", "DATE", "TIMESTAMP"],
};
const ACTIONS = ["NO ACTION", "CASCADE", "SET NULL", "RESTRICT", "SET DEFAULT"];

function blankColumn(flavor: DbFlavor, first: boolean): Column {
  const integer = flavor === "mysql" ? "int" : flavor === "sqlite" ? "INTEGER" : "integer";
  return first
    ? { was: null, name: "id", type: integer, nullable: false, default: null, primary: true, auto: true, comment: null }
    : { was: null, name: "", type: flavor === "mysql" ? "varchar(255)" : flavor === "sqlite" ? "TEXT" : "text", nullable: true, default: null, primary: false, auto: false, comment: null };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_|_$/g, "");
}

/** Click columns on and off, in order. */
function ColumnPicker({ options, value, onChange, label }: { options: string[]; value: string[]; onChange: (next: string[]) => void; label: string }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.filter(Boolean).map((name) => {
        const at = value.indexOf(name);
        return (
          <button key={name} type="button" className={`chip db-pick ${at >= 0 ? "token" : ""}`} aria-pressed={at >= 0} onClick={() => onChange(at >= 0 ? value.filter((v) => v !== name) : [...value, name])}>
            {at >= 0 && value.length > 1 && <span className="db-pick-n">{at + 1}</span>}
            {name}
          </button>
        );
      })}
    </div>
  );
}

export function DesignTab({ tab, flavor, readOnly, onSaved }: { tab: DesignTabState; flavor: DbFlavor; readOnly: boolean; onSaved: (name: string, created: boolean) => void }) {
  const { engine, fail, notify } = useApp();
  const [design, setDesign] = useState<Design | null>(null);
  const [tables, setTables] = useState<Record<string, string[]>>({});
  const [review, setReview] = useState<{ sql: string[]; notes: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (tab.name === null) {
      setDesign({ name: "", comment: null, columns: [blankColumn(flavor, true), blankColumn(flavor, false)], indexes: [], foreign_keys: [], checks: [] });
      return;
    }
    engine.call<Design>("db.design", { connection_id: tab.connection_id, database: tab.database, schema: tab.schema, name: tab.name }).then(setDesign, fail);
  }, [engine, fail, tab, flavor]);
  useEffect(load, [load]);
  useEffect(() => {
    engine.call<Record<string, string[]>>("db.columns", { connection_id: tab.connection_id, database: tab.database, schema: tab.schema }).then(setTables, () => undefined);
  }, [engine, tab]);

  const columnNames = useMemo(() => design?.columns.map((c) => c.name.trim()).filter(Boolean) ?? [], [design]);
  if (!design) return <div className="db-pad"><Spinner /></div>;
  const table = slug(design.name) || "table";
  const set = (change: Partial<Design>) => setDesign({ ...design, ...change });
  const setColumn = (i: number, change: Partial<Column>) => {
    const old = design.columns[i]?.name;
    const renamed = change.name !== undefined && old && change.name !== old ? (c: string) => (c === old ? change.name! : c) : null;
    set({
      columns: design.columns.map((c, j) => (j === i ? { ...c, ...change } : c)),
      // a renamed column is renamed in the indexes and foreign keys that use it
      ...(renamed && {
        indexes: design.indexes.map((ix) => ({ ...ix, columns: ix.columns.map(renamed) })),
        foreign_keys: design.foreign_keys.map((fk) => ({ ...fk, columns: fk.columns.map(renamed) })),
      }),
    });
  };
  const setIndex = (i: number, change: Partial<Index>) => set({ indexes: design.indexes.map((c, j) => (j === i ? { ...c, ...change } : c)) });
  const setKey = (i: number, change: Partial<ForeignKey>) => set({ foreign_keys: design.foreign_keys.map((c, j) => (j === i ? { ...c, ...change } : c)) });
  const setCheck = (i: number, change: Partial<Check>) => set({ checks: design.checks.map((c, j) => (j === i ? { ...c, ...change } : c)) });
  const move = (i: number, by: number) => {
    const next = [...design.columns];
    const [item] = next.splice(i, 1);
    next.splice(i + by, 0, item!);
    set({ columns: next });
  };
  const payload = () => ({ connection_id: tab.connection_id, database: tab.database, schema: tab.schema, original: tab.name, design });

  const showReview = async () => {
    try {
      setReview(await engine.call<{ sql: string[]; notes: string[] }>("db.design_sql", payload()));
    } catch (error) {
      fail(error);
    }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const done = await engine.call<{ name: string; sql: string[] }>("db.design_apply", payload());
      notify(tab.name ? `Changed ${done.name}.` : `Created ${done.name}.`, "ok");
      setReview(null);
      onSaved(done.name, tab.name === null);
      if (tab.name !== null) load();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  const otherTables = Object.keys(tables).sort();
  const types = TYPES[flavor] ?? TYPES.postgresql!;
  const moved = design.columns.some((c, i) => c.was !== null && design.columns.filter((x) => x.was !== null).indexOf(c) !== i);

  return (
    <div className="db-object">
      <div className="db-object-head">
        <Icon name="edit" size={16} />
        <h2>{tab.name ? `Design ${tab.name}` : "New table"}</h2>
        {tab.schema && <span className="dim small">in {tab.schema}</span>}
        <span className="spacer" />
        {tab.name && (
          <button className="ghost small" onClick={load}>
            <Icon name="refresh" size={12} /> Discard changes
          </button>
        )}
        <button className="primary" onClick={() => void showReview()} disabled={readOnly}>
          {tab.name ? "Review changes" : "Review and create"}
        </button>
      </div>
      <datalist id={`types-${tab.id}`}>{types.map((t) => <option key={t} value={t} />)}</datalist>
      <div className="db-pad db-design">
        {readOnly && <Notice level="warning">This connection is read-only, so you can look at the design but not change the table. Edit the connection and allow changes.</Notice>}
        <div className="db-design-top">
          <div className="field">
            <label htmlFor={`d-name-${tab.id}`}>Table name</label>
            <input id={`d-name-${tab.id}`} value={design.name} onChange={(e) => set({ name: e.target.value })} spellCheck={false} autoFocus={!tab.name} placeholder="orders" />
          </div>
          <div className="field grow">
            <label htmlFor={`d-comment-${tab.id}`}>Comment</label>
            <input id={`d-comment-${tab.id}`} value={design.comment ?? ""} onChange={(e) => set({ comment: e.target.value || null })} placeholder="What the table holds" />
          </div>
        </div>

        <h3>Columns</h3>
        <div className="table-wrap db-design-grid">
          <table>
            <thead>
              <tr>
                <th aria-label="Order" />
                <th>Name</th>
                <th>Type</th>
                <th title="The primary key: what tells rows apart">Key</th>
                <th title={flavor === "mysql" ? "AUTO_INCREMENT" : flavor === "postgresql" ? "GENERATED BY DEFAULT AS IDENTITY" : "AUTOINCREMENT"}>Auto number</th>
                <th>Empty allowed</th>
                <th>Default</th>
                <th>Comment</th>
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {design.columns.map((c, i) => (
                <tr key={i} className={c.was === null ? "db-row-new" : ""}>
                  <td className="db-design-order">
                    <button className="ghost icon-only small" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${c.name || "the column"} up`}><Icon name="arrowUp" size={11} /></button>
                    <button className="ghost icon-only small" disabled={i === design.columns.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${c.name || "the column"} down`}><Icon name="arrowDown" size={11} /></button>
                  </td>
                  <td><input value={c.name} onChange={(e) => setColumn(i, { name: e.target.value })} aria-label="Column name" spellCheck={false} placeholder="name" /></td>
                  <td><input value={c.type} onChange={(e) => setColumn(i, { type: e.target.value })} list={`types-${tab.id}`} aria-label={`Type of ${c.name}`} spellCheck={false} disabled={c.generated} className="mono" /></td>
                  <td className="db-design-check"><input type="checkbox" checked={c.primary} onChange={(e) => setColumn(i, { primary: e.target.checked, nullable: e.target.checked ? false : c.nullable })} aria-label={`${c.name} is part of the primary key`} /></td>
                  <td className="db-design-check"><input type="checkbox" checked={c.auto} onChange={(e) => setColumn(i, { auto: e.target.checked })} aria-label={`${c.name} numbers itself`} disabled={c.generated} /></td>
                  <td className="db-design-check"><input type="checkbox" checked={c.nullable} onChange={(e) => setColumn(i, { nullable: e.target.checked })} aria-label={`${c.name} may be empty`} disabled={c.primary} /></td>
                  <td><input value={c.default ?? ""} onChange={(e) => setColumn(i, { default: e.target.value || null })} aria-label={`Default of ${c.name}`} spellCheck={false} className="mono" placeholder={c.generated ? "generated" : c.auto ? "" : "none"} disabled={c.generated || (c.auto && flavor === "postgresql")} /></td>
                  <td><input value={c.comment ?? ""} onChange={(e) => setColumn(i, { comment: e.target.value || null })} aria-label={`Comment on ${c.name}`} /></td>
                  <td>
                    <button className="ghost icon-only small" onClick={() => set({ columns: design.columns.filter((_, j) => j !== i) })} aria-label={`Remove ${c.name || "the column"}`} title={c.was ? "Drop this column and its data" : "Remove"}>
                      <Icon name="trash" size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row">
          <button className="ghost small" onClick={() => set({ columns: [...design.columns, blankColumn(flavor, false)] })}>
            <Icon name="plus" size={12} /> Add column
          </button>
          <span className="faint small">Defaults are SQL: <code>0</code>, <code>'text'</code>, <code>{flavor === "mysql" ? "CURRENT_TIMESTAMP" : "now()"}</code>.{moved && tab.name ? " New column order applies to new columns only; existing ones keep their place." : ""}</span>
        </div>

        <h3>Indexes</h3>
        {design.indexes.length === 0 && <p className="faint small">None yet. An index on the columns you filter or join by makes those queries faster.</p>}
        {design.indexes.map((ix, i) => (
          <div key={i} className={`db-design-item ${ix.was === null ? "new" : ""}`}>
            <input value={ix.name} onChange={(e) => setIndex(i, { name: e.target.value })} aria-label="Index name" spellCheck={false} disabled={ix.expression} />
            {ix.expression ? <span className="dim small">An index on an expression; change it with SQL.</span> : <ColumnPicker options={columnNames} value={ix.columns} onChange={(columns) => setIndex(i, { columns, name: ix.was ? ix.name : `${table}_${columns.join("_")}` })} label="Columns of the index" />}
            <label className="db-inline"><input type="checkbox" checked={ix.unique} onChange={(e) => setIndex(i, { unique: e.target.checked })} disabled={ix.expression} /> Unique</label>
            <button className="ghost icon-only small" onClick={() => set({ indexes: design.indexes.filter((_, j) => j !== i) })} aria-label={`Remove the index ${ix.name}`}><Icon name="trash" size={12} /></button>
          </div>
        ))}
        <button className="ghost small" onClick={() => set({ indexes: [...design.indexes, { was: null, name: `${table}_index_${design.indexes.length + 1}`, columns: [], unique: false }] })}>
          <Icon name="plus" size={12} /> Add index
        </button>

        <h3>Foreign keys</h3>
        {design.foreign_keys.length === 0 && <p className="faint small">None yet. A foreign key makes sure a value here exists in another table (an order's customer).</p>}
        {design.foreign_keys.map((fk, i) => (
          <div key={i} className={`db-design-item fk ${fk.was === null ? "new" : ""}`}>
            <input value={fk.name} onChange={(e) => setKey(i, { name: e.target.value })} aria-label="Foreign key name" spellCheck={false} />
            <ColumnPicker options={columnNames} value={fk.columns} onChange={(columns) => setKey(i, { columns })} label="Columns here" />
            <span className="dim small">refer to</span>
            <select value={fk.references} onChange={(e) => setKey(i, { references: e.target.value, referred_columns: [] })} aria-label="Table it refers to">
              <option value="">a table…</option>
              {otherTables.map((t) => <option key={t} value={t}>{t}</option>)}
              {fk.references && !otherTables.includes(fk.references) && <option value={fk.references}>{fk.references}</option>}
            </select>
            <ColumnPicker options={tables[fk.references] ?? fk.referred_columns} value={fk.referred_columns} onChange={(referred_columns) => setKey(i, { referred_columns })} label="Its columns" />
            <label className="db-inline">On delete
              <select value={fk.on_delete ?? "NO ACTION"} onChange={(e) => setKey(i, { on_delete: e.target.value })}>{ACTIONS.map((a) => <option key={a}>{a}</option>)}</select>
            </label>
            <label className="db-inline">On update
              <select value={fk.on_update ?? "NO ACTION"} onChange={(e) => setKey(i, { on_update: e.target.value })}>{ACTIONS.map((a) => <option key={a}>{a}</option>)}</select>
            </label>
            <button className="ghost icon-only small" onClick={() => set({ foreign_keys: design.foreign_keys.filter((_, j) => j !== i) })} aria-label={`Remove the foreign key ${fk.name}`}><Icon name="trash" size={12} /></button>
          </div>
        ))}
        <button className="ghost small" onClick={() => set({ foreign_keys: [...design.foreign_keys, { was: null, name: `${table}_fk_${design.foreign_keys.length + 1}`, columns: [], references: "", referred_columns: [], on_delete: "NO ACTION", on_update: "NO ACTION" }] })}>
          <Icon name="plus" size={12} /> Add foreign key
        </button>

        <h3>Checks</h3>
        {design.checks.length === 0 && <p className="faint small">None yet. A check refuses rows that break a rule, such as <code>total &gt;= 0</code>.</p>}
        {design.checks.map((ch, i) => (
          <div key={i} className={`db-design-item ${ch.was === null ? "new" : ""}`}>
            <input value={ch.name} onChange={(e) => setCheck(i, { name: e.target.value })} aria-label="Check name" spellCheck={false} />
            <input className="mono grow" value={ch.sql} onChange={(e) => setCheck(i, { sql: e.target.value })} aria-label="Condition" spellCheck={false} placeholder="total >= 0" />
            <button className="ghost icon-only small" onClick={() => set({ checks: design.checks.filter((_, j) => j !== i) })} aria-label={`Remove the check ${ch.name}`}><Icon name="trash" size={12} /></button>
          </div>
        ))}
        <button className="ghost small" onClick={() => set({ checks: [...design.checks, { was: null, name: `${table}_check_${design.checks.length + 1}`, sql: "" }] })}>
          <Icon name="plus" size={12} /> Add check
        </button>
      </div>

      {review && (
        <Modal
          title={tab.name ? "Change the table?" : "Create the table?"}
          onClose={() => setReview(null)}
          wide
          footer={
            <>
              <button className="ghost" onClick={() => setReview(null)}>Keep editing</button>
              <button className="primary" onClick={() => void apply()} disabled={busy || review.sql.length === 0}>
                {busy ? <Spinner /> : null} {review.sql.length === 0 ? "Nothing to change" : tab.name ? `Run ${review.sql.length} ${review.sql.length === 1 ? "statement" : "statements"}` : "Create"}
              </button>
            </>
          }
        >
          {review.notes.map((n, i) => <Notice key={i} level="warning">{n}</Notice>)}
          {review.sql.length === 0 ? (
            <p className="dim">The design matches the table.</p>
          ) : (
            <>
              <p className="dim small" style={{ marginBottom: 10 }}>
                {flavor === "mysql" ? "MySQL saves each statement as it runs: if one fails, the ones before it stay." : "They run in one transaction: if one fails, nothing changes."}
                {review.sql.some((s) => /DROP COLUMN/i.test(s)) && " Dropping a column deletes its data."}
              </p>
              <CodeEditor value={review.sql.join("\n\n")} readOnly label="The statements" language="sql" dialect={dialectOf(flavor)} minLines={4} />
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
