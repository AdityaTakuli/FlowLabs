// What the toolbar, menus and shortcuts do to the selection.
import { type Area, cellName, key, keyCol, keyRow, MAX_COLS, MAX_ROWS, normal } from "../engine/address";
import { autofill } from "../engine/fill";
import { refText, tokenize } from "../engine/parser";
import { compareValues, type Scalar } from "../engine/values";
import type { Sheet, Style, Workbook } from "../engine/workbook";
import type { Selection } from "./render";

export const fullRows = (a: Area) => a.c1 === 0 && a.c2 === MAX_COLS - 1;
export const fullCols = (a: Area) => a.r1 === 0 && a.r2 === MAX_ROWS - 1;

/** The selection's areas, clipped to the used part of the sheet (whole columns stop at the data). */
export function usedAreas(wb: Workbook, sheet: Sheet, sel: Selection): Area[] {
  const { rows, cols } = wb.bounds(sheet);
  return sel.ranges.map((a) => ({ r1: a.r1, c1: a.c1, r2: Math.min(a.r2, Math.max(a.r1, rows - 1)), c2: Math.min(a.c2, Math.max(a.c1, cols - 1)) }));
}

/** The last format applied, for F4 to repeat on another selection. */
export const lastFormat: { apply: ((wb: Workbook, sheet: Sheet, sel: Selection) => void) | null } = { apply: null };

export function applyStyle(wb: Workbook, sheet: Sheet, sel: Selection, patch: Partial<Style> | ((s: Style) => Style), label = "Format") {
  lastFormat.apply = (w, s, x) => applyStyle(w, s, x, patch, label);
  wb.transact(label, () => {
    for (const area of sel.ranges) wb.setStyle(sheet, area, patch);
  });
}

/** Turn a style on for the selection, or off when the active cell has it already. */
export function toggleStyle(wb: Workbook, sheet: Sheet, sel: Selection, prop: "bold" | "italic" | "underline" | "strike" | "wrap") {
  const current = wb.style(sheet.cells.get(key(sel.active.row, sel.active.col))?.s)[prop];
  applyStyle(wb, sheet, sel, { [prop]: !current });
  lastFormat.apply = (w, s, x) => applyStyle(w, s, x, { [prop]: !current });
}

export type BorderKind = "all" | "outer" | "none" | "top" | "bottom" | "left" | "right" | "thick-outer" | "bottom-double";

export function applyBorders(wb: Workbook, sheet: Sheet, sel: Selection, kind: BorderKind, color?: string) {
  lastFormat.apply = (w, s, x) => applyBorders(w, s, x, kind, color);
  const thin = { style: "thin" as const, color };
  wb.transact("Borders", () => {
    for (const a of usedAreasForFormat(wb, sheet, sel)) {
      for (let r = a.r1; r <= a.r2; r++)
        for (let c = a.c1; c <= a.c2; c++) {
          wb.setStyle(sheet, { r1: r, c1: c, r2: r, c2: c }, (s) => {
            const next = { ...s };
            const edge = kind === "thick-outer" ? { style: "thick" as const, color } : thin;
            if (kind === "none") {
              delete next.top;
              delete next.bottom;
              delete next.left;
              delete next.right;
            } else if (kind === "all") Object.assign(next, { top: thin, bottom: thin, left: thin, right: thin });
            else if (kind === "outer" || kind === "thick-outer") {
              if (r === a.r1) next.top = edge;
              if (r === a.r2) next.bottom = edge;
              if (c === a.c1) next.left = edge;
              if (c === a.c2) next.right = edge;
            } else if (kind === "top" && r === a.r1) next.top = thin;
            else if (kind === "bottom" && r === a.r2) next.bottom = thin;
            else if (kind === "bottom-double" && r === a.r2) next.bottom = { style: "double", color };
            else if (kind === "left" && c === a.c1) next.left = thin;
            else if (kind === "right" && c === a.c2) next.right = thin;
            return next;
          });
        }
    }
  });
}

