// A workbook: sheets of cells, their formulas and styles, and the calculation that keeps every
// value up to date. Changes go through transactions, so each can be undone.
import { type Area, colName, key, keyCol, keyRow, MAX_COLS, MAX_ROWS } from "./address";
import { parseDate } from "./dates";
import { evaluate, resultScalar, type Context } from "./evaluate";
import "./functions";
import { FUNCTIONS } from "./functions";
import { formatGeneral, formatValue, isDateFormat, isTextFormat } from "./format";
import { mapRefs, parse, ParseError, plainName, refText, tokenize, type Node, type RefParts } from "./parser";
import { CellError, ERRORS, isMatrix, isRange, Matrix, parseNumber, type Scalar, type Value } from "./values";
import { fillTableColumn, growTable, structuredArea } from "./features";

// ------------------------------------------------------------------------------------ styles

export interface BorderEdge {
  style: "thin" | "medium" | "thick" | "dashed" | "dotted" | "double";
  color?: string;
}
export interface Style {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  font?: string;
  size?: number;
  color?: string;
  fill?: string;
  h?: "left" | "center" | "right" | "justify";
  v?: "top" | "middle" | "bottom";
  wrap?: boolean;
  indent?: number;
  format?: string;
  top?: BorderEdge;
  bottom?: BorderEdge;
  left?: BorderEdge;
  right?: BorderEdge;
  /** Text typed with a leading apostrophe stays text. */
  quote?: boolean;
  locked?: boolean;
}

// ------------------------------------------------------------------------------------- cells

export interface Cell {
  /** The value: typed, or calculated from the formula. */
  v: Scalar;
  /** The formula, without "=". */
  f?: string;
  /** Style id in workbook.styles (0 = none). */
  s?: number;
  /** A formula's parsed tree, or the error that stopped it. */
  tree?: Node | ParseError;
  /** A formula's whole array result, when it spills. */
  arr?: Matrix;
  volatile?: boolean;
  circular?: boolean;
  /** A comment (note). */
  note?: string;
  link?: string;
}

export interface Sheet {
  uid: number;
  name: string;
  cells: Map<number, Cell>;
  colWidths: Map<number, number>;
  rowHeights: Map<number, number>;
  hiddenRows: Set<number>;
  hiddenCols: Set<number>;
  freezeRows: number;
  freezeCols: number;
  merges: Area[];
  tabColor?: string;
  hidden?: boolean;
  showGrid: boolean;
  /** spill anchor key → area it fills; covered cell key → anchor key */
  spills: Map<number, Area>;
  spillOf: Map<number, number>;
  blocked: Map<number, Area>;
  rows: number;
  cols: number;
  boundsStale: boolean;
  /** AutoFilter: its range and each column's filter; the rows it hides. */
  filter?: AutoFilter;
  filterHidden: Set<number>;
  tables: TableDef[];
  validations: Validation[];
  conditionals: Conditional[];
  charts: ChartDef[];
  pivots: PivotDef[];
}

export interface FilterSpec {
  /** Shown texts to keep (null: every value). */
  values?: string[] | null;
  cond?: { op: string; value: string; op2?: string; value2?: string; join?: "and" | "or" };
  top?: { n: number; bottom?: boolean; percent?: boolean };
  color?: string;
}
export interface AutoFilter {
  area: Area;
  columns: Record<number, FilterSpec>;
}
export interface TableDef {
  name: string;
  area: Area;
  style: string;
  banded: boolean;
  totals: boolean;
  header: boolean;
}
export interface Validation {
  area: Area;
  kind: "list" | "whole" | "decimal" | "date" | "time" | "length" | "custom" | "any";
  /** list: "a,b,c" or "=A1:A9"; others: the bounds or the formula. */
  source?: string;
  op?: "between" | "notBetween" | "=" | "<>" | ">" | "<" | ">=" | "<=";
  a?: string;
  b?: string;
  allowBlank: boolean;
  dropdown: boolean;
  prompt?: string;
  error?: { style: "stop" | "warning" | "info"; title?: string; message?: string };
}
export interface Conditional {
  id: string;
  area: Area;
  kind: "cell" | "text" | "top" | "average" | "duplicate" | "unique" | "blank" | "noblank" | "error" | "formula" | "scale" | "bar" | "icons" | "date";
  op?: string;
  a?: string;
  b?: string;
  n?: number;
  percent?: boolean;
  bottom?: boolean;
  above?: boolean;
  formula?: string;
  style?: Partial<Style>;
  colors?: string[];
  icons?: "arrows" | "traffic" | "flags" | "stars";
  stop?: boolean;
}
export interface ChartDef {
  id: string;
  kind: "column" | "bar" | "line" | "area" | "pie" | "doughnut" | "scatter" | "stacked";
  data: Area;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  byRows?: boolean;
  legend: boolean;
}
export interface PivotDef {
  id: string;
  source: { sheet: number; area: Area };
  row: number;
  col: number;
  rows: number[];
  cols: number[];
  values: { col: number; fn: "sum" | "count" | "average" | "max" | "min" | "distinct"; format?: string }[];
  filters: { col: number; values: string[] | null }[];
  totals: boolean;
  /** The cells the pivot last wrote (cleared when it is rebuilt). */
  output?: Area;
}

export interface DefinedName {
  name: string;
  formula: string;
  sheet: number | null;
  tree?: Node | ParseError;
}

export const DEFAULT_COL_WIDTH = 96;
export const DEFAULT_ROW_HEIGHT = 24;

type Dep = { sheet: number; area: Area };
type Undo = { label: string; undo: () => void; redo: () => void };

const SHEET_BITS = 2 ** 34; // MAX_ROWS * MAX_COLS
const gk = (sheet: number, k: number) => sheet * SHEET_BITS + k;
const gSheet = (g: number) => Math.floor(g / SHEET_BITS);
const gKey = (g: number) => g % SHEET_BITS;

function newSheet(uid: number, name: string): Sheet {
  return {
    uid, name, cells: new Map(), colWidths: new Map(), rowHeights: new Map(), hiddenRows: new Set(), hiddenCols: new Set(), freezeRows: 0, freezeCols: 0,
    merges: [], showGrid: true, spills: new Map(), spillOf: new Map(), blocked: new Map(), rows: 0, cols: 0, boundsStale: false,
    filterHidden: new Set(), tables: [], validations: [], conditionals: [], charts: [], pivots: [],
  };
}

