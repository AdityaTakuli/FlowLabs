"""Data processing, sklearn and PyTorch training in real kernels, using examples/ml-lab.

These run the example project end to end: summaries for tensors, models, loaders and optimizers,
live training metrics parsed from printed output, tqdm progress, and explicit ``flowlab_log``.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest
from flowlab_api.service import short_value
from flowlab_lab.kernel import LabEvent, LabSession
from flowlab_lab.metrics import MetricParser
from flowlab_lab.project import LabProject

EXAMPLES = Path(__file__).resolve().parents[1] / "examples" / "ml-lab"
torch = pytest.importorskip("torch")


# --------------------------------------------------------------------------- parsing
@pytest.mark.parametrize(
    ("lines", "expected"),
    [
        (["epoch 1 loss=0.6931 val_loss=0.70 val_acc=0.51\n"], [(1.0, {"loss": 0.6931, "val_loss": 0.7, "val_acc": 0.51})]),
        (["Epoch 2/10\n", "50/50 [====] - 0s 2ms/step - loss: 0.41 - accuracy: 0.87\n"], [(2.0, {"loss": 0.41, "accuracy": 0.87})]),
        (["{'loss': 0.41, 'learning_rate': 5e-05, 'epoch': 1.0}\n"], [(1.0, {"loss": 0.41, "learning_rate": 5e-05})]),
        (["step 120 | loss: 0.3 | lr: 1e-3\n"], [(120.0, {"loss": 0.3, "lr": 0.001})]),
        (["[3/5] train_loss 0.211 test_accuracy 0.93\n"], [(3.0, {"train_loss": 0.211, "test_accuracy": 0.93})]),
        (["fold 2 f1=0.81 roc_auc=0.9\n"], [(2.0, {"f1": 0.81, "roc_auc": 0.9})]),
        (["rows 2000\n", "Train shape (1600, 8)\n", "saved data/features.csv (1980, 14)\n"], []),
    ],
)  # fmt: skip
def test_metric_lines(lines: list[str], expected: list[tuple[float, dict[str, float]]]) -> None:
    parser = MetricParser()
    found = [point for line in lines for point in parser.feed(line)[0]]
    assert [(p.step, p.values) for p in found] == expected


def test_tqdm_progress_and_split_chunks() -> None:
    parser = MetricParser()
    assert parser.feed("\r 40%|████      | 20/50 [00:01<00:02, 15.2it/s]")[1] == 0.4
    assert parser.feed("epoch 3 lo")[0] == []  # a line split across two stream messages
    points, _ = parser.feed("ss=0.25\n")
    assert [(p.step, p.values) for p in points] == [(3.0, {"loss": 0.25})]
    assert parser.feed("\r100%|██████████| 50/50 [00:03<00:00]\n") == ([], 1.0)


def test_value_labels_for_deep_learning_objects() -> None:
    assert short_value({"kind": "tensor", "shape": [64, 8], "dtype": "float32", "device": "cpu"}) == "Tensor 64×8 · float32"
    assert short_value({"kind": "tensor", "shape": [], "dtype": "float32", "device": "cuda:0"}) == "Tensor scalar · float32 · cuda:0"
    assert short_value({"kind": "model", "type": "__main__.ChurnNet", "params_total": 1442}) == "ChurnNet · 1.4k params"
    assert short_value({"kind": "dataloader", "batches": 38, "batch_size": 64}) == "DataLoader · 38 batches × 64"
    assert short_value({"kind": "optimizer", "type": "torch.optim.adamw.AdamW", "lr": 0.003}) == "AdamW · lr 0.003"
    assert short_value({"kind": "dataset", "type": "torch.utils.data.dataset.Subset", "length": 2400}) == "Subset · 2.4k items"


# -------------------------------------------------------------------------- kernels
@pytest.fixture(scope="module")
def project(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("ml-lab")
    for name in ("01_data_processing.py", "02_sklearn_training.py", "03_torch_training.ipynb"):
        shutil.copy(EXAMPLES / name, root / name)
    return root


def run_all(root: Path, file: str) -> tuple[LabSession, list[LabEvent]]:
    events: list[LabEvent] = []
    session = LabSession(LabProject(root), file, on_event=events.append, timeout_s=240)
    session.start()
    records = session.execute(None, mode="all")
    failed = [(r.node_id, r.error.evalue if r.error else "") for r in records if r.status != "success"]
    assert not failed, failed
    return session, events


@pytest.fixture(scope="module")
def processed(project: Path) -> Iterator[LabSession]:
    session, _ = run_all(project, "01_data_processing.py")
    try:
        yield session
    finally:
        session.shutdown()


def test_data_processing_cells_track_rows_and_columns(processed: LabSession, project: Path) -> None:
    records = {r.node_id: r for r in processed.last_run.values()}
    cleaning = next(r for r in records.values() if "clean rows" in r.stdout)
    assert cleaning.rows_in == 2000 and cleaning.rows_out is not None and cleaning.rows_out <= 2000
    features = processed.summarize(["features"])["features"]
    assert features["kind"] == "dataframe" and "plan_basic" in features["columns"]
    assert "calls_per_year" in features["columns"] and features["null_counts"]["age"] == 0
    assert (project / "data" / "features.csv").is_file()
    segments = next(r for r in records.values() if r.rich_outputs)
    assert any(o.kind == "html" for o in segments.rich_outputs)  # the pandas table is shown


def test_sklearn_training_summaries_metrics_and_plots(processed: LabSession, project: Path) -> None:
    session, events = run_all(project, "02_sklearn_training.py")
    try:
        model = session.summarize(["model"])["model"]
        assert model["kind"] == "estimator" and model["fitted"] and model["n_features"] >= 10
        assert model["classes"] == ["0", "1"] and len(model["importances"]) >= 5
        folds = [e.data for e in events if e.type == "metric"]
        assert [f["step"] for f in folds if set(f["values"]) == {"roc_auc"}] == [1.0, 2.0, 3.0, 4.0, 5.0]
        test_line = next(f for f in folds if "accuracy" in f["values"])
        assert set(test_line["values"]) == {"accuracy", "f1", "roc_auc"}
        assert any(o.kind == "image" for r in session.last_run.values() for o in r.rich_outputs)
    finally:
        session.shutdown()


def test_torch_training_streams_metrics_progress_and_deep_learning_summaries(project: Path) -> None:
    (project / "data").mkdir(exist_ok=True)
    session, events = run_all(project, "03_torch_training.ipynb")
    try:
        found = session.summarize(["X", "model", "train_loader", "train_set", "optimizer", "loss"])
        assert found["X"]["kind"] == "tensor" and found["X"]["shape"] == [3000, 8] and found["X"]["dtype"] == "float32"
        assert found["X"]["stats"]["value"]["mean"] is not None and found["X"]["rows"] == 3000
        model = found["model"]
        assert model["kind"] == "model" and model["framework"] == "torch"
        assert model["params_total"] == model["params_trainable"] > 1000
        assert [layer["name"] for layer in model["layers"]] == ["body", "head"]
        loader = found["train_loader"]
        assert loader["kind"] == "dataloader" and loader["batch_size"] == 64 and loader["batches"] == 38
        assert loader["shuffle"] is True and loader["item"] == "(Tensor[8] float32, Tensor[] int64)"
        assert found["train_set"]["kind"] == "dataset" and found["train_set"]["length"] == 2400
        assert found["optimizer"]["kind"] == "optimizer" and found["optimizer"]["lr"] == 0.003
        assert found["loss"]["kind"] == "tensor" and found["loss"]["shape"] == []

        epochs = [e.data for e in events if e.type == "metric" and {"loss", "val_acc"} <= set(e.data["values"])]
        assert [e["step"] for e in epochs] == [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
        assert epochs[-1]["values"]["loss"] < epochs[0]["values"]["loss"]
        training = next(r for r in session.last_run.values() if r.metrics)
        assert len(training.metrics) >= 6 and all("step" in m for m in training.metrics)
        progress = [e.data["fraction"] for e in events if e.type == "progress"]
        assert progress and all(0.0 <= fraction <= 1.0 for fraction in progress)
        assert any("it/s]" in r.stderr or "%|" in r.stderr for r in session.last_run.values())  # a text bar
    finally:
        session.shutdown()


def test_flowlab_log_charts_metrics_without_printing(tmp_path: Path) -> None:
    cells = [
        "for step in range(1, 4):\n    flowlab_log(step=step, loss=1 / step, note='ignored')",
        "names = sorted(k for k in dir() if not k.startswith('_'))",
    ]
    (tmp_path / "log.ipynb").write_text(json.dumps({
        "cells": [{"cell_type": "code", "source": c, "metadata": {}, "outputs": [], "execution_count": None} for c in cells],
        "metadata": {}, "nbformat": 4, "nbformat_minor": 5,
    }))  # fmt: skip
    events: list[LabEvent] = []
    session = LabSession(LabProject(tmp_path), "log.ipynb", on_event=events.append, timeout_s=60)
    session.start()
    try:
        records = session.execute(None, mode="all")
        assert [m["values"] for m in records[0].metrics] == [{"loss": 1.0}, {"loss": 0.5}, {"loss": 1 / 3}]
        assert [m["step"] for m in records[0].metrics] == [1.0, 2.0, 3.0]
        assert records[0].rich_outputs == [] and records[0].stdout == ""
        assert "flowlab_log" not in session.variables()
    finally:
        session.shutdown()
