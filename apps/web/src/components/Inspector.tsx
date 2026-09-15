import { useEffect, useMemo, useRef, useState } from "react";
import { Api, ApiError } from "../api";
import { formatBytes, formatCount, formatDuration } from "../layout";
import type {
  CodeGraph,
  CodeNode,
  DiffPayload,
  HistoryEntry,
  InspectPayload,
  RunMode,
  SessionState,
  VariableSummary,
} from "../types";
import { CodeEditor } from "./CodeEditor";
import { STATE_LABEL } from "./GraphCanvas";

export type InspectorTab = "code" | "data" | "diff" | "profile";

interface InspectorProps {
  api: Api;
  file: string | null;
  graph: CodeGraph | null;
  node: CodeNode | null;
  savedNode: CodeNode | null;
  session: SessionState | null;
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  focusVariable: string | null;
  kernelReady: boolean;
  onSelect: (nodeId: string | null) => void;
  onRun: (nodeId: string, mode: RunMode) => void;
  onTransform: (op: string, nodeIds: string[], params?: Record<string, unknown>) => Promise<boolean>;
  onPreview: (graph: CodeGraph | null) => void;
  onDirty: (dirty: boolean) => void;
}

export function Inspector(props: InspectorProps) {
  const { node, savedNode, graph, session, file, tab } = props;
  if (!file || !graph) return <aside className="inspector" />;
  if (!node) return <aside className="inspector"><Overview graph={graph} session={session} onSelect={props.onSelect} /></aside>;

  const entry = session?.nodes[node.id];
  const state = entry?.state ?? "idle";
  const undefinedNode = node.kind === "undefined";
  return (
    <aside className="inspector">
      <header className="inspector-head">
        <div className="inspector-title">
          <span className="code-node-id">{undefinedNode ? "?" : node.id}</span>
          <span className="title-text" title={node.label}>{node.label}</span>
          {!undefinedNode && (
            <span className={`state-pill state-${state}`}>
              <span aria-hidden>{STATE_LABEL[state].icon}</span> {STATE_LABEL[state].text}
            </span>
          )}
        </div>
        {!undefinedNode && (
          <div className="button-row">
            <button disabled={!props.kernelReady} onClick={() => props.onRun(node.id, "node")} title="Run this block with the current kernel state">▶ Run</button>
            <button disabled={!props.kernelReady} onClick={() => props.onRun(node.id, "to")} title="Run all ancestors, then this block">Run to here</button>
            <button disabled={!props.kernelReady} onClick={() => props.onRun(node.id, "from")} title="Run this block and everything downstream">Run from here</button>
          </div>
        )}
        <nav className="tabs" role="tablist">
          {(["code", "data", "diff", "profile"] as InspectorTab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => props.onTab(t)}>
              {t === "code" ? "Code" : t === "data" ? "Data" : t === "diff" ? "Diff" : "Profile"}
            </button>
          ))}
        </nav>
      </header>
      <div className="inspector-body">
        {undefinedNode ? (
          <UndefinedInfo node={node} graph={graph} onSelect={props.onSelect} />
        ) : tab === "code" && savedNode ? (
          <CodeTab {...props} node={node} savedNode={savedNode} file={file} graph={graph} />
        ) : tab === "data" ? (
          <DataTab api={props.api} file={file} nodeId={node.id} executionId={entry?.last_run?.execution_id ?? null} focusVariable={props.focusVariable} />
        ) : tab === "diff" ? (
          <DiffTab api={props.api} file={file} node={node} graph={graph} session={session} />
        ) : tab === "profile" ? (
          <ProfileTab api={props.api} file={file} node={node} session={session} onSelect={props.onSelect} />
        ) : null}
      </div>
    </aside>
  );
}

