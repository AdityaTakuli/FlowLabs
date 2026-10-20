// The engine runs the Python side of FlowLabs. Three kinds share one interface:
//   browser  Python inside this tab (Pyodide). Nothing to install; classic ML and small networks.
//   local    the desktop app's own server (same origin as the page).
//   remote   `flowlabs engine` on this or another computer: your CPU cores, RAM and GPU.
import type { DatasetMeta, EngineEvent, Interpreter, KernelState, UpdateInfo } from "../types";

export type EngineKind = "browser" | "local" | "remote";

export class EngineError extends Error {
  user: boolean;
  kernel: boolean;
  details?: unknown;
  constructor(message: string, user = true, kernel = false, details?: unknown) {
    super(message);
    this.user = user;
    this.kernel = kernel;
    this.details = details;
  }
}

type Listener = (event: EngineEvent) => void;

export interface KernelControls {
  state(): Promise<KernelState>;
  interpreters(): Promise<Interpreter[]>;
  select(python: string | null): Promise<KernelState>;
  restart(): Promise<KernelState>;
  install(packages: string[]): Promise<void>;
}

export interface Engine {
  kind: EngineKind;
  label: string;
  address?: string;
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  upload(file: File): Promise<DatasetMeta>;
  /** Hand a file to the engine as it is (a .sql file to restore); its path on the engine comes back. */
  uploadFile(file: File, onProgress?: (fraction: number) => void): Promise<{ path: string; name: string; bytes: number }>;
  download(path: string, name: string): Promise<void>;
  subscribe(listener: Listener): () => void;
  /** Stop a training job. The browser engine restarts itself to do this. */
  cancel(jobId: string): Promise<void>;
  kernel?: KernelControls;
  /** The desktop app only: new versions from GitHub. */
  updates?: UpdateControls;
  close(): void;
}

export interface UpdateControls {
  check(force?: boolean): Promise<UpdateInfo>;
  install(): Promise<void>;
  setAutomatic(on: boolean): Promise<void>;
}

interface AndroidBridge {
  saveFile(name: string, base64: string, mime: string): string;
}

/** The FlowLabs Android app injects this bridge: WebViews cannot save blob downloads by themselves. */
export function androidBridge(): AndroidBridge | null {
  return (window as unknown as { FlowLabsAndroid?: AndroidBridge }).FlowLabsAndroid ?? null;
}

