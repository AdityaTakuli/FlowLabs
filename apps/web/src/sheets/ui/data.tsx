// The spreadsheet's data screens: the AutoFilter menu, drop-down lists, Sort, Data Validation,
// Conditional Formatting, Text to Columns, Remove Duplicates, Tables, PivotTables, charts and Paste Special.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { type Area, cellName, colName, parseArea } from "../engine/address";
import type { PasteMode } from "../engine/fill";
import {
  AGG_LABELS, buildPivot, chartData, columnValues, createTable, pivotFields, region, removeDuplicates, setColumnFilter, sortRange, TABLE_STYLES, targetArea, textToColumns, uid, type SortKey,
} from "../engine/features";
import { formatValue } from "../engine/format";
import type { ChartDef, Conditional, FilterSpec, PivotDef, Sheet, Validation, Workbook } from "../engine/workbook";
import { Modal } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { isHeaderRow } from "./commands";
import type { Selection } from "./render";

// ------------------------------------------------------------------------------ small popovers

function usePopover(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const t = setTimeout(() => window.addEventListener("pointerdown", away), 0);
    window.addEventListener("keydown", esc);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  return ref;
}

function place(x: number, y: number, w: number, h: number) {
  return { left: Math.max(8, Math.min(x, window.innerWidth - w - 8)), top: Math.max(8, Math.min(y, window.innerHeight - h - 8)) };
}

