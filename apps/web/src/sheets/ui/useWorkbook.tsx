// Loading a workbook from the engine, saving it as it changes, and saving a table from it as a dataset.
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../../context";
import { Modal, Notice, Spinner } from "../../components/ui";
import type { Area } from "../engine/address";
import { isDateFormat, formatValue } from "../engine/format";
import { CellError, type Scalar } from "../engine/values";
import { Workbook, type Sheet, type WorkbookJSON } from "../engine/workbook";
import type { DatasetMeta } from "../../types";

export interface WorkbookMeta {
  id: string;
  name: string;
  created: string;
  updated: string;
  sheets: string[];
  cells: number;
  size?: number;
  project_id?: string;
  dataset_id?: string;
  truncated?: boolean;
  rows_loaded?: number;
  rows_total?: number;
}

export type SaveState = "saved" | "saving" | "unsaved" | "error";

/** A workbook from the engine, saved a moment after each change. */
export function useWorkbook(workbookId: string | null) {
  const { engine } = useApp();
  const [wb, setWb] = useState<Workbook | null>(null);
  const [meta, setMeta] = useState<WorkbookMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>("saved");
  const timer = useRef<number | null>(null);
  const busy = useRef(false);
  const again = useRef(false);

  useEffect(() => {
    setWb(null);
    setMeta(null);
    setError(null);
    if (!workbookId) return;
    let stale = false;
    engine.call<{ meta: WorkbookMeta; workbook: WorkbookJSON }>("sheets.get", { workbook_id: workbookId }).then(
      (found) => {
        if (stale) return;
        // calculating a big workbook takes a moment: let the spinner show first
        setTimeout(() => {
          if (stale) return;
          setWb(Workbook.fromJSON(found.workbook));
          setMeta(found.meta);
        }, 0);
      },
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [engine, workbookId]);

  const flush = useCallback(async () => {
    if (!wb || !workbookId) return;
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    setSave("saving");
    try {
      const next = await engine.call<WorkbookMeta>("sheets.save", { workbook_id: workbookId, workbook: wb.toJSON() });
      setMeta((m) => ({ ...m, ...next }));
      setSave("saved");
    } catch {
      setSave("error");
    } finally {
      busy.current = false;
      if (again.current) {
        again.current = false;
        void flush();
      }
    }
  }, [engine, wb, workbookId]);

  useEffect(() => {
    if (!wb) return;
    const off = wb.subscribe(() => {
      setSave("unsaved");
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), 900);
    });
    const leave = () => {
      if (timer.current) {
        window.clearTimeout(timer.current);
        void flush();
      }
    };
    window.addEventListener("beforeunload", leave);
    return () => {
      off();
      window.removeEventListener("beforeunload", leave);
      if (timer.current) {
        window.clearTimeout(timer.current);
        timer.current = null;
        void flush();
      }
    };
  }, [wb, flush]);

  const rename = useCallback(async (name: string) => {
    if (!workbookId) return;
    setMeta(await engine.call<WorkbookMeta>("sheets.rename", { workbook_id: workbookId, name }));
  }, [engine, workbookId]);

  return { wb, meta, error, save, flush, rename };
}

export function SaveState({ state }: { state: SaveState }) {
  return (
    <span className={`sheet-save ${state}`} aria-live="polite">
      {state === "saving" ? "Saving…" : state === "unsaved" ? "Edited" : state === "error" ? "Not saved: the engine did not answer" : "Saved"}
    </span>
  );
}

/** A table's values as a dataset takes them: the first row names the columns; dates as ISO text. */
export function tableValues(wb: Workbook, sheet: Sheet, area: Area): { columns: string[]; rows: Scalar[][] } {
  const { rows: used, cols: usedCols } = wb.bounds(sheet);
  const r2 = Math.min(area.r2, used - 1);
  const c2 = Math.min(area.c2, usedCols - 1);
  const columns: string[] = [];
  for (let c = area.c1; c <= c2; c++) columns.push(wb.display(sheet, area.r1, c).text);
  const rows: Scalar[][] = [];
  for (let r = area.r1 + 1; r <= r2; r++) {
    if (sheet.hiddenRows.has(r)) continue;
    const row: Scalar[] = [];
    let any = false;
    for (let c = area.c1; c <= c2; c++) {
      let v = wb.value(sheet, r, c);
      const format = wb.style(sheet.cells.get(r * 16384 + c)?.s).format;
      if (typeof v === "number" && format && isDateFormat(format)) v = formatValue(v, /[hs]/i.test(format) ? "yyyy-mm-dd hh:mm:ss" : "yyyy-mm-dd").text;
      if (v instanceof CellError) v = null;
      if (v !== null && v !== "") any = true;
      row.push(v === "" ? null : v);
    }
    if (any) rows.push(row);
  }
  return { columns, rows };
}

export function SaveDatasetDialog({ wb, sheet, area, defaultName, onClose, onSaved }: { wb: Workbook; sheet: Sheet; area: Area; defaultName: string; onClose: () => void; onSaved: (meta: DatasetMeta) => void }) {
  const { engine, fail } = useApp();
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const table = useState(() => tableValues(wb, sheet, area))[0];
  const save = async () => {
    setBusy(true);
    try {
      const meta = await engine.call<DatasetMeta>("sheets.save_dataset", { name, columns: table.columns, rows: table.rows, source: `Sheet: ${sheet.name}` });
      onSaved(meta);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Save as a dataset"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !name.trim() || !table.rows.length} onClick={() => void save()}>
            {busy ? <Spinner /> : null} Save dataset
          </button>
        </>
      }
    >
      <Notice>
        The first row names the columns: <b>{table.columns.slice(0, 6).join(", ")}{table.columns.length > 6 ? `, and ${table.columns.length - 6} more` : ""}</b>. {table.rows.length.toLocaleString()} rows of values below it are saved, as they show now (formulas give their results).
      </Notice>
      <div className="field">
        <label htmlFor="sheet-ds-name">Dataset name</label>
        <input id="sheet-ds-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && void save()} />
      </div>
    </Modal>
  );
}