async function saveBlob(blob: Blob, name: string) {
  const bridge = androidBridge();
  if (bridge) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const where = bridge.saveFile(name, data, blob.type || "application/octet-stream");
    if (where.startsWith("error")) throw new EngineError(where);
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ------------------------------------------------------------------------------------ remote

export class RemoteEngine implements Engine {
  kind: EngineKind;
  label: string;
  address: string;
  private listeners = new Set<Listener>();
  private seq = 0;
  private polling = false;
  private closed = false;
  kernel: KernelControls;
  updates?: UpdateControls;

  constructor(
    private base: string,
    private token: string,
    kind: "local" | "remote",
  ) {
    this.base = base.replace(/\/+$/, "");
    this.kind = kind;
    this.address = this.base;
    this.label = kind === "local" ? "This computer" : `Engine at ${new URL(this.base).host}`;
    const json = async <T>(path: string, init?: RequestInit) => this.request<T>(path, init);
    this.kernel = {
      state: () => json<KernelState>("/api/kernel"),
      interpreters: () => json<Interpreter[]>("/api/interpreters"),
      select: (python) => json<KernelState>("/api/kernel/select", { method: "POST", body: JSON.stringify({ python }) }),
      restart: () => json<KernelState>("/api/kernel/restart", { method: "POST", body: "{}" }),
      install: async (packages) => {
        await json("/api/kernel/install", { method: "POST", body: JSON.stringify({ packages }) });
      },
    };
    if (kind === "local") {
      this.updates = {
        check: (force = false) => json<UpdateInfo>(`/api/update${force ? "?force=true" : ""}`),
        install: async () => {
          await json("/api/update/install", { method: "POST", body: "{}" });
        },
        setAutomatic: async (on) => {
          await json("/api/update/settings", { method: "POST", body: JSON.stringify({ check: on }) });
        },
      };
    }
  }

  private headers(extra?: HeadersInit): HeadersInit {
    return { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", ...(extra ?? {}) };
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, { ...init, headers: this.headers(init?.headers) });
    } catch {
      throw new EngineError(`Cannot reach the engine at ${this.base}. Is it still running?`, true, true);
    }
    if (response.status === 401) throw new EngineError("The engine refused the token. Reconnect with the link it printed.");
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new EngineError(body.detail ?? body.error ?? `HTTP ${response.status}`);
    return body as T;
  }

  async hello(): Promise<{ version: string; workspace: string; kernel: KernelState }> {
    return this.request("/api/hello");
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const reply = await this.request<{ result?: T; error?: { message: string; user: boolean; kernel?: boolean } }>(
      "/api/rpc",
      { method: "POST", body: JSON.stringify({ method, params }) },
    );
    if (reply.error) throw new EngineError(reply.error.message, reply.error.user, Boolean(reply.error.kernel), reply.error);
    return reply.result as T;
  }

  async upload(file: File): Promise<DatasetMeta> {
    let response: Response;
    try {
      response = await fetch(`${this.base}/api/upload?filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        body: file,
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch {
      throw new EngineError("The upload did not reach the engine.");
    }
    const reply = await response.json();
    if (reply.error) throw new EngineError(reply.error.message ?? String(reply.error), reply.error.user ?? true);
    return reply.result as DatasetMeta;
  }

  uploadFile(file: File, onProgress?: (fraction: number) => void): Promise<{ path: string; name: string; bytes: number }> {
    // XMLHttpRequest, not fetch: it reports upload progress for big dumps
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", `${this.base}/api/upload-file?filename=${encodeURIComponent(file.name)}`);
      request.setRequestHeader("Authorization", `Bearer ${this.token}`);
      request.upload.onprogress = (event) => event.lengthComputable && onProgress?.(event.loaded / event.total);
      request.onerror = () => reject(new EngineError("The file did not reach the engine."));
      request.onload = () => {
        try {
          const reply = JSON.parse(request.responseText);
          if (request.status !== 200 || reply.error) reject(new EngineError(reply.error?.message ?? reply.detail ?? `HTTP ${request.status}`));
          else resolve(reply.result);
        } catch {
          reject(new EngineError(`HTTP ${request.status}`));
        }
      };
      request.send(file);
    });
  }

  async download(path: string, name: string): Promise<void> {
    const url = `${this.base}/api/files/${path.split("/").map(encodeURIComponent).join("/")}?token=${encodeURIComponent(this.token)}`;
    if (this.kind === "local" && !androidBridge()) {
      // same origin: let the browser (or the desktop window) download it directly
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      return;
    }
    const response = await fetch(url);
    if (!response.ok) throw new EngineError(`download failed (HTTP ${response.status})`);
    await saveBlob(await response.blob(), name);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (!this.polling) void this.poll();
    return () => this.listeners.delete(listener);
  }

  private emit(event: EngineEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private async poll() {
    this.polling = true;
    let failures = 0;
    let online = true;
    try {
      const first = await this.request<{ seq: number }>("/api/events?since=0&timeout=0");
      this.seq = first.seq; // start from now; history is not replayed
    } catch {
      /* handled below */
    }
    while (!this.closed) {
      try {
        const batch = await this.request<{ events: (EngineEvent & { seq: number })[]; seq: number }>(
          `/api/events?since=${this.seq}&timeout=20`,
        );
        if (!online) this.emit({ type: "connection", status: "online" });
        online = true;
        failures = 0;
        if (batch.seq < this.seq) this.seq = 0; // the engine restarted
        for (const event of batch.events) {
          this.seq = Math.max(this.seq, event.seq);
          this.emit(event);
        }
        if (batch.events.length === 0) this.seq = Math.max(this.seq, batch.seq);
      } catch {
        failures += 1;
        if (online) this.emit({ type: "connection", status: "offline" });
        online = false;
        await new Promise((r) => setTimeout(r, Math.min(10_000, 500 * 2 ** failures)));
      }
    }
  }

  async cancel(jobId: string): Promise<void> {
    await this.call("train.cancel", { job_id: jobId });
  }

  close() {
    this.closed = true;
    this.listeners.clear();
  }
}

// ----------------------------------------------------------------------------------- browser

type Pending = { resolve: (value: any) => void; reject: (error: EngineError) => void };

export class BrowserEngine implements Engine {
  kind: EngineKind = "browser";
  label = androidBridge() ? "On this phone" : "In this browser";
  private worker!: Worker;
  private pending = new Map<number, Pending>();
  private listeners = new Set<Listener>();
  private ids = 0;
  private booted!: Promise<unknown>;
  lastBoot: EngineEvent | null = null;

  constructor() {
    this.spawn();
  }

  private spawn() {
    this.worker = new Worker(new URL("./pyodide.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (message) => {
      const data = message.data;
      if (data.type === "event") {
        const event = data.event as EngineEvent;
        if (event.type === "boot") this.lastBoot = event;
        for (const listener of this.listeners) listener(event);
        return;
      }
      const waiting = this.pending.get(data.id);
      if (!waiting) return;
      this.pending.delete(data.id);
      if (data.error) waiting.reject(new EngineError(data.error.message, data.error.user ?? false, false, data.error));
      else waiting.resolve(data.result);
    };
    this.worker.onerror = (event) => {
      const error = new EngineError(`The in-browser engine crashed: ${event.message || "unknown error"}`, true, true);
      for (const waiting of this.pending.values()) waiting.reject(error);
      this.pending.clear();
    };
    const coreUrl = new URL("flowlabs-core.zip", document.baseURI).href;
    const local = import.meta.env.VITE_PYODIDE_BASE as string | undefined;
    const pyodideUrl = local ? new URL(local, document.baseURI).href : undefined;
    this.booted = this.send({ type: "init", coreUrl, pyodideUrl });
  }

  ready(): Promise<unknown> {
    return this.booted;
  }

  private send<T>(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.ids;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.send<T>({ type: "call", method, params });
  }

  async upload(file: File): Promise<DatasetMeta> {
    const buffer = await file.arrayBuffer();
    return this.send<DatasetMeta>({ type: "upload", name: file.name, buffer }, [buffer]);
  }

  async uploadFile(): Promise<{ path: string; name: string; bytes: number }> {
    throw new EngineError("The browser cannot reach a database server. Use the desktop app, or run `flowlabs engine`.");
  }

  async download(path: string, name: string): Promise<void> {
    const buffer = await this.send<ArrayBuffer>({ type: "read", path });
    await saveBlob(new Blob([buffer]), name);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async cancel(jobId: string): Promise<void> {
    // Python in the page runs the job synchronously, so stopping means restarting the engine.
    this.worker.terminate();
    for (const waiting of this.pending.values()) waiting.reject(new EngineError("stopped", true));
    this.pending.clear();
    for (const listener of this.listeners) listener({ type: "job", job_id: jobId, kind: "cancelled" });
    this.spawn();
    await this.booted;
  }

  close() {
    this.worker.terminate();
    this.listeners.clear();
  }
}

// ----------------------------------------------------------------------------------- choose

const SAVED = "flowlabs.engine";

export interface SavedEngine {
  url: string;
  token: string;
}

export function savedEngine(): SavedEngine | null {
  try {
    const value = JSON.parse(localStorage.getItem(SAVED) ?? "null");
    return value && typeof value.url === "string" && typeof value.token === "string" ? value : null;
  } catch {
    return null;
  }
}

export function rememberEngine(value: SavedEngine | null) {
  try {
    if (value) localStorage.setItem(SAVED, JSON.stringify(value));
    else localStorage.removeItem(SAVED);
  } catch {
    /* storage blocked */
  }
}

/** Parse "http://host:port/?token=x", "...#engine=...&token=...", or a bare URL + token. */
export function parseEngineLink(text: string, token = ""): SavedEngine | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    if (hash.get("engine")) return { url: hash.get("engine")!, token: hash.get("token") ?? token };
    const found = url.searchParams.get("token") ?? token;
    return { url: `${url.protocol}//${url.host}`, token: found };
  } catch {
    return null;
  }
}

async function servedByEngine(): Promise<boolean> {
  try {
    const response = await fetch(new URL("api/health", document.baseURI).href, { cache: "no-store" });
    const body = await response.json();
    return body.app === "flowlabs";
  } catch {
    return false;
  }
}

/** Pick the engine at start-up: the server that served this page, a link, a saved engine, or the browser. */
export async function chooseEngine(): Promise<{ engine: Engine; notice?: string }> {
  const query = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const queryToken = query.get("token");
  if (queryToken) {
    sessionStorage.setItem("flowlabs.token", queryToken);
    query.delete("token");
    history.replaceState(null, "", `${location.pathname}${query.size ? `?${query}` : ""}${location.hash}`);
  }
  const sessionToken = sessionStorage.getItem("flowlabs.token");
  if (sessionToken && (await servedByEngine())) {
    const base = new URL(".", document.baseURI).href;
    return { engine: new RemoteEngine(base, sessionToken, "local") };
  }
  const linked = hash.get("engine");
  if (linked) {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    const candidate = { url: linked, token: hash.get("token") ?? "" };
    const engine = new RemoteEngine(candidate.url, candidate.token, "remote");
    try {
      await engine.hello();
      rememberEngine(candidate);
      return { engine };
    } catch (error) {
      return { engine: new BrowserEngine(), notice: `Could not connect to ${linked}: ${(error as Error).message}` };
    }
  }
  const saved = savedEngine();
  if (saved) {
    const engine = new RemoteEngine(saved.url, saved.token, "remote");
    try {
      await engine.hello();
      return { engine };
    } catch {
      return { engine: new BrowserEngine(), notice: `The saved engine at ${saved.url} is not running, so FlowLabs is using this browser.` };
    }
  }
  return { engine: new BrowserEngine() };
}
