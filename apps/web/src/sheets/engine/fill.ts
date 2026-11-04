// AutoFill (drag the fill handle to continue a series), and copy and paste between ranges and
// other apps (tab-separated text and HTML tables).
import { type Area, key, keyCol, keyRow } from "./address";
import { DAYS, MONTHS } from "./dates";
import { isDateFormat } from "./format";
import { shiftFormula } from "./parser";
import { CellError, type Scalar } from "./values";
import { parseInput, type Cell, type Sheet, type Style, type Workbook } from "./workbook";

interface Source {
  v: Scalar;
  f?: string;
  s?: number;
  note?: string;
}

const LISTS: string[][] = [
  MONTHS,
  MONTHS.map((m) => m.slice(0, 3)),
  DAYS,
  DAYS.map((d) => d.slice(0, 3)),
  ["Q1", "Q2", "Q3", "Q4"],
];

function listOf(text: string): { list: string[]; index: number; upper: boolean; lower: boolean } | null {
  for (const list of LISTS) {
    const index = list.findIndex((x) => x.toLowerCase() === text.toLowerCase());
    if (index >= 0) return { list, index, upper: text === text.toUpperCase() && text !== text.toLowerCase(), lower: text === text.toLowerCase() };
  }
  return null;
}

function caseLike(word: string, like: { upper: boolean; lower: boolean }): string {
  return like.upper ? word.toUpperCase() : like.lower ? word.toLowerCase() : word;
}

const NUMBERED = /^(.*?)(\d+)(\D*)$/;

/** Values for `count` cells after the source cells (in order), the way Excel's AutoFill continues them. */
export function series(src: Source[], count: number, styles: Style[], copyOnly = false): Source[] {
  const out: Source[] = [];
  const n = src.length;
  if (!n) return out;
  const isDate = (c: Source) => isDateFormat(styles[c.s ?? 0]?.format ?? "General");
  if (copyOnly) {
    for (let i = 0; i < count; i++) {
      const s = src[i % n]!;
      out.push({ ...s });
    }
    return out;
  }
  // numbers (or dates) that are all plain values: a linear trend
  const numeric = src.every((c) => c.f === undefined && typeof c.v === "number");
  if (numeric && (n > 1 || isDate(src[0]!))) {
    const ys = src.map((c) => c.v as number);
    let step = 1;
    let start = ys[0]!;
    if (n > 1) {
      const mx = (n - 1) / 2;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      let sxy = 0;
      let sxx = 0;
      ys.forEach((y, i) => {
        sxy += (i - mx) * (y - my);
        sxx += (i - mx) ** 2;
      });
      step = sxx ? sxy / sxx : 0;
      start = my - step * mx;
    }
    for (let i = 0; i < count; i++) out.push({ v: Number((start + step * (n + i)).toPrecision(15)), s: src[(n + i) % n]!.s });
    return out;
  }
  // list items (months, days, quarters) with a steady step
  const lists = src.map((c) => (typeof c.v === "string" && c.f === undefined ? listOf(c.v) : null));
  if (lists.every((l) => l && l.list === lists[0]!.list)) {
    const first = lists[0]!;
    const len = first.list.length;
    const step = n > 1 ? (((lists[1]!.index - first.index) % len) + len) % len || 1 : 1;
    const steady = lists.every((l, i) => l!.index === (first.index + i * step) % len);
    if (steady) {
      for (let i = 0; i < count; i++) {
        const idx = (first.index + (n + i) * step) % len;
        out.push({ v: caseLike(first.list[idx]!, lists[(n + i) % n]!), s: src[(n + i) % n]!.s });
      }
      return out;
    }
  }
  // text with a number in it: "Item 1" → "Item 2", "Week 3 plan" keeps the rest
  const numbered = src.map((c) => (typeof c.v === "string" && c.f === undefined ? NUMBERED.exec(c.v) : null));
  if (numbered.every((m) => m && m[1] === numbered[0]![1] && m[3] === numbered[0]![3])) {
    const nums = numbered.map((m) => Number(m![2]));
    const step = n > 1 ? nums[1]! - nums[0]! : 1;
    const steady = nums.every((x, i) => x === nums[0]! + i * step);
    if (steady) {
      const width = numbered[0]![2]!.length;
      for (let i = 0; i < count; i++) {
        const next = Math.abs(nums[0]! + (n + i) * step);
        out.push({ v: numbered[0]![1] + String(next).padStart(width, "0") + numbered[0]![3], s: src[(n + i) % n]!.s });
      }
      return out;
    }
  }
  // otherwise each source cell repeats: single numbers copy, text with a number counts on its own
  for (let i = 0; i < count; i++) {
    const s = src[(n + i) % n]!;
    const turn = Math.floor((n + i) / n);
    if (n === 1 && typeof s.v === "string" && s.f === undefined) {
      const l = listOf(s.v);
      if (l) {
        out.push({ v: caseLike(l.list[(l.index + turn) % l.list.length]!, l), s: s.s });
        continue;
      }
      const m = NUMBERED.exec(s.v);
      if (m) {
        out.push({ v: m[1] + String(Number(m[2]) + turn).padStart(m[2]!.length, "0") + m[3], s: s.s });
        continue;
      }
    }
    out.push({ ...s });
  }
  return out;
}

