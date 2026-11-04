// The spreadsheet's toolbar: clipboard, fonts, colours, borders, alignment, number formats,
// AutoSum, sorting, rows and columns, freezing and finding.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { key, MAX_COLS, MAX_ROWS } from "../engine/address";
import type { PasteMode } from "../engine/fill";
import { BUILTIN_FORMATS, changeDecimals } from "../engine/format";
import type { Sheet, Style, Workbook } from "../engine/workbook";
import { applyBorders, applyStyle, shiftSelection, toggleStyle, type BorderKind } from "./commands";
import type { DialogState } from "./dialogs";
import type { DataDialog } from "./data";
import { Icon } from "../../components/Icon";
import { SheetIcon, type SheetIconName } from "./icons";
import type { Selection } from "./render";

export const PALETTE = [
  "#000000", "#434343", "#666666", "#999999", "#b7b7b7", "#cccccc", "#d9d9d9", "#efefef", "#f3f3f3", "#ffffff",
  "#980000", "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff", "#4a86e8", "#0000ff", "#9900ff", "#ff00ff",
  "#e6b8af", "#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3", "#d0e0e3", "#c9daf8", "#cfe2f3", "#d9d2e9", "#ead1dc",
  "#dd7e6b", "#ea9999", "#f9cb9c", "#ffe599", "#b6d7a8", "#a2c4c9", "#a4c2f4", "#9fc5e8", "#b4a7d6", "#d5a6bd",
  "#a61c00", "#cc0000", "#e69138", "#f1c232", "#6aa84f", "#45818e", "#3c78d8", "#3d85c6", "#674ea7", "#a64d79",
];
const FONTS = ["", "Arial", "Calibri", "Cambria", "Courier New", "Georgia", "Helvetica", "Inter", "Times New Roman", "Trebuchet MS", "Verdana"];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];

function Pop({ open, onClose, children, align = "left" }: { open: boolean; onClose: () => void; children: ReactNode; align?: "left" | "right" }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className={`sheet-pop ${align}`} role="menu">
      {children}
    </div>
  );
}

function Tool({ icon, label, onClick, active, disabled, children }: { icon?: SheetIconName; label: string; onClick?: () => void; active?: boolean; disabled?: boolean; children?: ReactNode }) {
  return (
    <button className={`sheet-tool ${active ? "on" : ""}`} onClick={onClick} title={label} aria-label={label} aria-pressed={active} disabled={disabled} onMouseDown={(e) => e.preventDefault()}>
      {icon && <SheetIcon name={icon} />}
      {children}
    </button>
  );
}

function ColorPicker({ label, icon, value, onPick, none }: { label: string; icon: SheetIconName; value?: string; onPick: (color: string | undefined) => void; none: string }) {
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<string | undefined>(icon === "fill" ? "#fff2cc" : "#cc0000");
  return (
    <span className="sheet-split">
      <button className="sheet-tool" title={label} aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(last)}>
        <SheetIcon name={icon} />
        <span className="sheet-swatch-bar" style={{ background: last ?? "transparent" }} />
      </button>
      <button className="sheet-tool caret" aria-label={`${label}: choose a colour`} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)}>
        <span className="sheet-caret" />
      </button>
      <Pop open={open} onClose={() => setOpen(false)}>
        <button className="sheet-pop-row" onClick={() => { onPick(undefined); setLast(undefined); setOpen(false); }}>
          {none}
        </button>
        <div className="sheet-palette">
          {PALETTE.map((c) => (
            <button key={c} className={`sheet-swatch ${value === c ? "on" : ""}`} style={{ background: c }} title={c} aria-label={c} onClick={() => { onPick(c); setLast(c); setOpen(false); }} />
          ))}
        </div>
        <label className="sheet-pop-row">
          Custom <input type="color" value={value ?? "#000000"} onChange={(e) => { onPick(e.target.value); setLast(e.target.value); }} />
        </label>
      </Pop>
    </span>
  );
}

