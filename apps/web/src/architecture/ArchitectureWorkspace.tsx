import { useEffect, useMemo, useState, type ReactNode } from "react";
import dagre from "@dagrejs/dagre";
import { Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { ApiError, type Api } from "../api";
import {
  UNASSIGNED_ID,
  archetypeFamily,
  cycleMembership,
  dependencyPairs,
  neighborIds,
  type AnalyseRequest,
  type ArchComponent,
  type ArchFinding,
  type ArchManifest,
  type ArchUnit,
  type Severity,
} from "./types";
import { Icon } from "../components/Icon";
import { PaperBackground } from "../components/PaperBackground";

const NODE_W = 250;
const NODE_H = 112;
const DECIDED_LABEL = { llm: "model", rule: "rules", cluster: "clustering" } as const;
const KIND_ICON: Record<ArchUnit["kind"], string> = {
  function: "ƒ",
  method: "m",
  class: "C",
  cell_block: "B",
  module_script: "S",
  route_handler: "R",
  config_block: "K",
};

type Selection = { kind: "component"; id: string } | { kind: "unit"; id: string } | { kind: "finding"; index: number } | null;

interface CardData extends Record<string, unknown> {
  component: ArchComponent;
  errors: number;
  warnings: number;
  highlighted: boolean;
  unassigned: boolean;
}

type CardNode = Node<CardData, "component">;

function message(error: unknown): string {
  return error instanceof ApiError ? error.message : String(error);
}

function ComponentCard({ data, selected }: NodeProps<CardNode>) {
  const c = data.component;
  const family = archetypeFamily(c.archetype);
  return (
    <div
      className={`arch-node fam-${data.unassigned ? "unassigned" : family} conf-${c.confidence} ${selected ? "selected" : ""} ${data.highlighted ? "highlighted" : ""}`}
      style={{ width: NODE_W, minHeight: NODE_H }}
      aria-label={`${c.name}, ${c.archetype}, ${c.units.length} units, ${c.confidence} confidence`}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="arch-node-head">
        <span className="arch-name" title={c.name}>
          {c.name}
        </span>
        {c.decided_by === "llm" && !data.unassigned && (
          <span className="chip model-chip" title="Named or regrouped by the model">
            <Icon name="spark" size={11} />
          </span>
        )}
      </div>
      <div className="arch-node-meta">
        <span className={`chip archetype fam-${data.unassigned ? "unassigned" : family}`}>{data.unassigned ? "unassigned" : c.archetype.replace(/_/g, " ")}</span>
        <span className="dim small">
          {c.units.length} units · {c.sloc} SLOC
        </span>
      </div>
      <div className="arch-node-resp" title={c.responsibility}>
        {c.responsibility}
      </div>
      <div className="arch-node-badges">
        {data.errors > 0 && <span className="badge-count error"><Icon name="error" size={10} /> {data.errors}</span>}
        {data.warnings > 0 && <span className="badge-count warning"><Icon name="warning" size={10} /> {data.warnings}</span>}
        {c.confidence !== "high" && <span className={`chip conf-${c.confidence}`}>{c.confidence} confidence</span>}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { component: ComponentCard };

function layout(components: ArchComponent[], pairs: [string, string][]): Record<string, { x: number; y: number }> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 80, marginx: 20, marginy: 20 });
  graph.setDefaultEdgeLabel(() => ({}));
  const placed = components.filter((c) => c.id !== UNASSIGNED_ID);
  for (const c of placed) graph.setNode(c.id, { width: NODE_W, height: NODE_H });
  for (const [dependent, dependency] of pairs) if (dependent !== dependency) graph.setEdge(dependent, dependency);
  dagre.layout(graph);
  const positions: Record<string, { x: number; y: number }> = {};
  for (const c of placed) {
    const node = graph.node(c.id) as { x: number; y: number } | undefined;
    positions[c.id] = node ? { x: node.x - NODE_W / 2, y: node.y - NODE_H / 2 } : { x: 0, y: 0 };
  }
  const extra = components.find((c) => c.id === UNASSIGNED_ID);
  if (extra) {
    const xs = Object.values(positions).map((p) => p.x);
    const ys = Object.values(positions).map((p) => p.y);
    positions[UNASSIGNED_ID] = { x: xs.length ? Math.min(...xs) : 0, y: (ys.length ? Math.max(...ys) : 0) + NODE_H + 72 };
  }
  return positions;
}

