// The pipeline as a graph: stage columns left to right, steps stacked inside each stage.
import type { Catalogue, Issue, ModelResult, Project, Step } from "./types";
import { fmt, metricValue } from "./format";

export type StageId = "data" | "clean" | "split" | "rows" | "transform" | "prep" | "models" | "results";
export type NodeKind = "dataset" | "step" | "split" | "autoprep" | "imageprep" | "model" | "results" | "add";

export interface PipeNode {
  id: string;
  kind: NodeKind;
  stage: StageId;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  disabled?: boolean;
  level?: "error" | "warning";
  metric?: string;
  status?: string;
  progress?: number;
  addStage?: "clean" | "rows" | "transform" | "models";
}

export interface PipeEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: "right" | "bottom";
  targetHandle: "left" | "top";
  dashed?: boolean;
}

export const STAGE_COLOURS: Record<StageId, string> = {
  data: "var(--st-data)",
  clean: "var(--st-clean)",
  split: "var(--st-split)",
  rows: "var(--st-rows)",
  transform: "var(--st-transform)",
  prep: "var(--st-transform)",
  models: "var(--st-model)",
  results: "var(--st-result)",
};

export const STAGE_TITLES: Record<StageId, string> = {
  data: "Data",
  clean: "Clean",
  split: "Split",
  rows: "Training rows",
  transform: "Transform",
  prep: "Image prep",
  models: "Models",
  results: "Results",
};

const COLUMN = 228;
const ROW = 104;
const TOP = 40;

function columnsText(columns: unknown): string {
  if (!Array.isArray(columns) || columns.length === 0) return "";
  const labels: Record<string, string> = {
    "@numeric": "all numbers",
    "@categorical": "all categories",
    "@all": "every column",
    "@datetime": "all dates",
    "@boolean": "all yes/no",
    "@text": "all text",
  };
  const shown = columns.slice(0, 3).map((c) => labels[String(c)] ?? String(c));
  return shown.join(", ") + (columns.length > 3 ? ` +${columns.length - 3}` : "");
}

/** One line saying what a step does with its current settings. */
export function summarize(step: Step, catalogue: Catalogue): string {
  const p = step.params;
  const option = (name: string) => {
    const op = [...catalogue.clean, ...catalogue.rows, ...catalogue.transform].find((o) => o.id === step.op);
    const param = op?.params.find((x) => x.name === name);
    return param?.options?.find((o) => o.value === p[name])?.label ?? String(p[name] ?? "");
  };
  switch (step.op) {
    case "drop_columns":
      return columnsText(p.columns) || "choose columns";
    case "change_type":
      return `${columnsText(p.columns) || "choose columns"} → ${option("to")}`;
    case "clean_text":
      return `${columnsText(p.columns)} · ${option("case")}`;
    case "replace_values":
      return p.column ? `${p.column}: “${p.find ?? ""}” → “${p.replace ?? ""}”` : "choose a column";
    case "extract_datetime":
      return `${columnsText(p.columns)} → ${(p.parts as string[] | undefined)?.join(", ") ?? ""}`;
    case "combine_columns":
      return p.a && p.b ? `${p.name || `${p.a} ${option("operation")} ${p.b}`}` : "choose two columns";
    case "drop_duplicates":
      return columnsText(p.columns) ? `by ${columnsText(p.columns)}` : "exact duplicates";
    case "drop_missing_rows":
      return `gaps in ${columnsText(p.columns)}`;
    case "filter_rows":
      return p.column ? `keep ${p.column} ${option("operator")} ${String(p.operator).includes("missing") ? "" : (p.value ?? "")}` : "choose a column";
    case "sample_rows":
      return `${fmt(p.rows)} random rows`;
    case "remove_outliers":
      return `${option("method")} · ${columnsText(p.columns)}`;
    case "balance_classes":
      return option("method");
    case "impute":
      return `${option("strategy")} · ${columnsText(p.columns)}`;
    case "encode":
    case "scale":
    case "power":
      return `${option("method")} · ${columnsText(p.columns)}`;
    case "clip_outliers":
      return `${option("method")} · ${columnsText(p.columns)}`;
    case "select_k_best":
      return `top ${p.k} · ${columnsText(p.columns)}`;
    case "pca":
      return Number(p.components) < 1 ? `keep ${Math.round(Number(p.components) * 100)}% variance` : `${p.components} components`;
    case "polynomial":
      return `degree ${p.degree} · ${columnsText(p.columns)}`;
    default:
      return columnsText(p.columns);
  }
}

function modelSubtitle(model: Project["models"][number], catalogue: Catalogue, kind: Project["kind"]): string {
  const algo = (kind === "image" ? catalogue.image_models : catalogue.models).find((a) => a.id === model.algo);
  if (model.algo === "neural_network" || model.algo === "cnn") {
    const layers = (model.params.layers as { type: string; units?: number; filters?: number }[] | undefined) ?? [];
    const sizes = layers.filter((l) => l.type === "dense" || l.type === "conv").map((l) => l.units ?? l.filters);
    return `${layers.length} layers (${sizes.join("→")}) · ${model.params.epochs} epochs`;
  }
  if (model.algo === "pretrained") return `${model.params.arch}${model.params.freeze ? " · last layer only" : " · fine-tune all"}`;
  const tune = model.tune !== "off" ? ` · tune ${model.tune}` : "";
  return `${algo?.family ?? ""}${tune}`;
}

