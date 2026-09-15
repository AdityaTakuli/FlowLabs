// Mirrors the Flow Spec (flowspec.models), the node catalogue (flowlab_nodes.registry) and the
// Flow Mode payloads of the local API (flowlab_api.flows).

export type PortType = "table" | "table_split" | "model" | "transformer" | "metrics" | "chart" | "report";

export interface NodeSpec {
  id: string;
  type: string;
  label?: string | null;
  params: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface EdgeSpec {
  id: string;
  source: string;
  source_port: string;
  target: string;
  target_port: string;
}

export interface FlowSpec {
  spec_version: "1.0";
  flow_id: string;
  name: string;
  description?: string;
  created_by?: "agent" | "user";
  dataset_bindings: Record<string, string>;
  nodes: NodeSpec[];
  edges: EdgeSpec[];
  meta?: { seed?: number; generated_from_prompt?: string | null; agent_plan?: string | null };
}

export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  "x-widget"?: "column-select" | "column-multiselect" | "select" | "radio-cards" | "dataset-select" | string;
  "x-descriptions"?: Record<string, string>;
  "x-filter"?: { semantic?: string[]; role?: string[] };
}

export interface CatalogueNode {
  type: string;
  title: string;
  category: string;
  description: string;
  inputs: Record<string, { types: PortType[]; required: boolean; description: string }>;
  outputs: Record<string, { types: PortType[]; description: string }>;
  params_schema: JsonSchema;
  flags: Record<string, boolean>;
}

export interface Catalogue {
  catalogue_version: string;
  nodes: CatalogueNode[];
}

export interface CompileIssue {
  node_id: string | null;
  code: string;
  severity: "error" | "warning";
  message: string;
  suggestion: string | null;
}

export interface ColumnSchema {
  name: string;
  dtype: string;
  role: "feature" | "target" | "identifier" | "ignore";
  semantic: string;
  nullable?: boolean;
  null_frac?: number | null;
  cardinality?: number | null;
  categories?: string[] | null;
}

export interface TableSchema {
  columns: ColumnSchema[];
  row_count?: number | null;
  content_hash?: string | null;
}

export interface PortSchema {
  kind: PortType;
  table?: TableSchema;
  partitions?: string[];
  partition_rows?: Record<string, number>;
  model?: { task: string; algorithm: string; target: string; features: string[]; classes?: string[] | null };
}

export interface CompilePayload {
  ok: boolean;
  errors: CompileIssue[];
  warnings: CompileIssue[];
  schemas: Record<string, { inputs: Record<string, PortSchema>; outputs: Record<string, PortSchema> }>;
  order: string[];
  cache_keys: Record<string, string>;
  datasets: Record<string, string>;
}

export interface FlowIndex {
  flows: string[];
  datasets: string[];
}

export interface FlowFile {
  file: string;
  hash: string;
  spec: FlowSpec;
}

export type RunEventType =
  | "run_started"
  | "node_started"
  | "node_progress"
  | "node_log"
  | "node_warning"
  | "node_completed"
  | "node_failed"
  | "artifact_written"
  | "run_completed"
  | "run_failed"
  | "run_cancelled";

export interface RunEvent {
  run_id: string;
  seq: number;
  type: RunEventType;
  ts: string;
  node_id: string | null;
  payload: Record<string, unknown>;
}

export interface NodeRecord {
  node_id: string;
  node_type: string;
  status: "success" | "cached" | "failed" | "skipped";
  cache_key: string;
  cache_hit: boolean;
  duration_ms: number;
  output_hashes: Record<string, string>;
  warnings: { code: string; message: string }[];
  error: { code: string; message: string; traceback?: string } | null;
}

export interface RunManifest {
  run_id: string;
  flow_id: string;
  flow_name: string;
  status: "completed" | "failed" | "cancelled";
  started_at: string;
  finished_at: string;
  nodes: NodeRecord[];
  exports: { node_id: string; path: string; hash: string }[];
  error: { node_id: string; code: string; message: string } | null;
}

export interface RunSummary {
  run_id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  flow_id: string;
  flow_name: string;
  started_at: string;
  finished_at: string | null;
  error: { node_id: string; code: string; message: string } | null;
  nodes: Record<"success" | "cached" | "failed" | "skipped", number> | null;
}

export interface RunDetail {
  run_id: string;
  running: boolean;
  manifest: RunManifest | null;
  events: RunEvent[];
}

export interface FramePreview {
  columns: string[];
  dtypes: string[];
  data: unknown[][];
}

export interface PortOutput {
  kind: PortType;
  missing?: boolean;
  rows?: number;
  preview?: FramePreview;
  partitions?: Record<string, { rows: number; preview: FramePreview }>;
  value?: Record<string, unknown>;
  model?: PortSchema["model"];
  schema?: TableSchema;
}

export interface NodeOutput {
  run_id: string;
  node_id: string;
  node_type: string;
  label: string | null;
  params: Record<string, unknown>;
  record: NodeRecord | null;
  outputs: Record<string, PortOutput>;
}

export interface DatasetProfile {
  file: string;
  schema: TableSchema;
  preview: FramePreview;
}

/** Canvas-side state of one node, from compile results and the live run. */
export type FlowNodeState = "idle" | "queued" | "running" | "success" | "cached" | "warning" | "error" | "skipped";