function usedAreasForFormat(wb: Workbook, sheet: Sheet, sel: Selection): Area[] {
  const { rows, cols } = wb.bounds(sheet);
  return sel.ranges.map((a) => ({ ...a, r2: Math.min(a.r2, Math.max(a.r1, rows - 1, a.r1 + 200)), c2: Math.min(a.c2, Math.max(a.c1, cols - 1, a.c1 + 50)) }));
}

const filled = (wb: Workbook, sheet: Sheet, r: number, c: number) => {
  const v = wb.value(sheet, r, c);
  return v !== null && v !== "";
};

/** Ctrl+arrow: to the edge of the data, as Excel jumps. */
export function jump(wb: Workbook, sheet: Sheet, row: number, col: number, dr: number, dc: number): { row: number; col: number } {
  const { rows, cols } = wb.bounds(sheet);
  const maxR = MAX_ROWS - 1;
  const maxC = MAX_COLS - 1;
  const inside = (r: number, c: number) => r >= 0 && c >= 0 && r <= maxR && c <= maxC;
  let r = row;
  let c = col;
  const here = filled(wb, sheet, r, c);
  const next = filled(wb, sheet, r + dr, c + dc) && inside(r + dr, c + dc);
  if (here && next) {
    while (inside(r + dr, c + dc) && filled(wb, sheet, r + dr, c + dc)) {
      r += dr;
      c += dc;
    }
    return { row: r, col: c };
  }
  // skip the empty run to the next filled cell, or the sheet's edge
  r += dr;
  c += dc;
  while (inside(r, c) && !filled(wb, sheet, r, c)) {
    if ((dr > 0 && r >= rows) || (dc > 0 && c >= cols)) return { row: dr > 0 ? maxR : r, col: dc > 0 ? maxC : c };
    r += dr;
    c += dc;
  }
  if (!inside(r, c)) return { row: Math.max(0, Math.min(maxR, r)), col: Math.max(0, Math.min(maxC, c)) };
  return { row: r, col: c };
}

/** The block of filled cells around a cell (Ctrl+A, AutoSum, sorting). */
export function currentRegion(wb: Workbook, sheet: Sheet, row: number, col: number): Area {
  let area = { r1: row, c1: col, r2: row, c2: col };
  for (let grew = true; grew; ) {
    grew = false;
    const any = (r1: number, c1: number, r2: number, c2: number) => {
      for (let r = Math.max(0, r1); r <= r2; r++) for (let c = Math.max(0, c1); c <= c2; c++) if (filled(wb, sheet, r, c)) return true;
      return false;
    };
    if (area.r1 > 0 && any(area.r1 - 1, area.c1 - 1, area.r1 - 1, area.c2 + 1)) (area = { ...area, r1: area.r1 - 1 }), (grew = true);
    if (any(area.r2 + 1, area.c1 - 1, area.r2 + 1, area.c2 + 1)) (area = { ...area, r2: area.r2 + 1 }), (grew = true);
    if (area.c1 > 0 && any(area.r1 - 1, area.c1 - 1, area.r2 + 1, area.c1 - 1)) (area = { ...area, c1: area.c1 - 1 }), (grew = true);
    if (any(area.r1 - 1, area.c2 + 1, area.r2 + 1, area.c2 + 1)) (area = { ...area, c2: area.c2 + 1 }), (grew = true);
    if (area.r2 - area.r1 > 200_000) break;
  }
  return area;
}

