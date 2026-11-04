// Analyze → Sheet: the project's data in a spreadsheet. A copy: edit it, add formulas, and save a
// table back as a dataset (and as this project's data) when it is ready.
import { useCallback, useEffect, useState } from "react";
import { useApp } from "../context";
import { Icon } from "../components/Icon";
import { Spinner } from "../components/ui";
import type { DatasetMeta } from "../types";
import type { Area } from "../sheets/engine/address";
import type { Sheet } from "../sheets/engine/workbook";
import { Spreadsheet } from "../sheets/ui/Spreadsheet";
import { SaveDatasetDialog, SaveState, useWorkbook, type WorkbookMeta } from "../sheets/ui/useWorkbook";
import type { ProjectApi } from "./ProjectPage";

export function ProjectSheet({ api }: { api: ProjectApi }) {
  const { engine, fail, notify } = useApp();
  const project = api.project;
  const [linked, setLinked] = useState<WorkbookMeta | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    engine.call<WorkbookMeta | null>("sheets.for_project", { project_id: project.id }).then(setLinked, (e) => {
      fail(e);
      setLinked(null);
    });
  }, [engine, fail, project.id]);

  const open = useCallback(async () => {
    if (!project.dataset_id) return;
    setBusy(true);
    try {
      const meta = await engine.call<WorkbookMeta>("sheets.from_dataset", { dataset_id: project.dataset_id, project_id: project.id, name: `${project.name} sheet` });
      if (meta.truncated) notify(`The first ${meta.rows_loaded?.toLocaleString()} of ${meta.rows_total?.toLocaleString()} rows opened; a sheet holds up to about two million cells.`, "info");
      setLinked(meta);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }, [engine, fail, notify, project]);

  if (linked === undefined) return <div className="sheets-loading"><Spinner /></div>;
  if (linked === null)
    return (
      <div className="sheets-empty in-project">
        <Icon name="table" size={28} />
        <p>Work on this project's data as a spreadsheet.</p>
        <p className="dim small">FlowLabs copies the data into a sheet. Add columns with formulas, fix values, sort, then save the table as a dataset and use it as this project's data. The original data does not change.</p>
        <button className="primary" onClick={() => void open()} disabled={busy || !project.dataset_id}>
          {busy ? <Spinner /> : <Icon name="table" size={13} />} Open the data as a sheet
        </button>
      </div>
    );
  return <LinkedSheet api={api} meta={linked} onReload={async () => {
    if (!window.confirm("Replace this sheet with a fresh copy of the project's data? Changes in the sheet are lost.")) return;
    try {
      await engine.call("sheets.delete", { workbook_id: linked.id });
      setLinked(null);
      await open();
    } catch (error) {
      fail(error);
    }
  }} />;
}

function LinkedSheet({ api, meta, onReload }: { api: ProjectApi; meta: WorkbookMeta; onReload: () => void }) {
  const { notify } = useApp();
  const { wb, error, save } = useWorkbook(meta.id);
  const [saving, setSaving] = useState<{ sheet: Sheet; area: Area } | null>(null);
  if (error) return <p className="error-text" style={{ padding: 24 }}>{error}</p>;
  if (!wb) return <div className="sheets-loading"><Spinner /> Opening the sheet…</div>;
  const useAsData = (d: DatasetMeta) => {
    if (!window.confirm(`Train this project on “${d.name}” (${d.rows.toLocaleString()} rows) instead of its current data? The old dataset is kept, and you can switch back on the Data page.`)) return;
    api.update((p) => ({ ...p, dataset_id: d.id }));
    notify(`This project now uses ${d.name}.`, "ok");
  };
  return (
    <div className="sheets-editor in-project">
      <Spreadsheet
        wb={wb}
        title={<div className="sheet-title"><SaveState state={save} /></div>}
        onSaveDataset={(sheet, area) => setSaving({ sheet, area })}
        extra={
          <>
            <button className="ghost small" onClick={onReload} title="Start again from the project's data">
              <Icon name="refresh" size={12} /> Fresh copy
            </button>
            <a className="button ghost small" href={`?page=sheets&workbook=${meta.id}`} title="Open in Sheets">
              <Icon name="external" size={12} />
            </a>
          </>
        }
      />
      {saving && (
        <SaveDatasetDialog
          wb={wb}
          sheet={saving.sheet}
          area={saving.area}
          defaultName={`${api.project.name} (sheet)`}
          onClose={() => setSaving(null)}
          onSaved={(d) => {
            setSaving(null);
            notify(`Saved ${d.rows.toLocaleString()} rows as the dataset ${d.name}.`, "ok");
            useAsData(d);
          }}
        />
      )}
    </div>
  );
}
