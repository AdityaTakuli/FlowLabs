import type {
  DiffPayload,
  GraphPayload,
  HistoryEntry,
  InspectPayload,
  KernelInfo,
  LabEvent,
  FolderListing,
  ProjectInfo,
  RunMode,
  SessionState,
  CodeGraph,
} from "./types";
import type {
  Catalogue,
  CompilePayload,
  DatasetProfile,
  FlowFile,
  FlowIndex,
  FlowSpec,
  NodeOutput,
  RunDetail,
  RunSummary,
} from "./flow/types";
import type { AnalyseRequest, ArchManifest } from "./architecture/types";
import type { LayoutPayload, StructureGraph } from "./structure/types";
import type { AgentPlan, AgentPreview, AgentProposal, AgentStatus, SnippetInfo } from "./agent/AgentPanel";

const TOKEN_KEY = "flowlab-token";

/** The per-launch token arrives as ?token=… once; keep it for this tab and hide it from the URL. */
export function initToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    return fromUrl;
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export class Api {
  constructor(private readonly token: string) {}

  private async request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | undefined>): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) params.set(key, value);
    const suffix = params.toString() ? `?${params}` : "";
    const response = await fetch(`/api${path}${suffix}`, {
      method,
      headers: { "X-FlowLab-Token": this.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const data: unknown = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = (data ?? {}) as { code?: string; message?: string; details?: Record<string, unknown> };
      throw new ApiError(response.status, error.code ?? "HTTP_ERROR", error.message ?? response.statusText, error.details);
    }
    return data as T;
  }

  project = () => this.request<ProjectInfo>("GET", "/project");
  graph = (file: string) => this.request<GraphPayload>("GET", "/graph", undefined, { file });
  preview = (file: string, nodeId: string, source: string) =>
    this.request<{ graph: CodeGraph; parse_error: string | null; parse_error_line: number | null }>("POST", "/graph/preview", {
      file,
      node_id: nodeId,
      source,
    });
  transform = (
    file: string,
    op: string,
    nodeIds: string[],
    params: Record<string, unknown> = {},
    options: { confirm?: boolean; expectedHash?: string } = {},
  ) =>
    this.request<{ message: string; affected: string[]; backup: string; hash: string; graph: CodeGraph }>("POST", "/transform", {
      file,
      op,
      node_ids: nodeIds,
      params,
      confirm: options.confirm ?? false,
      expected_hash: options.expectedHash ?? null,
    });
  revert = (file: string) => this.request<GraphPayload & { restored_from: string }>("POST", "/revert", { file });
  kernel = (action: "start" | "stop" | "restart" | "interrupt", file: string) =>
    this.request<KernelInfo>("POST", `/kernel/${action}`, { file });
  cleanKernel = (file: string) => this.request<{ removed: string[] }>("POST", "/kernel/clean", { file });
  execute = (file: string, nodeId: string | null, mode: RunMode) =>
    this.request<{ plan: string[] }>("POST", "/execute", { file, node_id: nodeId, mode });
  state = (file: string) => this.request<SessionState>("GET", "/state", undefined, { file });
  inspect = (file: string, nodeId: string) => this.request<InspectPayload>("GET", "/inspect", undefined, { file, node_id: nodeId });
  history = (file: string, nodeId: string) => this.request<HistoryEntry[]>("GET", "/history", undefined, { file, node_id: nodeId });
  diff = (file: string, options: { nodeA?: string; nodeB?: string; executionA?: string; executionB?: string; variable?: string }) =>
    this.request<DiffPayload>("GET", "/diff", undefined, {
      file,
      node_a: options.nodeA,
      node_b: options.nodeB,
      execution_a: options.executionA,
      execution_b: options.executionB,
      variable: options.variable || undefined,
    });

  // Flow Mode
  catalogue = () => this.request<Catalogue>("GET", "/catalogue");
  flows = () => this.request<FlowIndex>("GET", "/flows");
  loadFlow = (file: string) => this.request<FlowFile>("GET", "/flow", undefined, { file });
  saveFlow = (file: string, spec: FlowSpec, expectedHash: string | null) =>
    this.request<{ file: string; hash: string }>("PUT", "/flow", { file, spec, expected_hash: expectedHash });
  newFlow = (file: string, name: string, dataset: string | null) =>
    this.request<FlowFile>("POST", "/flow/new", { file, name, dataset });
  compileFlow = (file: string | null, spec: FlowSpec) => this.request<CompilePayload>("POST", "/flow/compile", { file, spec });
  runFlow = (file: string | null, spec: FlowSpec) =>
    this.request<{ run_id: string; order: string[] }>("POST", "/flow/run", { file, spec });
  cancelRun = (runId: string) => this.request<{ run_id: string }>("POST", "/flow/cancel", { run_id: runId });
  runs = (flowId: string) => this.request<RunSummary[]>("GET", "/flow/runs", undefined, { flow_id: flowId });
  runDetail = (runId: string) => this.request<RunDetail>("GET", "/flow/run", undefined, { run_id: runId });
  nodeOutput = (runId: string, nodeId: string) =>
    this.request<NodeOutput>("GET", "/flow/output", undefined, { run_id: runId, node_id: nodeId });
  datasetProfile = (file: string) => this.request<DatasetProfile>("GET", "/dataset/profile", undefined, { file });

  // Structure graphs (any language) and saved node positions
  structure = (file: string) => this.request<StructureGraph>("GET", "/structure", undefined, { file });
  structurePreview = (file: string, nodeId: string, source: string) =>
    this.request<{ ok: boolean; message: string | null; line: number | null }>("POST", "/structure/preview", { file, node_id: nodeId, source });
  structureEdit = (file: string, nodeId: string, source: string, expectedHash: string | null) =>
    this.request<StructureGraph>("POST", "/structure/edit", { file, node_id: nodeId, source, expected_hash: expectedHash });
  structureRevert = (file: string) => this.request<StructureGraph & { restored_from: string }>("POST", "/structure/revert", { file });
  layout = (file: string, view: string) => this.request<LayoutPayload>("GET", "/layout", undefined, { file, view });
  saveLayout = (file: string, view: string, positions: LayoutPayload["positions"]) =>
    this.request<{ saved: number }>("PUT", "/layout", { file, view, positions });

  // Architecture (code segregation)
  architecture = () => this.request<ArchManifest>("GET", "/architecture");
  analyseArchitecture = (body: AnalyseRequest) => this.request<ArchManifest>("POST", "/architecture/analyse", body);
  architectureFeedback = (body: { component_id?: string; unit_id?: string; correction: string }) =>
    this.request<{ stored: boolean; path: string }>("POST", "/architecture/feedback", body);

  // Open folders and files from anywhere on this machine
  fsBrowse = (path: string | null, hidden = false) =>
    this.request<FolderListing>("GET", "/fs/browse", undefined, { path: path ?? undefined, hidden: hidden ? "true" : undefined });
  fsRecent = () => this.request<string[]>("GET", "/fs/recent");
  openProject = (path: string) => this.request<{ root: string; file: string | null }>("POST", "/project/open", { path });
  importFile = (name: string, content: string) => this.request<{ file: string }>("POST", "/files/import", { name, content });

  // Agent panel
  agentStatus = () => this.request<AgentStatus>("GET", "/agent/status");
  agentPreview = (body: { goal: string; dataset: string; k: number }) => this.request<AgentPreview>("POST", "/agent/preview", body);
  agentAsk = (body: { goal: string; dataset: string; k: number; use_cache: boolean; confirm_external: boolean; model?: string }) =>
    this.request<AgentProposal>("POST", "/agent/ask", body);
  agentCompose = (body: { goal: string; dataset: string; plan: AgentPlan }) => this.request<AgentProposal>("POST", "/agent/compose", body);
  agentSave = (body: { proposal_id: string; file: string; overwrite: boolean }) => this.request<{ file: string }>("POST", "/agent/save", body);
  agentSnippets = (q: string, dataset: string | null) =>
    this.request<SnippetInfo[]>("GET", "/agent/snippets", undefined, { q, dataset: dataset ?? undefined });

  /** Raw payload of a rich output (image bytes, HTML, JSON). Not JSON-decoded, so it bypasses request(). */
  outputBlob = async (file: string, executionId: string, index: number): Promise<Blob> => {
    const params = new URLSearchParams({ file, execution_id: executionId, index: String(index) });
    const response = await fetch(`/api/output?${params}`, { headers: { "X-FlowLab-Token": this.token } });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
      throw new ApiError(response.status, error.code ?? "HTTP_ERROR", error.message ?? response.statusText);
    }
    return response.blob();
  };

  /** Reconnecting event stream. Returns a function that closes it. */
  events(onEvent: (event: LabEvent) => void, onStatus: (connected: boolean) => void): () => void {
    let socket: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${window.location.host}/api/ws?token=${encodeURIComponent(this.token)}`);
      socket.onopen = () => {
        retry = 0;
        onStatus(true);
      };
      socket.onmessage = (message) => onEvent(JSON.parse(message.data as string) as LabEvent);
      socket.onclose = () => {
        onStatus(false);
        if (!closed) window.setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      closed = true;
      socket?.close();
    };
  }
}