function Menu({ label, icon, text, children, wide }: { label: string; icon?: SheetIconName; text?: string; children: (close: () => void) => ReactNode; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="sheet-split">
      <button className="sheet-tool" title={label} aria-label={label} aria-expanded={open} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)}>
        {icon && <SheetIcon name={icon} />}
        {text && <span className="sheet-tool-text">{text}</span>}
        <span className="sheet-caret" />
      </button>
      <Pop open={open} onClose={() => setOpen(false)}>
        <div className={wide ? "sheet-pop-list wide" : "sheet-pop-list"}>{children(() => setOpen(false))}</div>
      </Pop>
    </span>
  );
}

export function Toolbar({
  wb, sheet, sel, onDialog, showFormulas, setShowFormulas, onAutoSum, onSort, run, onPaste, onCopy, onData, onFilter, onFlashFill, onCircle,
}: {
  onData: (d: DataDialog) => void;
  onFilter: () => void;
  onFlashFill: () => void;
  onCircle: () => void;
  wb: Workbook;
  sheet: Sheet;
  sel: Selection;
  onDialog: (d: DialogState) => void;
  showFormulas: boolean;
  setShowFormulas: (v: boolean) => void;
  zoom: number;
  setZoom: (z: number) => void;
  onAutoSum: (fn: string) => void;
  onSort: (desc: boolean) => void;
  run: (fn: () => void) => void;
  onPaste: (mode: PasteMode) => void;
  onCopy: (cut: boolean) => void;
}) {
  const cell = sheet.cells.get(key(sel.active.row, sel.active.col));
  const st: Style = wb.style(cell?.s);
  const value = wb.value(sheet, sel.active.row, sel.active.col);
  const set = (patch: Partial<Style>, label = "Format") => run(() => applyStyle(wb, sheet, sel, patch, label));
  const format = st.format ?? "General";
  const known = BUILTIN_FORMATS.find((f) => f.code === format);
  const merged = sheet.merges.some((m) => sel.active.row >= m.r1 && sel.active.row <= m.r2 && sel.active.col >= m.c1 && sel.active.col <= m.c2);
  const area = sel.ranges[sel.ranges.length - 1]!;

  return (
    <div className="sheet-toolbar" role="toolbar" aria-label="Spreadsheet">
      <div className="sheet-group">
        <Tool icon="undo" label={`Undo${wb.canUndo() ? ` ${wb.canUndo()}` : ""} (Ctrl+Z)`} onClick={() => wb.undo()} disabled={!wb.canUndo()} />
        <Tool icon="redo" label={`Redo${wb.canRedo() ? ` ${wb.canRedo()}` : ""} (Ctrl+Y)`} onClick={() => wb.redo()} disabled={!wb.canRedo()} />
      </div>
      <div className="sheet-group">
        <Menu label="Paste, cut and copy" icon="paste">
          {(close) => (
            <>
              <button onClick={() => { onCopy(true); close(); }}>Cut <kbd>Ctrl X</kbd></button>
              <button onClick={() => { onCopy(false); close(); }}>Copy <kbd>Ctrl C</kbd></button>
              <div className="sheet-pop-sep" />
              <button onClick={() => { onPaste("all"); close(); }}>Paste <kbd>Ctrl V</kbd></button>
              <button onClick={() => { onPaste("values"); close(); }}>Paste values</button>
              <button onClick={() => { onPaste("formulas"); close(); }}>Paste formulas</button>
              <button onClick={() => { onPaste("formats"); close(); }}>Paste formatting</button>
              <button onClick={() => { onPaste("transpose"); close(); }}>Paste transposed</button>
            </>
          )}
        </Menu>
      </div>
      <div className="sheet-group">
        <select className="sheet-select font" value={st.font ?? ""} onChange={(e) => set({ font: e.target.value || undefined }, "Font")} aria-label="Font" title="Font">
          {FONTS.map((f) => (
            <option key={f} value={f}>{f || "System"}</option>
          ))}
        </select>
        <select className="sheet-select size" value={st.size ?? 11} onChange={(e) => set({ size: Number(e.target.value) === 11 ? undefined : Number(e.target.value) }, "Font size")} aria-label="Font size" title="Font size">
          {SIZES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      <div className="sheet-group">
        <Tool icon="bold" label="Bold (Ctrl+B)" active={st.bold} onClick={() => run(() => toggleStyle(wb, sheet, sel, "bold"))} />
        <Tool icon="italic" label="Italic (Ctrl+I)" active={st.italic} onClick={() => run(() => toggleStyle(wb, sheet, sel, "italic"))} />
        <Tool icon="underline" label="Underline (Ctrl+U)" active={st.underline} onClick={() => run(() => toggleStyle(wb, sheet, sel, "underline"))} />
        <Tool icon="strike" label="Strikethrough (Ctrl+5)" active={st.strike} onClick={() => run(() => toggleStyle(wb, sheet, sel, "strike"))} />
        <ColorPicker label="Text colour" icon="textColor" value={st.color} none="Automatic" onPick={(c) => set({ color: c }, "Text colour")} />
        <ColorPicker label="Fill colour" icon="fill" value={st.fill} none="No fill" onPick={(c) => set({ fill: c }, "Fill colour")} />
        <Menu label="Borders" icon="border">
          {(close) => (
            <div className="sheet-borders">
              {([
                ["all", "border", "All borders"], ["outer", "borderOuter", "Outside borders"], ["thick-outer", "borderOuter", "Thick outside"], ["none", "borderNone", "No border"],
                ["top", "borderTop", "Top border"], ["bottom", "borderBottom", "Bottom border"], ["left", "borderLeft", "Left border"], ["right", "borderRight", "Right border"],
                ["bottom-double", "borderBottom", "Double bottom"],
              ] as [BorderKind, SheetIconName, string][]).map(([kind, icon, text]) => (
                <button key={kind} onClick={() => { run(() => applyBorders(wb, sheet, sel, kind)); close(); }}>
                  <SheetIcon name={icon} /> {text}
                </button>
              ))}
            </div>
          )}
        </Menu>
      </div>
      <div className="sheet-group">
        <Tool icon="alignLeft" label="Align left" active={st.h === "left"} onClick={() => set({ h: st.h === "left" ? undefined : "left" }, "Align")} />
        <Tool icon="alignCenter" label="Center" active={st.h === "center"} onClick={() => set({ h: st.h === "center" ? undefined : "center" }, "Align")} />
        <Tool icon="alignRight" label="Align right" active={st.h === "right"} onClick={() => set({ h: st.h === "right" ? undefined : "right" }, "Align")} />
        <Menu label="Vertical alignment" icon={st.v === "top" ? "alignTop" : st.v === "middle" ? "alignMiddle" : "alignBottom"}>
          {(close) => (
            <>
              <button onClick={() => { set({ v: "top" }, "Align"); close(); }}><SheetIcon name="alignTop" /> Top</button>
              <button onClick={() => { set({ v: "middle" }, "Align"); close(); }}><SheetIcon name="alignMiddle" /> Middle</button>
              <button onClick={() => { set({ v: undefined }, "Align"); close(); }}><SheetIcon name="alignBottom" /> Bottom</button>
            </>
          )}
        </Menu>
        <Tool icon="wrap" label="Wrap text" active={st.wrap} onClick={() => run(() => toggleStyle(wb, sheet, sel, "wrap"))} />
        <Menu label="Merge cells" icon="merge">
          {(close) => (
            <>
              <button disabled={area.r1 === area.r2 && area.c1 === area.c2} onClick={() => { run(() => wb.transact("Merge and center", () => { wb.merge(sheet, area); wb.setStyle(sheet, { r1: area.r1, c1: area.c1, r2: area.r1, c2: area.c1 }, { h: "center" }); })); close(); }}>Merge and center</button>
              <button disabled={area.r1 === area.r2 && area.c1 === area.c2} onClick={() => { run(() => wb.transact("Merge", () => wb.merge(sheet, area))); close(); }}>Merge cells</button>
              <button disabled={area.c1 === area.c2} onClick={() => { run(() => wb.transact("Merge across", () => { for (let r = area.r1; r <= area.r2; r++) wb.merge(sheet, { ...area, r1: r, r2: r }); })); close(); }}>Merge across</button>
              <button disabled={!merged} onClick={() => { run(() => wb.transact("Unmerge", () => wb.unmerge(sheet, area))); close(); }}>Unmerge cells</button>
            </>
          )}
        </Menu>
      </div>
      <div className="sheet-group">
        <select className="sheet-select format" value={known?.code ?? "custom"} onChange={(e) => (e.target.value === "custom" ? onDialog({ kind: "format", tab: "number" }) : set({ format: e.target.value }, "Number format"))} aria-label="Number format" title="Number format">
          {BUILTIN_FORMATS.map((f) => (
            <option key={f.id} value={f.code}>{f.label}</option>
          ))}
          <option value="custom">{known ? "More formats…" : "Custom"}</option>
        </select>
        <Tool label="Currency" onClick={() => set({ format: '"$"#,##0.00' }, "Currency")}><span className="sheet-tool-glyph">$</span></Tool>
        <Tool icon="percent" label="Percent (Ctrl+Shift+%)" onClick={() => set({ format: "0%" }, "Percent")} />
        <Tool label="Thousands separator" onClick={() => set({ format: "#,##0.00" }, "Comma style")}><span className="sheet-tool-glyph">,</span></Tool>
        <Tool icon="decimalsMore" label="More decimals" onClick={() => set({ format: changeDecimals(format, value, true) }, "Decimals")} />
        <Tool icon="decimalsLess" label="Fewer decimals" onClick={() => set({ format: changeDecimals(format, value, false) }, "Decimals")} />
      </div>
      <div className="sheet-group">
        <span className="sheet-split">
          <button className="sheet-tool" title="AutoSum (Alt+=)" aria-label="AutoSum" onMouseDown={(e) => e.preventDefault()} onClick={() => onAutoSum("SUM")}>
            <SheetIcon name="sigma" />
          </button>
          <Menu label="More AutoSum functions">
            {(close) => (
              <>
                {["SUM", "AVERAGE", "COUNT", "MAX", "MIN"].map((fn) => (
                  <button key={fn} onClick={() => { onAutoSum(fn); close(); }}>{fn === "SUM" ? "Sum" : fn === "AVERAGE" ? "Average" : fn === "COUNT" ? "Count numbers" : fn === "MAX" ? "Max" : "Min"}</button>
                ))}
                <div className="sheet-pop-sep" />
                <button onClick={() => { onDialog({ kind: "function" }); close(); }}>More functions…</button>
              </>
            )}
          </Menu>
        </span>
        <Tool icon="sortAsc" label="Sort A to Z" onClick={() => onSort(false)} />
        <Tool icon="sortDesc" label="Sort Z to A" onClick={() => onSort(true)} />
        <Tool icon="filter" label={sheet.filter ? "Remove the filter (Ctrl+Shift+L)" : "Filter (Ctrl+Shift+L)"} active={Boolean(sheet.filter)} onClick={onFilter} />
        <Menu label="Data" text="Data">
          {(close) => (
            <>
              <button onClick={() => { onData({ kind: "sort" }); close(); }}>Sort…</button>
              <button onClick={() => { onFilter(); close(); }}>{sheet.filter ? "Remove filter" : "Filter"} <kbd>Ctrl Shift L</kbd></button>
              <div className="sheet-pop-sep" />
              <button onClick={() => { onData({ kind: "table" }); close(); }}>Format as table… <kbd>Ctrl T</kbd></button>
              <button onClick={() => { onData({ kind: "pivot" }); close(); }}>PivotTable…</button>
              <button onClick={() => { onData({ kind: "chart" }); close(); }}>Chart… <kbd>Alt F1</kbd></button>
              <div className="sheet-pop-sep" />
              <button onClick={() => { onData({ kind: "split" }); close(); }}>Text to columns…</button>
              <button onClick={() => { onData({ kind: "dedupe" }); close(); }}>Remove duplicates…</button>
              <button onClick={() => { onFlashFill(); close(); }}>Flash fill <kbd>Ctrl E</kbd></button>
              <div className="sheet-pop-sep" />
              <button onClick={() => { onData({ kind: "validation" }); close(); }}>Data validation…</button>
              <button onClick={() => { onCircle(); close(); }}>Circle invalid data</button>
            </>
          )}
        </Menu>
        <Menu label="Conditional formatting" icon="rules" wide>
          {(close) => (
            <>
              <div className="sheet-pop-head">Highlight cells</div>
              {([[">", "Greater than…"], ["<", "Less than…"], ["between", "Between…"], ["=", "Equal to…"]] as const).map(([op, l]) => <button key={op} onClick={() => { onData({ kind: "conditional", preset: "cell", op }); close(); }}>{l}</button>)}
              <button onClick={() => { onData({ kind: "conditional", preset: "text" }); close(); }}>Text that contains…</button>
              <button onClick={() => { onData({ kind: "conditional", preset: "date" }); close(); }}>A date occurring…</button>
              <button onClick={() => { onData({ kind: "conditional", preset: "duplicate" }); close(); }}>Duplicate values</button>
              <div className="sheet-pop-head">Top and bottom</div>
              <button onClick={() => { onData({ kind: "conditional", preset: "top" }); close(); }}>Top or bottom items…</button>
              <button onClick={() => { onData({ kind: "conditional", preset: "average" }); close(); }}>Above or below average…</button>
              <div className="sheet-pop-head">Show the values</div>
              <button onClick={() => { onData({ kind: "conditional", preset: "bar" }); close(); }}>Data bars…</button>
              <button onClick={() => { onData({ kind: "conditional", preset: "scale" }); close(); }}>Colour scales…</button>
              <button onClick={() => { onData({ kind: "conditional", preset: "icons" }); close(); }}>Icon sets…</button>
              <div className="sheet-pop-sep" />
              <button onClick={() => { onData({ kind: "conditional", preset: "formula" }); close(); }}>New rule with a formula…</button>
              <button onClick={() => { onData({ kind: "rules" }); close(); }}>Manage rules…</button>
              <button onClick={() => { run(() => wb.transact("Clear rules", () => wb.setSheetProp(sheet, "conditionals", sheet.conditionals.filter((r) => !(r.area.r1 >= area.r1 && r.area.r2 <= area.r2 && r.area.c1 >= area.c1 && r.area.c2 <= area.c2))))); close(); }}>Clear rules from the selection</button>
              <button onClick={() => { run(() => wb.transact("Clear rules", () => wb.setSheetProp(sheet, "conditionals", []))); close(); }}>Clear rules from the sheet</button>
            </>
          )}
        </Menu>
      </div>
      <div className="sheet-group">
        <Menu label="Insert" icon="insertRow">
          {(close) => (
            <>
              <button onClick={() => { run(() => shiftSelection(wb, sheet, { ...sel, ranges: [{ ...area, c1: 0, c2: MAX_COLS - 1 }] }, "rows", true)); close(); }}>Insert rows above</button>
              <button onClick={() => { run(() => wb.transact("Insert rows", () => wb.shift(sheet, "rows", area.r2 + 1, area.r2 - area.r1 + 1))); close(); }}>Insert rows below</button>
              <button onClick={() => { run(() => shiftSelection(wb, sheet, { ...sel, ranges: [{ ...area, r1: 0, r2: MAX_ROWS - 1 }] }, "cols", true)); close(); }}>Insert columns left</button>
              <button onClick={() => { run(() => wb.transact("Insert columns", () => wb.shift(sheet, "cols", area.c2 + 1, area.c2 - area.c1 + 1))); close(); }}>Insert columns right</button>
              <div className="sheet-pop-sep" />
              <button onClick={() => { run(() => { const s = wb.transact("New sheet", () => wb.addSheet()); void s; }); close(); }}>Insert sheet</button>
              <button onClick={() => { onDialog({ kind: "note" }); close(); }}>Note…</button>
              <button onClick={() => { onDialog({ kind: "link" }); close(); }}>Link… <kbd>Ctrl K</kbd></button>
              <button onClick={() => { onDialog({ kind: "names" }); close(); }}>Names…</button>
            </>
          )}
        </Menu>
        <Menu label="Delete" icon="deleteRow">
          {(close) => (
            <>
              <button onClick={() => { run(() => shiftSelection(wb, sheet, sel, "rows", false)); close(); }}>Delete rows</button>
              <button onClick={() => { run(() => shiftSelection(wb, sheet, sel, "cols", false)); close(); }}>Delete columns</button>
              <div className="sheet-pop-sep" />
              <button onClick={() => { run(() => wb.transact("Clear", () => sel.ranges.forEach((r) => wb.clear(sheet, r, "contents")))); close(); }}>Clear contents <kbd>Delete</kbd></button>
              <button onClick={() => { run(() => wb.transact("Clear formats", () => sel.ranges.forEach((r) => wb.clear(sheet, r, "formats")))); close(); }}>Clear formats</button>
              <button onClick={() => { run(() => wb.transact("Clear all", () => sel.ranges.forEach((r) => wb.clear(sheet, r, "all")))); close(); }}>Clear all</button>
            </>
          )}
        </Menu>
        <Menu label="Format rows and columns" icon="freeze">
          {(close) => (
            <>
              <button onClick={() => { run(() => wb.transact("Freeze panes", () => { wb.setSheetProp(sheet, "freezeRows", sel.active.row); wb.setSheetProp(sheet, "freezeCols", sel.active.col); })); close(); }}>Freeze panes above and left of the cell</button>
              <button onClick={() => { run(() => wb.transact("Freeze top row", () => { wb.setSheetProp(sheet, "freezeRows", 1); wb.setSheetProp(sheet, "freezeCols", 0); })); close(); }}>Freeze top row</button>
              <button onClick={() => { run(() => wb.transact("Freeze first column", () => { wb.setSheetProp(sheet, "freezeRows", 0); wb.setSheetProp(sheet, "freezeCols", 1); })); close(); }}>Freeze first column</button>
              <button disabled={!sheet.freezeRows && !sheet.freezeCols} onClick={() => { run(() => wb.transact("Unfreeze", () => { wb.setSheetProp(sheet, "freezeRows", 0); wb.setSheetProp(sheet, "freezeCols", 0); })); close(); }}>Unfreeze panes</button>
              <div className="sheet-pop-sep" />
              <button onClick={() => { onDialog({ kind: "size", axis: "cols" }); close(); }}>Column width…</button>
              <button onClick={() => { onDialog({ kind: "size", axis: "rows" }); close(); }}>Row height…</button>
              <button onClick={() => { run(() => wb.transact("Show gridlines", () => wb.setSheetProp(sheet, "showGrid", !sheet.showGrid))); close(); }}>{sheet.showGrid ? "Hide gridlines" : "Show gridlines"}</button>
              <button onClick={() => { onDialog({ kind: "format" }); close(); }}>Format cells… <kbd>Ctrl 1</kbd></button>
            </>
          )}
        </Menu>
      </div>
      <div className="sheet-group">
        <Tool icon="zoom" label="Find and replace (Ctrl+F)" onClick={() => onDialog({ kind: "find", replace: false })} />
        <Tool icon="formulas" label="Show formulas (Ctrl+`)" active={showFormulas} onClick={() => setShowFormulas(!showFormulas)} />
      </div>
    </div>
  );
}

export function FileMenu({ onImport, onXlsx, onCsv, onPrint }: { onImport: () => void; onXlsx: () => void; onCsv: () => void; onPrint: () => void }) {
  return (
    <Menu label="File" text="File">
      {(close) => (
        <>
          <button onClick={() => { onImport(); close(); }}><Icon name="upload" size={12} /> Import .xlsx or .csv… <kbd>Ctrl O</kbd></button>
          <div className="sheet-pop-sep" />
          <button onClick={() => { onXlsx(); close(); }}><Icon name="download" size={12} /> Download as Excel (.xlsx)</button>
          <button onClick={() => { onCsv(); close(); }}><Icon name="download" size={12} /> Download this sheet as .csv</button>
          <div className="sheet-pop-sep" />
          <button onClick={() => { onPrint(); close(); }}>Print… <kbd>Ctrl P</kbd></button>
        </>
      )}
    </Menu>
  );
}