function unassignedComponent(manifest: ArchManifest): ArchComponent | null {
  if (!manifest.unassigned.length) return null;
  const members = manifest.units.filter((u) => manifest.unassigned.includes(u.id));
  return {
    id: UNASSIGNED_ID,
    name: "Unassigned",
    archetype: "utility",
    responsibility: "Units with no callers that are not an entry point, or that fit no component.",
    units: manifest.unassigned,
    public_surface: [],
    depends_on: [],
    files: [...new Set(members.map((u) => u.file))],
    spans: members.map((u) => ({ file: u.file, line_start: u.line_start, line_end: u.line_end })),
    sloc: members.reduce((n, u) => n + u.sloc, 0),
    confidence: "low",
    decided_by: "cluster",
    archetype_decided_by: "cluster",
    archetype_confidence: "low",
    reason: "Unassignable code stays unassigned (SEG-005).",
  };
}

export function ArchitectureWorkspace({ api, modeSwitch, onOpenFile }: { api: Api; modeSwitch: ReactNode; onOpenFile: (file: string) => void }) {
  const [manifest, setManifest] = useState<ArchManifest | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [severities, setSeverities] = useState<Record<Severity, boolean>>({ error: true, warning: true, info: false });
  const [modelOpen, setModelOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    api
      .architecture()
      .then(setManifest)
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.code === "NO_ARCHITECTURE") setMissing(true);
        else setError(message(e));
      });
  }, [api]);

  useEffect(
    () =>
      api.events((event) => {
        if (event.type !== "architecture_ready") return;
        api
          .architecture()
          .then((next) => {
            setManifest(next);
            setMissing(false);
          })
          .catch(() => undefined);
      }, () => undefined),
    [api],
  );

  async function run(body: AnalyseRequest): Promise<ArchManifest | null> {
    setBusy(body.use_llm ? "Naming with the model…" : "Analysing the project…");
    setError(null);
    try {
      const next = await api.analyseArchitecture(body);
      setManifest(next);
      setMissing(false);
      return next;
    } catch (e) {
      setError(message(e));
      return null;
    } finally {
      setBusy(null);
    }
  }

  const derived = useMemo(() => {
    if (!manifest) return null;
    const units = new Map(manifest.units.map((u) => [u.id, u]));
    const components = new Map(manifest.components.map((c) => [c.id, c]));
    const findingsByComponent = new Map<string, ArchFinding[]>();
    for (const f of manifest.findings) {
      const ids = new Set([f.component_id, f.unit_id ? units.get(f.unit_id)?.component_id : null, ...f.unit_ids.map((u) => units.get(u)?.component_id ?? null)]);
      for (const id of ids) if (id) findingsByComponent.set(id, [...(findingsByComponent.get(id) ?? []), f]);
    }
    const pairs = dependencyPairs(manifest.edges);
    const cycles = cycleMembership(manifest.components.map((c) => c.id), pairs);
    const layers = manifest.findings.filter((f) => f.code === "LAYER_VIOLATION");
    const leaks = manifest.findings.filter((f) => f.code === "LEAKAGE_FIT_BEFORE_SPLIT");
    const extra = unassignedComponent(manifest);
    const canvas = extra ? [...manifest.components, extra] : manifest.components;
    return { units, components, findingsByComponent, pairs, cycles, layers, leaks, extra, positions: layout(canvas, pairs) };
  }, [manifest]);

  const highlighted = useMemo(() => {
    const set = new Set<string>();
    if (!manifest || !derived) return set;
    if (selection?.kind === "finding") {
      const f = manifest.findings[selection.index];
      if (f?.component_id) set.add(f.component_id);
      for (const u of [f?.unit_id, ...(f?.unit_ids ?? [])]) {
        const owner = u ? derived.units.get(u)?.component_id : null;
        if (owner) set.add(owner);
        if (u && manifest.unassigned.includes(u)) set.add(UNASSIGNED_ID);
      }
    }
    if (selection?.kind === "component") {
      for (const id of neighborIds(selection.id, manifest.components)) set.add(id);
    }
    if (selection?.kind === "unit") {
      const owner = derived.units.get(selection.id)?.component_id;
      if (owner) for (const id of neighborIds(owner, manifest.components)) set.add(id);
      if (manifest.unassigned.includes(selection.id)) set.add(UNASSIGNED_ID);
    }
    return set;
  }, [manifest, derived, selection]);

  const selectedComponent =
    selection?.kind === "component"
      ? selection.id
      : selection?.kind === "unit"
        ? manifest?.unassigned.includes(selection.id)
          ? UNASSIGNED_ID
          : (derived?.units.get(selection.id)?.component_id ?? null)
        : null;

  const needle = query.trim().toLowerCase();
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);

  const nodes: CardNode[] =
    manifest && derived
      ? [...manifest.components, ...(derived.extra ? [derived.extra] : [])].map((c) => {
          const findings = derived.findingsByComponent.get(c.id) ?? [];
          return {
            id: c.id,
            type: "component",
            position: derived.positions[c.id] ?? { x: 0, y: 0 },
            selected: c.id === selectedComponent,
            data: {
              component: c,
              errors: findings.filter((f) => f.severity === "error").length,
              warnings: findings.filter((f) => f.severity === "warning").length,
              highlighted: highlighted.has(c.id),
              unassigned: c.id === UNASSIGNED_ID,
            },
          };
        })
      : [];

  const edges: Edge[] =
    manifest && derived
      ? manifest.edges.map((e) => {
          const [dependent] = e.kind === "call" ? [e.from] : [e.to];
          const sources = new Set(e.via.map((v) => v.split("→")[0]));
          const cycle = derived.cycles.has(e.from) && derived.cycles.get(e.from) === derived.cycles.get(e.to);
          const layer = derived.layers.some((f) => f.component_id === dependent && f.unit_ids.some((u) => sources.has(u)));
          const colour = cycle || layer ? "var(--red)" : e.kind === "call" ? "var(--edge)" : "var(--accent)";
          const dimmed = highlighted.size > 0 && !highlighted.has(e.from) && !highlighted.has(e.to);
          const marks = [cycle ? "cycle" : "", layer ? "layer" : "", e.observed ? "traced" : ""].filter(Boolean);
          return {
            id: `${e.from}->${e.to}:${e.kind}`,
            source: e.from,
            target: e.to,
            label: `${e.via.length} ${e.kind === "call" ? "call" : "flow"}${e.via.length === 1 ? "" : "s"}${marks.length ? ` · ${marks.join(" · ")}` : ""}`,
            style: {
              stroke: colour,
              strokeWidth: cycle || layer ? 2.2 : e.observed ? 2 : 1.4,
              strokeDasharray: e.kind === "dataflow" ? "6 4" : e.confidence === "low" ? "2 4" : undefined,
              opacity: dimmed ? 0.18 : 1,
            },
            labelStyle: { fill: cycle || layer ? "var(--red)" : "var(--text-dim)", fontSize: 11 },
            labelBgStyle: { fill: "var(--bg)", fillOpacity: 0.85 },
            markerEnd: { type: MarkerType.ArrowClosed, color: colour, width: 16, height: 16 },
          };
        })
      : [];

  const counts = manifest
    ? (["error", "warning", "info"] as Severity[]).map((s) => [s, manifest.findings.filter((f) => f.severity === s).length] as const)
    : [];

  return (
    <div className="app arch-app console-open">
      <header className="toolbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            <Icon name="logo" />
          </span>{" "}
          FlowLab {modeSwitch}
        </div>
        {manifest && (
          <div className="arch-stats small dim" title={`analysed ${new Date(manifest.analysed_at).toLocaleString()}`}>
            {manifest.stats.files} files · {manifest.stats.units} units · {manifest.stats.components} components · {manifest.stats.unassigned_units} unassigned
            {manifest.commit ? ` · ${manifest.commit}` : ""}
          </div>
        )}
        <div className="spacer" />
        {busy && <span className="small status-busy"><Icon name="dot" size={10} /> {busy}</span>}
        <button disabled={busy !== null} onClick={() => void run({ use_llm: false })} title="Static analysis only: no model, no tokens">
          {manifest ? "Re-analyse" : "Analyse project"}
        </button>
        <button className="primary" disabled={busy !== null || !manifest} onClick={() => setModelOpen(true)} title="Name components and write responsibilities with the model">
          <Icon name="spark" /> Name with model…
        </button>
      </header>

      <aside className="sidebar arch-sidebar">
        {manifest && derived ? (
          <>
            <section>
              <h2>Findings</h2>
              <input className="arch-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter components and findings…" aria-label="Filter architecture" />
              <div className="chip-row">
                {counts.map(([severity, count]) => (
                  <label key={severity} className={`chip toggle-chip sev-${severity} ${severities[severity] ? "on" : ""}`}>
                    <input type="checkbox" checked={severities[severity]} onChange={(e) => setSeverities((s) => ({ ...s, [severity]: e.target.checked }))} />
                    {severity} {count}
                  </label>
                ))}
              </div>
              <div className="arch-list">
                {manifest.findings.map((f, index) =>
                  severities[f.severity] && matches(`${f.code} ${f.message} ${f.law}`) ? (
                    <button key={index} className={`warning-row sev-${f.severity} ${selection?.kind === "finding" && selection.index === index ? "active" : ""}`} onClick={() => setSelection({ kind: "finding", index })}>
                      <span className="code">{f.code}</span>
                      <span className="arch-finding-text">{f.message}</span>
                    </button>
                  ) : null,
                )}
                {manifest.findings.length === 0 && <div className="dim small">No findings.</div>}
              </div>
            </section>
            <section>
              <h2>Components</h2>
              <div className="arch-list">
                {manifest.components.map((c) =>
                  matches(`${c.name} ${c.archetype} ${c.responsibility}`) ? (
                    <button key={c.id} className={`arch-row ${selectedComponent === c.id ? "active" : ""}`} onClick={() => setSelection({ kind: "component", id: c.id })}>
                      <span className="arch-row-name">{c.name}</span>
                      <span className={`chip archetype fam-${archetypeFamily(c.archetype)}`}>{c.archetype.replace(/_/g, " ")}</span>
                    </button>
                  ) : null,
                )}
              </div>
            </section>
            <section>
              <h2>Unassigned ({manifest.unassigned.length})</h2>
              <div className="arch-list">
                {manifest.unassigned.map((id) => {
                  const unit = derived.units.get(id);
                  return unit && matches(`${unit.qualified_name} ${unit.name} ${unit.file}`) ? (
                    <button key={id} className={`arch-row ${selection?.kind === "unit" && selection.id === id ? "active" : ""}`} onClick={() => setSelection({ kind: "unit", id })}>
                      <span className="kind-icon">{KIND_ICON[unit.kind]}</span>
                      <span className="arch-row-name mono">{unit.qualified_name}</span>
                    </button>
                  ) : null;
                })}
                {manifest.unassigned.length === 0 && <div className="dim small">Every unit belongs to a component.</div>}
              </div>
            </section>
          </>
        ) : (
          <section>
            <div className="dim small">Run an analysis to see the architecture of this project.</div>
          </section>
        )}
      </aside>

      <main className="workspace">
        {error && (
          <div className="banner warning" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>Dismiss</button>
          </div>
        )}
        {manifest && derived && derived.leaks.length > 0 && (
          <div className="banner warning arch-leak-banner" role="alert">
            <span>
              {derived.leaks.length} leakage finding{derived.leaks.length === 1 ? "" : "s"}: a transformer is fitted before the train/test split.
            </span>
            <button onClick={() => setSelection({ kind: "finding", index: manifest.findings.indexOf(derived.leaks[0]!) })}>
              Show
            </button>
          </div>
        )}
        {!manifest && (
          <div className="placeholder arch-empty">
            <h2>Architecture</h2>
            <p className="dim">
              FlowLab decomposes this project into <strong>components</strong> (cohesive groups with one responsibility) and <strong>units</strong> (functions, classes, cells). The analysis is static and local; nothing is sent anywhere.
            </p>
            {missing && (
              <button className="primary" disabled={busy !== null} onClick={() => void run({ use_llm: false })}>
                Analyse project
              </button>
            )}
          </div>
        )}
        {manifest && (
          <section className="canvas-pane">
            <ReactFlow
              key={manifest.analysed_at}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
              minZoom={0.05}
              nodesConnectable={false}
              onNodeClick={(_, node) => setSelection({ kind: "component", id: node.id })}
              onPaneClick={() => setSelection(null)}
              proOptions={{ hideAttribution: true }}
              colorMode="dark"
            >
              <PaperBackground />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable maskColor="rgba(1,4,9,0.6)" />
            </ReactFlow>
            <div className="arch-legend small">
              <span>— call</span>
              <span className="legend-flow">- - data flow</span>
              <span className="legend-bad">— cycle or layer violation</span>
              <span className="legend-traced">thick = traced (observed)</span>
              <span>dashed border = low confidence</span>
            </div>
          </section>
        )}
      </main>

      <aside className="inspector">
        {manifest && derived ? (
          <ArchInspector api={api} manifest={manifest} derived={derived} selection={selection} onSelect={setSelection} onOpenFile={onOpenFile} />
        ) : (
          <div className="panel dim">No analysis yet.</div>
        )}
      </aside>

      <section className="console arch-console">
        <div className="console-head">
          <span className="small">Model</span>
          {manifest && (
            <span className={`small run-status-${manifest.llm.status === "used" ? "completed" : manifest.llm.status === "skipped" ? "completed" : "failed"}`}>
              {manifest.llm.status} · {manifest.llm.tokens_used.toLocaleString()} tokens · {manifest.llm.calls} calls · {manifest.llm.cached_calls} cached
              {manifest.llm.estimated_tokens ? ` · estimated ${manifest.llm.estimated_tokens.toLocaleString()}` : ""}
            </span>
          )}
        </div>
        <div className="console-body">
          {manifest?.llm.notes.map((note, i) => (
            <div key={i} className="console-line info">
              <span className="text">{note}</span>
            </div>
          ))}
        </div>
      </section>

      {modelOpen && manifest && <ModelDialog onClose={() => setModelOpen(false)} onRun={run} />}
    </div>
  );
}

