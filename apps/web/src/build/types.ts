// Mirrors flowlab_agent.builder (catalogue, Pipeline, Finalized) and flowlab_api.builder_service.
import type { NodeState, SessionState } from "../types";

export interface ParamSpec {
  type: "column" | "columns" | "new_column" | "int" | "float" | "bool" | "choice" | "text" | "scalar" | "path";
  description: string;
  default: unknown;
  optional: boolean;
  choices: string[] | null;
  min: number | null;
  max: number | null;
}

export interface Technique {
  id: string;
  title: string;
  description: string;
  tags: string[];
  group: string;
  task: "classification" | "regression" | null;
  requires: string[];
  provides: string[];
  params: Record<string, ParamSpec>;
  example: string;
}

export interface Purpose {
  id: string;
  title: string;
  question: string;
  snippets: Technique[];
}

export interface BuildCatalogue {
  purposes: Purpose[];
  llm_configured: boolean;
}

export interface PipelineNode {
  id: string;
  snippet: string;
  params: Record<string, unknown>;
  x: number;
  y: number;
  label?: string | null;
}

export interface PipelineEdge {
  from: string;
  to: string;
}

export interface Pipeline {
  version: 1;
  name: string;
  dataset: string | null;
  target: string | null;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}

export interface BuildIssue {
  node: string | null;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface DatasetColumn {
  name: string;
  kind: string;
  null_pct: number;
  cardinality: number | null;
  task: "classification" | "regression" | null;
}

export interface DatasetInfo {
  file: string;
  rows: number;
  columns: DatasetColumn[];
}

export interface BlockInfo {
  node: string | null;
  kind: "setup" | "node" | "auto" | "glue";
  title: string;
}

export interface FinalizedCell {
  title: string;
  code: string;
  node: string | null;
  snippet: string | null;
  glue: boolean;
  auto: boolean;
  why: string;
}

export interface FinalizeResult {
  ok: boolean;
  script: string | null;
  cells: FinalizedCell[];
  issues: BuildIssue[];
  adjustments: string[];
  unresolved: Record<string, string[]>;
  llm_used: boolean;
  tokens: number;
  notes: string;
  script_file: string | null;
  blocks: Record<string, BlockInfo>;
}

// ------------------------------------------------------------------------------ helpers

export const PURPOSE_ICON: Record<string, import("../components/Icon").IconName> = {
  data: "database",
  explore: "search",
  clean: "filter",
  features: "spark",
  split: "branch",
  preprocess: "gear",
  model: "model",
  evaluate: "chart",
  explain: "eye",
  visualize: "chart",
  export: "download",
};

export function indexCatalogue(catalogue: BuildCatalogue | null): Map<string, { technique: Technique; purpose: Purpose }> {
  const index = new Map<string, { technique: Technique; purpose: Purpose }>();
  for (const purpose of catalogue?.purposes ?? []) for (const technique of purpose.snippets) index.set(technique.id, { technique, purpose });
  return index;
}

export function nextNodeId(pipeline: Pipeline): string {
  const used = new Set(pipeline.nodes.map((n) => n.id));
  let n = pipeline.nodes.length + 1;
  while (used.has(`n${n}`)) n += 1;
  return `n${n}`;
}

/** Params that differ from the technique's defaults, as short "name=value" text for the card. */
export function paramSummary(node: PipelineNode, technique: Technique | undefined): string {
  if (!technique) return "";
  const parts: string[] = [];
  for (const [name, spec] of Object.entries(technique.params)) {
    const value = node.params[name];
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    if (JSON.stringify(value) === JSON.stringify(spec.default)) continue;
    parts.push(`${name}=${Array.isArray(value) ? value.join(",") : String(value)}`);
  }
  return parts.join(" · ");
}

/** Add a node below `after` (or at the bottom) and connect it from there. */
export function addNode(pipeline: Pipeline, snippet: string, after: string | null): { pipeline: Pipeline; id: string } {
  const id = nextNodeId(pipeline);
  const anchor = pipeline.nodes.find((n) => n.id === after) ?? pipeline.nodes.reduce<PipelineNode | null>((low, n) => (!low || n.y > low.y ? n : low), null);
  const node: PipelineNode = { id, snippet, params: {}, x: anchor ? anchor.x : 0, y: anchor ? anchor.y + 140 : 0 };
  const edges = anchor ? [...pipeline.edges, { from: anchor.id, to: id }] : pipeline.edges;
  return { pipeline: { ...pipeline, nodes: [...pipeline.nodes, node], edges }, id };
}

export function removeNodes(pipeline: Pipeline, ids: Set<string>): Pipeline {
  const nodes = pipeline.nodes.filter((n) => !ids.has(n.id));
  // reconnect around a removed node so the chain stays intact
  const edges: PipelineEdge[] = pipeline.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));
  for (const id of ids) {
    const parents = pipeline.edges.filter((e) => e.to === id && !ids.has(e.from)).map((e) => e.from);
    const children = pipeline.edges.filter((e) => e.from === id && !ids.has(e.to)).map((e) => e.to);
    for (const p of parents) for (const c of children) if (!edges.some((e) => e.from === p && e.to === c)) edges.push({ from: p, to: c });
  }
  return { ...pipeline, nodes, edges };
}

export function connectNodes(pipeline: Pipeline, from: string, to: string): Pipeline {
  if (from === to || pipeline.edges.some((e) => e.from === from && e.to === to)) return pipeline;
  return { ...pipeline, edges: [...pipeline.edges, { from, to }] };
}

const RANK: Record<NodeState, number> = { error: 5, interrupted: 4, running: 3, stale: 2, success: 1, idle: 0 };

/** A pipeline node's run state from the generated script's blocks (worst block wins). */
export function nodeRunState(nodeId: string, blocks: Record<string, BlockInfo>, session: SessionState | null): NodeState | null {
  if (!session) return null;
  const states = Object.entries(blocks)
    .filter(([, info]) => info.node === nodeId)
    .map(([block]) => session.nodes[block]?.state)
    .filter((s): s is NodeState => Boolean(s));
  if (!states.length) return null;
  return states.reduce((worst, s) => (RANK[s] > RANK[worst] ? s : worst), states[0]!);
}

export function blockFor(nodeId: string, blocks: Record<string, BlockInfo>): string | null {
  return Object.entries(blocks).find(([, info]) => info.node === nodeId)?.[0] ?? null;
}
