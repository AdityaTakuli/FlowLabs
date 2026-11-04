// Sheets: workbooks like Excel's, kept in the workspace. Start one, open a dataset as one, and save
// a table from it as a dataset to train on. The spreadsheet itself is src/sheets.
import { useCallback, useEffect, useState } from "react";
import { useApp } from "../context";
import { Icon } from "../components/Icon";
import { SectionNav, TopBar } from "../components/TopBar";
import { Modal, Spinner } from "../components/ui";
import { ago } from "../format";
import type { DatasetMeta } from "../types";
import { Workbook } from "../sheets/engine/workbook";
import type { Area } from "../sheets/engine/address";
import type { Sheet } from "../sheets/engine/workbook";
import { Spreadsheet } from "../sheets/ui/Spreadsheet";
import { csvWorkbook, readXlsx } from "../sheets/engine/xlsx";
import { SaveDatasetDialog, SaveState, useWorkbook, type WorkbookMeta } from "../sheets/ui/useWorkbook";

function openWorkbook(id: string | null) {
  const query = new URLSearchParams({ page: "sheets" });
  if (id) query.set("workbook", id);
  window.history.pushState(null, "", `?${query}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function Sheets({ goHome, workbookId }: { goHome: () => void; workbookId: string | null }) {
  return (
    <div className="shell sheets-shell">
      <TopBar onHome={goHome} help="sheets">
        <SectionNav current="sheets" onProjects={goHome} />
      </TopBar>
      {workbookId ? <Editor workbookId={workbookId} /> : <Library />}
    </div>
  );
}

function Library() {
  const { engine, fail, notify } = useApp();
  const [list, setList] = useState<WorkbookMeta[] | null>(null);
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    engine.call<WorkbookMeta[]>("sheets.list").then(setList, (e) => {
      fail(e);
      setList([]);
    });
    engine.call<DatasetMeta[]>("datasets.list").then((all) => setDatasets(all.filter((d) => d.kind === "tabular")), () => undefined);
  }, [engine, fail]);
  useEffect(load, [load]);

  const create = async () => {
    setBusy("new");
    try {
      const meta = await engine.call<WorkbookMeta>("sheets.save", { workbook: new Workbook().toJSON(), name: "Untitled workbook" });
      openWorkbook(meta.id);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };
  const fromDataset = async (dataset: DatasetMeta) => {
    setBusy(dataset.id);
    try {
      const meta = await engine.call<WorkbookMeta>("sheets.from_dataset", { dataset_id: dataset.id });
      if (meta.truncated) notify(`The first ${meta.rows_loaded?.toLocaleString()} of ${meta.rows_total?.toLocaleString()} rows opened; a sheet holds up to about two million cells.`, "info");
      openWorkbook(meta.id);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="sheets-home">
      <header className="sheets-home-head">
        <div>
          <h1>Sheets</h1>
          <p className="dim">Spreadsheets with Excel's formulas, formats and shortcuts. Start from scratch, or open a dataset as a sheet and save a table back as a dataset to train on.</p>
        </div>
        <div className="row wrap">
          <label className="button" title="Open an Excel (.xlsx) or CSV file as a new workbook">
            <Icon name="upload" size={13} /> Open a file
            <input type="file" hidden accept=".xlsx,.xlsm,.csv,.tsv,.txt" onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setBusy("file");
              try {
                const bytes = new Uint8Array(await file.arrayBuffer());
                const name = file.name.replace(/\.[^.]+$/, "");
                const workbook = /\.(csv|tsv|txt)$/i.test(file.name) ? csvWorkbook(name.slice(0, 31), new TextDecoder().decode(bytes)) : await readXlsx(bytes);
                const meta = await engine.call<WorkbookMeta>("sheets.save", { workbook, name });
                openWorkbook(meta.id);
              } catch (error) {
                fail(error);
              } finally {
                setBusy(null);
              }
            }} />
          </label>
          <button onClick={() => setChoosing(true)} disabled={!datasets.length} title={datasets.length ? undefined : "Import a dataset on the Projects page first"}>
            <Icon name="table" size={13} /> Open a dataset
          </button>
          <button className="primary" onClick={() => void create()} disabled={busy === "new"}>
            {busy === "new" ? <Spinner /> : <Icon name="plus" size={13} />} New workbook
          </button>
        </div>
      </header>
      {list === null ? (
        <Spinner />
      ) : list.length === 0 ? (
        <div className="sheets-empty">
          <Icon name="table" size={28} />
          <p>No workbooks yet.</p>
          <p className="dim small">A new workbook opens with one empty sheet. Type values and formulas such as =SUM(A1:A10), or paste a table from Excel or a web page.</p>
        </div>
      ) : (
        <ul className="sheets-list">
          {list.map((w) => (
            <li key={w.id}>
              <button className="sheets-card" onClick={() => openWorkbook(w.id)}>
                <span className="sheets-thumb" aria-hidden="true"><Icon name="table" size={18} /></span>
                <span className="sheets-card-text">
                  <b className="ellipsis">{w.name}</b>
                  <span className="faint small">
                    {w.sheets.length} {w.sheets.length === 1 ? "sheet" : "sheets"} · {w.cells.toLocaleString()} cells · edited {ago(w.updated)}
                    {w.project_id ? " · in a project" : ""}
                  </span>
                </span>
              </button>
              <span className="sheets-actions">
                <button className="ghost icon-only small" aria-label={`Rename ${w.name}`} title="Rename" onClick={async () => {
                  const name = window.prompt("Workbook name", w.name);
                  if (!name || name === w.name) return;
                  try {
                    await engine.call("sheets.rename", { workbook_id: w.id, name });
                    load();
                  } catch (error) {
                    fail(error);
                  }
                }}>
                  <Icon name="edit" size={13} />
                </button>
                <button className="ghost icon-only small" aria-label={`Duplicate ${w.name}`} title="Duplicate" onClick={async () => {
                  try {
                    await engine.call("sheets.duplicate", { workbook_id: w.id });
                    load();
                  } catch (error) {
                    fail(error);
                  }
                }}>
                  <Icon name="copy" size={13} />
                </button>
                <button className="ghost icon-only small" aria-label={`Delete ${w.name}`} title="Delete" onClick={async () => {
                  if (!window.confirm(`Delete the workbook “${w.name}”? This cannot be undone.`)) return;
                  try {
                    await engine.call("sheets.delete", { workbook_id: w.id });
                    load();
                  } catch (error) {
                    fail(error);
                  }
                }}>
                  <Icon name="trash" size={13} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {choosing && (
        <Modal title="Open a dataset as a sheet" onClose={() => setChoosing(false)}>
          <p className="dim small">The dataset is copied into a new workbook; the dataset itself does not change.</p>
          <ul className="sheet-format-list tall">
            {datasets.map((d) => (
              <li key={d.id}>
                <button onClick={() => void fromDataset(d)} disabled={busy !== null}>
                  <b>{d.name}</b>
                  <span className="faint">{d.rows.toLocaleString()} rows × {d.columns} columns {busy === d.id ? "…" : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </main>
  );
}

function Editor({ workbookId }: { workbookId: string }) {
  const { notify, engine, fail } = useApp();
  const { wb, meta, error, save, rename, flush } = useWorkbook(workbookId);
  const [saving, setSaving] = useState<{ sheet: Sheet; area: Area } | null>(null);
  const [name, setName] = useState<string | null>(null);
  if (error)
    return (
      <div className="sheets-home">
        <p className="error-text">{error}</p>
        <button onClick={() => openWorkbook(null)}>Back to Sheets</button>
      </div>
    );
  if (!wb || !meta)
    return (
      <div className="sheets-loading">
        <Spinner /> Opening the workbook…
      </div>
    );
  const title = (
    <div className="sheet-title">
      <button className="ghost icon-only small" onClick={() => openWorkbook(null)} aria-label="All workbooks" title="All workbooks">
        <Icon name="arrowLeft" size={14} />
      </button>
      <input
        className="sheet-title-input"
        value={name ?? meta.name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          if (name !== null && name.trim() && name !== meta.name) void rename(name.trim());
          setName(null);
        }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        aria-label="Workbook name"
        spellCheck={false}
      />
      <SaveState state={save} />
    </div>
  );
  return (
    <main className="sheets-editor">
      <Spreadsheet
        wb={wb}
        title={title}
        fileName={meta.name}
        onSave={() => void flush()}
        onNew={async () => {
          try {
            const made = await engine.call<WorkbookMeta>("sheets.save", { workbook: new Workbook().toJSON(), name: "Untitled workbook" });
            openWorkbook(made.id);
          } catch (e) {
            fail(e);
          }
        }}
        onSaveDataset={(sheet, area) => setSaving({ sheet, area })}
      />
      {saving && (
        <SaveDatasetDialog
          wb={wb}
          sheet={saving.sheet}
          area={saving.area}
          defaultName={`${meta.name} ${saving.sheet.name}`.trim()}
          onClose={() => setSaving(null)}
          onSaved={(d) => {
            setSaving(null);
            notify(`Saved ${d.rows.toLocaleString()} rows as the dataset ${d.name}. Start a project from it on the Projects page.`, "ok");
          }}
        />
      )}
    </main>
  );
}
