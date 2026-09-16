import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, type Api } from "../api";
import { ConfirmDialog, type ConfirmRequest } from "../components/ConfirmDialog";
import { formatDuration } from "../layout";
import { FlowCanvas } from "./FlowCanvas";
import {
  EMPTY_HISTORY,
  FLOW_NODE_WIDTH,
  addNode,
  applyRunEvent,
  autoConnect,
  categoryIcon,
  columnsFor,
  connect,
  copySelection,
  indexCatalogue,
  issuesByNode,
  layoutFlow,
  moveNodes,
  outdatedNodes,
  paste,
  record,
  redo,
  removeElements,
  renameNode,
  statesFromManifest,
  undo,
  updateNode,
  type Clipboard,
  type ConnectionRequest,
  type History,
} from "./model";
import { DataGrid, OutputView, SchemaChips } from "./OutputView";
import { SchemaForm } from "./SchemaForm";
import type {
  Catalogue,
  CatalogueNode,
  CompileIssue,
  CompilePayload,
  DatasetProfile,
  FlowIndex,
  FlowNodeState,
  FlowSpec,
  RunEvent,
  RunManifest,
  RunSummary,
} from "./types";
import type { LabEvent } from "../types";
import { Icon } from "../components/Icon";

type InspectorTab = "params" | "output" | "docs";
interface Selection {
  nodes: string[];
  edges: string[];
}
interface LogLine {
  id: number;
  ts: string;
  kind: "info" | "error" | "warning" | "success";
  node: string | null;
  text: string;
}
interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  text: string;
}

const LAST_FLOW_KEY = "flowlab-last-flow";
const NO_SELECTION: Selection = { nodes: [], edges: [] };
const CATEGORY_ORDER = ["source", "profile", "clean", "prep", "transform", "stats", "model", "viz", "sink", "control"];
function storage(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    /* remembering the last flow is only a convenience */
  }
  return null;
}

/** Fill the Flow Spec defaults so edits and dirty-checks compare like with like. */
function normalise(raw: FlowSpec): FlowSpec {
  return {
    ...raw,
    dataset_bindings: raw.dataset_bindings ?? {},
    nodes: (raw.nodes ?? []).map((n) => ({ ...n, label: n.label ?? null, params: n.params ?? {}, position: n.position ?? { x: 0, y: 0 } })),
    edges: (raw.edges ?? []).map((e) => ({ ...e, source_port: e.source_port ?? "out", target_port: e.target_port ?? "in" })),
  };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "flow";
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || Boolean(target.closest(".monaco-editor"));
}

