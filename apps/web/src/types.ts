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

export interface RichOutput {
  index: number;
  kind: "vega" | "image" | "svg" | "html" | "markdown" | "latex" | "json" | "text";
  mime: string;
  plain: string;
  size_bytes: number;
  stored: boolean;
  truncated: boolean;
  width: number | null;
  height: number | null;
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
  execution_count?: number | null;
  stdout: string;
  stderr: string;
  outputs: string[];
  rich_outputs?: RichOutput[];
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
  nodes: Record<
    string,
    { state: NodeState; last_run: ExecutionRecord | null; values?: Record<string, { kind: string; text: string }>; metrics?: MetricPoint[] }
  >;
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
  code_files: string[];
  file_info: Record<string, import("./structure/types").FileKind>;
  languages: import("./structure/types").LanguageSummary[];
}

export interface VariableSummary {
  name: string;
  type: string;
  kind:
    | "dataframe"
    | "series"
    | "ndarray"
    | "tensor"
    | "model"
    | "dataloader"
    | "dataset"
    | "optimizer"
    | "estimator"
    | "scalar"
    | "collection"
    | "response"
    | "callable"
    | "object";
  // deep learning (torch / keras)
  device?: string;
  requires_grad?: boolean;
  numel?: number;
  framework?: "torch" | "keras";
  params_total?: number | null;
  params_trainable?: number;
  layers?: { name: string; type: string; params: number }[];
  training?: boolean;
  batch_size?: number | null;
  batches?: number | null;
  dataset_length?: number | null;
  dataset_type?: string;
  num_workers?: number;
  shuffle?: boolean;
  drop_last?: boolean;
  item?: string | null;
  lr?: number | null;
  groups?: number;
  // fitted sklearn estimators
  n_features?: number;
  classes?: string[];
  importances?: [string, number | null][];
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
  container?: string;
  keys?: string[];
  preview?: string;
  preview_truncated?: boolean;
  // HTTP responses (requests / httpx)
  status?: number | null;
  reason?: string;
  url?: string;
  method?: string;
  content_type?: string;
  elapsed_ms?: number | null;
  headers?: Record<string, string>;
  size_bytes?: number | null;
  body?: string;
  body_format?: "json" | "text";
  body_truncated?: boolean;
  error?: string;
}

export interface FolderListing {
  path: string;
  parent: string | null;
  home: string;
  root: string;
  entries: { name: string; path: string; kind: "dir" | "file"; is_project?: boolean }[];
  truncated: boolean;
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

/** One training step's metrics, parsed from output or sent with flowlab_log(). */
export interface MetricPoint {
  step: number;
  values: Record<string, number>;
  source: "output" | "log";
}

/** What a running block has streamed so far (cleared when it starts again). */
export interface LiveRun {
  progress: number | null;
  metrics: MetricPoint[];
}

/** Python environments that can run kernels (flowlab_lab.interpreters). */
export interface InterpreterInfo {
  path: string;
  source: "project" | "current" | "conda" | "path" | "configured" | "registered";
  label: string;
  version: string | null;
  ipykernel: boolean | null;
  prefix: string | null;
}

export interface InterpretersPayload {
  configured: string | null;
  using: InterpreterInfo | null;
  interpreters: InterpreterInfo[];
  packaged: boolean;
  running: string[];
  restart_required?: string[];
}
