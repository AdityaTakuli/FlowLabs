// Mirrors the two-level architecture manifest (flowlab_lab.segregation.models, bylaws §7).

export type Confidence = "high" | "medium" | "low";
export type Severity = "error" | "warning" | "info";
export type DecidedBy = "llm" | "rule" | "cluster";

export interface ArchUnit {
  id: string;
  component_id: string | null;
  kind: "function" | "method" | "class" | "cell_block" | "module_script" | "route_handler" | "config_block";
  name: string;
  qualified_name: string;
  file: string;
  line_start: number;
  line_end: number;
  signature: string | null;
  decorators: string[];
  docstring_first_line: string | null;
  loc: number;
  sloc: number;
  defines: string[];
  uses: string[];
  calls: string[];
  raises: string[];
  returns_type: string | null;
  is_async: boolean;
  is_generator: boolean;
  complexity: number;
  side_effects: string[];
  entry_point: boolean;
  confidence: Confidence;
  archetype_hint: string | null;
  tests: string[];
}

export interface ArchComponent {
  id: string;
  name: string;
  archetype: string;
  responsibility: string;
  units: string[];
  public_surface: string[];
  depends_on: string[];
  files: string[];
  spans: { file: string; line_start: number; line_end: number }[];
  sloc: number;
  confidence: Confidence;
  decided_by: DecidedBy;
  archetype_decided_by: DecidedBy;
  archetype_confidence: Confidence;
  reason: string;
}

export interface ArchEdge {
  from: string;
  to: string;
  kind: "call" | "dataflow";
  via: string[];
  confidence: Confidence;
  observed: boolean;
}

export interface ArchFinding {
  code: string;
  severity: Severity;
  message: string;
  law: string;
  component_id: string | null;
  unit_id: string | null;
  unit_ids: string[];
  file: string | null;
  line: number | null;
}

export interface LlmReport {
  status: "skipped" | "used" | "partial" | "failed" | "over_budget";
  estimated_tokens: number;
  tokens_used: number;
  calls: number;
  cached_calls: number;
  notes: string[];
}

export interface ArchManifest {
  manifest_version: string;
  project_id: string;
  analysed_at: string;
  commit: string | null;
  stats: {
    files: number;
    units: number;
    components: number;
    unassigned_units: number;
    sloc: number;
    tokens_used: number;
    estimated_tokens: number;
    clustering: string;
  };
  components: ArchComponent[];
  units: ArchUnit[];
  edges: ArchEdge[];
  findings: ArchFinding[];
  unassigned: string[];
  files: { path: string; language: string; role: string; loc: number; sloc: number; parse_error: string | null }[];
  llm: LlmReport;
}

export interface AnalyseRequest {
  use_llm: boolean;
  confirm_external?: boolean;
  max_tokens?: number;
  allow_over_budget?: boolean;
}

const ML = new Set(["ingestion", "validation", "cleaning", "feature_engineering", "splitting", "training", "tuning", "evaluation", "explainability", "inference", "experiment_tracking", "visualization"]);
const BACKEND = new Set(["entrypoint", "routing", "controller", "service", "repository", "domain_model", "schema", "middleware", "auth", "client_adapter", "background_job"]);

export function archetypeFamily(archetype: string): "ml" | "backend" | "cross" {
  if (ML.has(archetype)) return "ml";
  if (BACKEND.has(archetype)) return "backend";
  return "cross";
}

/** Component dependency (dependent → dependency): callers depend on callees, consumers on producers. */
export function dependencyPairs(edges: ArchEdge[]): [string, string][] {
  return edges.map((e) => (e.kind === "call" ? [e.from, e.to] : [e.to, e.from]));
}

/** Strongly connected components with more than one member, as component id → cycle index. */
export function cycleMembership(ids: string[], pairs: [string, string][]): Map<string, number> {
  const next = new Map<string, string[]>();
  for (const [a, b] of pairs) next.set(a, [...(next.get(a) ?? []), b]);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const result = new Map<string, number>();
  let counter = 0;
  let cycle = 0;
  const visit = (node: string) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of next.get(node) ?? []) {
      if (!index.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node)!, low.get(target)!));
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node)!, index.get(target)!));
      }
    }
    if (low.get(node) === index.get(node)) {
      const members: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        members.push(member);
      } while (member !== node);
      if (members.length > 1) {
        for (const m of members) result.set(m, cycle);
        cycle += 1;
      }
    }
  };
  for (const id of ids) if (!index.has(id)) visit(id);
  return result;
}
