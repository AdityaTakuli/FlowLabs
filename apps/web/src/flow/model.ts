import dagre from "@dagrejs/dagre";
import type {
  Catalogue,
  CatalogueNode,
  ColumnSchema,
  CompileIssue,
  CompilePayload,
  EdgeSpec,
  FlowNodeState,
  FlowSpec,
  JsonSchema,
  NodeSpec,
  PortType,
  RunEvent,
  RunManifest,
} from "./types";

export const FLOW_NODE_WIDTH = 230;
const NODE_BASE_HEIGHT = 70;
const PORT_ROW = 20;

export type CatalogueIndex = Map<string, CatalogueNode>;

export function indexCatalogue(catalogue: Catalogue): CatalogueIndex {
  return new Map(catalogue.nodes.map((node) => [node.type, node]));
}

export function nodeHeight(entry: CatalogueNode | undefined): number {
  if (!entry) return NODE_BASE_HEIGHT;
  const rows = Math.max(Object.keys(entry.inputs).length, Object.keys(entry.outputs).length, 1);
  return NODE_BASE_HEIGHT + rows * PORT_ROW;
}

/** Port colours (never the only signal: ports also carry their type name in a tooltip and label). */
export const PORT_COLOUR: Record<PortType, string> = {
  table: "#58a6ff",
  table_split: "#39c5cf",
  model: "#bc8cff",
  transformer: "#db61a2",
  metrics: "#3fb950",
  chart: "#d29922",
  report: "#8b949e",
};

const CATEGORY_ICON: Record<string, string> = {
  source: "⛁",
  profile: "◔",
  clean: "✧",
  prep: "⚙",
  transform: "⇄",
  stats: "∑",
  model: "◆",
  viz: "▦",
  sink: "⇩",
  control: "⎇",
};

export function categoryIcon(category: string): string {
  return CATEGORY_ICON[category] ?? "●";
}

export function sharedTypes(a: PortType[], b: PortType[]): PortType[] {
  return a.filter((t) => b.includes(t));
}

export interface ConnectionRequest {
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
}

export type ConnectionCheck = { ok: true } | { ok: false; reason: string };

/** Reachability along existing edges: would source→target close a loop? */
export function wouldCycle(edges: EdgeSpec[], source: string, target: string): boolean {
  if (source === target) return true;
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop() as string;
    if (current === source) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of edges) if (edge.source === current) stack.push(edge.target);
  }
  return false;
}

/** Mirrors the compiler's structural rules so invalid drags are refused before they land. */
export function checkConnection(spec: FlowSpec, index: CatalogueIndex, request: ConnectionRequest): ConnectionCheck {
  const sourceNode = spec.nodes.find((n) => n.id === request.source);
  const targetNode = spec.nodes.find((n) => n.id === request.target);
  if (!sourceNode || !targetNode) return { ok: false, reason: "That node no longer exists." };
  if (sourceNode.id === targetNode.id) return { ok: false, reason: "A node cannot feed its own input." };
  const source = index.get(sourceNode.type);
  const target = index.get(targetNode.type);
  if (!source || !target) return { ok: false, reason: "Unknown node type." };
  const out = source.outputs[request.sourcePort];
  const input = target.inputs[request.targetPort];
  if (!out) return { ok: false, reason: `${source.title} has no output '${request.sourcePort}'.` };
  if (!input) return { ok: false, reason: `${target.title} has no input '${request.targetPort}'.` };
  if (sharedTypes(out.types, input.types).length === 0) {
    return {
      ok: false,
      reason: `${source.title} → '${request.sourcePort}' produces ${out.types.join("/")}, but ${target.title} → '${request.targetPort}' accepts ${input.types.join("/")}.`,
    };
  }
  const taken = spec.edges.find((e) => e.target === request.target && e.target_port === request.targetPort);
  if (taken) {
    return taken.source === request.source && taken.source_port === request.sourcePort
      ? { ok: false, reason: "These ports are already connected." }
      : { ok: false, reason: `Input '${request.targetPort}' of ${labelOf(targetNode, target)} is already connected to ${taken.source}. Delete that edge first.` };
  }
  if (wouldCycle(spec.edges, request.source, request.target)) {
    return { ok: false, reason: "That connection would create a cycle; flows must run in one direction." };
  }
  return { ok: true };
}

export function labelOf(node: NodeSpec, entry?: CatalogueNode): string {
  return node.label || entry?.title || node.id;
}

