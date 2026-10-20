// Shared pieces of the Databases page: the result grid, the plan tree, names and small helpers.
import { useEffect, useMemo, useState } from "react";
import type { SqlDialect } from "../../components/CodeEditor";
import { Icon } from "../../components/Icon";
import type { DbFlavor, DbPlan, PlanNode } from "../../types";

export function dialectOf(flavor: DbFlavor | undefined): SqlDialect {
  return flavor === "postgresql" ? "postgresql" : flavor === "mysql" ? "mysql" : flavor === "sqlite" ? "sqlite" : "standard";
}

/** A name quoted the way the database wants it, when it needs quoting. */
export function ident(flavor: DbFlavor | undefined, name: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(name)) return name;
  return flavor === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;
}

export function qualified(flavor: DbFlavor | undefined, schema: string | null | undefined, name: string): string {
  return schema && !(flavor === "postgresql" && schema === "public") ? `${ident(flavor, schema)}.${ident(flavor, name)}` : ident(flavor, name);
}

export function ms(value: number): string {
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.floor(value / 60_000)} min ${Math.round((value % 60_000) / 1000)} s`;
}

/** Remembered in this browser (tabs, history, the editor's text); never needed for anything to work. */
export function useRemembered<T>(key: string, initial: T): [T, (value: T | ((old: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? (JSON.parse(stored) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full or blocked: only this session remembers */
    }
  }, [key, value]);
  return [value, setValue];
}

function shown(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  const x = Number(a);
  const y = Number(b);
  if (typeof a !== "boolean" && a !== "" && b !== "" && !Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  return String(a).localeCompare(String(b));
}

function tsv(columns: string[], rows: unknown[][]): string {
  const clean = (v: unknown) => (v === null || v === undefined ? "" : String(v).replace(/[\t\n\r]+/g, " "));
  return [columns.join("\t"), ...rows.map((r) => r.map(clean).join("\t"))].join("\n");
}

/** A query result: sort by a column, filter the rows shown, copy them. Sorting and filtering work on
    the rows that came back; the database's ORDER BY and WHERE work on all of them. */
export function ResultGrid({ columns, types, rows, truncated, note }: { columns: string[]; types: string[]; rows: unknown[][]; truncated?: boolean; note?: string }) {
  const [sort, setSort] = useState<{ column: number; desc: boolean } | null>(null);
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setSort(null);
    setFilter("");
  }, [rows]);
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    let out = needle ? rows.filter((r) => r.some((v) => shown(v).toLowerCase().includes(needle))) : rows;
    if (sort) out = [...out].sort((a, b) => compare(a[sort.column], b[sort.column]) * (sort.desc ? -1 : 1));
    return out;
  }, [rows, filter, sort]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tsv(columns, visible));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };
  if (columns.length === 0) return <p className="dim">The statement returned no columns.</p>;
  return (
    <div className="db-grid-wrap">
      <div className="db-grid-bar">
        <span className="db-search">
          <Icon name="filter" size={12} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter these rows" aria-label="Filter the rows shown" />
        </span>
        <span className="dim small num">
          {filter ? `${visible.length.toLocaleString()} of ` : ""}
          {rows.length.toLocaleString()} {rows.length === 1 ? "row" : "rows"}
          {truncated ? ", more in the database" : ""}
        </span>
        {note && <span className="faint small">{note}</span>}
        <span className="spacer" />
        <button className="ghost small" onClick={() => void copy()} title="Copy the rows shown, tab-separated, for a spreadsheet">
          <Icon name={copied ? "check" : "copy"} size={12} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="table-wrap db-grid">
        <table>
          <thead>
            <tr>
              <th className="row-no" aria-label="Row" />
              {columns.map((column, i) => (
                <th key={i} className={types[i] === "number" ? "num" : ""} aria-sort={sort?.column === i ? (sort.desc ? "descending" : "ascending") : "none"}>
                  <button
                    className="db-sort"
                    onClick={() => setSort(sort?.column === i ? (sort.desc ? null : { column: i, desc: true }) : { column: i, desc: false })}
                    title="Sort the rows shown"
                  >
                    {column}
                    {sort?.column === i && <Icon name={sort.desc ? "arrowDown" : "arrowUp"} size={11} />}
                  </button>
                  <span className="sql-type">{types[i]}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, r) => (
              <tr key={r}>
                <td className="row-no">{r + 1}</td>
                {row.map((value, c) => (
                  <td key={c} className={`${types[c] === "number" ? "num" : ""} ${value === null ? "cell-null" : ""}`} title={typeof value === "string" && value.length > 60 ? value : undefined}>
                    {shown(value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="dim sql-no-rows">No rows.</p>}
      </div>
    </div>
  );
}

function Plan({ node, top, depth }: { node: PlanNode; top: number; depth: number }) {
  const [open, setOpen] = useState(true);
  const weight = node.time_ms ?? node.cost ?? 0;
  const share = top > 0 ? Math.min(1, weight / top) : 0;
  return (
    <li>
      <div className={`plan-node ${node.hint ? "hot" : ""}`} style={{ paddingLeft: depth * 18 }}>
        {node.children.length > 0 ? (
          <button className="ghost icon-only small" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? "Hide the steps inside" : "Show the steps inside"}>
            <Icon name={open ? "chevronDown" : "chevronRight"} size={11} />
          </button>
        ) : (
          <span className="plan-leaf" />
        )}
        <div className="plan-main">
          <div className="plan-label">{node.label}</div>
          {node.detail.map((d, i) => (
            <div key={i} className="plan-detail mono">
              {d}
            </div>
          ))}
          {node.hint && (
            <div className="plan-hint">
              <Icon name="warning" size={12} /> {node.hint}
            </div>
          )}
        </div>
        <div className="plan-numbers num">
          {node.time_ms !== undefined && <span title="Time, including the steps inside">{ms(node.time_ms)}</span>}
          {node.actual_rows !== undefined ? (
            <span title="Rows it produced (estimated)">
              {node.actual_rows.toLocaleString()} rows{node.rows !== undefined ? <span className="faint"> (est. {Math.round(node.rows).toLocaleString()})</span> : null}
            </span>
          ) : node.rows !== undefined ? (
            <span title="Rows the planner expects">≈ {Math.round(node.rows).toLocaleString()} rows</span>
          ) : null}
          {node.cost !== undefined && node.time_ms === undefined && <span className="faint" title="The planner's cost estimate">cost {Number(node.cost).toFixed(1)}</span>}
          <span className="plan-bar" aria-hidden>
            <span style={{ width: `${share * 100}%` }} />
          </span>
        </div>
      </div>
      {open && node.children.length > 0 && (
        <ul>
          {node.children.map((child, i) => (
            <Plan key={i} node={child} top={top} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function PlanView({ plan }: { plan: DbPlan }) {
  const [raw, setRaw] = useState(false);
  const top = plan.tree.time_ms ?? plan.tree.cost ?? 0;
  return (
    <div className="plan">
      <div className="db-grid-bar">
        <strong>{plan.analyze ? "What the query did" : "What the database plans to do"}</strong>
        {plan.totals.planning_ms !== undefined && <span className="dim small">Planning {ms(plan.totals.planning_ms)}</span>}
        {plan.totals.execution_ms !== undefined && <span className="dim small">Running {ms(plan.totals.execution_ms)}</span>}
        <span className="spacer" />
        <button className="ghost small" onClick={() => setRaw(!raw)}>
          {raw ? "Show as a tree" : "Show the database's output"}
        </button>
      </div>
      {raw ? (
        <pre className="code plan-raw">{plan.raw}</pre>
      ) : (
        <ul className="plan-tree">
          <Plan node={plan.tree} top={top} depth={0} />
        </ul>
      )}
      <p className="faint small">
        Bars compare {plan.tree.time_ms !== undefined ? "time" : "estimated cost"}; each step includes the steps inside it. {plan.analyze ? "" : "Explain and run shows real times and row counts."}
      </p>
    </div>
  );
}
