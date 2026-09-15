// Mirrors the CodeGraph (flowlab_lab.codegraph) and local API payloads (flowlab_api.service).

export type Confidence = "high" | "medium" | "low";
export type Severity = "info" | "warning" | "error";
export type NodeState = "idle" | "running" | "success" | "error" | "stale" | "interrupted";
export type RunMode = "node" | "to" | "from" | "stale" | "all";

export interface CodeNode {
  id: string;
  kind: "code" | "undefined" | "trace";
  file: string;
  cell_index: number | null;
  lines: [number, number];
  source: string;
  source_hash: string;
  label: string;
  defines: string[];
  uses: string[];
  mutates: string[];
  imports: string[];
  calls: string[];
  side_effects: string[];
  conditional_defines: string[];
  loop_carried: string[];
  flags: string[];
  matched_pattern: string | null;
  confidence: Confidence;
  execution_count: number | null;
  group: string | null;
}

export interface CodeEdge {
  from: string;
  to: string;
  variable: string;
  kind: "dataflow" | "mutation" | "alias" | "import";
  confidence: Confidence;
}

export interface GraphWarning {
  node_id: string | null;
  code: string;
  message: string;
  severity: Severity;
}

export interface CodeGraph {
  graph_version: string;
  source: { kind: string; files: { path: string; hash: string }[] };
  nodes: CodeNode[];
  edges: CodeEdge[];
  warnings: GraphWarning[];
  analysis_ms: number | null;
}

export interface GraphPayload {
  file: string;
  hash: string;
  graph: CodeGraph;
  secrets_warning: string | null;
}

export interface TraceFrame {
  node_id: string | null;
  line: number;
  file_line: number | null;
  text: string;
}

export interface ExecutionRecord {
  execution_id: string;
  node_id: string;
  source_hash: string;
  status: "success" | "error" | "interrupted";
  started_at: string;
  duration_ms: number;
  peak_memory_mb: number | null;
  memory_delta_mb: number | null;
  rows_in: number | null;
  rows_out: number | null;
  stdout: string;
  stderr: string;
  outputs: string[];
  error: { ename: string; evalue: string; traceback: string[]; frames: TraceFrame[] } | null;
  warnings: GraphWarning[];
}

export interface KernelInfo {
  status: "none" | "starting" | "idle" | "busy" | "dead";
  running?: string | null;
  pid?: number | null;
  python?: string;
  executable?: string;
  packages?: number;
  memory_mb?: number | null;
}

export interface Resources {
  cpu_percent: number;
  cpu_count: number;
  ram_total_mb: number;
  ram_available_mb: number;
  ram_percent: number;
  disk_free_mb: number;
  kernels: Record<string, number | null>;
}

export interface SessionState {
  file: string;
  kernel: KernelInfo;
  nodes: Record<string, { state: NodeState; last_run: ExecutionRecord | null }>;
  hidden_state: GraphWarning[];
  resources: Resources;
}

export interface ProjectInfo {
  root: string;
  name: string;
  files: string[];
  badge: string;
  config: { local_only: boolean; max_preview_rows: number };
  sessions: string[];
}

export interface VariableSummary {
  name: string;
  type: string;
  kind: "dataframe" | "series" | "ndarray" | "estimator" | "scalar" | "collection" | "callable" | "object";
  rows?: number;
  columns?: string[];
  dtypes?: Record<string, string>;
  dtype?: string;
  shape?: number[];
  null_counts?: Record<string, number>;
  null_count?: number;
  memory_bytes?: number;
  stats?: Record<string, { min: number | null; max: number | null; mean: number | null }>;
  sample?: { columns?: unknown[]; index?: unknown[]; data?: unknown[][] } | unknown[];
  fitted?: boolean;
  params?: Record<string, string>;
  repr?: string;
  length?: number;
  error?: string;
}

export interface InspectPayload {
  execution_id: string;
  node_id: string;
  status: string;
  started_at: string;
  duration_ms: number;
  source_hash: string;
  before: Record<string, VariableSummary>;
  after: Record<string, VariableSummary>;
}

export interface HistoryEntry {
  execution_id: string;
  status: string;
  started_at: string;
  duration_ms: number;
  peak_memory_mb: number | null;
  rows_in: number | null;
  rows_out: number | null;
  source_hash: string;
}

export interface DiffPayload {
  label_a: string;
  label_b: string;
  rows_a: number | null;
  rows_b: number | null;
  added: string[];
  removed: string[];
  retyped: [string, string, string][];
  row_delta: number | null;
  text: string;
}

export interface LabEvent {
  type: string;
  file: string | null;
  node_id?: string | null;
  ts?: string;
  data: Record<string, unknown>;
}
