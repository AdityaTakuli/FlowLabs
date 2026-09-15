import type { StructureEdge, StructureGraph, StructureNode } from "./types";
import { KIND_ICON } from "./types";

/** Inspector for the structure graph: one unit, one call edge, or the file overview. */
export function StructurePanel({
  graph,
  node,
  edge,
  onSelect,
  onEdit,
  onOpenFile,
}: {
  graph: StructureGraph;
  node: StructureNode | null;
  edge: StructureEdge | null;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onOpenFile: (file: string) => void;
}) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const label = (id: string) => byId.get(id)?.qualified_name ?? id;

  if (edge) {
    return (
      <div className="inspector-body">
        <h2>
          {label(edge.from)} → {label(edge.to)}
        </h2>
        <p className="dim small">
          Calls {edge.names.map((n) => `${n}()`).join(", ")} · {edge.sites.length} call site{edge.sites.length === 1 ? "" : "s"} shown. The arguments below are what travels along this edge.
        </p>
        <ul className="call-sites">
          {edge.sites.map((site, i) => (
            <li key={i}>
              <span className="chip">L{site.line}</span>
              <code>{site.text}</code>
            </li>
          ))}
        </ul>
        <div className="button-row">
          <button onClick={() => onSelect(edge.from)}>Caller</button>
          <button onClick={() => onSelect(edge.to)}>Callee</button>
        </div>
      </div>
    );
  }

  if (node) {
    const out = graph.edges.filter((e) => e.from === node.id && e.kind === "call");
    const incoming = graph.edges.filter((e) => e.to === node.id && e.kind === "call");
    const linked = new Set(out.flatMap((e) => e.names));
    const unresolved = node.calls.filter((c) => !linked.has(c));
    const members = graph.nodes.filter((n) => n.parent === node.id);
    return (
      <div className="inspector-body">
        <h2 className="mono">
          {KIND_ICON[node.kind]} {node.qualified_name}
        </h2>
        <div className="chip-row">
          <span className="chip">{node.kind}</span>
          <span className="chip">{graph.language_name}</span>
          {node.kind !== "external" && (
            <span className="chip">
              lines {node.line_start}–{node.line_end}
            </span>
          )}
          {!node.editable && <span className="chip">read-only</span>}
        </div>
        {node.doc && <p>{node.doc}</p>}
        {node.signature && <pre className="signature">{node.signature}</pre>}
        <div className="button-row">
          {node.editable && (
            <button className="primary" onClick={() => onEdit(node.id)}>
              ✎ Edit on canvas
            </button>
          )}
          {node.kind === "external" && (
            <button className="primary" onClick={() => onOpenFile(node.file)}>
              ↗ Open {node.file}
            </button>
          )}
        </div>
        {members.length > 0 && (
          <>
            <h3>Members</h3>
            <div className="chip-row">
              {members.map((m) => (
                <button key={m.id} className="chip link" onClick={() => onSelect(m.id)}>
                  {m.name}
                </button>
              ))}
            </div>
          </>
        )}
        <h3>Calls ({out.length})</h3>
        {out.length === 0 && <div className="dim small">No calls to code in this project.</div>}
        {out.map((e) => (
          <button key={e.to} className="warning-row" onClick={() => onSelect(e.to)}>
            <span className="code">{e.names.join(", ")}()</span>
            <span>{label(e.to)}</span>
            {e.sites[0] && <span className="dim small mono">L{e.sites[0].line}</span>}
          </button>
        ))}
        <h3>Called by ({incoming.length})</h3>
        {incoming.length === 0 && <div className="dim small">Nothing in this file calls it{node.kind === "module" ? "" : " (it may be an entry point or used from another file)"}.</div>}
        {incoming.map((e) => (
          <button key={e.from} className="warning-row" onClick={() => onSelect(e.from)}>
            <span className="code">{label(e.from)}</span>
            {e.sites[0] && <code className="small">{e.sites[0].text}</code>}
          </button>
        ))}
        {unresolved.length > 0 && (
          <>
            <h3>Library and other calls</h3>
            <div className="chip-row">
              {unresolved.slice(0, 30).map((c) => (
                <code key={c} className="chip">
                  {c}
                </code>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  const counts = new Map<string, number>();
  for (const n of graph.nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
  return (
    <div className="inspector-body">
      <h2>{graph.file}</h2>
      <div className="chip-row">
        <span className="chip">{graph.language_name}</span>
        <span className="chip">structure graph</span>
      </div>
      <p className="dim small">Why this view: {graph.reason}.</p>
      <dl className="stats">
        {[...counts.entries()].map(([kind, count]) => (
          <div key={kind} style={{ display: "contents" }}>
            <dt>{kind}</dt>
            <dd>{count}</dd>
          </div>
        ))}
        <dt>Calls</dt>
        <dd>{graph.edges.filter((e) => e.kind === "call").length}</dd>
      </dl>
      {graph.truncated && <div className="banner-inline">Large file: only the first 400 units are drawn.</div>}
      {graph.problems.length > 0 && (
        <>
          <h3>Syntax problems</h3>
          {graph.problems.map((p, i) => (
            <div key={i} className="warning-row sev-error">
              <span className="code">L{p.line}</span>
              <span>{p.message}</span>
            </div>
          ))}
        </>
      )}
      <h3>How to use</h3>
      <ul className="small tips">
        <li>Every card is a function, method or class. Arrows are calls; the label shows the function called and the arguments travel with it (click an arrow to see each call site).</li>
        <li>Drag cards anywhere: the arrangement is saved for this file. “Reset layout” returns to the automatic one.</li>
        <li>Double-click a card to edit just that unit. Saves that would break the syntax are refused, and “Undo change” restores the file.</li>
        <li>Purple ↗ cards live in other files; double-click to open them.</li>
        {graph.can_run_cells && <li>This Python file can also open as runnable cells (“Open as cells”), for data analysis and ML work.</li>}
      </ul>
    </div>
  );
}
