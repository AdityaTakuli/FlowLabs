from __future__ import annotations

import zipfile
from pathlib import Path

import pandas as pd
import pytest

from synapse_studio.core import datasets
from synapse_studio.core.util import UserError


def test_samples_import_once_and_profile(ws):
    first = datasets.import_sample(ws, "churn")
    assert datasets.import_sample(ws, "churn")["id"] == first["id"]
    profile = datasets.profile(ws, first["id"])
    assert profile["rows"] == 2000 and profile["suggested_target"] == "churned"
    kinds = {c["name"]: c["kind"] for c in profile["columns"]}
    assert kinds["signup_date"] == "datetime" and kinds["plan_type"] == "categorical"
    assert kinds["has_partner"] == "boolean" and kinds["tenure_months"] == "numeric"
    ids = {s["id"] for s in profile["suggestions"]}
    assert {"drop_ids", "dates", "impute"} <= ids
    assert profile["target"]["task"] == "classification" and profile["target"]["n_classes"] == 2


@pytest.mark.parametrize("sample", ["iris", "wine", "breast_cancer", "diabetes", "fraud", "orders"])
def test_every_table_sample_loads(ws, sample):
    meta = datasets.import_sample(ws, sample)
    frame = datasets.load_frame(ws, meta["id"])
    assert meta["sample"]["target"] in frame.columns
    datasets.profile(ws, meta["id"])


def test_messy_orders_suggestions(ws):
    meta = datasets.import_sample(ws, "orders")
    profile = datasets.profile(ws, meta["id"])
    by_id = {s["id"]: s for s in profile["suggestions"]}
    assert "amount" in by_id["numbers_as_text"]["fix"]["params"]["columns"]
    assert "city" in by_id["tidy_text"]["fix"]["params"]["columns"]


def test_import_csv_semicolon_and_excel(ws, tmp_path: Path):
    csv = tmp_path / "data.csv"
    csv.write_text("a;b;label\n1;2;x\n3;4;y\n5;6;x\n")
    meta = datasets.import_file(ws, csv)
    assert meta["columns"] == 3 and meta["rows"] == 3
    xlsx = tmp_path / "sheet.xlsx"
    pd.DataFrame({"a": [1, 2], "b": ["x", "y"]}).to_excel(xlsx, index=False)
    assert datasets.import_file(ws, xlsx)["rows"] == 2


def test_image_zip_and_bad_files(ws, tmp_path: Path):
    from PIL import Image

    archive = tmp_path / "pets.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        for label in ("cat", "dog"):
            for i in range(3):
                image = tmp_path / f"{label}{i}.png"
                Image.new("RGB", (10, 10), (i * 40, 0, 0)).save(image)
                bundle.write(image, f"pets/{label}/{i}.png")
    meta = datasets.import_file(ws, archive)
    assert meta["kind"] == "image" and meta["classes"] == {"cat": 3, "dog": 3}
    profile = datasets.profile(ws, meta["id"])
    assert [c["value"] for c in profile["classes"]] == ["cat", "dog"]
    bad = tmp_path / "notes.docx"
    bad.write_text("x")
    with pytest.raises(UserError):
        datasets.import_file(ws, bad)
    assert len(datasets.list_datasets(ws)) == 1


def test_leak_suspect(ws, tmp_path: Path):
    import numpy as np

    rng = np.random.default_rng(0)
    y = rng.integers(0, 2, 300)
    frame = pd.DataFrame({"x": rng.normal(size=300), "refund": np.where(y == 1, "yes", "no"), "target": y})
    path = tmp_path / "leak.csv"
    frame.to_csv(path, index=False)
    meta = datasets.import_file(ws, path)
    profile = datasets.profile(ws, meta["id"], "target")
    leak = next(s for s in profile["suggestions"] if s["id"] == "leak")
    assert leak["fix"]["params"]["columns"] == ["refund"]
