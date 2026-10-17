import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../context";
import { Icon, type IconName } from "../components/Icon";
import { NetworkDiagram, ParamForm, type ColumnInfo, type Layer } from "../components/ParamForm";
import { CommitInput, KindBadge, Modal, Notice, Segmented, Spinner, Switch } from "../components/ui";
import { cell, metricValue, pct } from "../format";
import { buildGraph, move, STAGE_COLOURS, STAGE_TITLES, type PipeNode } from "../pipeline";
import type { AlgoDef, ModelEntry, OpDef, Preview, Project, Step } from "../types";
import type { ProjectApi } from "./ProjectPage";
import type { Training } from "./useTraining";

type StepStage = "clean" | "rows" | "transform";

const KIND_ICON: Record<string, IconName> = {
  dataset: "database",
  split: "split",
  autoprep: "sparkles",
  imageprep: "image",
  model: "model",
  results: "trophy",
};
const STAGE_ICON: Record<string, IconName> = { clean: "broom", rows: "rows", transform: "transform" };

type FlowData = PipeNode & { selected: boolean; onAdd: (stage: NonNullable<PipeNode["addStage"]>) => void } & Record<string, unknown>;

function PipelineNode({ data }: NodeProps<Node<FlowData>>) {
  const colour = STAGE_COLOURS[data.stage];
  if (data.kind === "add") {
    return (
      <button className={`node-add ${data.narrow ? "narrow" : ""}`} onClick={(e) => { e.stopPropagation(); data.onAdd(data.addStage!); }}>
        <Icon name="plus" size={13} /> {data.title}
      </button>
    );
  }
  if (data.band) {
    return <div className="stage-band" style={{ width: Number(data.bandWidth), height: Number(data.bandHeight) }} />;
  }
  if (data.id.startsWith("label-")) {
    return <div className="stage-label" style={{ color: colour }}><i />{data.title}</div>;
  }
  const icon = data.kind === "step" ? STAGE_ICON[data.stage] ?? "dot" : KIND_ICON[data.kind] ?? "dot";
  const classes = ["node", data.selected ? "selected" : "", data.disabled ? "disabled" : "", data.level === "error" ? "has-error" : data.level === "warning" ? "has-warning" : ""];
  return (
    <div className={classes.join(" ")}>
      <Handle type="target" position={Position.Left} id="left" />
      <Handle type="target" position={Position.Top} id="top" />
      <div className="node-title">
        <span className="node-icon" style={{ color: colour, background: `color-mix(in srgb, ${colour} 14%, transparent)` }}>
          <Icon name={data.kind === "model" && data.title.toLowerCase().includes("neural") ? "brain" : icon} size={14} />
        </span>
        <span className="ellipsis" style={{ flex: 1 }}>{data.title}</span>
        {data.level === "error" && <Icon name="error" size={14} className="error-text" />}
        {data.level === "warning" && <Icon name="warning" size={14} className="warn-text" />}
      </div>
      <div className="node-sub">{data.subtitle}</div>
      {(data.metric || data.status) && (
        <div className="node-foot">
          {data.status === "running" || data.status === "explaining" ? (
            <>
              <Spinner />
              <div className="bar" style={{ flex: 1 }}><span style={{ width: `${(data.progress ?? 0.05) * 100}%` }} /></div>
            </>
          ) : data.status === "waiting" ? (
            <span className="faint tiny">waiting</span>
          ) : data.metric ? (
            <span className={data.metric === "failed" ? "error-text tiny" : "metric"}>{data.metric}</span>
          ) : null}
        </div>
      )}
      <Handle type="source" position={Position.Right} id="right" />
      <Handle type="source" position={Position.Bottom} id="bottom" />
    </div>
  );
}

const nodeTypes = { pipe: PipelineNode };

// ------------------------------------------------------------------------------- pickers

