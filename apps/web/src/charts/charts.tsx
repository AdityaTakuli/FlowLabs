// FlowLabs charts: small SVG charts in the app's style, animated with Motion (motion.dev).
// Charts draw themselves the first time they scroll into view: lines trace, bars and dots rise from
// the baseline, rings sweep. Reduced motion (system setting) shows them at rest.
import { animate, motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fmt } from "../format";

export const PALETTE = ["var(--c-blue)", "var(--signal)", "var(--c-green)", "var(--c-purple)", "var(--c-olive)", "var(--c-pink)", "var(--c-cyan)", "var(--c-indigo)"];
const EASE = [0.22, 1, 0.36, 1] as const;

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

/** True once the element has scrolled into view (always true with reduced motion). */
function useShown<T extends Element>() {
  const ref = useRef<T>(null);
  const seen = useInView(ref, { once: true, amount: 0.25 });
  const reduced = useReducedMotion();
  return [ref, Boolean(seen || reduced), Boolean(reduced)] as const;
}

/** useShown for a chart box, plus its width in pixels, so charts draw at 1:1 and text stays its size. */
function useChart(min = 260) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.2 });
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(420);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(Math.max(min, Math.round(element.clientWidth || 420)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [min]);
  return [ref, Boolean(seen || reduced), Boolean(reduced), width] as const;
}

/** Doto has no clear decimal point: numbers keep their digits in Doto and separators in the text face. */
export function dotted(text: string): ReactNode {
  const parts = text.split(/([.,:%/−-])/);
  if (parts.length === 1) return text;
  return parts.map((part, i) => (i % 2 ? <span key={i} className="dot-sep">{part}</span> : part));
}

function smooth(points: [number, number][]): string {
  // monotone-ish cubic through the points (Catmull-Rom, tension 0.5), so curves never overshoot much
  if (points.length < 3) return points.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  let d = `M${points[0]![0].toFixed(1)},${points[0]![1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0]!.toFixed(1)},${c1[1]!.toFixed(1)} ${c2[0]!.toFixed(1)},${c2[1]!.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/** A number that counts up to its value when it first appears. */
export function CountUp({ value, format = (v: number) => fmt(v), className }: { value: number | null | undefined; format?: (v: number) => string; className?: string }) {
  const [ref, shown, reduced] = useShown<HTMLSpanElement>();
  const [current, setCurrent] = useState(reduced ? value ?? 0 : 0);
  useEffect(() => {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    if (!shown) return;
    if (reduced) {
      setCurrent(value);
      return;
    }
    const controls = animate(0, value, { duration: 0.9, ease: EASE, onUpdate: setCurrent });
    return () => controls.stop();
  }, [value, shown, reduced]);
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={className}>–</span>;
  return (
    <span ref={ref} className={className}>
      {dotted(format(shown ? current : 0))}
    </span>
  );
}

/** The DeerFlow-style dotted ring: a share (0 to 1) lit in the signal colour, a number in the middle. */
export function Ring({ value, label, display, size = 150, dots = 64 }: { value: number; label?: string; display: ReactNode; size?: number; dots?: number }) {
  const [ref, shown, reduced] = useShown<SVGSVGElement>();
  const share = Math.max(0, Math.min(1, value));
  const lit = Math.round(share * dots);
  const r = size / 2 - 8;
  const c = size / 2;
  return (
    <svg ref={ref} width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label ?? "score"}: ${Math.round(share * 100)}%`} className="chart">
      <circle cx={c} cy={c} r={r - 11} fill="none" stroke="var(--rule)" strokeWidth={1} strokeDasharray="1 4" />
      {Array.from({ length: dots }, (_, i) => {
        const angle = (i / dots) * Math.PI * 2 - Math.PI / 2;
        const on = i < lit;
        return (
          <motion.circle
            key={i}
            cx={c + Math.cos(angle) * r}
            cy={c + Math.sin(angle) * r}
            r={on ? 2.6 : 1.7}
            fill={on ? "var(--signal)" : "var(--rule-strong)"}
            initial={reduced ? false : { opacity: 0 }}
            animate={shown ? { opacity: 1 } : undefined}
            transition={{ delay: on ? 0.15 + i * (0.9 / Math.max(lit, 1)) : 0.05 + (i / dots) * 0.3, duration: 0.18 }}
          />
        );
      })}
      <foreignObject x={0} y={c - 26} width={size} height={56}>
        <div style={{ textAlign: "center", lineHeight: 1 }}>
          <div className="dots-face" style={{ fontSize: size * 0.2 }}>
            {display}
          </div>
          {label && <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>{label}</div>}
        </div>
      </foreignObject>
    </svg>
  );
}

