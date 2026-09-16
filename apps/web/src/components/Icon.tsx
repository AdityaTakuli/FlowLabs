// Line icons drawn as inline SVG (no emoji, no icon font). 16px grid, stroke follows currentColor.

const PATHS = {
  play: "M5 3.5v9l7.5-4.5z",
  runTo: "M3 3.5v6l5-3zM9 3.5v6l5-3zM3 13h11",
  runFrom: "M4 2.5v6l5-3zM4 11h9M4 14h9",
  stop: "M4 4h8v8H4z",
  refresh: "M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3",
  undo: "M5.5 4 2.5 7l3 3M3 7h6.5a3.5 3.5 0 0 1 0 7H7",
  edit: "M10.5 2.5l3 3L6 13H3v-3z",
  close: "M4 4l8 8M12 4l-8 8",
  check: "M3 8.5l3.2 3L13 4.5",
  warning: "M8 2.5 14.5 13.5h-13zM8 6.5v3.5M8 11.8v.2",
  error: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM6 6l4 4M10 6l-4 4",
  folder: "M1.8 4.2h4.4l1.5 1.6h6.5v7.4H1.8z",
  file: "M4 1.8h5l3 3v9.4H4zM9 1.8v3h3",
  notebook: "M4 1.8h8.2v12.4H4zM2.5 4.5h3M2.5 8h3M2.5 11.5h3M7 5h3.5",
  spark: "M8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4M4 4l1.8 1.8M10.2 10.2 12 12M12 4l-1.8 1.8M5.8 10.2 4 12",
  lock: "M4 7.2h8v6.8H4zM5.8 7.2V5a2.2 2.2 0 0 1 4.4 0v2.2",
  key: "M10 2.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM7.5 8.5 2 14M4 12l1.5 1.5",
  output: "M2 3h12v10H2zM2 6h12M5 9h6M5 11h4",
  external: "M9 2.5h4.5V7M13.5 2.5 7 9M11.5 9.5v4h-9v-9h4",
  chevronRight: "M6 3.5 10.5 8 6 12.5",
  chevronDown: "M3.5 6 8 10.5 12.5 6",
  star: "M8 1.8l1.9 4 4.3.5-3.2 2.9.9 4.3L8 11.3l-3.9 2.2.9-4.3L1.8 6.3l4.3-.5z",
  gear: "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4",
  database: "M2.5 3.8C2.5 2.5 13.5 2.5 13.5 3.8v8.4c0 1.3-11 1.3-11 0zM2.5 3.8c0 1.3 11 1.3 11 0M2.5 8c0 1.3 11 1.3 11 0",
  bolt: "M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z",
  search: "M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.3 10.3 14 14",
  chart: "M2 13.5h12M3.5 11l3-4 2.5 2 4-5.5",
  cpu: "M4.5 4.5h7v7h-7zM6.5 6.5h3v3h-3zM6 2v2.5M10 2v2.5M6 11.5V14M10 11.5V14M2 6h2.5M2 10h2.5M11.5 6H14M11.5 10H14",
  model: "M3 3.5h3v3H3zM10 3.5h3v3h-3zM6.5 10.5h3v3h-3zM4.5 6.5 8 10.5M11.5 6.5 8 10.5",
  layers: "M8 2 14 5 8 8 2 5zM2 8l6 3 6-3M2 11l6 3 6-3",
  dot: "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  logo: "M3.5 3.5h3v3h-3zM9.5 9.5h3v3h-3zM6.5 5h3.5v4.5",
  graph: "M3 3h3v3H3zM10 10h3v3h-3zM10 3h3v3h-3zM6 4.5h4M11.5 6v4",
  redo: "M10.5 4 13.5 7l-3 3M13 7H6.5a3.5 3.5 0 0 0 0 7H9",
  sigma: "M12 3H4l4.5 5L4 13h8",
  filter: "M2 3h12L9.5 8.5V13l-3 1.5v-6z",
  branch: "M5 2.5v11M5 9c0-3 6-2 6-5.5M11 3.5a1 1 0 1 0 0 .1",
  download: "M8 2v8M4.5 7 8 10.5 11.5 7M3 13.5h10",
  eye: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z",
  swap: "M3 5h9l-2.5-2.5M13 11H4l2.5 2.5",
  minus: "M4 8h8",
  more: "M4 8h.1M8 8h.1M12 8h.1",
} as const;

export type IconName = keyof typeof PATHS;

const FILLED = new Set<IconName>(["play", "runTo", "runFrom", "stop", "dot"]);

export function Icon({ name, size = 14, className, title }: { name: IconName; size?: number; className?: string; title?: string }) {
  const filled = FILLED.has(name);
  return (
    <svg
      className={`icon ${className ?? ""}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 0.8 : 1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  );
}
