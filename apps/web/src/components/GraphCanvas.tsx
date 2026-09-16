import { useMemo } from "react";
import {
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  NodeToolbar,
  Position,
  ReactFlow,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  edgeValueLabel,
  type EdgeRoute,
  formatCount,
  formatDuration,
  layoutWithRoutes,
  neighbourhood,
  smoothPath,
  variableMatches,
  visibleEdges,
} from "../layout";
import type { Api } from "../api";
import type { CodeGraph, CodeNode, ExecutionRecord, LiveRun, MetricPoint, NodeState, RunMode, SessionState } from "../types";
import { Icon, type IconName } from "./Icon";
import { latestValues } from "./MetricsChart";
import { PaperBackground } from "./PaperBackground";
import { useSavedLayout, withMoved } from "../structure/useSavedLayout";
import { InlineEditor, type SourceProblem } from "./InlineEditor";

export type HeatMode = "off" | "time" | "memory";

export const STATE_LABEL: Record<NodeState, { icon: IconName; text: string }> = {
  idle: { icon: "dot", text: "idle" },
  running: { icon: "refresh", text: "running" },
  success: { icon: "check", text: "ran" },
  error: { icon: "error", text: "error" },
  stale: { icon: "refresh", text: "stale" },
  interrupted: { icon: "stop", text: "stopped" },
};

const PREFERRED_METRICS = ["val_loss", "loss", "val_acc", "val_accuracy", "accuracy", "acc", "roc_auc", "f1"];

/** The one metric worth showing on a card: validation loss first, then training loss, then scores. */
export function headlineMetric(points: MetricPoint[]): [string, number] | null {
  if (!points.length) return null;
  const latest = latestValues(points);
  const name = PREFERRED_METRICS.find((m) => m in latest) ?? Object.keys(latest)[0];
  return name === undefined ? null : [name, latest[name]!];
}

export interface EdgeTarget {
  from: string;
  to: string;
  variables: string[];
}

interface NodeData extends Record<string, unknown> {
  node: CodeNode;
  state: NodeState;
  record: ExecutionRecord | null;
  warnings: number;
  dimmed: boolean;
  highlighted: boolean;
  heat: number | null;
  kernelReady: boolean;
  editing: boolean;
  progress: number | null;
  metric: [string, number] | null;
  model: string | null;
  onRun: (nodeId: string, mode: RunMode) => void;
  onEdit: (nodeId: string | null) => void;
  onSaveSource: (nodeId: string, source: string) => Promise<boolean>;
  onCheckSource: (nodeId: string, source: string) => Promise<SourceProblem | null>;
}

type CodeFlowNode = Node<NodeData, "code">;

interface DataEdgeData extends Record<string, unknown> {
  route: EdgeRoute | null;
  names: string;
  value: string | null;
  stale: boolean;
  dimmed: boolean;
  flowing: boolean;
  kind: string;
  onOpen: () => void;
}

type DataFlowEdge = Edge<DataEdgeData, "data">;

function heatColour(value: number): string {
  // 0 → cool slate, 1 → hot orange
  const hue = 210 - 190 * value;
  return `hsl(${hue} 70% ${18 + 14 * value}%)`;
}

