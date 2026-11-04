// The spreadsheet editor: a canvas grid with a formula bar, toolbar, sheet tabs and status bar,
// and the keyboard and mouse behaviour people know from Excel.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type Area, cellName, colName, key, MAX_COLS, MAX_ROWS, normal, parseArea } from "../engine/address";
import { clipboardMemory, copyArea, paste, parseHtmlTable, parseTsv, type PasteMode } from "../engine/fill";
import { autofill } from "../engine/fill";
import { FUNCTIONS } from "../engine/functions";
import { helpFor } from "../engine/help";
import { parse, ParseError, refText, shiftFormula, tokenize } from "../engine/parser";
import { formatValue } from "../engine/format";
import { DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT, type Sheet, type Workbook } from "../engine/workbook";
import { useApp } from "../../context";
import { Icon } from "../../components/Icon";
import { applyStyle, autoSum, currentRegion, describeArea, fillFrom, fullCols, fullRows, jump, shiftSelection, sortArea, statusOf, toggleAbsolute, toggleStyle } from "./commands";
import { cellRect, HEADER_H, HEADER_W, hit, makeLayout } from "./layout";
import { draw, fitHeight, fitWidth, readTheme, REF_COLORS, type Overlay, type Selection, type Theme } from "./render";
import { FileMenu, Toolbar } from "./Toolbar";
import { ContextMenu, Dialogs, type DialogState, type MenuState } from "./dialogs";
import { ChartLayer, DataDialogs, FilterMenu, ListMenu, PivotPanel, type DataDialog } from "./data";
import { applyBorders, lastFormat } from "./commands";
import { checkValidation, flashFill, invalidCells, listItems, pivotAt, region, toggleFilter, validationAt } from "../engine/features";
import { parseInput, type PivotDef } from "../engine/workbook";
import { filterButton } from "./render";
import { csvSheet, parseCsv, readXlsx, writeCsv, writeXlsx } from "../engine/xlsx";

interface Point {
  start: number;
  end: number;
  anchor: { row: number; col: number };
  cursor: { row: number; col: number };
}

export interface Edit {
  row: number;
  col: number;
  text: string;
  /** "enter": typing replaced the cell, arrows leave it; "edit": arrows move the caret (F2). */
  mode: "enter" | "edit";
  from: "cell" | "bar";
  point: Point | null;
  caret: number;
}

const single = (row: number, col: number): Selection => ({ active: { row, col }, ranges: [{ r1: row, c1: col, r2: row, c2: col }] });

/** Where a reference can be typed by clicking or with the arrows: after "=", an operator, "(" or ",". */
function canPoint(text: string, caret: number): boolean {
  if (!text.startsWith("=")) return false;
  const before = text.slice(0, caret).replace(/\s+$/, "");
  const after = text.slice(caret).replace(/^\s+/, "");
  const last = before[before.length - 1];
  if (last === undefined) return false;
  const ok = "=(,+-*/^&<>:;{".includes(last);
  return ok && (after === "" || ")+-*/^&<>=,; ".includes(after[0]!));
}

/** Closing brackets a formula is missing, as Excel adds them on Enter. */
function closeBrackets(text: string): string {
  let depth = 0;
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "(") depth++;
    else if (!quoted && ch === ")") depth--;
  }
  return depth > 0 && !quoted ? text + ")".repeat(depth) : quoted ? text + '"' + ")".repeat(Math.max(0, depth)) : text;
}

/** The function call around the caret, and which argument the caret is in. */
function callAt(text: string, caret: number): { name: string; arg: number } | null {
  const stack: { name: string; arg: number }[] = [];
  let quoted = false;
  const before = text.slice(0, caret);
  for (let i = 0; i < before.length; i++) {
    const ch = before[i]!;
    if (ch === '"') quoted = !quoted;
    if (quoted) continue;
    if (ch === "(") {
      const m = /([A-Za-z_][\w.]*)\s*$/.exec(before.slice(0, i));
      stack.push({ name: m ? m[1]!.toUpperCase() : "", arg: 0 });
    } else if (ch === ")") stack.pop();
    else if (ch === "," && stack.length) stack[stack.length - 1]!.arg++;
  }
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.name) return stack[i]!;
  return null;
}

