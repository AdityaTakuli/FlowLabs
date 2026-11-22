"""Excel sheets and header rows, dataset downloads, and browsing cloud storage folders.

Live cloud storage: set FLOWLABS_TEST_AZURITE to an Azurite blob endpoint (for example
``http://127.0.0.1:10000``) to browse and query a real container.
"""

from __future__ import annotations

import os
import zipfile
from pathlib import Path

import pandas as pd
import pytest
from helpers import fast

from flowlabs.core import datasets, export, sources, sql, training
from flowlabs.core import project as projects
from flowlabs.core.training import Job
from flowlabs.core.util import UserError

ROWS = 60


def _workbook(path: Path) -> Path:
    """A notes sheet first, then a report with a title above its table (headers on row 3)."""
    table = pd.DataFrame({
        "region": ["north", "south", "east", "west"] * (ROWS // 4),
        "units": list(range(ROWS)),
        "price": [round(1.5 + i * 0.25, 2) for i in range(ROWS)],
        "big": ["yes" if i % 3 == 0 else "no" for i in range(ROWS)],
    })  # fmt: skip
    with pd.ExcelWriter(path) as writer:
        pd.DataFrame({"note": ["made by finance"]}).to_excel(writer, sheet_name="Notes", index=False)
        pd.DataFrame([["Sales report 2026"]]).to_excel(writer, sheet_name="Report", index=False, header=False)
        table.to_excel(writer, sheet_name="Report", index=False, startrow=2)
        pd.DataFrame().to_excel(writer, sheet_name="Empty", index=False)
    return path


@pytest.fixture
def book(ws, tmp_path) -> dict:
    return datasets.import_file(ws, _workbook(tmp_path / "sales.xlsx"))


def test_excel_import_lists_sheets_and_skips_ones_without_a_table(book):
    names = [s["name"] for s in book["sheets"]]
    assert names == ["Notes", "Report", "Empty"]
    assert book["sheet"] == "Report"  # Notes has one column: not a table
    assert next(s for s in book["sheets"] if s["name"] == "Empty")["rows"] == 0


def test_headers_on_a_lower_row(ws, book):
    meta = datasets.choose_sheet(ws, book["id"], "Report", header_row=3)
    assert meta["header_row"] == 3 and meta["rows"] == ROWS and meta["columns"] == 4
    assert meta["created"] == book["created"]
    frame = datasets.load_frame(ws, book["id"])
    assert list(frame.columns) == ["region", "units", "price", "big"]
    assert frame["units"].sum() == sum(range(ROWS))
    # SQL sees the same table
    result = sql.run(ws, "select count(*) as n, sum(units) as u from data", dataset_id=book["id"])
    assert result["rows"][0] == [ROWS, sum(range(ROWS))]


def test_choosing_a_sheet_explains_mistakes(ws, book):
    with pytest.raises(UserError, match="no sheet called Missing"):
        datasets.choose_sheet(ws, book["id"], "Missing")
    with pytest.raises(UserError, match="the sheet Notes needs at least two columns"):
        datasets.choose_sheet(ws, book["id"], "Notes")
    with pytest.raises(UserError, match="header row"):
        datasets.choose_sheet(ws, book["id"], "Report", header_row=0)
    assert datasets.get_meta(ws, book["id"])["sheet"] == "Report"  # unchanged after a mistake


def test_only_excel_datasets_have_sheets(ws, churn):
    with pytest.raises(UserError, match="only Excel"):
        datasets.choose_sheet(ws, churn["id"], "Sheet1")


@pytest.mark.parametrize("fmt", ["csv", "xlsx", "parquet", "json"])
def test_dataset_downloads(ws, book, fmt):
    datasets.choose_sheet(ws, book["id"], "Report", header_row=3)
    written = datasets.export(ws, book["id"], fmt)
    path = ws.root / written["path"]
    assert written["path"].startswith("exports/datasets/") and path.name == f"sales.{fmt}"
    assert written["rows"] == ROWS and path.stat().st_size == written["bytes"]
    again = datasets.read_table(path)
    assert list(again.columns) == ["region", "units", "price", "big"] and len(again) == ROWS


def test_dataset_download_rejects_unknown_formats(ws, churn):
    with pytest.raises(UserError, match="CSV, Excel, Parquet or JSON"):
        datasets.export(ws, churn["id"], "pdf")


def test_parquet_download_of_mixed_columns(ws, tmp_path):
    frame = pd.DataFrame({"code": ["A1", 7, None, 3.5], "n": [1, 2, 3, 4]})
    path = tmp_path / "mixed.json"
    frame.to_json(path, orient="records")
    meta = datasets.import_file(ws, path)
    written = datasets.export(ws, meta["id"], "parquet")
    assert len(pd.read_parquet(ws.root / written["path"])) == 4


def test_project_export_trains_on_the_chosen_sheet(ws, book, tmp_path):
    from test_export_images import _run

    datasets.choose_sheet(ws, book["id"], "Report", header_row=3)
    project = fast(projects.new_project(ws, book["id"], target="big"), "logistic_regression")
    result = training.run(ws, project, Job("job"))
    record = result["models"][0]
    assert record["status"] == "done", record.get("error")
    built = export.build(ws, project["id"], result["id"], record["id"], include_data=True)
    with zipfile.ZipFile(ws.inside(built["zip"]["path"])) as bundle:
        bundle.extractall(tmp_path / "out")
    folder = next((tmp_path / "out").iterdir())
    assert (folder / "data.csv").is_file() and not (folder / "data.xlsx").exists()
    assert list(pd.read_csv(folder / "data.csv").columns) == ["region", "units", "price", "big"]
    _run(["train.py", "data.csv"], folder)


# ------------------------------------------------------------------------------- cloud storage


def _bucket(root: Path) -> Path:
    (root / "sales" / "2026").mkdir(parents=True)
    pd.DataFrame({"id": [1, 2], "amount": [10.0, 20.0]}).to_parquet(root / "sales" / "jan.parquet")
    pd.DataFrame({"id": [3], "amount": [5.0], "note": ["late"]}).to_parquet(root / "sales" / "feb.parquet")
    pd.DataFrame({"id": [9], "amount": [1.0]}).to_csv(root / "sales" / "2026" / "mar.csv", index=False)
    (root / "readme.md").write_text("not a table")
    pd.DataFrame({"a": [1]}).to_csv(root / "top.csv", index=False)
    return root


def test_browse_a_folder(tmp_path):
    import duckdb

    root = _bucket(tmp_path / "bucket")
    connection = duckdb.connect()
    top = sources.browse_at(connection, f"{root.as_posix()}/")
    assert [f["name"] for f in top["folders"]] == ["sales"] and top["folders"][0]["files"] == 3
    files = {f["name"]: f for f in top["files"]}
    assert set(files) == {"readme.md", "top.csv"}
    assert files["readme.md"]["sql"] is None and files["top.csv"]["format"] == "csv"
    assert files["top.csv"]["size"] == (root / "top.csv").stat().st_size
    assert top["all_files_sql"] is None  # one readable file: nothing to put together

    inner = sources.browse_at(connection, f"{root.as_posix()}/sales/")
    assert [f["name"] for f in inner["folders"]] == ["2026"]
    assert [f["name"] for f in inner["files"]] == ["feb.parquet", "jan.parquet"]
    together = connection.sql(f"select sum(amount), count(note) from {inner['all_files_sql']}").fetchall()[0]
    assert together == (35.0, 1)  # columns matched by name across the files
    one = inner["files"][1]["sql"]
    assert connection.sql(f"select count(*) from {one}").fetchall() == [(2,)]


def test_browse_cleans_the_folder_path(tmp_path):
    import duckdb

    root = _bucket(tmp_path / "bucket")
    source = sources.get("s3")
    values = {"bucket": "b"}
    calls: list[str] = []
    original = sources.browse_at
    try:
        sources.browse_at = lambda connection, base, limit=0: calls.append(base) or {"files": [], "folders": []}  # type: ignore[assignment]
        found = sources.browse(duckdb.connect(), source, values, "/sales/../2026/./")
    finally:
        sources.browse_at = original  # type: ignore[assignment]
    assert calls == ["s3://b/sales/2026/"] and found["folder"] == "sales/2026" and found["root"] == "s3://b/"
    assert root.is_dir()


def test_storage_browse_is_for_storage_connections_only(ws):
    saved = sql.save_connection(ws, {"kind": "sqlite", "name": "lite", "values": {"database": str(ws.root / "x.db")}})
    with pytest.raises(UserError, match="only cloud storage"):
        sql.storage_browse(ws, saved["id"])


@pytest.mark.skipif(not os.environ.get("FLOWLABS_TEST_AZURITE"), reason="FLOWLABS_TEST_AZURITE is not set")
def test_live_azure_container(ws, tmp_path):
    from azure.storage.blob import BlobServiceClient

    endpoint = os.environ["FLOWLABS_TEST_AZURITE"].rstrip("/")
    key = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=="
    connection_string = (f"DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey={key};"
                         f"BlobEndpoint={endpoint}/devstoreaccount1;")  # fmt: skip
    client = BlobServiceClient.from_connection_string(connection_string)
    container = client.get_container_client("flowlabs-test")
    if not container.exists():
        container.create_container()
    root = _bucket(tmp_path / "bucket")
    for path in root.rglob("*"):
        if path.is_file():
            container.upload_blob(path.relative_to(root).as_posix(), path.read_bytes(), overwrite=True)
    saved = sql.save_connection(ws, {"kind": "azure", "name": "azurite", "values": {
        "account": "devstoreaccount1", "container": "flowlabs-test", "auth": "connection",
        "connection_string": connection_string}})  # fmt: skip
    top = sql.storage_browse(ws, saved["id"])
    assert "sales" in [f["name"] for f in top["folders"]]
    inner = sql.storage_browse(ws, saved["id"], "sales")
    assert {f["name"] for f in inner["files"]} == {"feb.parquet", "jan.parquet"}
    result = sql.run(ws, f"select sum(amount) as total from {inner['all_files_sql']}", connection_id=saved["id"])
    assert result["rows"][0] == [35.0]


# ------------------------------------------------------------------------- found by breaking it


@pytest.mark.parametrize(
    ("name", "content", "message"),
    [
        ("broken.xlsx", b"not a zip at all", "could not open this Excel file"),
        ("empty.csv", b"", "the file is empty"),
        ("old.xls", b"\xd0\xcf\x11\xe0" + b"\0" * 600, "could not open this Excel file"),
    ],
)
def test_unreadable_files_are_explained(ws, tmp_path, name, content, message):
    path = tmp_path / name
    path.write_bytes(content)
    with pytest.raises(UserError, match=message):
        datasets.import_file(ws, path)
    assert not any(ws.datasets.iterdir()) if ws.datasets.exists() else True  # nothing half-imported


def test_header_row_mistakes(ws, book):
    with pytest.raises(UserError, match="fewer than 500 rows"):
        datasets.choose_sheet(ws, book["id"], "Report", header_row=500)
    with pytest.raises(UserError, match="a number from 1 to 1000"):
        datasets.choose_sheet(ws, book["id"], "Report", header_row="abc")


def test_a_dataset_in_use_keeps_its_sheet_for_its_projects(ws, book):
    datasets.choose_sheet(ws, book["id"], "Report", header_row=3)
    project = projects.new_project(ws, book["id"], target="big")
    projects.save(ws, project)
    other = datasets.choose_sheet(ws, book["id"], "Report", header_row=1)
    assert other["id"] != book["id"] and other["name"] == "sales (Report)" and other["header_row"] == 1
    kept = datasets.get_meta(ws, book["id"])
    assert kept["header_row"] == 3 and "big" in datasets.load_frame(ws, book["id"]).columns
    # the same choice again changes nothing
    assert datasets.choose_sheet(ws, other["id"], "Report", header_row=1)["id"] == other["id"]


def test_browse_keeps_brackets_and_quotes(tmp_path):
    import duckdb

    folder = tmp_path / "bucket" / "it's [2026] & co*"
    folder.mkdir(parents=True)
    pd.DataFrame({"x": [1, 2]}).to_parquet(folder / "o'neil [v1].parquet")
    pd.DataFrame({"x": [3]}).to_parquet(folder / "plain.parquet")
    connection = duckdb.connect()
    top = sources.browse_at(connection, f"{(tmp_path / 'bucket').as_posix()}/")
    assert [f["name"] for f in top["folders"]] == ["it's [2026] & co*"]
    inner = sources.browse_at(connection, f"{folder.as_posix()}/")
    files = {f["name"]: f for f in inner["files"]}
    assert set(files) == {"o'neil [v1].parquet", "plain.parquet"}
    assert files["o'neil [v1].parquet"]["size"] == (folder / "o'neil [v1].parquet").stat().st_size
    assert connection.sql(
        f"select count(*) from {files[chr(111) + chr(39) + 'neil [v1].parquet']['sql']}"
    ).fetchall() == [(2,)]
    assert connection.sql(f"select sum(x) from {inner['all_files_sql']}").fetchall() == [(6,)]


def test_storage_errors_in_plain_words():
    assert sql._storage_error(
        "IO Error: Could not connect to server error for HTTP GET to 'http://10.0.0.9:9000/b/'"
    ) == ("Could not reach 10.0.0.9:9000. Check the address (endpoint), and that you are online.")
    assert "refused the request" in sql._storage_error("HTTP Error: 403 (Forbidden) for 'https://b.s3.amazonaws.com/x'")


def test_the_header_row_is_found(ws, tmp_path):
    path = tmp_path / "found.xlsx"
    table = pd.DataFrame({"region": ["n", "s"] * 5, "units": range(10), "won": ["yes", "no"] * 5})
    with pd.ExcelWriter(path) as writer:
        pd.DataFrame([["Quarterly report"], ["made by finance"]]).to_excel(
            writer, sheet_name="Titled", index=False, header=False
        )
        table.to_excel(writer, sheet_name="Titled", index=False, startrow=3)
        table.to_excel(writer, sheet_name="Plain", index=False)
        pd.DataFrame({"region": ["n", "s"], 2024: [1, 2], 2025: [3, 4]}).to_excel(
            writer, sheet_name="Years", index=False
        )
    assert datasets.guess_header_row(path, "Titled") == 4
    assert datasets.guess_header_row(path, "Plain") == 1
    assert datasets.guess_header_row(path, "Years") == 1  # numbers as column names: keep row 1
    meta = datasets.import_file(ws, path)
    assert meta["sheet"] == "Titled" and meta["header_row"] == 4 and meta["rows"] == 10
    assert list(datasets.load_frame(ws, meta["id"]).columns) == ["region", "units", "won"]
    # another sheet: its own header row is found again
    plain = datasets.choose_sheet(ws, meta["id"], "Plain", header_row=None)
    assert plain["header_row"] == 1 and plain["rows"] == 10
