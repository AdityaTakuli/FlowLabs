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
  type: "int" | "float" | "select" | "bool" | "text" | "columns" | "column" | "parts" | "layers" | "code";
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
  needs?: string[];
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
  /** The histogram again, one per class of the target (2 to 6 classes). */
  by_target?: { label: string; counts: number[] }[];
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
    /** One histogram of predicted probability per true class. */
    separation?: { axis: string; edges: number[]; groups: { label: string; counts: number[] }[] };
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
  /** Why the Python chosen in the Engine menu is not in use (the built-in engine runs instead). */
  notice?: string | null;
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
  | { type: "install"; line?: string; done?: boolean; code?: number; job_id?: string; kind?: string; extra?: string | null; needs?: string[] }
  | { type: "update"; stage: "download" | "installing" | "restarting" | "error"; progress?: number | null; message?: string }
  | { type: "log"; text: string }
  | { type: "connection"; status: "online" | "offline" }
  | { type: "boot"; stage: string; message: string; progress?: number };

/** projects.step_code: the Python for one step or model, and the code step that would replace it. */
export interface StepCode {
  code: string;
  replacement: { op?: string; algo?: string; label?: string; params: Record<string, unknown> };
}

export interface SqlColumn {
  name: string;
  type: string;
}

export interface SqlTable {
  name: string;
  columns: SqlColumn[];
  /** Your datasets only. */
  dataset_id?: string;
  label?: string;
  rows?: number;
}

export interface SqlResult {
  columns: string[];
  types: string[];
  rows: unknown[][];
  /** null when the database did not say how many rows there are in all. */
  total: number | null;
  truncated: boolean;
  elapsed_ms: number;
  message: string | null;
}

export interface UpdateInfo {
  current: string;
  latest?: string;
  available: boolean;
  /** False when GitHub could not be reached, or checking is turned off. */
  checked: boolean;
  enabled: boolean;
  /** deb, macos and windows install themselves; manual and pip show how. */
  method: "deb" | "macos" | "windows" | "manual" | "pip";
  can_install?: boolean;
  /** The release exists but this system's file is still being built. */
  pending?: boolean;
  notes?: string;
  page?: string;
  asset?: { name: string; size: number } | null;
  error?: string;
}

export interface AiStatus {
  provider: string;
  configured: boolean;
  source: "environment" | "saved" | null;
  model: string;
  models: string[];
  available: boolean;
}

// ------------------------------------------------------------------ databases (databases.py)

/** One field of a Connect form, as sources.py describes it. */
export interface SourceField {
  name: string;
  label: string;
  kind: "text" | "password" | "number" | "path" | "select" | "bool" | "textarea";
  required: boolean;
  default: unknown;
  placeholder: string;
  help: string;
  options: [string, string][];
  secret: boolean;
  /** Shown only when the field named first has one of these values. */
  when: [string, unknown[]] | null;
}

/** A kind of source (sql.kinds): PostgreSQL, MySQL, Snowflake, S3... */
export interface SourceKind {
  id: string;
  label: string;
  group: string;
  engine: "sqlalchemy" | "duckdb" | "storage";
  fields: SourceField[];
  packages: string[];
  editor: string;
  about: string;
  docs: string;
  size_mb: number;
  /** Python modules still missing here; installable when the engine can install them. */
  needs: string[];
  installable: boolean;
  browser: boolean;
  /** paramiko, when it is missing and the source can connect through SSH. */
  ssh_needs: string[];
}

/** A saved connection (sql.connections). */
export interface DbConnection {
  id: string;
  kind: string;
  kind_label: string;
  group: string;
  name: string;
  allow_changes: boolean;
  values: Record<string, unknown>;
  secrets_set: string[];
  password_set: boolean;
}

export type DbFlavor = "postgresql" | "mysql" | "sqlite" | string;

export interface DbOverview {
  connection_id: string;
  name: string;
  kind: string;
  flavor: DbFlavor;
  mariadb: boolean;
  server: string;
  read_only: boolean;
  default: string | null;
  /** PostgreSQL: databases hold schemas. MySQL: a database is the schema. */
  schemas: boolean;
  databases: { name: string; system: boolean }[];
}

