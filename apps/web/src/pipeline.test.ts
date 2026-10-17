import { describe, expect, it } from "vitest";
import { buildGraph, move, summarize } from "./pipeline";
import { parseEngineLink } from "./engine/engine";
import type { Catalogue, Project } from "./types";

const catalogue = {
  clean: [{ id: "drop_columns", stage: "clean", group: "Columns", label: "Drop columns", description: "", params: [], rows: false }],
  rows: [],
  transform: [{ id: "impute", stage: "transform", group: "Missing values", label: "Fill missing values", description: "", rows: false,
    params: [{ name: "strategy", label: "Fill with", type: "select", default: "median", options: [{ value: "median", label: "Median" }] }] }],
  models: [{ id: "random_forest", label: "Random forest", tasks: ["classification"], family: "Trees", description: "", params: [], needs: null, available: true, deep: false }],
  image_models: [], image_prep: [], samples: [], metrics: { classification: [], regression: [] }, metric_labels: {},
} as unknown as Catalogue;

const project = {
  id: "p", name: "t", kind: "tabular", dataset_id: "d", target: "y", task: "classification", created: "", updated: "",
  clean: [{ id: "c1", op: "drop_columns", params: { columns: ["id"] }, enabled: true }],
  rows: [],
  transform: [{ id: "t1", op: "impute", params: { columns: ["@numeric"], strategy: "median" }, enabled: true }],
  auto_prep: true,
  split: { test_size: 0.2, stratify: true, shuffle: true, seed: 1, time_column: null, cv_folds: 5 },
  metric: "auto",
  models: [
    { id: "m1", algo: "random_forest", label: "Forest", params: {}, tune: "quick", enabled: true },
    { id: "m2", algo: "random_forest", label: "Forest 2", params: {}, tune: "off", enabled: false },
  ],
} as Project;

describe("buildGraph", () => {
  const { nodes, edges } = buildGraph(project, catalogue, [{ level: "error", stage: "models", message: "x", step: "m1" }], new Map(), "f1_macro", new Map());
  it("lays out every stage left to right", () => {
    const ids = nodes.map((n) => n.id);
    expect(ids).toEqual(["dataset", "c1", "add-clean", "split", "add-rows", "t1", "auto_prep", "add-transform", "m1", "m2", "add-models", "results"]);
    const x = (id: string) => nodes.find((n) => n.id === id)!.x;
    expect(x("dataset")).toBeLessThan(x("c1"));
    expect(x("split")).toBeLessThan(x("t1"));
    expect(x("t1")).toBe(x("auto_prep"));
  });
  it("connects stages and fans out to models", () => {
    const pairs = edges.map((e) => `${e.source}>${e.target}`);
    expect(pairs).toContain("dataset>c1");
    expect(pairs).toContain("c1>split");
    expect(pairs).toContain("split>t1"); // the empty training-rows stage is skipped
    expect(pairs).toContain("t1>auto_prep");
    expect(pairs).toContain("auto_prep>m1");
    expect(pairs).toContain("auto_prep>m2");
    expect(pairs).toContain("m1>results");
    expect(edges.find((e) => e.target === "m2")?.dashed).toBe(true);
  });
  it("marks issues and summarises steps", () => {
    expect(nodes.find((n) => n.id === "m1")?.level).toBe("error");
    expect(nodes.find((n) => n.id === "split")?.subtitle).toContain("5-fold CV");
    expect(nodes.find((n) => n.id === "m1")?.subtitle).toContain("tune quick");
    expect(summarize(project.transform[0]!, catalogue)).toBe("Median · all numbers");
  });
});

describe("helpers", () => {
  it("moves items", () => {
    expect(move([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(move([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
  });
  it("parses engine links", () => {
    expect(parseEngineLink("https://x.github.io/Synapse/#engine=http%3A%2F%2F127.0.0.1%3A8899&token=abc")).toEqual({ url: "http://127.0.0.1:8899", token: "abc" });
    expect(parseEngineLink("http://127.0.0.1:8899/?token=t1")).toEqual({ url: "http://127.0.0.1:8899", token: "t1" });
    expect(parseEngineLink("http://10.0.0.5:9000", "tok")).toEqual({ url: "http://10.0.0.5:9000", token: "tok" });
    expect(parseEngineLink("not a url")).toBeNull();
  });
});
