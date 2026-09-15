import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useReactFlow,
  type Connection,
  type ConnectionLineComponentProps,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import {
  FLOW_NODE_WIDTH,
  PORT_COLOUR,
  categoryIcon,
  checkConnection,
  labelOf,
  type CatalogueIndex,
  type ConnectionCheck,
  type ConnectionRequest,
} from "./model";
import type { CatalogueNode, CompileIssue, FlowNodeState, FlowSpec, NodeSpec } from "./types";

const STATE_ICON: Record<FlowNodeState, { icon: string; text: string }> = {
  idle: { icon: "○", text: "idle" },
  queued: { icon: "⋯", text: "queued" },
  running: { icon: "◐", text: "running" },
  success: { icon: "✓", text: "ran" },
  cached: { icon: "⚡", text: "cached" },
  warning: { icon: "⚠", text: "warnings" },
  error: { icon: "✕", text: "failed" },
  skipped: { icon: "–", text: "skipped" },
};

interface FlowNodeData extends Record<string, unknown> {
  node: NodeSpec;
  entry: CatalogueNode | undefined;
  state: FlowNodeState;
  issues: CompileIssue[];
  outdated: boolean;
  connected: string[];
}

type FlowRFNode = Node<FlowNodeData, "flow">;

type Checker = (request: ConnectionRequest) => ConnectionCheck;
const CheckContext = createContext<Checker>(() => ({ ok: true }));

