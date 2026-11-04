// Dialogs (Format Cells, Find and Replace, Go To, Insert Function, Names, notes, sizes) and the
// right-click menus of the spreadsheet.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cellName, key, keyCol, keyRow, MAX_COLS, MAX_ROWS } from "../engine/address";
import type { PasteMode } from "../engine/fill";
import { BUILTIN_FORMATS, formatValue } from "../engine/format";
import { FUNCTIONS } from "../engine/functions";
import { HELP, helpFor } from "../engine/help";
import { DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT, type Sheet, type Style, type Workbook } from "../engine/workbook";
import { Modal } from "../../components/ui";
import { applyBorders, applyStyle, shiftSelection, sortArea, usedAreas } from "./commands";
import { PALETTE } from "./Toolbar";
import type { Selection } from "./render";

export type DialogState =
  | { kind: "format"; tab?: "number" | "alignment" | "font" | "border" | "fill" }
  | { kind: "find"; replace: boolean }
  | { kind: "goto" }
  | { kind: "function" }
  | { kind: "shift"; insert: boolean }
  | { kind: "link" }
  | { kind: "note" }
  | { kind: "size"; axis: "rows" | "cols" }
  | { kind: "names" };

export type MenuState = { x: number; y: number; kind: "cells" | "rows" | "cols" | "tab"; sheet?: number };

// ------------------------------------------------------------------------------ context menus