export function FilterMenu({ wb, sheet, col, x, y, onClose, run }: { wb: Workbook; sheet: Sheet; col: number; x: number; y: number; onClose: () => void; run: (fn: () => void) => void }) {
  const ref = usePopover(onClose);
  const f = sheet.filter!;
  const spec = f.columns[col] ?? {};
  // the checklist shows every value, as if this column were not filtered
  const values = useMemo(() => columnValues(wb, sheet, col, f.area), [wb, sheet, col, f.area]);
  const [q, setQ] = useState("");
  const [checked, setChecked] = useState<Set<string>>(() => new Set(spec.values ?? values.map((v) => v.text)));
  const numeric = values.filter((v) => typeof v.value === "number").length > values.length / 2;
  const [cond, setCond] = useState(spec.cond ?? { op: numeric ? ">" : "contains", value: "" });
  const [mode, setMode] = useState<"list" | "cond" | "top">(spec.cond ? "cond" : spec.top ? "top" : "list");
  const [top, setTop] = useState(spec.top ?? { n: 10 });
  const shown = values.filter((v) => !q || v.text.toLowerCase().includes(q.toLowerCase()));
  const apply = (next: FilterSpec | null) => {
    run(() => setColumnFilter(wb, sheet, col, next));
    onClose();
  };
  const header = sheet.filter!.area;
  const pos = place(x, y, 280, 440);
  return createPortal(
    <div ref={ref} className="sheet-filter" style={pos} role="dialog" aria-label={`Filter ${wb.display(sheet, header.r1, col).text}`}>
      <button className="sheet-filter-row" onClick={() => { run(() => sortRange(wb, sheet, header, [{ col, desc: false }], true)); onClose(); }}>
        <Icon name="arrowUp" size={12} /> Sort smallest to largest
      </button>
      <button className="sheet-filter-row" onClick={() => { run(() => sortRange(wb, sheet, header, [{ col, desc: true }], true)); onClose(); }}>
        <Icon name="arrowDown" size={12} /> Sort largest to smallest
      </button>
      <div className="sheet-pop-sep" />
      <div className="segmented small" role="tablist">
        <button className={mode === "list" ? "active" : ""} onClick={() => setMode("list")}>Values</button>
        <button className={mode === "cond" ? "active" : ""} onClick={() => setMode("cond")}>{numeric ? "Number" : "Text"} filter</button>
        {numeric && <button className={mode === "top" ? "active" : ""} onClick={() => setMode("top")}>Top 10</button>}
      </div>
      {mode === "list" && (
        <>
          <input className="sheet-filter-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" autoFocus aria-label="Search values" />
          <div className="sheet-filter-list">
            <label className="row small">
              <input type="checkbox" checked={shown.every((v) => checked.has(v.text))} onChange={(e) => {
                const next = new Set(checked);
                for (const v of shown) e.target.checked ? next.add(v.text) : next.delete(v.text);
                setChecked(next);
              }} />
              <b>(Select all)</b>
            </label>
            {shown.slice(0, 1000).map((v) => (
              <label key={v.text} className="row small">
                <input type="checkbox" checked={checked.has(v.text)} onChange={(e) => {
                  const next = new Set(checked);
                  e.target.checked ? next.add(v.text) : next.delete(v.text);
                  setChecked(next);
                }} />
                <span className="ellipsis">{v.text === "" ? "(Blanks)" : v.text}</span>
                <span className="faint tiny">{v.count}</span>
              </label>
            ))}
          </div>
        </>
      )}
      {mode === "cond" && (
        <div className="sheet-filter-cond">
          <select value={cond.op} onChange={(e) => setCond({ ...cond, op: e.target.value })} aria-label="Condition">
            {(numeric ? [["=", "equals"], ["<>", "does not equal"], [">", "is greater than"], [">=", "is at least"], ["<", "is less than"], ["<=", "is at most"]] : [["contains", "contains"], ["notContains", "does not contain"], ["begins", "begins with"], ["ends", "ends with"], ["=", "equals"], ["<>", "does not equal"]]).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input value={cond.value} onChange={(e) => setCond({ ...cond, value: e.target.value })} autoFocus aria-label="Value" />
          <div className="row small">
            <label className="row"><input type="radio" checked={(cond.join ?? "and") === "and"} onChange={() => setCond({ ...cond, join: "and" })} /> And</label>
            <label className="row"><input type="radio" checked={cond.join === "or"} onChange={() => setCond({ ...cond, join: "or" })} /> Or</label>
          </div>
          <select value={cond.op2 ?? ""} onChange={(e) => setCond({ ...cond, op2: e.target.value || undefined })} aria-label="Second condition">
            <option value="">(no second condition)</option>
            {(numeric ? [["=", "equals"], ["<>", "does not equal"], [">", "is greater than"], [">=", "is at least"], ["<", "is less than"], ["<=", "is at most"]] : [["contains", "contains"], ["notContains", "does not contain"], ["begins", "begins with"], ["ends", "ends with"]]).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {cond.op2 && <input value={cond.value2 ?? ""} onChange={(e) => setCond({ ...cond, value2: e.target.value })} aria-label="Second value" />}
          <p className="faint tiny">Use ? for any one character and * for any run of characters.</p>
        </div>
      )}
      {mode === "top" && (
        <div className="sheet-filter-cond row wrap">
          <select value={top.bottom ? "bottom" : "top"} onChange={(e) => setTop({ ...top, bottom: e.target.value === "bottom" })} aria-label="Top or bottom">
            <option value="top">Top</option>
            <option value="bottom">Bottom</option>
          </select>
          <input type="number" min={1} value={top.n} onChange={(e) => setTop({ ...top, n: Math.max(1, Number(e.target.value)) })} style={{ width: 70 }} aria-label="How many" />
          <select value={top.percent ? "percent" : "items"} onChange={(e) => setTop({ ...top, percent: e.target.value === "percent" })} aria-label="Items or percent">
            <option value="items">items</option>
            <option value="percent">percent</option>
          </select>
        </div>
      )}
      <div className="sheet-filter-foot">
        <button className="ghost small" onClick={() => apply(null)} disabled={!f.columns[col]}>Clear filter</button>
        <span className="spacer" />
        <button className="small" onClick={onClose}>Cancel</button>
        <button className="small primary" onClick={() => {
          if (mode === "list") apply(checked.size === values.length ? null : { values: [...checked] });
          else if (mode === "cond") apply(cond.value || cond.op === "=" || cond.op === "<>" ? { cond } : null);
          else apply({ top });
        }}>OK</button>
      </div>
    </div>,
    document.body,
  );
}

export function ListMenu({ items, x, y, onPick, onClose }: { items: string[]; x: number; y: number; onPick: (v: string) => void; onClose: () => void }) {
  const ref = usePopover(onClose);
  const [i, setI] = useState(0);
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setI((n) => Math.min(items.length - 1, n + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setI((n) => Math.max(0, n - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (items[i] !== undefined) onPick(items[i]!);
      }
    };
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, [items, i, onPick]);
  return createPortal(
    <div ref={ref} className="sheet-list" style={place(x, y, 220, 260)} role="listbox">
      {items.length === 0 && <p className="faint small" style={{ padding: 8 }}>No choices.</p>}
      {items.map((item, k) => (
        <button key={item + k} role="option" aria-selected={k === i} className={k === i ? "active" : ""} onMouseEnter={() => setI(k)} onClick={() => onPick(item)}>
          {item}
        </button>
      ))}
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------------------------ dialogs

export type DataDialog =
  | { kind: "sort" }
  | { kind: "validation" }
  | { kind: "conditional"; preset?: Conditional["kind"]; op?: string }
  | { kind: "rules" }
  | { kind: "split" }
  | { kind: "dedupe" }
  | { kind: "table" }
  | { kind: "pivot" }
  | { kind: "chart"; chart?: ChartDef }
  | { kind: "paste" };

interface Props {
  wb: Workbook;
  sheet: Sheet;
  sel: Selection;
  onClose: () => void;
  run: (fn: () => void) => void;
  notify: (m: string, level?: "info" | "ok" | "error") => void;
}

export function DataDialogs({ dialog, onPaste, onPivot, onSwitch, ...p }: Props & { dialog: DataDialog; onPaste: (mode: PasteMode, skipBlanks: boolean) => void; onPivot: (sheet: Sheet, pivot: PivotDef) => void; onSwitch: (uid: number) => void }) {
  switch (dialog.kind) {
    case "sort": return <SortDialog {...p} />;
    case "validation": return <ValidationDialog {...p} />;
    case "conditional": return <ConditionalDialog {...p} preset={dialog.preset} op={dialog.op} />;
    case "rules": return <RulesDialog {...p} />;
    case "split": return <SplitDialog {...p} />;
    case "dedupe": return <DedupeDialog {...p} />;
    case "table": return <TableDialog {...p} />;
    case "pivot": return <PivotDialog {...p} onPivot={onPivot} onSwitch={onSwitch} />;
    case "chart": return <ChartDialog {...p} chart={dialog.chart} />;
    case "paste": return <PasteSpecial onClose={p.onClose} onPaste={onPaste} />;
  }
}

const area = (p: Props) => targetArea(p.wb, p.sheet, p.sel.ranges[p.sel.ranges.length - 1]!, p.sel.active);
const label = (wb: Workbook, sheet: Sheet, a: Area, c: number, header: boolean) => (header ? wb.display(sheet, a.r1, c).text || `Column ${colName(c)}` : `Column ${colName(c)}`);

function SortDialog(p: Props) {
  const a = area(p);
  const [header, setHeader] = useState(() => isHeaderRow(p.wb, p.sheet, a, p.sel.active.col));
  const [keys, setKeys] = useState<SortKey[]>([{ col: p.sel.active.col >= a.c1 && p.sel.active.col <= a.c2 ? p.sel.active.col : a.c1, desc: false }]);
  const [leftToRight, setLeftToRight] = useState(false);
  const cols = leftToRight ? [...Array(a.r2 - a.r1 + 1).keys()].map((i) => a.r1 + i) : [...Array(a.c2 - a.c1 + 1).keys()].map((i) => a.c1 + i);
  const orders: Record<string, string[]> = {
    months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    mon: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    dd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  };
  return (
    <Modal title="Sort" onClose={p.onClose} wide footer={
      <>
        <button className="ghost" onClick={() => setKeys([...keys, { col: cols[0]!, desc: false }])}><Icon name="plus" size={12} /> Add level</button>
        <span className="spacer" />
        <button onClick={p.onClose}>Cancel</button>
        <button className="primary" onClick={() => { p.run(() => sortRange(p.wb, p.sheet, a, keys, header, leftToRight)); p.onClose(); }}>Sort</button>
      </>
    }>
      <p className="dim small">Sorting {cellName(a.r1, a.c1)}:{cellName(a.r2, a.c2)}. The first level decides; the next ones break ties.</p>
      <div className="row wrap small" style={{ gap: 16, marginBottom: 10 }}>
        <label className="row"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> My data has headers</label>
        <label className="row"><input type="checkbox" checked={leftToRight} onChange={(e) => { setLeftToRight(e.target.checked); setKeys([{ col: e.target.checked ? a.r1 : a.c1, desc: false }]); }} /> Sort left to right</label>
      </div>
      {keys.map((k, i) => (
        <div key={i} className="sheet-sort-row">
          <span className="faint small">{i === 0 ? "Sort by" : "Then by"}</span>
          <select value={k.col} onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, col: Number(e.target.value) } : x)))} aria-label="Column">
            {cols.map((c) => <option key={c} value={c}>{leftToRight ? `Row ${c + 1}` : label(p.wb, p.sheet, a, c, header)}</option>)}
          </select>
          <select value={k.by ?? "value"} onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, by: e.target.value as SortKey["by"], color: e.target.value === "fill" ? "#ffff00" : e.target.value === "color" ? "#ff0000" : undefined } : x)))} aria-label="Sort on">
            <option value="value">Cell values</option>
            <option value="fill">Cell colour</option>
            <option value="color">Font colour</option>
          </select>
          {k.by === "fill" || k.by === "color" ? (
            <>
              <input type="color" value={k.color ?? "#ffff00"} onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))} aria-label="Colour" />
              <select value={k.desc ? "bottom" : "top"} onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, desc: e.target.value === "bottom" } : x)))} aria-label="Where">
                <option value="top">On top</option>
                <option value="bottom">On bottom</option>
              </select>
            </>
          ) : (
            <select value={k.order ? Object.keys(orders).find((o) => orders[o] === k.order) : k.desc ? "desc" : "asc"} onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, desc: e.target.value === "desc", order: orders[e.target.value] } : x)))} aria-label="Order">
              <option value="asc">A to Z, smallest to largest</option>
              <option value="desc">Z to A, largest to smallest</option>
              <option value="months">January, February…</option>
              <option value="mon">Jan, Feb…</option>
              <option value="days">Sunday, Monday…</option>
              <option value="dd">Sun, Mon…</option>
            </select>
          )}
          {keys.length > 1 && <button className="ghost icon-only small" aria-label="Remove level" onClick={() => setKeys(keys.filter((_, j) => j !== i))}><Icon name="close" size={11} /></button>}
        </div>
      ))}
    </Modal>
  );
}