const FlowNodeView = memo(function FlowNodeView({ data, selected }: NodeProps<FlowRFNode>) {
  const { node, entry, state, issues, outdated, connected } = data;
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const status = STATE_ICON[state];
  const title = labelOf(node, entry);
  const className = [
    "flow-node",
    `cat-${entry?.category ?? "unknown"}`,
    `state-${state}`,
    selected ? "selected" : "",
    errors.length ? "has-error" : "",
    warnings.length ? "has-warning" : "",
  ].join(" ");
  return (
    <div
      className={className}
      style={{ width: FLOW_NODE_WIDTH }}
      aria-label={`${title} (${node.type}), ${status.text}${errors.length ? `, ${errors.length} errors` : ""}${warnings.length ? `, ${warnings.length} warnings` : ""}`}
    >
      <div className="flow-node-badges">
        {errors.length > 0 && (
          <span className="badge-count error" title={errors.map((e) => `${e.code}: ${e.message}`).join("\n")}>
            ✕ {errors.length}
          </span>
        )}
        {warnings.length > 0 && (
          <span className="badge-count warning" title={warnings.map((w) => `${w.code}: ${w.message}`).join("\n")}>
            ⚠ {warnings.length}
          </span>
        )}
        {outdated && (
          <span className="badge-count outdated" title="Params or inputs changed since the run shown">
            changed
          </span>
        )}
      </div>
      <div className="flow-node-head">
        <span className="flow-node-icon" aria-hidden>
          {categoryIcon(entry?.category ?? "")}
        </span>
        <span className="flow-node-label" title={title}>
          {title}
        </span>
        <span className={`state-pill flow-state-${state}`} title={status.text}>
          <span aria-hidden>{status.icon}</span> {status.text}
        </span>
      </div>
      <div className="flow-node-sub">
        <span className="mono">{node.id}</span>
        {node.label && entry && <span>· {entry.title}</span>}
        {!entry && <span className="error-text">unknown type {node.type}</span>}
      </div>
      <div className="flow-node-ports">
        <div className="col in">
          {Object.entries(entry?.inputs ?? {}).map(([port, def]) => {
            const empty = def.required && !connected.includes(port);
            return (
              <div key={port} className="port-row" title={`input ${port}: ${def.types.join(" / ")}${def.required ? " (required)" : ""}`}>
                <Handle
                  type="target"
                  position={Position.Left}
                  id={port}
                  className={empty ? "required-empty" : ""}
                  style={{ background: PORT_COLOUR[def.types[0] ?? "report"] }}
                  aria-label={`${port} input, accepts ${def.types.join(" or ")}`}
                />
                {port}
              </div>
            );
          })}
        </div>
        <div className="col out">
          {Object.entries(entry?.outputs ?? {}).map(([port, def]) => (
            <div key={port} className="port-row" title={`output ${port}: ${def.types.join(" / ")}`}>
              {port}
              <Handle
                type="source"
                position={Position.Right}
                id={port}
                style={{ background: PORT_COLOUR[def.types[0] ?? "report"] }}
                aria-label={`${port} output, produces ${def.types.join(" or ")}`}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

const nodeTypes = { flow: FlowNodeView };

function requestFrom(from: { nodeId: string; id?: string | null; type: string }, to: { nodeId: string; id?: string | null }): ConnectionRequest {
  return from.type === "source"
    ? { source: from.nodeId, sourcePort: from.id ?? "out", target: to.nodeId, targetPort: to.id ?? "in" }
    : { source: to.nodeId, sourcePort: to.id ?? "out", target: from.nodeId, targetPort: from.id ?? "in" };
}

/** While dragging a connection, an invalid target shows why it would be refused (PRD 11.2). */
function ConnectionLine(props: ConnectionLineComponentProps) {
  const check = useContext(CheckContext);
  const [path] = getBezierPath({
    sourceX: props.fromX,
    sourceY: props.fromY,
    sourcePosition: props.fromPosition,
    targetX: props.toX,
    targetY: props.toY,
    targetPosition: props.toPosition,
  });
  let reason: string | null = null;
  if (props.toHandle && props.connectionStatus === "invalid") {
    const result = check(requestFrom(props.fromHandle, props.toHandle));
    reason = result.ok ? null : result.reason;
  }
  const colour = props.connectionStatus === "invalid" ? "var(--red)" : props.connectionStatus === "valid" ? "var(--green)" : "var(--accent)";
  return (
    <g>
      <path d={path} fill="none" stroke={colour} strokeWidth={2} strokeDasharray={props.connectionStatus === "invalid" ? "6 4" : undefined} />
      <circle cx={props.toX} cy={props.toY} r={4} fill={colour} />
      {reason && (
        <text x={props.toX + 12} y={props.toY - 12} className="connection-reason">
          {reason.length > 110 ? `${reason.slice(0, 107)}…` : reason}
        </text>
      )}
    </g>
  );
}

export interface FlowCanvasProps {
  spec: FlowSpec;
  index: CatalogueIndex;
  states: Record<string, FlowNodeState>;
  issues: Map<string, CompileIssue[]>;
  outdated: Set<string>;
  selection: { nodes: string[]; edges: string[] };
  runningNode: string | null;
  /** Changing this re-fits the viewport (new file, auto-layout). */
  fitKey: string;
  onSelection: (selection: { nodes: string[]; edges: string[] }) => void;
  onMove: (positions: Record<string, { x: number; y: number }>) => void;
  onConnect: (request: ConnectionRequest) => void;
  onRefuse: (reason: string) => void;
  onDropNode: (type: string, position: { x: number; y: number }) => void;
}

export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas(props: FlowCanvasProps) {
  const { spec, index, states, issues, outdated, selection } = props;
  const { screenToFlowPosition, fitView } = useReactFlow();
  const dragging = useRef<Record<string, { x: number; y: number }>>({});
  const measured = useRef<Record<string, { width: number; height: number }>>({});
  const [, rerender] = useState(0);

  const check = useCallback<Checker>((request) => checkConnection(spec, index, request), [spec, index]);

  useEffect(() => {
    const timer = window.setTimeout(() => void fitView({ padding: 0.2, maxZoom: 1.1, duration: 200 }), 60);
    return () => window.clearTimeout(timer);
  }, [props.fitKey, fitView]);

  const connectedInputs = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const edge of spec.edges) map.set(edge.target, [...(map.get(edge.target) ?? []), edge.target_port]);
    return map;
  }, [spec.edges]);

  const nodes: FlowRFNode[] = spec.nodes.map((node) => ({
    id: node.id,
    type: "flow",
    position: dragging.current[node.id] ?? node.position,
    selected: selection.nodes.includes(node.id),
    measured: measured.current[node.id],
    data: {
      node,
      entry: index.get(node.type),
      state: states[node.id] ?? "idle",
      issues: issues.get(node.id) ?? [],
      outdated: outdated.has(node.id),
      connected: connectedInputs.get(node.id) ?? [],
    },
  }));

  const typeByOutput = (nodeId: string, port: string) => {
    const node = spec.nodes.find((n) => n.id === nodeId);
    return index.get(node?.type ?? "")?.outputs[port]?.types[0] ?? "report";
  };

  const edges: Edge[] = spec.edges.map((edge) => {
    const colour = PORT_COLOUR[typeByOutput(edge.source, edge.source_port)];
    const running = props.runningNode === edge.target;
    return {
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.source_port,
      target: edge.target,
      targetHandle: edge.target_port,
      selected: selection.edges.includes(edge.id),
      animated: running,
      style: { stroke: colour, strokeWidth: running ? 2.4 : 1.8 },
      markerEnd: { type: MarkerType.ArrowClosed, color: colour, width: 14, height: 14 },
      ariaLabel: `${edge.source}.${edge.source_port} to ${edge.target}.${edge.target_port}`,
    };
  });

  const onNodesChange = (changes: NodeChange<FlowRFNode>[]) => {
    const ended: Record<string, { x: number; y: number }> = {};
    let selected: Set<string> | null = null;
    let touched = false;
    for (const change of changes) {
      if (change.type === "position") {
        if (change.dragging && change.position) {
          dragging.current[change.id] = change.position;
          touched = true;
        } else if (!change.dragging) {
          const final = change.position ?? dragging.current[change.id];
          if (final) ended[change.id] = final;
          delete dragging.current[change.id];
          touched = true;
        }
      } else if (change.type === "dimensions" && change.dimensions) {
        measured.current[change.id] = change.dimensions;
        touched = true;
      } else if (change.type === "select") {
        selected ??= new Set(selection.nodes);
        if (change.selected) selected.add(change.id);
        else selected.delete(change.id);
      }
    }
    if (Object.keys(ended).length) props.onMove(ended);
    if (selected) props.onSelection({ nodes: [...selected], edges: selection.edges });
    if (touched) rerender((n) => n + 1);
  };

  const onEdgesChange = (changes: EdgeChange[]) => {
    let selected: Set<string> | null = null;
    for (const change of changes) {
      if (change.type === "select") {
        selected ??= new Set(selection.edges);
        if (change.selected) selected.add(change.id);
        else selected.delete(change.id);
      }
    }
    if (selected) props.onSelection({ nodes: selection.nodes, edges: [...selected] });
  };

  const isValidConnection = (connection: Connection | Edge) =>
    check({
      source: connection.source,
      sourcePort: connection.sourceHandle ?? "out",
      target: connection.target,
      targetPort: connection.targetHandle ?? "in",
    }).ok;

  const onConnectEnd = (_: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid !== false || !state.fromHandle || !state.toHandle) return;
    const result = check(requestFrom(state.fromHandle, state.toHandle));
    if (!result.ok) props.onRefuse(result.reason);
  };

  const onDragOver = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes("application/flowlab-node")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const onDrop = (event: DragEvent) => {
    const type = event.dataTransfer.getData("application/flowlab-node");
    if (!type) return;
    event.preventDefault();
    const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    props.onDropNode(type, { x: point.x - 30, y: point.y - 20 });
  };

  return (
    <CheckContext.Provider value={check}>
      <div className="flow-canvas" style={{ width: "100%", height: "100%" }} onDragOver={onDragOver} onDrop={onDrop}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={(c) =>
            props.onConnect({ source: c.source, sourcePort: c.sourceHandle ?? "out", target: c.target, targetPort: c.targetHandle ?? "in" })
          }
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          connectionLineComponent={ConnectionLine}
          connectionRadius={28}
          onPaneClick={() => props.onSelection({ nodes: [], edges: [] })}
          deleteKeyCode={null}
          selectionKeyCode="Shift"
          multiSelectionKeyCode={["Meta", "Control"]}
          panActivationKeyCode="Space"
          snapToGrid
          snapGrid={[10, 10]}
          minZoom={0.1}
          maxZoom={2}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
        >
          <Background gap={20} size={1} color="var(--grid)" />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => {
              const state = (n.data as FlowNodeData).state;
              return state === "error" ? "#f85149" : state === "success" || state === "cached" ? "#3fb950" : state === "running" ? "#58a6ff" : "#30363d";
            }}
            maskColor="rgba(1,4,9,0.6)"
          />
        </ReactFlow>
      </div>
    </CheckContext.Provider>
  );
}
