import { describe, expect, it } from "vitest";
import type { ProjectAction } from "../components/AiPanel";
import type { ModelEntry, Project, Step } from "../types";
import { locate, projectChange } from "./projectAi";

const step = (id: string, op = "drop_columns"): Step => ({ id, op, params: { columns: [] }, enabled: true });
const model = (id: string, algo = "random_forest"): ModelEntry => ({ id, algo, label: algo, params: { n_estimators: 200 }, tune: "off", enabled: true });

const project: Project = {
  id: "p1",
  name: "Churn",
  kind: "tabular",
  dataset_id: "d1",
  target: "churned",
  task: "classification",
  created: "",
  updated: "",
  clean: [step("c1"), step("c2", "fill_missing")],
  rows: [],
  transform: [],
  auto_prep: true,
  split: { test_size: 0.2 } as Project["split"],
  metric: "auto",
  models: [model("m1", "baseline"), model("m2")],
};

function act(fields: Partial<ProjectAction>): ProjectAction {
  return { type: "project", change: "update", stage: "", op: "", item: "", params: {}, target: "", metric: "", label: "Change", dropped: [], ...fields };
}

describe("AI changes to a project", () => {
  it("adds a step or a model, and undo removes exactly that one", () => {
    const added = step("c3", "drop_duplicates");
    const change = projectChange(act({ change: "add_step", stage: "clean", op: "drop_duplicates" }), project, added);
    const next = change.next(project);
    expect(next.clean.map((s) => s.id)).toEqual(["c1", "c2", "c3"]);
    // a step added by hand afterwards survives the undo
    const edited = { ...next, clean: [...next.clean, step("c4")] };
    expect(change.undo(edited).clean.map((s) => s.id)).toEqual(["c1", "c2", "c4"]);

    const forest = model("m3", "extra_trees");
    const addModel = projectChange(act({ change: "add_model", op: "extra_trees" }), project, forest);
    expect(addModel.next(project).models.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(() => projectChange(act({ change: "add_step", stage: "clean" }), project, null)).toThrow();
  });

  it("changes settings, on/off and tuning, and undo puts back only those", () => {
    const change = projectChange(act({ item: "m2", params: { n_estimators: 500, enabled: false, tune: "quick" } }), project);
    const next = change.next(project);
    expect(next.models[1]).toMatchObject({ params: { n_estimators: 500 }, enabled: false, tune: "quick" });
    expect(next.models[0]).toBe(project.models[0]);
    const back = change.undo(next);
    expect(back.models[1]).toMatchObject({ params: { n_estimators: 200 }, enabled: true, tune: "off" });

    const stepChange = projectChange(act({ item: "c2", params: { strategy: "median" } }), project);
    expect(stepChange.next(project).clean[1]?.params).toEqual({ columns: [], strategy: "median" });
    expect(() => projectChange(act({ item: "gone" }), project)).toThrow("no longer in the project");
  });

  it("removes an item and undo puts it back where it was", () => {
    const change = projectChange(act({ change: "remove", item: "c1" }), project);
    const next = change.next(project);
    expect(next.clean.map((s) => s.id)).toEqual(["c2"]);
    expect(change.undo(next).clean.map((s) => s.id)).toEqual(["c1", "c2"]);
    expect(change.undo(project)).toBe(project); // already there: nothing to do
    expect(locate(project, "m2")).toEqual({ stage: "models", index: 1 });
  });

  it("sets the target and metric, and undo leaves a later hand edit alone", () => {
    const change = projectChange(act({ change: "settings", metric: "accuracy" }), project);
    const next = change.next(project);
    expect(next).toMatchObject({ target: "churned", metric: "accuracy" });
    expect(change.undo(next).metric).toBe("auto");
    expect(change.undo({ ...next, metric: "f1_macro" }).metric).toBe("f1_macro");
  });

  it("training is not a pipeline change", () => {
    expect(() => projectChange(act({ change: "train", label: "Train the models" }), project)).toThrow("not a change");
  });
});