function ValidationDialog(p: Props) {
  const sel = p.sel.ranges[p.sel.ranges.length - 1]!;
  const existing = p.sheet.validations.find((v) => v.area.r1 <= sel.r1 && v.area.r2 >= sel.r1 && v.area.c1 <= sel.c1 && v.area.c2 >= sel.c1);
  const [v, setV] = useState<Validation>(existing ?? { area: sel, kind: "list", source: "", allowBlank: true, dropdown: true, op: "between" });
  const [tab, setTab] = useState<"rule" | "message" | "error">("rule");
  const save = (rule: Validation | null) => {
    p.run(() => p.wb.transact("Data validation", () => {
      const rest = p.sheet.validations.filter((x) => x !== existing && !(x.area.r1 >= sel.r1 && x.area.r2 <= sel.r2 && x.area.c1 >= sel.c1 && x.area.c2 <= sel.c2));
      p.wb.setSheetProp(p.sheet, "validations", rule ? [...rest, { ...rule, area: existing && existing.area.r1 <= sel.r1 && existing.area.r2 >= sel.r2 ? existing.area : sel }] : rest);
    }));
    p.onClose();
  };
  const needsBounds = ["whole", "decimal", "date", "time", "length"].includes(v.kind);
  return (
    <Modal title="Data validation" onClose={p.onClose} footer={
      <>
        {existing && <button className="danger" onClick={() => save(null)}>Clear rule</button>}
        <span className="spacer" />
        <button onClick={p.onClose}>Cancel</button>
        <button className="primary" onClick={() => save(v)}>OK</button>
      </>
    }>
      <div className="segmented" role="tablist" style={{ marginBottom: 12 }}>
        {(["rule", "message", "error"] as const).map((t) => <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t === "rule" ? "Rule" : t === "message" ? "Input message" : "Error alert"}</button>)}
      </div>
      {tab === "rule" && (
        <div className="sheet-format-grid">
          <div className="field">
            <label>Allow</label>
            <select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as Validation["kind"] })}>
              <option value="any">Any value</option>
              <option value="list">List</option>
              <option value="whole">Whole number</option>
              <option value="decimal">Decimal</option>
              <option value="date">Date</option>
              <option value="time">Time</option>
              <option value="length">Text length</option>
              <option value="custom">Custom formula</option>
            </select>
          </div>
          {needsBounds && (
            <div className="field">
              <label>Data</label>
              <select value={v.op ?? "between"} onChange={(e) => setV({ ...v, op: e.target.value as Validation["op"] })}>
                {[["between", "between"], ["notBetween", "not between"], ["=", "equal to"], ["<>", "not equal to"], [">", "greater than"], ["<", "less than"], [">=", "greater than or equal to"], ["<=", "less than or equal to"]].map(([x, l]) => <option key={x} value={x}>{l}</option>)}
              </select>
            </div>
          )}
          {v.kind === "list" && (
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label>Source</label>
              <input value={v.source ?? ""} onChange={(e) => setV({ ...v, source: e.target.value })} placeholder="Yes,No,Maybe or =$A$1:$A$10" autoFocus />
              <span className="help">Items separated by commas, or = and a range of cells (or a name).</span>
            </div>
          )}
          {v.kind === "custom" && (
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label>Formula</label>
              <input className="mono" value={v.source ?? ""} onChange={(e) => setV({ ...v, source: e.target.value })} placeholder={`=COUNTIF($A:$A,${cellName(sel.r1, sel.c1)})=1`} />
              <span className="help">Allowed when the formula is TRUE, written for the first selected cell.</span>
            </div>
          )}
          {needsBounds && (
            <>
              <div className="field"><label>{v.op === "between" || v.op === "notBetween" || !v.op ? "Minimum" : "Value"}</label><input value={v.a ?? ""} onChange={(e) => setV({ ...v, a: e.target.value })} placeholder={v.kind === "date" ? "1/1/2024" : "0"} /></div>
              {(v.op === "between" || v.op === "notBetween" || !v.op) && <div className="field"><label>Maximum</label><input value={v.b ?? ""} onChange={(e) => setV({ ...v, b: e.target.value })} placeholder={v.kind === "date" ? "12/31/2024" : "100"} /></div>}
            </>
          )}
          <label className="row small"><input type="checkbox" checked={v.allowBlank} onChange={(e) => setV({ ...v, allowBlank: e.target.checked })} /> Ignore blank</label>
          {v.kind === "list" && <label className="row small"><input type="checkbox" checked={v.dropdown} onChange={(e) => setV({ ...v, dropdown: e.target.checked })} /> In-cell drop-down</label>}
        </div>
      )}
      {tab === "message" && (
        <div className="field"><label>Message shown when the cell is selected</label><textarea rows={3} value={v.prompt ?? ""} onChange={(e) => setV({ ...v, prompt: e.target.value || undefined })} /></div>
      )}
      {tab === "error" && (
        <>
          <div className="field">
            <label>Style</label>
            <select value={v.error?.style ?? "stop"} onChange={(e) => setV({ ...v, error: { ...v.error, style: e.target.value as "stop" } })}>
              <option value="stop">Stop: refuse the value</option>
              <option value="warning">Warning: ask first</option>
              <option value="info">Information: allow, and say so</option>
            </select>
          </div>
          <div className="field"><label>Message</label><textarea rows={3} value={v.error?.message ?? ""} onChange={(e) => setV({ ...v, error: { style: v.error?.style ?? "stop", ...v.error, message: e.target.value || undefined } })} /></div>
        </>
      )}
    </Modal>
  );
}

const HIGHLIGHT_STYLES: { label: string; style: Conditional["style"] }[] = [
  { label: "Light red fill with dark red text", style: { fill: "#ffc7ce", color: "#9c0006" } },
  { label: "Yellow fill with dark yellow text", style: { fill: "#ffeb9c", color: "#9c5700" } },
  { label: "Green fill with dark green text", style: { fill: "#c6efce", color: "#006100" } },
  { label: "Light red fill", style: { fill: "#ffc7ce" } },
  { label: "Red text", style: { color: "#9c0006" } },
  { label: "Bold", style: { bold: true } },
];

