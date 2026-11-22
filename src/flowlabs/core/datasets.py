"""Datasets: import files and samples, read them back, and profile them.

Tables: CSV/TSV/TXT, Excel, Parquet, JSON / JSON Lines, or a zip holding one of those.
Images: a zip (or folder) with one sub-folder per class, e.g. ``cats/001.jpg``, ``dogs/002.png``.
"""

from __future__ import annotations

import base64
import csv
import io
import re
import shutil
import warnings
import zipfile
from collections import OrderedDict
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

import flowlabs_runtime as rt

from .util import UserError, jsonable, new_id, now, round_floats
from .workspace import Workspace

TABLE_EXTENSIONS = {".csv", ".tsv", ".txt", ".xlsx", ".xls", ".parquet", ".pq", ".json", ".jsonl", ".ndjson"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".tif", ".tiff"}
SAMPLES_DIR = Path(__file__).resolve().parent / "samples"
MAX_CACHED = 3

SAMPLES: list[dict[str, Any]] = [
    {"id": "churn", "name": "Customer churn", "kind": "tabular", "target": "churned", "task": "classification",
     "description": "2,000 telecom customers: will they leave? Mixed numbers, categories, dates and gaps."},
    {"id": "iris", "name": "Iris flowers", "kind": "tabular", "target": "species", "task": "classification",
     "description": "150 flowers, 4 measurements, 3 species. The classic first dataset."},
    {"id": "breast_cancer", "name": "Breast cancer diagnosis", "kind": "tabular", "target": "diagnosis",
     "task": "classification", "description": "569 tumours, 30 measurements: malignant or benign."},
    {"id": "wine", "name": "Wine cultivars", "kind": "tabular", "target": "cultivar", "task": "classification",
     "description": "178 wines, 13 chemical measurements, 3 cultivars."},
    {"id": "diabetes", "name": "Diabetes progression", "kind": "tabular", "target": "progression",
     "task": "regression", "description": "442 patients, 10 measurements: predict disease progression a year later."},
    {"id": "fraud", "name": "Card fraud (imbalanced)", "kind": "tabular", "target": "is_fraud",
     "task": "classification", "description": "3,000 transactions, only 2% fraud: practice class balancing."},
    {"id": "orders", "name": "Messy orders", "kind": "tabular", "target": "rating", "task": "regression",
     "description": "300 orders with inconsistent text, numbers stored as text and mixed date formats."},
    {"id": "digits", "name": "Handwritten digits (images)", "kind": "image", "target": "label",
     "task": "classification", "description": "1,797 small images of the digits 0 to 9, one folder per digit."},
]  # fmt: skip

_CACHE: OrderedDict[tuple[str, float, str | None, int], pd.DataFrame] = OrderedDict()
EXCEL = (".xlsx", ".xls")
EXPORT_FORMATS = {"csv": "CSV", "xlsx": "Excel", "parquet": "Parquet", "json": "JSON"}
EXCEL_MAX_ROWS = 1_048_575  # one row is the header


# ------------------------------------------------------------------------------------- reading


def _sniff_separator(sample: str) -> str:
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        return ","


def read_table(path: Path, sheet: str | None = None, header_row: int = 1) -> pd.DataFrame:
    """One table from a file. Excel: ``sheet`` (the first when None), headers on ``header_row`` (1 = top)."""
    try:
        return _read_table(path, sheet, header_row)
    except UserError:
        raise
    except pd.errors.EmptyDataError as error:
        raise UserError("the file is empty: it has no columns") from error
    except ValueError as error:
        if "header=" in str(error) and sheet is not None:
            raise UserError(f"the sheet {sheet} has fewer than {header_row} rows") from error
        raise UserError(f"could not read this {path.suffix or ''} file: {_first_line(error)}") from error
    except (zipfile.BadZipFile, pd.errors.ParserError, UnicodeError, OSError, KeyError, TypeError) as error:
        raise UserError(f"could not read this {path.suffix or ''} file: {_first_line(error)}") from error


def _first_line(error: Exception) -> str:
    text = str(error).strip().splitlines()
    return (text[0] if text else type(error).__name__)[:200]


def _read_table(path: Path, sheet: str | None, header_row: int) -> pd.DataFrame:
    suffix = path.suffix.lower()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        if suffix in (".csv", ".tsv", ".txt"):
            raw = path.read_bytes()[:65536]
            for encoding in ("utf-8-sig", "latin-1"):
                try:
                    sample = raw.decode(encoding)
                    break
                except UnicodeDecodeError:
                    continue
            separator = "\t" if suffix == ".tsv" else _sniff_separator(sample)
            try:
                return pd.read_csv(path, sep=separator, encoding="utf-8-sig", low_memory=False)
            except UnicodeDecodeError:
                return pd.read_csv(path, sep=separator, encoding="latin-1", low_memory=False)
        if suffix in EXCEL:
            try:
                return pd.read_excel(path, sheet_name=sheet if sheet is not None else 0, header=max(0, header_row - 1))
            except ImportError as error:
                raise UserError("reading Excel files needs the openpyxl package in this engine") from error
            except ValueError as error:
                if sheet is not None and "not found" in str(error):
                    raise UserError(f"the file has no sheet called {sheet}") from error
                raise
        if suffix in (".parquet", ".pq"):
            try:
                return pd.read_parquet(path)
            except ImportError as error:
                raise UserError("reading Parquet files needs the pyarrow package in this engine") from error
        if suffix in (".jsonl", ".ndjson"):
            return pd.read_json(path, lines=True)
        if suffix == ".json":
            try:
                return pd.read_json(path)
            except ValueError:
                return pd.read_json(path, lines=True)
    raise UserError(f"{path.suffix or 'this'} files are not supported; use CSV, Excel, Parquet or JSON")


