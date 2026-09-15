import { describe, expect, it } from "vitest";
import { filesForLanguage, languageIcon, structureNeighbours, visibleStructure, workspaceFor, type FileKind, type StructureGraph } from "./types";
import { withMoved } from "./useSavedLayout";

const py = (workspace: FileKind["workspace"]): FileKind => ({
  language: "python",
  language_name: "Python",
  monaco: "python",
  workspace,
  reason: "",
  can_run_cells: true,
});
const go: FileKind = { language: "go", language_name: "Go", monaco: "go", workspace: "structure", reason: "", can_run_cells: false };

function node(id: string, parent: string | null = null, kind: "function" | "method" | "class" = parent ? "method" : "function") {
  return { id, kind, name: id, qualified_name: id, parent, file: "a.py", line_start: 1, line_end: 2, signature: "", doc: null, source: "", source_hash: "", editable: true, calls: [], loc: 2 };
}

describe("workspace routing", () => {
  it("honours the detected workspace, notebook rule and per-file override", () => {
    expect(workspaceFor("a.ipynb", py("structure"), "structure")).toBe("cells");
    expect(workspaceFor("api.py", py("structure"), null)).toBe("structure");
    expect(workspaceFor("api.py", py("structure"), "cells")).toBe("cells");
    expect(workspaceFor("main.go", go, "cells")).toBe("structure"); // Go cannot run as cells
    expect(workspaceFor("explore.py", py("cells"), "structure")).toBe("structure");
  });

  it("filters files by language and picks icons", () => {
    const info = { "a.py": py("cells"), "main.go": go };
    expect(filesForLanguage(["a.py", "main.go"], info, "Go")).toEqual(["main.go"]);
    expect(filesForLanguage(["a.py", "main.go"], info, "all")).toEqual(["a.py", "main.go"]);
    expect(languageIcon("Go", "main.go")).toBe("Go");
    expect(languageIcon("Python", "x.ipynb")).toBe("📓");
  });
});

describe("structure graph helpers", () => {
  const graph = {
    nodes: [node("A", null, "class"), node("A.m", "A"), node("A.n", "A"), node("f")],
    edges: [
      { from: "A", to: "A.m", kind: "member", names: [], sites: [] },
      { from: "A.m", to: "A.n", kind: "call", names: ["n"], sites: [{ line: 3, text: "self.n()" }] },
      { from: "f", to: "A.m", kind: "call", names: ["m"], sites: [{ line: 9, text: "A().m()" }] },
      { from: "f", to: "A.n", kind: "call", names: ["n"], sites: [{ line: 10, text: "A().n()" }] },
    ],
  } as unknown as StructureGraph;

  it("folds class members into the class and merges their edges", () => {
    const { nodes, edges } = visibleStructure(graph, new Set(["A"]));
    expect(nodes.map((n) => n.id)).toEqual(["A", "f"]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: "f", to: "A", names: ["m", "n"] });
    expect(edges[0]!.sites).toHaveLength(2);
    expect(graph.edges[2]!.names).toEqual(["m"]); // the original graph is untouched
  });

  it("finds neighbours and applies dragged positions only to nodes that exist", () => {
    expect([...structureNeighbours(graph.edges, "A.n")].sort()).toEqual(["A.m", "A.n", "f"]);
    expect(withMoved({ a: { x: 0, y: 0 }, b: { x: 5, y: 5 } }, { a: { x: 9, y: 9 }, gone: { x: 1, y: 1 } })).toEqual({ a: { x: 9, y: 9 }, b: { x: 5, y: 5 } });
  });
});