export interface DbObject {
  name: string;
  kind: string;
  rows?: number | null;
  bytes?: number | null;
  comment?: string | null;
  signature?: string;
  returns?: string | null;
  table?: string;
}

export interface DbObjects {
  database: string;
  schema: string | null;
  tables: DbObject[];
  views: DbObject[];
  functions: DbObject[];
  procedures: DbObject[];
  triggers: DbObject[];
  sequences: DbObject[];
}

export interface DbTableInfo {
  name: string;
  schema: string | null;
  database: string;
  view: boolean;
  comment: string | null;
  columns: { name: string; type: string; nullable: boolean; default: string | null; key: boolean; foreign: boolean; auto: boolean; comment: string | null }[];
  primary_key: string[];
  foreign_keys: { name: string | null; columns: string[]; references: string; referred_columns: string[]; on_delete?: string | null; on_update?: string | null }[];
  indexes: { name: string | null; columns: string[]; unique: boolean }[];
  uniques: { name: string | null; columns: string[] }[];
  checks: { name: string | null; sql: string }[];
  editable: boolean;
  read_only: boolean;
  ddl: string;
}

export interface DbSession {
  session_id: string;
  connection_id: string;
  flavor: DbFlavor;
  server: string;
  read_only: boolean;
  autocommit: boolean;
  in_transaction: boolean;
  backend_id: number | null;
  database: string | null;
  schema: string | null;
}

export interface DbStatementResult {
  statement: number;
  start: number;
  end: number;
  sql: string;
  elapsed_ms: number;
  columns?: string[];
  types?: string[];
  rows?: unknown[][];
  truncated?: boolean;
  message?: string;
  rowcount?: number | null;
}

export interface DbRun {
  results: DbStatementResult[];
  error: { message: string; statement: number; line: number; start: number; end: number; cancelled: boolean } | null;
  elapsed_ms: number;
  session: DbSession;
}

export interface PlanNode {
  label: string;
  detail: string[];
  children: PlanNode[];
  cost?: number;
  rows?: number;
  actual_rows?: number;
  time_ms?: number;
  hint?: string;
}

export interface DbPlan {
  flavor: DbFlavor;
  analyze: boolean;
  tree: PlanNode;
  totals: { planning_ms?: number; execution_ms?: number };
  raw: string;
}

export interface DbRows {
  columns: { name: string; type: string; nullable: boolean; key: boolean; default: boolean }[];
  primary_key: string[];
  rows: unknown[][];
  offset: number;
  total: number;
  exact: boolean;
  editable: boolean;
  read_only: boolean;
}

export interface DbActivity {
  server: { version: string; uptime_s: number; connections: number; max_connections: number; database_bytes?: number; queries?: number };
  sessions: { id: number; user: string | null; database: string | null; app: string | null; client: string | null; state: string | null; waiting: string | null; seconds: number; query: string | null; mine: boolean }[];
  read_only: boolean;
}

export interface DbUser {
  name: string;
  host: string | null;
  login: boolean;
  superuser?: boolean;
  create_db?: boolean;
  create_role?: boolean;
  replication?: boolean;
  connection_limit?: number | null;
  valid_until?: string | null;
  member_of?: string[];
}

export interface DbUsers {
  flavor: DbFlavor;
  current: string;
  users: DbUser[];
  read_only: boolean;
  note?: string;
}

export interface DbGrants {
  /** MySQL: SHOW GRANTS. */
  statements?: string[];
  /** PostgreSQL: what the role may do. */
  databases?: { name: string; connect: boolean; create: boolean; temp: boolean }[];
  schemas?: { name: string; usage: boolean; create: boolean }[];
  tables?: { schema: string; name: string; privileges: string }[];
}

export interface DbExport {
  path: string;
  name: string;
  rows: number;
  bytes: number;
  elapsed_ms: number;
}