def excel_sheets(path: Path) -> list[dict[str, Any]]:
    """The sheets of an Excel file with their used size, in workbook order (hidden ones marked)."""
    if path.suffix.lower() == ".xlsx":
        try:
            import openpyxl
        except ImportError as error:
            raise UserError("reading Excel files needs the openpyxl package in this engine") from error
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            try:
                book = openpyxl.load_workbook(path, read_only=True, data_only=True)
            except Exception as error:  # noqa: BLE001 - not a workbook: a zip of something else, or damaged
                raise UserError(f"could not open this Excel file: {_first_line(error)}") from error
        try:
            listed = []
            for sheet in book.worksheets:
                try:
                    rows, columns = int(sheet.max_row or 0), int(sheet.max_column or 0)
                except Exception:  # noqa: BLE001 - a sheet without a stored size
                    rows = columns = 0
                if rows == 1 and columns == 1 and sheet.cell(1, 1).value is None:
                    rows = columns = 0  # an empty sheet reports A1
                listed.append({"name": sheet.title, "rows": rows, "columns": columns,
                               "hidden": sheet.sheet_state != "visible"})  # fmt: skip
            return listed
        finally:
            book.close()
    try:
        names = pd.ExcelFile(path).sheet_names
    except ImportError as error:
        raise UserError("reading .xls files needs the xlrd package in this engine") from error
    except Exception as error:  # noqa: BLE001 - damaged, or not really an Excel file
        raise UserError(f"could not open this Excel file: {_first_line(error)}") from error
    return [{"name": str(n), "rows": None, "columns": None, "hidden": False} for n in names]


def _tidy(frame: pd.DataFrame) -> pd.DataFrame:
    frame = frame.loc[:, [not str(c).startswith("Unnamed: ") or frame[c].notna().any() for c in frame.columns]]
    frame.columns = [str(c).strip() or f"column_{i}" for i, c in enumerate(frame.columns)]
    if frame.columns.duplicated().any():
        seen: dict[str, int] = {}
        names = []
        for name in frame.columns:
            seen[name] = seen.get(name, 0) + 1
            names.append(name if seen[name] == 1 else f"{name}_{seen[name]}")
        frame.columns = names
    return frame


def meta_path(ws: Workspace, dataset_id: str) -> Path:
    path = ws.datasets / dataset_id / "meta.json"
    if not path.is_file():
        raise UserError("dataset not found; it may have been deleted")
    return path


def get_meta(ws: Workspace, dataset_id: str) -> dict[str, Any]:
    return dict(ws.read_json(meta_path(ws, dataset_id)))


def data_file(ws: Workspace, dataset_id: str) -> Path:
    meta = get_meta(ws, dataset_id)
    return ws.datasets / dataset_id / meta["file"]


def load_frame(ws: Workspace, dataset_id: str) -> pd.DataFrame:
    meta = get_meta(ws, dataset_id)
    if meta["kind"] != "tabular":
        raise UserError("this dataset is a folder of images, not a table")
    path = ws.datasets / dataset_id / meta["file"]
    sheet, header_row = meta.get("sheet"), int(meta.get("header_row") or 1)
    key = (str(path), path.stat().st_mtime, sheet, header_row)
    if key in _CACHE:
        _CACHE.move_to_end(key)
        return _CACHE[key]
    frame = _tidy(read_table(path, sheet, header_row))
    _CACHE[key] = frame
    while len(_CACHE) > MAX_CACHED:
        _CACHE.popitem(last=False)
    return frame


# ----------------------------------------------------------------------------------- importing


def _image_root(folder: Path) -> Path | None:
    """The folder whose sub-folders are classes (skips a single wrapping folder)."""
    current = folder
    for _ in range(3):
        children = [c for c in current.iterdir() if c.is_dir() and not c.name.startswith((".", "__MACOSX"))]
        images_here = [f for f in current.iterdir() if f.suffix.lower() in IMAGE_EXTENSIONS]
        if len(children) == 1 and not images_here:
            current = children[0]
            continue
        with_images = [c for c in children if any(f.suffix.lower() in IMAGE_EXTENSIONS for f in c.rglob("*"))]
        return current if len(with_images) >= 2 else None
    return None


def image_classes(root: Path) -> dict[str, list[Path]]:
    classes: dict[str, list[Path]] = {}
    for folder in sorted(c for c in root.iterdir() if c.is_dir() and not c.name.startswith((".", "__MACOSX"))):
        files = sorted(
            f for f in folder.rglob("*") if f.suffix.lower() in IMAGE_EXTENSIONS and not f.name.startswith(".")
        )
        if files:
            classes[folder.name] = files
    return classes


def _write_meta(ws: Workspace, dataset_id: str, meta: dict[str, Any]) -> dict[str, Any]:
    ws.write_json(ws.datasets / dataset_id / "meta.json", meta)
    return meta