function StepPicker({ stage, onPick, onClose }: { stage: StepStage; onPick: (op: OpDef) => void; onClose: () => void }) {
  const { catalogue } = useApp();
  const ops = catalogue[stage];
  const groups = [...new Set(ops.map((o) => o.group))];
  const [group, setGroup] = useState(groups[0] ?? "");
  const [query, setQuery] = useState("");
  const shown = ops.filter((o) => (query ? `${o.label} ${o.description}`.toLowerCase().includes(query.toLowerCase()) : o.group === group));
  const intro: Record<StepStage, string> = {
    clean: "Clean steps run on the whole table before the split. Row steps (duplicates, filters) only apply while training.",
    rows: "These steps change training rows only, so the test rows stay a fair exam.",
    transform: "Transforms learn from training rows (for example the median used to fill gaps) and apply the same to new data.",
  };
  return (
    <Modal title={`Add a ${STAGE_TITLES[stage].toLowerCase()} step`} onClose={onClose} wide>
      <p className="dim small" style={{ marginBottom: 12 }}>{intro[stage]}</p>
      <input placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: "100%", marginBottom: 12 }} autoFocus />
      <div className="picker-groups">
        <div className="picker-nav">
          {groups.map((g) => (
            <button key={g} className={!query && g === group ? "active" : ""} onClick={() => { setGroup(g); setQuery(""); }}>{g}</button>
          ))}
        </div>
        <div className="picker-list">
          {shown.map((op) => (
            <button key={op.id} className="picker-item" onClick={() => onPick(op)}>
              <b>{op.label}</b>
              <span className="dim small">{op.description}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function ModelPicker({ project, onPick, onClose }: { project: Project; onPick: (algo: AlgoDef) => void; onClose: () => void }) {
  const { catalogue, engine } = useApp();
  const list = project.kind === "image" ? catalogue.image_models : catalogue.models.filter((m) => m.tasks.includes(project.task));
  const families = [...new Set(list.map((m) => m.family))];
  return (
    <Modal title="Add a model" onClose={onClose} wide>
      <p className="dim small" style={{ marginBottom: 12 }}>Add several to compare them: every model trains on the same rows and is scored on the same test rows.</p>
      <div className="col" style={{ gap: 14 }}>
        {families.map((family) => (
          <div key={family}>
            <h3 className="section-title">{family}</h3>
            <div className="picker-list">
              {list.filter((m) => m.family === family).map((algo) => (
                <button key={algo.id} className="picker-item" disabled={!algo.available} onClick={() => onPick(algo)}>
                  <div className="row">
                    <b>{algo.label}</b>
                    {algo.deep && <span className="badge">deep learning</span>}
                  </div>
                  <span className="dim small">{algo.description}</span>
                  {!algo.available && <span className="warn-text tiny">Needs {algo.needs} in this engine{engine.kind === "browser" ? ": connect an engine" : ": install it from the Engine menu"}</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------- inspector

function stepColumns(preview: Preview | null, fallback: ColumnInfo[]): ColumnInfo[] {
  if (!preview) return fallback;
  return preview.columns.filter((c) => c.state !== "added").map((c) => ({ name: c.name, kind: c.kind }));
}

function Inspector({ api, selected, setSelected, preview, training }: { api: ProjectApi; selected: string; setSelected: (id: string) => void; preview: Preview | null; training: Training | null }) {
  const { catalogue, engine, fail } = useApp();
  const { project, update, issues, profile, run } = api;
  const raw: ColumnInfo[] = (profile?.columns ?? []).filter((c) => c.name !== project.target).map((c) => ({ name: c.name, kind: c.kind }));
  const issuesFor = (id: string, stage?: string) => issues.filter((i) => i.step === id || (!i.step && stage && i.stage === stage));
  const issueList = (id: string, stage?: string) =>
    issuesFor(id, stage).map((issue, i) => <Notice key={i} level={issue.level === "error" ? "error" : "warning"}>{issue.message}</Notice>);

  const stage = (["clean", "rows", "transform"] as StepStage[]).find((s) => project[s].some((x) => x.id === selected));
  if (stage) {
    const steps = project[stage];
    const index = steps.findIndex((s) => s.id === selected);
    const step = steps[index]!;
    const op = catalogue[stage].find((o) => o.id === step.op);
    const setSteps = (next: Step[]) => update((p) => ({ ...p, [stage]: next }));
    const columns = stage === "clean" ? stepColumns(preview, raw) : stepColumns(preview, raw);
    return (
      <>
        <div className="inspector-head">
          <span className="stage-kicker" style={{ color: STAGE_COLOURS[stage] }}>{STAGE_TITLES[stage].toUpperCase()} · STEP {index + 1}</span>
          <h2>{op?.label ?? step.op}</h2>
          <p className="dim small">{op?.description}</p>
          {step.note && <p className="small accent-text">Added because: {step.note}</p>}
          <div className="row">
            <Switch on={step.enabled} onChange={(on) => setSteps(steps.map((s) => (s.id === step.id ? { ...s, enabled: on } : s)))} label={step.enabled ? "On" : "Off"} />
            <span className="spacer" />
            <button className="ghost icon-only" disabled={index === 0} title="Run earlier" onClick={() => setSteps(move(steps, index, -1))}><Icon name="arrowUp" /></button>
            <button className="ghost icon-only" disabled={index === steps.length - 1} title="Run later" onClick={() => setSteps(move(steps, index, 1))}><Icon name="arrowDown" /></button>
            <button className="ghost icon-only danger" title="Remove step" onClick={() => { setSteps(steps.filter((s) => s.id !== step.id)); setSelected(stage === "transform" ? "auto_prep" : "dataset"); }}><Icon name="trash" /></button>
          </div>
        </div>
        <div className="inspector-body">
          {issueList(step.id)}
          {op && (
            <ParamForm
              owner={op.id}
              params={op.params}
              values={step.params}
              columns={columns}
              onChange={(name, value) => setSteps(steps.map((s) => (s.id === step.id ? { ...s, params: { ...s.params, [name]: value } } : s)))}
            />
          )}
        </div>
      </>
    );
  }

  const model = project.models.find((m) => m.id === selected);
  if (model) {
    const algo = (project.kind === "image" ? catalogue.image_models : catalogue.models).find((a) => a.id === model.algo);
    const setModel = (patch: Partial<ModelEntry>) => update((p) => ({ ...p, models: p.models.map((m) => (m.id === model.id ? { ...m, ...patch } : m)) }));
    const result = run?.models.find((m) => m.id === model.id);
    const live = training?.models.find((m) => m.id === model.id);
    const outputs = project.task === "classification" ? `${profile?.target?.n_classes ?? "k"} classes` : "1 value";
    return (
      <>
        <div className="inspector-head">
          <span className="stage-kicker" style={{ color: STAGE_COLOURS.models }}>MODEL · {algo?.family?.toUpperCase()}</span>
          <CommitInput value={model.label} onCommit={(label) => setModel({ label: label || algo?.label || model.label })} style={{ fontSize: 16, fontWeight: 600 }} />
          <p className="dim small">{algo?.description}</p>
          <div className="row">
            <Switch on={model.enabled} onChange={(on) => setModel({ enabled: on })} label={model.enabled ? "Will train" : "Skipped"} />
            <span className="spacer" />
            <button className="ghost small" title="Duplicate to compare settings" onClick={() => {
              engine.call<ModelEntry>("projects.new_model", { algo: model.algo, params: model.params, image: project.kind === "image" }).then((copy) => {
                update((p) => ({ ...p, models: [...p.models, { ...copy, label: `${model.label} (2)`, tune: model.tune }] }));
                setSelected(copy.id);
              }).catch(fail);
            }}><Icon name="copy" size={12} /> Duplicate</button>
            <button className="ghost icon-only danger" title="Remove model" onClick={() => { update((p) => ({ ...p, models: p.models.filter((m) => m.id !== model.id) })); setSelected("dataset"); }}><Icon name="trash" /></button>
          </div>
        </div>
        <div className="inspector-body">
          {issueList(model.id)}
          {live && live.status === "running" && live.epochs.length > 0 && <Notice level="info">Epoch {live.epochs.at(-1)?.epoch} of {live.totalEpochs}: loss {metricValue("loss", live.epochs.at(-1)?.loss)}</Notice>}
          {result?.status === "done" && (
            <div className="card tight" style={{ marginBottom: 12 }}>
              <div className="row small">
                <Icon name="trophy" className="accent-text" />
                <span>Last run: <b>{metricValue(run!.metric, result.metrics?.[run!.metric])}</b> {run!.metric_label}</span>
                <span className="spacer" />
                <button className="small" onClick={() => api.setTab("results")}>Details</button>
              </div>
            </div>
          )}
          {result?.status === "failed" && <Notice level="error">Last run failed: {result.error}</Notice>}
          {algo?.tunable && (
            <div className="field">
              <label>Automatic tuning</label>
              <Segmented value={model.tune} onChange={(tune) => setModel({ tune })} options={[{ value: "off", label: "Off" }, { value: "quick", label: "Quick (8 tries)" }, { value: "thorough", label: "Thorough (25)" }]} />
              <span className="help">Tries settings with 3-fold cross-validation on training rows and keeps the best. Your values below are the starting point.</span>
            </div>
          )}
          {algo && (
            <ParamForm owner={algo.id} params={algo.params} values={model.params} columns={raw} onChange={(name, value) => setModel({ params: { ...model.params, [name]: value } })} />
          )}
          {model.algo === "neural_network" && <p className="faint tiny">Output layer: {outputs}{project.task === "classification" ? " with softmax" : ", linear"}. Inputs are standardized automatically.</p>}
          {model.algo === "cnn" && <NetworkDiagram layers={(model.params.layers as Layer[]) ?? []} inputs="image" outputs={outputs} />}
        </div>
      </>
    );
  }

  if (selected === "split") {
    const s = project.split;
    const setSplit = (patch: Partial<Project["split"]>) => update((p) => ({ ...p, split: { ...p.split, ...patch } }));
    const dates = raw.filter((c) => c.kind === "datetime" || c.kind === "numeric");
    return (
      <>
        <div className="inspector-head">
          <span className="stage-kicker" style={{ color: STAGE_COLOURS.split }}>SPLIT</span>
          <h2>Train / test split</h2>
          <p className="dim small">Models learn from training rows and are scored on test rows they never saw, like an exam with new questions.</p>
        </div>
        <div className="inspector-body">
          {issueList("", "split")}
          <div className="field">
            <label>Test rows: {pct(s.test_size, 0)}</label>
            <div className="field-row">
              <input type="range" min={5} max={50} value={Math.round(s.test_size * 100)} onChange={(e) => setSplit({ test_size: Number(e.target.value) / 100 })} />
              <span className="num small">{Math.round((1 - s.test_size) * 100)} / {Math.round(s.test_size * 100)}</span>
            </div>
          </div>
          {project.kind === "tabular" && (
            <>
              <div className="field">
                <label>Order</label>
                <Segmented value={s.time_column ? "time" : "random"} onChange={(v) => setSplit({ time_column: v === "time" ? dates[0]?.name ?? null : null })} options={[{ value: "random", label: "Random" }, { value: "time", label: "By time (test = latest)" }]} />
                {s.time_column && (
                  <select value={s.time_column} onChange={(e) => setSplit({ time_column: e.target.value })} style={{ marginTop: 6 }}>
                    {dates.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                  </select>
                )}
                <span className="help">Use time order for forecasting, so the model is tested on the future, not the past.</span>
              </div>
              {!s.time_column && project.task === "classification" && <div className="field"><Switch on={s.stratify} onChange={(on) => setSplit({ stratify: on })} label="Keep class shares equal in both parts (stratify)" /></div>}
              <div className="field">
                <label>Cross-validation on training rows</label>
                <Segmented value={s.cv_folds} onChange={(cv_folds) => setSplit({ cv_folds })} options={[{ value: 0, label: "Off" }, { value: 3, label: "3 folds" }, { value: 5, label: "5 folds" }, { value: 10, label: "10" }]} />
                <span className="help">Trains each model several times on different slices to show how stable its score is (slower).</span>
              </div>
            </>
          )}
          <div className="field">
            <label>Random seed</label>
            <input type="number" value={s.seed} onChange={(e) => setSplit({ seed: Number(e.target.value) })} />
            <span className="help">The same seed gives the same split, so runs are comparable.</span>
          </div>
        </div>
      </>
    );
  }

  if (selected === "auto_prep") {
    return (
      <>
        <div className="inspector-head">
          <span className="stage-kicker" style={{ color: STAGE_COLOURS.transform }}>TRANSFORM · FINAL STEP</span>
          <h2>Auto-prep</h2>
          <p className="dim small">Makes the table model-ready after your transforms: numbers only, no gaps. Categories become one column per value (or frequencies when there are many), yes/no becomes 1/0, dates become year, month and weekday, and IDs are dropped. Models that need scaled inputs (linear, SVM, k-NN, neural networks) are also standardized when you have not added a Scale step.</p>
          <Switch on={project.auto_prep} onChange={(on) => update((p) => ({ ...p, auto_prep: on }))} label={project.auto_prep ? "On (recommended)" : "Off"} />
        </div>
        <div className="inspector-body">
          {preview?.report && preview.report.length > 0 && (
            <>
              <h3 className="section-title">What it will do</h3>
              {preview.report.map((r) => <div key={r.column} className="small" style={{ marginBottom: 4 }}><b>{r.column}</b>: <span className="dim">{r.detail}</span></div>)}
            </>
          )}
          {preview?.report?.length === 0 && <p className="dim small">Nothing to do: the table is already model-ready.</p>}
        </div>
      </>
    );
  }

  if (selected === "image_prep") {
    return (
      <>
        <div className="inspector-head">
          <span className="stage-kicker" style={{ color: STAGE_COLOURS.prep }}>IMAGE PREP</span>
          <h2>Resize & augment</h2>
          <p className="dim small">Every image is resized to a square. Augmentations show the network slightly changed copies while training, so it learns what matters rather than memorising pictures. Test images are never augmented.</p>
        </div>
        <div className="inspector-body">
          <ParamForm owner="image" params={catalogue.image_prep} values={project.image ?? {}} columns={[]} onChange={(name, value) => update((p) => ({ ...p, image: { ...(p.image ?? {}), [name]: value } }))} />
        </div>
      </>
    );
  }

  if (selected === "results") {
    return (
      <>
        <div className="inspector-head"><h2>Evaluate</h2><p className="dim small">Each model is scored on the test rows. The best one by {run?.metric_label ?? "the chosen metric"} is highlighted.</p></div>
        <div className="inspector-body">
          {run ? <button onClick={() => api.setTab("results")}><Icon name="trophy" /> Open results</button> : <p className="dim">Train to see scores.</p>}
        </div>
      </>
    );
  }

  // dataset
  return (
    <>
      <div className="inspector-head">
        <span className="stage-kicker" style={{ color: STAGE_COLOURS.data }}>DATA</span>
        <h2>{profile?.dataset.name ?? "Dataset"}</h2>
        <p className="dim small">{profile ? `${profile.rows.toLocaleString()} ${project.kind === "image" ? "images" : "rows"}` : ""}</p>
      </div>
      <div className="inspector-body">
        {issueList("", "data")}
        {project.kind === "tabular" && (
          <div className="field">
            <label>Target (what to predict)</label>
            <select value={project.target} onChange={(e) => update((p) => ({ ...p, target: e.target.value }))}>
              {(profile?.columns ?? []).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </div>
        )}
        <p className="small dim">Task: <b>{project.task}</b>. Change it, the metric and see column details on the Data page.</p>
        <button style={{ marginTop: 8 }} onClick={() => api.setTab("data")}><Icon name="database" /> Open Data</button>
        {project.notes && project.notes.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <h3 className="section-title">Set up for you</h3>
            {project.notes.map((note, i) => <p key={i} className="small dim" style={{ marginBottom: 6 }}>{note}</p>)}
          </div>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------- preview

function PreviewDrawer({ preview, loading, error, open, setOpen }: { preview: Preview | null; loading: boolean; error: string | null; open: boolean; setOpen: (open: boolean) => void }) {
  const states = new Map(preview?.columns.map((c) => [c.name, c]) ?? []);
  const removed = preview?.columns.filter((c) => c.state === "removed") ?? [];
  return (
    <div className={`preview-drawer ${open ? "" : "collapsed"}`}>
      <div className="preview-head">
        <button className="ghost small" onClick={() => setOpen(!open)}><Icon name={open ? "chevronDown" : "chevronRight"} size={12} /> Preview</button>
        {loading && <Spinner />}
        {preview && (
          <span className="small dim">
            after <b>{preview.title}</b>: {preview.after_shape[0].toLocaleString()} rows × {preview.after_shape[1]} columns
            {(preview.before_shape[0] !== preview.after_shape[0] || preview.before_shape[1] !== preview.after_shape[1]) &&
              ` (was ${preview.before_shape[0].toLocaleString()} × ${preview.before_shape[1]})`}
          </span>
        )}
        {preview?.note && <span className="small accent-text">{preview.note}</span>}
        {removed.length > 0 && <span className="small error-text">removed: {removed.map((c) => c.name).join(", ")}</span>}
        {error && <span className="small error-text">{error}</span>}
      </div>
      {open && preview && (
        <div className="preview-body">
          <table>
            <thead>
              <tr>
                {preview.header.map((h) => {
                  const state = states.get(h)?.state;
                  return <th key={h} className={state === "added" || state === "changed" ? state : ""}>{h} <KindBadge kind={states.get(h)?.kind ?? ""} />{state === "added" && <span className="ok-text tiny"> new</span>}{state === "changed" && <span className="warn-text tiny"> changed</span>}</th>;
                })}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((v, j) => {
                    const state = states.get(preview.header[j]!)?.state;
                    return <td key={j} className={`${state === "added" || state === "changed" ? state : ""} ${v === null ? "cell-null" : ""}`}>{v === null ? "empty" : cell(v)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------- the tab

export function PipelineTab({ api, training }: { api: ProjectApi; training: Training | null }) {
  const { engine, catalogue, fail } = useApp();
  const { project, update, issues, run } = api;
  const [selected, setSelected] = useState("dataset");
  const [adding, setAdding] = useState<NonNullable<PipeNode["addStage"]> | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const flow = useRef<ReactFlowInstance<Node<FlowData>, Edge> | null>(null);

  const select = useCallback((id: string) => {
    setSelected(id);
    setSheetOpen(true);
    if (id !== "dataset" && id !== "results") setDrawerOpen(true);
  }, []);

  /** Fit the pipeline, but never below a readable zoom: wide pipelines pan instead. */
  const fit = useCallback(async () => {
    const instance = flow.current;
    if (!instance) return;
    await instance.fitView({ padding: 0.08, maxZoom: 1 });
    const { x, y, zoom } = instance.getViewport();
    const floor = window.innerWidth < 760 ? 0.62 : 0.8;
    const top = 60; // room for the stage chips
    if (zoom < floor) instance.setViewport({ x: 28, y: top, zoom: floor });
    else if (y < top) instance.setViewport({ x, y: top, zoom });
  }, []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const results = useMemo(() => new Map((run?.models ?? []).map((m) => [m.id, m])), [run]);
  const live = useMemo(() => new Map((training?.running ? training.models : []).map((m) => [m.id, { status: m.status, progress: m.progress }])), [training]);
  const metric = run?.metric ?? (project.task === "classification" ? "f1_macro" : "r2");
  const graph = useMemo(() => buildGraph(project, catalogue, issues, results, metric, live), [project, catalogue, issues, results, metric, live]);

  const nodes: Node<FlowData>[] = useMemo(() => {
    const onAdd = (stage: NonNullable<PipeNode["addStage"]>) => setAdding(stage);
    const base = { subtitle: "", y: 0, selected: false, onAdd };
    const bands: Node<FlowData>[] = graph.stages.map((s) => ({
      id: `band-${s.id}`,
      type: "pipe",
      position: { x: s.x - 14, y: 30 },
      draggable: false,
      selectable: false,
      zIndex: -1,
      data: { ...base, id: `band-${s.id}`, kind: "results", stage: s.id, title: "", x: s.x, band: true, bandWidth: s.width + 28, bandHeight: s.height + 6 },
    }));
    const labels: Node<FlowData>[] = graph.stages.map((s) => ({
      id: `label-${s.id}`,
      type: "pipe",
      position: { x: s.x, y: 0 },
      draggable: false,
      selectable: false,
      data: { ...base, id: `label-${s.id}`, kind: "results", stage: s.id, title: STAGE_TITLES[s.id], x: s.x },
    }));
    const empty = new Set(graph.stages.filter((s) => s.empty).map((s) => s.id));
    return [
      ...bands,
      ...labels,
      ...graph.nodes.map((n) => ({ id: n.id, type: "pipe", position: { x: n.x, y: n.y }, draggable: false, data: { ...n, selected: n.id === selected, onAdd, narrow: empty.has(n.stage) } })),
    ];
  }, [graph, selected]);
  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        type: "smoothstep",
        animated: training?.running && (e.target === "results" || graph.nodes.find((n) => n.id === e.target)?.kind === "model"),
        style: { stroke: e.dashed ? "#2e333b" : "#4b525d", strokeWidth: 1.8, strokeDasharray: e.dashed ? "5 5" : undefined },
      })),
    [graph, training?.running],
  );

  // preview whatever is selected (tables only)
  useEffect(() => {
    if (project.kind !== "tabular") return;
    const previewable = selected === "dataset" || selected === "split" || selected === "auto_prep" || ["clean", "rows", "transform"].some((s) => project[s as StepStage].some((x) => x.id === selected));
    if (!previewable) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setLoading(true);
      engine
        .call<Preview>("projects.preview", { project, step_id: selected })
        .then((p) => {
          setPreview(p);
          setPreviewError(null);
        })
        .catch((error) => setPreviewError((error as Error).message))
        .finally(() => setLoading(false));
    }, 300);
  }, [engine, project, selected]);

  const addStep = async (op: OpDef) => {
    const stage = adding as StepStage;
    setAdding(null);
    try {
      const step = await engine.call<Step>("projects.new_step", { op: op.id });
      update((p) => {
        const list = p[stage];
        const at = list.findIndex((s) => s.id === selected);
        const next = [...list];
        next.splice(at >= 0 ? at + 1 : list.length, 0, step);
        return { ...p, [stage]: next };
      });
      select(step.id);
    } catch (error) {
      fail(error);
    }
  };

  const addModel = async (algo: AlgoDef) => {
    setAdding(null);
    try {
      const entry = await engine.call<ModelEntry>("projects.new_model", { algo: algo.id, image: project.kind === "image" });
      update((p) => ({ ...p, models: [...p.models, entry] }));
      select(entry.id);
    } catch (error) {
      fail(error);
    }
  };

  const errors = issues.filter((i) => i.level === "error" && !i.step);
  const jump = (stageX: number, width: number) => {
    const instance = flow.current;
    if (!instance) return;
    const { zoom } = instance.getViewport();
    const pane = document.querySelector(".canvas")?.getBoundingClientRect();
    instance.setViewport({ x: (pane?.width ?? 800) / 2 - (stageX + width / 2) * zoom, y: 60, zoom }, { duration: 350 });
  };
  return (
    <div className="pipeline">
      <div className="canvas">
        <div className="stage-chips" role="toolbar" aria-label="Jump to a stage">
          {graph.stages.map((stage) => (
            <button key={stage.id} className="small" onClick={() => jump(stage.x, stage.width)}>
              <i style={{ background: STAGE_COLOURS[stage.id] }} />
              {STAGE_TITLES[stage.id]}
            </button>
          ))}
        </div>
        {errors.length > 0 && (
          <div className="problems">
            {errors.slice(0, 3).map((issue, i) => <Notice key={i} level="error">{issue.message}</Notice>)}
          </div>
        )}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => node.data.kind !== "add" && !node.data.band && !node.id.startsWith("label-") && select(node.id)}
          onInit={(instance) => {
            flow.current = instance;
            requestAnimationFrame(() => void fit());
          }}
          minZoom={0.3}
          maxZoom={1.6}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background id="minor" variant={BackgroundVariant.Lines} gap={20} lineWidth={0.5} color="var(--paper-minor)" />
          <Background id="major" variant={BackgroundVariant.Lines} gap={100} lineWidth={1} color="var(--paper-major)" />
          <Controls showInteractive={false} onFitView={() => void fit()} />
        </ReactFlow>
      </div>
      <aside className={`inspector ${sheetOpen ? "open" : ""}`}>
        <div className="sheet-handle">
          <span />
          <button className="ghost small icon-only" style={{ position: "absolute", right: 8 }} onClick={() => setSheetOpen(false)} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <Inspector api={api} selected={selected} setSelected={select} preview={preview} training={training} />
      </aside>
      {project.kind === "tabular" && <PreviewDrawer preview={preview} loading={loading} error={previewError} open={drawerOpen} setOpen={setDrawerOpen} />}
      {adding && adding !== "models" && <StepPicker stage={adding} onPick={(op) => void addStep(op)} onClose={() => setAdding(null)} />}
      {adding === "models" && <ModelPicker project={project} onPick={(algo) => void addModel(algo)} onClose={() => setAdding(null)} />}
    </div>
  );
}