function CodeNodeView({ data, selected }: NodeProps<CodeFlowNode>) {
  const { node, state, record, warnings, dimmed, highlighted, heat } = data;
  const label = STATE_LABEL[state];
  const undefinedNode = node.kind === "undefined";
  const outputs = record?.rich_outputs?.length ?? 0;
  const className = [
    "code-node",
    `state-${state}`,
    `confidence-${node.confidence}`,
    undefinedNode ? "undefined-node" : "",
    selected ? "selected" : "",
    dimmed ? "dimmed" : "",
    highlighted ? "highlighted" : "",
    data.editing ? "editing" : "",
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
            <Icon name={label.icon} size={10} /> {label.text}
          </span>
        )}
      </div>
      <div className="code-node-meta">
        {node.matched_pattern && <span className="chip pattern">{node.matched_pattern}</span>}
        {node.confidence !== "high" && <span className={`chip conf-${node.confidence}`}>{node.confidence} confidence</span>}
        {node.loop_carried.length > 0 && <span className="chip">⟳ loop</span>}
        {data.model && (
          <span className="chip model-chip-dl" title={data.model}>
            <Icon name="model" size={10} /> {data.model.split(" · ").slice(1).join(" · ") || data.model}
          </span>
        )}
        {data.metric && (
          <span className="chip metric-chip" title="Latest training metric (Training tab)">
            {data.metric[0]} {Number(data.metric[1].toPrecision(3))}
          </span>
        )}
        {warnings > 0 && (
          <span className="chip warn">
            <Icon name="warning" size={10} /> {warnings}
          </span>
        )}
        {outputs > 0 && (
          <span className="chip" title={`${outputs} displayed output(s): see the Output tab`}>
            <Icon name="output" size={10} /> {outputs}
          </span>
        )}
      </div>
      <div className="code-node-summary">{summary}</div>
      {!undefinedNode && (
        <div className="code-node-actions">
          <button className="nodrag" title="Edit this block here (or double-click it)" onClick={(e) => (e.stopPropagation(), data.onEdit(node.id))}>
            <Icon name="edit" size={11} />
          </button>
          {data.kernelReady && (
            <>
              <button className="nodrag" title="Run this block only" onClick={(e) => (e.stopPropagation(), data.onRun(node.id, "node"))}>
                <Icon name="play" size={11} />
              </button>
              <button className="nodrag" title="Run to here (ancestors first)" onClick={(e) => (e.stopPropagation(), data.onRun(node.id, "to"))}>
                <Icon name="runTo" size={11} />
              </button>
              <button className="nodrag" title="Run from here (and descendants)" onClick={(e) => (e.stopPropagation(), data.onRun(node.id, "from"))}>
                <Icon name="runFrom" size={11} />
              </button>
            </>
          )}
        </div>
      )}
      {state === "running" && data.progress !== null && (
        <div className="node-progress" role="progressbar" aria-valuenow={Math.round(data.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${data.progress * 100}%` }} />
        </div>
      )}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
      {data.editing && !undefinedNode && (
        <NodeToolbar isVisible position={Position.Bottom} offset={12} className="nodrag nowheel nopan nokey">
          <InlineEditor
            node={node}
            kernelReady={data.kernelReady}
            onCheck={(source) => data.onCheckSource(node.id, source)}
            onSave={(source) => data.onSaveSource(node.id, source)}
            onRun={() => data.onRun(node.id, "node")}
            onClose={() => data.onEdit(null)}
          />
        </NodeToolbar>
      )}
    </div>
  );
}

/** An edge whose label shows the variables it carries and, once the source ran, their values. */
function DataEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, data }: EdgeProps<DataFlowEdge>) {
  let [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const route = data?.route;
  if (route && route.points.length > 2) {
    // follow dagre's route (it bends around blocks) and put the label on it
    path = smoothPath([{ x: sourceX, y: sourceY }, ...route.points.slice(1, -1), { x: targetX, y: targetY }]);
    labelX = route.label.x;
    labelY = route.label.y;
  }
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={18} />
      {data && (
        <EdgeLabelRenderer>
          <button
            className={[
              "edge-label",
              "nodrag",
              "nopan",
              data.value ? "has-value" : "",
              data.stale ? "stale" : "",
              data.flowing ? "flowing" : "",
              `edge-kind-${data.kind}`,
            ].join(" ")}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, opacity: data.dimmed ? 0.18 : 1 }}
            onClick={(event) => {
              event.stopPropagation();
              data.onOpen();
            }}
            title={data.value ? "Show the data travelling along this edge" : "Run the upstream block to capture the data on this edge"}
          >
            <span className="edge-names">{data.names}</span>
            {data.value && <span className="edge-value">{data.value}</span>}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { code: CodeNodeView };
const edgeTypes = { data: DataEdge };

export interface GraphCanvasProps {
  api: Api;
  file: string;
  graph: CodeGraph;
  session: SessionState | null;
  selectedId: string | null;
  focus: boolean;
  search: string;
  heat: HeatMode;
  showImports: boolean;
  editingId: string | null;
  onSelect: (nodeId: string | null) => void;
  onOpenEdge: (edge: EdgeTarget) => void;
  onRun: (nodeId: string, mode: RunMode) => void;
  onEdit: (nodeId: string | null) => void;
  onSaveSource: (nodeId: string, source: string) => Promise<boolean>;
  onCheckSource: (nodeId: string, source: string) => Promise<SourceProblem | null>;
  /** Metrics and progress streamed from blocks while they run. */
  live?: Record<string, LiveRun>;
}

export function GraphCanvas(props: GraphCanvasProps) {
  const { graph, session, selectedId, focus, search, heat, showImports } = props;
  const edges = useMemo(() => visibleEdges(graph, showImports), [graph, showImports]);
  const structure = useMemo(
    () => graph.nodes.map((n) => n.id).join(",") + "|" + edges.map((e) => `${e.from}>${e.to}`).join(","),
    [graph, edges],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => layoutWithRoutes(graph.nodes, edges), [structure]);
  const saved = useSavedLayout(props.api, props.file, "cells", props.onSelect);
  const positions = withMoved(layout.positions, saved.moved);

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
    const streamed = props.live?.[node.id];
    const points = streamed?.metrics.length ? streamed.metrics : (entry?.metrics ?? []);
    const model = Object.values(entry?.values ?? {}).find((v) => v.kind === "model")?.text ?? null;
    return {
      id: node.id,
      type: "code",
      position: positions[node.id] ?? { x: 0, y: 0 },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      measured: saved.measured[node.id],
      selected: node.id === selectedId,
      draggable: true,
      zIndex: node.id === props.editingId ? 10 : 0,
      data: {
        node,
        state: entry?.state ?? "idle",
        record: entry?.last_run ?? null,
        warnings: (warningCounts.get(node.id) ?? 0) + (entry?.last_run?.warnings.length ?? 0),
        dimmed: related !== null && !related.has(node.id),
        highlighted: related !== null && related.has(node.id) && search.trim() !== "",
        heat: heatValues ? (heatValues.get(node.id) ?? 0) : null,
        kernelReady,
        editing: node.id === props.editingId,
        progress: streamed?.progress ?? null,
        metric: headlineMetric(points),
        model,
        onRun: props.onRun,
        onEdit: props.onEdit,
        onSaveSource: props.onSaveSource,
        onCheckSource: props.onCheckSource,
      },
    };
  });

  const running = session?.kernel.running ?? null;
  const flowEdges: DataFlowEdge[] = edges.map((edge) => {
    const dimmed = related !== null && !(related.has(edge.from) && related.has(edge.to));
    const dash = edge.kind === "mutation" ? "7 4" : edge.confidence === "medium" ? "5 4" : edge.confidence === "low" ? "2 4" : undefined;
    const colour =
      edge.kind === "mutation" ? "var(--orange)" : edge.kind === "import" ? "var(--edge-import)" : edge.from.startsWith("undefined:") ? "var(--red)" : "var(--edge)";
    const source = session?.nodes[edge.from];
    const label = edgeValueLabel(edge.variables, edge.kind === "import" ? undefined : source?.values);
    return {
      id: `${edge.from}->${edge.to}:${edge.kind}`,
      source: edge.from,
      target: edge.to,
      type: "data",
      animated: running === edge.to,
      className: `edge-${edge.kind}`,
      style: { stroke: label.value ? "var(--accent)" : colour, strokeWidth: edge.kind === "import" ? 1 : 1.6, strokeDasharray: dash, opacity: dimmed ? 0.15 : 1 },
      markerEnd: { type: MarkerType.ArrowClosed, color: label.value ? "var(--accent)" : colour, width: 16, height: 16 },
      data: {
        // dagre's routed bends only fit the automatic layout; a dragged card gets a plain curve
        route: edge.from in saved.moved || edge.to in saved.moved ? null : (layout.routes[`${edge.from}>${edge.to}`] ?? null),
        names: label.names,
        value: label.value,
        stale: source?.state === "stale",
        dimmed,
        flowing: running === edge.to,
        kind: edge.kind,
        onOpen: () => props.onOpenEdge({ from: edge.from, to: edge.to, variables: edge.variables }),
      },
    };
  });

  return (
    <ReactFlow
      key={props.file}
      nodes={nodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={saved.onNodesChange}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
      minZoom={0.1}
      nodesConnectable={false}
      edgesFocusable
      zoomOnDoubleClick={false}
      onNodeClick={(_, node) => props.onSelect(node.id)}
      onNodeDoubleClick={(_, node) => {
        if (node.data.node.kind !== "undefined") props.onEdit(node.id);
      }}
      onEdgeClick={(_, edge) => edge.data?.onOpen()}
      onPaneClick={() => props.onSelect(null)}
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
    >
      <PaperBackground />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor={(n) => ((n.data as NodeData).node.kind === "undefined" ? "#fb7185" : "#2a2a2a")} maskColor="rgba(1,4,9,0.6)" />
    </ReactFlow>
  );
}