export function nextNodeId(spec: FlowSpec, type: string): string {
  const base = (type.split(".").pop() || "node").replace(/[^A-Za-z0-9_]/g, "_");
  const taken = new Set(spec.nodes.map((n) => n.id));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

export function nextEdgeId(spec: FlowSpec): string {
  const taken = new Set(spec.edges.map((e) => e.id));
  for (let i = spec.edges.length + 1; ; i++) if (!taken.has(`e${i}`)) return `e${i}`;
}

export function connect(spec: FlowSpec, request: ConnectionRequest): FlowSpec {
  const edge: EdgeSpec = {
    id: nextEdgeId(spec),
    source: request.source,
    source_port: request.sourcePort,
    target: request.target,
    target_port: request.targetPort,
  };
  return { ...spec, edges: [...spec.edges, edge] };
}

export function addNode(
  spec: FlowSpec,
  entry: CatalogueNode,
  position: { x: number; y: number },
): { spec: FlowSpec; nodeId: string } {
  const nodeId = nextNodeId(spec, entry.type);
  const params: Record<string, unknown> = {};
  if (entry.type === "source.dataset") {
    const refs = Object.keys(spec.dataset_bindings);
    if (refs.length === 1) params.dataset_ref = refs[0];
  }
  const node: NodeSpec = { id: nodeId, type: entry.type, label: null, params, position: roundPoint(position) };
  return { spec: { ...spec, nodes: [...spec.nodes, node] }, nodeId };
}

function roundPoint(point: { x: number; y: number }) {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

/**
 * PRD 11.2: a dropped node auto-connects its first unconnected required input to the nearest
 * compatible output upstream (to the left of or level with the drop point).
 */
export function autoConnect(spec: FlowSpec, index: CatalogueIndex, nodeId: string): FlowSpec {
  const node = spec.nodes.find((n) => n.id === nodeId);
  const entry = node && index.get(node.type);
  if (!node || !entry) return spec;
  const port = Object.entries(entry.inputs).find(
    ([name, def]) => def.required && !spec.edges.some((e) => e.target === nodeId && e.target_port === name),
  );
  if (!port) return spec;
  const [portName] = port;
  let best: { request: ConnectionRequest; distance: number } | null = null;
  for (const candidate of spec.nodes) {
    if (candidate.id === nodeId || candidate.position.x > node.position.x + 40) continue;
    const candidateEntry = index.get(candidate.type);
    if (!candidateEntry) continue;
    const distance = Math.hypot(candidate.position.x - node.position.x, candidate.position.y - node.position.y);
    for (const outPort of Object.keys(candidateEntry.outputs)) {
      const request = { source: candidate.id, sourcePort: outPort, target: nodeId, targetPort: portName };
      if (checkConnection(spec, index, request).ok && (!best || distance < best.distance)) best = { request, distance };
    }
  }
  return best ? connect(spec, best.request) : spec;
}

export function removeElements(spec: FlowSpec, nodeIds: Set<string>, edgeIds: Set<string>): FlowSpec {
  return {
    ...spec,
    nodes: spec.nodes.filter((n) => !nodeIds.has(n.id)),
    edges: spec.edges.filter((e) => !edgeIds.has(e.id) && !nodeIds.has(e.source) && !nodeIds.has(e.target)),
  };
}

export function updateNode(spec: FlowSpec, nodeId: string, patch: Partial<NodeSpec>): FlowSpec {
  return { ...spec, nodes: spec.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) };
}

export function moveNodes(spec: FlowSpec, positions: Record<string, { x: number; y: number }>): FlowSpec {
  return {
    ...spec,
    nodes: spec.nodes.map((n) => {
      const position = positions[n.id];
      return position ? { ...n, position: roundPoint(position) } : n;
    }),
  };
}

/** Rename a node id everywhere it is referenced. Returns null when the id is invalid or taken. */
export function renameNode(spec: FlowSpec, from: string, to: string): FlowSpec | null {
  if (from === to) return spec;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(to) || spec.nodes.some((n) => n.id === to)) return null;
  return {
    ...spec,
    nodes: spec.nodes.map((n) => (n.id === from ? { ...n, id: to } : n)),
    edges: spec.edges.map((e) => ({
      ...e,
      source: e.source === from ? to : e.source,
      target: e.target === from ? to : e.target,
    })),
  };
}

/** Left-to-right dagre layout, for agent-generated or messy graphs. */
export function layoutFlow(spec: FlowSpec, index: CatalogueIndex): FlowSpec {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 90, marginx: 40, marginy: 40 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of spec.nodes) graph.setNode(node.id, { width: FLOW_NODE_WIDTH, height: nodeHeight(index.get(node.type)) });
  for (const edge of spec.edges) if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);
  const positions: Record<string, { x: number; y: number }> = {};
  for (const node of spec.nodes) {
    const placed = graph.node(node.id) as { x: number; y: number; height: number } | undefined;
    if (placed) positions[node.id] = { x: placed.x - FLOW_NODE_WIDTH / 2, y: placed.y - placed.height / 2 };
  }
  return moveNodes(spec, positions);
}

// ------------------------------------------------------------------------- clipboard
export interface Clipboard {
  nodes: NodeSpec[];
  edges: EdgeSpec[];
}

export function copySelection(spec: FlowSpec, nodeIds: Set<string>): Clipboard | null {
  const nodes = spec.nodes.filter((n) => nodeIds.has(n.id));
  if (!nodes.length) return null;
  return { nodes, edges: spec.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target)) };
}

