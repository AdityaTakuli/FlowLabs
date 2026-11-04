// Excel's data features on a sheet: AutoFilter, multi-level sort, data validation, conditional
// formatting, Text to Columns, Remove Duplicates, Flash Fill, Tables, PivotTables and chart data.
import { type Area, colName, key, MAX_COLS, MAX_ROWS } from "./address";
import { criteria } from "./evaluate";
import { formatValue } from "./format";
import { parse, refText, shiftFormula, tokenize } from "./parser";
import { CellError, compareValues, isMatrix, Matrix, parseNumber, type Scalar } from "./values";
import { parseDate } from "./dates";
import type { AutoFilter, FilterSpec, PivotDef, Sheet, Style, TableDef, Validation, Workbook } from "./workbook";

export const uid = () => Math.random().toString(36).slice(2, 10);
const inArea = (a: Area, r: number, c: number) => r >= a.r1 && r <= a.r2 && c >= a.c1 && c <= a.c2;
const text = (wb: Workbook, sheet: Sheet, r: number, c: number) => wb.display(sheet, r, c).text;

/** The used rows of an area (whole columns stop at the data). */
export function usedArea(wb: Workbook, sheet: Sheet, a: Area): Area {
  const b = wb.bounds(sheet);
  return { r1: a.r1, c1: a.c1, r2: Math.min(a.r2, Math.max(a.r1, b.rows - 1)), c2: Math.min(a.c2, Math.max(a.c1, b.cols - 1)) };
}

/** The block of data around a cell (as Excel picks for Sort, Filter, Table and PivotTable). */
export function region(wb: Workbook, sheet: Sheet, row: number, col: number): Area {
  const filled = (r: number, c: number) => r >= 0 && c >= 0 && (() => {
    const v = wb.value(sheet, r, c);
    return v !== null && v !== "";
  })();
  let a = { r1: row, c1: col, r2: row, c2: col };
  for (let grew = true; grew; ) {
    grew = false;
    const any = (r1: number, c1: number, r2: number, c2: number) => {
      for (let r = Math.max(0, r1); r <= r2; r++) for (let c = Math.max(0, c1); c <= c2; c++) if (filled(r, c)) return true;
      return false;
    };
    if (a.r1 > 0 && any(a.r1 - 1, a.c1 - 1, a.r1 - 1, a.c2 + 1)) (a = { ...a, r1: a.r1 - 1 }), (grew = true);
    if (any(a.r2 + 1, a.c1 - 1, a.r2 + 1, a.c2 + 1)) (a = { ...a, r2: a.r2 + 1 }), (grew = true);
    if (a.c1 > 0 && any(a.r1 - 1, a.c1 - 1, a.r2 + 1, a.c1 - 1)) (a = { ...a, c1: a.c1 - 1 }), (grew = true);
    if (any(a.r1 - 1, a.c2 + 1, a.r2 + 1, a.c2 + 1)) (a = { ...a, c2: a.c2 + 1 }), (grew = true);
    if (a.r2 - a.r1 > 1_048_000) break;
  }
  return a;
}

/** The area a command works on: the selection when it is a block, otherwise the data around the cell. */
export function targetArea(wb: Workbook, sheet: Sheet, selection: Area, active: { row: number; col: number }): Area {
  if (selection.r1 !== selection.r2 || selection.c1 !== selection.c2) return usedArea(wb, sheet, selection);
  return region(wb, sheet, active.row, active.col);
}

// -------------------------------------------------------------------------------- AutoFilter

export function rowHidden(sheet: Sheet, row: number): boolean {
  return sheet.hiddenRows.has(row) || sheet.filterHidden.has(row);
}

/** Whether a value passes a column's filter. `all` is the column's values, for top 10 and average. */
function passes(spec: FilterSpec, value: Scalar, shown: string, all: number[]): boolean {
  if (spec.values && !spec.values.includes(shown)) return false;
  if (spec.cond) {
    const one = (op: string, v: string) => {
      const n = parseNumber(v, parseDate);
      const test = criteria(op === "contains" ? `*${v}*` : op === "notContains" ? `<>*${v}*` : op === "begins" ? `${v}*` : op === "ends" ? `*${v}` : `${op}${n ?? v}`);
      return test(typeof value === "number" || n === null ? value : value);
    };
    const first = one(spec.cond.op, spec.cond.value);
    if (spec.cond.op2) {
      const second = one(spec.cond.op2, spec.cond.value2 ?? "");
      if (spec.cond.join === "or" ? !(first || second) : !(first && second)) return false;
    } else if (!first) return false;
  }
  if (spec.top) {
    if (typeof value !== "number") return false;
    const sorted = [...all].sort((a, b) => (spec.top!.bottom ? a - b : b - a));
    const n = spec.top.percent ? Math.max(1, Math.ceil((sorted.length * spec.top.n) / 100)) : spec.top.n;
    const edge = sorted[Math.min(sorted.length, n) - 1];
    if (edge === undefined) return false;
    if (spec.top.bottom ? value > edge : value < edge) return false;
  }
  return true;
}

/** Hide the rows that fail the filter (and show the rest). */
export function applyFilter(wb: Workbook, sheet: Sheet) {
  const f = sheet.filter;
  const hidden = new Set<number>();
  if (f) {
    const columns = Object.entries(f.columns).filter(([, spec]) => spec.values || spec.cond || spec.top);
    if (columns.length) {
      const nums = new Map<number, number[]>();
      for (const [c] of columns) {
        const col = Number(c);
        const list: number[] = [];
        for (let r = f.area.r1 + 1; r <= f.area.r2; r++) {
          const v = wb.value(sheet, r, col);
          if (typeof v === "number") list.push(v);
        }
        nums.set(col, list);
      }
      for (let r = f.area.r1 + 1; r <= f.area.r2; r++)
        for (const [c, spec] of columns) {
          const col = Number(c);
          if (!passes(spec, wb.value(sheet, r, col), text(wb, sheet, r, col), nums.get(col)!)) {
            hidden.add(r);
            break;
          }
        }
    }
  }
  wb.setSheetProp(sheet, "filterHidden", hidden);
}

