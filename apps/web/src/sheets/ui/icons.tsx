// Toolbar icons for the spreadsheet, drawn on the same 16×16 grid and stroke as the app's icons.
const PATHS = {
  undo: "M5 4L2 7l3 3M2.5 7H10a3.5 3.5 0 010 7H8",
  redo: "M11 4l3 3-3 3M13.5 7H6a3.5 3.5 0 000 7h2",
  bold: "M4.5 2.5h4.25a2.75 2.75 0 010 5.5H4.5zM4.5 8h5a3 3 0 010 6h-5z",
  italic: "M7 2.5h5M4 13.5h5M10 2.5l-4 11",
  underline: "M4.5 2.5V7a3.5 3.5 0 007 0V2.5M3.5 14h9",
  strike: "M3 8h10M10.75 4.5C10.3 3.3 9.3 2.5 8 2.5c-1.8 0-3 1-3 2.4 0 1 .6 1.7 1.7 2.1M5 11.3c.4 1.4 1.5 2.2 3 2.2 1.9 0 3.1-1 3.1-2.4 0-.5-.1-.9-.4-1.2",
  alignLeft: "M2.5 3.5h11M2.5 6.5h7M2.5 9.5h11M2.5 12.5h7",
  alignCenter: "M2.5 3.5h11M4.5 6.5h7M2.5 9.5h11M4.5 12.5h7",
  alignRight: "M2.5 3.5h11M6.5 6.5h7M2.5 9.5h11M6.5 12.5h7",
  alignTop: "M2.5 2.5h11M8 5v9M5.5 7.5L8 5l2.5 2.5",
  alignMiddle: "M2.5 8h11M8 2v3.5M8 10.5V14M6 4l2 1.5L10 4M6 12l2-1.5 2 1.5",
  alignBottom: "M2.5 13.5h11M8 2v9M5.5 8.5L8 11l2.5-2.5",
  wrap: "M2.5 3.5h11M2.5 7.5h9a2 2 0 010 4H8M9.5 10L8 11.5 9.5 13M2.5 11.5h3",
  merge: "M2.5 3.5h11v9h-11zM5 8h6M5 8l1.5-1.5M5 8l1.5 1.5M11 8L9.5 6.5M11 8l-1.5 1.5",
  border: "M2.5 2.5h11v11h-11zM8 2.5v11M2.5 8h11",
  borderNone: "M2.5 2.5h11v11h-11z",
  borderOuter: "M2.5 2.5h11v11h-11z",
  borderBottom: "M2.5 13.5h11",
  borderTop: "M2.5 2.5h11",
  borderLeft: "M2.5 2.5v11",
  borderRight: "M13.5 2.5v11",
  fill: "M3 8.5L8 3.5l5 5-4.5 4.5a1.4 1.4 0 01-2 0L3 9.5a.7.7 0 010-1zM2.5 8.5h11M13 11.5c0 .8.6 1.5 1 1.5",
  textColor: "M4 12L8 3l4 9M5.5 9h5",
  sigma: "M12 3H4l4.5 5L4 13h8",
  percent: "M12 4L4 12M5 5.5a.5.5 0 100-1 .5.5 0 000 1zM11 11.5a.5.5 0 100-1 .5.5 0 000 1z",
  comma: "M7 10.5c0 1.6-.6 2.8-1.6 3.5M7 10.5a.8.8 0 11-1.6 0 .8.8 0 011.6 0z",
  decimalsMore: "M2.5 12h.01M5 9.5a2 2 0 104 0v-1a2 2 0 10-4 0zM10.5 9.5a2 2 0 104 0v-1a2 2 0 10-4 0zM7 4h5M10.5 2.5L12 4l-1.5 1.5",
  decimalsLess: "M2.5 12h.01M5 9.5a2 2 0 104 0v-1a2 2 0 10-4 0zM12 4H7M8.5 2.5L7 4l1.5 1.5",
  freeze: "M2.5 2.5h11v11h-11zM2.5 6h11M6 2.5v11",
  sortAsc: "M4.5 3v10M2.5 11l2 2 2-2M9 4h4.5M9 8h3.5M9 12h2",
  sortDesc: "M4.5 3v10M2.5 5l2-2 2 2M9 4h2M9 8h3.5M9 12h4.5",
  insertRow: "M2.5 9.5h11v4h-11zM8 2.5v5M5.5 5h5",
  insertCol: "M9.5 2.5h4v11h-4zM2.5 8h5M5 5.5v5",
  deleteRow: "M2.5 9.5h11v4h-11zM5.5 5h5",
  formulas: "M6 13.5c1.5 0 2-1 2.3-3l.9-5c.3-2 .8-3 2.3-3M5.5 7h5",
  zoom: "M7 12A5 5 0 107 2a5 5 0 000 10zM14 14l-3.5-3.5M5 7h4M7 5v4",
  note: "M3 2.5h7.5l2.5 2.5v8.5H3zM5.5 6.5h5M5.5 9h5M5.5 11.5h3",
  clear: "M3 13.5h10M5.5 11L11 5.5a1.4 1.4 0 012 2L9.5 11zM5.5 11l-2-2 4-4",
  paste: "M5.5 3H4a1 1 0 00-1 1v9a1 1 0 001 1h8a1 1 0 001-1V4a1 1 0 00-1-1h-1.5M5.5 2.5h5v2h-5zM5.5 8h5M5.5 10.5h3",
  filter: "M2.5 3h11L9.5 8v4.5l-3 1.5V8z",
  rules: "M2.5 2.5h11v11h-11zM2.5 6.2h11M2.5 9.8h11M6.2 2.5v11M5 4.3h.01M8.7 8h3M8.7 11.6h1.5",
  painter: "M3.5 2.5h8v3h-8zM11.5 4h1.5v3.5H8v2M7 9.5h2v4H7z",
} as const;

export type SheetIconName = keyof typeof PATHS;

export function SheetIcon({ name, size = 15 }: { name: SheetIconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