/** AutoSum: SUM (or another function) of the numbers above or to the left, or under a selection. */
export function autoSum(wb: Workbook, sheet: Sheet, sel: Selection, fn = "SUM"): { row: number; col: number; formula: string } | null {
  const area = sel.ranges[sel.ranges.length - 1]!;
  const single = area.r1 === area.r2 && area.c1 === area.c2;
  if (!single) {
    // a selected block of numbers: totals under each column
    wb.transact("AutoSum", () => {
      for (let c = area.c1; c <= area.c2; c++) {
        const target = area.r2 + 1;
        const empty = !filled(wb, sheet, area.r2, c);
        const row = empty ? area.r2 : target;
        const last = empty ? area.r2 - 1 : area.r2;
        if (last < area.r1) continue;
        wb.setInput(sheet, row, c, `=${fn}(${cellName(area.r1, c)}:${cellName(last, c)})`);
      }
    });
    return null;
  }
  const { row, col } = sel.active;
  const numeric = (r: number, c: number) => typeof wb.value(sheet, r, c) === "number";
  let r = row - 1;
  while (r >= 0 && !numeric(r, col) && filled(wb, sheet, r, col) === false && r > row - 2) r--;
  if (r >= 0 && numeric(r, col)) {
    let top = r;
    while (top - 1 >= 0 && numeric(top - 1, col)) top--;
    return { row, col, formula: `=${fn}(${cellName(top, col)}:${cellName(r, col)})` };
  }
  let c = col - 1;
  if (c >= 0 && numeric(row, c)) {
    let left = c;
    while (left - 1 >= 0 && numeric(row, left - 1)) left--;
    return { row, col, formula: `=${fn}(${cellName(row, left)}:${cellName(row, c)})` };
  }
  return { row, col, formula: `=${fn}()` };
}

/** Sort the selected block (or the data around the active cell) by a column. */
export function sortArea(wb: Workbook, sheet: Sheet, sel: Selection, descending: boolean, byCol?: number, hasHeader?: boolean) {
  let area = normal(sel.ranges[sel.ranges.length - 1]!);
  if (area.r1 === area.r2 && area.c1 === area.c2) area = currentRegion(wb, sheet, area.r1, area.c1);
  else area = usedAreas(wb, sheet, { ...sel, ranges: [area] })[0]!;
  const column = byCol ?? sel.active.col;
  // a first row of text over a column of numbers (or dates) is a header
  // a first row of labels (all text, bold, or text over numbers) is a header and stays put
  const header = hasHeader ?? isHeaderRow(wb, sheet, area, column);
  const start = header ? area.r1 + 1 : area.r1;
  if (start >= area.r2) return;
  type Row = { cells: ReturnType<Sheet["cells"]["get"]>[]; key: Scalar; from: number };
  const rows: Row[] = [];
  for (let r = start; r <= area.r2; r++) {
    const cells = [];
    for (let c = area.c1; c <= area.c2; c++) cells.push(sheet.cells.get(key(r, c)));
    rows.push({ cells, key: wb.value(sheet, r, column), from: r });
  }
  rows.sort((a, b) => {
    if (a.key === null && b.key !== null) return 1;
    if (b.key === null && a.key !== null) return -1;
    const c = compareValues(a.key, b.key);
    return (descending ? -c : c) || a.from - b.from;
  });
  wb.transact("Sort", () => {
    rows.forEach((row, i) => {
      const r = start + i;
      row.cells.forEach((cell, k) => {
        const c = area.c1 + k;
        if (!cell) wb.putCell(sheet, r, c, null);
        else if (cell.f !== undefined) wb.putCell(sheet, r, c, { v: null, f: moveRowRefs(cell.f, row.from, r), s: cell.s, note: cell.note });
        else wb.putCell(sheet, r, c, { v: cell.v, s: cell.s, note: cell.note });
      });
    });
  });
}

export function isHeaderRow(wb: Workbook, sheet: Sheet, area: Area, column: number): boolean {
  if (area.r1 === area.r2) return false;
  for (let c = area.c1; c <= area.c2; c++) {
    const v = wb.value(sheet, area.r1, c);
    if (v !== null && typeof v !== "string") return false;
  }
  return boldRow(wb, sheet, area) || typeof wb.value(sheet, area.r1 + 1, column) !== "string";
}

function boldRow(wb: Workbook, sheet: Sheet, area: Area): boolean {
  for (let c = area.c1; c <= area.c2; c++) if (wb.style(sheet.cells.get(key(area.r1, c))?.s).bold) return true;
  return false;
}

