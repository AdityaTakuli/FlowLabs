import { describe, expect, it } from "vitest";
import { NODE_HEIGHT, edgeValueLabel, formatBytes, formatDuration, layoutGraph, layoutWithRoutes, neighbourhood, smoothPath, variableMatches, visibleEdges } from "./layout";
import type { CodeEdge, CodeGraph, CodeNode } from "./types";

function node(id: string, defines: string[] = [], uses: string[] = []): CodeNode {
  return {
    id, kind: "code", file: "a.py", cell_index: null, lines: [1, 1], source: "", source_hash: "", label: id,
    defines, uses, mutates: [], imports: [], calls: [], side_effects: [], conditional_defines: [], loop_carried: [],
    flags: [], matched_pattern: null, confidence: "high", execution_count: null, group: null,
  };
}

const edges: CodeEdge[] = [
  { from: "b1", to: "b2", variable: "pd", kind: "import", confidence: "high" },
  { from: "b2", to: "b3", variable: "df", kind: "dataflow", confidence: "high" },
  { from: "b2", to: "b3", variable: "cols", kind: "dataflow", confidence: "medium" },
  { from: "b3", to: "b4", variable: "clean", kind: "dataflow", confidence: "high" },
];
const graph: CodeGraph = {
  graph_version: "1.0",
  source: { kind: "script", files: [{ path: "a.py", hash: "" }] },
  nodes: [node("b1", ["pd"]), node("b2", ["df", "cols"], ["pd"]), node("b3", ["clean"], ["df", "cols"]), node("b4", [], ["clean"]), node("b5", ["other"])],
  edges,
  warnings: [],
  analysis_ms: 1,
};

describe("layout", () => {
  it("places dependencies top to bottom", () => {
    const positions = layoutGraph(graph.nodes, visibleEdges(graph, false));
    expect(positions.b2!.y).toBeLessThan(positions.b3!.y);
    expect(positions.b3!.y).toBeLessThan(positions.b4!.y);
    expect(Object.keys(positions)).toHaveLength(5);
  });

  it("routes edges with label boxes between the blocks they connect", () => {
    const { positions, routes } = layoutWithRoutes(graph.nodes, visibleEdges(graph, false));
    const route = routes["b2>b3"]!;
    expect(route.points.length).toBeGreaterThanOrEqual(3);
    expect(route.label.y).toBeGreaterThan(positions.b2!.y + NODE_HEIGHT);
    expect(route.label.y).toBeLessThan(positions.b3!.y);
    expect(Object.keys(routes).sort()).toEqual(["b2>b3", "b3>b4"]);
  });

  it("draws a smooth path through route points", () => {
    const path = smoothPath([{ x: 0, y: 0 }, { x: 10, y: 50 }, { x: 0, y: 100 }]);
    expect(path.startsWith("M 0,0")).toBe(true);
    expect(path.match(/ C /g)).toHaveLength(2);
    expect(path.endsWith("0,100")).toBe(true);
    expect(smoothPath([{ x: 1, y: 1 }])).toBe("");
  });

  it("hides import edges by default and merges variables between the same blocks", () => {
    const shown = visibleEdges(graph, false);
    expect(shown.map((e) => `${e.from}>${e.to}`)).toEqual(["b2>b3", "b3>b4"]);
    expect(shown[0]!.variables).toEqual(["df", "cols"]);
    expect(shown[0]!.confidence).toBe("medium");
    expect(visibleEdges(graph, true)).toHaveLength(3);
  });

  it("focus mode keeps ancestors and descendants", () => {
    expect([...neighbourhood(graph, "b3")].sort()).toEqual(["b1", "b2", "b3", "b4"]);
    expect([...neighbourhood(graph, "b5")]).toEqual(["b5"]);
  });

  it("variable search finds definers and consumers", () => {
    expect([...variableMatches(graph, "clean")].sort()).toEqual(["b3", "b4"]);
    expect(variableMatches(graph, "  ").size).toBe(0);
  });

  it("labels edges with the values that travel along them", () => {
    expect(edgeValueLabel(["resp"], undefined)).toEqual({ names: "resp", value: null });
    expect(edgeValueLabel(["resp"], { resp: { kind: "response", text: "200 OK · json" } })).toEqual({ names: "resp", value: "200 OK · json" });
    const values = { a: { kind: "scalar", text: "1" }, b: { kind: "scalar", text: "2" }, c: { kind: "scalar", text: "3" } };
    expect(edgeValueLabel(["a", "b", "c", "d"], values)).toEqual({ names: "a, b, c …", value: "a: 1 · b: 2 +1" });
    expect(edgeValueLabel(["x"], values).value).toBeNull();
  });

  it("formats values", () => {
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(12_300)).toBe("12.3 s");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});
