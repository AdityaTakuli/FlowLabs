import { useMemo, useState } from "react";
import type { MetricPoint } from "../types";

const PALETTE = ["#ffffff", "#7dd3fc", "#fbbf24", "#a3e635", "#f472b6", "#c4b5fd", "#fb923c", "#94a3b8"];
const W = 400;
const H = 180;
const PAD = { left: 44, right: 10, top: 10, bottom: 24 };

/** Metrics grouped by what they measure, so loss and accuracy never share one y axis. */
export function metricGroups(points: MetricPoint[]): { title: string; names: string[] }[] {
  const names = [...new Set(points.flatMap((p) => Object.keys(p.values)))];
  const family = (name: string) => {
    const n = name.toLowerCase();
    if (/loss|mse|mae|rmse|error|perplexity|ppl|kl/.test(n)) return "Loss and error";
    if (/lr|learning_rate/.test(n)) return "Learning rate";
    if (/grad/.test(n)) return "Gradients";
    return "Scores";
  };
  const groups = new Map<string, string[]>();
  for (const name of names) groups.set(family(name), [...(groups.get(family(name)) ?? []), name]);
  const order = ["Loss and error", "Scores", "Learning rate", "Gradients"];
  return [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([title, members]) => ({ title, names: members }));
}

export function latestValues(points: MetricPoint[]): Record<string, number> {
  const latest: Record<string, number> = {};
  for (const point of points) Object.assign(latest, point.values);
  return latest;
}

function ticks(min: number, max: number, count = 4): number[] {
  if (min === max) return [min];
  const step = (max - min) / count;
  return Array.from({ length: count + 1 }, (_, i) => min + i * step);
}

function format(value: number): string {
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 0.001 || abs >= 1e5)) return value.toExponential(1);
  return Number(value.toPrecision(3)).toString();
}

/** Live line chart of training metrics; redraws as points stream in. */
export function MetricsChart({ points, title, names }: { points: MetricPoint[]; title: string; names: string[] }) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [hover, setHover] = useState<number | null>(null);
  const series = useMemo(
    () =>
      names.map((name, i) => ({
        name,
        colour: PALETTE[i % PALETTE.length]!,
        data: points.filter((p) => typeof p.values[name] === "number").map((p) => ({ step: p.step, value: p.values[name]! })),
      })),
    [points, names],
  );
  const visible = series.filter((s) => !hidden.has(s.name) && s.data.length);
  const all = visible.flatMap((s) => s.data);
  if (!all.length) return null;
  const steps = all.map((d) => d.step);
  const values = all.map((d) => d.value);
  const [x0, x1] = [Math.min(...steps), Math.max(...steps)];
  const [rawY0, rawY1] = [Math.min(...values), Math.max(...values)];
  const margin = (rawY1 - rawY0) * 0.08 || Math.abs(rawY1) * 0.1 || 1;
  const [y0, y1] = [rawY0 - margin, rawY1 + margin];
  const x = (step: number) => PAD.left + (x1 === x0 ? 0.5 : (step - x0) / (x1 - x0)) * (W - PAD.left - PAD.right);
  const y = (value: number) => PAD.top + (1 - (value - y0) / (y1 - y0)) * (H - PAD.top - PAD.bottom);
  const hoverStep = hover === null ? null : steps.reduce((best, s) => (Math.abs(s - hover) < Math.abs(best - hover) ? s : best), steps[0]!);

  return (
    <figure className="metrics-chart">
      <figcaption>
        <span>{title}</span>
        <span className="metrics-legend">
          {series.map((s) => (
            <button
              key={s.name}
              className={`legend-item ${hidden.has(s.name) ? "off" : ""}`}
              onClick={() =>
                setHidden((current) => {
                  const next = new Set(current);
                  if (next.has(s.name)) next.delete(s.name);
                  else next.add(s.name);
                  return next;
                })
              }
            >
              <span className="swatch" style={{ background: s.colour }} />
              {s.name}
              {s.data.length > 0 && <span className="legend-value">{format(s.data[s.data.length - 1]!.value)}</span>}
            </button>
          ))}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title}: ${names.join(", ")} by step`}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const px = ((event.clientX - box.left) / box.width) * W;
          setHover(x0 + ((px - PAD.left) / (W - PAD.left - PAD.right)) * (x1 - x0));
        }}
        onMouseLeave={() => setHover(null)}
      >
        {ticks(y0, y1).map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={PAD.left - 6} y={y(t) + 3} textAnchor="end" className="chart-tick">
              {format(t)}
            </text>
          </g>
        ))}
        {ticks(x0, x1, Math.min(5, Math.max(1, x1 - x0))).map((t) => (
          <text key={t} x={x(t)} y={H - 6} textAnchor="middle" className="chart-tick">
            {format(t)}
          </text>
        ))}
        {visible.map((s) => (
          <g key={s.name}>
            <polyline fill="none" stroke={s.colour} strokeWidth={1.6} points={s.data.map((d) => `${x(d.step)},${y(d.value)}`).join(" ")} />
            {s.data.length <= 60 && s.data.map((d, i) => <circle key={i} cx={x(d.step)} cy={y(d.value)} r={2} fill={s.colour} />)}
          </g>
        ))}
        {hoverStep !== null && (
          <g>
            <line x1={x(hoverStep)} x2={x(hoverStep)} y1={PAD.top} y2={H - PAD.bottom} className="chart-cursor" />
            <text x={Math.min(x(hoverStep) + 6, W - 120)} y={PAD.top + 10} className="chart-readout">
              step {format(hoverStep)}
              {visible.map((s) => {
                const match = s.data.find((d) => d.step === hoverStep);
                return match ? ` · ${s.name} ${format(match.value)}` : "";
              })}
            </text>
          </g>
        )}
      </svg>
    </figure>
  );
}
