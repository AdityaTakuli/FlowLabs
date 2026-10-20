// The guide's pages. The text lives in docs/guide/*.md at the top of the repository, so the same
// files can feed the website later. "reference" is generated from the engine's catalogue.
import code from "../../../../docs/guide/code.md?raw";
import data from "../../../../docs/guide/data.md?raw";
import databases from "../../../../docs/guide/databases.md?raw";
import engines from "../../../../docs/guide/engines.md?raw";
import gettingStarted from "../../../../docs/guide/getting-started.md?raw";
import pipeline from "../../../../docs/guide/pipeline.md?raw";
import predictExport from "../../../../docs/guide/predict-export.md?raw";
import results from "../../../../docs/guide/results.md?raw";
import sql from "../../../../docs/guide/sql.md?raw";
import troubleshooting from "../../../../docs/guide/troubleshooting.md?raw";
import updates from "../../../../docs/guide/updates.md?raw";

export interface Topic {
  id: string;
  title: string;
  group: string;
  /** Markdown; empty for the generated reference. */
  text: string;
  summary: string;
}

function topic(id: string, group: string, text: string): Topic {
  const lines = text.split("\n");
  const title = (lines.find((l) => l.startsWith("# ")) ?? id).slice(2).trim();
  const summary = lines.find((l, i) => i > 0 && l.trim() && !l.startsWith("#")) ?? "";
  return { id, group, title, text, summary };
}

export const TOPICS: Topic[] = [
  topic("getting-started", "Start", gettingStarted),
  topic("data", "Build a model", data),
  topic("sql", "Build a model", sql),
  topic("databases", "Databases", databases),
  topic("pipeline", "Build a model", pipeline),
  topic("code", "Build a model", code),
  topic("results", "Results", results),
  topic("predict-export", "Results", predictExport),
  topic("engines", "Set up", engines),
  topic("updates", "Set up", updates),
  { id: "reference", group: "Reference", title: "Steps and models", text: "", summary: "Every step and model, with what each setting does." },
  topic("troubleshooting", "Help", troubleshooting),
];

export function findTopic(id: string | undefined): Topic {
  return TOPICS.find((t) => t.id === id) ?? TOPICS[0]!;
}
