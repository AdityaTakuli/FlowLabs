// Line icons drawn as inline SVG on a 16px grid; stroke follows currentColor.

const PATHS = {
  play: "M5 3.5v9l7.5-4.5z",
  code: "M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3 7 13",
  sun: "M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9 13 13M3 13l1.1-1.1M11.9 4.1 13 3",
  moon: "M13.5 9.5A5.8 5.8 0 0 1 6.5 2.5a5.8 5.8 0 1 0 7 7z",
  stop: "M4 4h8v8H4z",
  refresh: "M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3",
  close: "M4 4l8 8M12 4l-8 8",
  check: "M3 8.5l3.2 3L13 4.5",
  plus: "M8 3v10M3 8h10",
  minus: "M4 8h8",
  warning: "M8 2.5 14.5 13.5h-13zM8 6.5v3.5M8 11.8v.2",
  error: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM6 6l4 4M10 6l-4 4",
  info: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM8 7.2v4M8 4.8v.2",
  help: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4M8 11.3v.2",
  expand: "M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9",
  search: "M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.3 10.3l3.2 3.2",
  book: "M2.5 3h4A1.5 1.5 0 0 1 8 4.5V13a1.2 1.2 0 0 0-1.2-1.2H2.5zM13.5 3h-4A1.5 1.5 0 0 0 8 4.5V13a1.2 1.2 0 0 1 1.2-1.2h4.3z",
  folder: "M1.8 4.2h4.4l1.5 1.6h6.5v7.4H1.8z",
  file: "M4 1.8h5l3 3v9.4H4zM9 1.8v3h3",
  upload: "M8 11V3M4.5 6.5 8 3l3.5 3.5M3 13.5h10",
  download: "M8 2v8M4.5 7 8 10.5 11.5 7M3 13.5h10",
  database: "M2.5 3.8C2.5 2.5 13.5 2.5 13.5 3.8v8.4c0 1.3-11 1.3-11 0zM2.5 3.8c0 1.3 11 1.3 11 0M2.5 8c0 1.3 11 1.3 11 0",
  broom: "M10.5 2 7 7.5M4 8l5 2.5L7.5 14 2 11.5zM5.5 12.3 6.3 10.5",
  split: "M2 8h4M6 8l3-4h5M6 8l3 4h5",
  rows: "M2.5 3h11M2.5 6.3h11M2.5 9.7h11M2.5 13h11",
  transform: "M2.5 5h7M7 2.5 9.5 5 7 7.5M13.5 11h-7M9 8.5 6.5 11 9 13.5",
  sparkles: "M6 2v3M6 9v3M2.5 6h3M8.5 6h3M12 9.5v3M10.5 11h3",
  model: "M3 3.5h3v3H3zM10 3.5h3v3h-3zM6.5 10.5h3v3h-3zM4.5 6.5 8 10.5M11.5 6.5 8 10.5",
  brain: "M6 2.5a2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 0-1 4.5 2.5 2.5 0 0 0 3.5 3.5V2.5zM10 2.5a2.5 2.5 0 0 1 2.5 2.5 2.5 2.5 0 0 1 1 4.5 2.5 2.5 0 0 1-3.5 3.5V2.5z",
  chart: "M2 13.5h12M3.5 11l3-4 2.5 2 4-5.5",
  trophy: "M5 2.5h6v3a3 3 0 0 1-6 0zM5 3.5H2.5a2 2 0 0 0 2.5 3M11 3.5h2.5a2 2 0 0 1-2.5 3M8 8.5v3M5.5 13.5h5",
  target: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM8 7.5v1",
  package: "M8 1.8 14 5v6l-6 3.2L2 11V5zM2 5l6 3.2L14 5M8 8.2v6",
  cpu: "M4.5 4.5h7v7h-7zM6.5 6.5h3v3h-3zM6 2v2.5M10 2v2.5M6 11.5V14M10 11.5V14M2 6h2.5M2 10h2.5M11.5 6H14M11.5 10H14",
  gpu: "M1.5 4.5h13v7h-13zM4 7h3v2H4zM9 7h3v2H9zM3 11.5V13M13 11.5V13",
  globe: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM1.8 8h12.4M8 1.8c-3 3.4-3 9 0 12.4M8 1.8c3 3.4 3 9 0 12.4",
  link: "M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1",
  laptop: "M3 3.5h10v7H3zM1.5 12.5h13",
  terminal: "M2 3h12v10H2zM4.5 6l2 2-2 2M8 10.5h3.5",
  gear: "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9",
  copy: "M5.5 5.5h7v8h-7zM3.5 10.5v-8h7",
  eye: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z",
  eyeOff: "M2 2l12 12M6.5 4a7 7 0 0 1 8 4 9 9 0 0 1-1.6 2.2M10 12a6.5 6.5 0 0 1-8.5-4 9 9 0 0 1 2-2.6",
  arrowLeft: "M13 8H3M7 4 3 8l4 4",
  arrowRight: "M3 8h10M9 4l4 4-4 4",
  arrowUp: "M8 13V3M4 7l4-4 4 4",
  arrowDown: "M8 3v10M4 9l4 4 4-4",
  chevronRight: "M6 3.5 10.5 8 6 12.5",
  chevronDown: "M3.5 6 8 10.5 12.5 6",
  bolt: "M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z",
  image: "M2 3h12v10H2zM2 11l3.5-3.5 3 3L11 8l3 3M10.5 5.5h.1",
  table: "M2 3h12v10H2zM2 6.3h12M2 9.7h12M6 3v10",
  dot: "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  logo: "M5 4a2 2 0 1 0 0 .1M11 4a2 2 0 1 0 0 .1M8 12a2 2 0 1 0 0 .1M6.5 5.6 7.4 10.2M9.5 5.6 8.6 10.2M7 4h2",
  edit: "M10.5 2.5l3 3L6 13H3v-3z",
  layers: "M8 2 14 5 8 8 2 5zM2 8l6 3 6-3M2 11l6 3 6-3",
  sliders: "M3 4h6M12 4h1M3 12h1M7 12h6M10.5 2.5v3M5.5 10.5v3M3 8h3M9 8h4M7.5 6.5v3",
  lock: "M4 7.2h8v6.8H4zM5.8 7.2V5a2.2 2.2 0 0 1 4.4 0v2.2",
  github: "M6 13c-3 1-3-1.5-4.5-2M10 14.5v-2.4c0-.7.1-1.2-.3-1.6 2.2-.2 4.3-1 4.3-4.7a3.6 3.6 0 0 0-1-2.5 3.4 3.4 0 0 0-.1-2.5s-.8-.2-2.6 1a9 9 0 0 0-4.6 0C3.9 .6 3.1.8 3.1.8A3.4 3.4 0 0 0 3 3.3a3.6 3.6 0 0 0-1 2.5c0 3.7 2.1 4.5 4.3 4.7-.4.4-.5 1-.3 1.6v2.4",
  external: "M9 2.5h4.5V7M13.5 2.5 7 9M11.5 9.5v4h-9v-9h4",
} as const;

export type IconName = keyof typeof PATHS;
const FILLED = new Set<IconName>(["play", "stop", "dot"]);

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
      style={{ flex: "none" }}
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  );
}
