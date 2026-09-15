import { describe, expect, it } from "vitest";
import {
  EMPTY_HISTORY,
  addNode,
  applyRunEvent,
  autoConnect,
  checkConnection,
  columnsFor,
  connect,
  copySelection,
  indexCatalogue,
  layoutFlow,
  outdatedNodes,
  paste,
  record,
  redo,
  removeElements,
  renameNode,
  statesFromManifest,
  undo,
  wouldCycle,
} from "./model";
import type { Catalogue, CatalogueNode, CompilePayload, FlowSpec, RunEvent, RunManifest } from "./types";

function node(type: string, inputs: CatalogueNode["inputs"], outputs: CatalogueNode["outputs"]): CatalogueNode {
  return { type, title: type, category: type.split(".")[0] ?? type, description: "", inputs, outputs, params_schema: {}, flags: {} };
}

const catalogue: Catalogue = {
  catalogue_version: "1",
  nodes: [
    node("source.dataset", {}, { out: { types: ["table"], description: "" } }),
    node("prep.split", { in: { types: ["table"], required: true, description: "" } }, { out: { types: ["table_split"], description: "" } }),
    node("prep.scale", { in: { types: ["table", "table_split"], required: true, description: "" } }, { out: { types: ["table", "table_split"], description: "" } }),
    node("model.fit", { train: { types: ["table", "table_split"], required: true, description: "" } }, { model: { types: ["model"], description: "" } }),
    node(
      "model.evaluate",
      { model: { types: ["model"], required: true, description: "" }, data: { types: ["table", "table_split"], required: true, description: "" } },
      { metrics: { types: ["metrics"], description: "" } },
    ),
  ],
};
const index = indexCatalogue(catalogue);