export const Spreadsheet = memo(function Spreadsheet({ wb, extra, onSaveDataset, title, fileName, onSave, onNew }: { wb: Workbook; extra?: ReactNode; title?: ReactNode; onSaveDataset?: (sheet: Sheet, area: Area) => void; fileName?: string; onSave?: () => void; onNew?: () => void }) {
  const { notify, engine, fail } = useApp();
  const [data, setData] = useState<DataDialog | null>(null);
  const [filterMenu, setFilterMenu] = useState<{ col: number; x: number; y: number } | null>(null);
  const [listMenu, setListMenu] = useState<{ items: string[]; x: number; y: number; row: number; col: number } | null>(null);
  const [panelClosed, setPanelClosed] = useState<string | null>(null);
  const [chartSelected, setChartSelected] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<{ row: number; col: number }[] | null>(null);
  const [headless, setHeadless] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [, setVersion] = useState(0);
  useEffect(() => wb.subscribe(() => setVersion((v) => v + 1)), [wb]);
  const [sheetUid, setSheetUid] = useState(() => wb.sheets.find((s) => !s.hidden)?.uid ?? wb.sheets[0]!.uid);
  const sheet = wb.sheet(sheetUid) ?? wb.sheets[0]!;
  const selections = useRef(new Map<number, Selection>());
  const [sel, setSelState] = useState<Selection>(single(0, 0));
  const anchor = useRef({ row: 0, col: 0 });
  const cursor = useRef({ row: 0, col: 0 });
  const [edit, setEdit] = useState<Edit | null>(null);
  const [zoom, setZoom] = useState(1);
  const [extent, setExtent] = useState({ rows: 200, cols: 40 });
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [copied, setCopied] = useState<{ sheet: number; area: Area; cut: boolean } | null>(null);
  const [fillTo, setFillTo] = useState<Area | null>(null);
  const [showFormulas, setShowFormulas] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [found, setFound] = useState<{ row: number; col: number } | null>(null);
  const [ac, setAc] = useState<{ index: number; touched: boolean }>({ index: 0, touched: false });
  const [renaming, setRenaming] = useState<number | null>(null);
  const [nameBox, setNameBox] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const bar = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef({ x: 0, y: 0 });
  const theme = useRef<Theme | null>(null);
  const ants = useRef(0);
  /** Where a run of Tab-entered cells began: Enter goes back to its column, one row down. */
  const tabStart = useRef<{ row: number; col: number } | null>(null);
  const drag = useRef<null | { kind: "select" | "fill" | "col" | "row" | "point"; start: { row: number; col: number }; index?: number; origin?: number; size?: number; add?: boolean; moved?: boolean }>(null);
  const [, setScrollTick] = useState(0);

  const setSel = useCallback((next: Selection) => {
    setSelState(next);
    selections.current.set(sheetUid, next);
  }, [sheetUid]);

  // the sheet's used size decides how far the scrollbars go
  const bounds = wb.bounds(sheet);
  const rowsNeeded = Math.min(MAX_ROWS, Math.max(extent.rows, bounds.rows + 100, sel.active.row + 60, sheet.freezeRows + 60));
  const colsNeeded = Math.min(MAX_COLS, Math.max(extent.cols, bounds.cols + 12, sel.active.col + 20, sheet.freezeCols + 20));
  const layout = useMemo(
    () => makeLayout(sheet, rowsNeeded, colsNeeded, zoom),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sheet, rowsNeeded, colsNeeded, zoom, wb.version, sheet.rowHeights, sheet.colWidths, sheet.hiddenRows, sheet.hiddenCols, sheet.filterHidden, sheet.freezeRows, sheet.freezeCols],
  );

  // ------------------------------------------------------------------------ drawing
  const refsInEdit = useMemo(() => {
    if (!edit || !edit.text.startsWith("=")) return [] as { area: Area; color: string; text: string }[];
    const out: { area: Area; color: string; text: string }[] = [];
    const seen = new Map<string, string>();
    for (const t of tokenize(edit.text.slice(1))) {
      if (t.type !== "ref" || !t.ref) continue;
      if (t.ref.sheet !== null && t.ref.sheet.toLowerCase() !== sheet.name.toLowerCase()) continue;
      const id = t.text.replace(/\$/g, "").toUpperCase();
      let color = seen.get(id);
      if (!color) {
        color = REF_COLORS[seen.size % REF_COLORS.length]!;
        seen.set(id, color);
      }
      out.push({ area: normal(t.ref), color, text: t.text });
    }
    return out;
  }, [edit, sheet.name]);

  const overlay: Overlay = {
    selection: sel,
    refs: refsInEdit,
    copied: copied && copied.sheet === sheet.uid ? copied.area : null,
    antsOffset: ants.current,
    fillTo,
    editing: edit && (edit.text !== "" || edit.mode === "edit") ? { row: edit.row, col: edit.col } : null,
    showFormulas,
    found,
    invalid: invalid ?? undefined,
  };
  const state = useRef({ overlay, layout, sheet, zoom });
  state.current = { overlay, layout, sheet, zoom };

  const paint = useCallback(() => {
    const c = canvas.current;
    if (!c || !wrap.current) return;
    if (!theme.current) theme.current = readTheme(wrap.current);
    const { overlay: o, layout: l, sheet: s, zoom: z } = state.current;
    draw(c, wb, s, l, scroll.current.x, scroll.current.y, size.w, size.h, theme.current, { ...o, antsOffset: ants.current }, z);
  }, [wb, size]);

  useLayoutEffect(() => paint());

  // theme changes (light and dark) redraw in the new colours
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const again = () => {
      theme.current = null;
      requestAnimationFrame(paint);
    };
    media.addEventListener("change", again);
    const watcher = new MutationObserver(again);
    watcher.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => {
      media.removeEventListener("change", again);
      watcher.disconnect();
    };
  }, [paint]);

  // marching ants around what was copied
  useEffect(() => {
    if (!copied) return;
    let frame = 0;
    const tick = () => {
      ants.current = (ants.current + 0.4) % 18;
      paint();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [copied, paint]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const box = el.getBoundingClientRect();
      setSize({ w: Math.max(100, Math.floor(box.width)), h: Math.max(100, Math.floor(box.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scroller.current!;
    scroll.current = { x: el.scrollLeft, y: el.scrollTop };
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 300 && rowsNeeded < MAX_ROWS) setExtent((e) => ({ ...e, rows: Math.min(MAX_ROWS, Math.max(e.rows, rowsNeeded) + 400) }));
    if (el.scrollLeft + el.clientWidth > el.scrollWidth - 300 && colsNeeded < MAX_COLS) setExtent((e) => ({ ...e, cols: Math.min(MAX_COLS, Math.max(e.cols, colsNeeded) + 20) }));
    requestAnimationFrame(paint);
    if (edit) setScrollTick((t) => t + 1);
  };

  /** Scroll so a cell can be seen. */
  const reveal = useCallback((row: number, col: number) => {
    const el = scroller.current;
    if (!el) return;
    const l = state.current.layout;
    const viewW = el.clientWidth - HEADER_W - l.frozenW;
    const viewH = el.clientHeight - HEADER_H - l.frozenH;
    if (row >= l.freezeRows) {
      const top = l.rows.start(row) - l.frozenH;
      const bottom = l.rows.end(row) - l.frozenH;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + viewH) el.scrollTop = bottom - viewH;
    }
    if (col >= l.freezeCols) {
      const left = l.cols.start(col) - l.frozenW;
      const right = l.cols.end(col) - l.frozenW;
      if (left < el.scrollLeft) el.scrollLeft = left;
      else if (right > el.scrollLeft + viewW) el.scrollLeft = right - viewW;
    }
    scroll.current = { x: el.scrollLeft, y: el.scrollTop };
  }, []);

  // ------------------------------------------------------------------------ selection
  const mergeAt = (row: number, col: number) => wb.mergeAt(sheet, row, col);

  const select = useCallback((row: number, col: number, extend = false, add = false) => {
    row = Math.max(0, Math.min(MAX_ROWS - 1, row));
    col = Math.max(0, Math.min(MAX_COLS - 1, col));
    if (extend) {
      cursor.current = { row, col };
      let area = normal({ r1: anchor.current.row, c1: anchor.current.col, r2: row, c2: col });
      // a range that touches a merged cell takes all of it
      for (const m of sheet.merges) if (m.r1 <= area.r2 && area.r1 <= m.r2 && m.c1 <= area.c2 && area.c1 <= m.c2) area = { r1: Math.min(area.r1, m.r1), c1: Math.min(area.c1, m.c1), r2: Math.max(area.r2, m.r2), c2: Math.max(area.c2, m.c2) };
      setSel({ active: anchor.current, ranges: [...sel.ranges.slice(0, -1), area] });
    } else {
      anchor.current = { row, col };
      cursor.current = { row, col };
      const m = mergeAt(row, col);
      const area = m ?? { r1: row, c1: col, r2: row, c2: col };
      setSel({ active: { row: m?.r1 ?? row, col: m?.c1 ?? col }, ranges: add ? [...sel.ranges, area] : [area] });
    }
    reveal(row, col);
    setFound(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, sheet, reveal, setSel]);

  const selectArea = useCallback((area: Area, active?: { row: number; col: number }) => {
    const a = active ?? { row: area.r1, col: area.c1 };
    anchor.current = a;
    cursor.current = { row: area.r2, col: area.c2 };
    setSel({ active: a, ranges: [area] });
    reveal(a.row, a.col);
  }, [reveal, setSel]);

  const switchSheet = useCallback((uid: number) => {
    if (uid === sheetUid) return;
    selections.current.set(sheetUid, sel);
    setSheetUid(uid);
    const restored = selections.current.get(uid) ?? single(0, 0);
    setSelState(restored);
    anchor.current = restored.active;
    cursor.current = restored.active;
    setFound(null);
    if (scroller.current) {
      scroller.current.scrollTop = 0;
      scroller.current.scrollLeft = 0;
    }
    scroll.current = { x: 0, y: 0 };
  }, [sheetUid, sel]);

  // ------------------------------------------------------------------------ editing
  const startEdit = (text: string, mode: Edit["mode"], from: Edit["from"] = "cell") => {
    const { row, col } = sel.active;
    setEdit({ row, col, text, mode, from, point: null, caret: text.length });
    setAc({ index: 0, touched: false });
    requestAnimationFrame(() => {
      const target = from === "bar" ? bar.current : input.current;
      if (target) {
        target.focus();
        target.setSelectionRange(text.length, text.length);
      }
    });
  };

  const focusGrid = () => requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));

  const cancelEdit = () => {
    setEdit(null);
    if (input.current) input.current.value = "";
    focusGrid();
  };

  /** Put the edited text in the cell (or every selected cell, with Ctrl+Enter). Returns false to keep editing. */
  const commit = (move: { dr: number; dc: number } | null, everywhere = false): boolean => {
    if (!edit) return true;
    let text = edit.text;
    if (text.startsWith("=") && text.length > 1) {
      text = closeBrackets(text);
      try {
        parse(text.slice(1));
      } catch (error) {
        notify(`There's a problem with this formula: ${error instanceof ParseError ? error.message : String(error)}. To type text that starts with =, put an apostrophe first.`, "error");
        return false;
      }
    }
    const { row, col } = edit;
    // a cell's data validation rule checks what is typed
    const rule = validationAt(sheet, row, col);
    if (rule && !text.startsWith("=")) {
      const value = parseInput(text, wb.style(sheet.cells.get(key(row, col))?.s).format).value;
      const problem = checkValidation(wb, sheet, row, col, value);
      if (problem) {
        const style = rule.error?.style ?? "stop";
        if (style === "stop") {
          notify(`${rule.error?.title ? rule.error.title + ": " : ""}${problem}`, "error");
          return false;
        }
        if (style === "warning" && !window.confirm(`${problem}\n\nKeep it anyway?`)) return false;
        if (style === "info") notify(problem, "info");
      }
    }
    wb.transact(`Edit ${cellName(row, col)}`, () => {
      if (everywhere) {
        for (const a of sel.ranges)
          for (let r = a.r1; r <= Math.min(a.r2, a.r1 + 100_000); r++)
            for (let c = a.c1; c <= Math.min(a.c2, a.c1 + 1000); c++) wb.setInput(sheet, r, c, text.startsWith("=") ? "=" + shiftFormula(text.slice(1), r - row, c - col) : text);
      } else wb.setInput(sheet, row, col, text);
    });
    setEdit(null);
    if (input.current) input.current.value = "";
    if (move) {
      const range = sel.ranges[sel.ranges.length - 1]!;
      const multi = sel.ranges.length === 1 && (range.r1 !== range.r2 || range.c1 !== range.c2);
      if (multi && !everywhere) {
        // Enter and Tab move inside a selected block, wrapping at its edges
        let r = sel.active.row + move.dr;
        let c = sel.active.col + move.dc;
        if (r > range.r2) {
          r = range.r1;
          c = c + 1 > range.c2 ? range.c1 : c + 1;
        } else if (r < range.r1) {
          r = range.r2;
          c = c - 1 < range.c1 ? range.c2 : c - 1;
        }
        if (c > range.c2) {
          c = range.c1;
          r = r + 1 > range.r2 ? range.r1 : r + 1;
        } else if (c < range.c1) {
          c = range.c2;
          r = r - 1 < range.r1 ? range.r2 : r - 1;
        }
        setSel({ active: { row: r, col: c }, ranges: sel.ranges });
        reveal(r, c);
      } else if (!everywhere && move.dr > 0 && move.dc === 0 && tabStart.current && tabStart.current.row === row) {
        const startCol = tabStart.current.col;
        tabStart.current = null;
        select(row + 1, startCol);
      } else if (!everywhere) {
        if (move.dc !== 0) {
          if (!tabStart.current || tabStart.current.row !== row) tabStart.current = { row, col };
        } else tabStart.current = null;
        const m = mergeAt(row, col);
        const nextRow = move.dr > 0 ? (m ? m.r2 : row) + move.dr : row + move.dr;
        const nextCol = move.dc > 0 ? (m ? m.c2 : col) + move.dc : col + move.dc;
        select(nextRow, nextCol);
      }
    }
    focusGrid();
    return true;
  };

  /** Type a reference into the formula being edited (clicks and arrows while pointing). */
  const pointAt = (area: Area, from: { row: number; col: number }, cur: { row: number; col: number }, keepAnchor: boolean) => {
    if (!edit) return;
    const ref = area.r1 === area.r2 && area.c1 === area.c2 ? cellName(area.r1, area.c1) : `${cellName(area.r1, area.c1)}:${cellName(area.r2, area.c2)}`;
    const text = (() => {
      const editingSheet = wb.sheet(sheetUid);
      return editingSheet && editingSheet.uid !== sheetUid ? ref : ref;
    })();
    const p = edit.point;
    const start = p ? p.start : edit.caret;
    const end = p ? p.end : edit.caret;
    const next = edit.text.slice(0, start) + text + edit.text.slice(end);
    setEdit({ ...edit, text: next, caret: start + text.length, point: { start, end: start + text.length, anchor: keepAnchor && p ? p.anchor : from, cursor: cur } });
    requestAnimationFrame(() => {
      const target = edit.from === "bar" ? bar.current : input.current;
      target?.focus();
      target?.setSelectionRange(start + text.length, start + text.length);
    });
  };

  // autocomplete for function names
  const suggestions = useMemo(() => {
    if (!edit || !edit.text.startsWith("=")) return [];
    const before = edit.text.slice(0, edit.caret);
    const m = /(^|[=(,+\-*/^&<>:;{ ])([A-Za-z_][\w.]*)$/.exec(before);
    if (!m || before.endsWith(" ")) return [];
    const prefix = m[2]!.toUpperCase();
    const names = Object.keys(FUNCTIONS).filter((n) => n.startsWith(prefix)).sort((a, b) => a.length - b.length || a.localeCompare(b));
    const defined = [...wb.names.values()].map((n) => n.name).filter((n) => n.toUpperCase().startsWith(prefix));
    return [...defined, ...names].slice(0, 10).map((name) => ({ name, prefix: m[2]!, isName: defined.includes(name) }));
  }, [edit, wb.names]);
  const hint = edit && edit.text.startsWith("=") ? callAt(edit.text, edit.caret) : null;

  const accept = (index: number) => {
    if (!edit) return;
    const pick = suggestions[index];
    if (!pick) return;
    const start = edit.caret - pick.prefix.length;
    const insert = pick.isName ? pick.name : pick.name + "(";
    const text = edit.text.slice(0, start) + insert + edit.text.slice(edit.caret);
    setEdit({ ...edit, text, caret: start + insert.length, point: null });
    setAc({ index: 0, touched: false });
    requestAnimationFrame(() => {
      const target = edit.from === "bar" ? bar.current : input.current;
      target?.focus();
      target?.setSelectionRange(start + insert.length, start + insert.length);
    });
  };

  // ------------------------------------------------------------------------ clipboard
  const copy = (cut: boolean, event?: ClipboardEvent | React.ClipboardEvent) => {
    if (sel.ranges.length > 1) {
      notify("Copy works on one block of cells at a time.", "error");
      return;
    }
    const area = sel.ranges[0]!;
    const used = { ...area, r2: Math.min(area.r2, Math.max(area.r1, wb.bounds(sheet).rows - 1)), c2: Math.min(area.c2, Math.max(area.c1, wb.bounds(sheet).cols - 1)) };
    const { clip, text, html } = copyArea(wb, sheet, used);
    if (cut) clip.cut = { sheet: sheet.uid, area: used };
    clipboardMemory.set(clip);
    if (event && "clipboardData" in event && event.clipboardData) {
      event.clipboardData.setData("text/plain", text);
      event.clipboardData.setData("text/html", html);
      event.preventDefault();
    } else void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied({ sheet: sheet.uid, area: used, cut });
  };

  const pasteData = (text: string, html: string, mode: PasteMode = "all") => {
    const memory = clipboardMemory.get();
    const area = sel.ranges[sel.ranges.length - 1]!;
    try {
      let pasted: Area;
      if (memory && (memory.text === text.replace(/\r\n/g, "\n").replace(/\n$/, "") || !text)) {
        pasted = paste(wb, sheet, area, memory, mode);
        if (memory.cut) {
          clipboardMemory.set(null);
          setCopied(null);
        }
      } else {
        const rows = parseHtmlTable(html) ?? parseTsv(text);
        pasted = paste(wb, sheet, area, rows, mode);
      }
      selectArea(pasted, { row: pasted.r1, col: pasted.c1 });
    } catch (error) {
      notify((error as Error).message, "error");
    }
  };

  const pasteFromMenu = async (mode: PasteMode) => {
    let text = "";
    try {
      text = (await navigator.clipboard?.readText()) ?? "";
    } catch {
      /* no permission: the copy made here still pastes */
    }
    pasteData(text, "", mode);
  };

  /** Alt+Down: the cell's list, or (as Excel's Pick From Drop-down List) the column's own values. */
  const openList = () => {
    const { row, col } = sel.active;
    const v = validationAt(sheet, row, col);
    let items: string[];
    if (v?.kind === "list") items = listItems(wb, sheet, v, row, col);
    else {
      const block = region(wb, sheet, row, col);
      const seen = new Set<string>();
      for (let r = block.r1; r <= block.r2; r++) {
        if (r === row) continue;
        const t = wb.display(sheet, r, col).text;
        if (t && typeof wb.value(sheet, r, col) === "string") seen.add(t);
      }
      items = [...seen].sort((a, b) => a.localeCompare(b));
    }
    const box = cellRect(state.current.layout, row, col, scroll.current.x, scroll.current.y);
    const wbox = wrap.current!.getBoundingClientRect();
    setListMenu({ items, x: wbox.left + box.x, y: wbox.top + box.y + box.h + 2, row, col });
  };

  const download = async (kind: "xlsx" | "csv") => {
    try {
      const base = (fileName || "workbook").replace(/[\\/:*?"<>|]+/g, "_");
      let bytes: Uint8Array;
      if (kind === "xlsx") bytes = await writeXlsx(wb);
      else bytes = new TextEncoder().encode("\ufeff" + writeCsv(wb, wb.sheets.indexOf(sheet)));
      const name = kind === "xlsx" ? `${base}.xlsx` : `${base}${wb.sheets.length > 1 ? ` - ${sheet.name}` : ""}.csv`;
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const saved = await engine.call<{ path: string; name: string }>("sheets.export_file", { name, data: btoa(binary) });
      await engine.download(saved.path, saved.name);
      notify(`Downloaded ${saved.name}.`, "ok");
    } catch (error) {
      fail(error);
    }
  };

  /** Bring sheets from an .xlsx or .csv file into this workbook. */
  const importFile = async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isCsv = /\.(csv|tsv|txt)$/i.test(file.name);
      const incoming = isCsv ? { format: "flowlabs-workbook" as const, version: 1 as const, sheets: [csvSheet(file.name.replace(/\.[^.]+$/, "").slice(0, 31), parseCsv(new TextDecoder().decode(bytes)))], styles: [{}, { format: "yyyy-mm-dd" }], names: [] } : await readXlsx(bytes);
      let first: number | null = null;
      wb.transact(`Import ${file.name}`, () => {
        for (const json of incoming.sheets) {
          let name = json.name;
          let n = 2;
          while (wb.sheetByName(name)) name = `${json.name.slice(0, 27)} (${n++})`;
          const made = wb.addSheet(name);
          if (first === null) first = made.uid;
          // styles come with their own ids: map them into this workbook's list
          for (const [r, c, cell] of json.cells) {
            const st = cell.s ? incoming.styles[cell.s] : undefined;
            const s2 = st ? wb.styleId(st) : undefined;
            if (cell.f !== undefined) wb.putCell(made, r, c, { v: null, f: cell.f, s: s2, note: cell.n });
            else {
              const v = cell.v && typeof cell.v === "object" ? null : (cell.v ?? null);
              wb.putCell(made, r, c, { v, s: s2, note: cell.n });
            }
          }
          wb.setSheetProp(made, "colWidths", new Map(json.colWidths ?? []));
          wb.setSheetProp(made, "rowHeights", new Map(json.rowHeights ?? []));
          wb.setSheetProp(made, "merges", json.merges ?? []);
          wb.setSheetProp(made, "freezeRows", json.freezeRows ?? 0);
          wb.setSheetProp(made, "freezeCols", json.freezeCols ?? 0);
          if (json.filter) wb.setSheetProp(made, "filter", json.filter);
          wb.setSheetProp(made, "validations", json.validations ?? []);
          wb.setSheetProp(made, "conditionals", json.conditionals ?? []);
          wb.setSheetProp(made, "tables", json.tables ?? []);
        }
        for (const n of incoming.names ?? []) {
          try {
            wb.defineName(n.name, n.formula, n.sheet ? (wb.sheetByName(n.sheet)?.uid ?? null) : null);
          } catch {
            /* a name this workbook already has */
          }
        }
      });
      if (first !== null) switchSheet(first);
      notify(`Imported ${incoming.sheets.length} ${incoming.sheets.length === 1 ? "sheet" : "sheets"} from ${file.name}.`, "ok");
    } catch (error) {
      notify((error as Error).message, "error");
    }
  };

  const print = () => {
    const { rows, cols } = wb.bounds(sheet);
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    let html = `<table>`;
    for (let r = 0; r < Math.min(rows, 5000); r++) {
      if (sheet.hiddenRows.has(r) || sheet.filterHidden.has(r)) continue;
      html += "<tr>";
      for (let c = 0; c < Math.min(cols, 200); c++) {
        if (sheet.hiddenCols.has(c)) continue;
        const st = wb.style(sheet.cells.get(key(r, c))?.s);
        const shown = wb.display(sheet, r, c);
        const align = st.h ?? (typeof shown.value === "number" ? "right" : "left");
        html += `<td style="text-align:${align};${st.bold ? "font-weight:600;" : ""}${st.italic ? "font-style:italic;" : ""}${st.fill ? `background:${st.fill};` : ""}${st.color ? `color:${st.color};` : ""}">${esc(shown.text)}</td>`;
      }
      html += "</tr>";
    }
    html += "</table>";
    const w = window.open("", "_blank");
    if (!w) return notify("The print window was blocked.", "error");
    w.document.write(`<!doctype html><title>${esc(fileName ?? "Workbook")} - ${esc(sheet.name)}</title><style>body{font:11pt -apple-system,Segoe UI,sans-serif;margin:24px}table{border-collapse:collapse}td{border:1px solid #ccc;padding:3px 6px;white-space:nowrap}@media print{body{margin:0}}</style>${html}<script>onload=()=>print()</script>`);
    w.document.close();
  };

  const repeatable = (fn: () => void) => run(fn);

  // ------------------------------------------------------------------------ keyboard
  const moveBy = (dr: number, dc: number, extend: boolean, toEdge: boolean) => {
    const from = extend ? cursor.current : sel.active;
    let { row, col } = from;
    if (toEdge) ({ row, col } = jump(wb, sheet, row, col, dr, dc));
    else {
      const m = mergeAt(row, col);
      if (m && !extend) {
        if (dr > 0) row = m.r2;
        if (dc > 0) col = m.c2;
        if (dr < 0) row = m.r1;
        if (dc < 0) col = m.c1;
      }
      row += dr;
      col += dc;
      while (dr && row > 0 && row < MAX_ROWS - 1 && sheet.hiddenRows.has(row)) row += dr;
      while (dc && col > 0 && col < MAX_COLS - 1 && sheet.hiddenCols.has(col)) col += dc;
    }
    if (row + 50 > rowsNeeded) setExtent((e) => ({ ...e, rows: Math.min(MAX_ROWS, row + 200) }));
    if (col + 20 > colsNeeded) setExtent((e) => ({ ...e, cols: Math.min(MAX_COLS, col + 30) }));
    requestAnimationFrame(() => select(row, col, extend));
    select(row, col, extend);
  };

  const pageRows = () => Math.max(1, Math.floor((size.h - HEADER_H) / (DEFAULT_ROW_HEIGHT * zoom)) - 1);

  const run = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      notify((error as Error).message, "error");
    }
  };

  const onGridKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const sh = e.shiftKey;
    // keys while a cell is being edited
    if (edit) {
      if (suggestions.length && (k === "ArrowDown" || k === "ArrowUp") && !sh && !mod) {
        e.preventDefault();
        setAc((a) => ({ index: (a.index + (k === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length, touched: true }));
        return;
      }
      if (suggestions.length && (k === "Tab" || (k === "Enter" && ac.touched))) {
        e.preventDefault();
        accept(ac.index);
        return;
      }
      if (k === "Enter" && e.altKey) {
        e.preventDefault();
        const t = e.currentTarget;
        const caret = t.selectionStart;
        const text = edit.text.slice(0, caret) + "\n" + edit.text.slice(t.selectionEnd);
        setEdit({ ...edit, text, caret: caret + 1, mode: "edit" });
        requestAnimationFrame(() => t.setSelectionRange(caret + 1, caret + 1));
        return;
      }
      if (k === "Enter") {
        e.preventDefault();
        // Ctrl+Shift+Enter (an array formula in old Excel) is a plain Enter: arrays spill by themselves
        if (mod && sh) commit({ dr: 1, dc: 0 });
        else commit(mod ? null : { dr: sh ? -1 : 1, dc: 0 }, mod);
        return;
      }
      if (k === "Tab") {
        e.preventDefault();
        commit({ dr: 0, dc: sh ? -1 : 1 });
        return;
      }
      if (k === "Escape") {
        e.preventDefault();
        if (suggestions.length && !ac.touched && edit.text.startsWith("=")) {
          setAc({ index: 0, touched: true });
        }
        cancelEdit();
        return;
      }
      if (k === "F2") {
        e.preventDefault();
        setEdit({ ...edit, mode: edit.mode === "enter" ? "edit" : "enter", point: null });
        return;
      }
      if (k === "F4") {
        e.preventDefault();
        const t = e.currentTarget;
        const next = toggleAbsolute(edit.text, t.selectionStart);
        setEdit({ ...edit, text: next.text, caret: next.caret, point: null });
        requestAnimationFrame(() => t.setSelectionRange(next.caret, next.caret));
        return;
      }
      const arrow = k === "ArrowDown" ? [1, 0] : k === "ArrowUp" ? [-1, 0] : k === "ArrowRight" ? [0, 1] : k === "ArrowLeft" ? [0, -1] : null;
      if (arrow && edit.mode === "enter") {
        e.preventDefault();
        const caret = e.currentTarget.selectionStart;
        if (edit.point || canPoint(edit.text, caret)) {
          // arrows point at cells to put their reference in the formula
          const base = edit.point ? (sh ? edit.point.cursor : edit.point.cursor) : { row: edit.row, col: edit.col };
          const next = mod ? jump(wb, sheet, base.row, base.col, arrow[0]!, arrow[1]!) : { row: Math.max(0, base.row + arrow[0]!), col: Math.max(0, base.col + arrow[1]!) };
          const from = sh && edit.point ? edit.point.anchor : next;
          pointAt(normal({ r1: from.row, c1: from.col, r2: next.row, c2: next.col }), from, next, sh);
          reveal(next.row, next.col);
          return;
        }
        commit({ dr: arrow[0]!, dc: arrow[1]! });
        return;
      }
      return;
    }

    // navigation and commands
    if (chartSelected && (k === "Delete" || k === "Backspace")) {
      e.preventDefault();
      wb.transact("Delete chart", () => wb.setSheetProp(sheet, "charts", sheet.charts.filter((c) => c.id !== chartSelected)));
      setChartSelected(null);
      return;
    }
    if (k === "ArrowDown" && e.altKey) {
      e.preventDefault();
      openList();
      return;
    }
    if (mod && e.altKey && !sh && (k === "v" || k === "V")) {
      e.preventDefault();
      setData({ kind: "paste" });
      return;
    }
    if (mod && e.altKey && k === "F9") {
      e.preventDefault();
      wb.recalcAll();
      return;
    }
    if (mod && sh && !e.altKey) {
      const special: Record<string, () => void> = {
        l: () => run(() => toggleFilter(wb, sheet, sheet.filter ? sheet.filter.area : region(wb, sheet, sel.active.row, sel.active.col))),
        "&": () => repeatable(() => applyBorders(wb, sheet, sel, "outer")),
        "7": () => repeatable(() => applyBorders(wb, sheet, sel, "outer")),
        _: () => repeatable(() => applyBorders(wb, sheet, sel, "none")),
        "^": () => repeatable(() => applyStyle(wb, sheet, sel, { format: "0.00E+00" })),
        "6": () => repeatable(() => applyStyle(wb, sheet, sel, { format: "0.00E+00" })),
        f: () => setDialog({ kind: "format", tab: "font" }),
        p: () => setDialog({ kind: "format", tab: "font" }),
        " ": () => selectArea({ r1: 0, c1: 0, r2: MAX_ROWS - 1, c2: MAX_COLS - 1 }, sel.active),
        f3: () => setDialog({ kind: "names" }),
      };
      const fn = special[k.length === 1 ? k.toLowerCase() : k.toLowerCase()];
      if (fn) {
        e.preventDefault();
        fn();
        return;
      }
    }
    if (mod && !sh && !e.altKey) {
      const plain: Record<string, () => void> = {
        t: () => setData({ kind: "table" }),
        e: () => {
          const n = flashFill(wb, sheet, sel.active.row, sel.active.col);
          notify(n ? `Flash Fill filled ${n} ${n === 1 ? "cell" : "cells"}.` : "Flash Fill found no pattern. Type one or two examples in the column first, next to the data.", n ? "ok" : "info");
        },
        f3: () => setDialog({ kind: "names" }),
        "[": () => {
          const f = sheet.cells.get(key(sel.active.row, sel.active.col))?.f;
          const ref = f ? tokenize(f).find((t) => t.type === "ref")?.ref : undefined;
          if (!ref) return;
          const target = ref.sheet ? wb.sheetByName(ref.sheet) : sheet;
          if (target && target.uid !== sheet.uid) switchSheet(target.uid);
          requestAnimationFrame(() => selectArea(normal(ref)));
        },
        p: () => print(),
        s: () => onSave?.(),
        o: () => fileInput.current?.click(),
        n: () => onNew?.(),
        f1: () => setHeadless((v) => !v),
        insert: () => copy(false),
      };
      const fn = plain[k.length === 1 ? k.toLowerCase() : k.toLowerCase()];
      if (fn) {
        e.preventDefault();
        fn();
        return;
      }
    }
    if (!mod && e.altKey && k === "F1") {
      e.preventDefault();
      setData({ kind: "chart" });
      return;
    }
    if (!mod && sh && !e.altKey) {
      const shifted: Record<string, () => void> = {
        F2: () => setDialog({ kind: "note" }),
        F3: () => setDialog({ kind: "function" }),
        F10: () => {
          const box = cellRect(state.current.layout, sel.active.row, sel.active.col, scroll.current.x, scroll.current.y);
          const w = wrap.current!.getBoundingClientRect();
          setMenu({ x: w.left + box.x + box.w / 2, y: w.top + box.y + box.h, kind: "cells" });
        },
        F9: () => wb.recalcAll(),
        Backspace: () => select(sel.active.row, sel.active.col),
        Delete: () => copy(true),
        Insert: () => void pasteFromMenu("all"),
        Home: () => select(cursor.current.row, 0, true),
      };
      const fn = shifted[k];
      if (fn) {
        e.preventDefault();
        fn();
        return;
      }
    }
    if (k === "F4" && !mod && !sh && lastFormat.apply) {
      e.preventDefault();
      const again = lastFormat.apply;
      run(() => again(wb, sheet, sel));
      return;
    }
    const arrow = k === "ArrowDown" ? [1, 0] : k === "ArrowUp" ? [-1, 0] : k === "ArrowRight" ? [0, 1] : k === "ArrowLeft" ? [0, -1] : null;
    if (arrow) {
      e.preventDefault();
      if (e.altKey) return;
      moveBy(arrow[0]!, arrow[1]!, sh, mod);
      return;
    }
    const a = sel.active;
    const area = sel.ranges[sel.ranges.length - 1]!;
    const key2 = k.length === 1 ? k.toLowerCase() : k;
    const handled = (): boolean => {
      if (k === "Enter" || k === "Tab") {
        const multi = sel.ranges.length === 1 && (area.r1 !== area.r2 || area.c1 !== area.c2);
        const dr = k === "Enter" ? (sh ? -1 : 1) : 0;
        const dc = k === "Tab" ? (sh ? -1 : 1) : 0;
        if (multi) {
          let r = a.row + dr;
          let c = a.col + dc;
          if (r > area.r2) (r = area.r1), (c = c + 1 > area.c2 ? area.c1 : c + 1);
          if (r < area.r1) (r = area.r2), (c = c - 1 < area.c1 ? area.c2 : c - 1);
          if (c > area.c2) (c = area.c1), (r = r + 1 > area.r2 ? area.r1 : r + 1);
          if (c < area.c1) (c = area.c2), (r = r - 1 < area.r1 ? area.r2 : r - 1);
          setSel({ active: { row: r, col: c }, ranges: sel.ranges });
          reveal(r, c);
        } else if (k === "Enter" && !sh && tabStart.current && tabStart.current.row === a.row) {
          const startCol = tabStart.current.col;
          tabStart.current = null;
          select(a.row + 1, startCol);
        } else {
          if (k === "Tab" && (!tabStart.current || tabStart.current.row !== a.row)) tabStart.current = { row: a.row, col: a.col };
          if (k === "Enter") tabStart.current = null;
          moveBy(dr, dc, false, false);
        }
        return true;
      }
      if (k === "F2") {
        startEdit(wb.editText(sheet, a.row, a.col), "edit");
        return true;
      }
      if (k === "Delete") {
        run(() => wb.transact("Clear", () => sel.ranges.forEach((r) => wb.clear(sheet, r, "contents"))));
        return true;
      }
      if (k === "Backspace") {
        run(() => wb.transact("Clear", () => wb.clear(sheet, { r1: a.row, c1: a.col, r2: a.row, c2: a.col }, "contents")));
        startEdit("", "enter");
        return true;
      }
      if (k === "Escape") {
        setCopied(null);
        clipboardMemory.set(null);
        setFound(null);
        return true;
      }
      if (k === "Home") {
        if (mod) select(sheet.freezeRows, sheet.freezeCols, sh);
        else select(sh ? cursor.current.row : a.row, 0, sh);
        return true;
      }
      if (k === "End" && mod) {
        const b = wb.bounds(sheet);
        select(Math.max(0, b.rows - 1), Math.max(0, b.cols - 1), sh);
        return true;
      }
      if (k === "PageDown" || k === "PageUp") {
        const dir = k === "PageDown" ? 1 : -1;
        if (e.altKey) moveBy(0, dir * 10, sh, false);
        else if (mod) {
          const visible = wb.sheets.filter((s) => !s.hidden);
          const i = visible.findIndex((s) => s.uid === sheet.uid);
          const next = visible[(i + dir + visible.length) % visible.length];
          if (next) switchSheet(next.uid);
        } else moveBy(dir * pageRows(), 0, sh, false);
        return true;
      }
      if (k === "F4" && !mod) return true;
      if (k === "F9") {
        wb.recalcAll();
        return true;
      }
      if (k === "F11" && sh) {
        run(() => {
          const made = wb.transact("New sheet", () => wb.addSheet(undefined, wb.sheets.indexOf(sheet)));
          switchSheet(made.uid);
        });
        return true;
      }
      if (k === "F5") {
        setDialog({ kind: "goto" });
        return true;
      }
      if (k === "F10" && sh) return false;
      if (k === " " && mod && !sh) {
        selectArea({ r1: 0, c1: area.c1, r2: MAX_ROWS - 1, c2: area.c2 }, a);
        return true;
      }
      if (k === " " && sh && !mod) {
        selectArea({ r1: area.r1, c1: 0, r2: area.r2, c2: MAX_COLS - 1 }, a);
        return true;
      }
      if (!mod) return false;
      // Ctrl shortcuts
      switch (key2) {
        case "z":
          sh ? wb.redo() : wb.undo();
          return true;
        case "y":
          wb.redo();
          return true;
        case "a": {
          const region = currentRegion(wb, sheet, a.row, a.col);
          const isRegion = area.r1 === region.r1 && area.r2 === region.r2 && area.c1 === region.c1 && area.c2 === region.c2;
          if (isRegion || (region.r1 === region.r2 && region.c1 === region.c2)) selectArea({ r1: 0, c1: 0, r2: MAX_ROWS - 1, c2: MAX_COLS - 1 }, a);
          else selectArea(region, a);
          return true;
        }
        case "b":
          run(() => toggleStyle(wb, sheet, sel, "bold"));
          return true;
        case "i":
          run(() => toggleStyle(wb, sheet, sel, "italic"));
          return true;
        case "u":
          run(() => toggleStyle(wb, sheet, sel, "underline"));
          return true;
        case "5":
          run(() => toggleStyle(wb, sheet, sel, "strike"));
          return true;
        case "1":
          setDialog({ kind: "format" });
          return true;
        case "d":
          run(() => fillFrom(wb, sheet, sel, "down"));
          return true;
        case "r":
          run(() => fillFrom(wb, sheet, sel, "right"));
          return true;
        case "f":
          setDialog({ kind: "find", replace: false });
          return true;
        case "h":
          setDialog({ kind: "find", replace: true });
          return true;
        case "g":
          setDialog({ kind: "goto" });
          return true;
        case "k":
          setDialog({ kind: "link" });
          return true;
        case "`":
          setShowFormulas((v) => !v);
          return true;
        case ":":
        case ";":
          run(() => {
            const now = new Date();
            const text = sh || key2 === ":" ? `${now.getHours() % 12 || 12}:${String(now.getMinutes()).padStart(2, "0")} ${now.getHours() < 12 ? "AM" : "PM"}` : `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
            wb.transact("Insert date", () => wb.setInput(sheet, a.row, a.col, text));
          });
          return true;
        case "-":
          if (fullRows(area)) run(() => shiftSelection(wb, sheet, sel, "rows", false));
          else if (fullCols(area)) run(() => shiftSelection(wb, sheet, sel, "cols", false));
          else setDialog({ kind: "shift", insert: false });
          return true;
        case "=":
        case "+":
          if (fullRows(area)) run(() => shiftSelection(wb, sheet, sel, "rows", true));
          else if (fullCols(area)) run(() => shiftSelection(wb, sheet, sel, "cols", true));
          else setDialog({ kind: "shift", insert: true });
          return true;
        case "(":
        case "9":
          run(() => wb.transact(sh ? "Unhide rows" : "Hide rows", () => {
            const next = new Set(sheet.hiddenRows);
            for (const r of sel.ranges) for (let i = r.r1; i <= Math.min(r.r2, r.r1 + 100_000); i++) sh ? next.delete(i) : next.add(i);
            wb.setSheetProp(sheet, "hiddenRows", next);
          }));
          return true;
        case ")":
        case "0":
          run(() => wb.transact(sh ? "Unhide columns" : "Hide columns", () => {
            const next = new Set(sheet.hiddenCols);
            for (const r of sel.ranges) for (let i = r.c1; i <= r.c2; i++) sh ? next.delete(i) : next.add(i);
            wb.setSheetProp(sheet, "hiddenCols", next);
          }));
          return true;
        case "$":
        case "4":
          if (!sh) return false;
          run(() => applyStyle(wb, sheet, sel, { format: '"$"#,##0.00' }));
          return true;
        case "%":
          run(() => applyStyle(wb, sheet, sel, { format: "0%" }));
          return true;
        case "!":
          run(() => applyStyle(wb, sheet, sel, { format: "#,##0.00" }));
          return true;
        case "#":
          run(() => applyStyle(wb, sheet, sel, { format: "d-mmm-yy" }));
          return true;
        case "@":
          run(() => applyStyle(wb, sheet, sel, { format: "h:mm AM/PM" }));
          return true;
        case "~":
          run(() => applyStyle(wb, sheet, sel, { format: "General" }));
          return true;
        case "enter":
          return false;
        case "s":
          return true;
        default:
          return false;
      }
    };
    if (k === "=" && e.altKey) {
      e.preventDefault();
      const target = autoSum(wb, sheet, sel);
      if (target) startEdit(target.formula, "enter");
      return;
    }
    if (handled()) {
      e.preventDefault();
      return;
    }
  };

  // typing a character starts editing the active cell (the hidden input receives it)
  const onGridInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    if (edit) return;
    const text = e.currentTarget.value;
    if (!text) return;
    const { row, col } = sel.active;
    setEdit({ row, col, text, mode: "enter", from: "cell", point: null, caret: e.currentTarget.selectionStart });
    setAc({ index: 0, touched: false });
  };

  // ------------------------------------------------------------------------ mouse
  const local = (e: { clientX: number; clientY: number }) => {
    const box = wrap.current!.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };

  const edgeAt = (x: number, y: number): { kind: "col" | "row"; index: number } | null => {
    const l = state.current.layout;
    if (y < HEADER_H && x > HEADER_W) {
      const h = hit(l, x, y, scroll.current.x, scroll.current.y);
      const box = cellRect(l, 0, h.col, scroll.current.x, scroll.current.y);
      if (Math.abs(x - (box.x + box.w)) <= 4) return { kind: "col", index: h.col };
      if (Math.abs(x - box.x) <= 4 && h.col > 0) {
        let c = h.col - 1;
        while (c > 0 && l.cols.size(c) === 0) c--;
        return { kind: "col", index: c };
      }
    }
    if (x < HEADER_W && y > HEADER_H) {
      const h = hit(l, x, y, scroll.current.x, scroll.current.y);
      const box = cellRect(l, h.row, 0, scroll.current.x, scroll.current.y);
      if (Math.abs(y - (box.y + box.h)) <= 3) return { kind: "row", index: h.row };
      if (Math.abs(y - box.y) <= 3 && h.row > 0) return { kind: "row", index: h.row - 1 };
    }
    return null;
  };

  const nearFillHandle = (x: number, y: number) => {
    if (sel.ranges.length !== 1) return false;
    const a = sel.ranges[0]!;
    const box = cellRect(state.current.layout, a.r1, a.c1, scroll.current.x, scroll.current.y, a.r2 - a.r1 + 1, a.c2 - a.c1 + 1);
    return Math.abs(x - (box.x + box.w)) <= 6 && Math.abs(y - (box.y + box.h)) <= 6;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button === 2) return;
    const { x, y } = local(e);
    const el = scroller.current!;
    // clicks on the scrollbars belong to them
    if (x > el.clientWidth || y > el.clientHeight) return;
    const l = state.current.layout;
    const h = hit(l, x, y, scroll.current.x, scroll.current.y);
    const edge = edgeAt(x, y);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (edge) {
      drag.current = { kind: edge.kind, start: { row: 0, col: 0 }, index: edge.index, origin: edge.kind === "col" ? x : y, size: edge.kind === "col" ? l.cols.size(edge.index) / zoom : l.rows.size(edge.index) / zoom };
      return;
    }
    const pointing = edit && (edit.point || canPoint(edit.text, edit.caret));
    if (pointing && !h.inHeaderCol && !h.inHeaderRow) {
      e.preventDefault();
      const extend = e.shiftKey && edit!.point;
      const from = extend ? edit!.point!.anchor : { row: h.row, col: h.col };
      pointAt(normal({ r1: from.row, c1: from.col, r2: h.row, c2: h.col }), from, { row: h.row, col: h.col }, Boolean(extend));
      drag.current = { kind: "point", start: from };
      return;
    }
    if (edit) {
      if (!commit(null)) return;
    }
    if (h.inHeaderRow && h.inHeaderCol) {
      selectArea({ r1: 0, c1: 0, r2: MAX_ROWS - 1, c2: MAX_COLS - 1 }, { row: 0, col: 0 });
      focusGrid();
      return;
    }
    if (h.inHeaderRow) {
      const start = e.shiftKey ? anchor.current.col : h.col;
      if (!e.shiftKey) anchor.current = { row: 0, col: h.col };
      const area = { r1: 0, c1: Math.min(start, h.col), r2: MAX_ROWS - 1, c2: Math.max(start, h.col) };
      setSel({ active: { row: Math.max(0, scrollTopRow()), col: anchor.current.col }, ranges: e.ctrlKey || e.metaKey ? [...sel.ranges, area] : [area] });
      drag.current = { kind: "select", start: { row: -1, col: anchor.current.col }, add: e.ctrlKey || e.metaKey };
      focusGrid();
      return;
    }
    if (h.inHeaderCol) {
      const start = e.shiftKey ? anchor.current.row : h.row;
      if (!e.shiftKey) anchor.current = { row: h.row, col: 0 };
      const area = { r1: Math.min(start, h.row), c1: 0, r2: Math.max(start, h.row), c2: MAX_COLS - 1 };
      setSel({ active: { row: anchor.current.row, col: Math.max(0, scrollLeftCol()) }, ranges: e.ctrlKey || e.metaKey ? [...sel.ranges, area] : [area] });
      drag.current = { kind: "select", start: { row: anchor.current.row, col: -1 }, add: e.ctrlKey || e.metaKey };
      focusGrid();
      return;
    }
    if (nearFillHandle(x, y)) {
      drag.current = { kind: "fill", start: { row: h.row, col: h.col } };
      return;
    }
    setChartSelected(null);
    // a filter button in the header row
    if (sheet.filter && h.row === sheet.filter.area.r1 && h.col >= sheet.filter.area.c1 && h.col <= sheet.filter.area.c2) {
      const b = filterButton(cellRect(l, h.row, h.col, scroll.current.x, scroll.current.y));
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        const box = wrap.current!.getBoundingClientRect();
        setFilterMenu({ col: h.col, x: box.left + b.x, y: box.top + b.y + b.h + 4 });
        drag.current = null;
        return;
      }
    }
    // the drop-down arrow beside a cell with a list rule
    {
      const v = validationAt(sheet, sel.active.row, sel.active.col);
      if (v?.kind === "list" && v.dropdown) {
        const ab = cellRect(l, sel.active.row, sel.active.col, scroll.current.x, scroll.current.y);
        if (x >= ab.x + ab.w && x <= ab.x + ab.w + 17 && y >= ab.y && y <= ab.y + ab.h) {
          openList();
          drag.current = null;
          return;
        }
      }
    }
    tabStart.current = null;
    if (e.shiftKey) select(h.row, h.col, true);
    else select(h.row, h.col, false, e.ctrlKey || e.metaKey);
    drag.current = { kind: "select", start: { row: h.row, col: h.col }, add: e.ctrlKey || e.metaKey };
    focusGrid();
  };

  const scrollTopRow = () => state.current.layout.rows.at(scroll.current.y + state.current.layout.frozenH);
  const scrollLeftCol = () => state.current.layout.cols.at(scroll.current.x + state.current.layout.frozenW);

  const autoScroll = useRef<number | null>(null);
  const lastPointer = useRef<{ clientX: number; clientY: number } | null>(null);

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const { x, y } = local(e);
    const d = drag.current;
    const el = scroller.current!;
    if (!d) {
      const edge = edgeAt(x, y);
      el.style.cursor = edge ? (edge.kind === "col" ? "col-resize" : "row-resize") : nearFillHandle(x, y) ? "crosshair" : y < HEADER_H || x < HEADER_W ? "default" : "cell";
      return;
    }
    lastPointer.current = { clientX: e.clientX, clientY: e.clientY };
    dragTo(x, y);
    // keep scrolling while the pointer is past an edge
    const outside = x < HEADER_W || y < HEADER_H || x > el.clientWidth || y > el.clientHeight;
    if (outside && autoScroll.current === null && d.kind !== "col" && d.kind !== "row") {
      autoScroll.current = window.setInterval(() => {
        const p = lastPointer.current;
        if (!p || !drag.current) return;
        const q = local(p);
        if (q.x > el.clientWidth) el.scrollLeft += 40;
        if (q.x < HEADER_W) el.scrollLeft -= 40;
        if (q.y > el.clientHeight) el.scrollTop += 30;
        if (q.y < HEADER_H) el.scrollTop -= 30;
        scroll.current = { x: el.scrollLeft, y: el.scrollTop };
        dragTo(Math.max(HEADER_W + 1, Math.min(el.clientWidth - 1, q.x)), Math.max(HEADER_H + 1, Math.min(el.clientHeight - 1, q.y)));
      }, 50);
    } else if (!outside && autoScroll.current !== null) {
      window.clearInterval(autoScroll.current);
      autoScroll.current = null;
    }
  };

  const dragTo = (x: number, y: number) => {
    const d = drag.current;
    if (!d) return;
    const l = state.current.layout;
    const h = hit(l, Math.max(HEADER_W + 1, x), Math.max(HEADER_H + 1, y), scroll.current.x, scroll.current.y);
    d.moved = true;
    if (d.kind === "col" || d.kind === "row") {
      const delta = ((d.kind === "col" ? x : y) - d.origin!) / zoom;
      const next = Math.max(0, d.size! + delta);
      // preview by drawing with the new size (committed on release)
      const s = state.current.sheet;
      const sizes = d.kind === "col" ? new Map(s.colWidths) : new Map(s.rowHeights);
      sizes.set(d.index!, next);
      const preview = d.kind === "col" ? { ...s, colWidths: sizes } : { ...s, rowHeights: sizes };
      state.current = { ...state.current, layout: makeLayout(preview as Sheet, rowsNeeded, colsNeeded, zoom) };
      paint();
      return;
    }
    if (d.kind === "point") {
      pointAt(normal({ r1: d.start.row, c1: d.start.col, r2: h.row, c2: h.col }), d.start, { row: h.row, col: h.col }, true);
      return;
    }
    if (d.kind === "fill") {
      const a = sel.ranges[0]!;
      const down = h.row > a.r2 ? h.row - a.r2 : 0;
      const up = h.row < a.r1 ? a.r1 - h.row : 0;
      const right = h.col > a.c2 ? h.col - a.c2 : 0;
      const left = h.col < a.c1 ? a.c1 - h.col : 0;
      const vertical = Math.max(down, up) >= Math.max(right, left);
      let target: Area | null = null;
      if (vertical && down) target = { ...a, r2: h.row };
      else if (vertical && up) target = { ...a, r1: h.row };
      else if (!vertical && right) target = { ...a, c2: h.col };
      else if (!vertical && left) target = { ...a, c1: h.col };
      setFillTo(target);
      return;
    }
    if (d.start.row === -1) {
      setSel({ active: sel.active, ranges: [...(d.add ? sel.ranges.slice(0, -1) : []), { r1: 0, c1: Math.min(d.start.col, h.col), r2: MAX_ROWS - 1, c2: Math.max(d.start.col, h.col) }] });
      return;
    }
    if (d.start.col === -1) {
      setSel({ active: sel.active, ranges: [...(d.add ? sel.ranges.slice(0, -1) : []), { r1: Math.min(d.start.row, h.row), c1: 0, r2: Math.max(d.start.row, h.row), c2: MAX_COLS - 1 }] });
      return;
    }
    if (h.row !== cursor.current.row || h.col !== cursor.current.col) select(h.row, h.col, true);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (autoScroll.current !== null) {
      window.clearInterval(autoScroll.current);
      autoScroll.current = null;
    }
    if (!d) return;
    const { x, y } = local(e);
    if (d.kind === "col" || d.kind === "row") {
      const delta = ((d.kind === "col" ? x : y) - d.origin!) / zoom;
      if (!d.moved || Math.abs(delta) < 1) return;
      const next = Math.max(0, d.size! + delta);
      // resizing one of several selected columns resizes them all
      const indices = d.kind === "col"
        ? sel.ranges.some((a) => fullCols(a) && d.index! >= a.c1 && d.index! <= a.c2) ? sel.ranges.flatMap((a) => (fullCols(a) ? [...Array(a.c2 - a.c1 + 1).keys()].map((i) => a.c1 + i) : [])) : [d.index!]
        : sel.ranges.some((a) => fullRows(a) && d.index! >= a.r1 && d.index! <= a.r2) ? sel.ranges.flatMap((a) => (fullRows(a) ? [...Array(Math.min(5000, a.r2 - a.r1 + 1)).keys()].map((i) => a.r1 + i) : [])) : [d.index!];
      run(() => wb.transact(d.kind === "col" ? "Column width" : "Row height", () => (d.kind === "col" ? wb.setColWidth(sheet, indices, next) : wb.setRowHeight(sheet, indices, next))));
      return;
    }
    if (d.kind === "fill") {
      const target = fillTo;
      setFillTo(null);
      if (target) {
        run(() => autofill(wb, sheet, sel.ranges[0]!, target, e.ctrlKey || e.metaKey));
        selectArea(target, sel.active);
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const { x, y } = local(e);
    const edge = edgeAt(x, y);
    if (edge) {
      run(() => wb.transact("AutoFit", () => (edge.kind === "col" ? wb.setColWidth(sheet, [edge.index], fitWidth(canvas.current!, wb, sheet, edge.index, zoom)) : wb.setRowHeight(sheet, [edge.index], fitHeight(canvas.current!, wb, sheet, edge.index, zoom, (c) => sheet.colWidths.get(c) ?? DEFAULT_COL_WIDTH)))));
      return;
    }
    if (nearFillHandle(x, y)) {
      // double-click the fill handle: fill down as far as the column beside has data
      const a = sel.ranges[0]!;
      const side = a.c1 > 0 ? a.c1 - 1 : a.c2 + 1;
      let last = a.r2;
      while (last + 1 < MAX_ROWS && wb.value(sheet, last + 1, side) !== null) last++;
      if (last > a.r2) run(() => autofill(wb, sheet, a, { ...a, r2: last }));
      return;
    }
    const h = hit(state.current.layout, x, y, scroll.current.x, scroll.current.y);
    if (h.inHeaderCol || h.inHeaderRow) return;
    startEdit(wb.editText(sheet, sel.active.row, sel.active.col), "edit");
  };

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const { x, y } = local(e);
    const h = hit(state.current.layout, x, y, scroll.current.x, scroll.current.y);
    const inside = sel.ranges.some((a) => h.row >= a.r1 && h.row <= a.r2 && h.col >= a.c1 && h.col <= a.c2);
    if (h.inHeaderRow && !h.inHeaderCol) {
      if (!sel.ranges.some((a) => fullCols(a) && h.col >= a.c1 && h.col <= a.c2)) selectArea({ r1: 0, c1: h.col, r2: MAX_ROWS - 1, c2: h.col });
      setMenu({ x: e.clientX, y: e.clientY, kind: "cols" });
    } else if (h.inHeaderCol && !h.inHeaderRow) {
      if (!sel.ranges.some((a) => fullRows(a) && h.row >= a.r1 && h.row <= a.r2)) selectArea({ r1: h.row, c1: 0, r2: h.row, c2: MAX_COLS - 1 });
      setMenu({ x: e.clientX, y: e.clientY, kind: "rows" });
    } else {
      if (!inside) select(h.row, h.col);
      setMenu({ x: e.clientX, y: e.clientY, kind: "cells" });
    }
  };

  // ------------------------------------------------------------------------ name box
  const goTo = (text: string) => {
    const t = text.trim();
    if (!t) return;
    const bang = t.lastIndexOf("!");
    let target = sheet;
    let address = t;
    if (bang > 0) {
      const name = t.slice(0, bang).replace(/^'|'$/g, "");
      const other = wb.sheetByName(name);
      if (!other) {
        notify(`There is no sheet named “${name}”.`, "error");
        return;
      }
      target = other;
      address = t.slice(bang + 1);
    }
    const area = parseArea(address);
    if (area) {
      if (target.uid !== sheet.uid) switchSheet(target.uid);
      requestAnimationFrame(() => selectArea(area));
      focusGrid();
      return;
    }
    const named = wb.names.get(address.toUpperCase());
    if (named) {
      const tokens = tokenize(named.formula);
      const ref = tokens.find((x) => x.type === "ref")?.ref;
      if (ref) {
        const s = ref.sheet ? wb.sheetByName(ref.sheet) : sheet;
        if (s && s.uid !== sheet.uid) switchSheet(s.uid);
        requestAnimationFrame(() => selectArea(normal(ref)));
        focusGrid();
        return;
      }
    }
    // a new name for the selection
    if (/^[A-Za-z_][\w.]*$/.test(address)) {
      const a = sel.ranges[sel.ranges.length - 1]!;
      run(() => wb.transact("Define name", () => wb.defineName(address, refText({ sheet: sheet.name, kind: a.r1 === a.r2 && a.c1 === a.c2 ? "cell" : "area", r1: a.r1, c1: a.c1, r2: a.r2, c2: a.c2, ar1: true, ac1: true, ar2: true, ac2: true }))));
      notify(`${address} now names ${describeArea(a)}.`, "ok");
      focusGrid();
      return;
    }
    notify(`“${t}” is not a cell address or a name.`, "error");
  };

  // ------------------------------------------------------------------------ rendering
  const active = sel.active;
  const activeMerge = mergeAt(active.row, active.col);
  const editRect = edit ? cellRect(layout, edit.row, edit.col, scroll.current.x, scroll.current.y, activeMerge && edit.row === activeMerge.r1 && edit.col === activeMerge.c1 ? activeMerge.r2 - activeMerge.r1 + 1 : 1, activeMerge && edit.row === activeMerge.r1 && edit.col === activeMerge.c1 ? activeMerge.c2 - activeMerge.c1 + 1 : 1) : cellRect(layout, active.row, active.col, scroll.current.x, scroll.current.y);
  const editStyle = wb.style(sheet.cells.get(key(edit?.row ?? active.row, edit?.col ?? active.col))?.s);
  const barText = edit ? edit.text : wb.editText(sheet, active.row, active.col);
  const status = !edit ? statusOf(wb, sheet, sel) : null;
  const lastArea = sel.ranges[sel.ranges.length - 1]!;
  const dragging = drag.current?.kind === "select" && (lastArea.r1 !== lastArea.r2 || lastArea.c1 !== lastArea.c2);
  const nameText = nameBox ?? (dragging ? `${lastArea.r2 - lastArea.r1 + 1}R × ${lastArea.c2 - lastArea.c1 + 1}C` : [...wb.names.values()].find((n) => {
    const r = tokenize(n.formula).find((t) => t.type === "ref")?.ref;
    return r && normal(r).r1 === lastArea.r1 && normal(r).c1 === lastArea.c1 && normal(r).r2 === lastArea.r2 && normal(r).c2 === lastArea.c2 && (r.sheet ?? sheet.name).toLowerCase() === sheet.name.toLowerCase();
  })?.name ?? (fullCols(lastArea) && fullRows(lastArea) ? "All" : cellName(active.row, active.col)));
  const visibleSheets = wb.sheets.filter((s) => !s.hidden);

  // colored references in the editor, as Excel shows them
  const mirror = useMemo(() => {
    if (!edit || !edit.text.startsWith("=")) return null;
    const pieces: ReactNode[] = ["="];
    let i = 0;
    const colors = new Map<string, string>();
    for (const t of tokenize(edit.text.slice(1))) {
      if (t.type === "ref" && (t.ref!.sheet === null || t.ref!.sheet.toLowerCase() === sheet.name.toLowerCase())) {
        const id = t.text.replace(/\$/g, "").toUpperCase();
        let color = colors.get(id);
        if (!color) {
          color = REF_COLORS[colors.size % REF_COLORS.length]!;
          colors.set(id, color);
        }
        pieces.push(<span key={i++} style={{ color }}>{t.text}</span>);
      } else if (t.type === "func") pieces.push(<span key={i++} className="sh-f-func">{t.text}</span>);
      else if (t.type === "str") pieces.push(<span key={i++} className="sh-f-str">{t.text}</span>);
      else pieces.push(t.text);
    }
    return pieces;
  }, [edit, sheet.name]);

  const editorStyle: React.CSSProperties = edit
    ? {
        left: Math.max(HEADER_W, editRect.x),
        top: Math.max(HEADER_H, editRect.y),
        minWidth: editRect.w + 1,
        minHeight: editRect.h + 1,
        maxWidth: Math.max(editRect.w + 1, size.w - editRect.x - 16),
        font: `${editStyle.italic ? "italic " : ""}${editStyle.bold ? "600 " : ""}${((editStyle.size ?? 11) * (13 / 11) * zoom).toFixed(1)}px ${editStyle.font ? `"${editStyle.font}", ` : ""}-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif`,
        textAlign: editStyle.h === "center" ? "center" : editStyle.h === "right" ? "right" : "left",
        background: editStyle.fill ?? undefined,
        color: editStyle.color ?? undefined,
      }
    : { left: Math.max(HEADER_W, editRect.x), top: Math.max(HEADER_H, editRect.y) };

  const lines = edit ? edit.text.split("\n") : [];
  const editorRows = Math.max(1, lines.length);

  return (
    <div className="sheet-app">
      {!headless && (title || extra || onSaveDataset) && (
        <div className="sheet-head">
          {title}
          <FileMenu
            onImport={() => fileInput.current?.click()}
            onXlsx={() => void download("xlsx")}
            onCsv={() => void download("csv")}
            onPrint={print}
          />
          <input ref={fileInput} type="file" hidden accept=".xlsx,.xlsm,.csv,.tsv,.txt" onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void importFile(f);
          }} />
          <span className="spacer" />
          {onSaveDataset && (
            <button className="small" onClick={() => {
              const area = sel.ranges.length === 1 && (lastArea.r1 !== lastArea.r2 || lastArea.c1 !== lastArea.c2) ? lastArea : currentRegion(wb, sheet, active.row, active.col);
              onSaveDataset(sheet, area);
            }} title="Save the selected table (or the data around the selected cell) as a dataset to train on">
              <Icon name="download" size={12} /> Save as dataset
            </button>
          )}
          {extra}
        </div>
      )}
      {!headless && <Toolbar
        onData={setData}
        onFilter={() => run(() => toggleFilter(wb, sheet, sheet.filter ? sheet.filter.area : region(wb, sheet, active.row, active.col)))}
        onFlashFill={() => {
          const n = flashFill(wb, sheet, active.row, active.col);
          notify(n ? `Flash Fill filled ${n} ${n === 1 ? "cell" : "cells"}.` : "Flash Fill found no pattern. Type one or two examples in the column first, next to the data.", n ? "ok" : "info");
        }}
        onCircle={() => {
          if (invalid) return setInvalid(null);
          const bad = invalidCells(wb, sheet);
          setInvalid(bad);
          notify(bad.length ? `${bad.length} ${bad.length === 1 ? "cell breaks" : "cells break"} their rules (circled).` : "Every value meets its rule.", bad.length ? "info" : "ok");
        }}
        wb={wb}
        sheet={sheet}
        sel={sel}
        onDialog={setDialog}
        showFormulas={showFormulas}
        setShowFormulas={setShowFormulas}
        zoom={zoom}
        setZoom={setZoom}
        onAutoSum={(fn) => {
          const target = autoSum(wb, sheet, sel, fn);
          if (target) startEdit(target.formula, "enter");
        }}
        onSort={(desc) => run(() => sortArea(wb, sheet, sel, desc))}
        run={run}
        onPaste={(mode) => void pasteFromMenu(mode)}
        onCopy={(cut) => copy(cut)}
      />}
      <div className="sheet-bar">
        <input
          className="sheet-namebox"
          value={nameText}
          onChange={(e) => setNameBox(e.target.value)}
          onFocus={(e) => {
            setNameBox(nameText);
            requestAnimationFrame(() => e.target.select());
          }}
          onBlur={() => setNameBox(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              goTo(e.currentTarget.value);
              setNameBox(null);
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              setNameBox(null);
              focusGrid();
            }
          }}
          aria-label="Name box: the selected cell, or type an address or a name to go there"
          spellCheck={false}
        />
        <button className="ghost icon-only small sheet-fx" title="Insert a function" aria-label="Insert a function" onClick={() => setDialog({ kind: "function" })}>
          <span className="sheet-fx-mark">fx</span>
        </button>
        <div className="sheet-formula">
          <textarea
            ref={bar}
            className="sheet-formula-input"
            value={barText}
            rows={1}
            spellCheck={false}
            aria-label="Formula bar"
            onFocus={() => {
              if (!edit) {
                const text = wb.editText(sheet, active.row, active.col);
                setEdit({ row: active.row, col: active.col, text, mode: "edit", from: "bar", point: null, caret: text.length });
              } else if (edit.from !== "bar") setEdit({ ...edit, from: "bar", mode: "edit" });
            }}
            onChange={(e) => edit && setEdit({ ...edit, text: e.target.value, caret: e.target.selectionStart, point: null, from: "bar" })}
            onSelect={(e) => edit && edit.caret !== e.currentTarget.selectionStart && setEdit({ ...edit, caret: e.currentTarget.selectionStart })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.altKey) {
                e.preventDefault();
                if (suggestions.length && ac.touched) accept(ac.index);
                else commit({ dr: e.shiftKey ? -1 : 1, dc: 0 }, e.ctrlKey || e.metaKey);
              } else if (e.key === "Tab") {
                e.preventDefault();
                if (suggestions.length) accept(ac.index);
                else commit({ dr: 0, dc: e.shiftKey ? -1 : 1 });
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              } else if (e.key === "F4" && edit) {
                e.preventDefault();
                const t = e.currentTarget;
                const next = toggleAbsolute(edit.text, t.selectionStart);
                setEdit({ ...edit, text: next.text, caret: next.caret });
                requestAnimationFrame(() => t.setSelectionRange(next.caret, next.caret));
              } else if (suggestions.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                setAc((a) => ({ index: (a.index + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length, touched: true }));
              }
            }}
          />
          {edit?.from === "bar" && (suggestions.length > 0 || hint) && (
            <Suggest suggestions={suggestions} index={ac.index} hint={hint} onPick={accept} style={{ left: 8, top: "100%" }} />
          )}
        </div>
      </div>

      <div className="sheet-body">
      <div className="sheet-grid" ref={wrap}>
        <canvas ref={canvas} className="sheet-canvas" />
        <div
          ref={scroller}
          className="sheet-scroller"
          onScroll={onScroll}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          onWheel={(e) => {
            if (e.ctrlKey) {
              e.preventDefault();
              setZoom((z) => Math.max(0.5, Math.min(2, Math.round((z - Math.sign(e.deltaY) * 0.1) * 10) / 10)));
            }
          }}
        >
          <div style={{ width: HEADER_W + layout.cols.total() + 40, height: HEADER_H + layout.rows.total() + 40 }} />
        </div>
        <div className={`sheet-editor ${edit && (edit.text !== "" || edit.mode === "edit") ? "open" : ""}`} style={editorStyle}>
          {mirror && edit?.from === "cell" && <div className="sheet-editor-mirror" aria-hidden="true">{mirror}{"​"}</div>}
          <textarea
            ref={input}
            className={`sheet-editor-input ${mirror && edit?.from === "cell" ? "mirrored" : ""}`}
            value={edit && edit.from === "cell" ? edit.text : edit ? edit.text : ""}
            rows={editorRows}
            spellCheck={false}
            autoFocus
            aria-label={`Cell ${cellName(active.row, active.col)}${edit ? ", editing" : ""}`}
            onChange={(e) => {
              if (!edit) return;
              setEdit({ ...edit, text: e.target.value, caret: e.target.selectionStart, point: null, from: "cell" });
              setAc({ index: 0, touched: false });
            }}
            onInput={onGridInput}
            onSelect={(e) => edit && edit.caret !== e.currentTarget.selectionStart && setEdit({ ...edit, caret: e.currentTarget.selectionStart })}
            onKeyDown={onGridKey}
            onCopy={(e) => !edit && copy(false, e)}
            onCut={(e) => !edit && copy(true, e)}
            onPaste={(e) => {
              if (edit) return;
              e.preventDefault();
              pasteData(e.clipboardData.getData("text/plain"), e.clipboardData.getData("text/html"));
            }}
            onCompositionStart={() => {
              if (!edit) startEdit("", "enter");
            }}
          />
          {edit?.from === "cell" && (suggestions.length > 0 || hint) && <Suggest suggestions={suggestions} index={ac.index} hint={hint} onPick={accept} style={{ left: 0, top: "100%" }} />}
        </div>
        {(() => {
          const cell = !edit ? sheet.cells.get(key(active.row, active.col)) : undefined;
          if (!cell?.note) return null;
          const box = cellRect(layout, active.row, active.col, scroll.current.x, scroll.current.y);
          return (
            <div className="sheet-note" style={{ left: box.x + box.w + 6, top: box.y }}>
              {cell.note}
            </div>
          );
        })()}
        {(() => {
          const v = !edit ? validationAt(sheet, active.row, active.col) : undefined;
          if (!v?.prompt) return null;
          const box = cellRect(layout, active.row, active.col, scroll.current.x, scroll.current.y);
          return <div className="sheet-note prompt" style={{ left: box.x + 8, top: box.y + box.h + 6 }}>{v.prompt}</div>;
        })()}
        <ChartLayer wb={wb} sheet={sheet} scrollX={scroll.current.x} scrollY={scroll.current.y} offsetX={HEADER_W} offsetY={HEADER_H} selected={chartSelected} onSelect={(id) => { setChartSelected(id); focusGrid(); }} onEdit={(c) => setData({ kind: "chart", chart: c })} />
      </div>
      {(() => {
        const p = pivotAt(sheet, active.row, active.col);
        if (!p || panelClosed === p.id) return null;
        return <PivotPanel wb={wb} sheet={sheet} pivot={p} onClose={() => setPanelClosed(p.id)} run={run} />;
      })()}
      </div>

      <div className="sheet-foot">
        <div className="sheet-tabs" role="tablist" aria-label="Sheets">
          <button
            className="ghost icon-only small"
            title="New sheet (Shift+F11)"
            aria-label="New sheet"
            onClick={() => run(() => {
              const made = wb.transact("New sheet", () => wb.addSheet());
              switchSheet(made.uid);
            })}
          >
            <Icon name="plus" size={13} />
          </button>
          {visibleSheets.map((s, i) => (
            <div
              key={s.uid}
              role="tab"
              aria-selected={s.uid === sheet.uid}
              className={`sheet-tab ${s.uid === sheet.uid ? "active" : ""}`}
              style={s.tabColor ? { boxShadow: `inset 0 -3px 0 ${s.tabColor}` } : undefined}
              draggable={renaming !== s.uid}
              onDragStart={(e) => e.dataTransfer.setData("text/x-sheet", String(s.uid))}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                const uid = Number(e.dataTransfer.getData("text/x-sheet"));
                const moving = wb.sheet(uid);
                if (moving && moving !== s) run(() => wb.transact("Move sheet", () => wb.moveSheet(moving, wb.sheets.indexOf(s))));
              }}
              onClick={() => {
                if (edit && (edit.point || canPoint(edit.text, edit.caret))) return;
                if (edit) commit(null);
                switchSheet(s.uid);
              }}
              onDoubleClick={() => setRenaming(s.uid)}
              onContextMenu={(e) => {
                e.preventDefault();
                switchSheet(s.uid);
                setMenu({ x: e.clientX, y: e.clientY, kind: "tab", sheet: s.uid });
              }}
              title={i < 9 ? `${s.name} (Ctrl+PageDown and Ctrl+PageUp switch sheets)` : s.name}
            >
              {renaming === s.uid ? (
                <input
                  className="sheet-tab-rename"
                  defaultValue={s.name}
                  autoFocus
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => {
                    const next = e.target.value;
                    setRenaming(null);
                    if (next !== s.name) run(() => wb.transact("Rename sheet", () => wb.renameSheet(s, next)));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") {
                      e.currentTarget.value = s.name;
                      e.currentTarget.blur();
                    }
                  }}
                />
              ) : (
                s.name
              )}
            </div>
          ))}
        </div>
        <div className="sheet-status" aria-live="polite">
          {wb.circular.length > 0 && (
            <button className="ghost small sheet-circular" onClick={() => {
              const c = wb.circular[0]!;
              if (c.sheet !== sheet.uid) switchSheet(c.sheet);
              requestAnimationFrame(() => select(c.row, c.col));
            }}>
              <Icon name="warning" size={12} /> Circular reference: {wb.sheet(wb.circular[0]!.sheet)?.uid !== sheet.uid ? `${wb.sheet(wb.circular[0]!.sheet)?.name}!` : ""}{cellName(wb.circular[0]!.row, wb.circular[0]!.col)}
            </button>
          )}
          {status && status.numbers > 0 && (
            <>
              <span>Average <b>{formatValue(status.sum / status.numbers, wb.style(sheet.cells.get(key(active.row, active.col))?.s).format ?? "General").text}</b></span>
              <span>Count <b>{status.count.toLocaleString()}</b></span>
              <span>Sum <b>{formatValue(status.sum, wb.style(sheet.cells.get(key(active.row, active.col))?.s).format ?? "General").text}</b></span>
            </>
          )}
          {status && status.numbers === 0 && status.count > 0 && <span>Count <b>{status.count.toLocaleString()}</b></span>}
          <span className="sheet-zoom">
            <button className="ghost icon-only small" onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))} aria-label="Zoom out">
              <Icon name="minus" size={11} />
            </button>
            <button className="ghost small" onClick={() => setZoom(1)} title="Back to 100%">{Math.round(zoom * 100)}%</button>
            <button className="ghost icon-only small" onClick={() => setZoom((z) => Math.min(2, Math.round((z + 0.1) * 10) / 10))} aria-label="Zoom in">
              <Icon name="plus" size={11} />
            </button>
          </span>
        </div>
      </div>

      {menu && (
        <ContextMenu
          menu={menu}
          wb={wb}
          sheet={sheet}
          sel={sel}
          onClose={() => {
            setMenu(null);
            focusGrid();
          }}
          onDialog={setDialog}
          onCopy={(cut) => copy(cut)}
          onPaste={(mode) => void pasteFromMenu(mode)}
          onRename={(uid) => setRenaming(uid)}
          onSwitch={switchSheet}
          run={run}
        />
      )}
      {filterMenu && sheet.filter && <FilterMenu wb={wb} sheet={sheet} col={filterMenu.col} x={filterMenu.x} y={filterMenu.y} onClose={() => { setFilterMenu(null); focusGrid(); }} run={run} />}
      {listMenu && (
        <ListMenu
          items={listMenu.items}
          x={listMenu.x}
          y={listMenu.y}
          onClose={() => { setListMenu(null); focusGrid(); }}
          onPick={(v) => {
            run(() => wb.transact(`Edit ${cellName(listMenu.row, listMenu.col)}`, () => wb.setInput(sheet, listMenu.row, listMenu.col, v)));
            setListMenu(null);
            focusGrid();
          }}
        />
      )}
      {data && (
        <DataDialogs
          dialog={data}
          wb={wb}
          sheet={sheet}
          sel={sel}
          onClose={() => { setData(null); focusGrid(); }}
          run={run}
          notify={notify}
          onSwitch={switchSheet}
          onPivot={(target: Sheet, p: PivotDef) => {
            setPanelClosed(null);
            requestAnimationFrame(() => {
              if (target.uid === sheet.uid) select(p.row, p.col);
              else selections.current.set(target.uid, single(p.row, p.col));
            });
          }}
          onPaste={(mode, skip) => {
            const memory = clipboardMemory.get();
            const area = sel.ranges[sel.ranges.length - 1]!;
            if (!memory) return notify("Copy some cells first (Ctrl+C).", "error");
            run(() => {
              const pasted = paste(wb, sheet, area, memory, mode, skip);
              selectArea(pasted);
            });
          }}
        />
      )}
      {dialog && (
        <Dialogs
          dialog={dialog}
          wb={wb}
          sheet={sheet}
          sel={sel}
          onClose={() => {
            setDialog(null);
            focusGrid();
          }}
          onFound={(at) => {
            if (at.sheet !== sheet.uid) switchSheet(at.sheet);
            requestAnimationFrame(() => {
              select(at.row, at.col);
              setFound({ row: at.row, col: at.col });
            });
          }}
          onGoTo={goTo}
          onInsertFunction={(name) => {
            const text = `=${name}(`;
            setDialog(null);
            startEdit(edit ? edit.text + name + "(" : text, "edit", edit?.from ?? "cell");
          }}
          run={run}
        />
      )}
    </div>
  );
});

function Suggest({ suggestions, index, hint, onPick, style }: { suggestions: { name: string; isName: boolean }[]; index: number; hint: { name: string; arg: number } | null; onPick: (i: number) => void; style: React.CSSProperties }) {
  const help = hint ? helpFor(hint.name) : null;
  const args = help?.args.split(", ") ?? [];
  return (
    <div className="sheet-suggest" style={style} onPointerDown={(e) => e.preventDefault()}>
      {suggestions.length > 0 ? (
        <ul role="listbox" aria-label="Functions">
          {suggestions.map((s, i) => {
            const h = helpFor(s.name);
            return (
              <li key={s.name} role="option" aria-selected={i === index} className={i === index ? "active" : ""} onClick={() => onPick(i)}>
                <b className="mono">{s.name}</b>
                <span className="faint small">{s.isName ? "Name" : h.about}</span>
              </li>
            );
          })}
          <li className="sheet-suggest-tip faint tiny">Tab to choose</li>
        </ul>
      ) : help ? (
        <div className="sheet-hint mono">
          {help.name}(
          {args.map((a, i) => (
            <span key={i}>
              {i ? ", " : ""}
              {i === Math.min(hint!.arg, args.length - 1) || (a.includes("…") && hint!.arg >= i) ? <b>{a}</b> : a}
            </span>
          ))}
          )
          {help.about && <div className="sheet-hint-about">{help.about}</div>}
        </div>
      ) : null}
    </div>
  );
}

export { colName };