export function toggleFilter(wb: Workbook, sheet: Sheet, area: Area) {
  wb.transact(sheet.filter ? "Remove filter" : "Filter", () => {
    if (sheet.filter) {
      wb.setSheetProp(sheet, "filter", undefined);
      wb.setSheetProp(sheet, "filterHidden", new Set());
    } else {
      wb.setSheetProp(sheet, "filter", { area, columns: {} } as AutoFilter);
      const st = wb.style(sheet.cells.get(key(area.r1, area.c1))?.s);
      if (!st.bold) wb.setStyle(sheet, { ...area, r2: area.r1 }, { bold: true });
    }
  });
}

export function setColumnFilter(wb: Workbook, sheet: Sheet, col: number, spec: FilterSpec | null) {
  const f = sheet.filter;
  if (!f) return;
  wb.transact("Filter", () => {
    const columns = { ...f.columns };
    if (spec) columns[col] = spec;
    else delete columns[col];
    wb.setSheetProp(sheet, "filter", { ...f, columns });
    applyFilter(wb, sheet);
  });
}

/** A column's distinct shown values, for the filter's checklist (sorted as Excel sorts them). */
export function columnValues(wb: Workbook, sheet: Sheet, col: number, area: Area): { text: string; value: Scalar; count: number }[] {
  const seen = new Map<string, { text: string; value: Scalar; count: number }>();
  for (let r = area.r1 + 1; r <= area.r2; r++) {
    const shown = wb.display(sheet, r, col);
    const t = shown.text;
    const found = seen.get(t);
    if (found) found.count++;
    else seen.set(t, { text: t, value: shown.value, count: 1 });
    if (seen.size > 10_000) break;
  }
  return [...seen.values()].sort((a, b) => {
    if (a.text === "") return 1;
    if (b.text === "") return -1;
    return compareValues(a.value, b.value);
  });
}

// ------------------------------------------------------------------------------------- sort

export interface SortKey {
  col: number; // a column (or row, for left-to-right) on the sheet
  desc: boolean;
  /** "value", or sort by a cell or font colour first. */
  by?: "value" | "fill" | "color";
  color?: string;
  /** A custom order (e.g. months). */
  order?: string[];
}

export function sortRange(wb: Workbook, sheet: Sheet, area: Area, keys: SortKey[], header: boolean, leftToRight = false) {
  const start = leftToRight ? area.c1 + (header ? 1 : 0) : area.r1 + (header ? 1 : 0);
  const end = leftToRight ? area.c2 : area.r2;
  if (start >= end) return;
  type Line = { cells: ReturnType<Sheet["cells"]["get"]>[]; keys: Scalar[]; styles: Style[]; from: number };
  const lines: Line[] = [];
  for (let i = start; i <= end; i++) {
    const cells = [];
    const len = leftToRight ? area.r2 - area.r1 + 1 : area.c2 - area.c1 + 1;
    for (let j = 0; j < len; j++) cells.push(leftToRight ? sheet.cells.get(key(area.r1 + j, i)) : sheet.cells.get(key(i, area.c1 + j)));
    lines.push({
      cells,
      keys: keys.map((k) => (leftToRight ? wb.value(sheet, k.col, i) : wb.value(sheet, i, k.col))),
      styles: keys.map((k) => wb.style((leftToRight ? sheet.cells.get(key(k.col, i)) : sheet.cells.get(key(i, k.col)))?.s)),
      from: i,
    });
  }
  lines.sort((a, b) => {
    for (let k = 0; k < keys.length; k++) {
      const spec = keys[k]!;
      if (spec.by === "fill" || spec.by === "color") {
        const ha = (spec.by === "fill" ? a.styles[k]!.fill : a.styles[k]!.color) === spec.color;
        const hb = (spec.by === "fill" ? b.styles[k]!.fill : b.styles[k]!.color) === spec.color;
        if (ha !== hb) return ha === !spec.desc ? -1 : 1;
        continue;
      }
      const x = a.keys[k] ?? null;
      const y = b.keys[k] ?? null;
      if (x === null && y !== null) return 1;
      if (y === null && x !== null) return -1;
      let c: number;
      if (spec.order) {
        const ix = spec.order.findIndex((o) => o.toLowerCase() === String(x).toLowerCase());
        const iy = spec.order.findIndex((o) => o.toLowerCase() === String(y).toLowerCase());
        c = (ix < 0 ? 1e9 : ix) - (iy < 0 ? 1e9 : iy);
      } else c = compareValues(x, y);
      if (c) return spec.desc ? -c : c;
    }
    return a.from - b.from;
  });
  wb.transact("Sort", () => {
    lines.forEach((line, n) => {
      const i = start + n;
      line.cells.forEach((cell, j) => {
        const r = leftToRight ? area.r1 + j : i;
        const c = leftToRight ? i : area.c1 + j;
        if (!cell) wb.putCell(sheet, r, c, null);
        else if (cell.f !== undefined) wb.putCell(sheet, r, c, { v: null, f: moveRefs(cell.f, leftToRight ? 0 : i - line.from, leftToRight ? i - line.from : 0, area), s: cell.s, note: cell.note });
        else wb.putCell(sheet, r, c, { v: cell.v, s: cell.s, note: cell.note });
      });
    });
    if (sheet.filter) applyFilter(wb, sheet);
  });
}

/** Sorting moves a formula with its row: relative references to cells in its own row move too. */
function moveRefs(f: string, dr: number, dc: number, area: Area): string {
  if (!dr && !dc) return f;
  return tokenize(f)
    .map((t) => {
      if (t.type !== "ref" || !t.ref) return t.text;
      const ref = { ...t.ref };
      if (dr && ref.kind !== "cols") {
        if (!ref.ar1) ref.r1 += dr;
        if (!ref.ar2) ref.r2 += dr;
      }
      if (dc && ref.kind !== "rows") {
        if (!ref.ac1) ref.c1 += dc;
        if (!ref.ac2) ref.c2 += dc;
      }
      void area;
      if (ref.r1 < 0 || ref.c1 < 0 || ref.r2 >= MAX_ROWS || ref.c2 >= MAX_COLS) return "#REF!";
      return refText(ref);
    })
    .join("");
}

// -------------------------------------------------------------------------- data validation

export function validationAt(sheet: Sheet, row: number, col: number): Validation | undefined {
  for (let i = sheet.validations.length - 1; i >= 0; i--) if (inArea(sheet.validations[i]!.area, row, col)) return sheet.validations[i];
  return undefined;
}