export function ContextMenu({ menu, wb, sheet, sel, onClose, onDialog, onCopy, onPaste, onRename, onSwitch, run }: {
  menu: MenuState;
  wb: Workbook;
  sheet: Sheet;
  sel: Selection;
  onClose: () => void;
  onDialog: (d: DialogState) => void;
  onCopy: (cut: boolean) => void;
  onPaste: (mode: PasteMode) => void;
  onRename: (uid: number) => void;
  onSwitch: (uid: number) => void;
  run: (fn: () => void) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  useEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (box) setPos({ x: Math.min(menu.x, window.innerWidth - box.width - 8), y: Math.min(menu.y, window.innerHeight - box.height - 8) });
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [menu, onClose]);
  const act = (fn: () => void) => () => {
    run(fn);
    onClose();
  };
  const area = sel.ranges[sel.ranges.length - 1]!;
  const cell = sheet.cells.get(key(sel.active.row, sel.active.col));
  const hide = (axis: "rows" | "cols", on: boolean) => () =>
    wb.transact(on ? "Hide" : "Unhide", () => {
      const next = new Set(axis === "rows" ? sheet.hiddenRows : sheet.hiddenCols);
      for (const a of sel.ranges) {
        const [lo, hi] = axis === "rows" ? [a.r1, Math.min(a.r2, a.r1 + 100_000)] : [a.c1, a.c2];
        for (let i = lo; i <= hi; i++) on ? next.add(i) : next.delete(i);
        // unhiding from a selection around hidden ones also opens the hidden neighbours
        if (!on) for (let i = Math.max(0, lo - 1); i <= hi + 1; i++) next.delete(i);
      }
      wb.setSheetProp(sheet, axis === "rows" ? "hiddenRows" : "hiddenCols", next);
    });
  const target = menu.sheet !== undefined ? wb.sheet(menu.sheet) : undefined;
  const items: ([string, () => void, boolean?] | "-")[] =
    menu.kind === "tab" && target
      ? [
          ["Rename", () => onRename(target.uid)],
          ["Duplicate", () => onSwitch(wb.transact("Duplicate sheet", () => wb.duplicateSheet(target)).uid)],
          ["Delete", () => {
            if (window.confirm(`Delete the sheet “${target.name}”? Formulas that use it show #REF!. You can undo this.`)) {
              const i = wb.sheets.indexOf(target);
              wb.transact("Delete sheet", () => wb.deleteSheet(target));
              const next = wb.sheets.filter((s) => !s.hidden)[Math.max(0, i - 1)];
              if (next) onSwitch(next.uid);
            }
          }],
          "-",
          ["Move left", () => wb.transact("Move sheet", () => wb.moveSheet(target, Math.max(0, wb.sheets.indexOf(target) - 1))), wb.sheets.indexOf(target) === 0],
          ["Move right", () => wb.transact("Move sheet", () => wb.moveSheet(target, wb.sheets.indexOf(target) + 1)), wb.sheets.indexOf(target) === wb.sheets.length - 1],
          "-",
          ...(["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#0a84ff", "#af52de"].map((c) => [`Tab colour: ${({ "#ff3b30": "red", "#ff9500": "orange", "#ffcc00": "yellow", "#34c759": "green", "#0a84ff": "blue", "#af52de": "purple" } as Record<string, string>)[c]}`, () => wb.transact("Tab colour", () => wb.setSheetProp(target, "tabColor", c))] as [string, () => void])),
          ["No tab colour", () => wb.transact("Tab colour", () => wb.setSheetProp(target, "tabColor", undefined)), !target.tabColor],
          "-",
          ["Hide sheet", () => {
            wb.transact("Hide sheet", () => wb.setSheetProp(target, "hidden", true));
            const next = wb.sheets.find((s) => !s.hidden);
            if (next) onSwitch(next.uid);
          }, wb.sheets.filter((s) => !s.hidden).length <= 1],
          ...wb.sheets.filter((s) => s.hidden).map((s) => [`Unhide “${s.name}”`, () => wb.transact("Unhide sheet", () => wb.setSheetProp(s, "hidden", false))] as [string, () => void]),
        ]
      : [
          ["Cut", () => onCopy(true)],
          ["Copy", () => onCopy(false)],
          ["Paste", () => onPaste("all")],
          ["Paste values", () => onPaste("values")],
          ["Paste transposed", () => onPaste("transpose")],
          "-",
          ...(menu.kind === "rows"
            ? ([
                ["Insert rows above", () => shiftSelection(wb, sheet, sel, "rows", true)],
                ["Insert rows below", () => wb.transact("Insert rows", () => wb.shift(sheet, "rows", area.r2 + 1, area.r2 - area.r1 + 1))],
                ["Delete rows", () => shiftSelection(wb, sheet, sel, "rows", false)],
                ["Hide rows", hide("rows", true)],
                ["Unhide rows", hide("rows", false)],
                ["Row height…", () => onDialog({ kind: "size", axis: "rows" })],
              ] as [string, () => void][])
            : menu.kind === "cols"
              ? ([
                  ["Insert columns left", () => shiftSelection(wb, sheet, sel, "cols", true)],
                  ["Insert columns right", () => wb.transact("Insert columns", () => wb.shift(sheet, "cols", area.c2 + 1, area.c2 - area.c1 + 1))],
                  ["Delete columns", () => shiftSelection(wb, sheet, sel, "cols", false)],
                  ["Hide columns", hide("cols", true)],
                  ["Unhide columns", hide("cols", false)],
                  ["Column width…", () => onDialog({ kind: "size", axis: "cols" })],
                  ["Sort A to Z", () => sortArea(wb, sheet, sel, false, area.c1)],
                  ["Sort Z to A", () => sortArea(wb, sheet, sel, true, area.c1)],
                ] as [string, () => void][])
              : ([
                  ["Insert…", () => onDialog({ kind: "shift", insert: true })],
                  ["Delete…", () => onDialog({ kind: "shift", insert: false })],
                  ["Sort A to Z", () => sortArea(wb, sheet, sel, false)],
                  ["Sort Z to A", () => sortArea(wb, sheet, sel, true)],
                ] as [string, () => void][])),
          ["Clear contents", () => wb.transact("Clear", () => sel.ranges.forEach((r) => wb.clear(sheet, r, "contents")))],
          "-",
          [cell?.note ? "Edit note…" : "Insert note…", () => onDialog({ kind: "note" })],
          ...(cell?.note ? [["Delete note", () => wb.transact("Delete note", () => wb.setNote(sheet, sel.active.row, sel.active.col, null))] as [string, () => void]] : []),
          ["Link…", () => onDialog({ kind: "link" })],
          ["Define name…", () => onDialog({ kind: "names" })],
          ["Format cells…", () => onDialog({ kind: "format" })],
        ];
  return createPortal(
    <div ref={ref} className="sheet-context" style={{ left: pos.x, top: pos.y }} role="menu">
      {items.map((item, i) =>
        item === "-" ? (
          <div key={i} className="sheet-pop-sep" />
        ) : (
          <button key={i} role="menuitem" disabled={item[2]} onClick={act(item[1])}>
            {item[0]}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------------------- dialogs

export function Dialogs({ dialog, wb, sheet, sel, onClose, onFound, onGoTo, onInsertFunction, run }: {
  dialog: DialogState;
  wb: Workbook;
  sheet: Sheet;
  sel: Selection;
  onClose: () => void;
  onFound: (at: { sheet: number; row: number; col: number }) => void;
  onGoTo: (text: string) => void;
  onInsertFunction: (name: string) => void;
  run: (fn: () => void) => void;
}) {
  switch (dialog.kind) {
    case "format":
      return <FormatCells wb={wb} sheet={sheet} sel={sel} onClose={onClose} run={run} tab={dialog.tab} />;
    case "find":
      return <FindReplace wb={wb} sheet={sheet} sel={sel} replace={dialog.replace} onClose={onClose} onFound={onFound} run={run} />;
    case "goto":
      return <GoTo wb={wb} onClose={onClose} onGoTo={onGoTo} />;
    case "function":
      return <InsertFunction onClose={onClose} onPick={onInsertFunction} />;
    case "shift":
      return <ShiftCells wb={wb} sheet={sheet} sel={sel} insert={dialog.insert} onClose={onClose} run={run} />;
    case "note":
      return <NoteDialog wb={wb} sheet={sheet} sel={sel} onClose={onClose} run={run} />;
    case "link":
      return <LinkDialog wb={wb} sheet={sheet} sel={sel} onClose={onClose} run={run} />;
    case "size":
      return <SizeDialog wb={wb} sheet={sheet} sel={sel} axis={dialog.axis} onClose={onClose} run={run} />;
    case "names":
      return <NamesDialog wb={wb} sheet={sheet} sel={sel} onClose={onClose} run={run} />;
  }
}

function FormatCells({ wb, sheet, sel, onClose, run, tab: initial }: { wb: Workbook; sheet: Sheet; sel: Selection; onClose: () => void; run: (fn: () => void) => void; tab?: string }) {
  const cell = sheet.cells.get(key(sel.active.row, sel.active.col));
  const start = wb.style(cell?.s);
  const [tab, setTab] = useState(initial ?? "number");
  const [style, setStyle] = useState<Style>(start);
  const [border, setBorder] = useState<string | null>(null);
  const value = wb.value(sheet, sel.active.row, sel.active.col);
  const sample = typeof value === "number" ? value : typeof value === "string" ? value : 1234.5678;
  const preview = formatValue(sample, style.format ?? "General");
  const codes = [...new Set([...BUILTIN_FORMATS.map((f) => f.code), "0", "0.00", "#,##0", "#,##0.00", "#,##0;[Red]-#,##0", "0%", "0.0%", "0.00E+00", "# ??/??", "m/d/yy", "d-mmm-yy", "mmm-yy", "mmmm d, yyyy", "yyyy-mm-dd", "h:mm", "h:mm:ss", "[h]:mm:ss", "mm:ss.0", "m/d/yyyy h:mm", '"€"#,##0.00', '"£"#,##0.00', '"₹"#,##0.00', "@"])];
  const apply = () => {
    run(() => {
      wb.transact("Format cells", () => {
        const { top: _t, bottom: _b, left: _l, right: _r, ...rest } = style;
        void _t; void _b; void _l; void _r;
        applyStyle(wb, sheet, sel, (s) => ({ ...s, ...rest, format: rest.format }));
        if (border) applyBorders(wb, sheet, sel, border as never, style.top?.color);
      });
    });
    onClose();
  };
  return (
    <Modal
      title="Format cells"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={apply}>OK</button>
        </>
      }
    >
      <div className="segmented sheet-format-tabs" role="tablist">
        {["number", "alignment", "font", "border", "fill"].map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === "number" && (
        <div className="sheet-format-number">
          <div className="field">
            <label htmlFor="fmt-code">Format code</label>
            <input id="fmt-code" className="mono" value={style.format ?? "General"} onChange={(e) => setStyle({ ...style, format: e.target.value })} />
            <span className="help">
              0 is a digit, # a digit when needed, , groups thousands, % multiplies by 100. Dates: d, m, yyyy, h, mm, ss. Sections: positive;negative;zero;text.
            </span>
          </div>
          <div className="sheet-format-preview">
            <span className="faint small">Sample</span>
            <b style={{ color: preview.color }}>{preview.text || " "}</b>
          </div>
          <ul className="sheet-format-list">
            {codes.map((c) => (
              <li key={c}>
                <button className={c === (style.format ?? "General") ? "active" : ""} onClick={() => setStyle({ ...style, format: c })}>
                  <span className="mono">{c}</span>
                  <span className="faint">{formatValue(typeof sample === "number" ? sample : 1234.5678, c).text}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {tab === "alignment" && (
        <div className="sheet-format-grid">
          <div className="field">
            <label>Horizontal</label>
            <select value={style.h ?? ""} onChange={(e) => setStyle({ ...style, h: (e.target.value || undefined) as Style["h"] })}>
              <option value="">General</option>
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
              <option value="justify">Justify</option>
            </select>
          </div>
          <div className="field">
            <label>Vertical</label>
            <select value={style.v ?? "bottom"} onChange={(e) => setStyle({ ...style, v: e.target.value === "bottom" ? undefined : (e.target.value as Style["v"]) })}>
              <option value="top">Top</option>
              <option value="middle">Middle</option>
              <option value="bottom">Bottom</option>
            </select>
          </div>
          <div className="field">
            <label>Indent</label>
            <input type="number" min={0} max={15} value={style.indent ?? 0} onChange={(e) => setStyle({ ...style, indent: Number(e.target.value) || undefined })} />
          </div>
          <label className="row small">
            <input type="checkbox" checked={Boolean(style.wrap)} onChange={(e) => setStyle({ ...style, wrap: e.target.checked || undefined })} /> Wrap text
          </label>
        </div>
      )}
      {tab === "font" && (
        <div className="sheet-format-grid">
          <div className="field">
            <label>Font</label>
            <input value={style.font ?? ""} placeholder="System" onChange={(e) => setStyle({ ...style, font: e.target.value || undefined })} />
          </div>
          <div className="field">
            <label>Size</label>
            <input type="number" min={6} max={120} value={style.size ?? 11} onChange={(e) => setStyle({ ...style, size: Number(e.target.value) === 11 ? undefined : Number(e.target.value) })} />
          </div>
          {(["bold", "italic", "underline", "strike"] as const).map((p) => (
            <label key={p} className="row small">
              <input type="checkbox" checked={Boolean(style[p])} onChange={(e) => setStyle({ ...style, [p]: e.target.checked || undefined })} /> {p === "strike" ? "Strikethrough" : p[0]!.toUpperCase() + p.slice(1)}
            </label>
          ))}
          <div className="field">
            <label>Colour</label>
            <ColorRow value={style.color} onPick={(c) => setStyle({ ...style, color: c })} none="Automatic" />
          </div>
        </div>
      )}
      {tab === "border" && (
        <div className="sheet-format-borders">
          {[["all", "All"], ["outer", "Outline"], ["thick-outer", "Thick outline"], ["bottom", "Bottom"], ["bottom-double", "Double bottom"], ["top", "Top"], ["left", "Left"], ["right", "Right"], ["none", "None"]].map(([k, label]) => (
            <button key={k} className={border === k ? "primary" : ""} onClick={() => setBorder(k!)}>{label}</button>
          ))}
          <div className="field">
            <label>Colour</label>
            <ColorRow value={style.top?.color} onPick={(c) => setStyle({ ...style, top: { style: "thin", color: c } })} none="Automatic" />
          </div>
        </div>
      )}
      {tab === "fill" && (
        <div className="field">
          <label>Background</label>
          <ColorRow value={style.fill} onPick={(c) => setStyle({ ...style, fill: c })} none="No fill" />
        </div>
      )}
    </Modal>
  );
}

function ColorRow({ value, onPick, none }: { value?: string; onPick: (c: string | undefined) => void; none: string }) {
  return (
    <div className="sheet-color-row">
      <button className={!value ? "small primary" : "small"} onClick={() => onPick(undefined)}>{none}</button>
      <div className="sheet-palette">
        {PALETTE.map((c) => (
          <button key={c} className={`sheet-swatch ${value === c ? "on" : ""}`} style={{ background: c }} aria-label={c} title={c} onClick={() => onPick(c)} />
        ))}
      </div>
      <input type="color" value={value ?? "#000000"} onChange={(e) => onPick(e.target.value)} aria-label="Custom colour" />
    </div>
  );
}

function FindReplace({ wb, sheet, sel, replace, onClose, onFound, run }: { wb: Workbook; sheet: Sheet; sel: Selection; replace: boolean; onClose: () => void; onFound: (at: { sheet: number; row: number; col: number }) => void; run: (fn: () => void) => void }) {
  const [find, setFind] = useState("");
  const [by, setBy] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [whole, setWhole] = useState(false);
  const [everywhere, setEverywhere] = useState(false);
  const [inFormulas, setInFormulas] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [mode, setMode] = useState(replace);
  const last = useRef<{ sheet: number; row: number; col: number } | null>(null);
  const textOf = (s: Sheet, r: number, c: number) => {
    const cell = s.cells.get(key(r, c));
    if (!cell) return "";
    return inFormulas && cell.f !== undefined ? "=" + cell.f : wb.display(s, r, c).text;
  };
  const matches = (text: string) => {
    if (!find) return false;
    const a = matchCase ? text : text.toLowerCase();
    const b = matchCase ? find : find.toLowerCase();
    return whole ? a === b : a.includes(b);
  };
  const cells = (s: Sheet) => [...s.cells.keys()].sort((x, y) => keyRow(x) - keyRow(y) || keyCol(x) - keyCol(y));
  const next = () => {
    const sheets = everywhere ? [...wb.sheets.slice(wb.sheets.indexOf(sheet)), ...wb.sheets.slice(0, wb.sheets.indexOf(sheet))] : [sheet];
    const from = last.current ?? { sheet: sheet.uid, row: sel.active.row, col: sel.active.col };
    for (let pass = 0; pass < 2; pass++)
      for (const s of sheets)
        for (const k of cells(s)) {
          const r = keyRow(k);
          const c = keyCol(k);
          if (pass === 0 && s.uid === from.sheet && (r < from.row || (r === from.row && c <= from.col))) continue;
          if (matches(textOf(s, r, c))) {
            last.current = { sheet: s.uid, row: r, col: c };
            onFound(last.current);
            setMessage(null);
            return;
          }
        }
    setMessage(`Nothing matches “${find}”.`);
  };
  const replaceAll = () => {
    let count = 0;
    run(() =>
      wb.transact("Replace all", () => {
        for (const s of everywhere ? wb.sheets : [sheet])
          for (const k of cells(s)) {
            const r = keyRow(k);
            const c = keyCol(k);
            const text = textOf(s, r, c);
            if (!matches(text)) continue;
            const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "g" : "gi");
            const nextText = whole ? by : text.replace(re, by);
            wb.setInput(s, r, c, nextText);
            count++;
          }
      }),
    );
    setMessage(count ? `Replaced ${count.toLocaleString()} ${count === 1 ? "cell" : "cells"}.` : `Nothing matches “${find}”.`);
  };
  const replaceOne = () => {
    const at = last.current;
    if (!at) return next();
    const s = wb.sheet(at.sheet)!;
    const text = textOf(s, at.row, at.col);
    if (matches(text)) {
      const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "" : "i");
      run(() => wb.transact("Replace", () => wb.setInput(s, at.row, at.col, whole ? by : text.replace(re, by))));
    }
    next();
  };
  return (
    <Modal
      title={mode ? "Find and replace" : "Find"}
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={() => setMode(!mode)}>{mode ? "Find only" : "Replace…"}</button>
          <span className="spacer" />
          {mode && <button onClick={replaceAll} disabled={!find}>Replace all</button>}
          {mode && <button onClick={replaceOne} disabled={!find}>Replace</button>}
          <button className="primary" onClick={next} disabled={!find}>Find next</button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="find-text">Find</label>
        <input id="find-text" value={find} onChange={(e) => { setFind(e.target.value); last.current = null; }} autoFocus onKeyDown={(e) => e.key === "Enter" && next()} />
      </div>
      {mode && (
        <div className="field">
          <label htmlFor="replace-text">Replace with</label>
          <input id="replace-text" value={by} onChange={(e) => setBy(e.target.value)} />
        </div>
      )}
      <div className="row wrap small" style={{ gap: 16 }}>
        <label className="row"><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case</label>
        <label className="row"><input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} /> Whole cell</label>
        <label className="row"><input type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} /> Every sheet</label>
        <label className="row"><input type="checkbox" checked={inFormulas} onChange={(e) => setInFormulas(e.target.checked)} /> Look in formulas</label>
      </div>
      {message && <p className="dim small" style={{ marginTop: 10 }}>{message}</p>}
    </Modal>
  );
}

function GoTo({ wb, onClose, onGoTo }: { wb: Workbook; onClose: () => void; onGoTo: (t: string) => void }) {
  const [text, setText] = useState("");
  return (
    <Modal
      title="Go to"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!text.trim()} onClick={() => { onGoTo(text); onClose(); }}>Go</button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="goto">Cell, range or name</label>
        <input id="goto" value={text} onChange={(e) => setText(e.target.value)} placeholder="B12, A1:D20, Sheet2!C3, a name" autoFocus onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) { onGoTo(text); onClose(); } }} />
      </div>
      {wb.names.size > 0 && (
        <ul className="sheet-format-list">
          {[...wb.names.values()].map((n) => (
            <li key={n.name}><button onClick={() => { onGoTo(n.name); onClose(); }}><b>{n.name}</b> <span className="faint mono">={n.formula}</span></button></li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function InsertFunction({ onClose, onPick }: { onClose: () => void; onPick: (name: string) => void }) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("All");
  const all = useMemo(() => Object.keys(FUNCTIONS).sort().map((name) => helpFor(name)), []);
  const categories = ["All", ...new Set([...HELP.values()].map((h) => h.category)), "Other"];
  const shown = all.filter((h) => (category === "All" || h.category === category) && (!q || h.name.includes(q.toUpperCase()) || h.about.toLowerCase().includes(q.toLowerCase())));
  const [pick, setPick] = useState<string | null>(null);
  const chosen = pick ? helpFor(pick) : null;
  return (
    <Modal
      title="Insert a function"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="faint small">{Object.keys(FUNCTIONS).length} functions</span>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!pick} onClick={() => pick && onPick(pick)}>Insert</button>
        </>
      }
    >
      <div className="row" style={{ gap: 8 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search, e.g. lookup, average, date" autoFocus style={{ flex: 1 }} aria-label="Search functions" />
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          {categories.map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>
      <ul className="sheet-format-list tall">
        {shown.map((h) => (
          <li key={h.name}>
            <button className={pick === h.name ? "active" : ""} onClick={() => setPick(h.name)} onDoubleClick={() => onPick(h.name)}>
              <b className="mono">{h.name}</b>
              <span className="faint">{h.about}</span>
            </button>
          </li>
        ))}
      </ul>
      {chosen && (
        <p className="small" style={{ marginTop: 10 }}>
          <b className="mono">{chosen.name}({chosen.args})</b>
          <br />
          <span className="dim">{chosen.about}</span>
        </p>
      )}
    </Modal>
  );
}

function ShiftCells({ wb, sheet, sel, insert, onClose, run }: { wb: Workbook; sheet: Sheet; sel: Selection; insert: boolean; onClose: () => void; run: (fn: () => void) => void }) {
  const [what, setWhat] = useState<"rows" | "cols">("rows");
  return (
    <Modal
      title={insert ? "Insert" : "Delete"}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => { run(() => shiftSelection(wb, sheet, sel, what, insert)); onClose(); }}>OK</button>
        </>
      }
    >
      <label className="row"><input type="radio" checked={what === "rows"} onChange={() => setWhat("rows")} /> Entire {insert ? "rows" : "rows"}</label>
      <label className="row"><input type="radio" checked={what === "cols"} onChange={() => setWhat("cols")} /> Entire columns</label>
    </Modal>
  );
}

function NoteDialog({ wb, sheet, sel, onClose, run }: { wb: Workbook; sheet: Sheet; sel: Selection; onClose: () => void; run: (fn: () => void) => void }) {
  const cell = sheet.cells.get(key(sel.active.row, sel.active.col));
  const [text, setText] = useState(cell?.note ?? "");
  return (
    <Modal
      title={`Note on ${cellName(sel.active.row, sel.active.col)}`}
      onClose={onClose}
      footer={
        <>
          {cell?.note && <button className="danger" onClick={() => { run(() => wb.transact("Delete note", () => wb.setNote(sheet, sel.active.row, sel.active.col, null))); onClose(); }}>Delete note</button>}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => { run(() => wb.transact("Note", () => wb.setNote(sheet, sel.active.row, sel.active.col, text.trim() || null))); onClose(); }}>Save</button>
        </>
      }
    >
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} autoFocus style={{ width: "100%" }} aria-label="Note" />
    </Modal>
  );
}

function LinkDialog({ wb, sheet, sel, onClose, run }: { wb: Workbook; sheet: Sheet; sel: Selection; onClose: () => void; run: (fn: () => void) => void }) {
  const { row, col } = sel.active;
  const shown = wb.display(sheet, row, col).text;
  const [url, setUrl] = useState("https://");
  const [label, setLabel] = useState(shown);
  return (
    <Modal
      title="Link"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => {
            const safe = url.replace(/"/g, '""');
            const text = label.replace(/"/g, '""');
            run(() => wb.transact("Link", () => wb.setInput(sheet, row, col, `=HYPERLINK("${safe}","${text || safe}")`)));
            onClose();
          }}>Insert</button>
        </>
      }
    >
      <div className="field"><label htmlFor="link-url">Address</label><input id="link-url" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus /></div>
      <div className="field"><label htmlFor="link-label">Text to show</label><input id="link-label" value={label} onChange={(e) => setLabel(e.target.value)} /></div>
    </Modal>
  );
}

function SizeDialog({ wb, sheet, sel, axis, onClose, run }: { wb: Workbook; sheet: Sheet; sel: Selection; axis: "rows" | "cols"; onClose: () => void; run: (fn: () => void) => void }) {
  const a = sel.ranges[sel.ranges.length - 1]!;
  const current = axis === "cols" ? (sheet.colWidths.get(a.c1) ?? DEFAULT_COL_WIDTH) : (sheet.rowHeights.get(a.r1) ?? DEFAULT_ROW_HEIGHT);
  const [value, setValue] = useState(String(current));
  const apply = () => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 2000) return;
    const indices: number[] = [];
    for (const r of sel.ranges) {
      if (axis === "cols") for (let c = r.c1; c <= Math.min(r.c2, MAX_COLS - 1); c++) indices.push(c);
      else for (let i = r.r1; i <= Math.min(r.r2, r.r1 + 10_000, MAX_ROWS - 1); i++) indices.push(i);
    }
    run(() => wb.transact(axis === "cols" ? "Column width" : "Row height", () => (axis === "cols" ? wb.setColWidth(sheet, indices, n) : wb.setRowHeight(sheet, indices, n))));
    onClose();
  };
  return (
    <Modal
      title={axis === "cols" ? "Column width" : "Row height"}
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={() => setValue(String(axis === "cols" ? DEFAULT_COL_WIDTH : DEFAULT_ROW_HEIGHT))}>Default</button>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={apply}>OK</button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="size-value">{axis === "cols" ? "Width" : "Height"} in pixels</label>
        <input id="size-value" type="number" min={0} max={2000} value={value} onChange={(e) => setValue(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && apply()} />
      </div>
    </Modal>
  );
}

function NamesDialog({ wb, sheet, sel, onClose, run }: { wb: Workbook; sheet: Sheet; sel: Selection; onClose: () => void; run: (fn: () => void) => void }) {
  const a = usedAreas(wb, sheet, sel)[0]!;
  const quoted = /^[A-Za-z_][\w.]*$/.test(sheet.name) ? sheet.name : `'${sheet.name.replace(/'/g, "''")}'`;
  const [name, setName] = useState("");
  const [formula, setFormula] = useState(`${quoted}!$${cellName(a.r1, a.c1).replace(/(\d+)/, "$$$1")}${a.r1 !== a.r2 || a.c1 !== a.c2 ? ":$" + cellName(a.r2, a.c2).replace(/(\d+)/, "$$$1") : ""}`);
  const [, setTick] = useState(0);
  return (
    <Modal
      title="Names"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
          <button className="primary" disabled={!name.trim()} onClick={() => {
            run(() => {
              wb.transact("Define name", () => wb.defineName(name, formula));
              setName("");
              setTick((t) => t + 1);
            });
          }}>Add name</button>
        </>
      }
    >
      <p className="dim small">A name stands for a cell, a range, a value or a formula: =SUM(Sales) instead of =SUM(Sheet1!$B$2:$B$50). A name holding a LAMBDA is a function of your own.</p>
      <div className="row wrap" style={{ gap: 8, alignItems: "flex-end" }}>
        <div className="field" style={{ flex: 1 }}><label htmlFor="name-name">Name</label><input id="name-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
        <div className="field" style={{ flex: 2 }}><label htmlFor="name-ref">Refers to</label><input id="name-ref" className="mono" value={formula} onChange={(e) => setFormula(e.target.value)} /></div>
      </div>
      <ul className="sheet-format-list">
        {[...wb.names.entries()].map(([id, n]) => (
          <li key={id}>
            <div className="sheet-name-row">
              <b>{n.name}</b>
              <span className="mono faint">={n.formula}</span>
              <span className="spacer" />
              <button className="ghost small" onClick={() => { run(() => wb.transact("Delete name", () => wb.deleteName(id))); setTick((t) => t + 1); }}>Delete</button>
            </div>
          </li>
        ))}
        {!wb.names.size && <li className="faint small" style={{ padding: 8 }}>No names yet.</li>}
      </ul>
    </Modal>
  );
}
