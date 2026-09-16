import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { ApiError, type Api } from "../api";
import { Console, type ConsoleLine } from "../components/Console";
import { Icon } from "../components/Icon";
import { MetricsChart, metricGroups } from "../components/MetricsChart";
import { PaperBackground } from "../components/PaperBackground";
import { OutputList } from "../components/RichOutput";
import { STATE_LABEL, headlineMetric } from "../components/GraphCanvas";
import type { LabEvent, MetricPoint, NodeState, SessionState } from "../types";
import { CreateNodeDialog } from "./CreateNodeDialog";
import {
  PURPOSE_ICON,
  addNode,
  blockFor,
  connectNodes,
  indexCatalogue,
  nodeRunState,
  paramSummary,
  removeNodes,
  type BlockInfo,
  type BuildCatalogue,
  type BuildIssue,
  type DatasetInfo,
  type FinalizeResult,
  type ParamSpec,
  type Pipeline,
  type PipelineNode,
  type Technique,
} from "./types";

const CARD_W = 250;
const CARD_H = 96;
const CONSENT_KEY = "flowlab-build-ai-consent";

interface StepData extends Record<string, unknown> {
  node: PipelineNode;
  technique: Technique | undefined;
  purposeId: string;
  purposeTitle: string;
  summary: string;
  state: NodeState | null;
  errors: number;
  metric: [string, number] | null;
}

type StepNode = Node<StepData, "step">;

function message(error: unknown): string {
  return error instanceof ApiError ? error.message : String(error);
}

function readConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "yes";
  } catch {
    return false;
  }
}