/** A list rule's items: typed ("Yes,No") or from cells ("=$A$1:$A$9", or a name). */
export function listItems(wb: Workbook, sheet: Sheet, v: Validation, row = 0, col = 0): string[] {
  const src = (v.source ?? "").trim();
  if (!src.startsWith("=")) return src.split(/\s*,\s*/).filter((x) => x !== "");
  const result = wb.evaluateFormula(sheet, src.slice(1), row, col);
  const values = isMatrix(result) ? result.data : [result];
  const out: string[] = [];
  for (const val of values) {
    if (val === null || val === "") continue;
    const shown = formatValue(val, "General").text;
    if (!out.includes(shown)) out.push(shown);
  }
  return out;
}

/** Why a value breaks a cell's rule, or null when it is allowed. */
export function checkValidation(wb: Workbook, sheet: Sheet, row: number, col: number, value: Scalar): string | null {
  const v = validationAt(sheet, row, col);
  if (!v || v.kind === "any") return null;
  if (value === null || value === "") return v.allowBlank ? null : "This cell can't be empty.";
  const message = v.error?.message;
  const num = (s: string | undefined): number | null => {
    if (s === undefined || s === "") return null;
    if (s.startsWith("=")) {
      const r = wb.evaluateFormula(sheet, s.slice(1), row, col);
      return typeof r === "number" ? r : null;
    }
    return parseNumber(s, parseDate);
  };
  const compare = (x: number, label: string): string | null => {
    const a = num(v.a);
    const b = num(v.b);
    const ok = (() => {
      switch (v.op ?? "between") {
        case "between": return a !== null && b !== null && x >= a && x <= b;
        case "notBetween": return a !== null && b !== null && (x < a || x > b);
        case "=": return x === a;
        case "<>": return x !== a;
        case ">": return a !== null && x > a;
        case "<": return a !== null && x < a;
        case ">=": return a !== null && x >= a;
        default: return a !== null && x <= a;
      }
    })();
    if (ok) return null;
    const show = (n: number | null) => (n === null ? "" : formatValue(n, v.kind === "date" ? "m/d/yyyy" : v.kind === "time" ? "h:mm AM/PM" : "General").text);
    const rule = v.op === "between" || !v.op ? `between ${show(a)} and ${show(b)}` : v.op === "notBetween" ? `not between ${show(a)} and ${show(b)}` : `${v.op} ${show(a)}`;
    return message ?? `${label} must be ${rule}.`;
  };
  switch (v.kind) {
    case "list": {
      const items = listItems(wb, sheet, v, row, col);
      const shown = formatValue(value, "General").text;
      return items.some((i) => i.toLowerCase() === shown.toLowerCase()) ? null : (message ?? `Choose one of: ${items.slice(0, 12).join(", ")}${items.length > 12 ? "…" : ""}.`);
    }
    case "whole":
      if (typeof value !== "number" || !Number.isInteger(value)) return message ?? "This cell takes a whole number.";
      return compare(value, "The number");
    case "decimal":
      if (typeof value !== "number") return message ?? "This cell takes a number.";
      return compare(value, "The number");
    case "date":
    case "time":
      if (typeof value !== "number") return message ?? `This cell takes a ${v.kind}.`;
      return compare(v.kind === "time" ? value - Math.floor(value) : Math.floor(value), v.kind === "date" ? "The date" : "The time");
    case "length":
      return compare(String(value instanceof CellError ? value.code : value).length, "The length");
    case "custom": {
      const r = wb.evaluateFormula(sheet, (v.source ?? "").replace(/^=/, ""), row, col);
      return r === true || (typeof r === "number" && r !== 0) ? null : (message ?? "The value breaks this cell's rule.");
    }
    default:
      return null;
  }
}

/** Cells whose values break their rules (Circle Invalid Data). */
export function invalidCells(wb: Workbook, sheet: Sheet): { row: number; col: number }[] {
  const out: { row: number; col: number }[] = [];
  for (const v of sheet.validations) {
    const a = usedArea(wb, sheet, v.area);
    for (let r = a.r1; r <= a.r2; r++) for (let c = a.c1; c <= a.c2; c++) if (checkValidation(wb, sheet, r, c, wb.value(sheet, r, c))) out.push({ row: r, col: c });
  }
  return out;
}

// --------------------------------------------------------------------- conditional formatting

export interface CondLook {
  style?: Partial<Style>;
  bar?: { fill: number; color: string };
  icon?: { kind: string; level: number };
}

function interpolate(colors: string[], t: number): string {
  const parse = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const stops = colors.map(parse);
  const scaled = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  return "#" + a.map((v, k) => Math.round(v + (b[k]! - v) * f).toString(16).padStart(2, "0")).join("");
}

