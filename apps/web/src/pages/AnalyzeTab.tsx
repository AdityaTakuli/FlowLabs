// Analyze: work with the project's data directly. Table is the whole dataset as a grid (sort, search,
// page through every row); SQL queries it, other datasets or a database, with Ask AI.
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "../context";
import { Icon, type IconName } from "../components/Icon";
import { Spinner } from "../components/ui";
import { cell } from "../format";
import type { SqlResult } from "../types";
import type { ProjectApi } from "./ProjectPage";
import { SqlWorkspace } from "./SqlWorkspace";

type View = "table" | "sql";
const VIEWS: { id: View; label: string; icon: IconName }[] = [
  { id: "table", label: "Table", icon: "table" },
  { id: "sql", label: "SQL", icon: "database" },
];
const PAGE = 100;

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The grid's query: every row of `data`, searched and sorted. */
export function tableQuery(search: string, sort: { column: string; descending: boolean } | null): string {
  const where = search.trim() ? `\nwhere concat_ws(' ', *columns(*)) ilike '%${search.trim().replace(/'/g, "''")}%'` : "";
  const order = sort ? `\norder by ${quote(sort.column)} ${sort.descending ? "desc" : "asc"} nulls last` : "";
  return `select *\nfrom data${where}${order}`;
}

function DataTable({ api, onOpenSql }: { api: ProjectApi; onOpenSql: (sql: string) => void }) {
  const { engine, fail } = useApp();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const [sort, setSort] = useState<{ column: string; descending: boolean } | null>(null);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [loading, setLoading] = useState(false);
  const query = tableQuery(applied, sort);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setResult(await engine.call<SqlResult>("sql.run", { sql: query, dataset_id: api.project.dataset_id, limit: PAGE, offset: page * PAGE }));
    } catch (error) {
      fail(error);
    } finally {
      setLoading(false);
    }
  }, [engine, fail, query, page, api.project.dataset_id]);

  useEffect(() => {
    void load();
  }, [load]);

  // search as you type, a moment after the last key
  useEffect(() => {
    const timer = setTimeout(() => {
      setApplied(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const total = result?.total ?? 0;
  const first = total ? page * PAGE + 1 : 0;
  const last = Math.min(total, (page + 1) * PAGE);
  const target = api.project.target;
  return (
    <div className="data-table">
      <div className="data-table-bar">
        <label className="guide-search data-search">
          <Icon name="search" size={14} />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search every column" aria-label="Search every column" />
        </label>
        {loading && <Spinner />}
        <span className="dim small num">
          {total ? `${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()} rows` : loading ? "" : "No rows match"}
          {applied && " matching"}
        </span>
        <span className="spacer" />
        <button className="ghost small" onClick={() => onOpenSql(query)} title="Open this view as a SQL query">
          <Icon name="database" size={13} /> Open in SQL
        </button>
        <button className="small icon-only" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous rows">
          <Icon name="arrowLeft" size={13} />
        </button>
        <button className="small icon-only" disabled={last >= total} onClick={() => setPage(page + 1)} aria-label="Next rows">
          <Icon name="arrowRight" size={13} />
        </button>
      </div>
      <div className="table-wrap data-table-grid">
        {result && (
          <table>
            <thead>
              <tr>
                <th className="row-no" />
                {result.columns.map((column, i) => {
                  const sorted = sort?.column === column;
                  return (
                    <th
                      key={column}
                      className={`sortable ${result.types[i] === "integer" || result.types[i] === "number" ? "num" : ""} ${column === target ? "target" : ""}`}
                      aria-sort={sorted ? (sort!.descending ? "descending" : "ascending") : "none"}
                    >
                      <button
                        onClick={() => {
                          setSort(sorted ? (sort!.descending ? null : { column, descending: true }) : { column, descending: false });
                          setPage(0);
                        }}
                        title={`Sort by ${column}`}
                      >
                        {column}
                        {sorted && <Icon name={sort!.descending ? "arrowDown" : "arrowUp"} size={11} />}
                      </button>
                      <span className="sql-type">{column === target ? "to predict" : result.types[i]}</span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, r) => (
                <tr key={r}>
                  <td className="row-no">{(first + r).toLocaleString()}</td>
                  {row.map((value, c) => (
                    <td key={c} className={`${value === null ? "cell-null" : typeof value === "number" ? "num" : ""} ${result.columns[c] === target ? "target" : ""}`}>
                      {value === null ? "empty" : cell(value)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function AnalyzeTab({ api }: { api: ProjectApi }) {
  const [view, setView] = useState<View>("table");
  const [sqlSeed, setSqlSeed] = useState<string | null>(null);
  return (
    <div className="charts-page analyze">
      <div className="tabstrip" role="tablist" aria-label="Analyze">
        {VIEWS.map((v) => (
          <button key={v.id} role="tab" aria-selected={view === v.id} className={`tab ${view === v.id ? "active" : ""}`} onClick={() => setView(v.id)}>
            {view === v.id && <motion.span layoutId="analyze-tab" className="tab-surface" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
            <Icon name={v.icon} size={14} />
            <span>{v.label}</span>
          </button>
        ))}
      </div>
      <AnimatePresence mode="wait">
        <motion.div key={view} className="analyze-body" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.1 } }} transition={{ duration: 0.18 }}>
          {view === "table" ? (
            <DataTable
              api={api}
              onOpenSql={(sql) => {
                setSqlSeed(sql);
                setView("sql");
              }}
            />
          ) : (
            <SqlWorkspace api={api} seed={sqlSeed} />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
