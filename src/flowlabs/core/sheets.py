"""Workbooks: spreadsheets saved in the workspace, made from datasets, and saved back as datasets.

The app calculates the formulas (apps/web/src/sheets); the engine keeps the workbook as JSON:

<root>/sheets/<id>.json       the workbook (sheets, cells, styles, names)
<root>/sheets/<id>.meta.json  its name, dates and size, for the list
"""

from __future__ import annotations

import base64
import binascii
import datetime as dt
import math
import re
from pathlib import Path
from typing import Any

import pandas as pd

from . import datasets
from .util import UserError, new_id, now
from .workspace import Workspace

MAX_CELLS = 2_000_000
EXCEL_EPOCH = dt.datetime(1899, 12, 30)


def _folder(ws: Workspace) -> Path:
    folder = ws.root / "sheets"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _paths(ws: Workspace, workbook_id: str) -> tuple[Path, Path]:
    if not workbook_id.replace("_", "").isalnum():
        raise UserError("that is not a workbook id")
    folder = _folder(ws)
    return folder / f"{workbook_id}.json", folder / f"{workbook_id}.meta.json"


def _check(workbook: Any) -> dict[str, Any]:
    if (
        not isinstance(workbook, dict)
        or workbook.get("format") != "flowlabs-workbook"
        or not isinstance(workbook.get("sheets"), list)
    ):
        raise UserError("that is not a FlowLabs workbook")
    if not workbook["sheets"]:
        raise UserError("a workbook needs at least one sheet")
    cells = sum(len(s.get("cells") or []) for s in workbook["sheets"])
    if cells > MAX_CELLS * 2:
        raise UserError(f"the workbook has {cells:,} cells; FlowLabs keeps up to {MAX_CELLS * 2:,}")
    return workbook


def _meta_for(
    workbook_id: str, name: str, workbook: dict[str, Any], old: dict[str, Any] | None, **extra: Any
) -> dict[str, Any]:
    cells = sum(len(s.get("cells") or []) for s in workbook["sheets"])
    meta = {
        **(old or {}),
        "id": workbook_id,
        "name": name,
        "updated": now(),
        "sheets": [s.get("name", "") for s in workbook["sheets"]],
        "cells": cells,
    }
    meta.setdefault("created", meta["updated"])
    for k, v in extra.items():
        if v is not None:
            meta[k] = v
    return meta


def list_workbooks(ws: Workspace) -> list[dict[str, Any]]:
    out = []
    for path in _folder(ws).glob("*.meta.json"):
        try:
            out.append(ws.read_json(path))
        except (OSError, ValueError):
            continue
    return sorted(out, key=lambda m: m.get("updated", ""), reverse=True)


def get(ws: Workspace, workbook_id: str) -> dict[str, Any]:
    data, meta = _paths(ws, workbook_id)
    if not data.is_file():
        raise UserError("that workbook is gone")
    return {
        "meta": ws.read_json(meta) if meta.is_file() else {"id": workbook_id, "name": workbook_id},
        "workbook": ws.read_json(data),
    }


def save(
    ws: Workspace, workbook: Any, name: str | None = None, workbook_id: str | None = None, project_id: str | None = None
) -> dict[str, Any]:
    """Create a workbook (no id) or replace its content."""
    _check(workbook)
    workbook_id = workbook_id or new_id("w")
    data, meta_path = _paths(ws, workbook_id)
    old = ws.read_json(meta_path) if meta_path.is_file() else None
    label = (name or (old or {}).get("name") or "Untitled workbook").strip()[:120] or "Untitled workbook"
    ws.write_json(data, workbook)
    meta = _meta_for(workbook_id, label, workbook, old, project_id=project_id)
    meta["size"] = data.stat().st_size
    ws.write_json(meta_path, meta)
    return meta


def rename(ws: Workspace, workbook_id: str, name: str) -> dict[str, Any]:
    _, meta_path = _paths(ws, workbook_id)
    if not meta_path.is_file():
        raise UserError("that workbook is gone")
    meta = ws.read_json(meta_path)
    meta["name"] = name.strip()[:120] or meta["name"]
    meta["updated"] = now()
    ws.write_json(meta_path, meta)
    return meta


def delete(ws: Workspace, workbook_id: str) -> None:
    for path in _paths(ws, workbook_id):
        ws.remove(path)


def duplicate(ws: Workspace, workbook_id: str) -> dict[str, Any]:
    found = get(ws, workbook_id)
    return save(ws, found["workbook"], f"{found['meta'].get('name', 'Workbook')} (copy)")


def for_project(ws: Workspace, project_id: str) -> dict[str, Any] | None:
    for meta in list_workbooks(ws):
        if meta.get("project_id") == project_id:
            return meta
    return None


# ----------------------------------------------------------------------------- from datasets


def _serial(value: Any) -> float:
    stamp = pd.Timestamp(value)
    if stamp.tzinfo is not None:
        stamp = stamp.tz_convert(None)
    delta = stamp.to_pydatetime() - EXCEL_EPOCH
    serial = delta.days + delta.seconds / 86400 + delta.microseconds / 86_400_000_000
    return serial if serial >= 61 else serial - 1  # Excel's 29 Feb 1900


def _cell_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return None if isinstance(value, float) and not math.isfinite(value) else value
    if hasattr(value, "item") and not isinstance(value, (str, bytes)):  # numpy scalars
        return _cell_value(value.item())
    if isinstance(value, float) and math.isnan(value):
        return None
    return str(value)