function Overview({ graph, session, onSelect }: { graph: CodeGraph; session: SessionState | null; onSelect: (id: string) => void }) {
  const code = graph.nodes.filter((n) => n.kind !== "undefined");
  const lowConfidence = code.filter((n) => n.confidence === "low").length;
  const ran = session ? Object.values(session.nodes).filter((n) => n.last_run).length : 0;
  return (
    <div className="inspector-body overview">
      <h2>{graph.source.files[0]?.path}</h2>
      <dl className="stats">
        <dt>Blocks</dt><dd>{code.length}</dd>
        <dt>Dependencies</dt><dd>{graph.edges.filter((e) => e.kind !== "import").length}</dd>
        <dt>Low-confidence blocks</dt><dd>{lowConfidence}</dd>
        <dt>Blocks run</dt><dd>{ran}</dd>
        <dt>Analysed in</dt><dd>{graph.analysis_ms} ms</dd>
      </dl>
      <p className="dim small">
        The graph is derived from your code: edges show which block defines a variable another block reads.
        Dashed edges mean mutation or medium confidence; dotted means low confidence.
      </p>
      <h3>Tips</h3>
      <ul className="small tips">
        <li>Click a block to see its code, data, diffs and profile.</li>
        <li>Click an edge to inspect the data flowing through it.</li>
        <li>Start the kernel in the sidebar, then use ▶ / Run to here on any block.</li>
        <li>Editing a block marks everything downstream as stale.</li>
      </ul>
      {graph.warnings.length > 0 && (
        <>
          <h3>Warnings</h3>
          {graph.warnings.map((w, i) => (
            <button key={i} className={`warning-row sev-${w.severity}`} onClick={() => w.node_id && onSelect(w.node_id)}>
              <span className="code">{w.code}</span>
              <span>{w.message}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}

function UndefinedInfo({ node, graph, onSelect }: { node: CodeNode; graph: CodeGraph; onSelect: (id: string) => void }) {
  const users = graph.edges.filter((e) => e.from === node.id).map((e) => e.to);
  const name = node.defines[0] ?? "";
  return (
    <div className="panel">
      <p><code>{name}</code> is used here but no block in this file defines it.</p>
      <p className="dim small">
        It may come from a deleted cell that still lives in the kernel, from <code>%run</code>, or from a typo.
        Code that relies on it will fail after a kernel restart.
      </p>
      <h3>Used by</h3>
      <div className="chip-row">
        {users.map((u) => (
          <button key={u} className="chip link" onClick={() => onSelect(u)}>{u}</button>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------ Code

function CodeTab(props: InspectorProps & { node: CodeNode; savedNode: CodeNode; file: string; graph: CodeGraph }) {
  const { api, file, node, savedNode, onTransform, onPreview, onDirty } = props;
  const [draft, setDraft] = useState(savedNode.source);
  const [parseError, setParseError] = useState<{ message: string; line: number | null } | null>(null);
  const [cursorLine, setCursorLine] = useState(1);
  const [extractName, setExtractName] = useState("");
  const [saving, setSaving] = useState(false);
  const savedRef = useRef(savedNode.source);
  savedRef.current = savedNode.source;

  useEffect(() => {
    setDraft(savedNode.source);
    setParseError(null);
    onPreview(null);
    onDirty(false);
    // reset only when the saved block itself changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedNode.id, savedNode.source_hash]);

  useEffect(() => {
    if (draft === savedRef.current) {
      onDirty(false);
      onPreview(null);
      setParseError(null);
      return;
    }
    onDirty(true);
    const timer = window.setTimeout(() => {
      api
        .preview(file, savedNode.id, draft)
        .then((result) => {
          setParseError(result.parse_error ? { message: result.parse_error, line: result.parse_error_line } : null);
          onPreview(result.graph);
        })
        .catch(() => undefined);
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const dirty = draft !== savedNode.source;
  async function save(auto = false) {
    if (!dirty || saving) return;
    if (auto && parseError) return; // never auto-save code that does not parse
    setSaving(true);
    await onTransform("edit", [savedNode.id], { source: draft });
    setSaving(false);
  }

  const warnings = props.graph.warnings.filter((w) => w.node_id === node.id);
  const lineCount = savedNode.source.split("\n").length;
  return (
    <div className="code-tab">
      <div className="editor-frame">
        <CodeEditor
          value={draft}
          onChange={setDraft}
          onSave={() => void save()}
          onBlur={() => void save(true)}
          onCursor={setCursorLine}
          errorLine={parseError?.line ?? null}
        />
      </div>
      <div className="editor-bar">
        {parseError ? (
          <span className="error-text">Syntax error{parseError.line ? ` on line ${parseError.line}` : ""}: {parseError.message}</span>
        ) : dirty ? (
          <span className="dim">Unsaved · saves on blur or Ctrl/⌘+S · downstream blocks will turn stale</span>
        ) : (
          <span className="dim">Saved to disk</span>
        )}
        <div className="spacer" />
        <button disabled={!dirty} onClick={() => setDraft(savedNode.source)}>Discard</button>
        <button className="primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
      </div>

      <section className="symbols">
        <SymbolRow label="Defines" names={node.defines} />
        <SymbolRow label="Uses" names={node.uses} />
        {node.mutates.length > 0 && <SymbolRow label="Mutates" names={node.mutates} tone="warn" />}
        {node.conditional_defines.length > 0 && <SymbolRow label="Maybe defined" names={node.conditional_defines} tone="warn" />}
        {node.side_effects.length > 0 && <SymbolRow label="Side effects" names={node.side_effects} />}
        <div className="symbol-row">
          <span className="symbol-label">Confidence</span>
          <span className={`chip conf-${node.confidence}`}>{node.confidence}</span>
          {node.matched_pattern && <span className="chip pattern">{node.matched_pattern}</span>}
        </div>
      </section>

      {warnings.length > 0 && (
        <section>
          {warnings.map((w, i) => (
            <div key={i} className={`warning-row static sev-${w.severity}`}>
              <span className="code">{w.code}</span>
              <span>{w.message}</span>
            </div>
          ))}
        </section>
      )}

      <section className="actions">
        <h3>Edit the structure</h3>
        <p className="dim small">Every change is checked against the dependency graph, backed up, and can be undone.</p>
        <div className="button-row wrap">
          <button disabled={dirty} onClick={() => void onTransform("duplicate", [savedNode.id])}>Duplicate</button>
          <button
            disabled={dirty || cursorLine < 2 || cursorLine > lineCount}
            onClick={() => void onTransform("split", [savedNode.id], { line: cursorLine })}
            title="Split into two blocks at the cursor line"
          >
            Split at line {cursorLine}
          </button>
          <button disabled={dirty} onClick={() => void onTransform("insert", [savedNode.id], { source: "# new block\npass\n" })}>
            Insert block below
          </button>
          <button className="danger" disabled={dirty} onClick={() => void onTransform("delete", [savedNode.id])}>Delete</button>
        </div>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (extractName.trim()) void onTransform("extract", [savedNode.id], { name: extractName.trim() }).then((ok) => ok && setExtractName(""));
          }}
        >
          <input placeholder="function_name" value={extractName} onChange={(e) => setExtractName(e.target.value)} aria-label="Function name" />
          <button type="submit" disabled={dirty || !extractName.trim()}>Extract to function</button>
        </form>
      </section>
    </div>
  );
}

function SymbolRow({ label, names, tone }: { label: string; names: string[]; tone?: "warn" }) {
  return (
    <div className="symbol-row">
      <span className="symbol-label">{label}</span>
      {names.length ? names.map((n) => <code key={n} className={`chip ${tone ?? ""}`}>{n}</code>) : <span className="dim">—</span>}
    </div>
  );
}

// ------------------------------------------------------------------------------ Data

function DataTab({ api, file, nodeId, executionId, focusVariable }: { api: Api; file: string; nodeId: string; executionId: string | null; focusVariable: string | null }) {
  const [data, setData] = useState<InspectPayload | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    api
      .inspect(file, nodeId)
      .then((result) => live && setData(result))
      .catch((e: unknown) => live && (setData(null), setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)))));
    return () => {
      live = false;
    };
  }, [api, file, nodeId, executionId]);

  if (error?.code === "NO_SNAPSHOT") return <div className="panel dim">Run this block to see the data flowing out of it.</div>;
  if (error) return <div className="panel error-text">{error.message}</div>;
  if (!data) return <div className="panel dim">Loading…</div>;
  const after = Object.values(data.after).sort((a, b) => Number(b.name === focusVariable) - Number(a.name === focusVariable));
  const before = Object.values(data.before);
  return (
    <div className="data-tab">
      <div className="dim small">
        From run at {new Date(data.started_at).toLocaleTimeString()} · {data.status} · {formatDuration(data.duration_ms)}
      </div>
      {after.length === 0 && <div className="panel dim">This block does not produce any variables.</div>}
      {after.map((summary, index) => (
        <VariableCard key={summary.name} summary={summary} open={index === 0 || summary.name === focusVariable} />
      ))}
      {before.length > 0 && (
        <details className="inputs">
          <summary>Inputs before this block ran ({before.length})</summary>
          {before.map((summary) => (
            <VariableCard key={summary.name} summary={summary} open={false} />
          ))}
        </details>
      )}
    </div>
  );
}

function VariableCard({ summary, open }: { summary: VariableSummary; open: boolean }) {
  const shape =
    summary.kind === "dataframe"
      ? `${formatCount(summary.rows)} × ${summary.columns?.length ?? 0}`
      : summary.kind === "series"
        ? `${formatCount(summary.rows)} values`
        : summary.shape
          ? summary.shape.join(" × ")
          : summary.length !== undefined
            ? `${summary.length} items`
            : "";
  return (
    <details className="variable-card" open={open}>
      <summary>
        <code>{summary.name}</code>
        <span className="chip">{summary.kind}</span>
        <span className="dim">{shape}</span>
        {summary.memory_bytes !== undefined && <span className="dim small">{formatBytes(summary.memory_bytes)}</span>}
      </summary>
      {summary.error && <div className="error-text small">{summary.error}</div>}
      {summary.repr && <pre className="repr">{summary.repr}</pre>}
      {summary.kind === "estimator" && summary.params && (
        <table className="grid">
          <tbody>
            <tr><th>fitted</th><td>{summary.fitted ? "yes" : "no"}</td></tr>
            {Object.entries(summary.params).map(([k, v]) => (
              <tr key={k}><th>{k}</th><td>{v}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {summary.dtypes && (
        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr><th>column</th><th>dtype</th><th>nulls</th><th>min</th><th>max</th><th>mean</th></tr>
            </thead>
            <tbody>
              {Object.entries(summary.dtypes).map(([column, dtype]) => {
                const stats = summary.stats?.[column];
                const nulls = summary.null_counts?.[column] ?? 0;
                return (
                  <tr key={column}>
                    <td>{column}</td>
                    <td className="dim">{dtype}</td>
                    <td className={nulls ? "warn-text" : ""}>{formatCount(nulls)}</td>
                    <td>{num(stats?.min)}</td>
                    <td>{num(stats?.max)}</td>
                    <td>{num(stats?.mean)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <SampleTable summary={summary} />
    </details>
  );
}

function num(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return Math.abs(value) >= 1e5 || (Math.abs(value) < 1e-3 && value !== 0) ? value.toExponential(2) : String(Math.round(value * 1000) / 1000);
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  if (typeof value === "number") return num(value);
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function SampleTable({ summary }: { summary: VariableSummary }) {
  const sample = summary.sample;
  if (!sample) return null;
  if (Array.isArray(sample)) {
    return <pre className="repr">{JSON.stringify(sample.slice(0, 20), null, 1)}</pre>;
  }
  const rows = sample.data ?? [];
  if (!rows.length) return null;
  const columns = sample.columns ?? (summary.kind === "series" ? [summary.name] : []);
  return (
    <div className="table-scroll sample">
      <table className="grid">
        <thead>
          <tr>
            {sample.index && <th />}
            {columns.map((c, i) => (
              <th key={i}>{cell(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {sample.index && <th className="dim">{cell(sample.index[r])}</th>}
              {(Array.isArray(row) ? row : [row]).map((value, c) => (
                <td key={c}>{cell(value)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------------------ Diff

function DiffTab({ api, file, node, graph, session }: { api: Api; file: string; node: CodeNode; graph: CodeGraph; session: SessionState | null }) {
  const candidates = useMemo(
    () => graph.nodes.filter((n) => n.kind === "code" && n.id !== node.id && session?.nodes[n.id]?.last_run),
    [graph, node.id, session],
  );
  const parent = graph.edges.find((e) => e.to === node.id && e.kind !== "import" && !e.from.startsWith("undefined:"))?.from ?? "";
  const [other, setOther] = useState(parent);
  const [variable, setVariable] = useState("");
  const [result, setResult] = useState<DiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const ranHere = Boolean(session?.nodes[node.id]?.last_run);

  useEffect(() => {
    setOther(parent);
    setResult(null);
    setError(null);
  }, [node.id, parent]);
  useEffect(() => {
    api.history(file, node.id).then(setHistory).catch(() => setHistory([]));
  }, [api, file, node.id, session?.nodes[node.id]?.last_run?.execution_id]);

  async function compare(options: Parameters<Api["diff"]>[1]) {
    try {
      setError(null);
      setResult(await api.diff(file, { ...options, variable: variable || undefined }));
    } catch (e) {
      setResult(null);
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  if (!ranHere) return <div className="panel dim">Run this block first; diffs compare the data captured at each run.</div>;
  return (
    <div className="diff-tab">
      <p className="dim small">Which step dropped rows, added columns or changed types? Compare the data after two blocks.</p>
      <div className="form-grid">
        <label>
          Before
          <select value={other} onChange={(e) => setOther(e.target.value)}>
            <option value="">choose a block…</option>
            {candidates.map((n) => (
              <option key={n.id} value={n.id}>{n.id} · {n.label}</option>
            ))}
          </select>
        </label>
        <label>
          Variable
          <input placeholder="auto" value={variable} onChange={(e) => setVariable(e.target.value)} />
        </label>
      </div>
      <div className="button-row">
        <button className="primary" disabled={!other} onClick={() => void compare({ nodeA: other, nodeB: node.id })}>
          Compare {other || "…"} → {node.id}
        </button>
        <button
          disabled={history.length < 2}
          onClick={() => {
            const [latest, previous] = history;
            if (latest && previous) void compare({ executionA: previous.execution_id, executionB: latest.execution_id });
          }}
          title="Compare this block's latest run with its previous run"
        >
          vs previous run
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
      {result && (
        <div className="diff-result">
          <div className="diff-headline">
            {result.row_delta !== null && result.row_delta !== 0 && (
              <span className={`chip ${result.row_delta < 0 ? "warn" : ""}`}>
                {result.row_delta > 0 ? "+" : ""}
                {formatCount(result.row_delta)} rows
              </span>
            )}
            {result.added.length > 0 && <span className="chip">+{result.added.length} columns</span>}
            {result.removed.length > 0 && <span className="chip warn">−{result.removed.length} columns</span>}
            {result.retyped.length > 0 && <span className="chip warn">{result.retyped.length} retyped</span>}
          </div>
          <pre className="diff-text">{result.text}</pre>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- Profile

function ProfileTab({ api, file, node, session, onSelect }: { api: Api; file: string; node: CodeNode; session: SessionState | null; onSelect: (id: string) => void }) {
  const record = session?.nodes[node.id]?.last_run ?? null;
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  useEffect(() => {
    api.history(file, node.id).then(setHistory).catch(() => setHistory([]));
  }, [api, file, node.id, record?.execution_id]);

  if (!record) return <div className="panel dim">No runs yet in this kernel session.</div>;
  return (
    <div className="profile-tab">
      <dl className="stats">
        <dt>Status</dt><dd className={record.status === "success" ? "" : "error-text"}>{record.status}</dd>
        <dt>Wall time</dt><dd>{formatDuration(record.duration_ms)}</dd>
        <dt>Peak memory</dt><dd>{record.peak_memory_mb !== null ? `${record.peak_memory_mb.toFixed(0)} MB` : "–"}</dd>
        <dt>Memory delta</dt><dd>{record.memory_delta_mb !== null ? `${record.memory_delta_mb >= 0 ? "+" : ""}${record.memory_delta_mb.toFixed(1)} MB` : "–"}</dd>
        <dt>Rows in → out</dt><dd>{formatCount(record.rows_in)} → {formatCount(record.rows_out)}</dd>
      </dl>
      {record.warnings.map((w, i) => (
        <div key={i} className={`warning-row static sev-${w.severity}`}>
          <span className="code">{w.code}</span>
          <span>{w.message}</span>
        </div>
      ))}
      {record.error && (
        <section className="traceback">
          <h3>{record.error.ename}: {record.error.evalue}</h3>
          {record.error.frames.map((frame, i) => (
            <button key={i} className="frame" disabled={!frame.node_id} onClick={() => frame.node_id && onSelect(frame.node_id)}>
              <span className="chip">{frame.node_id ?? "library"}</span> line {frame.file_line ?? frame.line}
              <span className="dim"> {frame.text}</span>
            </button>
          ))}
          <details>
            <summary>Full traceback</summary>
            <pre className="stream">{record.error.traceback.join("\n")}</pre>
          </details>
        </section>
      )}
      {record.stdout && (
        <section>
          <h3>Output</h3>
          <pre className="stream">{record.stdout}</pre>
        </section>
      )}
      {record.stderr && (
        <section>
          <h3>Errors / warnings</h3>
          <pre className="stream stderr">{record.stderr}</pre>
        </section>
      )}
      {history.length > 1 && (
        <section>
          <h3>Run history</h3>
          <table className="grid">
            <thead>
              <tr><th>time</th><th>status</th><th>duration</th><th>peak</th><th>rows</th></tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.execution_id} className={h.source_hash !== node.source_hash ? "dim" : ""} title={h.source_hash !== node.source_hash ? "older code" : ""}>
                  <td>{new Date(h.started_at).toLocaleTimeString()}</td>
                  <td>{h.status}</td>
                  <td>{formatDuration(h.duration_ms)}</td>
                  <td>{h.peak_memory_mb !== null ? `${h.peak_memory_mb.toFixed(0)} MB` : "–"}</td>
                  <td>{formatCount(h.rows_in)} → {formatCount(h.rows_out)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
