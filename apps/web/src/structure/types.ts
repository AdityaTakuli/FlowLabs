// Mirrors flowlab_lab.structure (StructureGraph) and flowlab_lab.languages (FileKind).

export type Workspace = "cells" | "structure";

export interface FileKind {
  language: string;
  language_name: string;
  monaco: string;
  workspace: Workspace;
  reason: string;
  can_run_cells: boolean;
}

export interface LanguageSummary {
  id: string;
  name: string;
  files: number;
  share: number;
}

export type StructureNodeKind = "function" | "method" | "class" | "module" | "external";

export interface StructureNode {
  id: string;
  kind: StructureNodeKind;
  name: string;
  qualified_name: string;
  parent: string | null;
  file: string;
  line_start: number;
  line_end: number;
  signature: string;
  doc: string | null;
  source: string;
  source_hash: string;
  editable: boolean;
  calls: string[];
  loc: number;
}

export interface CallSite {
  line: number;
  text: string;
}

export interface StructureEdge {
  from: string;
  to: string;
  kind: "call" | "member";
  names: string[];
  sites: CallSite[];
}

export interface StructureGraph {
  file: string;
  language: string;
  language_name: string;
  monaco: string;
  hash: string;
  nodes: StructureNode[];
  edges: StructureEdge[];
  problems: { line: number; message: string }[];
  truncated: boolean;
  analysis_ms: number | null;
  workspace: Workspace;
  reason: string;
  can_run_cells: boolean;
}

export interface LayoutPayload {
  file: string;
  view: string;
  positions: Record<string, { x: number; y: number }>;
}

export const KIND_ICON: Record<StructureNodeKind, string> = {
  function: "ƒ",
  method: "m",
  class: "C",
  module: "▶",
  external: "↗",
};

const LANGUAGE_ICON: Record<string, string> = {
  Python: "🐍",
  TypeScript: "TS",
  JavaScript: "JS",
  Go: "Go",
  Rust: "Rs",
  Java: "Jv",
  Kotlin: "Kt",
  "C#": "C#",
  C: "C",
  "C++": "C++",
  Ruby: "Rb",
  PHP: "php",
  Swift: "Sw",
};

export function languageIcon(name: string | undefined, file: string): string {
  if (file.endsWith(".ipynb")) return "📓";
  return (name && LANGUAGE_ICON[name]) || "{}";
}

/** Which workspace a file opens in: the user's per-file choice wins, notebooks are always cells. */
export function workspaceFor(file: string, kind: FileKind | undefined, override: Workspace | null): Workspace {
  if (file.endsWith(".ipynb")) return "cells";
  if (!kind) return file.endsWith(".py") ? "cells" : "structure";
  if (override === "cells" && kind.can_run_cells) return "cells";
  if (override === "structure") return "structure";
  return kind.workspace;
}

/** Files shown in the sidebar for a language filter ("all" shows everything). */
export function filesForLanguage(files: string[], info: Record<string, FileKind>, language: string): string[] {
  if (language === "all") return files;
  return files.filter((f) => info[f]?.language_name === language);
}

/** Collapse a class's members out of view: edges to hidden members point at the class instead. */
export function visibleStructure(graph: StructureGraph, collapsed: Set<string>): { nodes: StructureNode[]; edges: StructureEdge[] } {
  const hidden = new Map<string, string>();
  for (const node of graph.nodes) if (node.parent && collapsed.has(node.parent)) hidden.set(node.id, node.parent);
  const nodes = graph.nodes.filter((n) => !hidden.has(n.id));
  const merged = new Map<string, StructureEdge>();
  for (const edge of graph.edges) {
    const from = hidden.get(edge.from) ?? edge.from;
    const to = hidden.get(edge.to) ?? edge.to;
    if (from === to) continue;
    const key = `${from}>${to}>${edge.kind}`;
    const existing = merged.get(key);
    if (existing) {
      for (const name of edge.names) if (!existing.names.includes(name)) existing.names.push(name);
      existing.sites.push(...edge.sites.slice(0, Math.max(0, 5 - existing.sites.length)));
    } else {
      merged.set(key, { ...edge, from, to, names: [...edge.names], sites: [...edge.sites] });
    }
  }
  return { nodes, edges: [...merged.values()] };
}

/** Everything one hop away from ``id`` (for focus dimming). */
export function structureNeighbours(edges: StructureEdge[], id: string): Set<string> {
  const near = new Set([id]);
  for (const e of edges) {
    if (e.from === id) near.add(e.to);
    if (e.to === id) near.add(e.from);
  }
  return near;
}