/** How conditional formats change each cell in view; rules are checked in order, the last style wins unless one stops. */
export function conditionalLooks(wb: Workbook, sheet: Sheet, view: Area): Map<number, CondLook> {
  const out = new Map<number, CondLook>();
  for (const rule of sheet.conditionals) {
    const area = usedArea(wb, sheet, rule.area);
    if (area.r2 < view.r1 || area.r1 > view.r2 || area.c2 < view.c1 || area.c1 > view.c2) continue;
    // statistics over the whole rule range
    const numbers: number[] = [];
    const counts = new Map<string, number>();
    const needsStats = ["top", "average", "scale", "bar", "icons", "duplicate", "unique"].includes(rule.kind);
    if (needsStats)
      for (let r = area.r1; r <= Math.min(area.r2, area.r1 + 200_000); r++)
        for (let c = area.c1; c <= area.c2; c++) {
          const v = wb.value(sheet, r, c);
          if (typeof v === "number") numbers.push(v);
          if (v !== null && v !== "") {
            const k = typeof v === "string" ? v.toLowerCase() : String(v);
            counts.set(k, (counts.get(k) ?? 0) + 1);
          }
        }
    const min = numbers.length ? Math.min(...numbers) : 0;
    const max = numbers.length ? Math.max(...numbers) : 0;
    const avg = numbers.length ? numbers.reduce((s, x) => s + x, 0) / numbers.length : 0;
    let edge: number | undefined;
    if (rule.kind === "top") {
      const sorted = [...numbers].sort((a, b) => (rule.bottom ? a - b : b - a));
      const n = rule.percent ? Math.max(1, Math.ceil((sorted.length * (rule.n ?? 10)) / 100)) : rule.n ?? 10;
      edge = sorted[Math.min(sorted.length, n) - 1];
    }
    const formula = rule.kind === "formula" && rule.formula ? (() => {
      try {
        parse(rule.formula.replace(/^=/, ""));
        return rule.formula.replace(/^=/, "");
      } catch {
        return null;
      }
    })() : null;
    const r1 = Math.max(area.r1, view.r1);
    const r2 = Math.min(area.r2, view.r2);
    const c1 = Math.max(area.c1, view.c1);
    const c2 = Math.min(area.c2, view.c2);
    for (let r = r1; r <= r2; r++)
      for (let c = c1; c <= c2; c++) {
        const k = key(r, c);
        const prior = out.get(k);
        if (prior && (prior as CondLook & { stopped?: boolean }).stopped) continue;
        const v = wb.value(sheet, r, c);
        let hit = false;
        const look: CondLook = {};
        switch (rule.kind) {
          case "cell": {
            if (v === null) break;
            const n = (s?: string) => {
              if (s === undefined) return null;
              if (s.startsWith("=")) return wb.evaluateFormula(sheet, s.slice(1), r, c) as Scalar;
              return parseNumber(s, parseDate) ?? s;
            };
            const a = n(rule.a);
            const b = n(rule.b);
            const cmp = (x: Scalar) => compareValues(v, x);
            switch (rule.op) {
              case "between": hit = cmp(a) >= 0 && cmp(b) <= 0; break;
              case "notBetween": hit = cmp(a) < 0 || cmp(b) > 0; break;
              case "=": hit = cmp(a) === 0; break;
              case "<>": hit = cmp(a) !== 0; break;
              case ">": hit = cmp(a) > 0; break;
              case "<": hit = cmp(a) < 0; break;
              case ">=": hit = cmp(a) >= 0; break;
              case "<=": hit = cmp(a) <= 0; break;
            }
            break;
          }
          case "text": {
            const t = text(wb, sheet, r, c).toLowerCase();
            const want = (rule.a ?? "").toLowerCase();
            hit = rule.op === "begins" ? t.startsWith(want) : rule.op === "ends" ? t.endsWith(want) : rule.op === "notContains" ? !t.includes(want) : t.includes(want);
            break;
          }
          case "top":
            hit = typeof v === "number" && edge !== undefined && (rule.bottom ? v <= edge : v >= edge);
            break;
          case "average":
            hit = typeof v === "number" && (rule.above === false ? v < avg : v > avg);
            break;
          case "duplicate":
          case "unique": {
            if (v === null || v === "") break;
            const n = counts.get(typeof v === "string" ? v.toLowerCase() : String(v)) ?? 0;
            hit = rule.kind === "duplicate" ? n > 1 : n === 1;
            break;
          }
          case "blank": hit = v === null || v === ""; break;
          case "noblank": hit = !(v === null || v === ""); break;
          case "error": hit = v instanceof CellError; break;
          case "date": {
            if (typeof v !== "number") break;
            const today = Math.floor(wb.evaluateFormula(sheet, "TODAY()") as number);
            const d = Math.floor(v);
            const op = rule.op ?? "today";
            hit = op === "today" ? d === today : op === "yesterday" ? d === today - 1 : op === "tomorrow" ? d === today + 1 : op === "last7" ? d > today - 7 && d <= today : op === "past" ? d < today : d > today;
            break;
          }
          case "formula": {
            if (!formula) break;
            // the formula is written for the rule's top-left cell; it moves with each cell
            const moved = moveRefs(formula, r - area.r1, c - area.c1, area);
            const res = wb.evaluateFormula(sheet, moved, r, c);
            hit = res === true || (typeof res === "number" && res !== 0);
            break;
          }
          case "scale": {
            if (typeof v !== "number" || max === min) {
              if (typeof v === "number") look.style = { fill: (rule.colors ?? ["#f8696b", "#ffeb84", "#63be7b"])[0] };
              hit = typeof v === "number";
              break;
            }
            const colors = rule.colors ?? ["#f8696b", "#ffeb84", "#63be7b"];
            look.style = { fill: interpolate(colors, (v - min) / (max - min)) };
            hit = true;
            break;
          }
          case "bar": {
            if (typeof v !== "number") break;
            const lo = Math.min(0, min);
            const span = max - lo || 1;
            look.bar = { fill: Math.max(0, Math.min(1, (v - lo) / span)), color: rule.colors?.[0] ?? "#638ec6" };
            hit = true;
            break;
          }
          case "icons": {
            if (typeof v !== "number") break;
            const t = max === min ? 1 : (v - min) / (max - min);
            look.icon = { kind: rule.icons ?? "arrows", level: t >= 2 / 3 ? 2 : t >= 1 / 3 ? 1 : 0 };
            hit = true;
            break;
          }
        }
        if (!hit) continue;
        const merged: CondLook & { stopped?: boolean } = { ...prior, ...look, style: { ...prior?.style, ...(rule.style ?? {}), ...(look.style ?? {}) } };
        if (rule.stop) merged.stopped = true;
        out.set(k, merged);
      }
  }
  return out;
}

// ------------------------------------------------------------------------------ data tools

/** Split a column of text into columns, by delimiters or fixed widths. */
export function textToColumns(wb: Workbook, sheet: Sheet, area: Area, opts: { delimiters: string[]; other?: string; consecutive: boolean; quote: string; widths?: number[]; asText?: boolean }) {
  const col = area.c1;
  const delims = [...opts.delimiters, ...(opts.other ? [opts.other] : [])];
  wb.transact("Text to columns", () => {
    for (let r = area.r1; r <= area.r2; r++) {
      const raw = text(wb, sheet, r, col);
      if (!raw) continue;
      let parts: string[];
      if (opts.widths?.length) {
        parts = [];
        let at = 0;
        for (const w of [...opts.widths, Infinity]) {
          parts.push(raw.slice(at, at + w).trim());
          at += w;
          if (at >= raw.length) break;
        }
      } else {
        parts = [];
        let field = "";
        let quoted = false;
        for (let i = 0; i < raw.length; i++) {
          const ch = raw[i]!;
          if (opts.quote && ch === opts.quote) {
            if (quoted && raw[i + 1] === opts.quote) {
              field += ch;
              i++;
            } else quoted = !quoted;
            continue;
          }
          if (!quoted && delims.includes(ch)) {
            if (!(opts.consecutive && field === "" && parts.length && delims.includes(raw[i - 1] ?? ""))) parts.push(field);
            field = "";
          } else field += ch;
        }
        parts.push(field);
      }
      parts.forEach((p, i) => (opts.asText ? wb.setInput(sheet, r, col + i, p === "" ? "" : "'" + p) : wb.setInput(sheet, r, col + i, p)));
    }
  });
}

