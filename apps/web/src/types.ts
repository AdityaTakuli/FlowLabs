// Shapes of the JSON the engine sends and receives (see src/flowlabs/core in the Python package).

export type Task = "classification" | "regression";
export type Kind = "tabular" | "image";
export type ColumnKind = "numeric" | "categorical" | "boolean" | "datetime" | "text";

export interface ParamOption {
  value: string | number | boolean | null;
  label: string;
}

export interface Param {
  name: string;
  label: string;
  type: "int" | "float" | "select" | "bool" | "text" | "columns" | "column" | "parts" | "layers";
  default: unknown;
  min?: number;
  max?: number;
  step?: number;
  log?: boolean;
  help?: string;
  options?: ParamOption[];
  kinds?: ColumnKind[];
  layer_types?: string[];
  activations?: string[];
}

export interface OpDef {
  id: string;
  stage: "clean" | "rows" | "transform";
  group: string;
  label: string;
  description: string;
  params: Param[];
  rows: boolean;
}

export interface AlgoDef {
  id: string;
  label: string;
  tasks: Task[];
  family: string;
  description: string;
  params: Param[];
  needs: string | null;
  available: boolean;
  needs_scaling?: boolean;
  deep: boolean;
  tunable?: boolean;
}

export interface Sample {
  id: string;
  name: string;
  kind: Kind;
  target: string;
  task: Task;
  description: string;
}

export interface Catalogue {
  clean: OpDef[];
  rows: OpDef[];
  transform: OpDef[];
  models: AlgoDef[];
  image_models: AlgoDef[];
  image_prep: Param[];
  samples: Sample[];
  metrics: Record<Task, [string, string][]>;
  metric_labels: Record<string, string>;
}

export interface DatasetMeta {
  id: string;
  name: string;
  kind: Kind;
  file: string;
  rows: number;
  columns: number;
  size: number;
  created: string;
  source: string;
  classes?: Record<string, number>;
  sample?: { target: string; task: Task };
}

export interface ColumnProfile {
  name: string;
  kind: ColumnKind;
  dtype: string;
  missing: number;
  missing_pct: number;
  unique: number;
  sample: unknown[];
  flags: string[];
  stats?: Record<string, number | string>;
  histogram?: { edges: number[]; counts: number[] };
  top?: { value: string; count: number }[];
}

export interface Suggestion {
  id: string;
  level: "info" | "warning" | "error";
  message: string;
  auto: boolean;
  fix?: { stage: "clean" | "rows" | "transform"; op: string; params: Record<string, unknown>; label: string };
}

export interface TargetInfo {
  name: string;
  task: Task;
  missing?: number;
  classes?: { value: string; count: number }[];
  n_classes?: number;
  minority_share?: number | null;
  histogram?: { edges: number[]; counts: number[] };
}

export interface Profile {
  dataset: DatasetMeta;
  kind: Kind;
  rows: number;
  columns?: ColumnProfile[];
  duplicates?: number;
  missing_cells_pct?: number;
  memory_mb?: number;
  target: TargetInfo | null;
  suggested_target: string;
  correlations?: { columns: string[]; matrix: number[][]; with_target?: { column: string; value: number }[] };
  suggestions: Suggestion[];
  sampled?: boolean;
  classes?: { value: string; count: number }[];
  samples?: Record<string, string[]>;
  image_size?: { min: number[]; max: number[] };
}

export interface Step {
  id: string;
  op: string;
  params: Record<string, unknown>;
  enabled: boolean;
  note?: string;
}

export interface ModelEntry {
  id: string;
  algo: string;
  label: string;
  params: Record<string, unknown>;
  tune: "off" | "quick" | "thorough";
  enabled: boolean;
}

export interface Split {
  test_size: number;
  stratify: boolean;
  shuffle: boolean;
  seed: number;
  time_column: string | null;
  cv_folds: number;
}

export interface Project {
  id: string;
  name: string;
  kind: Kind;
  dataset_id: string;
  target: string;
  task: Task;
  created: string;
  updated: string;
  clean: Step[];
  rows: Step[];
  transform: Step[];
  auto_prep: boolean;
  split: Split;
  metric: string;
  models: ModelEntry[];
  image?: Record<string, unknown>;
  notes?: string[];
  last_run?: string | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  kind: Kind;
  dataset_id: string;
  target: string;
  task: Task;
  created: string;
  updated: string;
  last_run?: string | null;
  models: number;
  best?: { label: string; metric: string; metric_label: string; value: number | null; finished: string } | null;
}

export interface Issue {
  level: "error" | "warning" | "info";
  stage: string;
  message: string;
  step: string | null;
}