interface Derived {
  units: Map<string, ArchUnit>;
  components: Map<string, ArchComponent>;
  findingsByComponent: Map<string, ArchFinding[]>;
  extra: ArchComponent | null;
  leaks: ArchFinding[];
}

function ArchInspector({
  api,
  manifest,
  derived,
  selection,
  onSelect,
  onOpenFile,
}: {
  api: Api;
  manifest: ArchManifest;
  derived: Derived;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onOpenFile: (file: string) => void;
}) {
  if (selection?.kind === "finding") {
    const f = manifest.findings[selection.index];
    if (!f) return null;
    const component = f.component_id ? derived.components.get(f.component_id) : undefined;
    return (
      <div className="inspector-body">
        <h2>{f.code}</h2>
        <div className="chip-row">
          <span className={`chip sev-chip sev-${f.severity}`}>{f.severity}</span>
          <span className="chip mono">{f.law}</span>
        </div>
        <p>{f.message}</p>
        {component && (
          <button className="chip link" onClick={() => onSelect({ kind: "component", id: component.id })}>
            {component.name}
          </button>
        )}
        {f.file && (
          <button className="link-button" onClick={() => onOpenFile(f.file!)} disabled={!/\.(py|ipynb)$/.test(f.file)}>
            {f.file}
            {f.line ? `:${f.line}` : ""} → open in Code Mode
          </button>
        )}
        {[f.unit_id, ...f.unit_ids].filter(Boolean).length > 0 && (
          <>
            <h3>Units</h3>
            <UnitList ids={[...new Set([f.unit_id, ...f.unit_ids].filter((u): u is string => Boolean(u)))]} derived={derived} onSelect={onSelect} />
          </>
        )}
      </div>
    );
  }

  if (selection?.kind === "unit") {
    const unit = derived.units.get(selection.id);
    if (!unit) return null;
    const component = unit.component_id ? derived.components.get(unit.component_id) : undefined;
    return (
      <div className="inspector-body">
        <h2 className="mono">{unit.name}</h2>
        <div className="chip-row">
          <span className="chip">{unit.kind.replace(/_/g, " ")}</span>
          {unit.entry_point && <span className="chip">entry point</span>}
          <span className={`chip conf-${unit.confidence}`}>{unit.confidence} confidence</span>
          {unit.archetype_hint && <span className="chip">looks like {unit.archetype_hint.replace(/_/g, " ")}</span>}
        </div>
        <dl className="stats">
          <dt>Qualified name</dt>
          <dd className="wrap">{unit.qualified_name}</dd>
          <dt>Location</dt>
          <dd>
            {unit.file}:{unit.line_start}-{unit.line_end}
          </dd>
          {unit.signature && (
            <>
              <dt>Signature</dt>
              <dd className="wrap">{unit.signature}</dd>
            </>
          )}
          <dt>Size</dt>
          <dd>
            {unit.sloc} SLOC · complexity {unit.complexity}
          </dd>
          <dt>Component</dt>
          <dd>
            {component ? (
              <button className="chip link" onClick={() => onSelect({ kind: "component", id: component.id })}>
                {component.name}
              </button>
            ) : (
              "unassigned"
            )}
          </dd>
        </dl>
        {unit.docstring_first_line && <p className="dim">{unit.docstring_first_line}</p>}
        <button className="primary" onClick={() => onOpenFile(unit.file)}>
          Open {unit.file} in Code Mode
        </button>
        {unit.side_effects.length > 0 && (
          <>
            <h3>Side effects</h3>
            <div className="chip-row">
              {unit.side_effects.map((s) => (
                <span key={s} className="chip warn">
                  {s}
                </span>
              ))}
            </div>
          </>
        )}
        {unit.calls.length > 0 && (
          <>
            <h3>Calls</h3>
            <div className="chip-row">
              {unit.calls.slice(0, 24).map((c) => (
                <code key={c} className="chip">
                  {c}
                </code>
              ))}
            </div>
          </>
        )}
        {unit.tests.length > 0 && (
          <>
            <h3>Tests</h3>
            <ul className="small tips">
              {unit.tests.map((t) => (
                <li key={t} className="mono">
                  {t}
                </li>
              ))}
            </ul>
          </>
        )}
        <FeedbackForm api={api} target={{ unit_id: unit.id }} />
      </div>
    );
  }

  if (selection?.kind === "component") {
    if (selection.id === UNASSIGNED_ID) {
      return (
        <div className="inspector-body">
          <h2>Unassigned</h2>
          <p className="dim small">Dead, unreachable, or uncategorisable units stay here rather than being forced into a neighbour (SEG-005, SEG-068).</p>
          <UnitList ids={manifest.unassigned} derived={derived} onSelect={onSelect} />
          {manifest.unassigned[0] && <FeedbackForm api={api} target={{ unit_id: manifest.unassigned[0] }} />}
        </div>
      );
    }
    const c = derived.components.get(selection.id);
    if (!c) return null;
    const usedBy = manifest.components.filter((other) => other.depends_on.includes(c.id));
    const findings = derived.findingsByComponent.get(c.id) ?? [];
    return (
      <div className="inspector-body">
        <h2>{c.name}</h2>
        <div className="chip-row">
          <span className={`chip archetype fam-${archetypeFamily(c.archetype)}`}>{c.archetype.replace(/_/g, " ")}</span>
          <span className="chip" title="Who decided the archetype (SEG-071)">
            archetype by {DECIDED_LABEL[c.archetype_decided_by]} · {c.archetype_confidence}
          </span>
          <span className={`chip conf-${c.confidence}`}>{c.confidence} confidence</span>
          <span className={`chip ${c.decided_by === "llm" ? "model-chip" : ""}`}>grouped by {DECIDED_LABEL[c.decided_by]}</span>
        </div>
        <p className="arch-responsibility">{c.responsibility}</p>
        <p className="dim small">{c.reason}</p>
        <dl className="stats">
          <dt>Units</dt>
          <dd>
            {c.units.length} ({c.public_surface.length} public)
          </dd>
          <dt>SLOC</dt>
          <dd>{c.sloc}</dd>
        </dl>
        {c.depends_on.length > 0 && (
          <>
            <h3>Depends on</h3>
            <div className="chip-row">
              {c.depends_on.map((id) => (
                <button key={id} className="chip link" onClick={() => onSelect({ kind: "component", id })}>
                  {derived.components.get(id)?.name ?? id}
                </button>
              ))}
            </div>
          </>
        )}
        {usedBy.length > 0 && (
          <>
            <h3>Used by</h3>
            <div className="chip-row">
              {usedBy.map((other) => (
                <button key={other.id} className="chip link" onClick={() => onSelect({ kind: "component", id: other.id })}>
                  {other.name}
                </button>
              ))}
            </div>
          </>
        )}
        {findings.length > 0 && (
          <>
            <h3>Findings</h3>
            {findings.map((f, i) => (
              <button key={i} className={`warning-row sev-${f.severity}`} onClick={() => onSelect({ kind: "finding", index: manifest.findings.indexOf(f) })}>
                <span className="code">{f.code}</span>
                <span>{f.message}</span>
              </button>
            ))}
          </>
        )}
        <h3>Units</h3>
        <UnitList ids={c.units} derived={derived} onSelect={onSelect} publicIds={new Set(c.public_surface)} />
        <h3>Files</h3>
        <ul className="small tips">
          {c.spans.map((s) => (
            <li key={s.file}>
              <button className="link-button mono" onClick={() => onOpenFile(s.file)}>
                {s.file}:{s.line_start}-{s.line_end}
              </button>
            </li>
          ))}
        </ul>
        <FeedbackForm api={api} target={{ component_id: c.id }} />
      </div>
    );
  }

  const byArchetype = new Map<string, number>();
  for (const c of manifest.components) byArchetype.set(c.archetype, (byArchetype.get(c.archetype) ?? 0) + 1);
  return (
    <div className="inspector-body">
      <h2>Architecture overview</h2>
      <dl className="stats">
        <dt>Components</dt>
        <dd>{manifest.stats.components}</dd>
        <dt>Units</dt>
        <dd>{manifest.stats.units}</dd>
        <dt>Unassigned</dt>
        <dd>{manifest.stats.unassigned_units}</dd>
        <dt>Source lines</dt>
        <dd>{manifest.stats.sloc.toLocaleString()}</dd>
        <dt>Clustering</dt>
        <dd>{manifest.stats.clustering}</dd>
      </dl>
      <h3>Archetypes</h3>
      <div className="chip-row">
        {[...byArchetype.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([archetype, count]) => (
            <span key={archetype} className={`chip archetype fam-${archetypeFamily(archetype)}`}>
              {archetype.replace(/_/g, " ")} {count}
            </span>
          ))}
      </div>
      <h3>How to read this</h3>
      <ul className="small tips">
        <li>Each card is a component: units that share one responsibility. Click one to see its units and why they were grouped.</li>
        <li>Solid arrows are calls, dashed arrows are data handed from one component to another. Red arrows are dependency cycles or layer violations.</li>
        <li>Low-confidence components have a dashed border. The spark icon marks names or groupings suggested by the model; everything else is static analysis.</li>
        <li>Leakage findings (a transformer fitted before the train/test split) are the most important results.</li>
      </ul>
    </div>
  );
}