function flow(): FlowSpec {
  return {
    spec_version: "1.0",
    flow_id: "f",
    name: "f",
    dataset_bindings: { primary: "churn" },
    nodes: [
      { id: "src", type: "source.dataset", params: { dataset_ref: "primary" }, position: { x: 0, y: 0 } },
      { id: "split", type: "prep.split", params: {}, position: { x: 300, y: 0 } },
      { id: "fit", type: "model.fit", params: {}, position: { x: 600, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "src", source_port: "out", target: "split", target_port: "in" },
      { id: "e2", source: "split", source_port: "out", target: "fit", target_port: "train" },
    ],
  };
}

describe("connection rules", () => {
  it("refuses incompatible types with a readable reason", () => {
    const result = checkConnection(flow(), index, { source: "fit", sourcePort: "model", target: "split", targetPort: "in" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/produces model.*accepts table/);
  });

  it("refuses a second edge into an occupied input", () => {
    const result = checkConnection(flow(), index, { source: "src", sourcePort: "out", target: "fit", targetPort: "train" });
    expect(!result.ok && result.reason).toMatch(/already connected to split/);
  });

  it("refuses cycles and self loops", () => {
    let spec = flow();
    spec = addNode(spec, index.get("prep.scale")!, { x: 900, y: 0 }).spec;
    spec = connect(spec, { source: "split", sourcePort: "out", target: "scale", targetPort: "in" });
    expect(wouldCycle(spec.edges, "scale", "split")).toBe(true);
    expect(checkConnection(spec, index, { source: "scale", sourcePort: "out", target: "scale", targetPort: "in" }).ok).toBe(false);
  });

  it("accepts a valid connection", () => {
    const spec = removeElements(flow(), new Set(), new Set(["e2"]));
    expect(checkConnection(spec, index, { source: "split", sourcePort: "out", target: "fit", targetPort: "train" })).toEqual({ ok: true });
  });
});

describe("editing", () => {
  it("adds nodes with unique ids and auto-connects to the nearest compatible upstream output", () => {
    const added = addNode(flow(), index.get("model.evaluate")!, { x: 900, y: 10 });
    expect(added.nodeId).toBe("evaluate");
    const wired = autoConnect(added.spec, index, added.nodeId);
    expect(wired.edges.at(-1)).toMatchObject({ source: "fit", source_port: "model", target: "evaluate", target_port: "model" });
    const again = addNode(wired, index.get("model.evaluate")!, { x: 900, y: 200 });
    expect(again.nodeId).toBe("evaluate_2");
  });

  it("does not auto-connect to nodes to the right of the drop point", () => {
    const added = addNode(flow(), index.get("prep.scale")!, { x: -400, y: 0 });
    expect(autoConnect(added.spec, index, added.nodeId).edges).toHaveLength(2);
  });

  it("removing a node removes its edges", () => {
    const spec = removeElements(flow(), new Set(["split"]), new Set());
    expect(spec.nodes.map((n) => n.id)).toEqual(["src", "fit"]);
    expect(spec.edges).toEqual([]);
  });

  it("renames ids everywhere and rejects collisions", () => {
    const renamed = renameNode(flow(), "split", "holdout")!;
    expect(renamed.edges.map((e) => `${e.source}>${e.target}`)).toEqual(["src>holdout", "holdout>fit"]);
    expect(renameNode(flow(), "split", "fit")).toBeNull();
    expect(renameNode(flow(), "split", "bad id")).toBeNull();
  });

  it("copy/paste duplicates nodes and internal edges with fresh ids", () => {
    const clip = copySelection(flow(), new Set(["split", "fit"]))!;
    const pasted = paste(flow(), clip);
    expect(pasted.nodeIds).toEqual(["split_2", "fit_2"]);
    expect(pasted.spec.edges.at(-1)).toMatchObject({ source: "split_2", target: "fit_2" });
  });

  it("undo and redo walk the history", () => {
    const first = flow();
    const second = removeElements(first, new Set(["fit"]), new Set());
    const history = record(EMPTY_HISTORY, first);
    const undone = undo(history, second)!;
    expect(undone.spec).toBe(first);
    const redone = redo(undone.history, undone.spec)!;
    expect(redone.spec).toBe(second);
    expect(undo(EMPTY_HISTORY, first)).toBeNull();
  });

  it("layout orders nodes left to right along edges", () => {
    const shuffled = { ...flow(), nodes: flow().nodes.map((n) => ({ ...n, position: { x: 0, y: 0 } })) };
    const laid = layoutFlow(shuffled, index);
    const x = Object.fromEntries(laid.nodes.map((n) => [n.id, n.position.x]));
    expect(Number(x.src)).toBeLessThan(Number(x.split));
    expect(Number(x.split)).toBeLessThan(Number(x.fit));
  });
});

describe("run state", () => {
  const event = (type: RunEvent["type"], node_id: string | null = null, payload: Record<string, unknown> = {}): RunEvent => ({
    run_id: "r",
    seq: 0,
    type,
    ts: "",
    node_id,
    payload,
  });

  it("folds live events into node states", () => {
    const order = ["src", "split", "fit"];
    let states = applyRunEvent({}, event("run_started"), order);
    expect(states).toEqual({ src: "queued", split: "queued", fit: "queued" });
    states = applyRunEvent(states, event("node_started", "src"), order);
    states = applyRunEvent(states, event("node_completed", "src", { cache_hit: true }), order);
    states = applyRunEvent(states, event("node_started", "split"), order);
    states = applyRunEvent(states, event("node_warning", "split"), order);
    states = applyRunEvent(states, event("node_completed", "split", { cache_hit: false }), order);
    states = applyRunEvent(states, event("node_started", "fit"), order);
    states = applyRunEvent(states, event("node_failed", "fit"), order);
    expect([states.src, states.split, states.fit]).toEqual(["cached", "warning", "error"]);
  });

  it("marks unfinished nodes skipped when a run is cancelled", () => {
    const states = applyRunEvent({ src: "success", split: "running", fit: "queued" }, event("run_cancelled"), []);
    expect(states).toEqual({ src: "success", split: "skipped", fit: "skipped" });
  });

  it("derives states from a manifest and detects outdated nodes", () => {
    const manifest = {
      nodes: [
        { node_id: "src", status: "cached", cache_key: "a", warnings: [] },
        { node_id: "split", status: "success", cache_key: "b", warnings: [{ code: "W", message: "" }] },
        { node_id: "fit", status: "failed", cache_key: "c", warnings: [] },
      ],
    } as unknown as RunManifest;
    expect(statesFromManifest(manifest)).toEqual({ src: "cached", split: "warning", fit: "error" });
    const compile = { ok: true, cache_keys: { src: "a", split: "b2", fit: "c" } } as unknown as CompilePayload;
    expect([...outdatedNodes(compile, manifest)]).toEqual(["split"]);
  });

  it("offers input columns to pickers, or output columns for sources", () => {
    const table = (name: string) => ({ kind: "table" as const, table: { columns: [{ name, dtype: "int", role: "feature" as const, semantic: "numeric_discrete" }] } });
    const compile = {
      schemas: { src: { inputs: {}, outputs: { out: table("a") } }, split: { inputs: { in: table("b") }, outputs: {} } },
    } as unknown as CompilePayload;
    expect(columnsFor(compile, "src")?.[0]?.name).toBe("a");
    expect(columnsFor(compile, "split")?.[0]?.name).toBe("b");
    expect(columnsFor(compile, "missing")).toBeNull();
  });
});