export function FlowWorkspace({ api, modeSwitch }: { api: Api; modeSwitch: ReactNode }) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [flowIndex, setFlowIndex] = useState<FlowIndex>({ flows: [], datasets: [] });
  const [file, setFile] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [spec, setSpec] = useState<FlowSpec | null>(null);
  const [savedJson, setSavedJson] = useState("");
  const [history, setHistory] = useState<History>(EMPTY_HISTORY);
  const [compile, setCompile] = useState<CompilePayload | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  const [tab, setTab] = useState<InspectorTab>("params");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [activeRun, setActiveRun] = useState<{ runId: string; order: string[] } | null>(null);
  const [displayRunId, setDisplayRunId] = useState<string | null>(null);
  const [manifest, setManifest] = useState<RunManifest | null>(null);
  const [states, setStates] = useState<Record<string, FlowNodeState>>({});
  const [runningNode, setRunningNode] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [panel, setPanel] = useState<"log" | "runs" | null>("log");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [connected, setConnected] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [quickAdd, setQuickAdd] = useState(false);
  const [paletteFilter, setPaletteFilter] = useState("");
  const [dataset, setDataset] = useState<string | null>(null);
  const [outputKey, setOutputKey] = useState(0);
  const [fitKey, setFitKey] = useState(0);
  const [needsLayout, setNeedsLayout] = useState(false);

  const index = useMemo(() => (catalogue ? indexCatalogue(catalogue) : new Map<string, CatalogueNode>()), [catalogue]);
  const dirty = spec !== null && JSON.stringify(spec) !== savedJson;
  const clipboard = useRef<Clipboard | null>(null);
  const lastEdit = useRef<{ key: string; at: number } | null>(null);
  const lineId = useRef(0);
  const compileSeq = useRef(0);
  // Run events can arrive before /flow/run answers with the run id: buffer them, then replay.
  const activeRunRef = useRef<{ runId: string; order: string[] } | null>(null);
  const pendingEvents = useRef<LabEvent[] | null>(null);

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current.slice(-4), { id, kind, text }]);
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), kind === "error" ? 9000 : 4000);
  }, []);
  const fail = useCallback((error: unknown) => toast("error", error instanceof ApiError ? error.message : String(error)), [toast]);
  const addLog = useCallback((line: Omit<LogLine, "id" | "ts">) => {
    setLog((lines) => [...lines.slice(-1999), { ...line, id: ++lineId.current, ts: new Date().toLocaleTimeString() }]);
  }, []);

  // ------------------------------------------------------------------ loading
  const refreshIndex = useCallback(() => api.flows().then(setFlowIndex), [api]);

  useEffect(() => {
    api.catalogue().then(setCatalogue).catch(fail);
    api
      .flows()
      .then((next) => {
        setFlowIndex(next);
        const remembered = storage(LAST_FLOW_KEY);
        setFile((remembered && next.flows.includes(remembered) ? remembered : null) ?? next.flows[0] ?? null);
      })
      .catch(fail);
  }, [api, fail]);

  const showRun = useCallback(
    async (runId: string | null) => {
      setDisplayRunId(runId);
      if (!runId) {
        setManifest(null);
        setStates({});
        return;
      }
      const detail = await api.runDetail(runId);
      setManifest(detail.manifest);
      if (detail.manifest) setStates(statesFromManifest(detail.manifest));
      setOutputKey((k) => k + 1);
    },
    [api],
  );

  const loadRuns = useCallback(
    async (flowId: string, show: "latest" | "keep") => {
      const list = await api.runs(flowId);
      setRuns(list);
      if (show === "latest") await showRun(list.find((r) => r.status !== "running")?.run_id ?? null);
    },
    [api, showRun],
  );

  useEffect(() => {
    if (!file) {
      setSpec(null);
      return;
    }
    storage(LAST_FLOW_KEY, file);
    let live = true;
    api
      .loadFlow(file)
      .then(async (loaded) => {
        if (!live) return;
        const next = normalise(loaded.spec);
        // Hand-written or agent-made flows often omit positions; lay those out instead of stacking.
        const overlapping = new Set(next.nodes.map((n) => `${n.position.x},${n.position.y}`)).size < next.nodes.length;
        setSpec(next);
        setSavedJson(JSON.stringify(next));
        setNeedsLayout(overlapping);
        setLog([]);
        setHash(loaded.hash);
        setHistory(EMPTY_HISTORY);
        setSelection(NO_SELECTION);
        setCompile(null);
        setDataset(null);
        setFitKey((k) => k + 1);
        if (next.flow_id) await loadRuns(next.flow_id, "latest");
      })
      .catch(fail);
    return () => {
      live = false;
    };
  }, [api, file, fail, loadRuns]);

  useEffect(() => {
    if (!needsLayout || !spec || !catalogue) return;
    const laid = layoutFlow(spec, index);
    setSpec(laid);
    setSavedJson(JSON.stringify(laid)); // positions are cosmetic: don't flag the file as unsaved
    setNeedsLayout(false);
    setFitKey((k) => k + 1);
  }, [needsLayout, spec, catalogue, index]);

  // debounced compile-on-edit (PRD 11.2)
  const specJson = spec ? JSON.stringify(spec) : "";
  useEffect(() => {
    if (!spec) return;
    const seq = ++compileSeq.current;
    setCompiling(true);
    const timer = window.setTimeout(() => {
      api
        .compileFlow(file, spec)
        .then((result) => {
          if (seq === compileSeq.current) setCompile(result);
        })
        .catch((error) => seq === compileSeq.current && fail(error))
        .finally(() => seq === compileSeq.current && setCompiling(false));
    }, 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, file, specJson]);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  // ------------------------------------------------------------------ editing
  /** Apply an edit. Edits sharing a `coalesce` key within a second form one undo step (typing). */
  const apply = useCallback(
    (next: FlowSpec, coalesce?: string) => {
      if (!spec) return;
      const now = Date.now();
      const merge = coalesce && lastEdit.current?.key === coalesce && now - lastEdit.current.at < 1000;
      if (!merge) setHistory((h) => record(h, spec));
      lastEdit.current = coalesce ? { key: coalesce, at: now } : null;
      setSpec(next);
    },
    [spec],
  );

  const doUndo = useCallback(() => {
    if (!spec) return;
    const result = undo(history, spec);
    if (!result) return;
    setHistory(result.history);
    setSpec(result.spec);
    lastEdit.current = null;
  }, [history, spec]);

  const doRedo = useCallback(() => {
    if (!spec) return;
    const result = redo(history, spec);
    if (!result) return;
    setHistory(result.history);
    setSpec(result.spec);
    lastEdit.current = null;
  }, [history, spec]);

  const nextPosition = useCallback((): { x: number; y: number } => {
    if (!spec || spec.nodes.length === 0) return { x: 40, y: 160 };
    const anchor = spec.nodes.find((n) => n.id === selection.nodes[selection.nodes.length - 1]);
    if (anchor) return { x: anchor.position.x + FLOW_NODE_WIDTH + 80, y: anchor.position.y };
    const rightmost = spec.nodes.reduce((a, b) => (b.position.x > a.position.x ? b : a));
    return { x: rightmost.position.x + FLOW_NODE_WIDTH + 80, y: rightmost.position.y };
  }, [spec, selection]);

  const insertNode = useCallback(
    (type: string, position?: { x: number; y: number }) => {
      const entry = index.get(type);
      if (!spec || !entry) return;
      const added = addNode(spec, entry, position ?? nextPosition());
      const wired = autoConnect(added.spec, index, added.nodeId);
      apply(wired);
      setSelection({ nodes: [added.nodeId], edges: [] });
      setDataset(null);
      setTab("params");
      const edge = wired.edges.length > added.spec.edges.length ? wired.edges[wired.edges.length - 1] : undefined;
      if (edge) {
        addLog({ kind: "info", node: added.nodeId, text: `added ${entry.title}, connected from ${edge.source}.${edge.source_port}` });
      }
    },
    [spec, index, apply, nextPosition, addLog],
  );

  const deleteSelection = useCallback(() => {
    if (!spec || (!selection.nodes.length && !selection.edges.length)) return;
    apply(removeElements(spec, new Set(selection.nodes), new Set(selection.edges)));
    setSelection(NO_SELECTION);
  }, [spec, selection, apply]);

  const copy = useCallback(() => {
    if (!spec) return;
    clipboard.current = copySelection(spec, new Set(selection.nodes));
    if (clipboard.current) toast("info", `Copied ${clipboard.current.nodes.length} node(s)`);
  }, [spec, selection, toast]);

  const pasteClipboard = useCallback(() => {
    if (!spec || !clipboard.current) return;
    const result = paste(spec, clipboard.current);
    apply(result.spec);
    setSelection({ nodes: result.nodeIds, edges: [] });
  }, [spec, apply]);

  const onConnect = useCallback(
    (request: ConnectionRequest) => {
      if (spec) apply(connect(spec, request));
    },
    [spec, apply],
  );

  // ------------------------------------------------------------------ save / create
  const save = useCallback(
    async (force = false) => {
      if (!spec || !file) return;
      try {
        const result = await api.saveFlow(file, spec, force ? null : hash);
        setHash(result.hash);
        setSavedJson(JSON.stringify(spec));
        toast("success", `Saved ${result.file}`);
        refreshIndex().catch(() => undefined);
      } catch (error) {
        if (error instanceof ApiError && error.code === "FILE_CHANGED") {
          setConfirm({
            title: "File changed on disk",
            message: `${file} was modified outside FlowLab since you opened it. Overwrite it with the canvas version?`,
            confirmLabel: "Overwrite",
            danger: true,
            onConfirm: () => void save(true),
          });
          return;
        }
        fail(error);
      }
    },
    [api, spec, file, hash, toast, fail, refreshIndex],
  );

  const openFlow = useCallback(
    (next: string) => {
      if (next === file) return;
      if (dirty && !window.confirm("Discard unsaved changes to this flow?")) return;
      setFile(next);
    },
    [file, dirty],
  );

  async function createFlow(name: string, path: string, datasetFile: string | null) {
    try {
      const created = await api.newFlow(path, name, datasetFile);
      await refreshIndex();
      setFile(created.file);
      toast("success", `Created ${created.file}`);
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  }

  // ------------------------------------------------------------------ running
  const run = useCallback(async () => {
    if (!spec) return;
    if (compile && !compile.ok) {
      const first = compile.errors[0];
      if (first?.node_id) setSelection({ nodes: [first.node_id], edges: [] });
      toast("error", `Fix ${compile.errors.length} compile error(s) before running: ${first?.message ?? ""}`);
      return;
    }
    pendingEvents.current = [];
    try {
      const started = await api.runFlow(file, spec);
      activeRunRef.current = { runId: started.run_id, order: started.order };
      setActiveRun(activeRunRef.current);
      setDisplayRunId(started.run_id);
      setManifest(null);
      setStates(Object.fromEntries(started.order.map((id) => [id, "queued" as FlowNodeState])));
      setPanel((p) => p ?? "log");
      addLog({ kind: "info", node: null, text: `run ${started.run_id}: ${started.order.join(" → ")}` });
      loadRuns(spec.flow_id, "keep").catch(() => undefined);
      const buffered = pendingEvents.current ?? [];
      pendingEvents.current = null;
      for (const event of buffered) handler.current(event);
    } catch (error) {
      pendingEvents.current = null;
      if (error instanceof ApiError && error.code === "COMPILE_FAILED") {
        const errors = (error.details.errors as CompileIssue[] | undefined) ?? [];
        if (errors[0]?.node_id) setSelection({ nodes: [errors[0].node_id], edges: [] });
      }
      fail(error);
    }
  }, [api, spec, file, compile, toast, fail, addLog, loadRuns]);

  const cancel = useCallback(async () => {
    if (!activeRun) return;
    try {
      await api.cancelRun(activeRun.runId);
      addLog({ kind: "warning", node: null, text: "cancelling after the current node finishes…" });
    } catch (error) {
      fail(error);
    }
  }, [api, activeRun, addLog, fail]);

  const handler = useRef<(event: LabEvent) => void>(() => undefined);
  handler.current = (event: LabEvent) => {
    if ((event.type === "flow_event" || event.type === "flow_run_finished") && pendingEvents.current) {
      pendingEvents.current.push(event);
      return;
    }
    const activeRun = activeRunRef.current;
    if (event.type === "flow_event") {
      const runEvent = event.data as unknown as RunEvent;
      if (!activeRun || runEvent.run_id !== activeRun.runId) return;
      setStates((current) => applyRunEvent(current, runEvent, activeRun.order));
      const node = runEvent.node_id;
      const payload = runEvent.payload;
      switch (runEvent.type) {
        case "node_started":
          setRunningNode(node);
          addLog({ kind: "info", node, text: `${String(payload.node_type ?? "")} started` });
          break;
        case "node_completed":
          setRunningNode(null);
          addLog({
            kind: "success",
            node,
            text: payload.cache_hit ? "from cache" : `done in ${formatDuration(Number(payload.duration_ms ?? 0))}`,
          });
          break;
        case "node_warning":
          addLog({ kind: "warning", node, text: `${String(payload.code)}: ${String(payload.message)}` });
          break;
        case "node_log":
          addLog({ kind: "info", node, text: String(payload.message ?? "") });
          break;
        case "node_failed":
          setRunningNode(null);
          addLog({ kind: "error", node, text: `${String(payload.code)}: ${String(payload.message)}` });
          if (node) setSelection({ nodes: [node], edges: [] });
          break;
        default:
          break;
      }
      return;
    }
    if (event.type === "flow_run_finished") {
      const data = event.data as { run_id: string; status: string; error: { message: string } | null };
      if (!activeRun || data.run_id !== activeRun.runId) {
        if (spec) loadRuns(spec.flow_id, "keep").catch(() => undefined);
        return;
      }
      activeRunRef.current = null;
      setActiveRun(null);
      setRunningNode(null);
      const kind = data.status === "completed" ? "success" : data.status === "cancelled" ? "info" : "error";
      addLog({ kind: kind === "info" ? "warning" : kind, node: null, text: `run ${data.status}${data.error ? `: ${data.error.message}` : ""}` });
      toast(kind, data.status === "completed" ? "Run completed" : `Run ${data.status}${data.error ? `: ${data.error.message}` : ""}`);
      showRun(data.run_id).catch(() => undefined);
      if (spec) loadRuns(spec.flow_id, "keep").catch(() => undefined);
    }
  };
  useEffect(() => api.events((event) => handler.current(event), setConnected), [api]);

  // ------------------------------------------------------------------ keyboard (PRD 11.2)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === "s") {
        event.preventDefault();
        void save();
        return;
      }
      if (mod && key === "enter") {
        event.preventDefault();
        void run();
        return;
      }
      if (event.key === "Escape") {
        setQuickAdd(false);
        return;
      }
      if (isEditable(event.target) || confirm) return;
      if (mod && key === "z" && !event.shiftKey) {
        event.preventDefault();
        doUndo();
      } else if (mod && ((key === "z" && event.shiftKey) || key === "y")) {
        event.preventDefault();
        doRedo();
      } else if (mod && key === "c") {
        copy();
      } else if (mod && key === "v") {
        pasteClipboard();
      } else if (mod && key === "d") {
        event.preventDefault();
        copy();
        pasteClipboard();
      } else if (mod && key === "k") {
        event.preventDefault();
        setQuickAdd(true);
      } else if (event.key === "Tab" && !mod) {
        event.preventDefault();
        setQuickAdd(true);
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, run, doUndo, doRedo, copy, pasteClipboard, deleteSelection, confirm]);

  // ------------------------------------------------------------------ derived
  const issues = useMemo(() => issuesByNode(compile), [compile]);
  const outdated = useMemo(() => outdatedNodes(compile, manifest), [compile, manifest]);
  const selectedNode = selection.nodes.length === 1 && spec ? (spec.nodes.find((n) => n.id === selection.nodes[0]) ?? null) : null;
  const errorCount = compile?.errors.length ?? 0;
  const warningCount = compile?.warnings.length ?? 0;
  const displayedRun = runs.find((r) => r.run_id === displayRunId) ?? null;
  const latestFinished = runs.find((r) => r.status !== "running")?.run_id ?? null;

  const focusFirstIssue = () => {
    const first = compile?.errors[0] ?? compile?.warnings[0];
    if (first?.node_id) {
      setSelection({ nodes: [first.node_id], edges: [] });
      setTab("params");
    } else {
      setSelection(NO_SELECTION);
    }
    setDataset(null);
  };

  return (
    <div className={`app flow-app ${panel ? "console-open" : "console-closed"}`}>
      <header className="toolbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            <Icon name="logo" size={14} />
          </span>{" "}
          FlowLab {modeSwitch}
        </div>
        <div className="file-title" title={file ?? ""}>
          {spec?.name ?? file ?? "no flow"}
          {dirty && <span className="unsaved"> · unsaved</span>}
        </div>
        <button disabled={!dirty} onClick={() => void save()} title="Save (Ctrl/⌘+S)">
          Save
        </button>
        <div className="segmented" role="group" aria-label="History">
          <button disabled={!history.past.length} onClick={doUndo} title="Undo (Ctrl/⌘+Z)" aria-label="Undo">
            <Icon name="undo" size={12} />
          </button>
          <button disabled={!history.future.length} onClick={doRedo} title="Redo (Ctrl/⌘+Shift+Z)" aria-label="Redo">
            <Icon name="redo" size={12} />
          </button>
        </div>
        <button disabled={!spec?.nodes.length} onClick={() => spec && (apply(layoutFlow(spec, index)), setFitKey((k) => k + 1))} title="Arrange nodes left to right">
          <Icon name="graph" /> Auto-layout
        </button>
        <button onClick={() => setQuickAdd(true)} disabled={!spec} title="Add a node (Tab or Ctrl/⌘+K)">
          ＋ Add node
        </button>
        <button className={`compile-pill ${compiling ? "busy" : !compile ? "" : errorCount ? "bad" : warningCount ? "warn" : "good"}`} onClick={focusFirstIssue} disabled={!compile}>
          {compiling && !compile
            ? "Compiling…"
            : !compile
              ? "—"
              : errorCount
                ? `${errorCount} error${errorCount === 1 ? "" : "s"}`
                : `Compiles · ${compile.order.length} steps${warningCount ? ` · ${warningCount} warning${warningCount === 1 ? "" : "s"}` : ""}`}
        </button>
        <div className="spacer" />
        {activeRun ? (
          <button className="danger" onClick={() => void cancel()} title="Stop after the current node">
            <Icon name="stop" /> Cancel run
          </button>
        ) : (
          <button className="primary" disabled={!spec || !compile?.ok} onClick={() => void run()} title="Run the flow (Ctrl/⌘+Enter)">
            <Icon name="play" /> Run flow
          </button>
        )}
        <span className={`conn ${connected ? "on" : "off"}`} title={connected ? "Live updates connected" : "Reconnecting…"}>
          <Icon name="dot" size={10} /> {connected ? "live" : "offline"}
        </span>
      </header>

      <FlowSidebar
        flowIndex={flowIndex}
        file={file}
        onOpen={openFlow}
        onCreate={createFlow}
        dataset={dataset}
        onDataset={(d) => {
          setDataset(d);
          setSelection(NO_SELECTION);
        }}
        catalogue={catalogue}
        filter={paletteFilter}
        onFilter={setPaletteFilter}
        onAdd={(type) => insertNode(type)}
        canAdd={Boolean(spec)}
      />

      <main className="workspace">
        {!spec && (
          <div className="placeholder">
            {flowIndex.flows.length ? "Loading flow…" : "No flows in this folder yet. Create one from the sidebar."}
          </div>
        )}
        {spec && catalogue && (
          <section className="canvas-pane">
            <FlowCanvas
              spec={spec}
              index={index}
              states={states}
              issues={issues}
              outdated={outdated}
              selection={selection}
              runningNode={runningNode}
              fitKey={`${file}:${fitKey}`}
              onSelection={(next) => {
                setSelection(next);
                if (next.nodes.length) setDataset(null);
              }}
              onMove={(positions) => apply(moveNodes(spec, positions))}
              onConnect={onConnect}
              onRefuse={(reason) => toast("error", reason)}
              onDropNode={(type, position) => insertNode(type, position)}
            />
            {spec.nodes.length === 0 && (
              <div className="canvas-hint">
                Drag a node from the palette, or press <kbd>Tab</kbd> to add one.
                {Object.keys(spec.dataset_bindings).length === 0 && " Start by binding a dataset in the flow settings (click the empty canvas)."}
              </div>
            )}
            {displayRunId && displayRunId !== latestFinished && !activeRun && (
              <div className="preview-note">
                Viewing run {displayRunId.slice(-12)} ·{" "}
                <button className="link-button" onClick={() => void showRun(latestFinished)}>
                  show latest
                </button>
              </div>
            )}
          </section>
        )}
        {quickAdd && catalogue && (
          <QuickAdd
            catalogue={catalogue}
            onPick={(type) => {
              setQuickAdd(false);
              insertNode(type);
            }}
            onClose={() => setQuickAdd(false)}
          />
        )}
      </main>

      <aside className="inspector">
        {dataset ? (
          <DatasetPanel
            api={api}
            file={dataset}
            spec={spec}
            onBind={(ref) => {
              if (!spec) return;
              apply({ ...spec, dataset_bindings: { ...spec.dataset_bindings, [ref]: dataset } });
              toast("success", `Bound ${dataset} as '${ref}'`);
            }}
          />
        ) : selectedNode && spec ? (
          <NodeInspector
            key={selectedNode.id}
            api={api}
            spec={spec}
            node={selectedNode}
            entry={index.get(selectedNode.type)}
            compile={compile}
            issues={issues.get(selectedNode.id) ?? []}
            state={states[selectedNode.id] ?? "idle"}
            outdated={outdated.has(selectedNode.id)}
            tab={tab}
            onTab={setTab}
            runId={displayRunId && manifest?.nodes.some((n) => n.node_id === selectedNode.id) ? displayRunId : null}
            running={activeRun !== null}
            outputKey={`${outputKey}`}
            onApply={apply}
            onRename={(to) => {
              const renamed = renameNode(spec, selectedNode.id, to);
              if (!renamed) {
                toast("error", `'${to}' is not a valid, unused node id (letters, digits, _ and -)`);
                return;
              }
              apply(renamed);
              setSelection({ nodes: [to], edges: [] });
            }}
            onDelete={deleteSelection}
          />
        ) : spec ? (
          <FlowSettings
            spec={spec}
            compile={compile}
            datasets={flowIndex.datasets}
            selection={selection}
            issues={issues.get("") ?? []}
            onApply={apply}
            onSelectNode={(id) => setSelection({ nodes: [id], edges: [] })}
            onDelete={deleteSelection}
            onCopy={copy}
          />
        ) : (
          <div className="panel dim">Open or create a flow.</div>
        )}
      </aside>

      <section className="console run-panel">
        <div className="console-head">
          <div className="tabs">
            <button className={panel === "log" ? "active" : ""} onClick={() => setPanel((p) => (p === "log" ? null : "log"))}>
              Run log
            </button>
            <button className={panel === "runs" ? "active" : ""} onClick={() => setPanel((p) => (p === "runs" ? null : "runs"))}>
              Runs {runs.length ? `(${runs.length})` : ""}
            </button>
          </div>
          {activeRun && <span className="small status-busy"><Icon name="dot" size={10} /> running {activeRun.runId.slice(-12)}</span>}
          {displayedRun && !activeRun && (
            <span className={`small run-status-${displayedRun.status}`}>
              showing {displayedRun.status} run from {new Date(displayedRun.started_at).toLocaleString()}
            </span>
          )}
          <div className="spacer" />
          {panel === "log" && (
            <button className="link-button" onClick={() => setLog([])}>
              clear
            </button>
          )}
          <button className="link-button" onClick={() => setPanel((p) => (p ? null : "log"))} aria-label={panel ? "Collapse panel" : "Expand panel"}>
            <Icon name={panel ? "chevronDown" : "chevronRight"} size={11} />
          </button>
        </div>
        {panel === "log" && (
          <div className="console-body">
            {log.map((line) => (
              <div key={line.id} className={`console-line ${line.kind}`}>
                <span className="ts">{line.ts}</span>
                {line.node ? (
                  <button className="node-ref" onClick={() => setSelection({ nodes: [line.node as string], edges: [] })}>
                    {line.node}
                  </button>
                ) : (
                  <span className="node-ref empty" />
                )}
                <span className="text">{line.text}</span>
              </div>
            ))}
            {log.length === 0 && <div className="dim">Run events appear here.</div>}
          </div>
        )}
        {panel === "runs" && (
          <div className="console-body runs-list">
            {runs.map((r) => (
              <button key={r.run_id} className={`run-row ${r.run_id === displayRunId ? "active" : ""}`} onClick={() => r.status !== "running" && void showRun(r.run_id)}>
                <span className={`state-pill flow-state-${r.status === "completed" ? "success" : r.status === "failed" ? "error" : r.status === "running" ? "running" : "skipped"}`}>{r.status}</span>
                <span className="mono">{r.run_id.slice(4)}</span>
                <span className="dim">{new Date(r.started_at).toLocaleString()}</span>
                {r.nodes && (
                  <span className="dim">
                    {r.nodes.success} ran · {r.nodes.cached} cached{r.nodes.failed ? ` · ${r.nodes.failed} failed` : ""}
                    {r.nodes.skipped ? ` · ${r.nodes.skipped} skipped` : ""}
                  </span>
                )}
                {r.error && <span className="error-text">{r.error.message}</span>}
              </button>
            ))}
            {runs.length === 0 && <div className="dim">No runs of this flow yet.</div>}
          </div>
        )}
      </section>

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

// ---------------------------------------------------------------------- sidebar
function FlowSidebar(props: {
  flowIndex: FlowIndex;
  file: string | null;
  onOpen: (file: string) => void;
  onCreate: (name: string, path: string, dataset: string | null) => Promise<boolean>;
  dataset: string | null;
  onDataset: (file: string) => void;
  catalogue: Catalogue | null;
  filter: string;
  onFilter: (text: string) => void;
  onAdd: (type: string) => void;
  canAdd: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [datasetChoice, setDatasetChoice] = useState("");
  const groups = useMemo(() => {
    const needle = props.filter.trim().toLowerCase();
    const grouped = new Map<string, CatalogueNode[]>();
    for (const node of props.catalogue?.nodes ?? []) {
      if (needle && !`${node.title} ${node.type} ${node.description}`.toLowerCase().includes(needle)) continue;
      grouped.set(node.category, [...(grouped.get(node.category) ?? []), node]);
    }
    const rank = (c: string) => (CATEGORY_ORDER.indexOf(c) === -1 ? 99 : CATEGORY_ORDER.indexOf(c));
    return [...grouped.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  }, [props.catalogue, props.filter]);

  return (
    <aside className="sidebar flow-sidebar">
      <section>
        <div className="section-head">
          <h2>Flows</h2>
          <button className="link-button" onClick={() => setCreating((c) => !c)}>
            {creating ? "cancel" : "＋ new"}
          </button>
        </div>
        {creating && (
          <form
            className="new-flow"
            onSubmit={(e) => {
              e.preventDefault();
              const target = path.trim() || `flows/${slug(name)}.json`;
              void props.onCreate(name.trim() || "Untitled flow", target, datasetChoice || null).then((ok) => {
                if (!ok) return;
                setCreating(false);
                setName("");
                setPath("");
              });
            }}
          >
            <input placeholder="Flow name" value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Flow name" />
            <input placeholder={`flows/${slug(name)}.json`} value={path} onChange={(e) => setPath(e.target.value)} aria-label="File path" />
            <select value={datasetChoice} onChange={(e) => setDatasetChoice(e.target.value)} aria-label="Dataset">
              <option value="">No dataset yet</option>
              {props.flowIndex.datasets.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <button className="primary" type="submit">
              Create
            </button>
          </form>
        )}
        <ul className="file-list">
          {props.flowIndex.flows.map((f) => (
            <li key={f}>
              <button className={f === props.file ? "active" : ""} onClick={() => props.onOpen(f)} title={f}>
                <span className="file-icon" aria-hidden>
                  ⧉
                </span>
                <span className="file-name">{f}</span>
              </button>
            </li>
          ))}
          {props.flowIndex.flows.length === 0 && <li className="dim small">No flow files (.json Flow Specs)</li>}
        </ul>
      </section>

      <section>
        <h2>Datasets</h2>
        <ul className="file-list">
          {props.flowIndex.datasets.map((d) => (
            <li key={d}>
              <button className={d === props.dataset ? "active" : ""} onClick={() => props.onDataset(d)} title={`${d} — click to profile`}>
                <span className="file-icon" aria-hidden>
                  <Icon name="database" size={12} />
                </span>
                <span className="file-name">{d}</span>
              </button>
            </li>
          ))}
          {props.flowIndex.datasets.length === 0 && <li className="dim small">No .csv / .parquet files</li>}
        </ul>
      </section>

      <section className="palette">
        <h2>Nodes</h2>
        <input className="palette-search" placeholder="Search nodes…" value={props.filter} onChange={(e) => props.onFilter(e.target.value)} aria-label="Search nodes" />
        {groups.map(([category, nodes]) => (
          <div key={category} className="palette-group">
            <div className="palette-category">
              <Icon name={categoryIcon(category)} size={12} /> {category}
            </div>
            {nodes.map((node) => (
              <button
                key={node.type}
                className={`palette-item cat-${node.category}`}
                draggable={props.canAdd}
                disabled={!props.canAdd}
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/flowlab-node", node.type);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => props.onAdd(node.type)}
                title={`${node.description.split("\n")[0]}\n\nDrag onto the canvas, or click to add.`}
              >
                <span className="palette-title">{node.title}</span>
                <span className="palette-type">{node.type}</span>
              </button>
            ))}
          </div>
        ))}
      </section>
    </aside>
  );
}

function QuickAdd({ catalogue, onPick, onClose }: { catalogue: Catalogue; onPick: (type: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const matches = catalogue.nodes.filter((n) => `${n.title} ${n.type} ${n.category}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal quick-add" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Add node">
        <input
          autoFocus
          placeholder="Add node…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setCursor((c) => Math.min(c + 1, matches.length - 1));
            else if (e.key === "ArrowUp") setCursor((c) => Math.max(c - 1, 0));
            else if (e.key === "Enter" && matches[cursor]) onPick(matches[cursor].type);
            else if (e.key === "Escape") onClose();
            else return;
            e.preventDefault();
          }}
        />
        <div className="quick-list" role="listbox">
          {matches.map((node, i) => (
            <button key={node.type} role="option" aria-selected={i === cursor} className={i === cursor ? "active" : ""} onMouseEnter={() => setCursor(i)} onClick={() => onPick(node.type)}>
              <span>
                <Icon name={categoryIcon(node.category)} size={12} /> {node.title}
              </span>
              <span className="dim small">{node.type}</span>
            </button>
          ))}
          {matches.length === 0 && <div className="dim small">No matching nodes.</div>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------- inspector
function IssueList({ issues, onSelectNode }: { issues: CompileIssue[]; onSelectNode?: (id: string) => void }) {
  if (!issues.length) return null;
  return (
    <div className="issue-list">
      {issues.map((issue, i) => (
        <button
          key={i}
          className={`warning-row sev-${issue.severity} ${onSelectNode && issue.node_id ? "" : "static"}`}
          onClick={() => onSelectNode && issue.node_id && onSelectNode(issue.node_id)}
        >
          <span className="code">{issue.code}</span>
          {onSelectNode && issue.node_id && <span className="node-ref">{issue.node_id}</span>}
          <span>
            {issue.message}
            {issue.suggestion && <span className="suggestion"> → {issue.suggestion}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

const STATE_TEXT: Record<FlowNodeState, string> = {
  idle: "not run",
  queued: "queued",
  running: "running",
  success: "ran",
  cached: "cached",
  warning: "ran with warnings",
  error: "failed",
  skipped: "skipped",
};

function NodeInspector(props: {
  api: Api;
  spec: FlowSpec;
  node: FlowSpec["nodes"][number];
  entry: CatalogueNode | undefined;
  compile: CompilePayload | null;
  issues: CompileIssue[];
  state: FlowNodeState;
  outdated: boolean;
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  runId: string | null;
  running: boolean;
  outputKey: string;
  onApply: (spec: FlowSpec, coalesce?: string) => void;
  onRename: (to: string) => void;
  onDelete: () => void;
}) {
  const { spec, node, entry, compile } = props;
  const [idDraft, setIdDraft] = useState(node.id);
  const columns = columnsFor(compile, node.id);
  const invalid = new Set(
    props.issues
      .filter((i) => i.code === "PARAM_INVALID")
      .map((i) => /: ([A-Za-z0-9_]+)[.:]/.exec(i.message)?.[1])
      .filter((k): k is string => Boolean(k)),
  );
  const inputSchemas = compile?.schemas[node.id]?.inputs ?? {};

  return (
    <>
      <div className="inspector-head">
        <div className="inspector-title">
          <span className={`cat-badge cat-${entry?.category ?? "unknown"}`} aria-hidden>
            <Icon name={categoryIcon(entry?.category ?? "")} size={12} />
          </span>
          <input
            className="title-input"
            value={node.label ?? ""}
            placeholder={entry?.title ?? node.type}
            aria-label="Node label"
            onChange={(e) => props.onApply(updateNode(spec, node.id, { label: e.target.value || null }), `label:${node.id}`)}
          />
          <span className={`state-pill flow-state-${props.state}`}>{STATE_TEXT[props.state]}</span>
        </div>
        <div className="node-subtitle">
          <label className="small dim">
            id{" "}
            <input
              className="id-input mono"
              value={idDraft}
              onChange={(e) => setIdDraft(e.target.value)}
              onBlur={() => idDraft !== node.id && props.onRename(idDraft)}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              aria-label="Node id"
            />
          </label>
          <span className="chip mono">{node.type}</span>
          <div className="spacer" />
          <button className="link-button danger" onClick={props.onDelete} title="Delete node (Del)">
            Delete
          </button>
        </div>
        <div className="tabs" role="tablist">
          {(["params", "output", "docs"] as InspectorTab[]).map((t) => (
            <button key={t} role="tab" aria-selected={props.tab === t} className={props.tab === t ? "active" : ""} onClick={() => props.onTab(t)}>
              {t === "params" ? `Params${props.issues.length ? ` (${props.issues.length})` : ""}` : t === "output" ? "Output" : "Docs"}
            </button>
          ))}
        </div>
      </div>
      <div className="inspector-body">
        {!entry && <div className="error-box">Unknown node type '{node.type}'. It is not in this runner's catalogue.</div>}
        {props.tab === "params" && entry && (
          <>
            <IssueList issues={props.issues} />
            <SchemaForm
              schema={entry.params_schema}
              value={node.params}
              onChange={(params) => props.onApply(updateNode(spec, node.id, { params }), `params:${node.id}`)}
              columns={columns}
              datasetRefs={Object.keys(spec.dataset_bindings)}
              invalidFields={invalid}
            />
            {Object.entries(inputSchemas).map(([port, schema]) => (
              <details key={port} className="inputs">
                <summary>
                  Input '{port}' · {schema.kind.replace("_", " ")}
                  {schema.table ? ` · ${schema.table.columns.length} columns` : ""}
                  {schema.partitions ? ` · ${schema.partitions.join("/")}` : ""}
                </summary>
                {schema.table && <SchemaChips schema={schema.table} />}
              </details>
            ))}
          </>
        )}
        {props.tab === "output" && (
          <>
            {props.outdated && <div className="banner-inline">Params or inputs changed since this run. Run again to refresh this output.</div>}
            {props.running && !props.runId && <div className="dim small">Running…</div>}
            <OutputView api={props.api} runId={props.runId} nodeId={node.id} refreshKey={props.outputKey} />
          </>
        )}
        {props.tab === "docs" && entry && <NodeDocs entry={entry} />}
      </div>
    </>
  );
}

function NodeDocs({ entry }: { entry: CatalogueNode }) {
  const [summary, ...rest] = entry.description.split("\n\n");
  return (
    <div className="docs">
      <h2>{entry.title}</h2>
      <p>{summary}</p>
      {rest.map((paragraph, i) => (
        <p key={i} className="dim">
          {paragraph}
        </p>
      ))}
      <h3>Inputs</h3>
      {Object.keys(entry.inputs).length === 0 && <div className="dim small">None: this node starts a flow.</div>}
      {Object.entries(entry.inputs).map(([port, def]) => (
        <div key={port} className="port-doc">
          <span className="mono">{port}</span> <span className="dim">{def.types.join(" / ")}</span>
          {def.required ? "" : <span className="dim"> · optional</span>}
          {def.description && <div className="small dim">{def.description}</div>}
        </div>
      ))}
      <h3>Outputs</h3>
      {Object.keys(entry.outputs).length === 0 && <div className="dim small">None: this node writes files.</div>}
      {Object.entries(entry.outputs).map(([port, def]) => (
        <div key={port} className="port-doc">
          <span className="mono">{port}</span> <span className="dim">{def.types.join(" / ")}</span>
          {def.description && <div className="small dim">{def.description}</div>}
        </div>
      ))}
      <h3>Behaviour</h3>
      <div className="chip-row">
        {Object.entries(entry.flags)
          .filter(([, on]) => on)
          .map(([flag]) => (
            <span key={flag} className="chip">
              {flag.replace(/_/g, " ")}
            </span>
          ))}
      </div>
    </div>
  );
}

function FlowSettings(props: {
  spec: FlowSpec;
  compile: CompilePayload | null;
  datasets: string[];
  selection: Selection;
  issues: CompileIssue[];
  onApply: (spec: FlowSpec, coalesce?: string) => void;
  onSelectNode: (id: string) => void;
  onDelete: () => void;
  onCopy: () => void;
}) {
  const { spec, compile } = props;
  const [newRef, setNewRef] = useState("");
  const bindings = Object.entries(spec.dataset_bindings);
  const setBindings = (next: Record<string, string>) => props.onApply({ ...spec, dataset_bindings: next });
  const allIssues = [...(compile?.errors ?? []), ...(compile?.warnings ?? [])];
  const multi = props.selection.nodes.length + props.selection.edges.length;
  return (
    <>
      <div className="inspector-head">
        <div className="inspector-title">
          <span className="title-text">{multi ? `${multi} selected` : "Flow settings"}</span>
        </div>
        <div className="tabs" />
      </div>
      <div className="inspector-body">
        {multi > 0 && (
          <div className="button-row">
            {props.selection.nodes.length > 0 && <button onClick={props.onCopy}>Copy</button>}
            <button className="danger" onClick={props.onDelete}>
              Delete selection
            </button>
          </div>
        )}
        <div className="field">
          <label htmlFor="flow-name">Name</label>
          <input id="flow-name" value={spec.name} onChange={(e) => props.onApply({ ...spec, name: e.target.value }, "flow-name")} />
        </div>
        <div className="field">
          <label htmlFor="flow-desc">Description</label>
          <textarea id="flow-desc" rows={2} value={spec.description ?? ""} onChange={(e) => props.onApply({ ...spec, description: e.target.value }, "flow-desc")} />
        </div>
        <div className="field">
          <label htmlFor="flow-seed">Seed</label>
          <input
            id="flow-seed"
            type="number"
            step={1}
            value={spec.meta?.seed ?? 42}
            onChange={(e) => props.onApply({ ...spec, meta: { ...spec.meta, seed: Math.trunc(Number(e.target.value) || 0) } }, "flow-seed")}
          />
          <div className="field-help">Every stochastic node derives its randomness from this, so runs are reproducible.</div>
        </div>

        <h3>Datasets</h3>
        {bindings.map(([ref, value]) => (
          <div key={ref} className="binding-row">
            <span className="mono binding-ref">{ref}</span>
            <select value={value} onChange={(e) => setBindings({ ...spec.dataset_bindings, [ref]: e.target.value })} aria-label={`Dataset for ${ref}`}>
              {!props.datasets.includes(value) && <option value={value}>{value}</option>}
              {props.datasets.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <button
              className="link-button"
              aria-label={`Remove binding ${ref}`}
              onClick={() => {
                const next = { ...spec.dataset_bindings };
                delete next[ref];
                setBindings(next);
              }}
            >
              <Icon name="close" size={12} />
            </button>
            {compile?.datasets[ref] && compile.datasets[ref] !== value && <div className="field-help">resolves to {compile.datasets[ref]}</div>}
          </div>
        ))}
        <form
          className="binding-row"
          onSubmit={(e) => {
            e.preventDefault();
            const ref = newRef.trim() || "primary";
            const first = props.datasets[0];
            if (spec.dataset_bindings[ref] || !first) return;
            setBindings({ ...spec.dataset_bindings, [ref]: first });
            setNewRef("");
          }}
        >
          <input placeholder={bindings.length ? "name" : "primary"} value={newRef} onChange={(e) => setNewRef(e.target.value.replace(/[^A-Za-z0-9_]/g, ""))} aria-label="Binding name" />
          <button type="submit" disabled={!props.datasets.length}>
            Bind dataset
          </button>
        </form>

        <h3>Compile</h3>
        {!compile ? (
          <div className="dim small">Compiling…</div>
        ) : compile.ok ? (
          <div className="small">
            <span className="good-text"><Icon name="check" size={11} /> Compiles</span> · {compile.order.length} steps in order {compile.order.join(" → ")}
          </div>
        ) : (
          <div className="small error-text"><Icon name="error" size={11} /> {compile.errors.length} error(s); the flow cannot run yet.</div>
        )}
        <IssueList issues={allIssues} onSelectNode={props.onSelectNode} />
        {props.issues.length === 0 && allIssues.length === 0 && compile?.ok && <div className="dim small">No warnings. Rigour checks passed.</div>}
        <h3>Shortcuts</h3>
        <ul className="tips small">
          <li>
            <kbd>Tab</kbd> / <kbd>Ctrl/⌘ K</kbd> add node · <kbd>Del</kbd> remove · <kbd>Space</kbd>+drag pan
          </li>
          <li>
            <kbd>Ctrl/⌘ Z</kbd> undo · <kbd>Ctrl/⌘ Shift Z</kbd> redo · <kbd>Ctrl/⌘ C</kbd>/<kbd>V</kbd>/<kbd>D</kbd> copy, paste, duplicate
          </li>
          <li>
            <kbd>Ctrl/⌘ S</kbd> save · <kbd>Ctrl/⌘ Enter</kbd> run · Shift+drag to box-select
          </li>
        </ul>
      </div>
    </>
  );
}

function DatasetPanel({ api, file, spec, onBind }: { api: Api; file: string; spec: FlowSpec | null; onBind: (ref: string) => void }) {
  const [profile, setProfile] = useState<DatasetProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setProfile(null);
    setError(null);
    let live = true;
    api
      .datasetProfile(file)
      .then((p) => live && setProfile(p))
      .catch((err: unknown) => live && setError(err instanceof ApiError ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [api, file]);
  const boundAs = spec ? Object.entries(spec.dataset_bindings).find(([, v]) => v === file)?.[0] : undefined;
  const suggested = file.split("/").pop()?.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_]/g, "_") || "data";
  const ref = spec && !spec.dataset_bindings.primary ? "primary" : suggested;
  return (
    <>
      <div className="inspector-head">
        <div className="inspector-title">
          <span className="cat-badge cat-source" aria-hidden>
            <Icon name="database" size={12} />
          </span>
          <span className="title-text mono" title={file}>
            {file}
          </span>
        </div>
        <div className="node-subtitle">
          {boundAs ? (
            <span className="chip">bound as {boundAs}</span>
          ) : (
            <button disabled={!spec || Boolean(spec.dataset_bindings[ref])} onClick={() => onBind(ref)}>
              Bind to flow as '{ref}'
            </button>
          )}
        </div>
        <div className="tabs" />
      </div>
      <div className="inspector-body">
        {error && <div className="error-box">{error}</div>}
        {!profile && !error && <div className="dim">Profiling…</div>}
        {profile && (
          <>
            <dl className="stats">
              <dt>Rows</dt>
              <dd>{profile.schema.row_count?.toLocaleString() ?? "?"}</dd>
              <dt>Columns</dt>
              <dd>{profile.schema.columns.length}</dd>
            </dl>
            <h3>Schema</h3>
            <div className="table-scroll">
              <table className="grid">
                <thead>
                  <tr>
                    <th>column</th>
                    <th>semantic</th>
                    <th>role</th>
                    <th>null</th>
                    <th>distinct</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.schema.columns.map((c) => (
                    <tr key={c.name}>
                      <td>{c.name}</td>
                      <td>{c.semantic.replace(/_/g, " ")}</td>
                      <td>{c.role}</td>
                      <td className="num">{c.null_frac ? `${(c.null_frac * 100).toFixed(1)}%` : "0"}</td>
                      <td className="num">{c.cardinality?.toLocaleString() ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>Preview</h3>
            <DataGrid preview={profile.preview} total={profile.schema.row_count ?? undefined} />
          </>
        )}
      </div>
    </>
  );
}

