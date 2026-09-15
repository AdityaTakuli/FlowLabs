"""Code → Flow conversion (PRD II 3.1): per-section drafts that compile and run in Flow Mode."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from flowlab_engine import compile_flow, execute_plan, load_schemas, resolve_dataset_paths
from flowlab_lab import analyse_text
from flowlab_lab.to_flow import ConversionError, convert_section
from flowspec import FlowSpec
from helpers import FIXTURES

CELLS = [
    "import pandas as pd\nfrom sklearn.model_selection import train_test_split\n"
    "from sklearn.preprocessing import StandardScaler\nfrom sklearn.linear_model import LinearRegression\n"
    "from sklearn.metrics import r2_score",
    "df = pd.read_csv('clean_numeric.csv')",
    "X_train, X_test, y_train, y_test = train_test_split(df.drop(columns=['y']), df['y'], test_size=0.2, random_state=1)",
    "scaler = StandardScaler()\nX_train_scaled = scaler.fit_transform(X_train)",
    "model = LinearRegression()\nmodel.fit(X_train_scaled, y_train)",
    "print(r2_score(y_test, model.predict(scaler.transform(X_test))))",
    "for column in df.columns:\n    print(column, df[column].mean())",
]


def notebook() -> str:
    return json.dumps({
        "cells": [{"cell_type": "code", "source": c, "metadata": {}, "outputs": [], "execution_count": None} for c in CELLS],
        "metadata": {}, "nbformat": 4, "nbformat_minor": 5,
    })  # fmt: skip


def test_recognised_section_becomes_a_runnable_flow(tmp_path: Path) -> None:
    graph = analyse_text("regression.ipynb", notebook())
    conversion = convert_section(graph, ["b2", "b3", "b4", "b5", "b6"])
    spec = FlowSpec.model_validate(conversion.spec)
    assert [(n.type, n.params) for n in spec.nodes] == [
        ("source.dataset", {"dataset_ref": "primary", "target": "y"}),
        ("prep.split", {"test_size": 0.2, "seed": 1}),
        ("prep.scale", {"method": "standard"}),
        ("model.fit", {"algorithm": "linear_regression"}),
        ("model.evaluate", {}),
    ]
    assert spec.dataset_bindings == {"primary": "clean_numeric"}
    wiring = {(e.source, e.source_port, e.target, e.target_port) for e in spec.edges}
    assert wiring == {
        ("c_b2", "out", "c_b3", "in"),
        ("c_b3", "out", "c_b4", "in"),
        ("c_b4", "out", "c_b5", "train"),
        ("c_b5", "model", "c_b6", "model"),
        ("c_b4", "out", "c_b6", "data"),
    }
    paths, errors = resolve_dataset_paths(spec, FIXTURES)
    assert not errors
    result = compile_flow(spec, load_schemas(paths))
    assert result.ok, result.errors
    run = execute_plan(result.plan, paths, runs_dir=tmp_path / "runs")  # type: ignore[arg-type]
    assert run.status == "completed"
    assert json.loads((run.run_dir / "nodes/c_b6/metrics.json").read_text())["r2"] > 0.9


def test_unrecognised_blocks_are_reported_not_guessed() -> None:
    graph = analyse_text("regression.ipynb", notebook())
    conversion = convert_section(graph, ["b6", "b7"])
    assert conversion.skipped == [("b7", "no recognised pattern")]
    assert list(conversion.converted) == ["b6"]


def test_sections_must_be_contiguous() -> None:
    graph = analyse_text("regression.ipynb", notebook())
    with pytest.raises(ConversionError, match="contiguous"):
        convert_section(graph, ["b2", "b4"])
    with pytest.raises(ConversionError, match="unknown blocks"):
        convert_section(graph, ["b99"])


def test_non_literal_arguments_are_skipped_with_a_reason() -> None:
    graph = analyse_text("dyn.ipynb", json.dumps({
        "cells": [
            {"cell_type": "code", "source": "import pandas as pd", "metadata": {}, "outputs": [], "execution_count": None},
            {"cell_type": "code", "source": "df = pd.read_csv(path_from_config)", "metadata": {}, "outputs": [],
             "execution_count": None},
        ],
        "metadata": {}, "nbformat": 4, "nbformat_minor": 5,
    }))  # fmt: skip
    conversion = convert_section(graph, ["b2"])
    assert conversion.skipped == [("b2", "the file path is not a literal string")]