/** Fill from `source` into `target` (which extends it in one direction), as dragging the fill handle does. */
export function autofill(wb: Workbook, sheet: Sheet, source: Area, target: Area, copyOnly = false) {
  const down = target.r2 > source.r2;
  const up = target.r1 < source.r1;
  const right = target.c2 > source.c2;
  const left = target.c1 < source.c1;
  const vertical = down || up;
  wb.transact("AutoFill", () => {
    const lines = vertical ? source.c2 - source.c1 + 1 : source.r2 - source.r1 + 1;
    for (let line = 0; line < lines; line++) {
      const cells: { r: number; c: number }[] = [];
      if (vertical) for (let r = source.r1; r <= source.r2; r++) cells.push({ r, c: source.c1 + line });
      else for (let c = source.c1; c <= source.c2; c++) cells.push({ r: source.r1 + line, c });
      if (up || left) cells.reverse();
      const src: Source[] = cells.map(({ r, c }) => {
        const cell = sheet.cells.get(key(r, c));
        return { v: cell?.f !== undefined ? null : (cell?.v ?? null), f: cell?.f, s: cell?.s };
      });
      const count = vertical ? (down ? target.r2 - source.r2 : source.r1 - target.r1) : right ? target.c2 - source.c2 : source.c1 - target.c1;
      const values = series(src, count, wb.styles, copyOnly);
      values.forEach((v, i) => {
        const r = vertical ? (down ? source.r2 + 1 + i : source.r1 - 1 - i) : source.r1 + line;
        const c = vertical ? source.c1 + line : right ? source.c2 + 1 + i : source.c1 - 1 - i;
        // formulas move with the distance from the source cell they repeat
        const from = cells[i % cells.length]!;
        if (v.f !== undefined) {
          const f = shiftFormula(v.f, r - from.r, c - from.c);
          wb.putCell(sheet, r, c, { v: null, f, s: v.s });
        } else wb.putCell(sheet, r, c, v.v === null && !v.s ? null : { v: v.v, s: v.s });
      });
    }
  });
}

// --------------------------------------------------------------------------------- clipboard

export interface ClipCell {
  v: Scalar;
  f?: string;
  s?: Style;
  note?: string;
}
export interface Clip {
  rows: number;
  cols: number;
  cells: (ClipCell | null)[][];
  /** Where it was copied from, for formulas to move relative to. */
  origin: { row: number; col: number };
  text: string;
  cut?: { sheet: number; area: Area };
}

let lastClip: Clip | null = null;
export const clipboardMemory = {
  get: () => lastClip,
  set: (clip: Clip | null) => {
    lastClip = clip;
  },
};

