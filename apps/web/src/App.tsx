import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Api, ApiError, initToken } from "./api";
import { formatDuration } from "./layout";
import type { CodeGraph, GraphPayload, LabEvent, ProjectInfo, Resources, RunMode, SessionState } from "./types";
import { GraphCanvas, type HeatMode } from "./components/GraphCanvas";
import { Sidebar, type KernelAction } from "./components/Sidebar";
import { Inspector, type InspectorTab } from "./components/Inspector";
import { LinearView } from "./components/LinearView";
import { Console, type ConsoleLine } from "./components/Console";
import { ConfirmDialog, type ConfirmRequest } from "./components/ConfirmDialog";
import { FlowWorkspace } from "./flow/FlowWorkspace";
import { AgentPanel } from "./agent/AgentPanel";
import { ArchitectureWorkspace } from "./architecture/ArchitectureWorkspace";
import { EdgePanel } from "./components/EdgePanel";
import { FolderPicker } from "./components/FolderPicker";
import type { EdgeTarget } from "./components/GraphCanvas";
import { StructureCanvas, type EditOutcome } from "./structure/StructureCanvas";
import { StructurePanel } from "./structure/StructurePanel";
import { filesForLanguage, workspaceFor, type StructureEdge, type StructureGraph, type Workspace as FileWorkspace } from "./structure/types";

type View = "graph" | "linear" | "split";
interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  text: string;
}

const LAST_FILE_KEY = "flowlab-last-file";
const WORKSPACE_KEY = "flowlab-workspace-overrides";
const LANGUAGE_KEY = "flowlab-language";

function readOverrides(): Record<string, FileWorkspace> {
  try {
    return JSON.parse(storageGet(WORKSPACE_KEY) ?? "{}") as Record<string, FileWorkspace>;
  } catch {
    return {};
  }
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: remembering the file is only a convenience */
  }
}

export function App() {
  const [token] = useState(() => initToken());
  const api = useMemo(() => (token ? new Api(token) : null), [token]);
  if (!api) {
    return (
      <div className="empty-screen">
        <h1>FlowLab</h1>
        <p>This page needs the private link printed by the server.</p>
        <pre>flowlab serve --root path/to/your/project</pre>
        <p className="dim">Open the <code>http://127.0.0.1:8765/?token=…</code> URL it prints.</p>
      </div>
    );
  }
  return <Shell api={api} />;
}

type Mode = "code" | "flow" | "architecture";
const MODE_KEY = "flowlab-mode";

function Shell({ api }: { api: Api }) {
  const [mode, setMode] = useState<Mode>(() => {
    const stored = storageGet(MODE_KEY);
    return stored === "flow" || stored === "architecture" ? stored : "code";
  });
  const [askOpen, setAskOpen] = useState(false);
  const [openRequest, setOpenRequest] = useState<{ file: string; at: number } | null>(null);
  const closeAsk = useCallback(() => setAskOpen(false), []);
  const [pickerOpen, setPickerOpen] = useState(false);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  // Another tab (or this one) opened a different folder: start fresh on the new project.
  useEffect(
    () =>
      api.events(
        (event) => {
          if (event.type === "project_changed") window.location.reload();
        },
        () => undefined,
      ),
    [api],
  );
  const modeSwitch = (
    <>
    <span className="mode-switch" role="group" aria-label="Mode">
      {(["code", "flow", "architecture"] as Mode[]).map((m) => (
        <button
          key={m}
          className={mode === m ? "active" : ""}
          aria-pressed={mode === m}
          onClick={() => {
            setMode(m);
            storageSet(MODE_KEY, m);
          }}
        >
          {m === "code" ? "Code Mode" : m === "flow" ? "Flow Mode" : "Architecture"}
        </button>
      ))}
    </span>
    <button className="open-button" onClick={() => setPickerOpen(true)} title="Open a folder or file from this computer">
      📂 Open
    </button>
    <button className={`ask-button ${askOpen ? "active" : ""}`} onClick={() => setAskOpen((o) => !o)} title="Ask a question about a dataset; FlowLab builds a script from reviewed snippets">
      ✦ Ask
    </button>
    </>
  );
  return (
    <>
      {mode === "architecture" ? (
        <ArchitectureWorkspace
          api={api}
          modeSwitch={modeSwitch}
          onOpenFile={(file) => {
            storageSet(LAST_FILE_KEY, file);
            storageSet(MODE_KEY, "code");
            setMode("code");
            setOpenRequest({ file, at: Date.now() });
          }}
        />
      ) : mode === "flow" ? (
        <FlowWorkspace api={api} modeSwitch={modeSwitch} />
      ) : (
        <Workspace api={api} modeSwitch={modeSwitch} openRequest={openRequest} />
      )}
      {askOpen && (
        <AgentPanel
          api={api}
          onClose={closeAsk}
          onOpenScript={(file) => {
            storageSet(LAST_FILE_KEY, file);
            storageSet(MODE_KEY, "code");
            setMode("code");
            setOpenRequest({ file, at: Date.now() });
            setAskOpen(false);
          }}
        />
      )}
      {pickerOpen && <FolderPicker api={api} onClose={closePicker} />}
    </>
  );
}