/** Remove rows whose chosen columns repeat an earlier row; returns how many went. */
export function removeDuplicates(wb: Workbook, sheet: Sheet, area: Area, columns: number[], header: boolean): { removed: number; left: number } {
  const start = area.r1 + (header ? 1 : 0);
  const seen = new Set<string>();
  const keep: number[] = [];
  for (let r = start; r <= area.r2; r++) {
    const id = JSON.stringify(columns.map((c) => {
      const v = wb.value(sheet, r, c);
      return typeof v === "string" ? v.toLowerCase() : v instanceof CellError ? v.code : v;
    }));
    if (seen.has(id)) continue;
    seen.add(id);
    keep.push(r);
  }
  const removed = area.r2 - start + 1 - keep.length;
  if (!removed) return { removed: 0, left: keep.length };
  wb.transact("Remove duplicates", () => {
    const rows = keep.map((r) => {
      const cells = [];
      for (let c = area.c1; c <= area.c2; c++) cells.push(sheet.cells.get(key(r, c)));
      return cells;
    });
    for (let i = 0; i <= area.r2 - start; i++) {
      const r = start + i;
      const cells = rows[i];
      for (let c = area.c1; c <= area.c2; c++) {
        const cell = cells?.[c - area.c1];
        if (!cell) wb.putCell(sheet, r, c, null);
        else wb.putCell(sheet, r, c, cell.f !== undefined ? { v: null, f: cell.f, s: cell.s } : { v: cell.v, s: cell.s, note: cell.note });
      }
    }
  });
  return { removed, left: keep.length };
}

/** Flash Fill: learn from the examples typed in a column how to make them from the columns beside, and fill the rest. */
export function flashFill(wb: Workbook, sheet: Sheet, row: number, col: number): number {
  // the examples: filled cells above in this column; the sources: cells in the same row to the left (and right)
  const data = region(wb, sheet, row, Math.max(0, col - 1));
  const top = data.r1;
  const bottom = data.r2;
  const sources: number[] = [];
  for (let c = data.c1; c <= data.c2; c++) if (c !== col) sources.push(c);
  const examples: { row: number; out: string }[] = [];
  for (let r = top; r <= bottom; r++) {
    const t = text(wb, sheet, r, col);
    if (t) examples.push({ row: r, out: t });
  }
  // skip a header row (the example in the first row that matches nothing)
  const rowsToFill: number[] = [];
  for (let r = top; r <= bottom; r++) if (!text(wb, sheet, r, col)) rowsToFill.push(r);
  if (!examples.length || !rowsToFill.length) return 0;
  type Piece = { kind: "lit"; text: string } | { kind: "token"; source: number; index: number; fromEnd: boolean; case: "same" | "upper" | "lower" | "proper"; first?: boolean };
  const tokens = (s: string) => s.match(/[A-Za-zÀ-￿]+|\d+/g) ?? [];
  const casing = (want: string, got: string): Piece extends never ? never : "same" | "upper" | "lower" | "proper" | null => {
    if (want === got) return "same";
    if (want === got.toUpperCase()) return "upper";
    if (want === got.toLowerCase()) return "lower";
    if (want === got[0]!.toUpperCase() + got.slice(1).toLowerCase()) return "proper";
    return null;
  };
  /** One way to build `out` from the row's tokens. */
  const explain = (r: number, out: string): Piece[] | null => {
    const pieces: Piece[] = [];
    let i = 0;
    while (i < out.length) {
      let best: Piece | null = null;
      let bestLen = 0;
      for (const s of sources) {
        const toks = tokens(text(wb, sheet, r, s));
        toks.forEach((t, idx) => {
          for (const len of [t.length, 1]) {
            const want = out.slice(i, i + len);
            if (want.length !== len) continue;
            const got = len === 1 ? t[0]! : t;
            const cs = casing(want, got);
            if (cs && len > bestLen) {
              const fromEnd = idx === toks.length - 1 && toks.length > 1;
              best = { kind: "token", source: s, index: fromEnd ? toks.length - 1 - idx : idx, fromEnd, case: cs, first: len === 1 && t.length > 1 };
              bestLen = len;
            }
          }
        });
      }
      if (best && bestLen > 0) {
        pieces.push(best);
        i += bestLen;
      } else {
        const last = pieces[pieces.length - 1];
        if (last?.kind === "lit") last.text += out[i];
        else pieces.push({ kind: "lit", text: out[i]! });
        i++;
      }
    }
    return pieces.some((p) => p.kind === "token") ? pieces : null;
  };
  const build = (r: number, pieces: Piece[]): string | null => {
    let out = "";
    for (const p of pieces) {
      if (p.kind === "lit") {
        out += p.text;
        continue;
      }
      const toks = tokens(text(wb, sheet, r, p.source));
      const t = p.fromEnd ? toks[toks.length - 1 - p.index] : toks[p.index];
      if (t === undefined) return null;
      const piece = p.first ? t[0]! : t;
      out += p.case === "upper" ? piece.toUpperCase() : p.case === "lower" ? piece.toLowerCase() : p.case === "proper" ? piece[0]!.toUpperCase() + piece.slice(1).toLowerCase() : piece;
    }
    return out;
  };
  // a program that explains every example
  let program: Piece[] | null = null;
  for (const ex of examples) {
    const candidate = explain(ex.row, ex.out);
    if (!candidate) continue;
    if (examples.every((e) => build(e.row, candidate) === e.out)) {
      program = candidate;
      break;
    }
  }
  if (!program) return 0;
  let filled = 0;
  wb.transact("Flash fill", () => {
    for (const r of rowsToFill) {
      if (r < examples[0]!.row) continue;
      const out = build(r, program!);
      if (out) {
        wb.setInput(sheet, r, col, out);
        filled++;
      }
    }
  });
  return filled;
}

