import { describe, expect, it } from "vitest";
import {
  UNASSIGNED_ID,
  archetypeFamily,
  cycleMembership,
  dependencyPairs,
  neighborIds,
  type ArchComponent,
  type ArchEdge,
} from "./types";

function component(id: string, depends_on: string[] = []): ArchComponent {
  return {
    id,
    name: id,
    archetype: "service",
    responsibility: "Handles one step.",
    units: [],
    public_surface: [],
    depends_on,
    files: [],
    spans: [],
    sloc: 0,
    confidence: "high",
    decided_by: "cluster",
    archetype_decided_by: "rule",
    archetype_confidence: "high",
    reason: "",
  };
}

const edges: ArchEdge[] = [
  { from: "a", to: "b", kind: "call", via: ["u1→u2"], confidence: "high", observed: false },
  { from: "b", to: "c", kind: "call", via: ["u2→u3"], confidence: "high", observed: false },
  { from: "c", to: "a", kind: "call", via: ["u3→u1"], confidence: "high", observed: false },
  { from: "p", to: "c", kind: "dataflow", via: ["u9→u3"], confidence: "medium", observed: true },
];

describe("architecture types", () => {
  it("groups archetypes into families", () => {
    expect(archetypeFamily("training")).toBe("ml");
    expect(archetypeFamily("repository")).toBe("backend");
    expect(archetypeFamily("configuration")).toBe("cross");
    expect(UNASSIGNED_ID).toBe("__unassigned__");
  });

  it("turns call and dataflow edges into dependent → dependency pairs", () => {
    expect(dependencyPairs(edges)).toEqual([
      ["a", "b"],
      ["b", "c"],
      ["c", "a"],
      ["c", "p"],
    ]);
  });

  it("marks every member of a dependency cycle", () => {
    const pairs = dependencyPairs(edges.filter((e) => e.kind === "call"));
    const cycles = cycleMembership(["a", "b", "c", "p"], pairs);
    expect(cycles.get("a")).toBe(cycles.get("b"));
    expect(cycles.get("b")).toBe(cycles.get("c"));
    expect(cycles.has("p")).toBe(false);
  });

  it("finds a component's neighbours along depends_on", () => {
    const components = [component("svc", ["repo", "schema"]), component("repo"), component("schema"), component("routes", ["svc"])];
    expect([...neighborIds("svc", components)].sort()).toEqual(["repo", "routes", "schema", "svc"]);
    expect([...neighborIds("missing", components)]).toEqual(["missing"]);
  });
});