def guess_header_row(path: Path, sheet: str) -> int:
    """The row an Excel sheet's column names are on: the first row of text that is about as wide as
    the table under it. Titles and notes above a table (one or two cells) are skipped; 1 otherwise."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            raw = pd.read_excel(path, sheet_name=sheet, header=None, nrows=30)
    except Exception:  # noqa: BLE001 - unreadable here: the normal read reports it
        return 1
    if raw.empty:
        return 1
    counts = raw.notna().sum(axis=1)
    widest = int(counts.max())
    for index, count in enumerate(counts):
        values = raw.iloc[index].dropna()
        if count >= max(2, -(-widest * 6 // 10)) and all(isinstance(v, str) and v.strip() for v in values):
            return index + 1
        if count >= max(2, widest - 1) and not all(isinstance(v, str) for v in values):
            break  # data starts with no header row of text above it: keep row 1
    return 1


def _usable(frame: pd.DataFrame) -> bool:
    return not frame.empty and len(frame.columns) >= 2


def _table_meta(
    ws: Workspace,
    dataset_id: str,
    name: str,
    file: str,
    source: str,
    sheet: str | None = None,
    header_row: int | None = None,
) -> dict[str, Any]:
    """``header_row`` None: found by guess_header_row (Excel), else 1."""
    folder = ws.datasets / dataset_id
    path = folder / file
    extra: dict[str, Any] = {}
    if path.suffix.lower() in EXCEL:
        sheets = excel_sheets(path)
        if sheet is None:  # the first visible sheet that holds a table
            frame = None
            for candidate in sorted(sheets, key=lambda s: bool(s["hidden"])):
                if candidate["rows"] == 0:
                    continue
                row = header_row or guess_header_row(path, candidate["name"])
                attempt = _tidy(read_table(path, candidate["name"], row))
                if _usable(attempt):
                    frame, sheet, header_row = attempt, candidate["name"], row
                    break
            if frame is None:
                raise UserError("none of the sheets holds a table with at least two columns and one row")
        else:
            header_row = header_row or guess_header_row(path, sheet)
            frame = _tidy(read_table(path, sheet, header_row))
        extra = {"sheet": sheet, "sheets": sheets, "header_row": header_row}
    else:
        frame = _tidy(read_table(path))
    header_row = header_row or 1
    if not _usable(frame):
        where = (
            f"the sheet {sheet}" + (f" with headers on row {header_row}" if header_row > 1 else "")
            if sheet
            else "the table"
        )
        raise UserError(f"{where} needs at least two columns and one row")
    return {"id": dataset_id, "name": name, "kind": "tabular", "file": file, "rows": int(len(frame)),
            "columns": int(len(frame.columns)), "size": path.stat().st_size, "created": now(), "source": source,
            **extra}  # fmt: skip


def _used_by(ws: Workspace, dataset_id: str) -> list[str]:
    """Names of the projects trained on a dataset."""
    names = []
    for path in ws.projects.glob("*.json"):
        try:
            project = ws.read_json(path)
        except (ValueError, OSError):
            continue
        if project.get("dataset_id") == dataset_id:
            names.append(str(project.get("name") or project.get("id")))
    return names


def choose_sheet(ws: Workspace, dataset_id: str, sheet: str, header_row: Any = 1) -> dict[str, Any]:
    """Read another sheet of an imported Excel file, or take the headers from a lower row. When
    projects already use the dataset, they keep their table: the choice goes to a copy, returned."""
    meta = get_meta(ws, dataset_id)
    if Path(meta.get("file", "")).suffix.lower() not in EXCEL:
        raise UserError("only Excel datasets have sheets")
    names = [s["name"] for s in meta.get("sheets") or excel_sheets(ws.datasets / dataset_id / meta["file"])]
    if sheet not in names:
        raise UserError(f"the file has no sheet called {sheet}")
    if header_row is None or header_row == "":  # another sheet: find its header row again
        header_row = guess_header_row(ws.datasets / dataset_id / meta["file"], sheet)
    try:
        header_row = int(header_row)
    except (TypeError, ValueError) as error:
        raise UserError("the header row is a number from 1 to 1000") from error
    if not 1 <= header_row <= 1000:
        raise UserError("the header row is a number from 1 to 1000")
    if sheet == meta.get("sheet") and header_row == int(meta.get("header_row") or 1):
        return meta
    target_id, name = dataset_id, meta["name"]
    if _used_by(ws, dataset_id):
        target_id, name = new_id("d"), f"{meta['name']} ({sheet})"
        shutil.copytree(ws.datasets / dataset_id, ws.datasets / target_id)
    try:
        fresh = _table_meta(ws, target_id, name, meta["file"], meta.get("source", ""), sheet, header_row)
    except Exception:
        if target_id != dataset_id:
            shutil.rmtree(ws.datasets / target_id, ignore_errors=True)
        raise
    created = meta.get("created", fresh["created"]) if target_id == dataset_id else fresh["created"]
    return _write_meta(ws, target_id, {**fresh, "created": created})


def export(ws: Workspace, dataset_id: str, fmt: str) -> dict[str, Any]:
    """A dataset as a CSV, Excel, Parquet or JSON file to download."""
    if fmt not in EXPORT_FORMATS:
        raise UserError("export as CSV, Excel, Parquet or JSON")
    meta = get_meta(ws, dataset_id)
    frame = load_frame(ws, dataset_id)
    folder = ws.root / "exports" / "datasets"
    folder.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^\w.-]+", "_", str(meta.get("name") or "dataset").strip())[:60].strip("_") or "dataset"
    target = folder / f"{stem}.{fmt}"
    if fmt == "csv":
        frame.to_csv(target, index=False)
    elif fmt == "json":
        frame.to_json(target, orient="records", date_format="iso", force_ascii=False)
    elif fmt == "parquet":
        try:
            _parquet_ready(frame.copy()).to_parquet(target, index=False)
        except ImportError as error:
            raise UserError("writing Parquet files needs the pyarrow package in this engine") from error
    else:
        if len(frame) > EXCEL_MAX_ROWS:
            raise UserError(f"Excel holds at most {EXCEL_MAX_ROWS:,} rows; export it as CSV or Parquet.")
        try:
            frame.to_excel(target, index=False, sheet_name=stem[:31] or "Data")
        except ImportError as error:
            raise UserError("writing Excel files needs the openpyxl package in this engine") from error
    return {"path": target.relative_to(ws.root).as_posix(), "name": target.name, "rows": int(len(frame)),
            "bytes": target.stat().st_size}  # fmt: skip


def _parquet_ready(frame: pd.DataFrame) -> pd.DataFrame:
    """Parquet wants one type per column: mixed text-and-number columns become text."""
    for column in frame.columns:
        if frame[column].dtype == object:
            values = frame[column].dropna()
            if not values.empty and not values.map(lambda v: isinstance(v, str)).all():
                frame[column] = frame[column].map(lambda v: v if v is None or isinstance(v, str) or v != v else str(v))
    frame.columns = [str(c) for c in frame.columns]
    return frame


def _images_meta(ws: Workspace, dataset_id: str, name: str, root: Path, source: str) -> dict[str, Any]:
    classes = image_classes(root)
    if len(classes) < 2:
        raise UserError("an image dataset needs at least two class folders, e.g. cats/ and dogs/")
    folder = ws.datasets / dataset_id
    return {"id": dataset_id, "name": name, "kind": "image", "file": root.relative_to(folder).as_posix(),
            "rows": sum(len(v) for v in classes.values()), "columns": len(classes),
            "classes": {k: len(v) for k, v in classes.items()},
            "size": sum(f.stat().st_size for v in classes.values() for f in v), "created": now(), "source": source}  # fmt: skip


def import_file(ws: Workspace, source: Path, filename: str | None = None) -> dict[str, Any]:
    """Copy a file (or folder of class folders) into the workspace as a new dataset."""
    filename = filename or source.name
    name = Path(filename).stem or "dataset"
    dataset_id = new_id("d")
    folder = ws.datasets / dataset_id
    folder.mkdir(parents=True)
    try:
        if source.is_dir():
            target = folder / "images"
            shutil.copytree(source, target)
            root = _image_root(target)
            if root is None:
                raise UserError("the folder needs one sub-folder of images per class")
            return _write_meta(ws, dataset_id, _images_meta(ws, dataset_id, name, root, filename))
        suffix = Path(filename).suffix.lower()
        if suffix == ".zip":
            target = folder / "images"
            with zipfile.ZipFile(source) as archive:
                for member in archive.infolist():
                    resolved = (target / member.filename).resolve()
                    if target.resolve() not in resolved.parents and resolved != target.resolve():
                        raise UserError("the zip contains unsafe paths")
                archive.extractall(target)
            root = _image_root(target)
            if root is not None:
                return _write_meta(ws, dataset_id, _images_meta(ws, dataset_id, name, root, filename))
            tables = [
                f for f in target.rglob("*") if f.suffix.lower() in TABLE_EXTENSIONS and "__MACOSX" not in f.parts
            ]
            if len(tables) != 1:
                raise UserError("a zip must hold one table, or one folder of images per class")
            file = tables[0].relative_to(folder).as_posix()
            return _write_meta(ws, dataset_id, _table_meta(ws, dataset_id, name, file, filename))
        if suffix not in TABLE_EXTENSIONS:
            raise UserError(f"{suffix or 'this'} files are not supported; use CSV, Excel, Parquet, JSON or a zip")
        file = "data" + suffix
        shutil.copyfile(source, folder / file)
        return _write_meta(ws, dataset_id, _table_meta(ws, dataset_id, name, file, filename))
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise


def _sample_frame(sample_id: str) -> pd.DataFrame:
    from sklearn import datasets as sk

    if sample_id == "churn":
        return pd.read_csv(SAMPLES_DIR / "churn.csv")
    if sample_id == "fraud":
        return pd.read_csv(SAMPLES_DIR / "imbalanced_2pct.csv")
    if sample_id == "orders":
        return pd.read_csv(SAMPLES_DIR / "mixed_messy.csv")
    if sample_id == "iris":
        bunch = sk.load_iris(as_frame=True)
        frame = bunch.frame.rename(columns=lambda c: c.replace(" (cm)", "").replace(" ", "_"))
        frame["species"] = [bunch.target_names[i] for i in bunch.target]
        return frame.drop(columns=["target"])
    if sample_id == "wine":
        bunch = sk.load_wine(as_frame=True)
        frame = bunch.frame.copy()
        frame["cultivar"] = [f"cultivar_{i + 1}" for i in bunch.target]
        return frame.drop(columns=["target"])
    if sample_id == "breast_cancer":
        bunch = sk.load_breast_cancer(as_frame=True)
        frame = bunch.frame.copy()
        frame.columns = [c.replace(" ", "_") for c in frame.columns]
        frame["diagnosis"] = ["benign" if t == 1 else "malignant" for t in bunch.target]
        return frame.drop(columns=["target"])
    if sample_id == "diabetes":
        bunch = sk.load_diabetes(as_frame=True, scaled=False)
        frame = bunch.frame.rename(columns={"target": "progression"})
        return frame
    raise UserError(f"unknown sample {sample_id}")


def import_sample(ws: Workspace, sample_id: str) -> dict[str, Any]:
    sample = next((s for s in SAMPLES if s["id"] == sample_id), None)
    if sample is None:
        raise UserError(f"unknown sample {sample_id}")
    for meta_file in ws.datasets.glob("*/meta.json"):  # import each sample once
        meta = ws.read_json(meta_file)
        if meta.get("source") == f"sample:{sample_id}":
            return dict(meta)
    dataset_id = new_id("d")
    folder = ws.datasets / dataset_id
    folder.mkdir(parents=True)
    try:
        if sample["kind"] == "image":
            from PIL import Image
            from sklearn.datasets import load_digits

            digits = load_digits()
            root = folder / "images"
            for index, (pixels, label) in enumerate(zip(digits.images, digits.target, strict=True)):
                target = root / str(label)
                target.mkdir(parents=True, exist_ok=True)
                array = (255 - pixels / 16 * 255).clip(0, 255).astype(np.uint8)
                Image.fromarray(array, mode="L").resize((32, 32), Image.Resampling.NEAREST).save(
                    target / f"{index:04d}.png"
                )
            meta = _images_meta(ws, dataset_id, sample["name"], root, f"sample:{sample_id}")
        else:
            _sample_frame(sample_id).to_csv(folder / "data.csv", index=False)
            meta = _table_meta(ws, dataset_id, sample["name"], "data.csv", f"sample:{sample_id}")
        meta["sample"] = {"target": sample["target"], "task": sample["task"]}
        return _write_meta(ws, dataset_id, meta)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise


def list_datasets(ws: Workspace) -> list[dict[str, Any]]:
    found = []
    for meta_file in ws.datasets.glob("*/meta.json"):
        try:
            found.append(ws.read_json(meta_file))
        except ValueError:
            continue
    return sorted(found, key=lambda m: m.get("created", ""), reverse=True)


def delete_dataset(ws: Workspace, dataset_id: str) -> None:
    meta_path(ws, dataset_id)
    ws.remove(ws.datasets / dataset_id)


def rename_dataset(ws: Workspace, dataset_id: str, name: str) -> dict[str, Any]:
    meta = get_meta(ws, dataset_id)
    meta["name"] = name.strip() or meta["name"]
    return _write_meta(ws, dataset_id, meta)


# ----------------------------------------------------------------------------------- profiling


def guess_task(series: pd.Series) -> str:
    values = series.dropna()
    if rt.is_bool_series(series) or not rt.is_numeric_series(series):
        return "classification"
    unique = values.nunique()
    integers = bool(np.all(np.mod(values.to_numpy(dtype=float), 1) == 0)) if len(values) else False
    if integers and (unique <= 10 or (unique <= 20 and unique < 0.05 * len(values))):
        return "classification"
    return "regression"


TARGET_NAMES = ("target", "label", "class", "y", "outcome", "churn", "churned", "price", "species", "diagnosis")


def guess_target(frame: pd.DataFrame) -> str:
    lowered = {str(c).lower(): str(c) for c in frame.columns}
    for name in TARGET_NAMES:
        if name in lowered:
            return lowered[name]
    for column in frame.columns:
        if any(str(column).lower().startswith(p) or str(column).lower().endswith(p) for p in ("is_", "has_churn")):
            return str(column)
    return str(frame.columns[-1])


def _histogram(values: np.ndarray, bins: int = 24) -> dict[str, Any]:
    if len(values) == 0:
        return {"edges": [], "counts": []}
    low, high = float(np.min(values)), float(np.max(values))
    if low == high:
        return {"edges": [low, high], "counts": [int(len(values))]}
    counts, edges = np.histogram(values, bins=min(bins, max(2, int(np.unique(values).size))))
    return {"edges": round_floats(edges.tolist()), "counts": counts.tolist()}


def _numbers_as_text(series: pd.Series) -> bool:
    if rt.is_numeric_series(series) or rt.is_bool_series(series):
        return False
    values = series.dropna().astype(str).head(500)
    if len(values) < 5:
        return False
    cleaned = values.str.replace(r"[,$%\s€£]", "", regex=True)
    cleaned = cleaned[~cleaned.str.upper().isin({"N/A", "NA", "NAN", "NULL", "NONE", "-", ""})]
    return len(cleaned) > 0 and pd.to_numeric(cleaned, errors="coerce").notna().mean() > 0.95


def profile_column(series: pd.Series, rows: int) -> dict[str, Any]:
    kind = rt.column_kind(series)
    missing = int(series.isna().sum())
    non_null = series.dropna()
    unique = int(non_null.astype(str).nunique()) if len(non_null) else 0
    info: dict[str, Any] = {
        "name": str(series.name), "kind": kind, "dtype": str(series.dtype), "missing": missing,
        "missing_pct": round(100 * missing / rows, 2) if rows else 0.0, "unique": unique,
        "sample": [jsonable(v) for v in non_null.head(5).tolist()], "flags": [],
    }  # fmt: skip
    if kind == "numeric":
        values = pd.to_numeric(non_null, errors="coerce").replace([np.inf, -np.inf], np.nan).dropna().to_numpy(float)
        if len(values):
            q1, median, q3 = np.percentile(values, [25, 50, 75])
            iqr = q3 - q1
            outliers = int(((values < q1 - 3 * iqr) | (values > q3 + 3 * iqr)).sum()) if iqr > 0 else 0
            std = float(values.std())
            skew = float(((values - values.mean()) ** 3).mean() / std**3) if std > 0 else 0.0
            info["stats"] = round_floats({"min": float(values.min()), "max": float(values.max()),
                                          "mean": float(values.mean()), "std": std, "median": float(median),
                                          "q1": float(q1), "q3": float(q3), "zeros": int((values == 0).sum()),
                                          "skew": skew, "outliers": outliers})  # fmt: skip
            info["histogram"] = _histogram(values)
            if abs(skew) > 2 and values.min() >= 0:
                info["flags"].append("skewed")
            if outliers:
                info["flags"].append("outliers")
    elif kind == "datetime":
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            parsed = pd.to_datetime(non_null, errors="coerce", format="mixed").dropna()
        if len(parsed):
            info["stats"] = {"min": parsed.min().isoformat(), "max": parsed.max().isoformat()}
    else:
        counts = non_null.astype(str).value_counts()
        info["top"] = [{"value": str(k), "count": int(v)} for k, v in counts.head(12).items()]
        if kind in ("categorical", "text"):
            text = non_null.astype(str)
            tidy_unique = text.str.strip().str.lower().str.replace(r"\s+", " ", regex=True).nunique()
            if 0 < tidy_unique < unique:
                info["flags"].append("inconsistent_text")
                info["tidy_unique"] = int(tidy_unique)
            if _numbers_as_text(series):
                info["flags"].append("numbers_as_text")
            if kind == "text":
                info["stats"] = {"avg_length": round(float(text.str.len().mean()), 1)}
    if unique <= 1:
        info["flags"].append("constant")
    if kind in ("categorical", "numeric") and rows >= 20 and unique >= 0.95 * (rows - missing) and missing < rows:
        if kind == "categorical" or (kind == "numeric" and str(series.name).lower().endswith("id")):
            info["flags"].append("id_like")
    if kind == "categorical" and unique > 50 and "id_like" not in info["flags"]:
        info["flags"].append("high_cardinality")
    if missing and missing / max(1, rows) >= 0.4:
        info["flags"].append("mostly_missing")
    return info


def _target_info(frame: pd.DataFrame, target: str) -> dict[str, Any]:
    series = frame[target]
    task = guess_task(series)
    info: dict[str, Any] = {"name": target, "task": task, "missing": int(series.isna().sum())}
    if task == "classification":
        counts = series.dropna().astype(str).value_counts()
        info["classes"] = [{"value": str(k), "count": int(v)} for k, v in counts.head(50).items()]
        info["n_classes"] = int(len(counts))
        info["minority_share"] = round(float(counts.min() / counts.sum()), 4) if len(counts) else None
    else:
        values = pd.to_numeric(series, errors="coerce").dropna().to_numpy(float)
        info["histogram"] = _histogram(values)
    return info


def _correlations(frame: pd.DataFrame, target: str | None) -> dict[str, Any]:
    numeric = [c for c in frame.columns if rt.is_numeric_series(frame[c]) or rt.is_bool_series(frame[c])][:30]
    if len(numeric) < 2:
        return {"columns": numeric, "matrix": []}
    data = frame[numeric].apply(pd.to_numeric, errors="coerce").astype(float)
    corr = data.corr().fillna(0.0)
    result: dict[str, Any] = {"columns": numeric, "matrix": round_floats(corr.to_numpy().tolist(), 3)}
    if target and target in frame.columns:
        encoded = frame[target]
        if not rt.is_numeric_series(encoded):
            encoded = encoded.astype("category").cat.codes.where(encoded.notna())
        with_target = data.corrwith(pd.to_numeric(encoded, errors="coerce").astype(float)).drop(
            labels=[target], errors="ignore"
        )
        result["with_target"] = [
            {"column": str(k), "value": round(float(v), 3)}
            for k, v in with_target.dropna().abs().sort_values(ascending=False).items()
        ][:20]
    return result


def suggestions(frame: pd.DataFrame, columns: list[dict[str, Any]], target: str | None) -> list[dict[str, Any]]:
    """Fixes worth making, each with the pipeline step that makes it (one click in the app)."""
    found: list[dict[str, Any]] = []
    by_flag = lambda flag: [c["name"] for c in columns if flag in c["flags"] and c["name"] != target]  # noqa: E731
    ids = by_flag("id_like")
    if ids:
        found.append({"id": "drop_ids", "level": "warning", "auto": True,
                      "message": f"{', '.join(ids)} look{'s' if len(ids) == 1 else ''} like an ID. IDs carry no "
                      "pattern a model can learn and can make it memorise rows.",
                      "fix": {"stage": "clean", "op": "drop_columns", "params": {"columns": ids}, "label": "Drop ID columns"}})  # fmt: skip
    constant = by_flag("constant")
    if constant:
        found.append({"id": "drop_constant", "level": "info", "auto": True,
                      "message": f"{', '.join(constant)} never change{'s' if len(constant) == 1 else ''}.",
                      "fix": {"stage": "clean", "op": "drop_columns", "params": {"columns": constant},
                              "label": "Drop constant columns"}})  # fmt: skip
    as_text = by_flag("numbers_as_text")
    if as_text:
        found.append({"id": "numbers_as_text", "level": "warning", "auto": True,
                      "message": f"{', '.join(as_text)} hold{'s' if len(as_text) == 1 else ''} numbers stored as text "
                      "(e.g. \"1,909.47\" or \"N/A\").",
                      "fix": {"stage": "clean", "op": "change_type", "params": {"columns": as_text, "to": "numeric"},
                              "label": "Convert to numbers"}})  # fmt: skip
    messy = [c for c in by_flag("inconsistent_text") if c not in as_text]
    if messy:
        found.append({"id": "tidy_text", "level": "warning", "auto": True,
                      "message": f"{', '.join(messy)} spell the same value in different ways (spaces or capitals).",
                      "fix": {"stage": "clean", "op": "clean_text", "params": {"columns": messy, "case": "lower",
                              "strip": True}, "label": "Tidy text"}})  # fmt: skip
    dates = [c["name"] for c in columns if c["kind"] == "datetime" and c["name"] != target]
    if dates:
        found.append({"id": "dates", "level": "info", "auto": True,
                      "message": f"{', '.join(dates)} {'is a date' if len(dates) == 1 else 'are dates'}. Year, month "
                      "and weekday are easier for a model to use.",
                      "fix": {"stage": "clean", "op": "extract_datetime", "params": {"columns": dates,
                              "parts": ["year", "month", "weekday"], "drop_original": True},
                              "label": "Extract date parts"}})  # fmt: skip
    mostly = by_flag("mostly_missing")
    if mostly:
        found.append({"id": "mostly_missing", "level": "warning", "auto": False,
                      "message": f"{', '.join(mostly)} {'is' if len(mostly) == 1 else 'are'} at least 40% empty.",
                      "fix": {"stage": "clean", "op": "drop_columns", "params": {"columns": mostly},
                              "label": "Drop mostly-empty columns"}})  # fmt: skip
    gaps = [c["name"] for c in columns if c["missing"] and c["name"] != target and c["name"] not in mostly + ids]
    numeric_gaps = [g for g in gaps if next(c for c in columns if c["name"] == g)["kind"] == "numeric"]
    if numeric_gaps:
        found.append({"id": "impute", "level": "info", "auto": False,
                      "message": f"{len(numeric_gaps)} numeric column{'s have' if len(numeric_gaps) > 1 else ' has'} gaps "
                      f"({', '.join(numeric_gaps[:4])}{'…' if len(numeric_gaps) > 4 else ''}). Auto-prep fills them with "
                      "the median; choose another method if you prefer.",
                      "fix": {"stage": "transform", "op": "impute", "params": {"columns": numeric_gaps, "strategy": "median",
                              "indicator": False}, "label": "Fill missing numbers"}})  # fmt: skip
    skewed = by_flag("skewed")
    if skewed:
        found.append({"id": "skewed", "level": "info", "auto": False,
                      "message": f"{', '.join(skewed[:4])} {'is' if len(skewed) == 1 else 'are'} strongly skewed. "
                      "Linear models and neural networks learn better after a log or power transform.",
                      "fix": {"stage": "transform", "op": "power", "params": {"columns": skewed, "method": "yeo-johnson"},
                              "label": "Fix skew"}})  # fmt: skip
    duplicates = int(frame.duplicated().sum())
    if duplicates:
        found.append({"id": "duplicates", "level": "warning", "auto": False,
                      "message": f"{duplicates} row{'s are' if duplicates > 1 else ' is'} exact duplicates. They can "
                      "end up in both training and test data and inflate scores.",
                      "fix": {"stage": "clean", "op": "drop_duplicates", "params": {"columns": []},
                              "label": "Remove duplicates"}})  # fmt: skip
    if target and target in frame.columns:
        info = _target_info(frame, target)
        if info["missing"]:
            found.append(
                {
                    "id": "target_missing",
                    "level": "info",
                    "auto": False,
                    "message": f"{info['missing']} rows have no {target}; they are left out of training.",
                }
            )
        share = info.get("minority_share")
        if info["task"] == "classification" and share is not None and share < 0.15:
            found.append({"id": "imbalance", "level": "warning", "auto": False,
                          "message": f"The rarest {target} class is only {share:.1%} of rows. Balance the training "
                          "rows, and judge models by F1 or balanced accuracy rather than accuracy.",
                          "fix": {"stage": "rows", "op": "balance_classes", "params": {"method": "oversample"},
                                  "label": "Balance classes"}})  # fmt: skip
        leaks = _leak_suspects(frame, target)
        if leaks:
            found.append({"id": "leak", "level": "error", "auto": False,
                          "message": f"{', '.join(leaks)} predict{'s' if len(leaks) == 1 else ''} {target} almost "
                          "perfectly. If this is only known after the outcome, it leaks the answer.",
                          "fix": {"stage": "clean", "op": "drop_columns", "params": {"columns": leaks},
                                  "label": "Drop suspected leaks"}})  # fmt: skip
    return found


def _leak_suspects(frame: pd.DataFrame, target: str) -> list[str]:
    suspects = []
    data = frame.dropna(subset=[target])
    if len(data) < 30:
        return []
    y = data[target].astype(str)
    for column in data.columns:
        if column == target:
            continue
        x = data[column]
        if x.isna().mean() > 0.5:
            continue
        unique = x.astype(str).nunique()
        if unique < 2 or unique > 50:
            if rt.is_numeric_series(x) and rt.is_numeric_series(data[target]):
                corr = pd.to_numeric(x, errors="coerce").corr(pd.to_numeric(data[target], errors="coerce"))
                if corr is not None and abs(corr) > 0.995:
                    suspects.append(str(column))
            continue
        # how well does this column alone predict the target? (purity of the target within each value)
        table = pd.crosstab(x.astype(str), y)
        purity = float(table.max(axis=1).sum() / table.to_numpy().sum())
        baseline = float(y.value_counts(normalize=True).max())
        if purity > 0.98 and purity - baseline > 0.1:
            suspects.append(str(column))
    return suspects


def profile(ws: Workspace, dataset_id: str, target: str | None = None) -> dict[str, Any]:
    meta = get_meta(ws, dataset_id)
    if meta["kind"] == "image":
        return image_profile(ws, dataset_id)
    frame = load_frame(ws, dataset_id)
    sample = frame if len(frame) <= 200_000 else frame.sample(200_000, random_state=0)
    rows = len(sample)
    columns = [profile_column(sample[c], rows) for c in sample.columns]
    if not target or target not in frame.columns:
        target = (meta.get("sample") or {}).get("target") or guess_target(frame)
    if target in sample.columns:
        _split_by_target(sample, columns, target)
    return {
        "dataset": meta, "kind": "tabular", "rows": int(len(frame)), "columns": columns,
        "duplicates": int(sample.duplicated().sum()),
        "missing_cells_pct": round(100 * float(sample.isna().to_numpy().mean()), 2),
        "memory_mb": round(float(frame.memory_usage(deep=True).sum()) / 1e6, 2),
        "target": _target_info(sample, target) if target in sample.columns else None,
        "suggested_target": target, "correlations": _correlations(sample, target),
        "suggestions": suggestions(sample, columns, target), "sampled": len(frame) > rows,
    }  # fmt: skip


def _split_by_target(frame: pd.DataFrame, columns: list[dict[str, Any]], target: str, most: int = 6) -> None:
    """Each number column's histogram again, one per class of a categorical target (2 to ``most`` classes)."""
    labels = frame[target]
    if rt.is_numeric_series(labels) and labels.nunique() > most:
        return
    classes = labels.dropna().astype(str).value_counts()
    if not 2 <= len(classes) <= most:
        return
    as_text = labels.astype(str).where(labels.notna())
    for column in columns:
        edges = (column.get("histogram") or {}).get("edges") or []
        if column["name"] == target or len(edges) < 3:
            continue
        values = pd.to_numeric(frame[column["name"]], errors="coerce")
        column["by_target"] = [{"label": str(label), "counts": np.histogram(values[(as_text == label) & values.notna()],
                                                                             bins=np.asarray(edges, float))[0].tolist()}
                               for label in classes.index]  # fmt: skip