// ------------------------------------------------------------------------------------ tables

export const TABLE_STYLES: Record<string, { header: string; band: string; headerText: string; line: string }> = {
  blue: { header: "#4472c4", band: "#d9e1f2", headerText: "#ffffff", line: "#8ea9db" },
  green: { header: "#70ad47", band: "#e2efda", headerText: "#ffffff", line: "#a9d08e" },
  orange: { header: "#ed7d31", band: "#fce4d6", headerText: "#ffffff", line: "#f4b084" },
  grey: { header: "#595959", band: "#ededed", headerText: "#ffffff", line: "#bfbfbf" },
  purple: { header: "#7030a0", band: "#e4dfec", headerText: "#ffffff", line: "#b4a7d6" },
  plain: { header: "#ffffff", band: "#f2f2f2", headerText: "#000000", line: "#bfbfbf" },
};

export function tableAt(sheet: Sheet, row: number, col: number): TableDef | undefined {
  return sheet.tables.find((t) => inArea(t.area, row, col));
}

export function createTable(wb: Workbook, sheet: Sheet, area: Area, header: boolean, style = "blue"): TableDef {
  if (sheet.tables.some((t) => t.area.r1 <= area.r2 && area.r1 <= t.area.r2 && t.area.c1 <= area.c2 && area.c1 <= t.area.c2)) throw new Error("A table can't overlap another table.");
  let n = 1;
  const names = new Set(wb.sheets.flatMap((s) => s.tables.map((t) => t.name.toLowerCase())));
  while (names.has(`table${n}`)) n++;
  const table: TableDef = { name: `Table${n}`, area, style, banded: true, totals: false, header: true };
  wb.transact("Format as table", () => {
    let a = area;
    if (!header) {
      // a table needs a header row: insert one with Column1, Column2…
      wb.shift(sheet, "rows", area.r1, 1);
      for (let c = area.c1; c <= area.c2; c++) wb.setInput(sheet, area.r1, c, `Column${c - area.c1 + 1}`);
      a = { ...area, r2: area.r2 + 1 };
    }
    // header names must be unique text
    const seen = new Set<string>();
    for (let c = a.c1; c <= a.c2; c++) {
      let label = text(wb, sheet, a.r1, c).trim() || `Column${c - a.c1 + 1}`;
      const base = label;
      let k = 2;
      while (seen.has(label.toLowerCase())) label = `${base}${k++}`;
      seen.add(label.toLowerCase());
      if (label !== text(wb, sheet, a.r1, c)) wb.setInput(sheet, a.r1, c, label);
    }
    table.area = a;
    wb.setSheetProp(sheet, "tables", [...sheet.tables, table]);
    if (!sheet.filter) wb.setSheetProp(sheet, "filter", { area: a, columns: {} });
  });
  return table;
}

export function tableColumns(wb: Workbook, sheet: Sheet, t: TableDef): string[] {
  const out: string[] = [];
  for (let c = t.area.c1; c <= t.area.c2; c++) out.push(text(wb, sheet, t.area.r1, c));
  return out;
}