def frame_workbook(
    frame: pd.DataFrame, sheet_name: str = "data", limit_cells: int = MAX_CELLS
) -> tuple[dict[str, Any], int]:
    """A DataFrame as a workbook: a bold header row, then the values; dates as Excel dates."""
    columns = [str(c) for c in frame.columns]
    width = max(1, len(columns))
    rows = min(len(frame), max(1, limit_cells // width))
    part = frame.iloc[:rows]
    styles: list[dict[str, Any]] = [
        {},
        {"bold": True, "fill": "#f2f2f7", "bottom": {"style": "thin", "color": "#c7c7cc"}},
        {"format": "yyyy-mm-dd"},
        {"format": "yyyy-mm-dd hh:mm"},
    ]
    cells: list[list[Any]] = [[0, c, {"v": name, "s": 1}] for c, name in enumerate(columns)]
    widths: list[list[int]] = []
    for c, column in enumerate(part.columns):
        series = part[column]
        longest = len(columns[c])
        if pd.api.types.is_datetime64_any_dtype(series):
            has_time = (
                bool(((series.dropna().dt.hour != 0) | (series.dropna().dt.minute != 0)).any())
                if series.notna().any()
                else False
            )
            style = 3 if has_time else 2
            for r, value in enumerate(series):
                if pd.notna(value):
                    cells.append([r + 1, c, {"v": round(_serial(value), 10), "s": style}])
            longest = max(longest, 16 if has_time else 10)
        else:
            for r, value in enumerate(series.tolist()):
                v = _cell_value(value)
                if v is None or (isinstance(v, float) and math.isnan(v)):
                    continue
                cells.append([r + 1, c, {"v": v}])
                if r < 500:
                    longest = max(longest, len(str(v)) if not isinstance(v, float) else len(f"{v:.6g}"))
        widths.append([c, int(min(320, max(64, longest * 7.5 + 18)))])
    sheet = {"name": sheet_name[:31] or "data", "cells": cells, "colWidths": widths, "freezeRows": 1}
    return {"format": "flowlabs-workbook", "version": 1, "sheets": [sheet], "styles": styles, "names": []}, rows


def from_dataset(
    ws: Workspace, dataset_id: str, name: str | None = None, project_id: str | None = None
) -> dict[str, Any]:
    meta = datasets.get_meta(ws, dataset_id)
    if meta.get("kind") != "tabular":
        raise UserError("only tables open as a sheet; this dataset holds images")
    frame = datasets.load_frame(ws, dataset_id)
    sheet_name = "".join(ch for ch in meta["name"] if ch not in "\\/?*[]:")[:31] or "data"
    workbook, rows = frame_workbook(frame, sheet_name)
    saved = save(ws, workbook, name or meta["name"], project_id=project_id)
    saved["dataset_id"] = dataset_id
    saved["truncated"] = rows < len(frame)
    saved["rows_loaded"] = rows
    saved["rows_total"] = int(len(frame))
    _, meta_path = _paths(ws, saved["id"])
    ws.write_json(meta_path, saved)
    return saved


# -------------------------------------------------------------------------------- to datasets


def _column(values: list[Any]) -> pd.Series:
    series = pd.Series(values, dtype=object)
    present = series.dropna()
    if present.empty:
        return series
    if all(isinstance(v, bool) for v in present):
        return series.astype("boolean")
    if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in present):
        return pd.to_numeric(series)
    if all(isinstance(v, str) for v in present):
        parsed = pd.to_datetime(present, errors="coerce", format="ISO8601")
        if parsed.notna().all() and present.str.match(r"^\d{4}-\d{2}-\d{2}").all():
            return pd.to_datetime(series, errors="coerce", format="ISO8601")
        return series.astype("string")
    return series.map(lambda v: None if v is None else str(v)).astype("string")


def save_dataset(
    ws: Workspace, name: str, columns: list[Any], rows: list[list[Any]], source: str | None = None
) -> dict[str, Any]:
    """Rows from a sheet (values as the sheet shows them) as a new dataset."""
    if not columns:
        raise UserError("select a table with a header row first")
    if not rows:
        raise UserError("the table has a header but no rows under it")
    names: list[str] = []
    for i, column in enumerate(columns):
        label = str(column).strip() if column not in (None, "") else f"column_{i + 1}"
        base = label
        n = 2
        while label in names:
            label = f"{base}_{n}"
            n += 1
        names.append(label)
    width = len(names)
    data = {names[c]: _column([row[c] if c < len(row) else None for row in rows]) for c in range(width)}
    frame = pd.DataFrame(data)
    dataset_id = new_id("d")
    folder = ws.datasets / dataset_id
    folder.mkdir(parents=True)
    try:
        frame.to_parquet(folder / "data.parquet", index=False)
        meta = datasets._table_meta(
            ws, dataset_id, (name or "sheet").strip()[:120] or "sheet", "data.parquet", source or "Sheet"
        )
        return datasets._write_meta(ws, dataset_id, meta)
    except Exception:
        ws.remove(folder)
        raise


def export_file(ws: Workspace, name: str, data_base64: str) -> dict[str, Any]:
    """A file the app made (an .xlsx or .csv of a workbook), kept under exports/ to download."""
    stem = re.sub(r"[^\w. -]+", "_", (name or "workbook").strip())[:120].strip(" ._") or "workbook"
    if not stem.lower().endswith((".xlsx", ".csv")):
        raise UserError("only .xlsx and .csv files can be saved here")
    try:
        data = base64.b64decode(data_base64, validate=True)
    except (binascii.Error, ValueError, TypeError) as error:
        raise UserError("the file did not arrive whole; save it again") from error
    if len(data) > 200 * 1024 * 1024:
        raise UserError("the file is over 200 MB")
    folder = ws.exports / "sheets"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / stem
    target.write_bytes(data)
    return {"path": ws.relative(target), "name": stem, "bytes": len(data)}