function UnitList({ ids, derived, onSelect, publicIds }: { ids: string[]; derived: Derived; onSelect: (s: Selection) => void; publicIds?: Set<string> }) {
  return (
    <div className="arch-units">
      {ids.map((id) => {
        const unit = derived.units.get(id);
        if (!unit) return null;
        return (
          <button key={id} className="arch-unit" onClick={() => onSelect({ kind: "unit", id })} title={unit.qualified_name}>
            <span className="kind-icon" title={unit.kind}>
              {KIND_ICON[unit.kind]}
            </span>
            <span className="mono arch-unit-name">{unit.name}</span>
            {publicIds?.has(id) && (
              <span className="public-star" title="Public surface: used from outside this component">
                <Icon name="star" size={10} />
              </span>
            )}
            {unit.tests.length > 0 && <span className="chip">{unit.tests.length} test{unit.tests.length === 1 ? "" : "s"}</span>}
            <span className="dim small arch-unit-where">
              {unit.file.split("/").pop()}:{unit.line_start}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function FeedbackForm({ api, target }: { api: Api; target: { component_id?: string; unit_id?: string } }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  if (!open) {
    return (
      <button className="link-button arch-feedback-toggle" onClick={() => setOpen(true)}>
        Report incorrect segregation…
      </button>
    );
  }
  return (
    <form
      className="arch-feedback"
      onSubmit={(e) => {
        e.preventDefault();
        api
          .architectureFeedback({ ...target, correction: text })
          .then((saved) => {
            setStatus(`Saved on this machine to ${saved.path} (identifiers are anonymised).`);
            setText("");
          })
          .catch((err: unknown) => setStatus(message(err)));
      }}
    >
      <label htmlFor="arch-correction" className="small">
        What is wrong, and where should it go?
      </label>
      <textarea id="arch-correction" rows={3} value={text} minLength={3} maxLength={1000} onChange={(e) => setText(e.target.value)} />
      <div className="button-row">
        <button type="submit" className="primary" disabled={text.trim().length < 3}>
          Save report
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {status && <div className="small dim">{status}</div>}
    </form>
  );
}

function ModelDialog({ onClose, onRun }: { onClose: () => void; onRun: (body: AnalyseRequest) => Promise<ArchManifest | null> }) {
  const [consent, setConsent] = useState(false);
  const [maxTokens, setMaxTokens] = useState(60000);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [running, setRunning] = useState(false);

  async function go(allowOverBudget: boolean) {
    setRunning(true);
    const next = await onRun({ use_llm: true, confirm_external: true, max_tokens: maxTokens, allow_over_budget: allowOverBudget });
    setRunning(false);
    if (!next) return;
    if (next.llm.status === "over_budget") setEstimate(next.llm.estimated_tokens);
    else onClose();
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal arch-model-dialog" role="dialog" aria-label="Name components with the model" onMouseDown={(e) => e.stopPropagation()}>
        <h2><Icon name="spark" /> Name components with the model</h2>
        <p className="small">
          The model receives <strong>cluster fingerprints</strong> only: unit names and kinds, signatures cut to 100 characters, first docstring lines, imported library names and edge counts. Never function bodies, tests, data or notebook outputs, and credential-looking strings are masked first.
        </p>
        <p className="small dim">It may rename components, write their responsibilities and suggest boundary changes; every change is validated against the segregation laws and anything invalid is discarded.</p>
        <label className="toggle">
          Token budget <input type="number" min={1000} max={500000} step={1000} value={maxTokens} onChange={(e) => setMaxTokens(Math.max(1000, Number(e.target.value) || 60000))} />
        </label>
        <label className="toggle consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Allow sending these fingerprints to Groq
        </label>
        {estimate !== null && (
          <div className="banner-inline">
            This project needs about <strong>{estimate.toLocaleString()}</strong> tokens, above your budget of {maxTokens.toLocaleString()}. No call was made.
          </div>
        )}
        <div className="button-row end">
          <button onClick={onClose}>Cancel</button>
          {estimate !== null ? (
            <button className="primary" disabled={!consent || running} onClick={() => void go(true)}>
              {running ? "Running…" : `Run anyway (~${estimate.toLocaleString()} tokens)`}
            </button>
          ) : (
            <button className="primary" disabled={!consent || running} onClick={() => void go(false)}>
              {running ? "Running…" : "Name components"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
