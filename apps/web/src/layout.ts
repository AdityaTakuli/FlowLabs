import dagre from "@dagrejs/dagre";
import type { CodeEdge, CodeGraph, CodeNode } from "./types";

export const NODE_WIDTH = 250;
export const NODE_HEIGHT = 96;

export interface Point {
  x: number;
  y: number;
}

/** Top-to-bottom dagre layout (imported graphs have no stored positions). */
export function layoutGraph(nodes: CodeNode[], edges: CodeEdge[]): Record<string, Point> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", nodesep: 36, ranksep: 64, marginx: 20, marginy: 20 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of edges) {
    if (graph.hasNode(edge.from) && graph.hasNode(edge.to) && edge.from !== edge.to) graph.setEdge(edge.from, edge.to);
  }
  dagre.layout(graph);
  const positions: Record<string, Point> = {};
  for (const node of nodes) {
    const placed = graph.node(node.id) as { x: number; y: number } | undefined;
    positions[node.id] = placed ? { x: placed.x - NODE_WIDTH / 2, y: placed.y - NODE_HEIGHT / 2 } : { x: 0, y: 0 };
  }
  return positions;
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