export interface Preview {
  title: string;
  note: string;
  before_shape: [number, number];
  after_shape: [number, number];
  columns: { name: string; state: "same" | "changed" | "added" | "removed"; kind: ColumnKind }[];
  header: string[];
  rows: unknown[][];
  report?: { column: string; action: string; detail: string }[];
}

export interface EpochPoint {
  epoch: number;
  [metric: string]: number;
}

export interface ModelResult {
  id: string;
  algo: string;
  label: string;
  family: string;
  status: "running" | "done" | "failed" | "cancelled";
  error?: string;
  params: Record<string, unknown>;
  best_params?: Record<string, unknown>;
  trials?: { params: Record<string, unknown>; score: number | null }[];
  metrics?: Record<string, number>;
  train_metrics?: Record<string, number>;
  cv?: { metric: string; folds: number[]; mean: number | null; std: number | null };
  fit_seconds?: number;
  predict_ms_per_row?: number;
  history?: EpochPoint[];
  backend?: string;
  device?: string;
  parameters?: number;
  details?: {
    confusion?: { labels: string[]; matrix: number[][] };
    per_class?: { label: string; precision: number; recall: number; f1: number; support: number }[];
    roc?: [number, number][];
    pr?: [number, number][];
    calibration?: [number, number, number][];
    positive_class?: string;
    scatter?: [number, number][];
    residual_histogram?: { edges: number[]; counts: number[] };
    range?: [number, number];
    mistakes?: { image: string; true: string; predicted: string; confidence: number }[];
  };
  importance?: { native?: { feature: string; value: number }[]; permutation?: { feature: string; value: number; std: number }[] };
  artifact?: string;
  size_kb?: number;
}

export interface SchemaColumn {
  name: string;
  kind: ColumnKind;
  used: boolean;
  min?: number;
  max?: number;
  median?: number;
  integer?: boolean;
  values?: string[];
  example?: unknown;
}

export interface RunResult {
  id: string;
  project_id: string;
  status: "completed" | "failed";
  started: string;
  finished: string;
  seconds: number;
  task: Task;
  target: string;
  metric: string;
  metric_label: string;
  classes: string[];
  best_model_id: string | null;
  kind?: Kind;
  data: {
    rows: number;
    labelled: number;
    train_rows: number;
    test_rows: number;
    val_rows?: number;
    features_in?: number;
    features_out?: number | null;
    auto_prep?: { column: string; action: string; detail: string }[];
    row_steps?: string;
    time_ordered?: boolean;
    train_classes?: number[] | null;
    image_size?: number;
  };
  models: ModelResult[];
  warnings: string[];
  project: Project;
  schema?: { columns: SchemaColumn[] };
}

export interface RunSummary {
  id: string;
  status: string;
  finished: string;
  seconds: number;
  metric: string;
  metric_label: string;
  best_label: string | null;
  best_value: number | null;
  models: number;
}

export interface ExportResult {
  id: string;
  folder: string;
  zip: { name: string; path: string; size: number };
  files: { name: string; path: string; size: number }[];
  notes: string[];
  model_card: string;
}

export interface EngineInfo {
  flowlabs: string;
  python: string;
  executable: string;
  platform: string;
  browser: boolean;
  cpus: number;
  memory: { total_gb: number; available_gb: number } | null;
  packages: Record<string, string | null>;
  gpus: { kind: string; name: string; memory_gb: number | null }[];
  workspace?: string;
}

export interface Interpreter {
  path: string | null;
  source: string;
  label: string;
  version: string | null;
  packages: Record<string, string | null>;
  ready: boolean;
  missing: string[];
}

export interface KernelState {
  status: "starting" | "ready" | "dead" | "stopped";
  python: string | null;
  info: EngineInfo | Record<string, never>;
  error: string | null;
  stderr: string[];
  install?: { running?: boolean; packages?: string[]; code?: number | null };
}

export interface JobEvent {
  type: "job";
  job_id: string;
  kind: "started" | "stage" | "model" | "epoch" | "trial" | "progress" | "log" | "done" | "error" | "cancelled";
  run_id?: string;
  models?: { id: string; label: string }[];
  model_id?: string;
  status?: string;
  index?: number;
  total?: number;
  label?: string;
  metrics?: Record<string, number>;
  epoch?: number;
  epochs?: number;
  fraction?: number;
  trial?: number;
  of?: number;
  score?: number;
  stage?: string;
  message?: string;
  error?: string;
  best_model_id?: string | null;
}

export type EngineEvent =
  | JobEvent
  | { type: "kernel"; status: string; message?: string; info?: EngineInfo }
  | { type: "install"; line?: string; done?: boolean; code?: number }
  | { type: "log"; text: string }
  | { type: "connection"; status: "online" | "offline" }
  | { type: "boot"; stage: string; message: string; progress?: number };