/** A formula moved from one row to another (relative row parts follow, as sorting does in Excel). */
function moveRowRefs(f: string, from: number, to: number): string {
  if (from === to) return f;
  return tokenize(f)
    .map((t) => {
      if (t.type !== "ref" || !t.ref) return t.text;
      const ref = { ...t.ref };
      if (ref.kind !== "cols") {
        if (!ref.ar1) ref.r1 += to - from;
        if (!ref.ar2) ref.r2 += to - from;
      }
      if (ref.r1 < 0 || ref.r2 < 0) return "#REF!";
      return refText(ref);
    })
    .join("");
}

/** Ctrl+D and Ctrl+R: copy the first row (or column) of the selection into the rest. */
export function fillFrom(wb: Workbook, sheet: Sheet, sel: Selection, direction: "down" | "right") {
  for (const a of usedAreas(wb, sheet, sel)) {
    if (direction === "down") {
      const src = a.r1 === a.r2 ? { ...a, r1: Math.max(0, a.r1 - 1), r2: Math.max(0, a.r1 - 1) } : { ...a, r2: a.r1 };
      autofill(wb, sheet, src, { ...a, r1: src.r1 }, true);
    } else {
      const src = a.c1 === a.c2 ? { ...a, c1: Math.max(0, a.c1 - 1), c2: Math.max(0, a.c1 - 1) } : { ...a, c2: a.c1 };
      autofill(wb, sheet, src, { ...a, c1: src.c1 }, true);
    }
  }
}

/** F4 while editing a formula: cycle the reference at the caret through A1, $A$1, A$1, $A1. */
export function toggleAbsolute(text: string, caret: number): { text: string; caret: number } {
  if (!text.startsWith("=")) return { text, caret };
  const tokens = tokenize(text.slice(1));
  let pos = 1;
  for (const t of tokens) {
    const start = pos;
    const end = pos + t.text.length;
    pos = end;
    if (t.type !== "ref" || !t.ref || caret < start || caret > end) continue;
    const ref = { ...t.ref };
    const state = (ref.ac1 ? 2 : 0) + (ref.ar1 ? 1 : 0); // 0 A1, 3 $A$1, 1 A$1, 2 $A1
    const next = state === 0 ? 3 : state === 3 ? 1 : state === 1 ? 2 : 0;
    ref.ac1 = ref.ac2 = (next & 2) !== 0;
    ref.ar1 = ref.ar2 = (next & 1) !== 0;
    const replacement = refText(ref);
    return { text: text.slice(0, start) + replacement + text.slice(end), caret: start + replacement.length };
  }
  return { text, caret };
}

/** Insert or delete whole rows or columns for the selection (or ask which, for a block of cells). */
export function shiftSelection(wb: Workbook, sheet: Sheet, sel: Selection, axis: "rows" | "cols", insert: boolean) {
  const area = sel.ranges[sel.ranges.length - 1]!;
  const at = axis === "rows" ? area.r1 : area.c1;
  const count = axis === "rows" ? area.r2 - area.r1 + 1 : area.c2 - area.c1 + 1;
  wb.transact(insert ? `Insert ${axis}` : `Delete ${axis}`, () => wb.shift(sheet, axis, at, insert ? Math.min(count, axis === "rows" ? 100_000 : 1000) : -count));
}

export function statusOf(wb: Workbook, sheet: Sheet, sel: Selection): { sum: number; count: number; numbers: number; min: number; max: number } | null {
  const areas = usedAreas(wb, sheet, sel);
  let count = 0;
  let numbers = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let cells = 0;
  for (const a of areas)
    for (let r = a.r1; r <= a.r2; r++)
      for (let c = a.c1; c <= a.c2; c++) {
        if (++cells > 400_000) return null;
        const v = wb.value(sheet, r, c);
        if (v === null || v === "") continue;
        count++;
        if (typeof v === "number") {
          numbers++;
          sum += v;
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
      }
  if (cells <= 1) return null;
  return { sum, count, numbers, min, max };
}

/** Selection text for the name box: "B3", or "4R x 2C" while dragging. */
export function describeArea(a: Area): string {
  return a.r1 === a.r2 && a.c1 === a.c2 ? cellName(a.r1, a.c1) : `${cellName(a.r1, a.c1)}:${cellName(a.r2, a.c2)}`;
}

export { keyRow, keyCol };
