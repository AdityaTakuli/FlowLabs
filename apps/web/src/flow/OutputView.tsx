import { useEffect, useRef, useState } from "react";
import type { Api } from "../api";
import { ApiError } from "../api";
import { formatDuration } from "../layout";
import type { FramePreview, NodeOutput, PortOutput, TableSchema } from "./types";

export function DataGrid({ preview, total }: { preview: FramePreview; total?: number }) {
  if (!preview.columns.length) return <div className="dim small">No columns.</div>;
  return (
    <>
      <div className="table-scroll">
        <table className="grid">
          <thead>
            <tr>
              {preview.columns.map((column, i) => (
                <th key={column} title={preview.dtypes[i]}>
                  {column}
                  <span className="dtype">{preview.dtypes[i]}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.data.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c} className={cell === null ? "null-cell" : typeof cell === "number" ? "num" : ""}>
                    {cell === null ? "null" : typeof cell === "object" ? JSON.stringify(cell) : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="dim small grid-foot">
        {total !== undefined && total > preview.data.length
          ? `First ${preview.data.length} of ${total.toLocaleString()} rows (preview only, never leaves this machine)`
          : `${preview.data.length.toLocaleString()} rows`}
      </div>
    </>
  );
}

export function SchemaChips({ schema }: { schema: TableSchema }) {
  return (
    <div className="schema-chips">
      {schema.columns.map((c) => (
        <span key={c.name} className={`chip role-${c.role}`} title={`${c.dtype} · ${c.semantic}${c.null_frac ? ` · ${(c.null_frac * 100).toFixed(1)}% null` : ""}`}>
          {c.name}
          <span className="dim"> {c.semantic.replace(/_/g, " ")}</span>
          {c.role !== "feature" && <span className="role"> {c.role}</span>}
        </span>
      ))}
    </div>
  );
}

let embedModule: Promise<typeof import("vega-embed")> | null = null;

export function VegaChart({ spec }: { spec: Record<string, unknown> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let finalize: (() => void) | null = null;
    embedModule ??= import("vega-embed");
    embedModule
      .then(({ default: embed }) => {
        if (cancelled || !ref.current) return;
        const themed = { width: "container", ...spec, background: "transparent", autosize: { type: "fit-x", contains: "padding" } };
        return embed(ref.current, themed as Parameters<typeof embed>[1], { actions: false, theme: "dark", renderer: "svg" }).then((result) => {
          if (cancelled) result.finalize();
          else finalize = () => result.finalize();
        });
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
      finalize?.();
    };
  }, [spec]);
  return error ? <div className="field-error">Chart could not render: {error}</div> : <div className="vega-chart" ref={ref} />;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(Math.abs(value) < 1 ? 4 : 2);
  if (value === null) return "—";
  return String(value);
}

function MetricsView({ value }: { value: Record<string, unknown> }) {
  const scalars = Object.entries(value).filter(([, v]) => typeof v !== "object" || v === null);
  const tables = Object.entries(value).filter(([, v]) => Array.isArray(v) && v.length > 0 && v.every(isRecord)) as [string, Record<string, unknown>[]][];
  const matrix = isRecord(value.confusion_matrix) ? (value.confusion_matrix as { labels: string[]; matrix: number[][] }) : null;
  const rest = Object.entries(value).filter(([k, v]) => typeof v === "object" && v !== null && k !== "confusion_matrix" && !tables.some(([t]) => t === k));
  return (
    <div className="metrics">
      {scalars.length > 0 && (
        <div className="stat-grid">
          {scalars.map(([key, v]) => (
            <div key={key} className="stat">
              <div className="stat-value">{formatValue(v)}</div>
              <div className="stat-label">{key.replace(/_/g, " ")}</div>
            </div>
          ))}
        </div>
      )}
      {matrix && (
        <>
          <h3>Confusion matrix</h3>
          <table className="grid matrix">
            <thead>
              <tr>
                <th>actual ↓ / predicted →</th>
                {matrix.labels.map((l) => (
                  <th key={l}>{l}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.matrix.map((row, i) => (
                <tr key={i}>
                  <th>{matrix.labels[i]}</th>
                  {row.map((cell, j) => (
                    <td key={j} className={`num ${i === j ? "diag" : ""}`}>
                      {cell.toLocaleString()}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {tables.map(([key, rows]) => {
        const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
        return (
          <div key={key}>
            <h3>{key.replace(/_/g, " ")}</h3>
            <DataGrid preview={{ columns, dtypes: columns.map(() => ""), data: rows.map((r) => columns.map((c) => (r[c] ?? null) as unknown)) }} />
          </div>
        );
      })}
      {rest.map(([key, v]) => (
        <details key={key} className="variable-card">
          <summary>{key.replace(/_/g, " ")}</summary>
          <pre className="repr">{JSON.stringify(v, null, 2)}</pre>
        </details>
      ))}
    </div>
  );
}

function PortView({ name, port }: { name: string; port: PortOutput }) {
  const [partition, setPartition] = useState<string | null>(null);
  if (port.missing) return <div className="dim small">Not produced in this run (the node failed or was skipped).</div>;
  switch (port.kind) {
    case "table":
      return (
        <>
          {port.schema && <SchemaChips schema={port.schema} />}
          {port.preview && <DataGrid preview={port.preview} total={port.rows} />}
        </>
      );
    case "table_split": {
      const parts = Object.entries(port.partitions ?? {});
      const active = parts.find(([p]) => p === partition) ?? parts[0];
      return (
        <>
          <div className="segmented small-seg" role="tablist" aria-label={`${name} partitions`}>
            {parts.map(([p, info]) => (
              <button key={p} role="tab" aria-selected={active?.[0] === p} className={active?.[0] === p ? "active" : ""} onClick={() => setPartition(p)}>
                {p} · {info.rows.toLocaleString()}
              </button>
            ))}
          </div>
          {port.schema && <SchemaChips schema={port.schema} />}
          {active && <DataGrid preview={active[1].preview} total={active[1].rows} />}
        </>
      );
    }
    case "chart": {
      const value = port.value ?? {};
      return (
        <>
          {typeof value.narration === "string" && <p className="narration">{value.narration}</p>}
          {isRecord(value.spec) && <VegaChart spec={value.spec} />}
        </>
      );
    }
    case "model":
      return port.model ? (
        <dl className="stats">
          <dt>Algorithm</dt>
          <dd>{port.model.algorithm.replace(/_/g, " ")}</dd>
          <dt>Task</dt>
          <dd>{port.model.task}</dd>
          <dt>Target</dt>
          <dd>{port.model.target}</dd>
          {port.model.classes && (
            <>
              <dt>Classes</dt>
              <dd>{port.model.classes.join(", ")}</dd>
            </>
          )}
          <dt>Features</dt>
          <dd className="wrap">{port.model.features.join(", ")}</dd>
        </dl>
      ) : (
        <div className="dim small">Fitted model.</div>
      );
    default:
      return port.value ? <MetricsView value={port.value} /> : <div className="dim small">No preview for {port.kind}.</div>;
  }
}

export function OutputView({ api, runId, nodeId, refreshKey }: { api: Api; runId: string | null; nodeId: string; refreshKey: string }) {
  const [output, setOutput] = useState<NodeOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setOutput(null);
    setError(null);
    if (!runId) return;
    let live = true;
    api
      .nodeOutput(runId, nodeId)
      .then((next) => live && setOutput(next))
      .catch((err: unknown) => live && setError(err instanceof ApiError ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [api, runId, nodeId, refreshKey]);

  if (!runId) return <div className="dim panel">Run the flow to see this node's output.</div>;
  if (error) return <div className="dim panel">{error}</div>;
  if (!output) return <div className="dim panel">Loading…</div>;
  const record = output.record;
  return (
    <div className="output-view">
      {record && (
        <div className="chip-row">
          <span className={`state-pill flow-state-${record.status === "failed" ? "error" : record.status}`}>{record.status}</span>
          {record.cache_hit && <span className="chip">from cache</span>}
          <span className="chip">{formatDuration(record.duration_ms)}</span>
          <span className="chip mono" title={output.run_id}>
            {output.run_id.slice(-12)}
          </span>
        </div>
      )}
      {record?.error && (
        <div className="error-box">
          <div>
            <span className="code">{record.error.code}</span> {record.error.message}
          </div>
          {record.error.traceback && (
            <details>
              <summary>Traceback</summary>
              <pre className="stream stderr">{record.error.traceback}</pre>
            </details>
          )}
        </div>
      )}
      {record?.warnings.map((w, i) => (
        <div key={i} className="warning-row static sev-warning">
          <span className="code">{w.code}</span>
          <span>{w.message}</span>
        </div>
      ))}
      {Object.entries(output.outputs).map(([name, port]) => (
        <section key={name} className="port-output">
          <h3>
            {name} <span className="dim">· {port.kind.replace("_", " ")}</span>
          </h3>
          <PortView name={name} port={port} />
        </section>
      ))}
      {Object.keys(output.outputs).length === 0 && <div className="dim small">This node writes files instead of passing data on.</div>}
    </div>
  );
}
