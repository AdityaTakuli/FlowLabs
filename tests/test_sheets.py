"""Workbooks in the workspace (core/sheets.py): saving, datasets as sheets and sheets as datasets."""

from __future__ import annotations

import base64

import pandas as pd
import pytest

from flowlabs.core import datasets, sheets
from flowlabs.core.rpc import Engine
from flowlabs.core.util import UserError


def workbook(cells: list[list[object]]) -> dict:
    return {
        "format": "flowlabs-workbook",
        "version": 1,
        "sheets": [{"name": "Sheet1", "cells": cells}],
        "styles": [{}],
        "names": [],
    }


@pytest.fixture
def engine(ws) -> Engine:
    return Engine(ws.root)


def test_save_list_rename_duplicate_delete(engine):
    meta = engine.call(
        "sheets.save", {"workbook": workbook([[0, 0, {"v": 1}], [0, 1, {"f": "A1*2"}]]), "name": "Budget"}
    )
    assert meta["name"] == "Budget" and meta["cells"] == 2 and meta["sheets"] == ["Sheet1"]
    again = engine.call("sheets.save", {"workbook": workbook([[0, 0, {"v": 5}]]), "workbook_id": meta["id"]})
    assert again["id"] == meta["id"] and again["name"] == "Budget" and again["created"] == meta["created"]
    assert engine.call("sheets.get", {"workbook_id": meta["id"]})["workbook"]["sheets"][0]["cells"] == [
        [0, 0, {"v": 5}]
    ]
    engine.call("sheets.rename", {"workbook_id": meta["id"], "name": "Budget 2026"})
    copy = engine.call("sheets.duplicate", {"workbook_id": meta["id"]})
    names = sorted(w["name"] for w in engine.call("sheets.list"))
    assert names == ["Budget 2026", "Budget 2026 (copy)"]
    engine.call("sheets.delete", {"workbook_id": copy["id"]})
    assert [w["id"] for w in engine.call("sheets.list")] == [meta["id"]]


def test_refuses_what_is_not_a_workbook(engine):
    with pytest.raises(UserError):
        engine.call("sheets.save", {"workbook": {"sheets": []}})
    with pytest.raises(UserError):
        engine.call("sheets.get", {"workbook_id": "../../etc/passwd"})


def test_dataset_opens_as_a_sheet(engine, ws):
    iris = engine.call("datasets.import_sample", {"sample_id": "iris"})
    meta = engine.call("sheets.from_dataset", {"dataset_id": iris["id"], "project_id": "p1"})
    assert meta["rows_total"] == 150 and not meta["truncated"]
    book = engine.call("sheets.get", {"workbook_id": meta["id"]})["workbook"]
    sheet = book["sheets"][0]
    header = [c for c in sheet["cells"] if c[0] == 0]
    assert header[0][2] == {"v": "sepal_length", "s": 1}
    assert sheet["freezeRows"] == 1
    assert len([c for c in sheet["cells"] if c[0] > 0]) == 150 * 5
    assert engine.call("sheets.for_project", {"project_id": "p1"})["id"] == meta["id"]
    assert engine.call("sheets.for_project", {"project_id": "nope"}) is None


def test_dates_become_excel_dates(ws):
    frame = pd.DataFrame(
        {"day": pd.to_datetime(["2024-01-02", "1900-03-01"]), "when": pd.to_datetime(["2024-01-02 06:00", None])}
    )
    book, rows = sheets.frame_workbook(frame)
    assert rows == 2
    values = {(r, c): cell for r, c, cell in book["sheets"][0]["cells"]}
    assert values[(1, 0)] == {"v": 45293, "s": 2}
    assert values[(2, 0)]["v"] == 61
    assert values[(1, 1)] == {"v": 45293.25, "s": 3}
    assert (2, 1) not in values


def test_sheet_saves_as_a_dataset(engine, ws):
    meta = engine.call(
        "sheets.save_dataset",
        {
            "name": "scores",
            "columns": ["name", "score", "passed", "day", ""],
            "rows": [
                ["Ann", 3, True, "2024-01-02", None],
                ["Bob", 4.5, False, "2024-01-03", "x"],
                ["Cy", None, True, "2024-01-04", None],
            ],
        },
    )
    frame = datasets.load_frame(ws, meta["id"])
    assert list(frame.columns) == ["name", "score", "passed", "day", "column_5"]
    assert frame["score"].dtype.kind == "f"
    assert str(frame["passed"].dtype) == "boolean"
    assert frame["day"].dtype.kind == "M"
    with pytest.raises(UserError):
        engine.call("sheets.save_dataset", {"name": "x", "columns": ["a"], "rows": []})


def test_export_file_stays_in_exports(engine, ws):
    data = base64.b64encode(b"PK\x03\x04 fake").decode()
    out = engine.call("sheets.export_file", {"name": "../../My book.xlsx", "data": data})
    assert out["path"].startswith("exports/sheets/") and out["name"] == "My book.xlsx"
    assert (ws.root / out["path"]).read_bytes().startswith(b"PK")
    with pytest.raises(UserError):
        engine.call("sheets.export_file", {"name": "run.sh", "data": data})
