// An ER diagram of a schema: each table with its columns, a line for each foreign key. Tables that
// others refer to sit on the left, the tables that refer to them to their right. Drag tables to
// rearrange them (remembered); double-click one to open it.
import { Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow, useNodesState, type Edge, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../context";
import { Icon } from "../../components/Icon";
import { Spinner, Switch } from "../../components/ui";

export interface DiagramTabState {
  kind: "diagram";
  id: string;
  connection_id: string;
  database: string;
  schema: string | null;
  title: string;
}

interface Diagram {
  schema: string | null;
  tables: { name: string; columns: { name: string; type: string; key: boolean; foreign: boolean; nullable: boolean }[] }[];
  links: { name: string | null; from: string; columns: string[]; to: string; to_schema: string | null; referred_columns: string[] }[];
}

type TableData = { table: Diagram["tables"][number]; keysOnly: boolean; dim: boolean; hit: boolean; onOpen: (name: string) => void };

const WIDTH = 240;
const ROW = 22;
const HEAD = 38;

function TableNode({ data }: NodeProps<Node<TableData>>) {
  const columns = data.keysOnly ? data.table.columns.filter((c) => c.key || c.foreign) : data.table.columns;
  return (
    <div className={`er-table ${data.dim ? "dim" : ""} ${data.hit ? "hit" : ""}`} onDoubleClick={() => data.onOpen(data.table.name)} title="Double-click to open">
      <Handle type="source" position={Position.Left} id="L-" className="er-handle head" />
      <Handle type="target" position={Position.Right} id="R-" className="er-handle head" />
      <div className="er-head">
        <Icon name="table" size={12} />
        <span className="ellipsis">{data.table.name}</span>
        <span className="er-count">{data.table.columns.length}</span>
      </div>
      {columns.map((c) => (
        <div key={c.name} className={`er-row ${c.key ? "key" : ""}`}>
          <Handle type="source" position={Position.Left} id={`L-${c.name}`} className="er-handle" />
          <Handle type="target" position={Position.Right} id={`R-${c.name}`} className="er-handle" />
          <span className="er-mark">{c.key ? <Icon name="key" size={10} /> : c.foreign ? <Icon name="link" size={10} /> : null}</span>
          <span className="er-name ellipsis">{c.name}</span>
          <span className="er-type ellipsis">{c.type}</span>
        </div>
      ))}
      {data.keysOnly && columns.length < data.table.columns.length && <div className="er-more">{data.table.columns.length - columns.length} more columns</div>}
    </div>
  );
}

const nodeTypes = { table: TableNode };

/** Columns of tables: a table's column is one more than the deepest table it refers to. */
function layout(diagram: Diagram, keysOnly: boolean): Record<string, { x: number; y: number }> {
  const names = new Set(diagram.tables.map((t) => t.name));
  const refers: Record<string, Set<string>> = {};
  const linked = new Set<string>();
  for (const link of diagram.links) {
    if (!names.has(link.to) || link.to === link.from || (link.to_schema && link.to_schema !== diagram.schema)) continue;
    (refers[link.from] ??= new Set()).add(link.to);
    linked.add(link.from);
    linked.add(link.to);
  }
  const level: Record<string, number> = {};
  const visit = (name: string, path: Set<string>): number => {
    if (level[name] !== undefined) return level[name]!;
    if (path.has(name)) return 0; // a cycle
    path.add(name);
    const deeper = [...(refers[name] ?? [])].map((other) => visit(other, path) + 1);
    path.delete(name);
    return (level[name] = Math.max(0, ...deeper));
  };
  const columns: string[][] = [];
  for (const table of diagram.tables.filter((t) => linked.has(t.name))) (columns[visit(table.name, new Set())] ??= []).push(table.name);
  const alone = diagram.tables.filter((t) => !linked.has(t.name)).map((t) => t.name);
  for (let i = 0; i < alone.length; i += 8) columns.push(alone.slice(i, i + 8));
  const height = (name: string) => {
    const table = diagram.tables.find((t) => t.name === name)!;
    const shown = keysOnly ? table.columns.filter((c) => c.key || c.foreign).length + 1 : table.columns.length;
    return HEAD + shown * ROW + 12;
  };
  const out: Record<string, { x: number; y: number }> = {};
  columns.forEach((names, x) => {
    let y = 0;
    for (const name of names ?? []) {
      out[name] = { x: x * (WIDTH + 110), y };
      y += height(name) + 34;
    }
  });
  return out;
}

export function DiagramTab({ tab, onOpen }: { tab: DiagramTabState; onOpen: (table: string) => void }) {
  const { engine } = useApp();
  const [diagram, setDiagram] = useState<Diagram | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keysOnly, setKeysOnly] = useState(false);
  const [find, setFind] = useState("");
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TableData>>([]);
  const flow = useRef<ReactFlowInstance<Node<TableData>, Edge> | null>(null);
  const storeKey = `flowlabs-er:${tab.connection_id}/${tab.database}/${tab.schema ?? ""}`;
  // the parent's callback changes on every render; the nodes keep one that does not
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const open = useCallback((name: string) => openRef.current(name), []);

  const load = useCallback(() => {
    setError(null);
    engine.call<Diagram>("db.diagram", { connection_id: tab.connection_id, database: tab.database, schema: tab.schema }).then(setDiagram, (e: Error) => setError(e.message));
  }, [engine, tab]);
  useEffect(load, [load]);

  const saved = (): Record<string, { x: number; y: number }> => {
    try {
      return JSON.parse(localStorage.getItem(storeKey) ?? "{}");
    } catch {
      return {};
    }
  };
  const place = useCallback(
    (fresh: boolean) => {
      if (!diagram) return;
      const auto = layout(diagram, keysOnly);
      const kept = fresh ? {} : saved();
      setNodes(diagram.tables.map((table) => ({ id: table.name, type: "table", position: kept[table.name] ?? auto[table.name] ?? { x: 0, y: 0 }, data: { table, keysOnly, dim: false, hit: false, onOpen: open } })));
      requestAnimationFrame(() => void flow.current?.fitView({ padding: 0.1, maxZoom: 1 }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [diagram, keysOnly, open, setNodes],
  );
  useEffect(() => place(false), [place]);
  useEffect(() => {
    const needle = find.trim().toLowerCase();
    setNodes((all) => all.map((n) => {
      const hit = Boolean(needle) && (n.id.toLowerCase().includes(needle) || n.data.table.columns.some((c) => c.name.toLowerCase().includes(needle)));
      return { ...n, data: { ...n.data, hit, dim: Boolean(needle) && !hit } };
    }));
  }, [find, setNodes]);

  const edges: Edge[] = useMemo(() => {
    if (!diagram) return [];
    const names = new Set(diagram.tables.map((t) => t.name));
    return diagram.links
      .filter((l) => names.has(l.to) && (!l.to_schema || l.to_schema === diagram.schema))
      .map((l, i) => {
        const from = diagram.tables.find((t) => t.name === l.from)!;
        const to = diagram.tables.find((t) => t.name === l.to)!;
        const shows = (table: Diagram["tables"][number], column: string) => table.columns.some((c) => c.name === column && (!keysOnly || c.key || c.foreign));
        return {
          id: `${l.name ?? i}-${l.from}-${l.to}`,
          source: l.from,
          target: l.to,
          sourceHandle: shows(from, l.columns[0] ?? "") ? `L-${l.columns[0]}` : "L-",
          targetHandle: shows(to, l.referred_columns[0] ?? "") ? `R-${l.referred_columns[0]}` : "R-",
          type: "smoothstep",
          className: "er-edge",
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
          label: undefined,
          ariaLabel: `${l.from} (${l.columns.join(", ")}) refers to ${l.to} (${l.referred_columns.join(", ")})`,
        };
      });
  }, [diagram, keysOnly]);

  const remember = () => {
    try {
      localStorage.setItem(storeKey, JSON.stringify(Object.fromEntries(nodes.map((n) => [n.id, n.position]))));
    } catch {
      /* the layout is not remembered */
    }
  };

  if (error) return <div className="db-pad error-text">{error}</div>;
  if (!diagram) return <div className="db-pad"><Spinner /></div>;
  return (
    <div className="db-object">
      <div className="db-object-head">
        <Icon name="tree" size={16} />
        <h2>{tab.schema ?? tab.database}</h2>
        <span className="dim small">
          {diagram.tables.length} tables, {edges.length} {edges.length === 1 ? "relationship" : "relationships"}
        </span>
        <span className="spacer" />
        <span className="db-search">
          <Icon name="search" size={12} />
          <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a table or column" aria-label="Find a table or column" />
        </span>
        <Switch on={keysOnly} onChange={setKeysOnly} label="Keys only" />
        <button className="ghost small" onClick={() => { try { localStorage.removeItem(storeKey); } catch { /* nothing kept */ } place(true); }} title="Arrange the tables again">
          <Icon name="refresh" size={12} /> Arrange
        </button>
        <button className="ghost small" onClick={load} title="Read the schema again">
          Reload
        </button>
      </div>
      <div className="er-canvas">
        {diagram.tables.length === 0 ? (
          <p className="dim db-pad">This schema has no tables yet.</p>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={remember}
            onInit={(instance) => {
              flow.current = instance;
              requestAnimationFrame(() => void instance.fitView({ padding: 0.1, maxZoom: 1 }));
            }}
            nodesConnectable={false}
            minZoom={0.1}
            maxZoom={1.6}
            proOptions={{ hideAttribution: true }}
          >
            <Background id="er-dots" variant={BackgroundVariant.Dots} gap={18} size={1.4} color="var(--grid-major)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}
