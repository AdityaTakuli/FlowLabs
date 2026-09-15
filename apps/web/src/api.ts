import type {
  DiffPayload,
  GraphPayload,
  HistoryEntry,
  InspectPayload,
  KernelInfo,
  LabEvent,
  ProjectInfo,
  RunMode,
  SessionState,
  CodeGraph,
} from "./types";

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