/** What typing into a cell means: a formula, a number (with the format it implies), a date, text. */
export function parseInput(text: string, currentFormat?: string): { value: Scalar; formula?: string; format?: string; quote?: boolean } {
  if (text === "") return { value: null };
  if (currentFormat && isTextFormat(currentFormat)) return { value: text };
  if (text.startsWith("'")) return { value: text.slice(1), quote: true };
  if (text.startsWith("=") && text.length > 1) return { value: null, formula: text.slice(1) };
  if (/^[+-]/.test(text) && text.length > 1 && /[A-Za-z(]/.test(text)) {
    // "+A1*2" and "-B2" are formulas too, as Excel reads them
    try {
      parse(text);
      return { value: null, formula: text };
    } catch {
      /* text */
    }
  }
  const t = text.trim();
  const upper = t.toUpperCase();
  if (upper === "TRUE" || upper === "FALSE") return { value: upper === "TRUE" };
  const err = Object.keys(ERRORS).find((e) => e === upper);
  if (err) return { value: ERRORS[err as keyof typeof ERRORS] };
  const plain = parseNumber(t);
  if (plain !== null) {
    let format: string | undefined;
    if (/%\s*$/.test(t)) format = /\.\d/.test(t) ? "0.00%" : "0%";
    else if (/^[-(]?\s*\$/.test(t) || /^-?\$/.test(t)) format = /\.\d/.test(t) ? '"$"#,##0.00' : '"$"#,##0';
    else if (/\d,\d{3}/.test(t)) format = /\.\d/.test(t) ? "#,##0.00" : "#,##0";
    else if (/e/i.test(t) && /\d[eE][+-]?\d/.test(t)) format = "0.00E+00";
    return { value: plain, format: currentFormat && currentFormat !== "General" ? undefined : format };
  }
  const date = parseDate(t);
  if (date !== null) {
    let format: string | undefined;
    const hasTime = /\d:\d/.test(t);
    const hasDate = /[/-]|[A-Za-z]{3}/.test(t.replace(/\s*(am|pm)$/i, ""));
    if (hasDate && hasTime) format = "m/d/yyyy h:mm";
    else if (hasTime) format = /:\d{1,2}:\d/.test(t) ? (/[ap]m?$/i.test(t) ? "h:mm:ss AM/PM" : "h:mm:ss") : /[ap]m?$/i.test(t) ? "h:mm AM/PM" : "h:mm";
    else if (/^[A-Za-z]/.test(t) || /\d[- ][A-Za-z]/.test(t)) format = /\d{4}$/.test(t) || /\d{2}$/.test(t) ? "d-mmm-yy" : "d-mmm";
    else format = "m/d/yyyy";
    return { value: date, format: currentFormat && currentFormat !== "General" && isDateFormat(currentFormat) ? undefined : format };
  }
  return { value: text };
}

export class Workbook {
  sheets: Sheet[] = [];
  names = new Map<string, DefinedName>();
  styles: Style[] = [{}];
  private styleIds = new Map<string, number>([["{}", 0]]);
  private nextUid = 1;
  private deps = new Map<number, Dep[]>(); // formula cell → what it reads
  private cellDeps = new Map<number, Set<number>>(); // a cell → formulas reading it alone
  private rangeDeps = new Map<number, Map<number, Area[]>>(); // sheet → formula cell → wide areas it reads
  private volatile = new Set<number>();
  private pending = new Set<number>(); // changed cells to recalculate from
  private computing = new Set<number>();
  private computed = new Set<number>();
  private dirty = new Set<number>();
  private undoStack: Undo[] = [];
  private redoStack: Undo[] = [];
  private batch: Undo[] | null = null;
  private batchLabel = "";
  private listeners = new Set<() => void>();
  private nowValue = 0;
  version = 0;
  circular: { sheet: number; row: number; col: number }[] = [];
  /** Iterative calculation is off: circular references show 0, as in Excel. */
  calcMode: "auto" | "manual" = "auto";

  constructor(empty = true) {
    if (empty) this.sheets.push(newSheet(this.nextUid++, "Sheet1"));
  }

  // -------------------------------------------------------------------------- reading

  sheet(uid: number): Sheet | undefined {
    return this.sheets.find((s) => s.uid === uid);
  }

  sheetByName(name: string): Sheet | undefined {
    const lower = name.toLowerCase();
    return this.sheets.find((s) => s.name.toLowerCase() === lower);
  }

  cell(sheet: Sheet, row: number, col: number): Cell | undefined {
    return sheet.cells.get(key(row, col));
  }

  style(id: number | undefined): Style {
    return this.styles[id ?? 0] ?? {};
  }

  styleId(style: Style): number {
    const clean: Style = {};
    for (const [k, v] of Object.entries(style)) if (v !== undefined && v !== false && v !== "" && !(k === "format" && v === "General")) (clean as Record<string, unknown>)[k] = v;
    const id = JSON.stringify(clean, Object.keys(clean).sort());
    let found = this.styleIds.get(id);
    if (found === undefined) {
      found = this.styles.length;
      this.styles.push(clean);
      this.styleIds.set(id, found);
    }
    return found;
  }

  /** The value shown in a cell, spilled values included. */
  value(sheet: Sheet, row: number, col: number): Scalar {
    const k = key(row, col);
    const cell = sheet.cells.get(k);
    if (cell && (cell.f !== undefined || cell.v !== null)) {
      if (cell.f !== undefined) this.ensure(gk(sheet.uid, k));
      return cell.v;
    }
    const anchor = sheet.spillOf.get(k);
    if (anchor !== undefined) {
      this.ensure(gk(sheet.uid, anchor));
      const a = sheet.cells.get(anchor);
      if (a?.arr) {
        const v = a.arr.get(row - keyRow(anchor), col - keyCol(anchor));
        return v === null ? 0 : v;
      }
    }
    return null;
  }

  /** The text a cell shows, with its number format. */
  display(sheet: Sheet, row: number, col: number): { text: string; color?: string; value: Scalar } {
    const value = this.value(sheet, row, col);
    const cell = sheet.cells.get(key(row, col));
    let format = this.style(cell?.s).format;
    // spilled cells take the anchor's format when they have none
    if (!format && !cell) {
      const anchor = sheet.spillOf.get(key(row, col));
      if (anchor !== undefined) format = this.style(sheet.cells.get(anchor)?.s).format;
    }
    const shown = formatValue(value, format || "General");
    return { ...shown, value };
  }

  /** What the formula bar and an editor show: "=formula", or the value as you would type it. */
  editText(sheet: Sheet, row: number, col: number): string {
    const cell = sheet.cells.get(key(row, col));
    if (!cell) return "";
    if (cell.f !== undefined) return "=" + cell.f;
    const v = cell.v;
    const st = this.style(cell.s);
    if (v === null) return "";
    if (typeof v === "string") return st.quote ? "'" + v : v;
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    if (v instanceof CellError) return v.code;
    const format = st.format ?? "General";
    if (isDateFormat(format)) {
      const hasTime = /[hs]/i.test(format.replace(/"[^"]*"/g, ""));
      const hasDate = /[dy]|m{3,}|\bm\b|\bmm\b(?!:)/i.test(format.replace(/"[^"]*"/g, "").replace(/h+:mm|mm:ss/gi, ""));
      if (hasDate && hasTime) return formatValue(v, "m/d/yyyy h:mm:ss AM/PM").text.replace(/:00 (AM|PM)$/, " $1");
      if (hasTime && !hasDate) return formatValue(v, "h:mm:ss AM/PM").text;
      return formatValue(v, "m/d/yyyy").text;
    }
    if (/%/.test(format.split(";")[0]!.replace(/"[^"]*"/g, ""))) return String(Number((v * 100).toPrecision(15))) + "%";
    return String(Number(v.toPrecision(15)));
  }

  bounds(sheet: Sheet): { rows: number; cols: number } {
    if (sheet.boundsStale) {
      let rows = 0;
      let cols = 0;
      for (const [k, cell] of sheet.cells) {
        if (cell.v === null && cell.f === undefined && !cell.s && !cell.note) continue;
        rows = Math.max(rows, keyRow(k) + 1);
        cols = Math.max(cols, keyCol(k) + 1);
      }
      for (const area of sheet.spills.values()) {
        rows = Math.max(rows, area.r2 + 1);
        cols = Math.max(cols, area.c2 + 1);
      }
      sheet.rows = rows;
      sheet.cols = cols;
      sheet.boundsStale = false;
    }
    return { rows: sheet.rows, cols: sheet.cols };
  }

  // ------------------------------------------------------------------------- listening

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  // ---------------------------------------------------------------------- transactions

  /** Run changes as one undoable step, then recalculate. */
  transact<T>(label: string, fn: () => T): T {
    if (this.batch) return fn();
    this.batch = [];
    this.batchLabel = label;
    let out: T;
    try {
      out = fn();
    } finally {
      const steps = this.batch;
      this.batch = null;
      if (steps.length) {
        this.undoStack.push({
          label: this.batchLabel,
          undo: () => {
            for (let i = steps.length - 1; i >= 0; i--) steps[i]!.undo();
          },
          redo: () => {
            for (const s of steps) s.redo();
          },
        });
        if (this.undoStack.length > 200) this.undoStack.shift();
        this.redoStack = [];
      }
      this.recalc();
      this.emit();
    }
    return out!;
  }

  private record(step: Undo) {
    if (this.batch) this.batch.push(step);
  }

  canUndo(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }
  canRedo(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }
  undo(): boolean {
    const step = this.undoStack.pop();
    if (!step) return false;
    this.batch = null;
    step.undo();
    this.redoStack.push(step);
    this.recalc();
    this.emit();
    return true;
  }
  redo(): boolean {
    const step = this.redoStack.pop();
    if (!step) return false;
    step.redo();
    this.undoStack.push(step);
    this.recalc();
    this.emit();
    return true;
  }

  // ------------------------------------------------------------------------- writing cells

  /** Replace a cell's content and style as stored (no parsing); records undo. */
  putCell(sheet: Sheet, row: number, col: number, next: Cell | null) {
    const k = key(row, col);
    const before = sheet.cells.get(k) ?? null;
    const snapshot = (c: Cell | null): Cell | null => (c ? { v: c.f !== undefined ? null : c.v, f: c.f, s: c.s, note: c.note, link: c.link } : null);
    const was = snapshot(before);
    const now = snapshot(next);
    const apply = (c: Cell | null) => this.rawPut(sheet, k, c ? { ...c } : null);
    apply(now);
    this.record({ label: "", undo: () => apply(was), redo: () => apply(now) });
  }

  private rawPut(sheet: Sheet, k: number, cell: Cell | null) {
    const g = gk(sheet.uid, k);
    const old = sheet.cells.get(k);
    if (old?.f !== undefined) this.unlink(g);
    if (old?.f !== undefined && sheet.spills.has(k)) this.clearSpill(sheet, k);
    sheet.blocked.delete(k);
    const empty = !cell || (cell.v === null && cell.f === undefined && !cell.s && !cell.note);
    if (empty) sheet.cells.delete(k);
    else {
      if (cell.f !== undefined) {
        cell.tree = this.parseFormula(cell.f);
        cell.v = null;
      }
      sheet.cells.set(k, cell);
      if (cell.f !== undefined) this.link(g, cell);
      const r = keyRow(k);
      const c = keyCol(k);
      if (r + 1 > sheet.rows) sheet.rows = r + 1;
      if (c + 1 > sheet.cols) sheet.cols = c + 1;
    }
    if (empty) sheet.boundsStale = true;
    this.pending.add(g);
    // typing over a spilled area blocks its formula; clearing a blocker may free one
    const anchor = sheet.spillOf.get(k);
    if (anchor !== undefined && anchor !== k) this.pending.add(gk(sheet.uid, anchor));
    for (const [a, area] of sheet.blocked) if (keyRow(k) >= area.r1 && keyRow(k) <= area.r2 && keyCol(k) >= area.c1 && keyCol(k) <= area.c2) this.pending.add(gk(sheet.uid, a));
  }

  /** Type into a cell, as a person would: formulas, numbers, dates, text. */
  setInput(sheet: Sheet, row: number, col: number, text: string) {
    if (text !== "" && sheet.tables.length) growTable(this, sheet, row, col);
    const cell = sheet.cells.get(key(row, col));
    const style = this.style(cell?.s);
    const parsed = parseInput(text, style.format);
    let s = cell?.s;
    if (parsed.format || parsed.quote !== undefined || (style.quote && !parsed.quote)) {
      const next: Style = { ...style };
      if (parsed.format) next.format = parsed.format;
      next.quote = parsed.quote || undefined;
      s = this.styleId(next);
    }
    if (parsed.formula !== undefined) {
      // formulas that show dates take a date format, as in Excel
      const f = parsed.formula;
      if (!style.format && /^\s*(TODAY|DATE|EDATE|EOMONTH|WORKDAY|DATEVALUE)\s*\(/i.test(f)) s = this.styleId({ ...style, format: "m/d/yyyy" });
      else if (!style.format && /^\s*NOW\s*\(/i.test(f)) s = this.styleId({ ...style, format: "m/d/yyyy h:mm" });
      else if (!style.format && /^\s*TIME\s*\(/i.test(f)) s = this.styleId({ ...style, format: "h:mm AM/PM" });
      this.putCell(sheet, row, col, { v: null, f: normalizeFormula(f), s, note: cell?.note, link: cell?.link });
      if (sheet.tables.length) fillTableColumn(this, sheet, row, col);
    } else this.putCell(sheet, row, col, { v: parsed.value, s, note: cell?.note, link: cell?.link });
  }

  setValue(sheet: Sheet, row: number, col: number, value: Scalar) {
    const cell = sheet.cells.get(key(row, col));
    this.putCell(sheet, row, col, { v: value, s: cell?.s, note: cell?.note });
  }

  setStyle(sheet: Sheet, area: Area, patch: Partial<Style> | ((s: Style) => Style)) {
    const { rows, cols } = this.bounds(sheet);
    const r2 = Math.min(area.r2, Math.max(rows, area.r1 + 1) + 2000);
    const c2 = Math.min(area.c2, Math.max(cols, area.c1 + 1) + 200);
    for (let r = area.r1; r <= r2; r++)
      for (let c = area.c1; c <= c2; c++) {
        const cell = sheet.cells.get(key(r, c));
        const base = this.style(cell?.s);
        const next = typeof patch === "function" ? patch(base) : { ...base, ...patch };
        const id = this.styleId(next);
        if (id === (cell?.s ?? 0)) continue;
        this.putCell(sheet, r, c, cell ? { ...cell, v: cell.f !== undefined ? null : cell.v, s: id } : { v: null, s: id });
      }
  }

  clear(sheet: Sheet, area: Area, what: "all" | "contents" | "formats" | "notes" = "contents") {
    const keys = [...sheet.cells.keys()].filter((k) => keyRow(k) >= area.r1 && keyRow(k) <= area.r2 && keyCol(k) >= area.c1 && keyCol(k) <= area.c2);
    for (const k of keys) {
      const cell = sheet.cells.get(k)!;
      const r = keyRow(k);
      const c = keyCol(k);
      if (what === "all") this.putCell(sheet, r, c, null);
      else if (what === "contents") this.putCell(sheet, r, c, cell.s || cell.note ? { v: null, s: cell.s, note: cell.note } : null);
      else if (what === "formats") this.putCell(sheet, r, c, { ...cell, v: cell.f !== undefined ? null : cell.v, s: undefined });
      else this.putCell(sheet, r, c, { ...cell, v: cell.f !== undefined ? null : cell.v, note: undefined });
    }
    if (what === "all" || what === "formats") sheet.merges = sheet.merges.filter((m) => !(m.r1 >= area.r1 && m.r2 <= area.r2 && m.c1 >= area.c1 && m.c2 <= area.c2));
  }

  setNote(sheet: Sheet, row: number, col: number, note: string | null) {
    const cell = sheet.cells.get(key(row, col));
    this.putCell(sheet, row, col, { ...(cell ?? { v: null }), v: cell?.f !== undefined ? null : (cell?.v ?? null), note: note || undefined });
  }

  /** Change a sheet property (widths, freeze, merges…) with undo. */
  setSheetProp<K extends keyof Sheet>(sheet: Sheet, prop: K, value: Sheet[K]) {
    const copy = (v: Sheet[K]): Sheet[K] => (v instanceof Map ? (new Map(v) as Sheet[K]) : v instanceof Set ? (new Set(v) as Sheet[K]) : Array.isArray(v) ? ([...v] as Sheet[K]) : v);
    const before = copy(sheet[prop]);
    const after = copy(value);
    sheet[prop] = copy(after);
    this.record({ label: "", undo: () => (sheet[prop] = copy(before)), redo: () => (sheet[prop] = copy(after)) });
  }

  setColWidth(sheet: Sheet, cols: number[], width: number | null) {
    const next = new Map(sheet.colWidths);
    for (const c of cols) {
      if (width === null || Math.round(width) === DEFAULT_COL_WIDTH) next.delete(c);
      else next.set(c, Math.max(0, Math.round(width)));
    }
    this.setSheetProp(sheet, "colWidths", next);
  }

  setRowHeight(sheet: Sheet, rows: number[], height: number | null) {
    const next = new Map(sheet.rowHeights);
    for (const r of rows) {
      if (height === null || Math.round(height) === DEFAULT_ROW_HEIGHT) next.delete(r);
      else next.set(r, Math.max(0, Math.round(height)));
    }
    this.setSheetProp(sheet, "rowHeights", next);
  }

  merge(sheet: Sheet, area: Area) {
    const rest = sheet.merges.filter((m) => !(m.r1 <= area.r2 && area.r1 <= m.r2 && m.c1 <= area.c2 && area.c1 <= m.c2));
    // a merge keeps only the top-left value, as Excel does
    for (let r = area.r1; r <= area.r2; r++)
      for (let c = area.c1; c <= area.c2; c++) {
        if (r === area.r1 && c === area.c1) continue;
        const cell = sheet.cells.get(key(r, c));
        if (cell && (cell.v !== null || cell.f !== undefined)) this.putCell(sheet, r, c, cell.s ? { v: null, s: cell.s } : null);
      }
    this.setSheetProp(sheet, "merges", [...rest, area]);
  }

  unmerge(sheet: Sheet, area: Area) {
    this.setSheetProp(sheet, "merges", sheet.merges.filter((m) => !(m.r1 <= area.r2 && area.r1 <= m.r2 && m.c1 <= area.c2 && area.c1 <= m.c2)));
  }

  mergeAt(sheet: Sheet, row: number, col: number): Area | undefined {
    return sheet.merges.find((m) => row >= m.r1 && row <= m.r2 && col >= m.c1 && col <= m.c2);
  }

  // ---------------------------------------------------------------------------- sheets

  addSheet(name?: string, at = this.sheets.length): Sheet {
    let n = this.sheets.length + 1;
    let label = name ?? `Sheet${n}`;
    while (this.sheetByName(label)) label = `Sheet${++n}`;
    const sheet = newSheet(this.nextUid++, label);
    const insert = () => {
      this.sheets.splice(Math.min(at, this.sheets.length), 0, sheet);
      this.rebuild();
    };
    insert();
    this.record({ label: "", undo: () => {
      this.sheets = this.sheets.filter((s) => s !== sheet);
      this.rebuild();
    }, redo: insert });
    return sheet;
  }

  /** Replace the whole workbook state with undo (for structural changes). */
  private structural(fn: () => void) {
    const before = this.toJSON();
    fn();
    const after = this.toJSON();
    this.rebuild();
    this.record({ label: "", undo: () => this.load(before), redo: () => this.load(after) });
  }

  renameSheet(sheet: Sheet, name: string) {
    const clean = name.trim();
    if (!clean || /[\\/?*[\]:]/.test(clean) || clean.length > 31) throw new Error("A sheet name can't be empty, longer than 31 characters, or use \\ / ? * [ ] :");
    const taken = this.sheetByName(clean);
    if (taken && taken !== sheet) throw new Error(`There is already a sheet named “${clean}”.`);
    const old = sheet.name;
    this.structural(() => {
      sheet.name = clean;
      this.rewriteAll((ref) => (ref.sheet !== null && ref.sheet.toLowerCase() === old.toLowerCase() ? { ...ref, sheet: clean } : ref));
    });
  }

  deleteSheet(sheet: Sheet) {
    if (this.sheets.filter((s) => !s.hidden).length <= 1) throw new Error("A workbook needs at least one visible sheet.");
    const old = sheet.name.toLowerCase();
    this.structural(() => {
      this.sheets = this.sheets.filter((s) => s !== sheet);
      this.rewriteAll((ref) => (ref.sheet !== null && ref.sheet.toLowerCase() === old ? null : ref));
    });
  }

  moveSheet(sheet: Sheet, to: number) {
    this.structural(() => {
      const rest = this.sheets.filter((s) => s !== sheet);
      rest.splice(Math.max(0, Math.min(to, rest.length)), 0, sheet);
      this.sheets = rest;
    });
  }

  duplicateSheet(sheet: Sheet): Sheet {
    let copy!: Sheet;
    this.structural(() => {
      const data = this.sheetJSON(sheet);
      let n = 2;
      while (this.sheetByName(`${sheet.name} (${n})`)) n++;
      copy = this.sheetFromJSON({ ...data, uid: undefined, name: `${sheet.name} (${n})` });
      this.sheets.splice(this.sheets.indexOf(sheet) + 1, 0, copy);
    });
    return copy;
  }

  // ---------------------------------------------------------------- rows and columns

  /** Insert (count > 0) or delete (count < 0) rows or columns at `at`, moving cells and references. */
  shift(sheet: Sheet, axis: "rows" | "cols", at: number, count: number) {
    if (!count) return;
    const rows = axis === "rows";
    const limit = rows ? MAX_ROWS : MAX_COLS;
    if (count > 0) {
      const { rows: used, cols: usedCols } = this.bounds(sheet);
      if ((rows ? used : usedCols) + count > limit) throw new Error(`There is no room: the sheet would pass ${rows ? "row " + limit.toLocaleString() : "column " + colName(limit - 1)}.`);
    }
    this.structural(() => {
      const moveIndex = (i: number): number | null => {
        if (count > 0) return i >= at ? i + count : i;
        const gone = -count;
        if (i >= at && i < at + gone) return null;
        return i >= at + gone ? i - gone : i;
      };
      const cells = new Map<number, Cell>();
      for (const [k, cell] of sheet.cells) {
        const r = keyRow(k);
        const c = keyCol(k);
        const moved = moveIndex(rows ? r : c);
        if (moved === null) continue;
        cells.set(rows ? key(moved, c) : key(r, moved), cell);
      }
      sheet.cells = cells;
      const sizes = rows ? sheet.rowHeights : sheet.colWidths;
      const nextSizes = new Map<number, number>();
      for (const [i, v] of sizes) {
        const m = moveIndex(i);
        if (m !== null) nextSizes.set(m, v);
      }
      if (rows) sheet.rowHeights = nextSizes;
      else sheet.colWidths = nextSizes;
      const hidden = rows ? sheet.hiddenRows : sheet.hiddenCols;
      const nextHidden = new Set<number>();
      for (const i of hidden) {
        const m = moveIndex(i);
        if (m !== null) nextHidden.add(m);
      }
      if (rows) sheet.hiddenRows = nextHidden;
      else sheet.hiddenCols = nextHidden;
      sheet.merges = sheet.merges.flatMap((m) => {
        const area = shiftArea(m, rows, at, count);
        return area && (area.r1 !== area.r2 || area.c1 !== area.c2) ? [area] : [];
      });
      // filters, tables, rules and charts follow their cells
      const move = <T extends { area: Area }>(list: T[]): T[] => list.flatMap((x) => {
        const area = shiftArea(x.area, rows, at, count);
        return area ? [{ ...x, area }] : [];
      });
      if (sheet.filter) {
        const area = shiftArea(sheet.filter.area, rows, at, count);
        if (!area) sheet.filter = undefined;
        else {
          const columns: Record<number, FilterSpec> = {};
          for (const [c, spec] of Object.entries(sheet.filter.columns)) {
            const moved = rows ? Number(c) : moveIndex(Number(c));
            if (moved !== null) columns[moved] = spec;
          }
          sheet.filter = { area, columns };
        }
      }
      const hiddenByFilter = new Set<number>();
      for (const i of sheet.filterHidden) {
        const m = rows ? moveIndex(i) : i;
        if (m !== null) hiddenByFilter.add(m);
      }
      sheet.filterHidden = hiddenByFilter;
      sheet.tables = move(sheet.tables);
      sheet.validations = move(sheet.validations);
      sheet.conditionals = move(sheet.conditionals);
      sheet.charts = sheet.charts.flatMap((ch) => {
        const area = shiftArea(ch.data, rows, at, count);
        return area ? [{ ...ch, data: area }] : [];
      });
      sheet.pivots = sheet.pivots.flatMap((p) => {
        const r = rows ? moveIndex(p.row) : p.row;
        const c = rows ? p.col : moveIndex(p.col);
        return r === null || c === null ? [] : [{ ...p, row: r, col: c, output: p.output ? (shiftArea(p.output, rows, at, count) ?? undefined) : undefined }];
      });
      for (const other of this.sheets)
        for (const p of other.pivots)
          if (p.source.sheet === sheet.uid) {
            const area = shiftArea(p.source.area, rows, at, count);
            if (area) p.source = { ...p.source, area };
          }
      const target = sheet.name.toLowerCase();
      this.rewriteAll((ref, owner) => {
        const onSheet = ref.sheet === null ? owner === sheet : ref.sheet.toLowerCase() === target;
        if (!onSheet) return ref;
        if (rows && ref.kind === "cols") return ref;
        if (!rows && ref.kind === "rows") return ref;
        const area = shiftArea({ r1: ref.r1, c1: ref.c1, r2: ref.r2, c2: ref.c2 }, rows, at, count);
        if (!area) return null;
        return { ...ref, ...area };
      });
      sheet.boundsStale = true;
    });
  }

  /** Rewrite every reference in every formula and name. */
  private rewriteAll(fn: (ref: RefParts, owner: Sheet | null) => RefParts | null) {
    for (const s of this.sheets)
      for (const cell of s.cells.values()) {
        if (cell.f === undefined) continue;
        const next = mapRefs(cell.f, (ref) => fn(ref, s));
        if (next !== cell.f) {
          cell.f = next;
          cell.tree = undefined;
        }
      }
    for (const n of this.names.values()) {
      const owner = n.sheet === null ? null : (this.sheet(n.sheet) ?? null);
      const next = mapRefs(n.formula, (ref) => fn(ref, owner));
      if (next !== n.formula) {
        n.formula = next;
        n.tree = undefined;
      }
    }
  }

  // ----------------------------------------------------------------------------- names

  defineName(name: string, formula: string, sheet: number | null = null) {
    const clean = name.trim();
    if (!/^[A-Za-z_\\][\w.\\]*$/.test(clean) || /^[A-Za-z]{1,3}\d+$/.test(clean) || /^(R|C)$/i.test(clean)) throw new Error("A name starts with a letter or _, has no spaces, and is not a cell address like A1.");
    const id = (sheet === null ? "" : `${sheet}!`) + clean.toUpperCase();
    const before = this.names.get(id);
    const after: DefinedName = { name: clean, formula: formula.replace(/^=/, ""), sheet };
    const apply = (v: DefinedName | undefined) => {
      if (v) this.names.set(id, { ...v, tree: undefined });
      else this.names.delete(id);
      this.rebuild();
    };
    apply(after);
    this.record({ label: "", undo: () => apply(before), redo: () => apply(after) });
  }

  deleteName(id: string) {
    const before = this.names.get(id);
    if (!before) return;
    const apply = (v: DefinedName | undefined) => {
      if (v) this.names.set(id, v);
      else this.names.delete(id);
      this.rebuild();
    };
    apply(undefined);
    this.record({ label: "", undo: () => apply(before), redo: () => apply(undefined) });
  }

  private nameTree(name: string, sheetUid: number): Node | undefined {
    const upper = name.toUpperCase();
    const found = this.names.get(`${sheetUid}!${upper}`) ?? this.names.get(upper);
    if (!found) return undefined;
    if (found.tree === undefined) found.tree = this.parseFormula(found.formula);
    return found.tree instanceof ParseError ? { t: "err", v: "#NAME?" } : found.tree;
  }

  // ------------------------------------------------------------------------ calculation

  private parseFormula(f: string): Node | ParseError {
    try {
      return parse(f);
    } catch (error) {
      return error instanceof ParseError ? error : new ParseError(String(error));
    }
  }

  /** What a formula reads: its references, the references inside names it uses. */
  private refsOf(sheet: Sheet, tree: Node, out: Dep[], depth = 0): boolean {
    let isVolatile = false;
    const visit = (n: Node) => {
      switch (n.t) {
        case "ref": {
          const target = n.ref.sheet === null ? sheet : this.sheetByName(n.ref.sheet);
          if (target) out.push({ sheet: target.uid, area: { r1: Math.min(n.ref.r1, n.ref.r2), c1: Math.min(n.ref.c1, n.ref.c2), r2: Math.max(n.ref.r1, n.ref.r2), c2: Math.max(n.ref.c1, n.ref.c2) } });
          break;
        }
        case "struct": {
          const found = structuredArea(this, n.table, n.spec, sheet.uid, this.refRow, this.refCol);
          // a reference to a whole table column: depend on the column (tables grow)
          if (found) out.push({ sheet: found.sheet, area: { ...found.area, r2: Math.max(found.area.r2, found.area.r2 + 0) } });
          isVolatile = true; // tables change size; recalculating keeps structured references right
          break;
        }
        case "name": {
          if (depth > 8) break;
          const t = this.nameTree(n.name, sheet.uid);
          if (t && this.refsOf(sheet, t, out, depth + 1)) isVolatile = true;
          break;
        }
        case "un": case "pct": visit(n.x); break;
        case "bin": visit(n.a); visit(n.b); break;
        case "union": n.items.forEach(visit); break;
        case "invoke": visit(n.fn); n.args.forEach((a) => a && visit(a)); break;
        case "call": {
          if (FUNCTIONS[n.name]?.volatile) isVolatile = true;
          if (!FUNCTIONS[n.name]) {
            const t = this.nameTree(n.name, sheet.uid);
            if (t && depth <= 8 && this.refsOf(sheet, t, out, depth + 1)) isVolatile = true;
          }
          n.args.forEach((a) => a && visit(a));
          break;
        }
        default:
      }
    };
    visit(tree);
    return isVolatile;
  }

  private refRow = 0;
  private refCol = 0;

  private link(g: number, cell: Cell) {
    const sheet = this.sheet(gSheet(g))!;
    const deps: Dep[] = [];
    this.refRow = keyRow(gKey(g));
    this.refCol = keyCol(gKey(g));
    cell.volatile = cell.tree instanceof ParseError ? false : this.refsOf(sheet, cell.tree!, deps);
    if (cell.volatile) this.volatile.add(g);
    this.deps.set(g, deps);
    for (const d of deps) {
      if (d.area.r1 === d.area.r2 && d.area.c1 === d.area.c2) {
        const target = gk(d.sheet, key(d.area.r1, d.area.c1));
        let set = this.cellDeps.get(target);
        if (!set) this.cellDeps.set(target, (set = new Set()));
        set.add(g);
      } else {
        let bySheet = this.rangeDeps.get(d.sheet);
        if (!bySheet) this.rangeDeps.set(d.sheet, (bySheet = new Map()));
        const list = bySheet.get(g) ?? [];
        list.push(d.area);
        bySheet.set(g, list);
      }
    }
  }

  private unlink(g: number) {
    const deps = this.deps.get(g);
    if (deps)
      for (const d of deps) {
        if (d.area.r1 === d.area.r2 && d.area.c1 === d.area.c2) this.cellDeps.get(gk(d.sheet, key(d.area.r1, d.area.c1)))?.delete(g);
        else this.rangeDeps.get(d.sheet)?.delete(g);
      }
    this.deps.delete(g);
    this.volatile.delete(g);
  }

  /** Rebuild every formula's links and recalculate everything (after structural changes). */
  rebuild() {
    this.deps.clear();
    this.cellDeps.clear();
    this.rangeDeps.clear();
    this.volatile.clear();
    for (const s of this.sheets) {
      s.spills.clear();
      s.spillOf.clear();
      s.blocked.clear();
      for (const [k, cell] of s.cells) {
        if (cell.f === undefined) continue;
        if (cell.tree === undefined) cell.tree = this.parseFormula(cell.f);
        cell.arr = undefined;
        this.link(gk(s.uid, k), cell);
        this.pending.add(gk(s.uid, k));
      }
      s.boundsStale = true;
    }
  }

  /** Formulas that read a cell. */
  private dependents(g: number, out: (d: number) => void) {
    this.cellDeps.get(g)?.forEach(out);
    const bySheet = this.rangeDeps.get(gSheet(g));
    if (!bySheet) return;
    const k = gKey(g);
    const r = keyRow(k);
    const c = keyCol(k);
    for (const [f, areas] of bySheet) for (const a of areas) if (r >= a.r1 && r <= a.r2 && c >= a.c1 && c <= a.c2) {
      out(f);
      break;
    }
  }

  /** Recalculate what changed and everything that depends on it, in order. */
  recalc() {
    if (this.calcMode === "manual" && !this.pending.size) return;
    this.nowValue = 0;
    for (let round = 0; round < 8 && (this.pending.size || (round === 0 && this.volatile.size)); round++) {
      const start = [...this.pending, ...(round === 0 ? this.volatile : [])];
      this.pending.clear();
      const dirty = new Set<number>();
      const queue: number[] = [];
      for (const g of start) {
        const cell = this.cellAt(g);
        if (cell?.f !== undefined && !dirty.has(g)) {
          dirty.add(g);
          queue.push(g);
        }
        this.dependents(g, (d) => {
          if (!dirty.has(d)) {
            dirty.add(d);
            queue.push(d);
          }
        });
        // a spilled area's readers depend on the cells it covers
        const sheet = this.sheet(gSheet(g));
        const area = sheet?.spills.get(gKey(g));
        if (area) this.spillReaders(sheet!, area, dirty, queue);
      }
      while (queue.length) {
        const g = queue.pop()!;
        this.dependents(g, (d) => {
          if (!dirty.has(d)) {
            dirty.add(d);
            queue.push(d);
          }
        });
        const sheet = this.sheet(gSheet(g));
        const area = sheet?.spills.get(gKey(g));
        if (area) this.spillReaders(sheet!, area, dirty, queue);
      }
      this.dirty = dirty;
      this.computed.clear();
      this.circular = [];
      const order = this.order(dirty);
      for (const g of order) this.ensure(g);
      this.dirty = new Set();
      this.computed.clear();
    }
  }

  private spillReaders(sheet: Sheet, area: Area, dirty: Set<number>, queue: number[]) {
    for (let r = area.r1; r <= area.r2 && r - area.r1 < 5000; r++)
      for (let c = area.c1; c <= area.c2 && c - area.c1 < 500; c++) {
        if (r === area.r1 && c === area.c1) continue;
        this.dependents(gk(sheet.uid, key(r, c)), (d) => {
          if (!dirty.has(d)) {
            dirty.add(d);
            queue.push(d);
          }
        });
      }
  }

  /** Dirty formulas in an order where each comes after the dirty formulas it reads. */
  private order(dirty: Set<number>): number[] {
    const out: number[] = [];
    const state = new Map<number, 1 | 2>(); // 1 visiting, 2 done
    const dirtyBySheet = new Map<number, number[]>();
    for (const g of dirty) {
      const s = gSheet(g);
      (dirtyBySheet.get(s) ?? dirtyBySheet.set(s, []).get(s)!).push(g);
    }
    const precedents = (g: number): number[] => {
      const found: number[] = [];
      for (const d of this.deps.get(g) ?? []) {
        const sheet = this.sheet(d.sheet);
        const size = (d.area.r2 - d.area.r1 + 1) * (d.area.c2 - d.area.c1 + 1);
        const candidates = dirtyBySheet.get(d.sheet) ?? [];
        if (size <= candidates.length) {
          for (let r = d.area.r1; r <= d.area.r2; r++)
            for (let c = d.area.c1; c <= d.area.c2; c++) {
              const p = gk(d.sheet, key(r, c));
              if (dirty.has(p)) found.push(p);
            }
        } else
          for (const p of candidates) {
            const k = gKey(p);
            const r = keyRow(k);
            const c = keyCol(k);
            if (r >= d.area.r1 && r <= d.area.r2 && c >= d.area.c1 && c <= d.area.c2) found.push(p);
          }
        // spill anchors whose area overlaps what this formula reads
        if (sheet)
          for (const [a, area] of sheet.spills) {
            const p = gk(d.sheet, a);
            if (dirty.has(p) && area.r1 <= d.area.r2 && d.area.r1 <= area.r2 && area.c1 <= d.area.c2 && d.area.c1 <= area.c2) found.push(p);
          }
      }
      return found;
    };
    for (const root of dirty) {
      if (state.has(root)) continue;
      const stack: [number, number[], number][] = [[root, precedents(root), 0]];
      state.set(root, 1);
      while (stack.length) {
        const top = stack[stack.length - 1]!;
        const [g, pre] = top;
        if (top[2] < pre.length) {
          const p = pre[top[2]++]!;
          const s = state.get(p);
          if (s === undefined) {
            state.set(p, 1);
            stack.push([p, precedents(p), 0]);
          } else if (s === 1 && p !== g) {
            // a cycle: every cell on it is circular
            for (const [x] of stack.slice(stack.findIndex((e) => e[0] === p))) this.markCircular(x);
          } else if (p === g) this.markCircular(g);
        } else {
          state.set(g, 2);
          out.push(g);
          stack.pop();
        }
      }
    }
    return out;
  }

  private markCircular(g: number) {
    const cell = this.cellAt(g);
    if (!cell || cell.circular) return;
    cell.circular = true;
    const k = gKey(g);
    this.circular.push({ sheet: gSheet(g), row: keyRow(k), col: keyCol(k) });
  }

  private cellAt(g: number): Cell | undefined {
    return this.sheet(gSheet(g))?.cells.get(gKey(g));
  }

  /** Calculate a formula cell now, when it is out of date. */
  private ensure(g: number) {
    if (!this.dirty.has(g) || this.computed.has(g)) return;
    const sheet = this.sheet(gSheet(g));
    const k = gKey(g);
    const cell = sheet?.cells.get(k);
    if (!sheet || !cell || cell.f === undefined) {
      this.computed.add(g);
      return;
    }
    if (this.computing.has(g)) {
      // reached itself while calculating: a circular reference
      this.markCircular(g);
      return;
    }
    this.computing.add(g);
    const wasCircular = cell.circular;
    cell.circular = false;
    try {
      if (cell.tree === undefined) cell.tree = this.parseFormula(cell.f);
      if (cell.tree instanceof ParseError) {
        this.setResult(sheet, k, cell, ERRORS["#NAME?"]);
      } else {
        const ctx = this.context(sheet, keyRow(k), keyCol(k));
        let result: Value;
        try {
          result = evaluate(cell.tree, ctx);
        } catch (error) {
          result = error instanceof RangeError ? new CellError("#NUM!", "too deep") : new CellError("#VALUE!", String(error));
        }
        this.setResult(sheet, k, cell, result);
      }
      if (wasCircular && !cell.circular && this.circular.some((c) => c.sheet === sheet.uid && key(c.row, c.col) === k)) cell.circular = true;
      if (cell.circular) {
        cell.v = 0;
        cell.arr = undefined;
      }
    } finally {
      this.computing.delete(g);
      this.computed.add(g);
    }
  }

  private setResult(sheet: Sheet, k: number, cell: Cell, result: Value) {
    const ctx = this.context(sheet, keyRow(k), keyCol(k));
    let block: Matrix | null = null;
    if (isMatrix(result)) block = result;
    else if (isRange(result) && !result.more && !(result.r1 === result.r2 && result.c1 === result.c2)) {
      const rows = result.r2 - result.r1 + 1;
      const cols = result.c2 - result.c1 + 1;
      if (rows * cols > 4_000_000) block = null;
      else {
        block = new Matrix(rows, cols, new Array(rows * cols));
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) block.data[r * cols + c] = ctx.value(result.sheet, result.r1 + r, result.c1 + c);
      }
    }
    const oldArea = sheet.spills.get(k);
    if (block && (block.rows > 1 || block.cols > 1)) {
      const r0 = keyRow(k);
      const c0 = keyCol(k);
      const area = { r1: r0, c1: c0, r2: r0 + block.rows - 1, c2: c0 + block.cols - 1 };
      if (area.r2 >= MAX_ROWS || area.c2 >= MAX_COLS || this.spillBlocked(sheet, k, area)) {
        if (oldArea) this.clearSpill(sheet, k);
        sheet.blocked.set(k, area);
        cell.arr = undefined;
        cell.v = ERRORS["#SPILL!"];
        return;
      }
      sheet.blocked.delete(k);
      const same = oldArea && oldArea.r2 === area.r2 && oldArea.c2 === area.c2;
      if (!same) {
        if (oldArea) this.clearSpill(sheet, k);
        sheet.spills.set(k, area);
        for (let r = area.r1; r <= area.r2; r++) for (let c = area.c1; c <= area.c2; c++) if (r !== r0 || c !== c0) sheet.spillOf.set(key(r, c), k);
        if (area.r2 + 1 > sheet.rows) sheet.rows = area.r2 + 1;
        if (area.c2 + 1 > sheet.cols) sheet.cols = area.c2 + 1;
        // cells under the new area changed: whatever reads them recalculates in the next round
        this.pending.add(gk(sheet.uid, k));
      } else if (cell.arr) {
        const changed = cell.arr.data.some((v, i) => v !== block!.data[i]);
        if (changed) this.queueSpillReaders(sheet, area);
      }
      cell.arr = block;
      const top = block.get(0, 0);
      cell.v = top === null ? 0 : top;
      return;
    }
    if (oldArea) {
      this.clearSpill(sheet, k);
      this.queueSpillReaders(sheet, oldArea);
    }
    sheet.blocked.delete(k);
    cell.arr = undefined;
    cell.v = block ? (block.get(0, 0) ?? 0) : resultScalar(result, ctx);
    if (cell.v === null) cell.v = 0;
  }

  private queueSpillReaders(sheet: Sheet, area: Area) {
    for (let r = area.r1; r <= area.r2 && r - area.r1 < 5000; r++)
      for (let c = area.c1; c <= area.c2 && c - area.c1 < 500; c++) {
        const g = gk(sheet.uid, key(r, c));
        this.dependents(g, (d) => {
          if (!this.computing.has(d)) this.pending.add(d);
        });
      }
  }

  private spillBlocked(sheet: Sheet, k: number, area: Area): boolean {
    for (let r = area.r1; r <= area.r2; r++)
      for (let c = area.c1; c <= area.c2; c++) {
        const kk = key(r, c);
        if (kk === k) continue;
        const cell = sheet.cells.get(kk);
        if (cell && (cell.v !== null || cell.f !== undefined)) return true;
        const other = sheet.spillOf.get(kk);
        if (other !== undefined && other !== k) return true;
      }
    return sheet.merges.some((m) => m.r1 <= area.r2 && area.r1 <= m.r2 && m.c1 <= area.c2 && area.c1 <= m.c2);
  }

  private clearSpill(sheet: Sheet, k: number) {
    const area = sheet.spills.get(k);
    if (!area) return;
    for (let r = area.r1; r <= area.r2; r++) for (let c = area.c1; c <= area.c2; c++) if (sheet.spillOf.get(key(r, c)) === k) sheet.spillOf.delete(key(r, c));
    sheet.spills.delete(k);
    sheet.boundsStale = true;
  }

  /** Recalculate every formula (F9, and after loading). */
  recalcAll() {
    for (const s of this.sheets) for (const [k, cell] of s.cells) if (cell.f !== undefined) this.pending.add(gk(s.uid, k));
    this.recalc();
    this.emit();
  }

  context(sheet: Sheet, row: number, col: number): Context {
    return {
      sheet: sheet.uid,
      row,
      col,
      value: (s, r, c) => {
        const target = s === sheet.uid ? sheet : this.sheet(s);
        return target ? this.value(target, r, c) : ERRORS["#REF!"];
      },
      bounds: (s) => {
        const target = this.sheet(s);
        return target ? this.bounds(target) : { rows: 0, cols: 0 };
      },
      sheetByName: (name) => this.sheetByName(name)?.uid ?? null,
      sheetName: (s) => this.sheet(s)?.name ?? "",
      sheetIndex: (s) => this.sheets.findIndex((x) => x.uid === s),
      sheetCount: () => this.sheets.length,
      name: (name, s) => this.nameTree(name, s),
      formula: (s, r, c) => this.sheet(s)?.cells.get(key(r, c))?.f ?? null,
      structured: (table, spec) => {
        const found = structuredArea(this, table, spec, sheet.uid, row, col);
        return found ? { kind: "range", sheet: found.sheet, ...found.area } : null;
      },
      hidden: (s, r) => {
        const target = this.sheet(s);
        if (!target) return 0;
        return target.hiddenRows.has(r) ? 2 : target.filterHidden.has(r) ? 1 : 0;
      },
      now: () => {
        if (!this.nowValue) {
          const d = new Date();
          this.nowValue = nowSerialLocal(d);
        }
        return this.nowValue;
      },
      random: Math.random,
    };
  }

  /** Evaluate a formula without putting it in a cell (status bar, conditional formats, tests). */
  evaluateFormula(sheet: Sheet, formula: string, row = 0, col = 0): Scalar | Matrix {
    try {
      const v = evaluate(parse(formula.replace(/^=/, "")), this.context(sheet, row, col));
      if (isRange(v)) {
        const ctx = this.context(sheet, row, col);
        if (v.r1 === v.r2 && v.c1 === v.c2) return ctx.value(v.sheet, v.r1, v.c1);
        const m = new Matrix(v.r2 - v.r1 + 1, v.c2 - v.c1 + 1, []);
        for (let r = 0; r < m.rows; r++) for (let c = 0; c < m.cols; c++) m.data.push(ctx.value(v.sheet, v.r1 + r, v.c1 + c));
        return m;
      }
      if (isMatrix(v)) return v;
      return resultScalar(v, this.context(sheet, row, col));
    } catch (error) {
      return error instanceof ParseError ? ERRORS["#NAME?"] : ERRORS["#VALUE!"];
    }
  }

  // ------------------------------------------------------------------------ saving

  sheetJSON(sheet: Sheet): SheetJSON {
    const cells: [number, number, CellJSON][] = [];
    for (const [k, cell] of sheet.cells) {
      const c: CellJSON = {};
      if (cell.f !== undefined) c.f = cell.f;
      else if (cell.v !== null) c.v = cell.v instanceof CellError ? { e: cell.v.code } : cell.v;
      if (cell.s) c.s = cell.s;
      if (cell.note) c.n = cell.note;
      if (cell.link) c.l = cell.link;
      cells.push([keyRow(k), keyCol(k), c]);
    }
    return {
      uid: sheet.uid, name: sheet.name, cells, colWidths: [...sheet.colWidths], rowHeights: [...sheet.rowHeights], hiddenRows: [...sheet.hiddenRows], hiddenCols: [...sheet.hiddenCols],
      freezeRows: sheet.freezeRows, freezeCols: sheet.freezeCols, merges: sheet.merges, tabColor: sheet.tabColor, hidden: sheet.hidden, showGrid: sheet.showGrid,
      filter: sheet.filter, filterHidden: [...sheet.filterHidden], tables: sheet.tables, validations: sheet.validations, conditionals: sheet.conditionals, charts: sheet.charts, pivots: sheet.pivots,
    };
  }

  sheetFromJSON(data: SheetJSON): Sheet {
    const free = data.uid !== undefined && !this.sheets.some((s) => s.uid === data.uid);
    const sheet = newSheet(free ? data.uid! : this.nextUid++, data.name);
    if (sheet.uid >= this.nextUid) this.nextUid = sheet.uid + 1;
    for (const [r, c, cell] of data.cells) {
      const v = cell.v;
      sheet.cells.set(key(r, c), {
        v: v && typeof v === "object" ? (ERRORS[(v as { e: string }).e as keyof typeof ERRORS] ?? ERRORS["#N/A"]) : (v ?? null),
        f: cell.f, s: cell.s, note: cell.n, link: cell.l,
      });
    }
    sheet.colWidths = new Map(data.colWidths ?? []);
    sheet.rowHeights = new Map(data.rowHeights ?? []);
    sheet.hiddenRows = new Set(data.hiddenRows ?? []);
    sheet.hiddenCols = new Set(data.hiddenCols ?? []);
    sheet.freezeRows = data.freezeRows ?? 0;
    sheet.freezeCols = data.freezeCols ?? 0;
    sheet.merges = data.merges ?? [];
    sheet.tabColor = data.tabColor;
    sheet.hidden = data.hidden;
    sheet.showGrid = data.showGrid ?? true;
    sheet.filter = data.filter;
    sheet.filterHidden = new Set(data.filterHidden ?? []);
    sheet.tables = data.tables ?? [];
    sheet.validations = data.validations ?? [];
    sheet.conditionals = data.conditionals ?? [];
    sheet.charts = data.charts ?? [];
    sheet.pivots = data.pivots ?? [];
    sheet.boundsStale = true;
    return sheet;
  }

  toJSON(): WorkbookJSON {
    return {
      format: "flowlabs-workbook",
      version: 1,
      sheets: this.sheets.map((s) => this.sheetJSON(s)),
      styles: this.styles,
      names: [...this.names.values()].map((n) => ({ name: n.name, formula: n.formula, sheet: n.sheet === null ? null : (this.sheet(n.sheet)?.name ?? null) })),
    };
  }

  load(data: WorkbookJSON) {
    this.styles = data.styles?.length ? data.styles : [{}];
    this.styleIds = new Map(this.styles.map((s, i) => [JSON.stringify(s, Object.keys(s).sort()), i]));
    // sheets keep their identity (undo of a structural change restores them in place)
    const old = new Map(this.sheets.map((sh) => [sh.uid, sh]));
    this.sheets = [];
    for (const json of data.sheets) {
      const made = this.sheetFromJSON(json);
      const same = old.get(made.uid);
      this.sheets.push(same ? Object.assign(same, made) : made);
    }
    if (!this.sheets.length) this.sheets.push(newSheet(this.nextUid++, "Sheet1"));
    this.names.clear();
    for (const n of data.names ?? []) {
      const owner = n.sheet === null ? null : (this.sheetByName(n.sheet)?.uid ?? null);
      this.names.set((owner === null ? "" : `${owner}!`) + n.name.toUpperCase(), { name: n.name, formula: n.formula, sheet: owner });
    }
    this.rebuild();
    this.recalc();
    this.emit();
  }

  static fromJSON(data: WorkbookJSON): Workbook {
    const wb = new Workbook(false);
    wb.load(data);
    return wb;
  }
}

function nowSerialLocal(d: Date): number {
  const utc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = (utc - Date.UTC(1899, 11, 30)) / 86_400_000;
  return days + (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
}

/** A reference area moved by inserting (count > 0) or deleting rows or columns; null when deleted. */
function shiftArea(area: Area, rows: boolean, at: number, count: number): Area | null {
  const lo = rows ? area.r1 : area.c1;
  const hi = rows ? area.r2 : area.c2;
  let nlo = lo;
  let nhi = hi;
  if (count > 0) {
    if (lo >= at) nlo += count;
    if (hi >= at) nhi += count;
  } else {
    const gone = -count;
    const end = at + gone - 1;
    if (lo >= at && hi <= end) return null;
    if (lo > end) nlo -= gone;
    else if (lo >= at) nlo = at;
    if (hi > end) nhi -= gone;
    else if (hi >= at) nhi = at - 1;
    if (nhi < nlo) return null;
  }
  const limit = rows ? MAX_ROWS - 1 : MAX_COLS - 1;
  nhi = Math.min(nhi, limit);
  if (nlo > limit) return null;
  return rows ? { ...area, r1: nlo, r2: nhi } : { ...area, c1: nlo, c2: nhi };
}

/** Formulas as Excel stores them: function names upper case. */
export function normalizeFormula(f: string): string {
  return tokenize(f)
    .map((t) => (t.type === "func" ? (FUNCTIONS[plainName(t.text)] ? plainName(t.text) : t.text) : t.type === "bool" ? t.text.toUpperCase() : t.type === "ref" ? refText(t.ref!) : t.text))
    .join("");
}

export interface CellJSON {
  v?: Scalar | { e: string };
  f?: string;
  s?: number;
  n?: string;
  l?: string;
}
export interface SheetJSON {
  uid?: number;
  name: string;
  cells: [number, number, CellJSON][];
  colWidths?: [number, number][];
  rowHeights?: [number, number][];
  hiddenRows?: number[];
  hiddenCols?: number[];
  freezeRows?: number;
  freezeCols?: number;
  merges?: Area[];
  tabColor?: string;
  hidden?: boolean;
  showGrid?: boolean;
  filter?: AutoFilter;
  filterHidden?: number[];
  tables?: TableDef[];
  validations?: Validation[];
  conditionals?: Conditional[];
  charts?: ChartDef[];
  pivots?: PivotDef[];
}
export interface WorkbookJSON {
  format: "flowlabs-workbook";
  version: 1;
  sheets: SheetJSON[];
  styles: Style[];
  names?: { name: string; formula: string; sheet: string | null }[];
}

export { formatGeneral, key, keyRow, keyCol };
