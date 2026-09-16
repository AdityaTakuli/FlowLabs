import { describe, expect, it } from "vitest";
import type { SessionState } from "../types";
import { addNode, connectNodes, nextNodeId, nodeRunState, paramSummary, removeNodes, type Pipeline, type Technique } from "./types";

const empty: Pipeline = { version: 1, name: "p", dataset: "d.csv", target: null, nodes: [], edges: [] };

describe("pipeline editing", () => {
  it("adds nodes below the anchor and connects them", () => {
    const first = addNode(empty, "load.csv", null);
    expect(first.id).toBe("n1");
    expect(first.pipeline.edges).toEqual([]);
    const second = addNode(first.pipeline, "split.train_test", "n1");
    expect(second.pipeline.edges).toEqual([{ from: "n1", to: "n2" }]);
    expect(second.pipeline.nodes[1]).toMatchObject({ x: 0, y: 140 });
    const third = addNode(second.pipeline, "model.ridge", null); // no selection: after the lowest node
    expect(third.pipeline.edges).toContainEqual({ from: "n2", to: "n3" });
    expect(nextNodeId(third.pipeline)).toBe("n4");
  });

  it("removing a node keeps the chain connected and ignores duplicate edges", () => {
    let p = addNode(empty, "a.x", null).pipeline;
    p = addNode(p, "b.x", "n1").pipeline;
    p = addNode(p, "c.x", "n2").pipeline;
    const removed = removeNodes(p, new Set(["n2"]));
    expect(removed.nodes.map((n) => n.id)).toEqual(["n1", "n3"]);
    expect(removed.edges).toEqual([{ from: "n1", to: "n3" }]);
    expect(connectNodes(removed, "n1", "n3").edges).toHaveLength(1);
    expect(connectNodes(removed, "n3", "n3")).toBe(removed);
  });

  it("summarises only non-default params", () => {
    const technique = {
      params: {
        method: { type: "choice", default: "standard" },
        columns: { type: "columns", default: null },
      },
    } as unknown as Technique;
    expect(paramSummary({ id: "n1", snippet: "prep.scale", params: { method: "standard" }, x: 0, y: 0 }, technique)).toBe("");
    expect(paramSummary({ id: "n1", snippet: "prep.scale", params: { method: "robust", columns: ["a", "b"] }, x: 0, y: 0 }, technique)).toBe(
      "method=robust · columns=a,b",
    );
  });

  it("maps script block states back onto pipeline nodes (worst block wins)", () => {
    const blocks = {
      b1: { node: null, kind: "setup" as const, title: "Setup" },
      b2: { node: "n1", kind: "node" as const, title: "" },
      b3: { node: "n2", kind: "node" as const, title: "" },
    };
    const session = { nodes: { b1: { state: "success" }, b2: { state: "success" }, b3: { state: "error" } } } as unknown as SessionState;
    expect(nodeRunState("n1", blocks, session)).toBe("success");
    expect(nodeRunState("n2", blocks, session)).toBe("error");
    expect(nodeRunState("n9", blocks, session)).toBeNull();
    expect(nodeRunState("n1", blocks, null)).toBeNull();
  });
});