def preview(ws: Workspace, dataset_id: str, offset: int = 0, limit: int = 100) -> dict[str, Any]:
    from .util import frame_rows

    frame = load_frame(ws, dataset_id)
    return {
        "columns": [str(c) for c in frame.columns],
        "rows": frame_rows(frame, limit, offset),
        "total": int(len(frame)),
    }


# -------------------------------------------------------------------------------------- images


def image_root(ws: Workspace, dataset_id: str) -> Path:
    meta = get_meta(ws, dataset_id)
    if meta["kind"] != "image":
        raise UserError("this dataset is a table, not images")
    return ws.datasets / dataset_id / meta["file"]


def thumbnail(path: Path, size: int = 96) -> str:
    from PIL import Image

    with Image.open(path) as opened:
        image = opened.convert("RGB")
        image.thumbnail((size, size))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def image_profile(ws: Workspace, dataset_id: str) -> dict[str, Any]:
    meta = get_meta(ws, dataset_id)
    classes = image_classes(image_root(ws, dataset_id))
    sizes: list[tuple[int, int]] = []
    modes: dict[str, int] = {}
    samples: dict[str, list[str]] = {}
    try:
        from PIL import Image

        for name, files in classes.items():
            samples[name] = [thumbnail(f) for f in files[:6]]
            for file in files[:: max(1, len(files) // 20)][:20]:
                with Image.open(file) as image:
                    sizes.append(image.size)
                    modes[image.mode] = modes.get(image.mode, 0) + 1
    except ImportError:
        samples = {}
    counts = {k: len(v) for k, v in classes.items()}
    total = sum(counts.values())
    found: list[dict[str, Any]] = []
    if counts and min(counts.values()) < 0.3 * max(counts.values()):
        found.append(
            {
                "id": "imbalance",
                "level": "warning",
                "auto": False,
                "message": "Some classes have far fewer images than others. Augmentation and more images help.",
            }
        )
    if counts and min(counts.values()) < 20:
        found.append(
            {
                "id": "few",
                "level": "warning",
                "auto": False,
                "message": "Some classes have fewer than 20 images. A pretrained network works best here.",
            }
        )
    widths = [s[0] for s in sizes]
    heights = [s[1] for s in sizes]
    return {
        "dataset": meta, "kind": "image", "rows": total, "classes": [{"value": k, "count": v} for k, v in counts.items()],
        "samples": samples, "image_size": {"min": [min(widths, default=0), min(heights, default=0)],
                                           "max": [max(widths, default=0), max(heights, default=0)]},
        "modes": modes, "suggestions": found, "target": {"name": "label", "task": "classification",
                                                        "n_classes": len(counts),
                                                        "classes": [{"value": k, "count": v} for k, v in counts.items()]},
        "suggested_target": "label",
    }  # fmt: skip
