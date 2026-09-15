import { useEffect, useMemo, useState } from "react";
import dagre from "@dagrejs/dagre";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  NodeToolbar,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { Api } from "../api";
import { CodeEditor } from "../components/CodeEditor";
import { KIND_ICON, structureNeighbours, visibleStructure, type StructureEdge, type StructureGraph, type StructureNode } from "./types";
import { useSavedLayout, withMoved, type Positions } from "./useSavedLayout";

const W = 260;
const H = 92;

export interface EditOutcome {
  ok: boolean;
  message?: string;
  line?: number | null;
}

interface CardData extends Record<string, unknown> {
  node: StructureNode;
  dimmed: boolean;
  highlighted: boolean;
  collapsed: boolean;
  memberCount: number;
  editing: boolean;
  monaco: string;
  onEdit: (id: string | null) => void;
  onToggle: (id: string) => void;
  onOpenFile: (file: string) => void;
  onSave: (id: string, source: string) => Promise<EditOutcome>;
}

type CardNode = Node<CardData, "unit">;

function UnitCard({ data, selected }: NodeProps<CardNode>) {
  const { node } = data;
  const className = [
    "code-node",
    "unit-node",
    `unit-${node.kind}`,
    selected ? "selected" : "",
    data.dimmed ? "dimmed" : "",
    data.highlighted ? "highlighted" : "",
    data.editing ? "editing" : "",
  ].join(" ");
  return (
    <div className={className} style={{ width: W, height: H }} aria-label={`${node.kind} ${node.qualified_name}, lines ${node.line_start} to ${node.line_end}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="code-node-head">
        <span className="code-node-id" title={node.kind}>
          {KIND_ICON[node.kind]}
        </span>
        <span className="code-node-label" title={node.qualified_name}>
          {node.kind === "method" ? node.name : node.qualified_name}
        </span>
        {node.kind === "class" && data.memberCount > 0 && (
          <button className="nodrag unit-collapse" title={data.collapsed ? "Show members" : "Fold members into the class"} onClick={(e) => (e.stopPropagation(), data.onToggle(node.id))}>
            {data.collapsed ? `▸ ${data.memberCount}` : "▾"}
          </button>
        )}
      </div>
      <div className="code-node-meta">
        {node.kind === "external" ? (
          <span className="chip">{node.file}</span>
        ) : (
          <span className="chip">
            L{node.line_start}
            {node.line_end !== node.line_start ? `–${node.line_end}` : ""}
          </span>
        )}
        {node.calls.length > 0 && <span className="chip">{node.calls.length} calls</span>}
        {node.parent && <span className="chip dim-chip">in {node.parent.split(" (")[0]}</span>}
      </div>
      <div className="code-node-summary" title={node.doc ?? node.signature}>
        {node.doc ?? node.signature}
      </div>
      <div className="code-node-actions">
        {node.editable ? (
          <button className="nodrag" title="Edit this unit here (or double-click it)" onClick={(e) => (e.stopPropagation(), data.onEdit(node.id))}>
            ✎
          </button>
        ) : node.kind === "external" ? (
          <button className="nodrag" title={`Open ${node.file}`} onClick={(e) => (e.stopPropagation(), data.onOpenFile(node.file))}>
            ↗
          </button>
        ) : null}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
      {data.editing && node.editable && (
        <NodeToolbar isVisible position={Position.Bottom} offset={12} className="nodrag nowheel nopan nokey">
          <UnitEditor node={node} monaco={data.monaco} onSave={(source) => data.onSave(node.id, source)} onClose={() => data.onEdit(null)} />
        </NodeToolbar>
      )}
    </div>
  );
}

/** Edit one function or class in place; the server refuses code that would not parse. */
export function UnitEditor({ node, monaco, onSave, onClose }: { node: StructureNode; monaco: string; onSave: (source: string) => Promise<EditOutcome>; onClose: () => void }) {
  const [draft, setDraft] = useState(node.source);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ message: string; line: number | null } | null>(null);
  useEffect(() => {
    setDraft(node.source);
    setProblem(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.source_hash]);
  const dirty = draft !== node.source;
  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const outcome = await onSave(draft);
      setProblem(outcome.ok ? null : { message: outcome.message ?? "Not saved", line: outcome.line ?? null });
    } finally {
      setSaving(false);
    }
  }
  return (
    <div
      className="inline-editor nodrag nowheel nopan nokey"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      role="dialog"
      aria-label={`Edit ${node.qualified_name}`}
    >
      <div className="inline-editor-head">
        <span className="code-node-id">{KIND_ICON[node.kind]}</span>
        <span className="cell-label">
          {node.qualified_name} · lines {node.line_start}–{node.line_end}
        </span>
        {dirty && <span className="unsaved small">unsaved</span>}
        <div className="spacer" />
        <button className="link-button" onClick={onClose} aria-label="Close editor">
          ✕
        </button>
      </div>
      <div className="inline-editor-frame">
        <CodeEditor
          value={draft}
          language={monaco}
          onChange={(next) => {
            setDraft(next);
            setProblem(null);
          }}
          onSave={() => void save()}
          onBlur={() => undefined}
          onCursor={() => undefined}
          errorLine={problem?.line ?? null}
        />
      </div>
      <div className="inline-editor-bar">
        {problem ? (
          <span className="error-text small" role="alert">
            {problem.message}
          </span>
        ) : (
          <span className="dim small">Ctrl/⌘+S saves · Esc closes</span>
        )}
        <div className="spacer" />
        <button disabled={!dirty || saving} onClick={() => setDraft(node.source)}>
          Discard
        </button>
        <button className="primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function autoLayout(nodes: StructureNode[], edges: StructureEdge[]): Positions {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 70, marginx: 20, marginy: 20 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) graph.setNode(node.id, { width: W, height: H });
  for (const edge of edges) if (edge.from !== edge.to && graph.hasNode(edge.from) && graph.hasNode(edge.to)) graph.setEdge(edge.from, edge.to);
  dagre.layout(graph);
  const positions: Positions = {};
  for (const node of nodes) {
    const placed = graph.node(node.id) as { x: number; y: number } | undefined;
    positions[node.id] = placed ? { x: placed.x - W / 2, y: placed.y - H / 2 } : { x: 0, y: 0 };
  }
  return positions;
}

export interface StructureCanvasProps {
  api: Api;
  graph: StructureGraph;
  selectedId: string | null;
  editingId: string | null;
  search: string;
  focus: boolean;
  collapsed: Set<string>;
  resetSignal: number;
  onSelect: (id: string | null) => void;
  onSelectEdge: (edge: StructureEdge) => void;
  onEdit: (id: string | null) => void;
  onToggleCollapse: (id: string) => void;
  onOpenFile: (file: string) => void;
  onSave: (id: string, source: string) => Promise<EditOutcome>;
  onLayoutMoved: (moved: boolean) => void;
}

export function StructureCanvas(props: StructureCanvasProps) {
  const { api, graph, collapsed } = props;
  const visible = useMemo(() => visibleStructure(graph, collapsed), [graph, collapsed]);
  const shape = visible.nodes.map((n) => n.id).join("|") + "#" + visible.edges.map((e) => `${e.from}>${e.to}`).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const auto = useMemo(() => autoLayout(visible.nodes, visible.edges), [shape]);
  const layout = useSavedLayout(api, graph.file, "structure");
  const { reset, hasMoved } = layout;
  const { resetSignal, onLayoutMoved } = props;
  useEffect(() => {
    if (resetSignal > 0) reset();
  }, [resetSignal, reset]);
  useEffect(() => onLayoutMoved(hasMoved), [hasMoved, onLayoutMoved]);
  const positions = withMoved(auto, layout.moved);

  const members = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of graph.nodes) if (n.parent) counts.set(n.parent, (counts.get(n.parent) ?? 0) + 1);
    return counts;
  }, [graph]);

  const query = props.search.trim().toLowerCase();
  const related = useMemo(() => {
    if (query) return new Set(visible.nodes.filter((n) => `${n.qualified_name} ${n.calls.join(" ")}`.toLowerCase().includes(query)).map((n) => n.id));
    if (props.focus && props.selectedId) return structureNeighbours(visible.edges, props.selectedId);
    return null;
  }, [query, visible, props.focus, props.selectedId]);

  const nodes: CardNode[] = visible.nodes.map((node) => ({
    id: node.id,
    type: "unit",
    position: positions[node.id] ?? { x: 0, y: 0 },
    selected: node.id === props.selectedId,
    zIndex: node.id === props.editingId ? 10 : 0,
    data: {
      node,
      dimmed: related !== null && !related.has(node.id),
      highlighted: related !== null && related.has(node.id) && query !== "",
      collapsed: collapsed.has(node.id),
      memberCount: members.get(node.id) ?? 0,
      editing: node.id === props.editingId,
      monaco: graph.monaco,
      onEdit: props.onEdit,
      onToggle: props.onToggleCollapse,
      onOpenFile: props.onOpenFile,
      onSave: props.onSave,
    },
  }));

  const edges: Edge[] = visible.edges.map((edge) => {
    const dimmed = related !== null && !(related.has(edge.from) && related.has(edge.to));
    const member = edge.kind === "member";
    const colour = member ? "var(--edge-import)" : "var(--edge)";
    return {
      id: `${edge.from}->${edge.to}:${edge.kind}`,
      source: edge.from,
      target: edge.to,
      label: member ? undefined : `${edge.names.slice(0, 2).join(", ")}${edge.names.length > 2 ? "…" : ""}()${edge.sites.length > 1 ? ` ×${edge.sites.length}` : ""}`,
      labelStyle: { fill: "var(--text)", fontSize: 11, fontFamily: "var(--mono)" },
      labelBgStyle: { fill: "var(--panel)", fillOpacity: 0.92 },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
      style: { stroke: colour, strokeWidth: member ? 1 : 1.6, strokeDasharray: member ? "3 4" : undefined, opacity: dimmed ? 0.15 : 1 },
      markerEnd: member ? undefined : { type: MarkerType.ArrowClosed, color: colour, width: 16, height: 16 },
      data: { edge },
    };
  });

  return (
    <ReactFlow
      key={graph.file}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={layout.onNodesChange}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
      minZoom={0.05}
      nodesConnectable={false}
      zoomOnDoubleClick={false}
      onNodeClick={(_, node) => props.onSelect(node.id)}
      onNodeDoubleClick={(_, node) => {
        if (node.data.node.editable) props.onEdit(node.id);
        else if (node.data.node.kind === "external") props.onOpenFile(node.data.node.file);
      }}
      onEdgeClick={(_, edge) => {
        const target = (edge.data as { edge?: StructureEdge } | undefined)?.edge;
        if (target && target.kind === "call") props.onSelectEdge(target);
      }}
      onPaneClick={() => props.onSelect(null)}
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
    >
      <Background gap={24} size={1} color="var(--grid)" />
      <Controls showInteractive={false} />
      {!props.editingId && <MiniMap pannable zoomable nodeColor={(n) => ((n.data as CardData).node.kind === "external" ? "#8957e5" : (n.data as CardData).node.kind === "class" ? "#1f6feb" : "#30363d")} maskColor="rgba(1,4,9,0.6)" />}
    </ReactFlow>
  );
}

const nodeTypes = { unit: UnitCard };