export interface Series {
  name: string;
  points: [number, number][];
  colour?: string;
  dashed?: boolean;
}

export function LineChart({
  series,
  height = 200,
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
  const [ref, shown, reduced, width] = useChart();
  const id = useRef(`g${Math.random().toString(36).slice(2, 8)}`).current;
  const W = width;
  const H = height;
  const P = { l: 40, r: 12, t: 12, b: xLabel ? 34 : 22 };
  const all = series.flatMap((s) => s.points);
  if (!all.length) return <div className="dim small">No data yet</div>;
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  let [x0, x1] = domain?.x ?? [Math.min(...xs), Math.max(...xs)];
  let [y0, y1] = domain?.y ?? [Math.min(...ys), Math.max(...ys)];
  if (x0 === x1) [x0, x1] = [x0 - 1, x1 + 1];
  if (y0 === y1) [y0, y1] = [y0 - 0.5, y1 + 0.5];
  if (!domain?.y) {
    const pad = (y1 - y0) * 0.08;
    y0 -= pad;
    y1 += pad;
  }
  const sx = (x: number) => P.l + ((x - x0) / (x1 - x0)) * (W - P.l - P.r);
  const sy = (y: number) => H - P.b - ((y - y0) / (y1 - y0)) * (H - P.t - P.b);
  const xt = ticks(x0, x1, 5);
  const yt = ticks(y0, y1, 4);
  const hoverX = hover === null ? null : x0 + ((hover - P.l) / (W - P.l - P.r)) * (x1 - x0);
  const nearest = (s: Series) =>
    hoverX === null || !s.points.length ? null : s.points.reduce((best, p) => (Math.abs(p[0] - hoverX) < Math.abs(best[0] - hoverX) ? p : best), s.points[0]!);
  const draw = { initial: reduced ? false : { pathLength: 0 }, animate: shown ? { pathLength: 1 } : undefined, transition: { duration: 1.1, ease: EASE } } as const;
  return (
    <div ref={ref}>
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
        <defs>
          {series.map((s, i) => (
            <linearGradient key={s.name} id={`${id}-${i}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={s.colour ?? PALETTE[i % PALETTE.length]} stopOpacity={0.28} />
              <stop offset="100%" stopColor={s.colour ?? PALETTE[i % PALETTE.length]} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        {yt.map((t) => (
          <g key={`y${t}`}>
            <line className="gridline" x1={P.l} x2={W - P.r} y1={sy(t)} y2={sy(t)} />
            <text x={P.l - 7} y={sy(t) + 3} textAnchor="end">
              {fmt(t)}
            </text>
          </g>
        ))}
        {xt.map((t) => (
          <text key={`x${t}`} x={sx(t)} y={H - P.b + 14} textAnchor="middle">
            {fmt(t)}
          </text>
        ))}
        <line className="axis" x1={P.l} x2={W - P.r} y1={H - P.b} y2={H - P.b} />
        {diagonal && <line x1={sx(Math.max(x0, y0))} y1={sy(Math.max(x0, y0))} x2={sx(Math.min(x1, y1))} y2={sy(Math.min(x1, y1))} stroke="var(--edge)" strokeDasharray="3 5" />}
        {series.map((s, i) => {
          const colour = s.colour ?? PALETTE[i % PALETTE.length];
          const d = s.points.map((p, j) => `${j ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join("");
          return (
            <g key={s.name}>
              {area && s.points.length > 1 && (
                <motion.path
                  d={`${d}L${sx(s.points.at(-1)![0])},${sy(y0)}L${sx(s.points[0]![0])},${sy(y0)}Z`}
                  fill={`url(#${id}-${i})`}
                  initial={reduced ? false : { opacity: 0 }}
                  animate={shown ? { opacity: 1 } : undefined}
                  transition={{ delay: 0.5, duration: 0.6 }}
                />
              )}
              <motion.path d={d} fill="none" stroke={colour} strokeWidth={2} strokeLinejoin="round" strokeDasharray={s.dashed ? "5 4" : undefined} {...(s.dashed ? {} : draw)} />
              {s.points.length < 30 &&
                s.points.map((p, j) => (
                  <motion.circle
                    key={j}
                    cx={sx(p[0])}
                    cy={sy(p[1])}
                    r={2.6}
                    fill="var(--sheet)"
                    stroke={colour}
                    strokeWidth={1.6}
                    initial={reduced ? false : { opacity: 0 }}
                    animate={shown ? { opacity: 1 } : undefined}
                    transition={{ delay: 0.2 + (j / s.points.length) * 0.9 }}
                  />
                ))}
            </g>
          );
        })}
        {hover !== null && (
          <g>
            <line x1={hover} x2={hover} y1={P.t} y2={H - P.b} stroke="var(--rule-strong)" />
            {series.map((s, i) => {
              const p = nearest(s);
              return p ? <circle key={s.name} cx={sx(p[0])} cy={sy(p[1])} r={4} fill={s.colour ?? PALETTE[i % PALETTE.length]} stroke="var(--sheet)" strokeWidth={2} /> : null;
            })}
          </g>
        )}
        {xLabel && (
          <text x={(W + P.l) / 2} y={H - 4} textAnchor="middle">
            {xLabel}
          </text>
        )}
        {yLabel && (
          <text x={P.l} y={P.t - 2} textAnchor="start">
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
        {hoverX !== null && series[0] && <span className="faint">at {fmt(nearest(series[0])?.[0])}</span>}
      </div>
    </div>
  );
}

/** Horizontal capsule bars that grow in, longest first. */
export function Bars({ items, max, colour = "var(--c-blue)", format = fmt, signed, highlight }: { items: { label: string; value: number; extra?: string }[]; max?: number; colour?: string; format?: (v: number) => string; signed?: boolean; highlight?: string }) {
  const [ref, shown, reduced] = useShown<HTMLDivElement>();
  const top = max ?? Math.max(...items.map((i) => Math.abs(i.value)), 1e-12);
  return (
    <div ref={ref} className="col" style={{ gap: 7 }}>
      {items.map((item, i) => (
        <div key={item.label} style={{ display: "grid", gridTemplateColumns: "minmax(80px, 36%) minmax(0, 1fr) 64px", gap: 10, alignItems: "center", fontSize: 12 }}>
          <span className="ellipsis" title={item.label} style={{ fontSize: 12, color: item.label === highlight ? "var(--text)" : "var(--text-dim)", fontWeight: item.label === highlight ? 600 : 400 }}>
            {item.label}
          </span>
          <div style={{ height: 8, background: "var(--sheet-2)", borderRadius: 999, overflow: "hidden" }}>
            <motion.div
              style={{ height: "100%", background: signed && item.value < 0 ? "var(--c-red)" : item.label === highlight ? "var(--signal)" : colour, borderRadius: 999 }}
              initial={reduced ? false : { width: 0 }}
              animate={shown ? { width: `${(Math.abs(item.value) / top) * 100}%` } : undefined}
              transition={{ delay: i * 0.04, duration: 0.8, ease: EASE }}
            />
          </div>
          <span className="num dim" style={{ textAlign: "right" }} title={item.extra}>
            {format(item.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Heatmap({ labels, columns, matrix, diverging, format = fmt, normalizeRows, title, accentDiagonal }: { labels: string[]; columns?: string[]; matrix: number[][]; diverging?: boolean; format?: (v: number) => string; normalizeRows?: boolean; title?: (row: string, column: string) => string; accentDiagonal?: boolean }) {
  const [ref, shown, reduced] = useShown<HTMLDivElement>();
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
  const size = Math.max(18, Math.min(48, Math.floor(420 / Math.max(cols.length, 1))));
  const colour = (v: number, onDiagonal: boolean) => {
    const t = Math.abs(v) / max;
    const base = diverging && v < 0 ? "var(--c-red)" : accentDiagonal && !onDiagonal ? "var(--c-red)" : accentDiagonal ? "var(--signal)" : "var(--c-blue)";
    return `color-mix(in srgb, ${base} ${Math.round(6 + 88 * t)}%, var(--sheet-2))`;
  };
  const showText = size >= 26;
  return (
    <div ref={ref} style={{ overflowX: "auto" }}>
      <table style={{ width: "auto", borderCollapse: "separate", borderSpacing: 3 }}>
        <thead>
          <tr>
            <th style={{ background: "none", position: "static", boxShadow: "none" }} />
            {cols.map((c) => (
              <th key={c} style={{ background: "none", boxShadow: "none", position: "static", padding: "0 2px", fontWeight: 500, fontSize: 10.5, writingMode: cols.length > 6 ? "vertical-rl" : undefined, maxHeight: 90 }} className="ellipsis faint" title={c}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((row, i) => (
            <tr key={row}>
              <td style={{ border: "none", padding: "0 8px 0 0", fontSize: 11, maxWidth: 140 }} className="ellipsis dim" title={row}>
                {row}
              </td>
              {cols.map((c, j) => {
                const v = values[i]?.[j] ?? 0;
                const raw = matrix[i]?.[j] ?? 0;
                const strong = Math.abs(v) / max > 0.55;
                return (
                  <motion.td
                    key={c}
                    title={title ? title(row, c) : `${row} × ${c}: ${format(raw)}`}
                    initial={reduced ? false : { opacity: 0, scale: 0.6 }}
                    animate={shown ? { opacity: 1, scale: 1 } : undefined}
                    transition={{ delay: Math.min(0.8, (i + j) * 0.035), type: "spring", stiffness: 300, damping: 24 }}
                    style={{ width: size, height: size, minWidth: size, padding: 0, border: "none", borderRadius: 7, textAlign: "center", fontSize: 10.5, fontWeight: strong ? 600 : 400, background: colour(v, labels[i] === c), color: strong ? "#fff" : "var(--text-dim)" }}
                  >
                    {showText ? format(raw) : ""}
                  </motion.td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Rounded bars growing from the baseline. */
export function Histogram({ edges, counts, height = 120, colour = "var(--c-blue)", label }: { edges: number[]; counts: number[]; height?: number; colour?: string; label?: string }) {
  const [ref, shown, reduced, width] = useChart();
  const W = width;
  const H = height;
  const P = { l: 34, r: 8, t: 6, b: 20 };
  if (!counts.length) return null;
  const top = Math.max(...counts, 1);
  const bw = (W - P.l - P.r) / counts.length;
  const yt = ticks(0, top, 3);
  return (
    <div ref={ref}>
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} width="100%">
      {yt.map((t) => (
        <g key={t}>
          <line className="gridline" x1={P.l} x2={W - P.r} y1={H - P.b - (t / top) * (H - P.t - P.b)} y2={H - P.b - (t / top) * (H - P.t - P.b)} />
          <text x={P.l - 6} y={H - P.b - (t / top) * (H - P.t - P.b) + 3} textAnchor="end">
            {fmt(t)}
          </text>
        </g>
      ))}
      {counts.map((c, i) => {
        const h = (c / top) * (H - P.t - P.b);
        return (
          <motion.rect
            key={i}
            x={P.l + i * bw + 1}
            y={H - P.b - h}
            width={Math.max(1, bw - 2)}
            height={h}
            rx={Math.min(3, bw / 3)}
            fill={colour}
            style={{ transformBox: "fill-box", transformOrigin: "bottom" }}
            initial={reduced ? false : { scaleY: 0 }}
            animate={shown ? { scaleY: 1 } : undefined}
            transition={{ delay: i * 0.02, duration: 0.6, ease: EASE }}
          >
            <title>{`${fmt(edges[i])} – ${fmt(edges[i + 1])}: ${c}`}</title>
          </motion.rect>
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
    </div>
  );
}

export interface Group {
  label: string;
  counts: number[];
  colour?: string;
}

/** r19's histogram with dot columns: each bin a column of dots, groups stacked in their colours. */
export function DotHistogram({ edges, groups, height = 190, xLabel, unitLabel = "rows" }: { edges: number[]; groups: Group[]; height?: number; xLabel?: string; unitLabel?: string }) {
  const [ref, shown, reduced, width] = useChart();
  const [hover, setHover] = useState<number | null>(null);
  const bins = Math.max(0, edges.length - 1);
  if (!bins || !groups.length) return null;
  const W = width;
  const H = height;
  const P = { l: 10, r: 10, t: 8, b: xLabel ? 34 : 20 };
  const totals = Array.from({ length: bins }, (_, i) => groups.reduce((s, g) => s + (g.counts[i] ?? 0), 0));
  const top = Math.max(...totals, 1);
  const colW = (W - P.l - P.r) / bins;
  const dot = Math.max(2.2, Math.min(5.5, colW / 2.6));
  const step = dot * 2 + 1.4;
  const rowsFit = Math.max(4, Math.floor((H - P.t - P.b) / step));
  const unit = Math.max(1, Math.ceil(top / rowsFit));
  const colours = groups.map((g, i) => g.colour ?? (groups.length === 1 ? "var(--ink)" : PALETTE[i % PALETTE.length]!));
  const columnsOfDots = totals.map((_, i) => {
    const cells: { colour: string; row: number }[] = [];
    groups.forEach((g, gi) => {
      const n = Math.round((g.counts[i] ?? 0) / unit);
      for (let k = 0; k < n; k++) cells.push({ colour: colours[gi]!, row: cells.length });
    });
    if (!cells.length && totals[i]! > 0) cells.push({ colour: colours[0]!, row: 0 });
    return cells;
  });
  const xt = ticks(edges[0]!, edges[bins]!, 5).filter((t) => t >= edges[0]! && t <= edges[bins]!);
  const sx = (v: number) => P.l + ((v - edges[0]!) / (edges[bins]! - edges[0]! || 1)) * (W - P.l - P.r);
  return (
    <div ref={ref} className="chart-wrap">
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} width="100%" onMouseLeave={() => setHover(null)}>
        <line className="axis" x1={P.l} x2={W - P.r} y1={H - P.b + 2} y2={H - P.b + 2} />
        {columnsOfDots.map((cells, i) => {
          const cx = P.l + colW * (i + 0.5);
          return (
            <g key={i} onMouseEnter={() => setHover(i)} opacity={hover === null || hover === i ? 1 : 0.35} style={{ transition: "opacity 0.2s" }}>
              <rect x={P.l + colW * i} y={P.t} width={colW} height={H - P.t - P.b} fill="transparent" />
              {cells.map((cell) => (
                <motion.circle
                  key={cell.row}
                  cx={cx}
                  cy={H - P.b - dot - cell.row * step}
                  r={dot}
                  fill={cell.colour}
                  initial={reduced ? false : { opacity: 0, scale: 0 }}
                  animate={shown ? { opacity: 1, scale: 1 } : undefined}
                  style={{ transformBox: "fill-box", transformOrigin: "center" }}
                  transition={{ delay: Math.min(1.2, i * 0.025 + cell.row * 0.018), duration: 0.25 }}
                />
              ))}
            </g>
          );
        })}
        {xt.map((t) => (
          <text key={t} x={sx(t)} y={H - P.b + 16} textAnchor="middle">
            {fmt(t)}
          </text>
        ))}
        {xLabel && (
          <text x={W / 2} y={H - 3} textAnchor="middle">
            {xLabel}
          </text>
        )}
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: `${((P.l + colW * (hover + 0.5)) / W) * 100}%`, top: 0, transform: "translate(-50%, -100%)" }}>
          <div className="faint tiny">
            {fmt(edges[hover])} to {fmt(edges[hover + 1])}
          </div>
          {groups.map((g, gi) => (
            <div key={g.label} className="row" style={{ gap: 6 }}>
              <i style={{ width: 7, height: 7, borderRadius: "50%", background: colours[gi] }} />
              {groups.length > 1 && <span className="dim">{g.label}</span>}
              <b className="num">{(g.counts[hover] ?? 0).toLocaleString()}</b>
            </div>
          ))}
        </div>
      )}
      <div className="legend">
        {groups.length > 1 &&
          groups.map((g, gi) => (
            <span key={g.label}>
              <i style={{ background: colours[gi] }} />
              {g.label}
            </span>
          ))}
        <span className="faint">
          one dot ≈ {unit.toLocaleString()} {unitLabel}
        </span>
      </div>
    </div>
  );
}

/** r19's overlapping density curves: each group's histogram smoothed and scaled to the same area. */
export function Density({ edges, groups, height = 200, xLabel }: { edges: number[]; groups: Group[]; height?: number; xLabel?: string }) {
  const [ref, shown, reduced, width] = useChart();
  const bins = edges.length - 1;
  const W = width;
  const H = height;
  const P = { l: 12, r: 12, t: 10, b: xLabel ? 34 : 20 };
  const curves = useMemo(() => {
    return groups.map((g) => {
      const total = g.counts.reduce((a, b) => a + b, 0) || 1;
      const raw = g.counts.map((c) => c / total);
      // light Gaussian smoothing over neighbouring bins
      const kernel = [0.06, 0.24, 0.4, 0.24, 0.06];
      return raw.map((_, i) => kernel.reduce((s, k, j) => s + k * (raw[Math.min(bins - 1, Math.max(0, i + j - 2))] ?? 0), 0));
    });
  }, [groups, bins]);
  if (bins < 2 || !groups.length) return null;
  const top = Math.max(...curves.flat(), 1e-9);
  const sx = (i: number) => P.l + (i / (bins - 1)) * (W - P.l - P.r);
  const sy = (v: number) => H - P.b - (v / top) * (H - P.t - P.b);
  const xt = ticks(edges[0]!, edges[bins]!, 5);
  const ex = (v: number) => P.l + ((v - edges[0]!) / (edges[bins]! - edges[0]! || 1)) * (W - P.l - P.r);
  return (
    <div ref={ref}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} width="100%">
        <line className="axis" x1={P.l} x2={W - P.r} y1={H - P.b} y2={H - P.b} />
        {curves.map((curve, gi) => {
          const colour = groups[gi]!.colour ?? PALETTE[gi % PALETTE.length]!;
          const line = smooth(curve.map((v, i) => [sx(i), sy(v)]));
          const fill = `${line}L${sx(bins - 1)},${sy(0)}L${sx(0)},${sy(0)}Z`;
          return (
            <g key={groups[gi]!.label}>
              <motion.path
                d={fill}
                fill={colour}
                fillOpacity={0.22}
                style={{ transformBox: "fill-box", transformOrigin: "bottom" }}
                initial={reduced ? false : { scaleY: 0, opacity: 0 }}
                animate={shown ? { scaleY: 1, opacity: 1 } : undefined}
                transition={{ delay: 0.15 + gi * 0.15, duration: 0.9, ease: EASE }}
              />
              <motion.path
                d={line}
                fill="none"
                stroke={colour}
                strokeWidth={2}
                initial={reduced ? false : { pathLength: 0 }}
                animate={shown ? { pathLength: 1 } : undefined}
                transition={{ delay: gi * 0.15, duration: 1.1, ease: EASE }}
              />
            </g>
          );
        })}
        {xt.map((t) => (
          <text key={t} x={ex(t)} y={H - P.b + 15} textAnchor="middle">
            {fmt(t)}
          </text>
        ))}
        {xLabel && (
          <text x={W / 2} y={H - 3} textAnchor="middle">
            {xLabel}
          </text>
        )}
      </svg>
      <div className="legend">
        {groups.map((g, gi) => (
          <span key={g.label}>
            <i style={{ background: g.colour ?? PALETTE[gi % PALETTE.length] }} />
            {g.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function quantile(sorted: number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}

/** r19's box plot, on its side: one row per item, a box from the 25th to the 75th percentile, the folds as dots. */
export function BoxPlot({ rows, format = fmt, highlight, label }: { rows: { label: string; values: number[] }[]; format?: (v: number) => string; highlight?: string; label?: string }) {
  const [ref, shown, reduced, width] = useChart();
  const usable = rows.filter((r) => r.values.length > 0);
  if (!usable.length) return null;
  const all = usable.flatMap((r) => r.values);
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.12;
  lo -= pad;
  hi += pad;
  const W = width;
  const rowH = 30;
  const P = { l: 118, r: 14, t: 6, b: 24 };
  const H = P.t + P.b + rowH * usable.length;
  const sx = (v: number) => P.l + ((v - lo) / (hi - lo)) * (W - P.l - P.r);
  const xt = ticks(lo, hi, 4);
  return (
    <div ref={ref}>
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label}>
      {xt.map((t) => (
        <g key={t}>
          <line className="gridline" x1={sx(t)} x2={sx(t)} y1={P.t} y2={H - P.b} />
          <text x={sx(t)} y={H - 6} textAnchor="middle">
            {format(t)}
          </text>
        </g>
      ))}
      {usable.map((row, i) => {
        const sorted = [...row.values].sort((a, b) => a - b);
        const [q1, median, q3] = [quantile(sorted, 0.25), quantile(sorted, 0.5), quantile(sorted, 0.75)];
        const cy = P.t + rowH * (i + 0.5);
        const best = row.label === highlight;
        const colour = best ? "var(--signal)" : "var(--c-blue)";
        return (
          <g key={row.label}>
            <text x={P.l - 10} y={cy + 4} textAnchor="end" style={{ fill: best ? "var(--text)" : undefined, fontWeight: best ? 600 : 400, fontSize: 11.5 }}>
              {row.label.length > 18 ? `${row.label.slice(0, 17)}…` : row.label}
            </text>
            <motion.g style={{ transformBox: "fill-box", transformOrigin: "center" }} initial={reduced ? false : { scaleX: 0, opacity: 0 }} animate={shown ? { scaleX: 1, opacity: 1 } : undefined} transition={{ delay: i * 0.08, duration: 0.6, ease: EASE }}>
              <line x1={sx(sorted[0]!)} x2={sx(sorted.at(-1)!)} y1={cy} y2={cy} stroke={colour} strokeOpacity={0.5} strokeWidth={1.4} />
              <rect x={sx(q1)} y={cy - 8} width={Math.max(2, sx(q3) - sx(q1))} height={16} rx={5} fill={colour} fillOpacity={0.16} stroke={colour} strokeWidth={1.2} />
              <line x1={sx(median)} x2={sx(median)} y1={cy - 8} y2={cy + 8} stroke={colour} strokeWidth={2.4} strokeLinecap="round" />
            </motion.g>
            {row.values.map((v, j) => (
              <motion.circle
                key={j}
                cx={sx(v)}
                cy={cy + ((j % 3) - 1) * 3.2}
                r={2.6}
                fill={colour}
                stroke="var(--sheet)"
                strokeWidth={1}
                initial={reduced ? false : { opacity: 0 }}
                animate={shown ? { opacity: 1 } : undefined}
                transition={{ delay: 0.4 + i * 0.08 + j * 0.04 }}
              >
                <title>{`${row.label}, fold ${j + 1}: ${format(v)}`}</title>
              </motion.circle>
            ))}
          </g>
        );
      })}
    </svg>
    </div>
  );
}

/** r19's bars and line: one bar per item (the score), a line for a second measure on its own scale. */
export function BarLine({ items, barLabel, lineLabel, formatBar = fmt, formatLine = fmt, highlight }: { items: { label: string; bar: number | null; line: number | null }[]; barLabel: string; lineLabel: string; formatBar?: (v: number) => string; formatLine?: (v: number) => string; highlight?: string }) {
  const [ref, shown, reduced, width] = useChart();
  if (!items.length) return null;
  const W = width;
  const H = 220;
  const P = { l: 40, r: 40, t: 14, b: 46 };
  const bars = items.map((i) => i.bar ?? 0);
  const lines = items.map((i) => i.line ?? 0);
  const barLow = Math.min(0, ...bars);
  const barTop = Math.max(...bars, 1e-9);
  const lineTop = Math.max(...lines, 1e-9);
  const slot = (W - P.l - P.r) / items.length;
  const bw = Math.min(42, slot * 0.6);
  const sy = (v: number) => H - P.b - ((v - barLow) / (barTop - barLow || 1)) * (H - P.t - P.b);
  const ly = (v: number) => H - P.b - (v / lineTop) * (H - P.t - P.b);
  const cx = (i: number) => P.l + slot * (i + 0.5);
  const yt = ticks(barLow, barTop, 4);
  const lt = ticks(0, lineTop, 4);
  const path = items.map((it, i) => (it.line === null ? null : [cx(i), ly(it.line)] as [number, number])).filter((p): p is [number, number] => p !== null);
  return (
    <div ref={ref}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} width="100%">
        {yt.map((t) => (
          <g key={t}>
            <line className="gridline" x1={P.l} x2={W - P.r} y1={sy(t)} y2={sy(t)} />
            <text x={P.l - 7} y={sy(t) + 3} textAnchor="end">
              {formatBar(t)}
            </text>
          </g>
        ))}
        {lt.map((t) => (
          <text key={t} x={W - P.r + 7} y={ly(t) + 3} style={{ fill: "var(--c-cyan)" }}>
            {formatLine(t)}
          </text>
        ))}
        {items.map((it, i) => {
          const value = it.bar ?? 0;
          const y = sy(Math.max(value, 0));
          const h = Math.abs(sy(value) - sy(0));
          const best = it.label === highlight;
          return (
            <g key={it.label}>
              <motion.rect
                x={cx(i) - bw / 2}
                y={y}
                width={bw}
                height={Math.max(1, h)}
                rx={6}
                fill={best ? "var(--signal)" : "var(--sheet-3)"}
                stroke={best ? "none" : "var(--rule-strong)"}
                style={{ transformBox: "fill-box", transformOrigin: "bottom" }}
                initial={reduced ? false : { scaleY: 0 }}
                animate={shown ? { scaleY: 1 } : undefined}
                transition={{ delay: i * 0.06, type: "spring", stiffness: 160, damping: 20 }}
              >
                <title>{`${it.label}: ${barLabel} ${it.bar === null ? "–" : formatBar(it.bar)}, ${lineLabel} ${it.line === null ? "–" : formatLine(it.line)}`}</title>
              </motion.rect>
              <text x={cx(i)} y={H - P.b + 15} textAnchor="middle" style={{ fill: best ? "var(--text)" : undefined, fontWeight: best ? 600 : 400 }}>
                {it.label.length > Math.max(6, Math.floor(slot / 7)) ? `${it.label.slice(0, Math.max(5, Math.floor(slot / 7) - 1))}…` : it.label}
              </text>
            </g>
          );
        })}
        {path.length > 1 && (
          <motion.path d={path.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join("")} fill="none" stroke="var(--c-cyan)" strokeWidth={2} initial={reduced ? false : { pathLength: 0 }} animate={shown ? { pathLength: 1 } : undefined} transition={{ delay: 0.4, duration: 1, ease: EASE }} />
        )}
        {path.map((p, i) => (
          <motion.circle key={i} cx={p[0]} cy={p[1]} r={3.4} fill="var(--sheet)" stroke="var(--c-cyan)" strokeWidth={2} initial={reduced ? false : { opacity: 0 }} animate={shown ? { opacity: 1 } : undefined} transition={{ delay: 0.5 + i * 0.08 }} />
        ))}
      </svg>
      <div className="legend">
        <span>
          <i style={{ background: "var(--signal)" }} />
          {barLabel} (bars)
        </span>
        <span>
          <i style={{ background: "var(--c-cyan)" }} />
          {lineLabel} (line, right scale)
        </span>
      </div>
    </div>
  );
}

export function Scatter({ points, range, xLabel, yLabel }: { points: [number, number][]; range?: [number, number]; xLabel: string; yLabel: string }) {
  const [ref, shown, reduced, width] = useChart();
  const W = width;
  const H = 270;
  const P = { l: 46, r: 10, t: 12, b: 34 };
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
    <div ref={ref}>
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} width="100%">
      {t.map((v) => (
        <g key={v}>
          <line className="gridline" x1={P.l} x2={W - P.r} y1={sy(v)} y2={sy(v)} />
          <text x={P.l - 6} y={sy(v) + 3} textAnchor="end">
            {fmt(v)}
          </text>
          <text x={sx(v)} y={H - P.b + 14} textAnchor="middle">
            {fmt(v)}
          </text>
        </g>
      ))}
      <motion.line x1={sx(lo)} y1={sy(lo)} x2={sx(hi)} y2={sy(hi)} stroke="var(--signal)" strokeWidth={1.4} strokeDasharray="4 5" initial={reduced ? false : { pathLength: 0 }} animate={shown ? { pathLength: 1 } : undefined} transition={{ duration: 0.9, ease: EASE }} />
      {points.map((p, i) => (
        <motion.circle
          key={i}
          cx={sx(p[0])}
          cy={sy(p[1])}
          r={2.6}
          fill="var(--c-blue)"
          fillOpacity={0.55}
          initial={reduced ? false : { opacity: 0 }}
          animate={shown ? { opacity: 1 } : undefined}
          transition={{ delay: 0.2 + (i / points.length) * 0.9, duration: 0.2 }}
        />
      ))}
      <text x={(W + P.l) / 2} y={H - 4} textAnchor="middle">
        {xLabel}
      </text>
      <text x={P.l + 4} y={P.t + 8}>
        {yLabel}
      </text>
    </svg>
    </div>
  );
}

/** A tiny dot histogram for table cells. */
export function Spark({ counts, width = 90, height = 22, colour = "var(--text-dim)" }: { counts: number[]; width?: number; height?: number; colour?: string }) {
  if (!counts.length) return null;
  const top = Math.max(...counts, 1);
  const bw = width / counts.length;
  return (
    <svg className="spark" width={width} height={height}>
      {counts.map((c, i) => {
        const h = Math.max(c > 0 ? 2 : 0, (c / top) * height);
        return <rect key={i} x={i * bw + 0.5} y={height - h} width={Math.max(1, bw - 1.2)} height={h} rx={Math.min(1.5, bw / 3)} fill={colour} opacity={0.85} />;
      })}
    </svg>
  );
}