export function paste(spec: FlowSpec, clip: Clipboard, offset = 40): { spec: FlowSpec; nodeIds: string[] } {
  let next = spec;
  const mapping = new Map<string, string>();
  for (const node of clip.nodes) {
    const id = nextNodeId(next, node.type);
    mapping.set(node.id, id);
    const copy: NodeSpec = {
      ...node,
      id,
      params: structuredClone(node.params),
      position: { x: node.position.x + offset, y: node.position.y + offset },
    };
    next = { ...next, nodes: [...next.nodes, copy] };
  }
  for (const edge of clip.edges) {
    next = connect(next, {
      source: mapping.get(edge.source) as string,
      sourcePort: edge.source_port,
      target: mapping.get(edge.target) as string,
      targetPort: edge.target_port,
    });
  }
  return { spec: next, nodeIds: [...mapping.values()] };
}

// --------------------------------------------------------------------------- history
export interface History {
  past: FlowSpec[];
  future: FlowSpec[];
}

export const EMPTY_HISTORY: History = { past: [], future: [] };
const HISTORY_LIMIT = 100;

export function record(history: History, previous: FlowSpec): History {
  return { past: [...history.past.slice(-(HISTORY_LIMIT - 1)), previous], future: [] };
}

export function undo(history: History, current: FlowSpec): { history: History; spec: FlowSpec } | null {
  const previous = history.past[history.past.length - 1];
  if (!previous) return null;
  return { history: { past: history.past.slice(0, -1), future: [current, ...history.future] }, spec: previous };
}

export function redo(history: History, current: FlowSpec): { history: History; spec: FlowSpec } | null {
  const [next, ...rest] = history.future;
  if (!next) return null;
  return { history: { past: [...history.past, current], future: rest }, spec: next };
}

// ------------------------------------------------------------------ compile & run state
export function issuesByNode(compile: CompilePayload | null): Map<string, CompileIssue[]> {
  const map = new Map<string, CompileIssue[]>();
  for (const issue of [...(compile?.errors ?? []), ...(compile?.warnings ?? [])]) {
    const key = issue.node_id ?? "";
    map.set(key, [...(map.get(key) ?? []), issue]);
  }
  return map;
}

export function statesFromManifest(manifest: RunManifest): Record<string, FlowNodeState> {
  const states: Record<string, FlowNodeState> = {};
  for (const node of manifest.nodes) {
    states[node.node_id] =
      node.status === "failed"
        ? "error"
        : node.status === "skipped"
          ? "skipped"
          : node.status === "cached"
            ? "cached"
            : node.warnings.length
              ? "warning"
              : "success";
  }
  return states;
}

/** Fold one live RunEvent into per-node states. ``order`` is the plan order returned by /flow/run. */
export function applyRunEvent(
  states: Record<string, FlowNodeState>,
  event: RunEvent,
  order: string[],
): Record<string, FlowNodeState> {
  const node = event.node_id;
  switch (event.type) {
    case "run_started":
      return Object.fromEntries(order.map((id) => [id, "queued" as FlowNodeState]));
    case "node_started":
      return node ? { ...states, [node]: "running" } : states;
    case "node_warning":
      return node ? { ...states, [node]: states[node] === "running" ? "running" : "warning", [`${node}:warned`]: "warning" } : states;
    case "node_completed": {
      if (!node) return states;
      const warned = states[`${node}:warned`] === "warning";
      return { ...states, [node]: event.payload.cache_hit ? "cached" : warned ? "warning" : "success" };
    }
    case "node_failed":
      return node ? { ...states, [node]: "error" } : states;
    case "run_failed":
    case "run_cancelled":
      return Object.fromEntries(
        Object.entries(states).map(([id, state]) => [id, state === "queued" || state === "running" ? "skipped" : state]),
      );
    default:
      return states;
  }
}

/** Nodes whose compiled cache key no longer matches the run being displayed. */
export function outdatedNodes(compile: CompilePayload | null, manifest: RunManifest | null): Set<string> {
  const outdated = new Set<string>();
  if (!compile?.ok || !manifest) return outdated;
  const ran = new Map(manifest.nodes.map((n) => [n.node_id, n.cache_key]));
  for (const [nodeId, key] of Object.entries(compile.cache_keys)) if (ran.get(nodeId) !== key) outdated.add(nodeId);
  return outdated;
}

/** Columns a node's column pickers offer: its first table input, or its own output for sources. */
export function columnsFor(compile: CompilePayload | null, nodeId: string): ColumnSchema[] | null {
  const sides = compile?.schemas[nodeId];
  if (!sides) return null;
  const ports = Object.values(sides.inputs).length ? Object.values(sides.inputs) : Object.values(sides.outputs);
  for (const port of ports) if (port.table) return port.table.columns;
  return null;
}

export function filterColumns(columns: ColumnSchema[], schema: JsonSchema): ColumnSchema[] {
  const filter = schema["x-filter"] ?? schema.items?.["x-filter"];
  if (!filter) return columns;
  return columns.filter(
    (c) => (!filter.semantic || filter.semantic.includes(c.semantic)) && (!filter.role || filter.role.includes(c.role)),
  );
}

export function emptyFlow(name: string): FlowSpec {
  return { spec_version: "1.0", flow_id: `flw_${Date.now().toString(36)}`, name, dataset_bindings: {}, nodes: [], edges: [] };
}