function ConditionalDialog({ preset, op, ...p }: Props & { preset?: Conditional["kind"]; op?: string }) {
  const sel = p.sel.ranges[p.sel.ranges.length - 1]!;
  const [rule, setRule] = useState<Conditional>({ id: uid(), area: sel, kind: preset ?? "cell", op: op ?? (preset === "text" ? "contains" : preset === "date" ? "today" : ">"), a: "", style: HIGHLIGHT_STYLES[0]!.style, n: 10 });
  const [styleIndex, setStyleIndex] = useState(0);
  const needsStyle = !["scale", "bar", "icons"].includes(rule.kind);
  const save = () => {
    // bars, scales and icons show the values themselves: no highlight style
    const saved = { ...rule, area: sel, style: needsStyle ? rule.style : undefined };
    p.run(() => p.wb.transact("Conditional formatting", () => p.wb.setSheetProp(p.sheet, "conditionals", [...p.sheet.conditionals, saved])));
    p.onClose();
  };
  return (
    <Modal title="Conditional formatting" onClose={p.onClose} footer={<><span className="spacer" /><button onClick={p.onClose}>Cancel</button><button className="primary" onClick={save}>OK</button></>}>
      <p className="dim small">For {cellName(sel.r1, sel.c1)}{sel.r1 !== sel.r2 || sel.c1 !== sel.c2 ? `:${cellName(Math.min(sel.r2, 1_048_575), sel.c2)}` : ""}.</p>
      <div className="field">
        <label>Format cells that…</label>
        <select value={rule.kind} onChange={(e) => setRule({ ...rule, kind: e.target.value as Conditional["kind"], op: e.target.value === "text" ? "contains" : e.target.value === "date" ? "today" : ">" })}>
          <option value="cell">have a value that…</option>
          <option value="text">contain text…</option>
          <option value="date">have a date…</option>
          <option value="top">are in the top or bottom…</option>
          <option value="average">are above or below average</option>
          <option value="duplicate">are duplicates</option>
          <option value="unique">are unique</option>
          <option value="blank">are blank</option>
          <option value="noblank">are not blank</option>
          <option value="error">have errors</option>
          <option value="formula">make a formula TRUE</option>
          <option value="scale">all cells: colour scale</option>
          <option value="bar">all cells: data bars</option>
          <option value="icons">all cells: icon set</option>
        </select>
      </div>
      {rule.kind === "cell" && (
        <div className="row wrap" style={{ gap: 8 }}>
          <select value={rule.op} onChange={(e) => setRule({ ...rule, op: e.target.value })} aria-label="Comparison">
            {[[">", "greater than"], ["<", "less than"], [">=", "at least"], ["<=", "at most"], ["=", "equal to"], ["<>", "not equal to"], ["between", "between"], ["notBetween", "not between"]].map(([x, l]) => <option key={x} value={x}>{l}</option>)}
          </select>
          <input value={rule.a ?? ""} onChange={(e) => setRule({ ...rule, a: e.target.value })} placeholder="100 or =$B$1" autoFocus aria-label="Value" />
          {(rule.op === "between" || rule.op === "notBetween") && <input value={rule.b ?? ""} onChange={(e) => setRule({ ...rule, b: e.target.value })} placeholder="and" aria-label="Second value" />}
        </div>
      )}
      {rule.kind === "text" && (
        <div className="row wrap" style={{ gap: 8 }}>
          <select value={rule.op} onChange={(e) => setRule({ ...rule, op: e.target.value })} aria-label="How"><option value="contains">containing</option><option value="notContains">not containing</option><option value="begins">beginning with</option><option value="ends">ending with</option></select>
          <input value={rule.a ?? ""} onChange={(e) => setRule({ ...rule, a: e.target.value })} autoFocus aria-label="Text" />
        </div>
      )}
      {rule.kind === "date" && (
        <select value={rule.op} onChange={(e) => setRule({ ...rule, op: e.target.value })} aria-label="When"><option value="today">today</option><option value="yesterday">yesterday</option><option value="tomorrow">tomorrow</option><option value="last7">in the last 7 days</option><option value="past">in the past</option><option value="future">in the future</option></select>
      )}
      {rule.kind === "top" && (
        <div className="row wrap" style={{ gap: 8 }}>
          <select value={rule.bottom ? "bottom" : "top"} onChange={(e) => setRule({ ...rule, bottom: e.target.value === "bottom" })} aria-label="Top or bottom"><option value="top">Top</option><option value="bottom">Bottom</option></select>
          <input type="number" min={1} value={rule.n ?? 10} onChange={(e) => setRule({ ...rule, n: Number(e.target.value) })} style={{ width: 80 }} aria-label="How many" />
          <label className="row small"><input type="checkbox" checked={Boolean(rule.percent)} onChange={(e) => setRule({ ...rule, percent: e.target.checked })} /> percent</label>
        </div>
      )}
      {rule.kind === "average" && (
        <select value={rule.above === false ? "below" : "above"} onChange={(e) => setRule({ ...rule, above: e.target.value === "above" })} aria-label="Above or below"><option value="above">above average</option><option value="below">below average</option></select>
      )}
      {rule.kind === "formula" && (
        <div className="field">
          <label>Formula</label>
          <input className="mono" value={rule.formula ?? ""} onChange={(e) => setRule({ ...rule, formula: e.target.value })} placeholder={`=$${colName(sel.c1)}${sel.r1 + 1}>100`} autoFocus />
          <span className="help">Written for the first cell, {cellName(sel.r1, sel.c1)}; it moves with each cell. Use $ to fix a column or row.</span>
        </div>
      )}
      {rule.kind === "scale" && (
        <select value={(rule.colors ?? ["#f8696b", "#ffeb84", "#63be7b"]).join()} onChange={(e) => setRule({ ...rule, colors: e.target.value.split(",") })} aria-label="Colours">
          <option value="#f8696b,#ffeb84,#63be7b">Red, yellow, green</option>
          <option value="#63be7b,#ffeb84,#f8696b">Green, yellow, red</option>
          <option value="#ffffff,#63be7b">White to green</option>
          <option value="#ffffff,#5a8ac6">White to blue</option>
          <option value="#f8696b,#ffffff,#5a8ac6">Red, white, blue</option>
        </select>
      )}
      {rule.kind === "bar" && (
        <select value={rule.colors?.[0] ?? "#638ec6"} onChange={(e) => setRule({ ...rule, colors: [e.target.value] })} aria-label="Bar colour">
          <option value="#638ec6">Blue</option><option value="#63c384">Green</option><option value="#ff555a">Red</option><option value="#ffb628">Orange</option><option value="#d6007b">Purple</option>
        </select>
      )}
      {rule.kind === "icons" && (
        <select value={rule.icons ?? "traffic"} onChange={(e) => setRule({ ...rule, icons: e.target.value as Conditional["icons"] })} aria-label="Icons">
          <option value="traffic">Traffic lights</option><option value="arrows">Arrows</option><option value="flags">Flags</option><option value="stars">Stars</option>
        </select>
      )}
      {needsStyle && (
        <div className="field" style={{ marginTop: 10 }}>
          <label>With</label>
          <select value={styleIndex} onChange={(e) => { const i = Number(e.target.value); setStyleIndex(i); setRule({ ...rule, style: HIGHLIGHT_STYLES[i]!.style }); }}>
            {HIGHLIGHT_STYLES.map((s, i) => <option key={i} value={i}>{s.label}</option>)}
          </select>
          <span className="sheet-cf-sample" style={{ background: rule.style?.fill, color: rule.style?.color, fontWeight: rule.style?.bold ? 700 : undefined }}>AaBbCc 123</span>
        </div>
      )}
    </Modal>
  );
}