/** A structured reference (Table1[Sales], [@Sales], Table1[#All]) as an area, or null. */
export function structuredArea(wb: Workbook, tableName: string | null, spec: string, sheetUid: number, row: number, col: number): { sheet: number; area: Area } | null {
  let table: TableDef | undefined;
  let owner: Sheet | undefined;
  for (const s of wb.sheets) {
    const found = tableName ? s.tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase()) : s.uid === sheetUid ? tableAt(s, row, col) : undefined;
    if (found) {
      table = found;
      owner = s;
      break;
    }
  }
  if (!table || !owner) return null;
  const a = table.area;
  const dataTop = a.r1 + 1;
  const dataBottom = table.totals ? a.r2 - 1 : a.r2;
  // items: [#All], [#Data], [#Headers], [#Totals], [#This Row], @, column names, Col1:Col2
  const inner = spec.trim().replace(/^\[|\]$/g, "");
  const items = (inner.includes("[") ? inner.match(/\[[^\]]*\]|[^,[\]]+/g) ?? [] : [inner]).map((x) => x.trim()).filter((x) => x && x !== ",");
  let r1 = dataTop;
  let r2 = dataBottom;
  let c1 = a.c1;
  let c2 = a.c2;
  const names = tableColumns(wb, owner, table).map((n) => n.toLowerCase());
  const colOf = (n: string) => {
    const i = names.indexOf(n.replace(/^\[|\]$/g, "").replace(/'(.)/g, "$1").trim().toLowerCase());
    return i < 0 ? null : a.c1 + i;
  };
  let columnsSet = false;
  for (let item of items) {
    item = item.replace(/^\[|\]$/g, "");
    const low = item.toLowerCase();
    if (low === "#all") (r1 = a.r1), (r2 = a.r2);
    else if (low === "#data") (r1 = dataTop), (r2 = dataBottom);
    else if (low === "#headers") r1 = r2 = a.r1;
    else if (low === "#totals") {
      if (!table.totals) return null;
      r1 = r2 = a.r2;
    } else if (low === "#this row" || low.startsWith("@")) {
      if (row < dataTop || row > dataBottom) return null;
      r1 = r2 = row;
      const rest = item.replace(/^@/, "").trim();
      if (rest) {
        const parts = rest.split(/\]\s*:\s*\[/);
        const x = colOf(parts[0]!);
        const y = parts[1] ? colOf(parts[1]) : x;
        if (x === null || y === null) return null;
        (c1 = Math.min(x, y)), (c2 = Math.max(x, y));
        columnsSet = true;
      }
    } else {
      const parts = item.split(/\s*:\s*/);
      const x = colOf(parts[0]!);
      const y = parts[1] ? colOf(parts[1]) : x;
      if (x === null || y === null) return null;
      if (columnsSet) (c1 = Math.min(c1, x, y)), (c2 = Math.max(c2, x, y));
      else (c1 = Math.min(x, y)), (c2 = Math.max(x, y));
      columnsSet = true;
    }
  }
  if (r2 < r1) return null;
  return { sheet: owner.uid, area: { r1, c1, r2, c2 } };
}

/** Typing just under or beside a table makes it grow, as in Excel. */
export function growTable(wb: Workbook, sheet: Sheet, row: number, col: number) {
  for (const t of sheet.tables) {
    const a = t.area;
    const below = row === a.r2 + 1 && col >= a.c1 && col <= a.c2 && !t.totals;
    const right = col === a.c2 + 1 && row >= a.r1 && row <= a.r2;
    if (!below && !right) continue;
    const area = below ? { ...a, r2: row } : { ...a, c2: col };
    wb.setSheetProp(sheet, "tables", sheet.tables.map((x) => (x === t ? { ...t, area } : x)));
    if (sheet.filter && sheet.filter.area.r1 === a.r1 && sheet.filter.area.c1 === a.c1) wb.setSheetProp(sheet, "filter", { ...sheet.filter, area });
    if (right && !text(wb, sheet, a.r1, col)) wb.setInput(sheet, a.r1, col, `Column${col - a.c1 + 1}`);
    // formulas in a calculated column fill the new row
    if (below)
      for (let c = a.c1; c <= a.c2; c++) {
        if (c === col) continue;
        const above = sheet.cells.get(key(a.r2, c));
        if (above?.f !== undefined && !sheet.cells.get(key(row, c))) wb.putCell(sheet, row, c, { v: null, f: above.f.replace(/\[@/g, "[@"), s: above.s });
      }
    return;
  }
}

/** A formula typed into an empty table column fills the whole column (a calculated column). */
export function fillTableColumn(wb: Workbook, sheet: Sheet, row: number, col: number) {
  const t = tableAt(sheet, row, col);
  if (!t || row === t.area.r1) return;
  const top = t.area.r1 + 1;
  const bottom = t.totals ? t.area.r2 - 1 : t.area.r2;
  const cell = sheet.cells.get(key(row, col));
  if (cell?.f === undefined) return;
  for (let r = top; r <= bottom; r++) {
    if (r === row) continue;
    const other = sheet.cells.get(key(r, col));
    if (other && (other.v !== null || other.f !== undefined)) return;
  }
  for (let r = top; r <= bottom; r++) {
    if (r === row) continue;
    wb.putCell(sheet, r, col, { v: null, f: shiftFormula(cell.f, r - row, 0), s: cell.s });
  }
}

// -------------------------------------------------------------------------------- PivotTable

const AGG: Record<PivotDef["values"][number]["fn"], (xs: Scalar[]) => Scalar> = {
  sum: (xs) => xs.reduce<number>((s, x) => s + (typeof x === "number" ? x : 0), 0),
  count: (xs) => xs.filter((x) => x !== null && x !== "").length,
  average: (xs) => {
    const n = xs.filter((x): x is number => typeof x === "number");
    return n.length ? n.reduce((s, x) => s + x, 0) / n.length : new CellError("#DIV/0!");
  },
  max: (xs) => {
    const n = xs.filter((x): x is number => typeof x === "number");
    return n.length ? Math.max(...n) : 0;
  },
  min: (xs) => {
    const n = xs.filter((x): x is number => typeof x === "number");
    return n.length ? Math.min(...n) : 0;
  },
  distinct: (xs) => new Set(xs.filter((x) => x !== null && x !== "").map((x) => (typeof x === "string" ? x.toLowerCase() : String(x)))).size,
};
export const AGG_LABELS: Record<PivotDef["values"][number]["fn"], string> = { sum: "Sum", count: "Count", average: "Average", max: "Max", min: "Min", distinct: "Distinct count" };

export function pivotFields(wb: Workbook, p: PivotDef): string[] {
  const src = wb.sheet(p.source.sheet);
  if (!src) return [];
  const out: string[] = [];
  for (let c = p.source.area.c1; c <= p.source.area.c2; c++) out.push(text(wb, src, p.source.area.r1, c) || `Column ${colName(c)}`);
  return out;
}

/** Calculate a PivotTable and write it into its sheet (replacing what it wrote before). */
export function buildPivot(wb: Workbook, sheet: Sheet, p: PivotDef): PivotDef {
  const src = wb.sheet(p.source.sheet);
  if (!src) throw new Error("The PivotTable's source sheet is gone.");
  const area = usedArea(wb, src, p.source.area);
  const fields = pivotFields(wb, p);
  const filtersPass = (r: number) => p.filters.every((f) => !f.values || f.values.includes(text(wb, src, r, area.c1 + f.col)));
  const rowsData: number[] = [];
  for (let r = area.r1 + 1; r <= area.r2; r++) if (filtersPass(r)) rowsData.push(r);
  const keyOf = (r: number, cols: number[]) => cols.map((c) => text(wb, src, r, area.c1 + c));
  const sortKeys = (list: string[][]) => {
    const valueOf = (s: string) => parseNumber(s, parseDate) ?? s;
    return list.sort((a, b) => {
      for (let i = 0; i < a.length; i++) {
        if (a[i] === "" && b[i] !== "") return 1;
        if (b[i] === "" && a[i] !== "") return -1;
        const c = compareValues(valueOf(a[i]!), valueOf(b[i]!));
        if (c) return c;
      }
      return 0;
    });
  };
  const rowKeys = sortKeys([...new Map(rowsData.map((r) => [JSON.stringify(keyOf(r, p.rows)), keyOf(r, p.rows)])).values()]);
  const colKeys = p.cols.length ? sortKeys([...new Map(rowsData.map((r) => [JSON.stringify(keyOf(r, p.cols)), keyOf(r, p.cols)])).values()]) : [[]];
  const values = p.values.length ? p.values : [];
  const groups = new Map<string, Scalar[][]>();
  for (const r of rowsData) {
    const id = JSON.stringify([keyOf(r, p.rows), keyOf(r, p.cols)]);
    let list = groups.get(id);
    if (!list) groups.set(id, (list = values.map(() => [])));
    values.forEach((v, i) => list![i]!.push(wb.value(src, r, area.c1 + v.col)));
  }
  const cell = (rk: string[] | null, ck: string[] | null, vi: number): Scalar => {
    const all: Scalar[] = [];
    for (const [id, lists] of groups) {
      const [r, c] = JSON.parse(id) as [string[], string[]];
      if (rk && JSON.stringify(r) !== JSON.stringify(rk)) continue;
      if (ck && JSON.stringify(c) !== JSON.stringify(ck)) continue;
      all.push(...lists[vi]!);
    }
    return AGG[values[vi]!.fn](all);
  };
  // the grid: header rows, then one row per row key, then the grand total
  const out: { v: Scalar; bold?: boolean; fill?: string; format?: string }[][] = [];
  const headerFill = "#ddebf7";
  const labelCols = Math.max(1, p.rows.length);
  const multipleValues = values.length > 1;
  const colsOut: { ck: string[] | null; vi: number }[] = [];
  for (const ck of colKeys) for (let vi = 0; vi < values.length; vi++) colsOut.push({ ck: p.cols.length ? ck : null, vi });
  if (p.totals && p.cols.length) for (let vi = 0; vi < values.length; vi++) colsOut.push({ ck: null, vi });
  const valueLabel = (vi: number) => `${AGG_LABELS[values[vi]!.fn]} of ${fields[values[vi]!.col] ?? "?"}`;
  if (p.cols.length) {
    const top: typeof out[number] = [{ v: values.length === 1 ? valueLabel(0) : null, bold: true, fill: headerFill }];
    for (let i = 1; i < labelCols; i++) top.push({ v: null, fill: headerFill });
    top.push({ v: p.cols.map((c) => fields[c]).join(" / "), bold: true, fill: headerFill });
    for (let i = 1; i < colsOut.length; i++) top.push({ v: null, fill: headerFill });
    out.push(top);
  }
  const head: typeof out[number] = p.rows.length ? p.rows.map((c) => ({ v: fields[c] ?? null, bold: true, fill: headerFill })) : [{ v: values.length ? "Total" : null, bold: true, fill: headerFill }];
  for (const co of colsOut) head.push({ v: co.ck ? (co.ck.join(" / ") || "(blank)") + (multipleValues ? ` ${valueLabel(co.vi)}` : "") : p.cols.length ? (multipleValues ? `Total ${valueLabel(co.vi)}` : "Grand Total") : valueLabel(co.vi), bold: true, fill: headerFill });
  out.push(head);
  if (p.rows.length) {
    for (const rk of rowKeys) {
      const line: typeof out[number] = rk.map((k) => ({ v: k === "" ? "(blank)" : (parseNumber(k, parseDate) ?? k) }));
      for (const co of colsOut) line.push({ v: cell(rk, co.ck, co.vi), format: values[co.vi]!.format });
      out.push(line);
    }
  }
  if (p.totals || !p.rows.length) {
    const total: typeof out[number] = [{ v: p.rows.length ? "Grand Total" : (values.length ? null : null), bold: true, fill: headerFill }];
    for (let i = 1; i < labelCols; i++) total.push({ v: null, bold: true, fill: headerFill });
    if (!p.rows.length) total.length = 0, total.push({ v: "Grand Total", bold: true, fill: headerFill });
    for (const co of colsOut) total.push({ v: cell(null, co.ck, co.vi), bold: true, fill: headerFill, format: values[co.vi]!.format });
    out.push(total);
  }
  const width = Math.max(...out.map((l) => l.length));
  const next: Area = { r1: p.row, c1: p.col, r2: p.row + out.length - 1, c2: p.col + width - 1 };
  wb.transact("PivotTable", () => {
    if (p.output) wb.clear(sheet, p.output, "all");
    out.forEach((line, i) =>
      line.forEach((c, j) => {
        const style: Style = {};
        if (c.bold) style.bold = true;
        if (c.fill) style.fill = c.fill;
        if (c.format) style.format = c.format;
        if (typeof c.v === "number" && !c.format && !Number.isInteger(c.v)) style.format = "#,##0.00";
        wb.putCell(sheet, p.row + i, p.col + j, c.v === null && !c.fill ? null : { v: c.v, s: wb.styleId(style) });
      }),
    );
    const saved = { ...p, output: next };
    wb.setSheetProp(sheet, "pivots", [...sheet.pivots.filter((x) => x.id !== p.id), saved]);
  });
  return { ...p, output: next };
}

export function pivotAt(sheet: Sheet, row: number, col: number): PivotDef | undefined {
  return sheet.pivots.find((p) => (p.output ? inArea(p.output, row, col) : p.row === row && p.col === col));
}

// ------------------------------------------------------------------------------------ charts

export interface Series {
  name: string;
  values: number[];
  color: string;
}
export const SERIES_COLORS = ["#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47", "#264478", "#9e480e", "#636363", "#997300"];

/** A chart's categories and series from its range: first column (or row) labels, first row names. */
export function chartData(wb: Workbook, sheet: Sheet, data: Area, byRows = false): { categories: string[]; series: Series[]; xs?: number[] } {
  const a = usedArea(wb, sheet, data);
  const get = (i: number, j: number) => (byRows ? wb.value(sheet, a.r1 + j, a.c1 + i) : wb.value(sheet, a.r1 + i, a.c1 + j));
  const show = (i: number, j: number) => (byRows ? text(wb, sheet, a.r1 + j, a.c1 + i) : text(wb, sheet, a.r1 + i, a.c1 + j));
  const n = byRows ? a.c2 - a.c1 + 1 : a.r2 - a.r1 + 1; // points + header
  const m = byRows ? a.r2 - a.r1 + 1 : a.c2 - a.c1 + 1; // series + labels
  const firstRowIsHeader = Array.from({ length: m }, (_, j) => get(0, j)).some((v) => typeof v === "string") || get(0, 0) === null;
  const firstColIsLabels = Array.from({ length: n }, (_, i) => get(i, 0)).slice(firstRowIsHeader ? 1 : 0).some((v) => typeof v !== "number") || m === 1 ? m > 1 : false;
  const startI = firstRowIsHeader ? 1 : 0;
  const startJ = firstColIsLabels ? 1 : 0;
  const categories: string[] = [];
  for (let i = startI; i < n; i++) categories.push(firstColIsLabels ? show(i, 0) : String(i - startI + 1));
  const series: Series[] = [];
  for (let j = startJ; j < m; j++) {
    const values: number[] = [];
    for (let i = startI; i < n; i++) {
      const v = get(i, j);
      values.push(typeof v === "number" ? v : NaN);
    }
    series.push({ name: firstRowIsHeader ? show(0, j) || `Series ${j}` : `Series ${j - startJ + 1}`, values, color: SERIES_COLORS[(j - startJ) % SERIES_COLORS.length]! });
  }
  return { categories, series };
}

export { Matrix };