function StepCard({ data, selected }: NodeProps<StepNode>) {
  const state = data.state;
  return (
    <div
      className={`code-node build-node purpose-${data.purposeId} ${state ? `state-${state}` : ""} ${selected ? "selected" : ""} ${data.errors ? "has-issue" : ""}`}
      style={{ width: CARD_W, height: CARD_H }}
      aria-label={`${data.technique?.title ?? data.node.snippet}, ${data.purposeTitle}${state ? `, ${state}` : ""}`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="code-node-head">
        <span className="build-purpose" title={data.purposeTitle}>
          <Icon name={PURPOSE_ICON[data.purposeId] ?? "dot"} size={12} />
        </span>
        <span className="code-node-label" title={data.technique?.title}>
          {data.node.label || data.technique?.title || data.node.snippet}
        </span>
        {state && (
          <span className={`state-pill state-${state}`}>
            <Icon name={STATE_LABEL[state].icon} size={10} /> {STATE_LABEL[state].text}
          </span>
        )}
      </div>
      <div className="code-node-meta">
        <span className="chip">{data.purposeTitle}</span>
        {data.technique?.group && <span className="chip dim-chip">{data.technique.group}</span>}
        {data.errors > 0 && (
          <span className="chip warn">
            <Icon name="warning" size={10} /> {data.errors}
          </span>
        )}
        {data.metric && (
          <span className="chip metric-chip">
            {data.metric[0]} {Number(data.metric[1].toPrecision(3))}
          </span>
        )}
      </div>
      <div className="code-node-summary" title={data.summary || data.technique?.description}>
        {data.summary || data.technique?.description}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { step: StepCard };

export function BuildWorkspace({ api, modeSwitch, onOpenScript }: { api: Api; modeSwitch: ReactNode; onOpenScript: (file: string) => void }) {
  const [catalogue, setCatalogue] = useState<BuildCatalogue | null>(null);
  const [datasets, setDatasets] = useState<string[]>([]);
  const [pipelines, setPipelines] = useState<{ file: string; name: string; nodes: number }[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [dataset, setDataset] = useState<DatasetInfo | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ purpose: string | null } | null>(null);
  const [issues, setIssues] = useState<BuildIssue[]>([]);
  const [result, setResult] = useState<FinalizeResult | null>(null);
  const [finalizedJson, setFinalizedJson] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [useAi, setUseAi] = useState(false);
  const [consent, setConsent] = useState(readConsent);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [live, setLive] = useState<Record<string, MetricPoint[]>>({});
  const [newName, setNewName] = useState<string | null>(null);
  const lineId = useRef(0);
  const scriptRef = useRef<string | null>(null);
  scriptRef.current = result?.script_file ?? null;

  const index = useMemo(() => indexCatalogue(catalogue), [catalogue]);
  const blocks: Record<string, BlockInfo> = result?.blocks ?? {};
  const targetTask = dataset?.columns.find((c) => c.name === pipeline?.target)?.task ?? null;
  const dirty = pipeline !== null && JSON.stringify(pipeline) !== finalizedJson;
  const running = session?.kernel.status === "busy" || Object.values(session?.nodes ?? {}).some((n) => n.state === "running");

  const log = useCallback((kind: ConsoleLine["kind"], node: string | null, text: string) => {
    setLines((current) => [...current.slice(-1999), { id: ++lineId.current, ts: new Date().toLocaleTimeString(), kind, node, text }]);
  }, []);

  // ------------------------------------------------------------------ loading
  useEffect(() => {
    api.buildCatalogue().then(setCatalogue).catch((e: unknown) => setError(message(e)));
    api.buildDatasets().then(setDatasets).catch(() => undefined);
    api
      .buildPipelines()
      .then((items) => {
        setPipelines(items);
        if (items[0]) setFile(items[0].file);
      })
      .catch(() => undefined);
  }, [api]);

  useEffect(() => {
    if (!file) return;
    setResult(null);
    setFinalizedJson(null);
    setSession(null);
    setSelected(null);
    setLive({});
    api
      .buildLoad(file)
      .then((loaded) => setPipeline(loaded.pipeline))
      .catch((e: unknown) => setError(message(e)));
  }, [api, file]);

  useEffect(() => {
    if (!pipeline?.dataset) {
      setDataset(null);
      return;
    }
    api.buildDataset(pipeline.dataset).then(setDataset).catch((e: unknown) => setError(message(e)));
  }, [api, pipeline?.dataset]);

  // save and check shortly after every edit
  useEffect(() => {
    if (!pipeline || !file) return;
    const timer = window.setTimeout(() => {
      api.buildSave(file, pipeline).catch((e: unknown) => setError(message(e)));
      api
        .buildCheck(pipeline)
        .then((checked) => setIssues(checked.issues))
        .catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [api, file, pipeline]);

  // live run events for the generated script
  const loadState = useCallback(() => {
    const script = scriptRef.current;
    if (script) api.state(script).then(setSession).catch(() => undefined);
  }, [api]);
  const handler = useRef<(event: LabEvent) => void>(() => undefined);
  handler.current = (event: LabEvent) => {
    const script = scriptRef.current;
    if (!script || event.file !== script) return;
    const block = event.node_id ?? null;
    const node = block ? (blocks[block]?.node ?? null) : null;
    const label = node ?? (block ? blocks[block]?.title.split(" [")[0] ?? block : null);
    const data = event.data;
    if (event.type === "stream") {
      const text = String(data.text ?? "").replace(/\r[^\n]*/g, "");
      for (const line of text.split("\n")) if (line.trim()) log(data.name === "stderr" ? "stderr" : "stdout", label, line);
    } else if (event.type === "metric" && block) {
      const point: MetricPoint = { step: Number(data.step), values: data.values as Record<string, number>, source: data.source === "log" ? "log" : "output" };
      setLive((current) => ({ ...current, [block]: [...(current[block] ?? []).slice(-4999), point] }));
    } else if (event.type === "node_started") {
      if (block) setLive((current) => ({ ...current, [block]: [] }));
      loadState();
    } else if (event.type === "node_completed" || event.type === "node_failed" || event.type === "run_finished" || event.type.startsWith("kernel")) {
      if (event.type === "node_failed") log("error", label, `failed (${String(data.status)})`);
      loadState();
    }
  };
  useEffect(() => api.events((event) => handler.current(event), () => undefined), [api]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(loadState, 1000);
    return () => window.clearInterval(timer);
  }, [running, loadState]);

  // ------------------------------------------------------------------ editing
  const update = (next: Pipeline) => setPipeline(next);
  const updateNode = (id: string, change: Partial<PipelineNode>) =>
    pipeline && update({ ...pipeline, nodes: pipeline.nodes.map((n) => (n.id === id ? { ...n, ...change } : n)) });

  function add(technique: Technique) {
    if (!pipeline) return;
    const { pipeline: next, id } = addNode(pipeline, technique.id, selected);
    update(next);
    setSelected(id);
    setDialog(null);
  }

  async function createPipeline(name: string) {
    try {
      const created = await api.buildNew(name, datasets[0] ?? null);
      setPipelines(await api.buildPipelines());
      setFile(created.file);
      setNewName(null);
    } catch (e) {
      setError(message(e));
    }
  }

  // ---------------------------------------------------------- finalize / run
  async function finalize(options: { ai: boolean; errorText?: string | null } = { ai: useAi }): Promise<FinalizeResult | null> {
    if (!pipeline || !file) return null;
    if (options.ai && !consent) {
      setError("Tick “Allow sending the pipeline code and column summary to Groq” to connect with AI.");
      return null;
    }
    setBusy(options.errorText ? "Asking AI to fix the failed step…" : options.ai ? "Connecting with AI…" : "Finalizing…");
    setError(null);
    try {
      const next = await api.buildFinalize({ file, pipeline, use_llm: options.ai, confirm_external: options.ai && consent, error: options.errorText ?? null });
      setResult(next);
      setIssues(next.issues);
      if (next.ok) {
        setFinalizedJson(JSON.stringify(pipeline));
        log("info", null, `finalized ${next.script_file}: ${next.cells.length} cells${next.llm_used ? `, AI used ${next.tokens} tokens` : ""}. ${next.notes}`);
      } else {
        setError(next.issues.find((i) => i.severity === "error")?.message ?? "the pipeline could not be finalized");
      }
      return next;
    } catch (e) {
      setError(message(e));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function run() {
    let current = result;
    if (!current?.ok || dirty) current = await finalize({ ai: useAi });
    if (!current?.ok || !current.script_file) return;
    setBusy("Starting the kernel…");
    try {
      setLive({});
      const started = await api.buildRun(current.script_file);
      setResult({ ...current, blocks: started.blocks });
      log("info", null, `running ${started.plan.length} cells`);
      loadState();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  }

  async function fixWithAi() {
    if (!session || !result) return;
    const failed = Object.entries(session.nodes).find(([, n]) => n.state === "error");
    const record = failed?.[1].last_run;
    if (!failed || !record?.error) return;
    const text = [`cell ${failed[0]} (${blocks[failed[0]]?.title ?? ""}) raised ${record.error.ename}: ${record.error.evalue}`, ...record.error.traceback.slice(-12)]
      .join("\n")
      .replace(/\[[0-9;]*m/g, "");
    const next = await finalize({ ai: true, errorText: text });
    if (next?.ok) await run();
  }

  // ------------------------------------------------------------------ canvas
  const issuesByNode = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of issues) if (issue.node && issue.severity !== "info") counts.set(issue.node, (counts.get(issue.node) ?? 0) + 1);
    return counts;
  }, [issues]);

  const nodes: StepNode[] = (pipeline?.nodes ?? []).map((node) => {
    const entry = index.get(node.snippet);
    const block = blockFor(node.id, blocks);
    const points = (block && live[block]?.length ? live[block] : block ? session?.nodes[block]?.metrics : undefined) ?? [];
    return {
      id: node.id,
      type: "step",
      position: { x: node.x, y: node.y },
      width: CARD_W,
      height: CARD_H,
      measured: { width: CARD_W, height: CARD_H },
      selected: node.id === selected,
      data: {
        node,
        technique: entry?.technique,
        purposeId: entry?.purpose.id ?? "unknown",
        purposeTitle: entry?.purpose.title ?? "Unknown",
        summary: paramSummary(node, entry?.technique),
        state: nodeRunState(node.id, blocks, session),
        errors: issuesByNode.get(node.id) ?? 0,
        metric: headlineMetric(points),
      },
    };
  });
  const edges: Edge[] = (pipeline?.edges ?? []).map((edge) => ({
    id: `${edge.from}->${edge.to}`,
    source: edge.from,
    target: edge.to,
    style: { stroke: "var(--edge)", strokeWidth: 1.6 },
    markerEnd: { type: MarkerType.ArrowClosed, color: "var(--edge)", width: 16, height: 16 },
  }));

  function onNodesChange(changes: NodeChange[]) {
    if (!pipeline) return;
    let next = pipeline;
    const removed = new Set<string>();
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        const { x, y } = change.position;
        next = { ...next, nodes: next.nodes.map((n) => (n.id === change.id ? { ...n, x: Math.round(x), y: Math.round(y) } : n)) };
      } else if (change.type === "select" && change.selected) {
        setSelected(change.id);
      } else if (change.type === "remove") {
        removed.add(change.id);
      }
    }
    if (removed.size) {
      next = removeNodes(next, removed);
      if (selected && removed.has(selected)) setSelected(null);
    }
    if (next !== pipeline) update(next);
  }

  function onEdgesChange(changes: EdgeChange[]) {
    if (!pipeline) return;
    const removed = new Set(changes.filter((c) => c.type === "remove").map((c) => c.id));
    if (removed.size) update({ ...pipeline, edges: pipeline.edges.filter((e) => !removed.has(`${e.from}->${e.to}`)) });
  }

  const selectedNode = pipeline?.nodes.find((n) => n.id === selected) ?? null;
  const failedBlock = Object.entries(session?.nodes ?? {}).find(([, n]) => n.state === "error")?.[0] ?? null;
  const errorsCount = issues.filter((i) => i.severity === "error").length;

  return (
    <div className={`app build-app ${consoleOpen ? "console-open" : "console-closed"}`}>
      <header className="toolbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            <Icon name="logo" />
          </span>{" "}
          FlowLab {modeSwitch}
        </div>
        {newName !== null ? (
          <form
            className="inline-form build-new"
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim()) void createPipeline(newName.trim());
            }}
          >
            <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Pipeline name" aria-label="Pipeline name" />
            <button className="primary" type="submit" disabled={!newName.trim()}>
              Create
            </button>
            <button type="button" onClick={() => setNewName(null)}>
              Cancel
            </button>
          </form>
        ) : (
          <>
            <select value={file ?? ""} onChange={(e) => setFile(e.target.value || null)} aria-label="Pipeline">
              {!pipelines.length && <option value="">No pipelines yet</option>}
              {pipelines.map((p) => (
                <option key={p.file} value={p.file}>
                  {p.name}
                </option>
              ))}
            </select>
            <button onClick={() => setNewName("")}>New pipeline</button>
          </>
        )}
        <div className="spacer" />
        {busy && <span className="small status-busy">{busy}</span>}
        <label className="toggle" title={catalogue?.llm_configured ? "Let the model write glue between cells when names do not line up" : "Set GROQ_API_KEY to enable"}>
          <input type="checkbox" checked={useAi} disabled={!catalogue?.llm_configured} onChange={(e) => setUseAi(e.target.checked)} /> Connect with AI
        </label>
        <button disabled={!pipeline || busy !== null} onClick={() => void finalize({ ai: useAi })} title="Order the nodes and generate the script">
          <Icon name="check" /> Finalize
        </button>
        <button className="primary" disabled={!pipeline || busy !== null || running || errorsCount > 0} onClick={() => void run()}>
          <Icon name="play" /> {dirty && result ? "Finalize and run" : "Run"}
        </button>
        {failedBlock && catalogue?.llm_configured && (
          <button disabled={busy !== null || running} onClick={() => void fixWithAi()} title="Send the error and the pipeline code to the model for a glue fix, then run again">
            <Icon name="spark" /> Fix with AI
          </button>
        )}
        {result?.script_file && (
          <button onClick={() => onOpenScript(result.script_file!)} title="Open the generated script as runnable cells">
            <Icon name="notebook" /> Open in Code Mode
          </button>
        )}
      </header>

      <aside className="sidebar build-palette">
        <section>
          <h2>Create node</h2>
          <button className="primary create-button" disabled={!pipeline || !catalogue} onClick={() => setDialog({ purpose: null })}>
            <Icon name="spark" /> Create node
          </button>
          <div className="palette-list">
            {catalogue?.purposes.map((p) => (
              <button key={p.id} className="palette-item" disabled={!pipeline} onClick={() => setDialog({ purpose: p.id })} title={p.question}>
                <Icon name={PURPOSE_ICON[p.id] ?? "dot"} />
                <span>{p.title}</span>
                <span className="dim small">{p.snippets.length}</span>
              </button>
            ))}
          </div>
        </section>
        <section>
          <h2>How it works</h2>
          <ol className="small tips">
            <li>Pick the dataset and the column to predict.</li>
            <li>Create nodes: choose what each is for, then a technique.</li>
            <li>Connect them top to bottom; set parameters on the right.</li>
            <li>Finalize to generate the script, then Run. Change anything and run again.</li>
          </ol>
        </section>
      </aside>

      <main className="workspace">
        {error && (
          <div className="banner warning" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>Dismiss</button>
          </div>
        )}
        {!pipeline ? (
          <div className="placeholder build-empty">
            <h2>Build a pipeline without code</h2>
            <p className="dim">Create a pipeline, add nodes for loading, cleaning, preprocessing, a model and evaluation, then finalize and run it.</p>
            <button className="primary" onClick={() => setNewName("")}>
              New pipeline
            </button>
          </div>
        ) : (
          <section className="canvas-pane">
            <ReactFlow
              key={file ?? ""}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={(c) => c.source && c.target && update(connectNodes(pipeline, c.source, c.target))}
              onPaneClick={() => setSelected(null)}
              onNodeDoubleClick={(_, node) => setSelected(node.id)}
              deleteKeyCode={["Delete", "Backspace"]}
              fitView
              fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
              minZoom={0.1}
              proOptions={{ hideAttribution: true }}
              colorMode="dark"
            >
              <PaperBackground />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeColor="#2a2a2a" maskColor="rgba(0,0,0,0.6)" />
            </ReactFlow>
            {pipeline.nodes.length === 0 && (
              <div className="build-hint">
                <button className="primary" onClick={() => setDialog({ purpose: null })}>
                  <Icon name="spark" /> Create your first node
                </button>
              </div>
            )}
          </section>
        )}
      </main>

      <aside className="inspector">
        {pipeline && selectedNode ? (
          <NodeInspector
            api={api}
            node={selectedNode}
            technique={index.get(selectedNode.snippet)?.technique}
            purposeTitle={index.get(selectedNode.snippet)?.purpose.title ?? ""}
            dataset={dataset}
            target={pipeline.target}
            issues={issues.filter((i) => i.node === selectedNode.id)}
            cell={result?.cells.find((c) => c.node === selectedNode.id) ?? null}
            scriptFile={result?.script_file ?? null}
            block={blockFor(selectedNode.id, blocks)}
            session={session}
            live={live}
            onChange={(change) => updateNode(selectedNode.id, change)}
            onRemove={() => {
              update(removeNodes(pipeline, new Set([selectedNode.id])));
              setSelected(null);
            }}
          />
        ) : pipeline ? (
          <PipelineInspector
            pipeline={pipeline}
            datasets={datasets}
            dataset={dataset}
            issues={issues}
            result={result}
            consent={consent}
            llmConfigured={Boolean(catalogue?.llm_configured)}
            onConsent={(value) => {
              setConsent(value);
              try {
                localStorage.setItem(CONSENT_KEY, value ? "yes" : "no");
              } catch {
                /* remembering consent is a convenience */
              }
            }}
            onChange={update}
            onSelect={setSelected}
          />
        ) : (
          <div className="panel dim">No pipeline open.</div>
        )}
      </aside>

      <Console lines={lines} open={consoleOpen} onToggle={() => setConsoleOpen((o) => !o)} onClear={() => setLines([])} onSelect={(node) => setSelected(node)} badge="" />

      {dialog && catalogue && (
        <CreateNodeDialog catalogue={catalogue} initialPurpose={dialog.purpose} task={targetTask} onAdd={add} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

// -------------------------------------------------------------------- inspectors

function PipelineInspector({
  pipeline,
  datasets,
  dataset,
  issues,
  result,
  consent,
  llmConfigured,
  onConsent,
  onChange,
  onSelect,
}: {
  pipeline: Pipeline;
  datasets: string[];
  dataset: DatasetInfo | null;
  issues: BuildIssue[];
  result: FinalizeResult | null;
  consent: boolean;
  llmConfigured: boolean;
  onConsent: (value: boolean) => void;
  onChange: (pipeline: Pipeline) => void;
  onSelect: (id: string) => void;
}) {
  const [openCell, setOpenCell] = useState<number | null>(null);
  return (
    <div className="inspector-body">
      <h2>Pipeline</h2>
      <label className="field">
        <span className="small dim">Name</span>
        <input value={pipeline.name} onChange={(e) => onChange({ ...pipeline, name: e.target.value || "Pipeline" })} />
      </label>
      <label className="field">
        <span className="small dim">Dataset</span>
        <select value={pipeline.dataset ?? ""} onChange={(e) => onChange({ ...pipeline, dataset: e.target.value || null, target: null })}>
          <option value="">Choose a dataset…</option>
          {datasets.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      {dataset && (
        <label className="field">
          <span className="small dim">Column to predict (target)</span>
          <select value={pipeline.target ?? ""} onChange={(e) => onChange({ ...pipeline, target: e.target.value || null })}>
            <option value="">None (exploration or clustering)</option>
            {dataset.columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} · {c.kind}
                {c.task ? ` · ${c.task}` : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {dataset && (
        <div className="dim small">
          {dataset.rows.toLocaleString()} rows · {dataset.columns.length} columns
        </div>
      )}

      <h3>Checks</h3>
      {issues.length === 0 && <div className="dim small">No problems found.</div>}
      {issues.map((issue, i) => (
        <button key={i} className={`warning-row sev-${issue.severity}`} onClick={() => issue.node && onSelect(issue.node)}>
          {issue.node && <span className="node-ref">{issue.node}</span>}
          <span>{issue.message}</span>
        </button>
      ))}

      {llmConfigured && (
        <label className="toggle consent build-consent">
          <input type="checkbox" checked={consent} onChange={(e) => onConsent(e.target.checked)} /> Allow sending the pipeline code and column summary (never data rows) to Groq when connecting or fixing with AI
        </label>
      )}

      {result && (
        <>
          <h3>Generated script</h3>
          <div className="small dim">
            {result.ok ? `${result.script_file} · ${result.cells.length} cells` : "not generated"}
            {result.llm_used ? ` · AI used ${result.tokens} tokens` : ""}
          </div>
          {result.notes && <p className="small">{result.notes}</p>}
          {result.adjustments.map((a) => (
            <div key={a} className="small dim">
              {a}
            </div>
          ))}
          <div className="cell-list">
            {result.cells.map((cell, i) => (
              <div key={i} className={`cell-row ${cell.glue ? "glue" : cell.auto ? "auto" : ""}`}>
                <button className="cell-row-head" onClick={() => setOpenCell(openCell === i ? null : i)}>
                  <Icon name={openCell === i ? "chevronDown" : "chevronRight"} size={10} />
                  <span className="cell-row-title">{cell.title.replace(/\s*\{node:[^}]+\}/, "")}</span>
                  {cell.glue && <span className="chip model-chip">AI glue</span>}
                  {cell.auto && <span className="chip">added</span>}
                </button>
                {cell.why && <div className="small dim">{cell.why}</div>}
                {openCell === i && <pre className="technique-code">{cell.code}</pre>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ParamField({ name, spec, value, dataset, target, onChange }: { name: string; spec: ParamSpec; value: unknown; dataset: DatasetInfo | null; target: string | null; onChange: (value: unknown) => void }) {
  const columns = dataset?.columns ?? [];
  const label = (
    <span className="small dim">
      {name.replace(/_/g, " ")}
      {spec.optional || spec.default !== null ? "" : " (required)"}
      {spec.description ? ` · ${spec.description}` : ""}
    </span>
  );
  if (spec.type === "column") {
    const current = typeof value === "string" ? value : name === "target" && target ? target : "";
    return (
      <label className="field">
        {label}
        <select value={current} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">{name === "target" && target ? `pipeline target (${target})` : "Choose a column…"}</option>
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} · {c.kind}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (spec.type === "columns") {
    const chosen = new Set(Array.isArray(value) ? (value as string[]) : []);
    return (
      <fieldset className="field columns-field">
        <legend>{label}</legend>
        <div className="small dim">{chosen.size ? `${chosen.size} selected` : spec.optional ? "none selected: all suitable columns" : "select at least one"}</div>
        <div className="columns-choices">
          {columns.map((c) => (
            <label key={c.name} className="toggle">
              <input
                type="checkbox"
                checked={chosen.has(c.name)}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(c.name);
                  else next.delete(c.name);
                  onChange(next.size ? [...next] : undefined);
                }}
              />
              {c.name}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  if (spec.type === "choice") {
    return (
      <label className="field">
        {label}
        <select value={String(value ?? spec.default ?? "")} onChange={(e) => onChange(e.target.value)}>
          {(spec.choices ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (spec.type === "bool") {
    return (
      <label className="toggle field">
        <input type="checkbox" checked={Boolean(value ?? spec.default)} onChange={(e) => onChange(e.target.checked)} /> {name.replace(/_/g, " ")}
      </label>
    );
  }
  if (spec.type === "int" || spec.type === "float") {
    return (
      <label className="field">
        {label}
        <input
          type="number"
          step={spec.type === "int" ? 1 : "any"}
          min={spec.min ?? undefined}
          max={spec.max ?? undefined}
          value={value === undefined || value === null ? String(spec.default ?? "") : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? undefined : spec.type === "int" ? Math.round(Number(e.target.value)) : Number(e.target.value))}
        />
      </label>
    );
  }
  return (
    <label className="field">
      {label}
      <input value={value === undefined || value === null ? String(spec.default ?? "") : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} />
    </label>
  );
}

function NodeInspector({
  api,
  node,
  technique,
  purposeTitle,
  dataset,
  target,
  issues,
  cell,
  scriptFile,
  block,
  session,
  live,
  onChange,
  onRemove,
}: {
  api: Api;
  node: PipelineNode;
  technique: Technique | undefined;
  purposeTitle: string;
  dataset: DatasetInfo | null;
  target: string | null;
  issues: BuildIssue[];
  cell: FinalizeResult["cells"][number] | null;
  scriptFile: string | null;
  block: string | null;
  session: SessionState | null;
  live: Record<string, MetricPoint[]>;
  onChange: (change: Partial<PipelineNode>) => void;
  onRemove: () => void;
}) {
  const [showCode, setShowCode] = useState(false);
  const entry = block ? session?.nodes[block] : undefined;
  const record = entry?.last_run ?? null;
  const points = (block && live[block]?.length ? live[block] : entry?.metrics) ?? [];
  if (!technique) {
    return (
      <div className="inspector-body">
        <h2>{node.snippet}</h2>
        <p className="error-text">This technique is not in the library any more.</p>
        <button className="danger" onClick={onRemove}>
          Remove node
        </button>
      </div>
    );
  }
  return (
    <div className="inspector-body">
      <h2>{technique.title}</h2>
      <div className="chip-row">
        <span className="chip">{purposeTitle}</span>
        {technique.group && <span className="chip">{technique.group}</span>}
        {technique.task && <span className="chip">{technique.task}</span>}
        <span className="chip mono">{node.id}</span>
      </div>
      <p className="small">{technique.description}</p>
      {issues.map((issue, i) => (
        <div key={i} className={`warning-row sev-${issue.severity}`}>
          <span>{issue.message}</span>
        </div>
      ))}

      <h3>Settings</h3>
      {Object.keys(technique.params).length === 0 && <div className="dim small">This technique has no settings.</div>}
      {Object.entries(technique.params).map(([name, spec]) => (
        <ParamField
          key={name}
          name={name}
          spec={spec}
          value={node.params[name]}
          dataset={dataset}
          target={target}
          onChange={(value) => {
            const params = { ...node.params };
            if (value === undefined) delete params[name];
            else params[name] = value;
            onChange({ params });
          }}
        />
      ))}
      <label className="field">
        <span className="small dim">Card label (optional)</span>
        <input value={node.label ?? ""} onChange={(e) => onChange({ label: e.target.value || null })} placeholder={technique.title} />
      </label>

      {entry && (
        <>
          <h3>
            Last run{" "}
            {entry.state && (
              <span className={`state-pill state-${entry.state}`}>
                <Icon name={STATE_LABEL[entry.state].icon} size={10} /> {STATE_LABEL[entry.state].text}
              </span>
            )}
          </h3>
          {record?.error && (
            <pre className="repr error-text">
              {record.error.ename}: {record.error.evalue}
            </pre>
          )}
          {record?.stdout && <pre className="repr">{record.stdout.slice(-4000)}</pre>}
          {record && scriptFile && <OutputList api={api} file={scriptFile} record={record} compact />}
          {points.length > 0 && metricGroups(points).map((group) => <MetricsChart key={group.title} title={group.title} names={group.names} points={points} />)}
        </>
      )}

      <h3>Code</h3>
      <button onClick={() => setShowCode((s) => !s)}>{showCode ? "Hide code" : cell ? "Show generated code" : "Show example code"}</button>
      {showCode && <pre className="technique-code">{cell ? cell.code : technique.example}</pre>}

      <div className="button-row build-remove">
        <button className="danger" onClick={onRemove}>
          Remove node
        </button>
      </div>
    </div>
  );
}
