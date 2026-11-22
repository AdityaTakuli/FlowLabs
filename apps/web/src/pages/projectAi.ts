// How a change proposed in the AI panel becomes a change to the project, and how it is taken back.
// The engine has already checked the change (core/ai_project.py); a new step or model arrives
// fully formed from the same calls the Pipeline tab uses. Each change comes with its exact
// inverse, so undoing one leaves later changes, made by hand or by the AI, in place.
import type { ProjectAction } from "../components/AiPanel";
import type { ModelEntry, Project, Step } from "../types";

export type StepStage = "clean" | "rows" | "transform";
export interface ProjectChange {
  next: (project: Project) => Project;
  undo: (project: Project) => Project;
  note?: string;
}

const STAGES: StepStage[] = ["clean", "rows", "transform"];

function isStage(stage: string): stage is StepStage {
  return (STAGES as string[]).includes(stage);
}

/** Where an item lives now: a step stage or the models. */
export function locate(project: Project, id: string): { stage: StepStage | "models"; index: number } | null {
  for (const stage of STAGES) {
    const index = project[stage].findIndex((s) => s.id === id);
    if (index >= 0) return { stage, index };
  }
  const index = project.models.findIndex((m) => m.id === id);
  return index >= 0 ? { stage: "models", index } : null;
}

function withItem(project: Project, stage: StepStage | "models", id: string, edit: (item: Step | ModelEntry) => Step | ModelEntry): Project {
  if (stage === "models") return { ...project, models: project.models.map((m) => (m.id === id ? (edit(m) as ModelEntry) : m)) };
  return { ...project, [stage]: project[stage].map((s) => (s.id === id ? (edit(s) as Step) : s)) };
}

function without(project: Project, id: string): Project {
  const found = locate(project, id);
  if (!found) return project;
  if (found.stage === "models") return { ...project, models: project.models.filter((m) => m.id !== id) };
  return { ...project, [found.stage]: project[found.stage].filter((s) => s.id !== id) };
}

/** The step or model with this id, or a plain error when it has gone. */
function existing(project: Project, id: string): { item: Step | ModelEntry; stage: StepStage | "models"; index: number } {
  const found = locate(project, id);
  const item = found ? (found.stage === "models" ? project.models[found.index] : project[found.stage][found.index]) : undefined;
  if (!found || !item) throw new Error("That step or model is no longer in the project.");
  return { item, ...found };
}

/** The change for one action. `created` is the step or model the engine made for an add. */
export function projectChange(action: ProjectAction, project: Project, created?: Step | ModelEntry | null): ProjectChange {
  switch (action.change) {
    case "add_step": {
      if (!created || !isStage(action.stage)) throw new Error("The step could not be created.");
      const step = created as Step;
      const stage = action.stage;
      return { next: (p) => ({ ...p, [stage]: [...p[stage], step] }), undo: (p) => without(p, step.id) };
    }
    case "add_model": {
      if (!created) throw new Error("The model could not be created.");
      const model = created as ModelEntry;
      return { next: (p) => ({ ...p, models: [...p.models, model] }), undo: (p) => without(p, model.id) };
    }
    case "remove": {
      const { item, stage, index } = existing(project, action.item);
      return {
        next: (p) => without(p, action.item),
        undo: (p) => {
          if (locate(p, item.id)) return p;
          if (stage === "models") {
            const models = [...p.models];
            models.splice(Math.min(index, models.length), 0, item as ModelEntry);
            return { ...p, models };
          }
          const steps = [...p[stage]];
          steps.splice(Math.min(index, steps.length), 0, item as Step);
          return { ...p, [stage]: steps };
        },
      };
    }
    case "update": {
      const { item, stage } = existing(project, action.item);
      const { enabled, tune, ...params } = action.params as { enabled?: boolean; tune?: ModelEntry["tune"] } & Record<string, unknown>;
      const before: Record<string, unknown> = {};
      for (const name of Object.keys(params)) before[name] = item.params[name];
      const wasEnabled = item.enabled;
      const wasTune = "tune" in item ? item.tune : undefined;
      const set = (values: Record<string, unknown>, on: boolean | undefined, level: ModelEntry["tune"] | undefined) => (entry: Step | ModelEntry) => {
        const next = { ...entry, params: { ...entry.params, ...values } } as Step | ModelEntry;
        if (on !== undefined) next.enabled = on;
        if (level !== undefined && "tune" in next) (next as ModelEntry).tune = level;
        return next;
      };
      return {
        next: (p) => withItem(p, stage, action.item, set(params, enabled, tune)),
        undo: (p) => withItem(p, stage, action.item, set(before, enabled === undefined ? undefined : wasEnabled, tune === undefined ? undefined : wasTune)),
      };
    }
    case "settings": {
      const was = { target: project.target, metric: project.metric };
      const now = { target: action.target || project.target, metric: action.metric || project.metric };
      return {
        next: (p) => ({ ...p, ...now }),
        undo: (p) => ({ ...p, target: p.target === now.target ? was.target : p.target, metric: p.metric === now.metric ? was.metric : p.metric }),
      };
    }
    default:
      throw new Error(`${action.label}: not a change to the project's pipeline.`);
  }
}
