import { useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { NODE_HEIGHT, NODE_WIDTH, formatCount, formatDuration, layoutGraph, neighbourhood, variableMatches, visibleEdges } from "../layout";
import type { CodeGraph, CodeNode, ExecutionRecord, NodeState, RunMode, SessionState } from "../types";

export type HeatMode = "off" | "time" | "memory";

export const STATE_LABEL: Record<NodeState, { icon: string; text: string }> = {
  idle: { icon: "○", text: "idle" },
  running: { icon: "◐", text: "running" },
  success: { icon: "✓", text: "ran" },
  error: { icon: "✕", text: "error" },
  stale: { icon: "↻", text: "stale" },
  interrupted: { icon: "■", text: "stopped" },
};

interface NodeData extends Record<string, unknown> {
  node: CodeNode;
  state: NodeState;
  record: ExecutionRecord | null;
  warnings: number;
  dimmed: boolean;
  highlighted: boolean;
  heat: number | null;
  kernelReady: boolean;
  onRun: (nodeId: string, mode: RunMode) => void;
}

type CodeFlowNode = Node<NodeData, "code">;

function heatColour(value: number): string {
  // 0 → cool slate, 1 → hot orange
  const hue = 210 - 190 * value;
  return `hsl(${hue} 70% ${18 + 14 * value}%)`;
}

function CodeNodeView({ data, selected }: NodeProps<CodeFlowNode>) {
  const { node, state, record, warnings, dimmed, highlighted, heat } = data;
  const label = STATE_LABEL[state];
  const undefinedNode = node.kind === "undefined";
  const className = [
    "code-node",
    `state-${state}`,
    `confidence-${node.confidence}`,
    undefinedNode ? "undefined-node" : "",
    selected ? "selected" : "",
    dimmed ? "dimmed" : "",
    highlighted ? "highlighted" : "",
  ].join(" ");
  const summary = record
    ? `${record.rows_out !== null ? `${formatCount(record.rows_out)} rows · ` : ""}${formatDuration(record.duration_ms)}`
    : undefinedNode
      ? "not defined in this file"
      : node.defines.length
        ? `→ ${node.defines.slice(0, 3).join(", ")}${node.defines.length > 3 ? "…" : ""}`
        : "";
  return (
    <div
      className={className}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT, ...(heat !== null ? { background: heatColour(heat) } : {}) }}
      aria-label={`${node.id} ${node.label}, ${label.text}, ${node.confidence} confidence${warnings ? `, ${warnings} warnings` : ""}`}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="code-node-head">
        <span className="code-node-id">{undefinedNode ? "?" : node.id}</span>
        <span className="code-node-label" title={node.label}>
          {node.label}
        </span>
        {!undefinedNode && (
          <span className={`state-pill state-${state}`}>
            <span aria-hidden>{label.icon}</span> {label.text}
          </span>
        )}
      </div>
      <div className="code-node-meta">
        {node.matched_pattern && <span className="chip pattern">{node.matched_pattern}</span>}
        {node.confidence !== "high" && <span className={`chip conf-${node.confidence}`}>{node.confidence} confidence</span>}
        {node.loop_carried.length > 0 && <span className="chip">⟳ loop</span>}
        {warnings > 0 && <span className="chip warn">⚠ {warnings}</span>}
      </div>
      <div className="code-node-summary">{summary}</div>
      {!undefinedNode && data.kernelReady && (
        <div className="code-node-actions">
          <button className="nodrag" title="Run this block only" onClick={(e) => (e.stopPropagation(), data.onRun(node.id, "node"))}>
            ▶
          </button>
          <button className="nodrag" title="Run to here (ancestors first)" onClick={(e) => (e.stopPropagation(), data.onRun(node.id, "to"))}>
            ⇣
          </button>
          <button className="nodrag" title="Run from here (and descendants)" onClick={(e) => (e.stopPropagation(), data.onRun(node.id, "from"))}>
            ⇊
          </button>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { code: CodeNodeView };

export interface GraphCanvasProps {
  file: string;
  graph: CodeGraph;
  session: SessionState | null;
  selectedId: string | null;
  focus: boolean;
  search: string;
  heat: HeatMode;
  showImports: boolean;
  onSelect: (nodeId: string | null) => void;
  onSelectEdge: (from: string, variable: string) => void;
  onRun: (nodeId: string, mode: RunMode) => void;
}

export function GraphCanvas(props: GraphCanvasProps) {
  const { graph, session, selectedId, focus, search, heat, showImports } = props;
  const edges = useMemo(() => visibleEdges(graph, showImports), [graph, showImports]);
  const structure = useMemo(
    () => graph.nodes.map((n) => n.id).join(",") + "|" + edges.map((e) => `${e.from}>${e.to}`).join(","),
    [graph, edges],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const positions = useMemo(() => layoutGraph(graph.nodes, edges), [structure]);

  const related = useMemo(() => {
    if (search.trim()) return variableMatches(graph, search);
    if (focus && selectedId) return neighbourhood(graph, selectedId);
    return null;
  }, [graph, search, focus, selectedId]);

  const heatValues = useMemo(() => {
    if (heat === "off" || !session) return null;
    const values = new Map<string, number>();
    for (const [id, entry] of Object.entries(session.nodes)) {
      const record = entry.last_run;
      const value = heat === "time" ? record?.duration_ms : record?.memory_delta_mb ?? record?.peak_memory_mb;
      if (value !== null && value !== undefined) values.set(id, Math.max(0, value));
    }
    const max = Math.max(1e-9, ...values.values());
    return new Map([...values].map(([id, value]) => [id, value / max]));
  }, [heat, session]);

  const warningCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const warning of graph.warnings) if (warning.node_id) counts.set(warning.node_id, (counts.get(warning.node_id) ?? 0) + 1);
    return counts;
  }, [graph]);

  const kernelReady = session?.kernel.status === "idle";
  const nodes: CodeFlowNode[] = graph.nodes.map((node) => {
    const entry = session?.nodes[node.id];
    return {
      id: node.id,
      type: "code",
      position: positions[node.id] ?? { x: 0, y: 0 },
      selected: node.id === selectedId,
      draggable: true,
      data: {
        node,
        state: entry?.state ?? "idle",
        record: entry?.last_run ?? null,
        warnings: (warningCounts.get(node.id) ?? 0) + (entry?.last_run?.warnings.length ?? 0),
        dimmed: related !== null && !related.has(node.id),
        highlighted: related !== null && related.has(node.id) && search.trim() !== "",
        heat: heatValues ? (heatValues.get(node.id) ?? 0) : null,
        kernelReady,
        onRun: props.onRun,
      },
    };
  });

  const running = session?.kernel.running ?? null;
  const flowEdges: Edge[] = edges.map((edge) => {
    const dimmed = related !== null && !(related.has(edge.from) && related.has(edge.to));
    const dash = edge.kind === "mutation" ? "7 4" : edge.confidence === "medium" ? "5 4" : edge.confidence === "low" ? "2 4" : undefined;
    const colour =
      edge.kind === "mutation" ? "var(--orange)" : edge.kind === "import" ? "var(--edge-import)" : edge.from.startsWith("undefined:") ? "var(--red)" : "var(--edge)";
    return {
      id: `${edge.from}->${edge.to}:${edge.kind}`,
      source: edge.from,
      target: edge.to,
      label: edge.variables.slice(0, 3).join(", ") + (edge.variables.length > 3 ? " …" : ""),
      animated: running === edge.to,
      className: `edge-${edge.kind}`,
      style: { stroke: colour, strokeWidth: edge.kind === "import" ? 1 : 1.6, strokeDasharray: dash, opacity: dimmed ? 0.15 : 1 },
      labelStyle: { fill: "var(--text-dim)", fontSize: 11, opacity: dimmed ? 0.2 : 1 },
      labelBgStyle: { fill: "var(--bg)", fillOpacity: 0.85 },
      markerEnd: { type: MarkerType.ArrowClosed, color: colour, width: 16, height: 16 },
      data: { variable: edge.variables[0] },
    };
  });

  return (
    <ReactFlow
      key={props.file}
      nodes={nodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
      minZoom={0.1}
      nodesConnectable={false}
      edgesFocusable
      onNodeClick={(_, node) => props.onSelect(node.id)}
      onEdgeClick={(_, edge) => props.onSelectEdge(edge.source, String((edge.data as { variable?: string } | undefined)?.variable ?? ""))}
      onPaneClick={() => props.onSelect(null)}
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
    >
      <Background gap={24} size={1} color="var(--grid)" />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor={(n) => (n.data as NodeData).node.kind === "undefined" ? "#f85149" : "#30363d"} maskColor="rgba(1,4,9,0.6)" />
    </ReactFlow>
  );
}