function RulesDialog(p: Props) {
  const [, tick] = useState(0);
  const describe = (r: Conditional) => {
    const where = `${cellName(r.area.r1, r.area.c1)}:${cellName(Math.min(r.area.r2, 1_048_575), r.area.c2)}`;
    const what = r.kind === "cell" ? `Value ${r.op} ${r.a}${r.b ? ` and ${r.b}` : ""}` : r.kind === "text" ? `Text ${r.op} “${r.a}”` : r.kind === "top" ? `${r.bottom ? "Bottom" : "Top"} ${r.n}${r.percent ? "%" : ""}` : r.kind === "formula" ? r.formula : r.kind === "scale" ? "Colour scale" : r.kind === "bar" ? "Data bars" : r.kind === "icons" ? "Icon set" : r.kind === "average" ? (r.above === false ? "Below average" : "Above average") : r.kind;
    return { where, what };
  };
  const list = p.sheet.conditionals;
  const update = (next: Conditional[]) => {
    p.run(() => p.wb.transact("Conditional formatting", () => p.wb.setSheetProp(p.sheet, "conditionals", next)));
    tick((t) => t + 1);
  };
  return (
    <Modal title="Conditional formatting rules" onClose={p.onClose} wide footer={<><span className="spacer" /><button className="primary" onClick={p.onClose}>Done</button></>}>
      {list.length === 0 && <p className="dim">This sheet has no rules.</p>}
      <ul className="sheet-format-list tall">
        {list.map((r, i) => {
          const d = describe(r);
          return (
            <li key={r.id}>
              <div className="sheet-name-row">
                <span className="sheet-cf-sample" style={{ background: r.style?.fill, color: r.style?.color, fontWeight: r.style?.bold ? 700 : undefined }}>Aa</span>
                <b className="mono">{d.where}</b>
                <span className="ellipsis">{d.what}</span>
                <span className="spacer" />
                <label className="row tiny" title="Rules after this one are not applied where it matches"><input type="checkbox" checked={Boolean(r.stop)} onChange={(e) => update(list.map((x) => (x.id === r.id ? { ...x, stop: e.target.checked } : x)))} /> Stop if true</label>
                <button className="ghost icon-only small" disabled={i === 0} aria-label="Move up" onClick={() => update(list.map((x, j) => (j === i - 1 ? r : j === i ? list[i - 1]! : x)))}><Icon name="arrowUp" size={11} /></button>
                <button className="ghost icon-only small" disabled={i === list.length - 1} aria-label="Move down" onClick={() => update(list.map((x, j) => (j === i + 1 ? r : j === i ? list[i + 1]! : x)))}><Icon name="arrowDown" size={11} /></button>
                <button className="ghost icon-only small" aria-label="Delete rule" onClick={() => update(list.filter((x) => x.id !== r.id))}><Icon name="trash" size={11} /></button>
              </div>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

function SplitDialog(p: Props) {
  const sel = p.sel.ranges[p.sel.ranges.length - 1]!;
  const used = { ...sel, r2: Math.min(sel.r2, p.wb.bounds(p.sheet).rows - 1), c2: sel.c1 };
  const [delims, setDelims] = useState<string[]>([","]);
  const [other, setOther] = useState("");
  const [fixed, setFixed] = useState(false);
  const [widths, setWidths] = useState("10,10");
  const [consecutive, setConsecutive] = useState(false);
  const [asText, setAsText] = useState(false);
  const sample = [...Array(Math.min(5, used.r2 - used.r1 + 1)).keys()].map((i) => p.wb.display(p.sheet, used.r1 + i, used.c1).text);
  const toggle = (d: string) => setDelims(delims.includes(d) ? delims.filter((x) => x !== d) : [...delims, d]);
  return (
    <Modal title="Text to columns" onClose={p.onClose} footer={<><span className="spacer" /><button onClick={p.onClose}>Cancel</button><button className="primary" onClick={() => {
      p.run(() => textToColumns(p.wb, p.sheet, used, { delimiters: fixed ? [] : delims, other: fixed ? undefined : other || undefined, consecutive, quote: '"', widths: fixed ? widths.split(",").map(Number).filter((n) => n > 0) : undefined, asText }));
      p.onClose();
    }}>Split</button></>}>
      <p className="dim small">Splits column {colName(used.c1)} ({(used.r2 - used.r1 + 1).toLocaleString()} rows) into the columns to its right, replacing what is there.</p>
      <div className="segmented" style={{ marginBottom: 10 }}>
        <button className={!fixed ? "active" : ""} onClick={() => setFixed(false)}>Delimited</button>
        <button className={fixed ? "active" : ""} onClick={() => setFixed(true)}>Fixed width</button>
      </div>
      {!fixed ? (
        <div className="row wrap small" style={{ gap: 14 }}>
          {[["\t", "Tab"], [";", "Semicolon"], [",", "Comma"], [" ", "Space"], ["|", "Pipe"]].map(([d, l]) => <label key={l} className="row"><input type="checkbox" checked={delims.includes(d!)} onChange={() => toggle(d!)} /> {l}</label>)}
          <label className="row">Other <input value={other} onChange={(e) => setOther(e.target.value.slice(0, 1))} style={{ width: 40 }} /></label>
          <label className="row"><input type="checkbox" checked={consecutive} onChange={(e) => setConsecutive(e.target.checked)} /> Treat consecutive delimiters as one</label>
        </div>
      ) : (
        <div className="field"><label>Column widths (characters, separated by commas)</label><input value={widths} onChange={(e) => setWidths(e.target.value)} /></div>
      )}
      <label className="row small" style={{ marginTop: 8 }}><input type="checkbox" checked={asText} onChange={(e) => setAsText(e.target.checked)} /> Keep every piece as text (no numbers or dates)</label>
      <pre className="sheet-split-preview">{sample.join("\n")}</pre>
    </Modal>
  );
}

function DedupeDialog(p: Props) {
  const a = area(p);
  const [header, setHeader] = useState(() => isHeaderRow(p.wb, p.sheet, a, a.c1));
  const cols = [...Array(a.c2 - a.c1 + 1).keys()].map((i) => a.c1 + i);
  const [chosen, setChosen] = useState<Set<number>>(new Set(cols));
  return (
    <Modal title="Remove duplicates" onClose={p.onClose} footer={<><span className="spacer" /><button onClick={p.onClose}>Cancel</button><button className="primary" disabled={!chosen.size} onClick={() => {
      p.run(() => {
        const r = removeDuplicates(p.wb, p.sheet, a, [...chosen], header);
        p.notify(r.removed ? `Removed ${r.removed.toLocaleString()} duplicate ${r.removed === 1 ? "row" : "rows"}; ${r.left.toLocaleString()} unique rows remain.` : "No duplicates found.", "ok");
      });
      p.onClose();
    }}>Remove duplicates</button></>}>
      <p className="dim small">Rows of {cellName(a.r1, a.c1)}:{cellName(a.r2, a.c2)} that repeat an earlier row in the chosen columns are removed (any case).</p>
      <label className="row small"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> My data has headers</label>
      <div className="sheet-check-list">
        {cols.map((c) => <label key={c} className="row small"><input type="checkbox" checked={chosen.has(c)} onChange={(e) => { const n = new Set(chosen); e.target.checked ? n.add(c) : n.delete(c); setChosen(n); }} /> {label(p.wb, p.sheet, a, c, header)}</label>)}
      </div>
    </Modal>
  );
}

function TableDialog(p: Props) {
  const a = area(p);
  const [ref, setRef] = useState(`${cellName(a.r1, a.c1)}:${cellName(a.r2, a.c2)}`);
  const [header, setHeader] = useState(true);
  const [style, setStyle] = useState("blue");
  return (
    <Modal title="Format as table" onClose={p.onClose} footer={<><span className="spacer" /><button onClick={p.onClose}>Cancel</button><button className="primary" onClick={() => {
      const target = parseArea(ref);
      if (!target) return p.notify("Type the table's range, such as A1:D20.", "error");
      p.run(() => {
        const t = createTable(p.wb, p.sheet, target, header, style);
        p.notify(`Made ${t.name}. Use it in formulas as ${t.name}[Column] or [@Column].`, "ok");
      });
      p.onClose();
    }}>OK</button></>}>
      <div className="field"><label htmlFor="table-ref">Where is the data?</label><input id="table-ref" className="mono" value={ref} onChange={(e) => setRef(e.target.value)} autoFocus /></div>
      <label className="row small"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> My table has headers</label>
      <div className="sheet-table-styles">
        {Object.entries(TABLE_STYLES).map(([id, t]) => (
          <button key={id} className={style === id ? "on" : ""} onClick={() => setStyle(id)} aria-label={`${id} style`}>
            <span style={{ background: t.header }} />
            <span style={{ background: t.band }} />
            <span />
            <span style={{ background: t.band }} />
          </button>
        ))}
      </div>
    </Modal>
  );
}

function PivotDialog({ onPivot, onSwitch, ...p }: Props & { onPivot: (sheet: Sheet, pivot: PivotDef) => void; onSwitch: (uid: number) => void }) {
  const a = area(p);
  const [ref, setRef] = useState(`${cellName(a.r1, a.c1)}:${cellName(a.r2, a.c2)}`);
  const [where, setWhere] = useState<"new" | "here">("new");
  const [at, setAt] = useState(cellName(0, a.c2 + 2));
  return (
    <Modal title="PivotTable" onClose={p.onClose} footer={<><span className="spacer" /><button onClick={p.onClose}>Cancel</button><button className="primary" onClick={() => {
      const source = parseArea(ref);
      if (!source || source.r2 === source.r1) return p.notify("Choose a range with a header row and at least one row of data.", "error");
      p.run(() => {
        let target = p.sheet;
        let row = 0;
        let col = 0;
        if (where === "new") target = p.wb.transact("New sheet", () => p.wb.addSheet(undefined, p.wb.sheets.indexOf(p.sheet)));
        else {
          const cell = parseArea(at);
          if (!cell) throw new Error("Type the cell to put the PivotTable at, such as H1.");
          row = cell.r1;
          col = cell.c1;
        }
        // start with the first text column as rows and the first number column as values
        const pivot: PivotDef = { id: uid(), source: { sheet: p.sheet.uid, area: source }, row, col, rows: [], cols: [], values: [], filters: [], totals: true };
        let textCol = -1;
        let numCol = -1;
        for (let c = source.c1; c <= source.c2; c++) {
          const v = p.wb.value(p.sheet, source.r1 + 1, c);
          if (textCol < 0 && typeof v === "string") textCol = c - source.c1;
          if (numCol < 0 && typeof v === "number") numCol = c - source.c1;
        }
        if (textCol >= 0) pivot.rows = [textCol];
        if (numCol >= 0) pivot.values = [{ col: numCol, fn: "sum" }];
        const built = buildPivot(p.wb, target, pivot);
        if (target !== p.sheet) onSwitch(target.uid);
        onPivot(target, built);
      });
      p.onClose();
    }}>Create</button></>}>
      <div className="field"><label htmlFor="pivot-ref">Data (with a header row)</label><input id="pivot-ref" className="mono" value={ref} onChange={(e) => setRef(e.target.value)} autoFocus /></div>
      <label className="row small"><input type="radio" checked={where === "new"} onChange={() => setWhere("new")} /> On a new sheet</label>
      <label className="row small"><input type="radio" checked={where === "here"} onChange={() => setWhere("here")} /> On this sheet, at <input className="mono" value={at} onChange={(e) => setAt(e.target.value)} style={{ width: 80 }} onFocus={() => setWhere("here")} /></label>
    </Modal>
  );
}

/** The PivotTable fields pane: pick rows, columns, values and filters. */
export function PivotPanel({ wb, sheet, pivot, onClose, run }: { wb: Workbook; sheet: Sheet; pivot: PivotDef; onClose: () => void; run: (fn: () => void) => void }) {
  const fields = pivotFields(wb, pivot);
  const src = wb.sheet(pivot.source.sheet);
  const update = (next: PivotDef) => run(() => buildPivot(wb, sheet, next));
  const used = (i: number) => pivot.rows.includes(i) || pivot.cols.includes(i) || pivot.values.some((v) => v.col === i) || pivot.filters.some((f) => f.col === i);
  const zone = (title: string, items: ReactNode, empty: string) => (
    <div className="pivot-zone">
      <h4>{title}</h4>
      {items}
      {!items || (Array.isArray(items) && !items.length) ? <p className="faint tiny">{empty}</p> : null}
    </div>
  );
  const chip = (text: string, onRemove: () => void, extra?: ReactNode, onUp?: () => void) => (
    <div className="pivot-chip">
      <span className="ellipsis">{text}</span>
      {extra}
      {onUp && <button className="ghost icon-only small" onClick={onUp} aria-label="Move up"><Icon name="arrowUp" size={10} /></button>}
      <button className="ghost icon-only small" onClick={onRemove} aria-label={`Remove ${text}`}><Icon name="close" size={10} /></button>
    </div>
  );
  return (
    <aside className="pivot-panel" aria-label="PivotTable fields">
      <div className="pivot-head">
        <b>PivotTable fields</b>
        <span className="spacer" />
        <button className="ghost icon-only small" title="Refresh from the source data" aria-label="Refresh" onClick={() => update(pivot)}><Icon name="refresh" size={12} /></button>
        <button className="ghost icon-only small" aria-label="Close" onClick={onClose}><Icon name="close" size={12} /></button>
      </div>
      <p className="faint tiny">Source: {src?.name}!{cellName(pivot.source.area.r1, pivot.source.area.c1)}:{cellName(pivot.source.area.r2, pivot.source.area.c2)}</p>
      <ul className="pivot-fields">
        {fields.map((f, i) => (
          <li key={i}>
            <label className="row small">
              <input type="checkbox" checked={used(i)} onChange={(e) => {
                if (!e.target.checked) update({ ...pivot, rows: pivot.rows.filter((x) => x !== i), cols: pivot.cols.filter((x) => x !== i), values: pivot.values.filter((v) => v.col !== i), filters: pivot.filters.filter((x) => x.col !== i) });
                else {
                  const sample = src ? wb.value(src, pivot.source.area.r1 + 1, pivot.source.area.c1 + i) : null;
                  update(typeof sample === "number" ? { ...pivot, values: [...pivot.values, { col: i, fn: "sum" }] } : { ...pivot, rows: [...pivot.rows, i] });
                }
              }} />
              <span className="ellipsis">{f}</span>
            </label>
            <span className="pivot-add">
              <button className="ghost small" title="Add to rows" onClick={() => update({ ...pivot, rows: [...pivot.rows.filter((x) => x !== i), i], cols: pivot.cols.filter((x) => x !== i) })}>R</button>
              <button className="ghost small" title="Add to columns" onClick={() => update({ ...pivot, cols: [...pivot.cols.filter((x) => x !== i), i], rows: pivot.rows.filter((x) => x !== i) })}>C</button>
              <button className="ghost small" title="Add to values" onClick={() => update({ ...pivot, values: [...pivot.values, { col: i, fn: "sum" }] })}>Σ</button>
              <button className="ghost small" title="Add as a filter" onClick={() => update({ ...pivot, filters: [...pivot.filters.filter((x) => x.col !== i), { col: i, values: null }] })}>F</button>
            </span>
          </li>
        ))}
      </ul>
      {zone("Filters", pivot.filters.map((f, k) => {
        const options = src ? columnValues(wb, src, pivot.source.area.c1 + f.col, pivot.source.area).map((v) => v.text) : [];
        return (
          <div key={k}>
            {chip(fields[f.col] ?? "?", () => update({ ...pivot, filters: pivot.filters.filter((_, j) => j !== k) }))}
            <select className="pivot-filter" value={f.values?.[0] ?? ""} onChange={(e) => update({ ...pivot, filters: pivot.filters.map((x, j) => (j === k ? { ...x, values: e.target.value ? [e.target.value] : null } : x)) })} aria-label={`Filter ${fields[f.col]}`}>
              <option value="">(All)</option>
              {options.map((o) => <option key={o} value={o}>{o || "(blank)"}</option>)}
            </select>
          </div>
        );
      }), "Add a field to show only some of the data.")}
      {zone("Columns", pivot.cols.map((c, k) => <div key={k}>{chip(fields[c] ?? "?", () => update({ ...pivot, cols: pivot.cols.filter((_, j) => j !== k) }), undefined, k ? () => update({ ...pivot, cols: pivot.cols.map((x, j) => (j === k - 1 ? c : j === k ? pivot.cols[k - 1]! : x)) }) : undefined)}</div>), "Fields across the top.")}
      {zone("Rows", pivot.rows.map((c, k) => <div key={k}>{chip(fields[c] ?? "?", () => update({ ...pivot, rows: pivot.rows.filter((_, j) => j !== k) }), undefined, k ? () => update({ ...pivot, rows: pivot.rows.map((x, j) => (j === k - 1 ? c : j === k ? pivot.rows[k - 1]! : x)) }) : undefined)}</div>), "Fields down the side.")}
      {zone("Values", pivot.values.map((v, k) => (
        <div key={k}>
          {chip(fields[v.col] ?? "?", () => update({ ...pivot, values: pivot.values.filter((_, j) => j !== k) }), (
            <select className="pivot-fn" value={v.fn} onChange={(e) => update({ ...pivot, values: pivot.values.map((x, j) => (j === k ? { ...x, fn: e.target.value as typeof v.fn } : x)) })} aria-label="Summarize by">
              {Object.entries(AGG_LABELS).map(([id, l]) => <option key={id} value={id}>{l}</option>)}
            </select>
          ))}
        </div>
      )), "Fields to add up, count or average.")}
      <label className="row tiny"><input type="checkbox" checked={pivot.totals} onChange={(e) => update({ ...pivot, totals: e.target.checked })} /> Grand totals</label>
    </aside>
  );
}

// ------------------------------------------------------------------------------------ charts

const CHART_KINDS: { id: ChartDef["kind"]; label: string }[] = [
  { id: "column", label: "Column" }, { id: "stacked", label: "Stacked column" }, { id: "bar", label: "Bar" }, { id: "line", label: "Line" },
  { id: "area", label: "Area" }, { id: "pie", label: "Pie" }, { id: "doughnut", label: "Doughnut" }, { id: "scatter", label: "Scatter" },
];

function ChartDialog({ chart, ...p }: Props & { chart?: ChartDef }) {
  const a = area(p);
  const [c, setC] = useState<ChartDef>(chart ?? { id: uid(), kind: "column", data: a, title: "", x: 0, y: 0, w: 480, h: 300, legend: true });
  const [ref, setRef] = useState(`${cellName(c.data.r1, c.data.c1)}:${cellName(c.data.r2, c.data.c2)}`);
  const save = () => {
    const data = parseArea(ref);
    if (!data) return p.notify("Type the chart's data range, such as A1:C10.", "error");
    p.run(() => p.wb.transact(chart ? "Edit chart" : "Insert chart", () => {
      // a new chart goes just right of the data around it, level with its top
      const around = region(p.wb, p.sheet, data.r1, data.c1);
      let x = 0;
      for (let col = 0; col <= Math.max(data.c2, around.c2) + 1; col++) x += p.sheet.hiddenCols.has(col) ? 0 : (p.sheet.colWidths.get(col) ?? 96);
      let y = 0;
      for (let row = 0; row < data.r1; row++) y += p.sheet.hiddenRows.has(row) || p.sheet.filterHidden.has(row) ? 0 : (p.sheet.rowHeights.get(row) ?? 24);
      const placed = chart ? { ...c, data } : { ...c, data, x: x + 12, y: y + 4 };
      p.wb.setSheetProp(p.sheet, "charts", [...p.sheet.charts.filter((x) => x.id !== c.id), placed]);
    }));
    p.onClose();
  };
  const preview = useMemo(() => {
    const data = parseArea(ref);
    return data ? { ...c, data } : null;
  }, [c, ref]);
  return (
    <Modal title={chart ? "Edit chart" : "Insert chart"} onClose={p.onClose} wide footer={
      <>
        {chart && <button className="danger" onClick={() => { p.run(() => p.wb.transact("Delete chart", () => p.wb.setSheetProp(p.sheet, "charts", p.sheet.charts.filter((x) => x.id !== chart.id)))); p.onClose(); }}>Delete chart</button>}
        <span className="spacer" />
        <button onClick={p.onClose}>Cancel</button>
        <button className="primary" onClick={save}>{chart ? "Save" : "Insert"}</button>
      </>
    }>
      <div className="sheet-chart-kinds">
        {CHART_KINDS.map((k) => <button key={k.id} className={c.kind === k.id ? "on" : ""} onClick={() => setC({ ...c, kind: k.id })}>{k.label}</button>)}
      </div>
      <div className="sheet-format-grid">
        <div className="field"><label htmlFor="chart-ref">Data</label><input id="chart-ref" className="mono" value={ref} onChange={(e) => setRef(e.target.value)} /></div>
        <div className="field"><label htmlFor="chart-title">Title</label><input id="chart-title" value={c.title} onChange={(e) => setC({ ...c, title: e.target.value })} placeholder="Chart title" /></div>
        <label className="row small"><input type="checkbox" checked={Boolean(c.byRows)} onChange={(e) => setC({ ...c, byRows: e.target.checked })} /> Series in rows</label>
        <label className="row small"><input type="checkbox" checked={c.legend} onChange={(e) => setC({ ...c, legend: e.target.checked })} /> Legend</label>
      </div>
      {preview && <div className="sheet-chart-preview"><ChartSvg wb={p.wb} sheet={p.sheet} chart={preview} width={560} height={260} /></div>}
    </Modal>
  );
}

function ticks(min: number, max: number, count = 5): number[] {
  if (min === max) return [min];
  const step0 = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 0.001; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

export function ChartSvg({ wb, sheet, chart, width, height }: { wb: Workbook; sheet: Sheet; chart: ChartDef; width: number; height: number }) {
  const { categories, series } = chartData(wb, sheet, chart.data, chart.byRows);
  const title = chart.title;
  const top = title ? 34 : 14;
  const legendH = chart.legend && chart.kind !== "pie" && chart.kind !== "doughnut" ? 22 : 0;
  const pie = chart.kind === "pie" || chart.kind === "doughnut";
  const fmt = (n: number) => formatValue(n, Math.abs(n) >= 1000 ? "#,##0" : "General").text;
  if (!series.length || !categories.length) return <svg width={width} height={height}><text x={width / 2} y={height / 2} textAnchor="middle" className="chart-empty">Choose cells with numbers to chart</text></svg>;
  if (pie) {
    const s = series[0]!;
    const total = s.values.reduce((t, v) => t + (Number.isFinite(v) && v > 0 ? v : 0), 0) || 1;
    const cx = width * 0.38;
    const cy = top + (height - top) / 2;
    const r = Math.min(width * 0.32, (height - top) / 2 - 8);
    let angle = -Math.PI / 2;
    const colors = ["#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47", "#264478", "#9e480e", "#636363", "#997300"];
    return (
      <svg width={width} height={height} role="img" aria-label={title || "Pie chart"}>
        {title && <text x={width / 2} y={22} textAnchor="middle" className="chart-title">{title}</text>}
        {s.values.map((v, i) => {
          if (!Number.isFinite(v) || v <= 0) return null;
          const a0 = angle;
          const a1 = angle + (v / total) * Math.PI * 2;
          angle = a1;
          const large = a1 - a0 > Math.PI ? 1 : 0;
          const inner = chart.kind === "doughnut" ? r * 0.55 : 0;
          const p = (rad: number, a: number) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
          const d = inner
            ? `M${p(r, a0)} A${r},${r} 0 ${large} 1 ${p(r, a1)} L${p(inner, a1)} A${inner},${inner} 0 ${large} 0 ${p(inner, a0)} Z`
            : `M${cx},${cy} L${p(r, a0)} A${r},${r} 0 ${large} 1 ${p(r, a1)} Z`;
          return <path key={i} d={d} fill={colors[i % colors.length]} stroke="var(--sh-bg)" strokeWidth={1.5}><title>{`${categories[i]}: ${fmt(v)} (${((v / total) * 100).toFixed(1)}%)`}</title></path>;
        })}
        {categories.slice(0, 14).map((c, i) => (
          <g key={i} transform={`translate(${width * 0.74},${top + 8 + i * 18})`}>
            <rect width={10} height={10} rx={2} fill={colors[i % colors.length]} />
            <text x={16} y={9} className="chart-label">{c.length > 18 ? c.slice(0, 17) + "…" : c}</text>
          </g>
        ))}
      </svg>
    );
  }
  const left = 52;
  const right = 14;
  const bottom = 34 + legendH;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const horizontal = chart.kind === "bar";
  const stacked = chart.kind === "stacked";
  const values = series.flatMap((s) => s.values.filter(Number.isFinite));
  let lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  if (stacked) {
    hi = Math.max(0, ...categories.map((_, i) => series.reduce((t, s) => t + (Number.isFinite(s.values[i]!) && s.values[i]! > 0 ? s.values[i]! : 0), 0)));
    lo = Math.min(0, ...categories.map((_, i) => series.reduce((t, s) => t + (Number.isFinite(s.values[i]!) && s.values[i]! < 0 ? s.values[i]! : 0), 0)));
  }
  if (chart.kind === "scatter") {
    const xs = categories.map((c, i) => Number(c.replace(/,/g, "")) || i + 1);
    const tx = ticks(Math.min(...xs), Math.max(...xs));
    const ty = ticks(lo, hi);
    const x = (v: number) => left + ((v - tx[0]!) / (tx[tx.length - 1]! - tx[0]! || 1)) * plotW;
    const y = (v: number) => top + plotH - ((v - ty[0]!) / (ty[ty.length - 1]! - ty[0]! || 1)) * plotH;
    return (
      <svg width={width} height={height} role="img" aria-label={title || "Scatter chart"}>
        {title && <text x={width / 2} y={22} textAnchor="middle" className="chart-title">{title}</text>}
        {ty.map((t) => <g key={t}><line x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} className="chart-grid" /><text x={left - 6} y={y(t) + 4} textAnchor="end" className="chart-label">{fmt(t)}</text></g>)}
        {tx.map((t) => <text key={t} x={x(t)} y={top + plotH + 16} textAnchor="middle" className="chart-label">{fmt(t)}</text>)}
        {series.map((s) => s.values.map((v, i) => (Number.isFinite(v) ? <circle key={`${s.name}${i}`} cx={x(xs[i]!)} cy={y(v)} r={3.5} fill={s.color}><title>{`${xs[i]}, ${fmt(v)}`}</title></circle> : null)))}
        <Legend series={series} show={chart.legend} y={height - 14} width={width} />
      </svg>
    );
  }
  const t = ticks(lo, hi);
  const tlo = t[0]!;
  const thi = t[t.length - 1]!;
  const scale = (v: number) => (thi === tlo ? 0 : ((v - tlo) / (thi - tlo)) * (horizontal ? plotW : plotH));
  const band = (horizontal ? plotH : plotW) / categories.length;
  const groups = stacked ? 1 : series.length;
  const barW = Math.max(1, (band * 0.72) / (chart.kind === "line" || chart.kind === "area" ? 1 : groups));
  const zero = scale(0);
  return (
    <svg width={width} height={height} role="img" aria-label={title || "Chart"}>
      {title && <text x={width / 2} y={22} textAnchor="middle" className="chart-title">{title}</text>}
      {t.map((v) =>
        horizontal ? (
          <g key={v}><line y1={top} y2={top + plotH} x1={left + scale(v)} x2={left + scale(v)} className="chart-grid" /><text y={top + plotH + 16} x={left + scale(v)} textAnchor="middle" className="chart-label">{fmt(v)}</text></g>
        ) : (
          <g key={v}><line x1={left} x2={left + plotW} y1={top + plotH - scale(v)} y2={top + plotH - scale(v)} className="chart-grid" /><text x={left - 6} y={top + plotH - scale(v) + 4} textAnchor="end" className="chart-label">{fmt(v)}</text></g>
        ),
      )}
      {categories.map((c, i) => {
        const every = Math.ceil(categories.length / Math.max(1, Math.floor((horizontal ? plotH : plotW) / 60)));
        if (i % every) return null;
        return horizontal ? (
          <text key={i} x={left - 6} y={top + band * i + band / 2 + 4} textAnchor="end" className="chart-label">{c.length > 10 ? c.slice(0, 9) + "…" : c}</text>
        ) : (
          <text key={i} x={left + band * i + band / 2} y={top + plotH + 16} textAnchor="middle" className="chart-label">{c.length > 12 ? c.slice(0, 11) + "…" : c}</text>
        );
      })}
      {(chart.kind === "line" || chart.kind === "area") &&
        series.map((s) => {
          const pts = s.values.map((v, i) => (Number.isFinite(v) ? [left + band * i + band / 2, top + plotH - scale(v)] : null)).filter((p): p is number[] => p !== null);
          const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join("");
          return (
            <g key={s.name}>
              {chart.kind === "area" && pts.length > 1 && <path d={`${line}L${pts[pts.length - 1]![0]},${top + plotH - zero}L${pts[0]![0]},${top + plotH - zero}Z`} fill={s.color} opacity={0.25} />}
              <path d={line} fill="none" stroke={s.color} strokeWidth={2.2} strokeLinejoin="round" />
              {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={2.6} fill={s.color} />)}
            </g>
          );
        })}
      {(chart.kind === "column" || chart.kind === "bar" || chart.kind === "stacked") &&
        categories.map((_, i) => {
          let up = 0;
          let down = 0;
          return series.map((s, k) => {
            const v = s.values[i]!;
            if (!Number.isFinite(v)) return null;
            let from: number;
            let to: number;
            if (stacked) {
              from = v >= 0 ? up : down;
              to = from + v;
              if (v >= 0) up = to;
              else down = to;
            } else {
              from = 0;
              to = v;
            }
            const a = scale(Math.min(from, to));
            const b = scale(Math.max(from, to));
            const offset = band * i + (band - barW * groups) / 2 + (stacked ? 0 : barW * k);
            return horizontal ? (
              <rect key={k} x={left + a} y={top + offset} width={Math.max(0.5, b - a)} height={barW - 1} fill={s.color} rx={1.5}><title>{`${s.name}, ${categories[i]}: ${fmt(v)}`}</title></rect>
            ) : (
              <rect key={k} x={left + offset} y={top + plotH - b} width={barW - 1} height={Math.max(0.5, b - a)} fill={s.color} rx={1.5}><title>{`${s.name}, ${categories[i]}: ${fmt(v)}`}</title></rect>
            );
          });
        })}
      <line x1={left} x2={left + (horizontal ? scale(0) : plotW)} y1={top + plotH - (horizontal ? 0 : zero)} y2={top + plotH - (horizontal ? 0 : zero)} className="chart-axis" />
      <Legend series={series} show={chart.legend} y={height - 12} width={width} />
    </svg>
  );
}

function Legend({ series, show, y, width }: { series: { name: string; color: string }[]; show: boolean; y: number; width: number }) {
  if (!show || series.length < 1) return null;
  const items = series.slice(0, 8);
  const w = Math.min(140, width / items.length);
  const start = (width - w * items.length) / 2;
  return (
    <g>
      {items.map((s, i) => (
        <g key={s.name + i} transform={`translate(${start + i * w},${y - 9})`}>
          <rect width={10} height={10} rx={2} fill={s.color} />
          <text x={14} y={9} className="chart-label">{s.name.length > 16 ? s.name.slice(0, 15) + "…" : s.name}</text>
        </g>
      ))}
    </g>
  );
}

/** Charts float over the grid; drag to move, drag the corner to resize, double-click to edit. */
export function ChartLayer({ wb, sheet, scrollX, scrollY, offsetX, offsetY, selected, onSelect, onEdit }: { wb: Workbook; sheet: Sheet; scrollX: number; scrollY: number; offsetX: number; offsetY: number; selected: string | null; onSelect: (id: string | null) => void; onEdit: (c: ChartDef) => void }) {
  const [moving, setMoving] = useState<{ id: string; dx: number; dy: number; resize: boolean; start: { x: number; y: number; w: number; h: number } } | null>(null);
  const [live, setLive] = useState<{ id: string; x: number; y: number; w: number; h: number } | null>(null);
  if (!sheet.charts.length) return null;
  return (
    <>
      {sheet.charts.map((c) => {
        const box = live?.id === c.id ? live : c;
        return (
          <div
            key={c.id}
            className={`sheet-chart ${selected === c.id ? "selected" : ""}`}
            style={{ left: offsetX + box.x - scrollX, top: offsetY + box.y - scrollY, width: box.w, height: box.h }}
            onPointerDown={(e) => {
              e.stopPropagation();
              onSelect(c.id);
              const resize = (e.target as HTMLElement).classList.contains("sheet-chart-grip");
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              setMoving({ id: c.id, dx: e.clientX, dy: e.clientY, resize, start: { x: c.x, y: c.y, w: c.w, h: c.h } });
            }}
            onPointerMove={(e) => {
              if (!moving || moving.id !== c.id) return;
              const dx = e.clientX - moving.dx;
              const dy = e.clientY - moving.dy;
              setLive(moving.resize ? { id: c.id, x: moving.start.x, y: moving.start.y, w: Math.max(200, moving.start.w + dx), h: Math.max(140, moving.start.h + dy) } : { id: c.id, x: Math.max(0, moving.start.x + dx), y: Math.max(0, moving.start.y + dy), w: moving.start.w, h: moving.start.h });
            }}
            onPointerUp={() => {
              if (live && moving) wb.transact(moving.resize ? "Resize chart" : "Move chart", () => wb.setSheetProp(sheet, "charts", sheet.charts.map((x) => (x.id === live.id ? { ...x, ...live } : x))));
              setMoving(null);
              setLive(null);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onEdit(c);
            }}
          >
            <ChartSvg wb={wb} sheet={sheet} chart={c} width={box.w - 2} height={box.h - 2} />
            {selected === c.id && <span className="sheet-chart-grip" aria-hidden="true" />}
          </div>
        );
      })}
    </>
  );
}

function PasteSpecial({ onClose, onPaste }: { onClose: () => void; onPaste: (mode: PasteMode, skipBlanks: boolean) => void }) {
  const [mode, setMode] = useState<PasteMode>("values");
  const [skip, setSkip] = useState(false);
  return (
    <Modal title="Paste special" onClose={onClose} footer={<><span className="spacer" /><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => { onPaste(mode, skip); onClose(); }}>OK</button></>}>
      {([["all", "All"], ["formulas", "Formulas"], ["values", "Values"], ["formats", "Formats"], ["transpose", "Transpose"]] as [PasteMode, string][]).map(([m, l]) => (
        <label key={m} className="row small"><input type="radio" checked={mode === m} onChange={() => setMode(m)} /> {l}</label>
      ))}
      <label className="row small" style={{ marginTop: 8 }}><input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} /> Skip blanks</label>
    </Modal>
  );
}