function Workspace({ api, modeSwitch, openRequest }: { api: Api; modeSwitch: ReactNode; openRequest: { file: string; at: number } | null }) {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [preview, setPreview] = useState<CodeGraph | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [resources, setResources] = useState<Resources | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedVariable, setSelectedVariable] = useState<string | null>(null);
  const [tab, setTab] = useState<InspectorTab>("code");
  const [view, setView] = useState<View>("graph");
  const [focus, setFocus] = useState(false);
  const [search, setSearch] = useState("");
  const [heat, setHeat] = useState<HeatMode>("off");
  const [showImports, setShowImports] = useState(false);
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [warningsOpen, setWarningsOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [connected, setConnected] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [canRevert, setCanRevert] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [dismissedSecrets, setDismissedSecrets] = useState<Set<string>>(() => new Set());
  const [edgePanel, setEdgePanel] = useState<EdgeTarget | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [structure, setStructure] = useState<StructureGraph | null>(null);
  const [structureEdge, setStructureEdge] = useState<StructureEdge | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [resetSignal, setResetSignal] = useState(0);
  const [layoutMoved, setLayoutMoved] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, FileWorkspace>>(readOverrides);
  const [language, setLanguage] = useState<string>("all");

  const fileRef = useRef<string | null>(null);
  fileRef.current = file;
  const fileKind = file ? project?.file_info?.[file] : undefined;
  const workspace: FileWorkspace = file ? workspaceFor(file, fileKind, overrides[file] ?? null) : "cells";
  const allFiles = project?.code_files ?? project?.files ?? [];
  const lineId = useRef(0);
  const stateTimer = useRef<number | null>(null);

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current.slice(-4), { id, kind, text }]);
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), kind === "error" ? 10000 : 4000);
  }, []);
  const fail = useCallback(
    (error: unknown) => toast("error", error instanceof ApiError ? error.message : String(error)),
    [toast],
  );
  const log = useCallback((line: Omit<ConsoleLine, "id" | "ts">) => {
    const entry: ConsoleLine = { ...line, id: ++lineId.current, ts: new Date().toLocaleTimeString() };
    setConsoleLines((lines) => [...lines.slice(-1999), entry]);
  }, []);

  const loadGraph = useCallback(
    async (target: string) => {
      const next = await api.graph(target);
      if (fileRef.current === target) setPayload(next);
    },
    [api],
  );
  const loadState = useCallback(
    async (target: string) => {
      const next = await api.state(target);
      if (fileRef.current === target) {
        setSession(next);
        setResources(next.resources);
      }
    },
    [api],
  );
  const scheduleState = useCallback(() => {
    if (stateTimer.current !== null) return;
    stateTimer.current = window.setTimeout(() => {
      stateTimer.current = null;
      const target = fileRef.current;
      if (target) loadState(target).catch(() => undefined);
    }, 120);
  }, [loadState]);

  // project + first file
  useEffect(() => {
    api
      .project()
      .then((info) => {
        setProject(info);
        const files = info.code_files ?? info.files;
        const storedLanguage = storageGet(`${LANGUAGE_KEY}:${info.root}`);
        const primary = info.languages?.[0];
        const chosen =
          storedLanguage && (storedLanguage === "all" || info.languages.some((l) => l.name === storedLanguage))
            ? storedLanguage
            : primary && primary.share >= 0.6 && info.languages.length > 1
              ? primary.name
              : "all";
        setLanguage(chosen);
        const remembered = storageGet(LAST_FILE_KEY);
        const initial =
          (remembered && files.includes(remembered) ? remembered : null) ??
          files.find((f) => f.endsWith(".ipynb")) ??
          filesForLanguage(files, info.file_info ?? {}, chosen)[0] ??
          files[0] ??
          null;
        setFile(initial);
      })
      .catch(fail);
  }, [api, fail]);

  useEffect(() => {
    if (!file) return;
    storageSet(LAST_FILE_KEY, file);
    setSelectedId(null);
    setPreview(null);
    setDirty(false);
    setCanRevert(false);
    setPayload(null);
    setSession(null);
    setEdgePanel(null);
    setEditingId(null);
    setStructure(null);
    setStructureEdge(null);
    setCollapsed(new Set());
    if (workspace === "structure") {
      api
        .structure(file)
        .then((next) => {
          if (fileRef.current === file) setStructure(next);
        })
        .catch(fail);
      return;
    }
    loadGraph(file).catch(fail);
    loadState(file).catch(fail);
  }, [api, file, workspace, loadGraph, loadState, fail]);

  // a script saved from the Ask panel
  useEffect(() => {
    if (!openRequest) return;
    api
      .project()
      .then((info) => {
        setProject(info);
        if ((info.code_files ?? info.files).includes(openRequest.file)) setFile(openRequest.file);
      })
      .catch(fail);
  }, [api, openRequest, fail]);

  // live events
  const handler = useRef<(event: LabEvent) => void>(() => undefined);
  handler.current = (event: LabEvent) => {
    if (event.type === "resources") {
      setResources(event.data as unknown as Resources);
      return;
    }
    if (event.type === "file_changed") {
      if (event.data.kind === "added" || event.data.kind === "deleted") api.project().then(setProject).catch(() => undefined);
      if (event.file === file && file && workspace === "structure") {
        if (event.data.origin === "disk") toast("info", `${file} changed on disk; the graph was refreshed`);
        api
          .structure(file)
          .then((next) => {
            if (fileRef.current === file) setStructure(next);
          })
          .catch(() => undefined);
        return;
      }
      if (event.file === file && file) {
        if (dirty && event.data.origin === "disk") toast("info", `${file} changed on disk while you were editing`);
        loadGraph(file).catch(() => undefined);
        scheduleState();
      }
      return;
    }
    if (!file || event.file !== file) return;
    const node = event.node_id ?? null;
    const data = event.data;
    switch (event.type) {
      case "stream":
        log({ kind: data.name === "stderr" ? "stderr" : "stdout", node, text: String(data.text ?? "") });
        break;
      case "display": {
        const rich = (data.output as { kind?: string; mime?: string } | undefined) ?? {};
        if (rich.kind && rich.kind !== "text") log({ kind: "info", node, text: `▣ ${rich.mime} output (open the block's Output tab)` });
        else if (data.text) log({ kind: "stdout", node, text: String(data.text) });
        break;
      }
      case "node_started":
        log({ kind: "info", node, text: `▶ ${node} started` });
        scheduleState();
        break;
      case "node_completed":
        log({ kind: "info", node, text: `✓ ${node} finished in ${formatDuration(data.duration_ms as number)}` });
        scheduleState();
        break;
      case "node_failed":
        log({ kind: "error", node, text: `✕ ${node} ${String(data.status)}` });
        scheduleState();
        break;
      case "run_finished": {
        const error = data.error as { message: string } | null;
        if (error) {
          toast("error", error.message);
          log({ kind: "error", node: null, text: error.message });
        }
        scheduleState();
        break;
      }
      case "kernel_died":
        toast("error", `The kernel died while running ${node}. Restart it from the sidebar.`);
        scheduleState();
        break;
      default:
        if (event.type.startsWith("kernel") || event.type === "run_started") scheduleState();
    }
  };
  useEffect(() => api.events((event) => handler.current(event), setConnected), [api]);

  // actions
  async function run(nodeId: string | null, mode: RunMode) {
    if (!file) return;
    try {
      const { plan } = await api.execute(file, nodeId, mode);
      log({ kind: "info", node: null, text: `run ${mode}${nodeId ? ` ${nodeId}` : ""}: ${plan.join(" → ")}` });
      scheduleState();
    } catch (error) {
      fail(error);
    }
  }

  async function kernel(action: KernelAction) {
    if (!file) return;
    try {
      if (action === "clean") {
        const { removed } = await api.cleanKernel(file);
        toast("success", removed.length ? `Removed ${removed.join(", ")}` : "Nothing to clean");
      } else {
        if (action === "start") toast("info", "Starting a kernel in your environment…");
        await api.kernel(action, file);
        if (action === "restart") log({ kind: "info", node: null, text: "kernel restarted" });
      }
      scheduleState();
    } catch (error) {
      fail(error);
    }
  }

  async function transform(op: string, nodeIds: string[], params: Record<string, unknown> = {}, confirmed = false): Promise<boolean> {
    if (!file || !payload) return false;
    try {
      const result = await api.transform(file, op, nodeIds, params, { confirm: confirmed, expectedHash: payload.hash });
      setPayload((current) => (current && current.file === file ? { ...current, hash: result.hash, graph: result.graph } : current));
      setPreview(null);
      setDirty(false);
      setCanRevert(true);
      if (op !== "edit") toast("success", result.message);
      if (selectedId && !result.graph.nodes.some((n) => n.id === selectedId)) setSelectedId(null);
      scheduleState();
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === "CONFIRM_REQUIRED") {
        setConfirm({
          title: `Delete ${nodeIds[0]}?`,
          message: error.message,
          confirmLabel: "Delete anyway",
          danger: true,
          onConfirm: () => void transform(op, nodeIds, params, true),
        });
        return false;
      }
      if (error instanceof ApiError && error.code === "FILE_CHANGED") {
        toast("error", "The file changed on disk. Reloaded it; check your edit and try again.");
        await loadGraph(file).catch(() => undefined);
        return false;
      }
      if (error instanceof ApiError && error.code === "DEPENDENCY_VIOLATION") {
        const edge = error.details.blocking_edge as { from: string; to: string; variable: string } | undefined;
        if (edge) {
          setSelectedId(edge.to);
          setSearch(edge.variable);
        }
      }
      fail(error);
      return false;
    }
  }

  async function revert() {
    if (!file) return;
    try {
      const result = await api.revert(file);
      setPayload({ file: result.file, hash: result.hash, graph: result.graph, secrets_warning: result.secrets_warning });
      setPreview(null);
      setDirty(false);
      toast("success", `Restored ${file} from ${result.restored_from}`);
      scheduleState();
    } catch (error) {
      if (error instanceof ApiError && error.code === "NO_BACKUP") setCanRevert(false);
      fail(error);
    }
  }

  async function saveUnit(nodeId: string, source: string): Promise<EditOutcome> {
    if (!file || !structure) return { ok: false, message: "Nothing to save" };
    try {
      const next = await api.structureEdit(file, nodeId, source, structure.hash);
      setStructure(next);
      setCanRevert(true);
      toast("success", `Saved ${nodeId}`);
      return { ok: true };
    } catch (error) {
      if (error instanceof ApiError && error.code === "SYNTAX_ERROR") {
        return { ok: false, message: error.message, line: (error.details.line as number | null | undefined) ?? null };
      }
      if (error instanceof ApiError && error.code === "FILE_CHANGED") {
        toast("error", "The file changed on disk. Reloaded it; check your edit and try again.");
        api.structure(file).then(setStructure).catch(() => undefined);
        return { ok: false, message: error.message };
      }
      fail(error);
      return { ok: false, message: error instanceof ApiError ? error.message : String(error) };
    }
  }

  async function revertStructure() {
    if (!file) return;
    try {
      const result = await api.structureRevert(file);
      setStructure(result);
      toast("success", `Restored ${file} from ${result.restored_from}`);
    } catch (error) {
      if (error instanceof ApiError && error.code === "NO_BACKUP") setCanRevert(false);
      fail(error);
    }
  }

  function chooseWorkspace(next: FileWorkspace) {
    if (!file) return;
    const updated = { ...overrides, [file]: next };
    setOverrides(updated);
    storageSet(WORKSPACE_KEY, JSON.stringify(updated));
  }

  function chooseLanguage(next: string) {
    setLanguage(next);
    if (project) storageSet(`${LANGUAGE_KEY}:${project.root}`, next);
  }

  function openFile(next: string) {
    if (dirty && !window.confirm("Discard your unsaved edit?")) return;
    if (!allFiles.includes(next)) {
      toast("info", `${next} is not in this project's file list`);
      return;
    }
    setFile(next);
  }

  function select(nodeId: string | null) {
    if (nodeId !== selectedId && dirty) {
      setPreview(null);
      setDirty(false);
    }
    setSelectedId(nodeId);
    setSelectedVariable(null);
  }

  const graph = preview ?? payload?.graph ?? null;
  const savedGraph = payload?.graph ?? null;
  const warningCount = (graph?.warnings.length ?? 0) + (session?.hidden_state.length ?? 0);
  const kernelStatus = session?.kernel.status ?? "none";
  const kernelReady = kernelStatus === "idle";
  const selectedNode = graph?.nodes.find((n) => n.id === selectedId) ?? null;

  // Notebook-style shortcuts (ignored while typing in an input or the code editor).
  const shortcuts = useRef<(event: KeyboardEvent) => void>(() => undefined);
  shortcuts.current = (event: KeyboardEvent) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.closest(".monaco-editor"))) return;
    if (event.key === "Escape") {
      if (editingId) setEditingId(null);
      else if (edgePanel) setEdgePanel(null);
      else select(null);
      return;
    }
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey || event.shiftKey) || !selectedId || !graph) return;
    event.preventDefault();
    if (!kernelReady) {
      toast("info", kernelStatus === "busy" ? "The kernel is still running" : "Start a kernel in the sidebar first");
      return;
    }
    void run(selectedId, "node");
    if (event.shiftKey) {
      const blocks = graph.nodes.filter((n) => n.kind === "code");
      const next = blocks[blocks.findIndex((n) => n.id === selectedId) + 1];
      if (next) select(next.id);
    }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => shortcuts.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const savedNode = savedGraph?.nodes.find((n) => n.id === selectedId) ?? null;

  if (workspace === "structure" && file) {
    const unit = structure?.nodes.find((n) => n.id === selectedId) ?? null;
    return (
      <div className="app console-closed structure-app">
        <header className="toolbar">
          <div className="brand">
            <span className="logo" aria-hidden>◆</span> FlowLab {modeSwitch}
          </div>
          <div className="file-title" title={fileKind?.reason ?? file}>
            {file}
            {structure && <span className="chip lang-chip">{structure.language_name}</span>}
          </div>
          <input className="search" placeholder="Find function…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search functions and calls" />
          <label className="toggle" title="Dim everything not connected to the selected unit">
            <input type="checkbox" checked={focus} onChange={(e) => setFocus(e.target.checked)} /> Focus
          </label>
          <button
            onClick={() => setCollapsed((current) => (current.size ? new Set() : new Set(structure?.nodes.filter((n) => n.kind === "class").map((n) => n.id) ?? [])))}
            title="Fold every class's methods into the class card, or unfold them"
          >
            {collapsed.size ? "Unfold classes" : "Fold classes"}
          </button>
          <div className="spacer" />
          <button disabled={!layoutMoved} onClick={() => setResetSignal((n) => n + 1)} title="Forget where you dragged cards and use the automatic layout">
            ⟲ Reset layout
          </button>
          <button disabled={!canRevert} onClick={() => void revertStructure()} title="Undo the last change FlowLab made to this file">
            ↶ Undo change
          </button>
          {fileKind?.can_run_cells && (
            <button className="primary" onClick={() => chooseWorkspace("cells")} title="Open this Python file as runnable cells (data analysis / ML)">
              ▶ Open as cells
            </button>
          )}
          <span className={`conn ${connected ? "on" : "off"}`} title={connected ? "Live updates connected" : "Reconnecting…"}>
            ● {connected ? "live" : "offline"}
          </span>
        </header>
        <Sidebar
          project={project}
          file={file}
          files={filesForLanguage(allFiles, project?.file_info ?? {}, language)}
          fileInfo={project?.file_info ?? {}}
          languages={project?.languages ?? []}
          language={language}
          onLanguage={chooseLanguage}
          onOpen={openFile}
          showKernel={false}
          kernel={{ status: "none" }}
          resources={resources}
          hidden={[]}
          onKernel={() => undefined}
        />
        <main className="workspace view-graph">
          {!structure && <div className="placeholder">Reading {file}…</div>}
          {structure && (
            <section className="canvas-pane">
              <StructureCanvas
                api={api}
                graph={structure}
                selectedId={selectedId}
                editingId={editingId}
                search={search}
                focus={focus}
                collapsed={collapsed}
                resetSignal={resetSignal}
                onSelect={(id) => {
                  setSelectedId(id);
                  setStructureEdge(null);
                }}
                onSelectEdge={(edge) => {
                  setStructureEdge(edge);
                  setSelectedId(null);
                }}
                onEdit={setEditingId}
                onToggleCollapse={(id) =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                onOpenFile={openFile}
                onSave={saveUnit}
                onLayoutMoved={setLayoutMoved}
              />
              {structure.problems.length > 0 && (
                <div className="preview-note">
                  ⚠ {structure.problems.length} syntax problem{structure.problems.length === 1 ? "" : "s"} (first on line {structure.problems[0]!.line})
                </div>
              )}
            </section>
          )}
        </main>
        <aside className="inspector">
          {structure ? (
            <StructurePanel
              graph={structure}
              node={unit}
              edge={structureEdge}
              onSelect={(id) => {
                setSelectedId(id);
                setStructureEdge(null);
              }}
              onEdit={(id) => {
                setSelectedId(id);
                setEditingId(id);
              }}
              onOpenFile={openFile}
            />
          ) : (
            <div className="panel dim">…</div>
          )}
        </aside>
        <div className="toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              {t.text}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`app ${consoleOpen ? "console-open" : "console-closed"}`}>
      <header className="toolbar">
        <div className="brand">
          <span className="logo" aria-hidden>◆</span> FlowLab {modeSwitch}
        </div>
        <div className="file-title" title={file ?? ""}>
          {file ?? "no file"}
          {dirty && <span className="unsaved"> · unsaved</span>}
        </div>
        {fileKind?.language === "python" && !file?.endsWith(".ipynb") && (
          <button onClick={() => chooseWorkspace("structure")} title="Show this file as functions, classes and calls instead of runnable cells">
            ⧉ Structure view
          </button>
        )}
        <div className="segmented" role="group" aria-label="View">
          {(["graph", "linear", "split"] as View[]).map((v) => (
            <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
              {v === "graph" ? "Graph" : v === "linear" ? "Linear" : "Split"}
            </button>
          ))}
        </div>
        <input
          className="search"
          placeholder="Find variable…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search by variable name"
        />
        <label className="toggle" title="Dim everything not connected to the selected block">
          <input type="checkbox" checked={focus} onChange={(e) => setFocus(e.target.checked)} /> Focus
        </label>
        <label className="toggle" title="Show edges from import blocks">
          <input type="checkbox" checked={showImports} onChange={(e) => setShowImports(e.target.checked)} /> Imports
        </label>
        <select value={heat} onChange={(e) => setHeat(e.target.value as HeatMode)} aria-label="Heat map">
          <option value="off">Heat map: off</option>
          <option value="time">Heat map: time</option>
          <option value="memory">Heat map: memory</option>
        </select>
        <div className="spacer" />
        <button disabled={!kernelReady} onClick={() => void run(null, "stale")} title="Re-run blocks whose code or inputs changed">
          ↻ Run stale
        </button>
        <button className="primary" disabled={!kernelReady} onClick={() => void run(null, "all")}>
          ▶ Run all
        </button>
        <button disabled={!canRevert} onClick={() => void revert()} title="Undo the last change FlowLab made to this file">
          ↶ Undo change
        </button>
        <span className={`conn ${connected ? "on" : "off"}`} title={connected ? "Live updates connected" : "Reconnecting…"}>
          ● {connected ? "live" : "offline"}
        </span>
      </header>

      <Sidebar
        project={project}
        file={file}
        files={filesForLanguage(allFiles, project?.file_info ?? {}, language)}
        fileInfo={project?.file_info ?? {}}
        languages={project?.languages ?? []}
        language={language}
        onLanguage={chooseLanguage}
        onOpen={openFile}
        showKernel
        kernel={session?.kernel ?? { status: "none" }}
        resources={resources}
        hidden={session?.hidden_state ?? []}
        onKernel={(action) => void kernel(action)}
      />

      <main className={`workspace view-${view}`}>
        {payload?.secrets_warning && file && !dismissedSecrets.has(file) && (
          <div className="banner warning" role="alert">
            <span>🔑 {payload.secrets_warning}</span>
            <button onClick={() => setDismissedSecrets((s) => new Set(s).add(file))}>Dismiss</button>
          </div>
        )}
        {!graph && <div className="placeholder">{file ? "Analysing…" : "No source files in this folder."}</div>}
        {graph && view !== "linear" && file && (
          <section className="canvas-pane">
            <GraphCanvas
              api={api}
              file={file}
              graph={graph}
              session={session}
              selectedId={selectedId}
              focus={focus}
              search={search}
              heat={heat}
              showImports={showImports}
              onSelect={select}
              editingId={editingId}
              onOpenEdge={setEdgePanel}
              onRun={(nodeId, mode) => void run(nodeId, mode)}
              onEdit={setEditingId}
              onSaveSource={(nodeId, source) => transform("edit", [nodeId], { source })}
              onCheckSource={async (nodeId, source) => {
                if (!file) return null;
                const result = await api.preview(file, nodeId, source);
                return result.parse_error ? { message: result.parse_error, line: result.parse_error_line } : null;
              }}
            />
            {edgePanel && file && (
              <EdgePanel
                api={api}
                file={file}
                edge={edgePanel}
                executionId={session?.nodes[edgePanel.from]?.last_run?.execution_id ?? null}
                stale={session?.nodes[edgePanel.from]?.state === "stale"}
                onClose={() => setEdgePanel(null)}
                onSelect={select}
              />
            )}
            <button className={`warnings-button ${warningCount ? "has" : ""}`} onClick={() => setWarningsOpen((o) => !o)}>
              ⚠ {warningCount} warning{warningCount === 1 ? "" : "s"}
            </button>
            {warningsOpen && (
              <div className="warnings-panel">
                {[...(graph.warnings ?? []), ...(session?.hidden_state ?? [])].map((w, i) => (
                  <button key={i} className={`warning-row sev-${w.severity}`} onClick={() => w.node_id && select(w.node_id)}>
                    <span className="code">{w.code}</span>
                    {w.node_id && <span className="node-ref">{w.node_id}</span>}
                    <span>{w.message}</span>
                  </button>
                ))}
                {warningCount === 0 && <div className="dim">No warnings.</div>}
              </div>
            )}
            {preview && <div className="preview-note">Previewing unsaved edit — edges reflect your draft</div>}
          </section>
        )}
        {graph && view !== "graph" && (
          <section className="linear-pane">
            <LinearView
              api={api}
              file={file ?? ""}
              graph={graph}
              session={session}
              selectedId={selectedId}
              kernelReady={kernelReady}
              onSelect={select}
              onRun={(nodeId, mode) => void run(nodeId, mode)}
              onReorder={(moving, anchor, before) => void transform("reorder", [moving], before ? { before: anchor } : { after: anchor })}
            />
          </section>
        )}
      </main>

      <Inspector
        api={api}
        file={file}
        graph={graph}
        node={selectedNode}
        savedNode={savedNode}
        session={session}
        tab={tab}
        onTab={setTab}
        focusVariable={selectedVariable}
        kernelReady={kernelReady}
        onSelect={select}
        onRun={(nodeId, mode) => void run(nodeId, mode)}
        onTransform={transform}
        onPreview={setPreview}
        onDirty={setDirty}
      />

      <Console
        lines={consoleLines}
        open={consoleOpen}
        onToggle={() => setConsoleOpen((o) => !o)}
        onClear={() => setConsoleLines([])}
        onSelect={select}
        badge={project?.badge ?? ""}
      />

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
      {confirm && <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
