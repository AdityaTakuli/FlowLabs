import type { RunResult } from "../types";
import { metricValue } from "../format";

export function ModelChooser({ run, value, onChange }: { run: RunResult; value: string; onChange: (id: string) => void }) {
  const done = run.models.filter((m) => m.status === "done");
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {done.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label} · {run.metric_label} {metricValue(run.metric, m.metrics?.[run.metric])}
          {m.id === run.best_model_id ? " (best)" : ""}
        </option>
      ))}
    </select>
  );
}