function tsvField(text: string): string {
  return /[\t\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Copy an area: values as shown (text), with formulas and styles kept for pasting here. */
export function copyArea(wb: Workbook, sheet: Sheet, area: Area): { clip: Clip; text: string; html: string } {
  const cells: (ClipCell | null)[][] = [];
  const lines: string[] = [];
  const html: string[] = ["<table>"];
  for (let r = area.r1; r <= area.r2; r++) {
    if (sheet.hiddenRows.has(r) && area.r2 > area.r1) continue;
    const row: (ClipCell | null)[] = [];
    const fields: string[] = [];
    const tds: string[] = [];
    for (let c = area.c1; c <= area.c2; c++) {
      const cell = sheet.cells.get(key(r, c));
      const shown = wb.display(sheet, r, c);
      const style = cell?.s ? wb.style(cell.s) : undefined;
      row.push(cell || shown.value !== null ? { v: cell?.f !== undefined ? shown.value : shown.value, f: cell?.f, s: style, note: cell?.note } : null);
      fields.push(tsvField(shown.text));
      const css = style ? [style.bold ? "font-weight:bold" : "", style.italic ? "font-style:italic" : "", style.color ? `color:${style.color}` : "", style.fill ? `background:${style.fill}` : ""].filter(Boolean).join(";") : "";
      tds.push(`<td${css ? ` style="${css}"` : ""}>${escapeHtml(shown.text)}</td>`);
    }
    cells.push(row);
    lines.push(fields.join("\t"));
    html.push(`<tr>${tds.join("")}</tr>`);
  }
  html.push("</table>");
  const text = lines.join("\n");
  const clip: Clip = { rows: cells.length, cols: area.c2 - area.c1 + 1, cells, origin: { row: area.r1, col: area.c1 }, text };
  return { clip, text, html: html.join("") };
}

/** Text from another app as rows of fields: tab-separated, with quoted fields. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const t = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (quoted) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === "\t") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/** Rows from an HTML table (pasted from a web page, Excel or Google Sheets). */
export function parseHtmlTable(html: string): string[][] | null {
  if (!/<table/i.test(html)) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return null;
  const rows: string[][] = [];
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    const row: string[] = [];
    for (const td of Array.from(tr.querySelectorAll("td,th"))) {
      row.push((td.textContent ?? "").replace(/ /g, " ").trim());
      const span = Number(td.getAttribute("colspan") ?? 1);
      for (let i = 1; i < span; i++) row.push("");
    }
    rows.push(row);
  }
  return rows.length ? rows : null;
}

export type PasteMode = "all" | "values" | "formulas" | "formats" | "transpose";

/** Paste a copied block (or text rows) at a cell; a selection that is a multiple of the block repeats it. */
export function paste(wb: Workbook, sheet: Sheet, at: Area, data: Clip | string[][], mode: PasteMode = "all", skipBlanks = false): Area {
  let clip: Clip;
  if (Array.isArray(data)) {
    const cols = Math.max(...data.map((r) => r.length));
    clip = { rows: data.length, cols, cells: data.map((r) => Array.from({ length: cols }, (_, c) => ({ v: null, raw: r[c] ?? "" }) as unknown as ClipCell)), origin: { row: at.r1, col: at.c1 }, text: "" };
  } else clip = data;
  const transpose = mode === "transpose";
  const height = transpose ? clip.cols : clip.rows;
  const width = transpose ? clip.rows : clip.cols;
  const selRows = at.r2 - at.r1 + 1;
  const selCols = at.c2 - at.c1 + 1;
  const repeatR = selRows % height === 0 ? selRows / height : 1;
  const repeatC = selCols % width === 0 ? selCols / width : 1;
  const area = { r1: at.r1, c1: at.c1, r2: at.r1 + height * repeatR - 1, c2: at.c1 + width * repeatC - 1 };
  wb.transact("Paste", () => {
    // a cut moves the cells: clear the source first (unless it is the same place)
    if (!Array.isArray(data) && data.cut && !(data.cut.sheet === sheet.uid && data.cut.area.r1 === at.r1 && data.cut.area.c1 === at.c1)) {
      const from = wb.sheet(data.cut.sheet);
      if (from) wb.clear(from, data.cut.area, "all");
    }
    for (let rr = 0; rr < repeatR; rr++)
      for (let cc = 0; cc < repeatC; cc++)
        for (let r = 0; r < height; r++)
          for (let c = 0; c < width; c++) {
            const src = transpose ? clip.cells[c]?.[r] : clip.cells[r]?.[c];
            const row = area.r1 + rr * height + r;
            const col = area.c1 + cc * width + c;
            const existing = sheet.cells.get(key(row, col));
            const raw = (src as unknown as { raw?: string } | null)?.raw;
            if (raw !== undefined) {
              if (mode === "formats") continue;
              if (raw === "") wb.putCell(sheet, row, col, existing?.s ? { v: null, s: existing.s } : null);
              else wb.setInput(sheet, row, col, raw);
              continue;
            }
            if (skipBlanks && (!src || (src.v === null && src.f === undefined))) continue;
            if (!src) {
              if (mode === "all" || mode === "transpose") wb.putCell(sheet, row, col, null);
              else if (mode === "values" || mode === "formulas") wb.putCell(sheet, row, col, existing?.s ? { v: null, s: existing.s } : null);
              continue;
            }
            const style = mode === "values" || mode === "formulas" ? existing?.s : src.s ? wb.styleId(src.s) : undefined;
            if (mode === "formats") {
              wb.putCell(sheet, row, col, existing ? { ...existing, v: existing.f !== undefined ? null : existing.v, s: style } : { v: null, s: style });
              continue;
            }
            const sourceRow = clip.origin.row + (transpose ? c : r);
            const sourceCol = clip.origin.col + (transpose ? r : c);
            let cell: Cell;
            if (src.f !== undefined && mode !== "values") {
              // a cut keeps references as they are; a copy moves the relative ones
              const isCut = !Array.isArray(data) && data.cut;
              cell = { v: null, f: isCut ? src.f : shiftFormula(src.f, row - sourceRow, col - sourceCol), s: style, note: src.note };
            } else cell = { v: src.v instanceof CellError || typeof src.v !== "object" ? src.v : null, s: style, note: mode === "all" ? src.note : existing?.note };
            wb.putCell(sheet, row, col, cell);
          }
  });
  return area;
}

/** Text in a cell from a paste: what parseInput makes of it (for tests and imports). */
export function inputValue(text: string): Scalar {
  return parseInput(text).value;
}

export { keyRow, keyCol };
