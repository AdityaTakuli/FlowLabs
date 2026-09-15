import dagre from "@dagrejs/dagre";
import type { CodeEdge, CodeGraph, CodeNode } from "./types";

export const NODE_WIDTH = 250;
export const NODE_HEIGHT = 96;

export interface Point {
  x: number;
  y: number;
}

export const EDGE_LABEL_WIDTH = 170;
export const EDGE_LABEL_HEIGHT = 36;

/** Where dagre routed an edge (around other blocks) and where its label sits on that route. */
export interface EdgeRoute {
  points: Point[];
  label: Point;
}

/**
 * Top-to-bottom dagre layout (imported graphs have no stored positions). Edge labels are laid out
 * as real boxes, so a value label never lands on top of a block the edge passes.
 */
export function layoutWithRoutes(nodes: CodeNode[], edges: CodeEdge[]): { positions: Record<string, Point>; routes: Record<string, EdgeRoute> } {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", nodesep: 50, ranksep: 46, edgesep: 24, marginx: 20, marginy: 20 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  const pairs = new Set<string>();
  for (const edge of edges) {
    const key = `${edge.from}>${edge.to}`;
    if (pairs.has(key) || !graph.hasNode(edge.from) || !graph.hasNode(edge.to) || edge.from === edge.to) continue;
    pairs.add(key);
    graph.setEdge(edge.from, edge.to, { width: EDGE_LABEL_WIDTH, height: EDGE_LABEL_HEIGHT, labelpos: "c" });
  }
  dagre.layout(graph);
  const positions: Record<string, Point> = {};
  for (const node of nodes) {
    const placed = graph.node(node.id) as { x: number; y: number } | undefined;
    positions[node.id] = placed ? { x: placed.x - NODE_WIDTH / 2, y: placed.y - NODE_HEIGHT / 2 } : { x: 0, y: 0 };
  }
  const routes: Record<string, EdgeRoute> = {};
  for (const key of pairs) {
    const [from, to] = key.split(">") as [string, string];
    const routed = graph.edge(from, to) as { points?: Point[]; x?: number; y?: number } | undefined;
    if (routed?.points && routed.x !== undefined && routed.y !== undefined) routes[key] = { points: routed.points, label: { x: routed.x, y: routed.y } };
  }
  return { positions, routes };
}

export function layoutGraph(nodes: CodeNode[], edges: CodeEdge[]): Record<string, Point> {
  return layoutWithRoutes(nodes, edges).positions;
}

/** A smooth SVG path through points (Catmull-Rom converted to cubic Bézier segments). */
export function smoothPath(points: Point[]): string {
  if (points.length < 2) return "";
  const at = (i: number) => points[Math.max(0, Math.min(points.length - 1, i))]!;
  let path = `M ${at(0).x},${at(0).y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    path += ` C ${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`;
  }
  return path;
}

/** Edges worth drawing: import edges are optional clutter; duplicate variables between a pair are merged. */
export function visibleEdges(graph: CodeGraph, showImports: boolean): (CodeEdge & { variables: string[] })[] {
  const merged = new Map<string, CodeEdge & { variables: string[] }>();
  for (const edge of graph.edges) {
    if (!showImports && edge.kind === "import") continue;
    const key = `${edge.from}->${edge.to}:${edge.kind}`;
    const existing = merged.get(key);
    if (existing) {
      existing.variables.push(edge.variable);
      if (rank(edge.confidence) < rank(existing.confidence)) existing.confidence = edge.confidence;
    } else {
      merged.set(key, { ...edge, variables: [edge.variable] });
    }
  }
  return [...merged.values()];
}

function rank(confidence: CodeEdge["confidence"]): number {
  return confidence === "high" ? 2 : confidence === "medium" ? 1 : 0;
}

/** Ancestors and descendants of a node, for focus mode. */
export function neighbourhood(graph: CodeGraph, nodeId: string): Set<string> {
  const related = new Set<string>([nodeId]);
  const walk = (start: string, forward: boolean) => {
    const stack = [start];
    while (stack.length) {
      const current = stack.pop() as string;
      for (const edge of graph.edges) {
        const next = forward ? (edge.from === current ? edge.to : null) : edge.to === current ? edge.from : null;
        if (next && !related.has(next)) {
          related.add(next);
          stack.push(next);
        }
      }
    }
  };
  walk(nodeId, true);
  walk(nodeId, false);
  return related;
}

/** Nodes that define or read a variable, for search. */
export function variableMatches(graph: CodeGraph, query: string): Set<string> {
  const needle = query.trim();
  const found = new Set<string>();
  if (!needle) return found;
  for (const node of graph.nodes) {
    if ([...node.defines, ...node.uses, ...node.mutates].some((name) => name === needle || name.includes(needle))) found.add(node.id);
  }
  return found;
}

/** Edge label: the variables an edge carries and, when the source block ran, a short value for each. */
export function edgeValueLabel(
  variables: string[],
  values: Record<string, { kind: string; text: string }> | undefined,
): { names: string; value: string | null } {
  const names = variables.slice(0, 3).join(", ") + (variables.length > 3 ? " …" : "");
  const known = values ? variables.filter((name) => values[name]) : [];
  if (!values || known.length === 0) return { names, value: null };
  const shown = known.slice(0, 2).map((name) => (variables.length > 1 ? `${name}: ${values[name]!.text}` : values[name]!.text));
  return { names, value: shown.join(" · ") + (known.length > 2 ? ` +${known.length - 2}` : "") };
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : value.toLocaleString();
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "–";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
