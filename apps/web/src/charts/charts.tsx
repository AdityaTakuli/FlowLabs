// Small SVG charts in the app's style. No chart library: fewer bytes, one look.
import { useMemo, useState } from "react";
import { fmt } from "../format";

export const PALETTE = ["var(--c-blue)", "var(--c-orange)", "var(--c-green)", "var(--c-red)", "var(--c-purple)", "var(--c-brown)", "var(--c-pink)", "var(--c-grey)"];

function ticks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const raw = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(10)));
  return out;
}

export interface Series {
  name: string;
  points: [number, number][];
  colour?: string;
  dashed?: boolean;
}

export function LineChart({
  series,
  height = 190,
  xLabel,
  yLabel,
  diagonal,
  domain,
  area,
}: {
  series: Series[];
  height?: number;
  xLabel?: string;
  yLabel?: string;
  diagonal?: boolean;
  domain?: { x?: [number, number]; y?: [number, number] };
  area?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 420;
  const H = height;
  const P = { l: 44, r: 12, t: 10, b: xLabel ? 32 : 22 };
  const all = series.flatMap((s) => s.points);
  if (!all.length) return <div className="dim small">No data yet</div>;
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  let [x0, x1] = domain?.x ?? [Math.min(...xs), Math.max(...xs)];
  let [y0, y1] = domain?.y ?? [Math.min(...ys), Math.max(...ys)];
  if (x0 === x1) [x0, x1] = [x0 - 1, x1 + 1];
  if (y0 === y1) [y0, y1] = [y0 - 0.5, y1 + 0.5];
  if (!domain?.y) {
    const pad = (y1 - y0) * 0.06;
    y0 -= pad;
    y1 += pad;
  }
  const sx = (x: number) => P.l + ((x - x0) / (x1 - x0)) * (W - P.l - P.r);
  const sy = (y: number) => H - P.b - ((y - y0) / (y1 - y0)) * (H - P.t - P.b);
  const xt = ticks(x0, x1, 5);
  const yt = ticks(y0, y1, 4);
  const hoverX = hover === null ? null : x0 + ((hover - P.l) / (W - P.l - P.r)) * (x1 - x0);
  const nearest = (s: Series) =>
    hoverX === null ? null : s.points.reduce((best, p) => (Math.abs(p[0] - hoverX) < Math.abs(best[0] - hoverX) ? p : best), s.points[0]!);
  return (
    <div>
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        onMouseMove={(e) => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const x = ((e.clientX - box.left) / box.width) * W;
          setHover(x >= P.l && x <= W - P.r ? x : null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {yt.map((t) => (
          <g key={`y${t}`}>
            <line className="gridline" x1={P.l} x2={W - P.r} y1={sy(t)} y2={sy(t)} />
            <text x={P.l - 6} y={sy(t) + 3} textAnchor="end">
              {fmt(t)}
            </text>
          </g>
        ))}
        {xt.map((t) => (
          <text key={`x${t}`} x={sx(t)} y={H - P.b + 13} textAnchor="middle">
            {fmt(t)}
          </text>
        ))}
        <line className="axis" x1={P.l} x2={W - P.r} y1={H - P.b} y2={H - P.b} stroke="var(--rule-strong)" />
        {diagonal && <line x1={sx(Math.max(x0, y0))} y1={sy(Math.max(x0, y0))} x2={sx(Math.min(x1, y1))} y2={sy(Math.min(x1, y1))} stroke="var(--edge)" strokeDasharray="4 4" />}
        {series.map((s, i) => {
          const colour = s.colour ?? PALETTE[i % PALETTE.length];
          const d = s.points.map((p, j) => `${j ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join("");
          return (
            <g key={s.name}>
              {area && s.points.length > 1 && (
                <path d={`${d}L${sx(s.points.at(-1)![0])},${sy(y0)}L${sx(s.points[0]![0])},${sy(y0)}Z`} fill={colour} opacity={0.08} />
              )}
              <path d={d} fill="none" stroke={colour} strokeWidth={1.8} strokeDasharray={s.dashed ? "5 4" : undefined} />
              {s.points.length < 30 && s.points.map((p, j) => <circle key={j} cx={sx(p[0])} cy={sy(p[1])} r={2} fill={colour} />)}
            </g>
          );
        })}
        {hover !== null && (
          <g>
            <line x1={hover} x2={hover} y1={P.t} y2={H - P.b} stroke="var(--edge)" />
            {series.map((s, i) => {
              const p = nearest(s);
              return p ? <circle key={s.name} cx={sx(p[0])} cy={sy(p[1])} r={3.5} fill={s.colour ?? PALETTE[i % PALETTE.length]} /> : null;
            })}
          </g>
        )}
        {xLabel && (
          <text x={(W + P.l) / 2} y={H - 4} textAnchor="middle">
            {xLabel}
          </text>
        )}
        {yLabel && (
          <text x={10} y={P.t + 4} textAnchor="start">
            {yLabel}
          </text>
        )}
      </svg>
      <div className="legend">
        {series.map((s, i) => {
          const p = nearest(s);
          return (
            <span key={s.name}>
              <i style={{ background: s.colour ?? PALETTE[i % PALETTE.length] }} />
              {s.name}
              {p && <b className="num">&nbsp;{fmt(p[1])}</b>}
            </span>
          );
        })}
        {hoverX !== null && <span className="faint">at {fmt(nearest(series[0]!)?.[0])}</span>}
      </div>
    </div>
  );
}

export function Bars({ items, max, colour = "var(--c-blue)", format = fmt, signed }: { items: { label: string; value: number; extra?: string }[]; max?: number; colour?: string; format?: (v: number) => string; signed?: boolean }) {
  const top = max ?? Math.max(...items.map((i) => Math.abs(i.value)), 1e-12);
  return (
    <div className="col" style={{ gap: 5 }}>
      {items.map((item) => (
        <div key={item.label} style={{ display: "grid", gridTemplateColumns: "minmax(80px, 38%) minmax(0, 1fr) 64px", gap: 8, alignItems: "center", fontSize: 12 }}>
          <span className="ellipsis mono" title={item.label} style={{ fontSize: 11.5 }}>
            {item.label}
          </span>
          <div style={{ height: 10, background: "var(--sheet-2)", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${(Math.abs(item.value) / top) * 100}%`, height: "100%", background: signed && item.value < 0 ? "var(--c-red)" : colour, borderRadius: 3 }} />
          </div>
          <span className="num dim" style={{ textAlign: "right" }} title={item.extra}>
            {format(item.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Heatmap({ labels, columns, matrix, diverging, format = fmt, normalizeRows, title }: { labels: string[]; columns?: string[]; matrix: number[][]; diverging?: boolean; format?: (v: number) => string; normalizeRows?: boolean; title?: (row: string, column: string) => string }) {
  const cols = columns ?? labels;
  const values = useMemo(() => {
    if (!normalizeRows) return matrix;
    return matrix.map((row) => {
      const total = row.reduce((a, b) => a + b, 0) || 1;
      return row.map((v) => v / total);
    });
  }, [matrix, normalizeRows]);
  const flat = values.flat();
  const max = Math.max(...flat.map(Math.abs), 1e-12);
  const size = Math.max(18, Math.min(46, Math.floor(420 / Math.max(cols.length, 1))));
  const colour = (v: number) => {
    const t = Math.abs(v) / max;
    if (diverging && v < 0) return `color-mix(in srgb, var(--c-red) ${Math.round(8 + 85 * t)}%, var(--sheet))`;
    return `color-mix(in srgb, var(--c-blue) ${Math.round(6 + 85 * t)}%, var(--sheet))`;
  };
  const showText = size >= 26;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "auto", borderCollapse: "separate", borderSpacing: 2 }}>
        <thead>
          <tr>
            <th style={{ background: "none", position: "static" }} />
            {cols.map((c) => (
              <th key={c} style={{ background: "none", position: "static", padding: "0 2px", fontWeight: 400, fontSize: 10, writingMode: cols.length > 6 ? "vertical-rl" : undefined, maxHeight: 90 }} className="ellipsis" title={c}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((row, i) => (
            <tr key={row}>
              <td style={{ border: "none", padding: "0 6px 0 0", fontSize: 11, maxWidth: 140 }} className="ellipsis dim" title={row}>
                {row}
              </td>
              {cols.map((c, j) => {
                const v = values[i]?.[j] ?? 0;
                const raw = matrix[i]?.[j] ?? 0;
                return (
                  <td
                    key={c}
                    title={title ? title(row, c) : `${row} × ${c}: ${format(raw)}`}
                    style={{ width: size, height: size, minWidth: size, padding: 0, border: "none", borderRadius: 3, textAlign: "center", fontSize: 10, background: colour(v), color: Math.abs(v) / max > 0.55 ? "#fff" : "var(--text-dim)" }}
                  >
                    {showText ? format(raw) : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Histogram({ edges, counts, height = 120, colour = "var(--c-blue)", label }: { edges: number[]; counts: number[]; height?: number; colour?: string; label?: string }) {
  const W = 420;
  const H = height;
  const P = { l: 36, r: 8, t: 6, b: 20 };
  if (!counts.length) return null;
  const top = Math.max(...counts, 1);
  const bw = (W - P.l - P.r) / counts.length;
  const yt = ticks(0, top, 3);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} width="100%">
      {yt.map((t) => (
        <g key={t}>
          <line className="gridline" x1={P.l} x2={W - P.r} y1={H - P.b - (t / top) * (H - P.t - P.b)} y2={H - P.b - (t / top) * (H - P.t - P.b)} />
          <text x={P.l - 5} y={H - P.b - (t / top) * (H - P.t - P.b) + 3} textAnchor="end">
            {fmt(t)}
          </text>
        </g>
      ))}
      {counts.map((c, i) => {
        const h = (c / top) * (H - P.t - P.b);
        return (
          <rect key={i} x={P.l + i * bw + 0.5} y={H - P.b - h} width={Math.max(1, bw - 1)} height={h} fill={colour} opacity={0.8} rx={1}>
            <title>{`${fmt(edges[i])} – ${fmt(edges[i + 1])}: ${c}`}</title>
          </rect>
        );
      })}
      <text x={P.l} y={H - 5}>
        {fmt(edges[0])}
      </text>
      <text x={W - P.r} y={H - 5} textAnchor="end">
        {fmt(edges.at(-1))}
      </text>
      {label && (
        <text x={(W + P.l) / 2} y={H - 5} textAnchor="middle">
          {label}
        </text>
      )}
    </svg>
  );
}

export function Scatter({ points, range, xLabel, yLabel }: { points: [number, number][]; range?: [number, number]; xLabel: string; yLabel: string }) {
  const W = 420;
  const H = 260;
  const P = { l: 48, r: 10, t: 10, b: 32 };
  if (!points.length) return null;
  const [lo, hi] = range ?? [Math.min(...points.flat()), Math.max(...points.flat())];
  const s = (v: number, size: number, start: number, flip: boolean) => {
    const t = (v - lo) / (hi - lo || 1);
    return flip ? start + size - t * size : start + t * size;
  };
  const sx = (v: number) => s(v, W - P.l - P.r, P.l, false);
  const sy = (v: number) => s(v, H - P.t - P.b, P.t, true);
  const t = ticks(lo, hi, 4);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} width="100%">
      {t.map((v) => (
        <g key={v}>
          <line className="gridline" x1={P.l} x2={W - P.r} y1={sy(v)} y2={sy(v)} />
          <text x={P.l - 5} y={sy(v) + 3} textAnchor="end">
            {fmt(v)}
          </text>
          <text x={sx(v)} y={H - P.b + 13} textAnchor="middle">
            {fmt(v)}
          </text>
        </g>
      ))}
      <line x1={sx(lo)} y1={sy(lo)} x2={sx(hi)} y2={sy(hi)} stroke="var(--edge)" strokeDasharray="4 4" />
      {points.map((p, i) => (
        <circle key={i} cx={sx(p[0])} cy={sy(p[1])} r={2.4} fill="var(--c-blue)" opacity={0.6} />
      ))}
      <text x={(W + P.l) / 2} y={H - 4} textAnchor="middle">
        {xLabel}
      </text>
      <text x={P.l + 4} y={P.t + 10}>
        {yLabel}
      </text>
    </svg>
  );
}

/** A tiny histogram for table cells. */
export function Spark({ counts, width = 90, height = 22, colour = "var(--c-blue)" }: { counts: number[]; width?: number; height?: number; colour?: string }) {
  if (!counts.length) return null;
  const top = Math.max(...counts, 1);
  const bw = width / counts.length;
  return (
    <svg className="spark" width={width} height={height}>
      {counts.map((c, i) => (
        <rect key={i} x={i * bw} y={height - (c / top) * height} width={Math.max(1, bw - 1)} height={(c / top) * height} fill={colour} opacity={0.75} />
      ))}
    </svg>
  );
}