export function buildGraph(
  project: Project,
  catalogue: Catalogue,
  issues: Issue[],
  results: Map<string, ModelResult>,
  metric: string,
  live: Map<string, { status: string; progress?: number }>,
): { nodes: PipeNode[]; edges: PipeEdge[]; stages: { id: StageId; x: number }[] } {
  const nodes: PipeNode[] = [];
  const edges: PipeEdge[] = [];
  const stages: { id: StageId; x: number }[] = [];
  const levelFor = (id: string, stage?: string): PipeNode["level"] => {
    const found = issues.filter((i) => i.step === id || (!i.step && stage && i.stage === stage));
    if (found.some((i) => i.level === "error")) return "error";
    if (found.some((i) => i.level === "warning")) return "warning";
    return undefined;
  };
  const image = project.kind === "image";
  const order: StageId[] = image ? ["data", "prep", "split", "models", "results"] : ["data", "clean", "split", "rows", "transform", "models", "results"];
  const columnNodes: string[][] = [];
  order.forEach((stage, column) => {
    const x = column * COLUMN;
    stages.push({ id: stage, x });
    const ids: string[] = [];
    const push = (node: Omit<PipeNode, "x" | "y" | "stage">) => {
      nodes.push({ ...node, stage, x, y: TOP + ids.length * ROW });
      ids.push(node.id);
    };
    if (stage === "data") {
      push({ id: "dataset", kind: "dataset", title: "Dataset", subtitle: `predict ${project.target} · ${project.task}`, level: levelFor("", "data") });
    } else if (stage === "clean" || stage === "rows" || stage === "transform") {
      for (const step of project[stage]) {
        const op = catalogue[stage].find((o) => o.id === step.op);
        push({ id: step.id, kind: "step", title: op?.label ?? step.op, subtitle: summarize(step, catalogue), disabled: !step.enabled, level: levelFor(step.id) });
      }
      if (stage === "transform")
        push({ id: "auto_prep", kind: "autoprep", title: "Auto-prep", subtitle: project.auto_prep ? "numbers only, no gaps" : "off", disabled: !project.auto_prep });
      nodes.push({ id: `add-${stage}`, kind: "add", stage, x, y: TOP + ids.length * ROW, title: stage === "clean" ? "Add a clean step" : stage === "rows" ? "Add a training-set step" : "Add a transform", subtitle: "", addStage: stage });
    } else if (stage === "split") {
      const s = project.split;
      const parts = [`${Math.round((1 - s.test_size) * 100)}% train / ${Math.round(s.test_size * 100)}% test`];
      if (s.time_column) parts.push(`by ${s.time_column}`);
      else if (s.stratify && project.task === "classification") parts.push("stratified");
      if (s.cv_folds >= 2) parts.push(`${s.cv_folds}-fold CV`);
      push({ id: "split", kind: "split", title: "Train / test split", subtitle: parts.join(" · "), level: levelFor("", "split") });
    } else if (stage === "prep") {
      const prep = project.image ?? {};
      const aug = ["hflip", "vflip"].filter((k) => prep[k]).length + (Number(prep.rotation) > 0 ? 1 : 0) + (Number(prep.color_jitter) > 0 ? 1 : 0);
      push({ id: "image_prep", kind: "imageprep", title: "Resize & augment", subtitle: `${prep.size}×${prep.size}px${prep.grayscale ? " grey" : ""} · ${aug} augmentations`, level: levelFor("", "prep") });
    } else if (stage === "models") {
      for (const model of project.models) {
        const result = results.get(model.id);
        const running = live.get(model.id);
        push({
          id: model.id,
          kind: "model",
          title: model.label,
          subtitle: modelSubtitle(model, catalogue, project.kind),
          disabled: !model.enabled,
          level: levelFor(model.id),
          metric: result?.status === "done" ? metricValue(metric, result.metrics?.[metric]) : result?.status === "failed" ? "failed" : undefined,
          status: running?.status,
          progress: running?.progress,
        });
      }
      nodes.push({ id: "add-models", kind: "add", stage, x, y: TOP + ids.length * ROW, title: "Add a model", subtitle: "", addStage: "models" });
    } else if (stage === "results") {
      push({ id: "results", kind: "results", title: "Evaluate", subtitle: results.size ? "scores on test rows" : "train to see scores" });
    }
    columnNodes.push(ids);
  });
  // within a stage: top to bottom; between stages: last node of one to the first of the next
  columnNodes.forEach((ids, column) => {
    const stage = order[column];
    if (stage !== "models") {
      for (let i = 1; i < ids.length; i++) edges.push({ id: `${ids[i - 1]}>${ids[i]}`, source: ids[i - 1]!, target: ids[i]!, sourceHandle: "bottom", targetHandle: "top" });
    }
  });
  let previous: string | undefined;
  columnNodes.forEach((ids, column) => {
    if (!ids.length) return;
    const stage = order[column];
    if (stage === "models") {
      for (const id of ids) {
        if (previous) edges.push({ id: `${previous}>${id}`, source: previous, target: id, sourceHandle: "right", targetHandle: "left", dashed: nodes.find((n) => n.id === id)?.disabled });
        edges.push({ id: `${id}>results`, source: id, target: "results", sourceHandle: "right", targetHandle: "left", dashed: nodes.find((n) => n.id === id)?.disabled });
      }
      previous = undefined;
      return;
    }
    if (previous && stage !== "results") edges.push({ id: `${previous}>${ids[0]}`, source: previous, target: ids[0]!, sourceHandle: "right", targetHandle: "left" });
    previous = ids.at(-1);
  });
  return { nodes, edges, stages };
}

/** Move an item within a list (for reordering steps). */
export function move<T>(list: T[], index: number, by: number): T[] {
  const target = index + by;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  return next;
}
