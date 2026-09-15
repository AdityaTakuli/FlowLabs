"""Kernel mode integration tests (PRD II 8, 14): real Jupyter kernels, no network."""

from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from flowlab_lab.kernel import KernelDied, LabEvent, LabSession
from flowlab_lab.project import LabProject

PIPELINE = [
    "import pandas as pd\nimport numpy as np",
    "raw = pd.DataFrame({'id': range(10), 'value': [1.0, None, 3.0, 4.0, None, 6.0, 7.0, 8.0, 9.0, 10.0], "
    "'group': list('aabbccddee')})",
    "clean = raw.dropna()",
    "features = clean.assign(double=clean['value'] * 2)",
    "print('rows', len(features))\nsummary = features.groupby('group')['double'].mean()",
    "other = 42",
]


def write_notebook(path: Path, cells: list[str]) -> None:
    path.write_text(json.dumps({
        "cells": [{"cell_type": "code", "source": c, "metadata": {}, "outputs": [], "execution_count": None} for c in cells],
        "metadata": {}, "nbformat": 4, "nbformat_minor": 5,
    }))  # fmt: skip


@pytest.fixture
def lab(tmp_path: Path) -> Iterator[tuple[LabSession, list[LabEvent]]]:
    write_notebook(tmp_path / "pipeline.ipynb", PIPELINE)
    events: list[LabEvent] = []
    session = LabSession(LabProject(tmp_path), "pipeline.ipynb", on_event=events.append, timeout_s=60)
    session.start()
    try:
        yield session, events
    finally:
        session.shutdown()


def ids(records: list) -> list[str]:  # type: ignore[type-arg]
    return [r.node_id for r in records]


def test_environment_resources_and_run_to_here(lab: tuple[LabSession, list[LabEvent]]) -> None:
    session, events = lab
    assert session.environment["python"] and "pandas" in session.environment["packages"]
    assert session.environment["cwd"] == str(session.project.root)
    assert session.resources()["kernel_memory_mb"] > 0

    records = session.execute("b4", mode="to")
    assert ids(records) == ["b1", "b2", "b3", "b4"]  # only ancestors, never b5/b6
    assert all(r.status == "success" for r in records)
    assert records[2].rows_in == 10 and records[2].rows_out == 8
    assert records[2].duration_ms >= 0 and records[2].peak_memory_mb
    assert [e.type for e in events].count("node_completed") == 4

    streamed = session.execute("b5")
    assert streamed[0].stdout == "rows 8\n"
    assert any(e.type == "stream" and e.data["text"] == "rows 8\n" for e in events)


def test_diff_finds_the_step_that_silently_dropped_rows(lab: tuple[LabSession, list[LabEvent]]) -> None:
    session, _ = lab
    session.execute(None, mode="all")
    steps = ["b2", "b3", "b4"]
    diffs = {(a, b): session.diff(a, b) for a, b in zip(steps, steps[1:], strict=False)}
    dropped = [pair for pair, d in diffs.items() if d is not None and (d.row_delta or 0) < 0]
    assert dropped == [("b2", "b3")]
    text = diffs[("b2", "b3")].format()  # type: ignore[union-attr]
    assert "Rows:     10 → 8   (-2, -20.0%)" in text and "Nulls:    2 → 0" in text

    edge = session.inspect("b3", "clean")
    assert edge is not None and edge["rows"] == 8 and edge["dtypes"]["value"] == "float64"
    assert len(edge["sample"]["data"]) == 8


def test_staleness_propagates_and_run_stale_only(
    lab: tuple[LabSession, list[LabEvent]], tmp_path: Path
) -> None:
    session, _ = lab
    session.execute(None, mode="all")
    assert session.stale_nodes() == []
    edited = list(PIPELINE)
    edited[1] = edited[1].replace("1.0, None, 3.0", "1.0, 2.0, 3.0")
    write_notebook(tmp_path / "pipeline.ipynb", edited)
    session.refresh()
    assert session.stale_nodes() == ["b2", "b3", "b4", "b5"]
    assert session.node_state("b6") == "success" and session.node_state("b4") == "stale"

    rerun = session.execute(None, mode="stale")
    assert ids(rerun) == ["b2", "b3", "b4", "b5"]
    assert session.stale_nodes() == []
    assert session.inspect("b3", "clean")["rows"] == 9  # type: ignore[index]


def test_errors_keep_state_and_map_frames(tmp_path: Path) -> None:
    write_notebook(tmp_path / "pipeline.ipynb", [*PIPELINE[:3], "value = clean['missing']"])
    with LabSession(LabProject(tmp_path), "pipeline.ipynb", timeout_s=60) as session:
        records = session.execute("b4", mode="to")
        failed = records[-1]
        assert failed.status == "error" and failed.error is not None
        assert failed.error.ename == "KeyError"
        assert any(frame.node_id == "b4" for frame in failed.error.frames)
        assert session.is_alive() and session.evaluate("len(clean)") == "8"
        assert session.node_state("b4") == "error"


def test_hidden_state_detection(tmp_path: Path) -> None:
    (tmp_path / "helper_mod.py").write_text("def factor():\n    return 3\n")
    cells = [
        *PIPELINE[:3],
        "import helper_mod\nscaled = clean['value'] * helper_mod.factor()",
        "def sneaky(frame):\n    frame['value'] = 0",
        "sneaky(clean)\ndone = True",
        "features = clean.assign(double=clean['value'] * 2)",
    ]
    write_notebook(tmp_path / "pipeline.ipynb", cells)
    with LabSession(LabProject(tmp_path), "pipeline.ipynb", timeout_s=60) as session:
        early = session.run_node("b7")
        assert early.status == "error"
        assert any(w.code == "EXECUTED_BEFORE_ANCESTOR" for w in early.warnings)

        session.execute("b4", mode="to")  # imports helper_mod
        session.execute("b6", mode="to")
        mutation = session.last_run["b6"]
        assert any(w.code == "RUNTIME_MUTATION" and "clean" in w.message for w in mutation.warnings)

        session.kc.execute_interactive("leftover = 1", store_history=False, timeout=30)
        assert "leftover" in session.orphan_variables()
        assert session.clean_kernel() == ["leftover"]
        assert "leftover" not in session.variables()

        future = time.time() + 5
        os.utime(tmp_path / "helper_mod.py", (future, future))
        codes = {w.code for w in session.hidden_state()}
        assert {"STALE_IMPORT", "RUNTIME_MUTATION", "EXECUTED_BEFORE_ANCESTOR"} <= codes

        session.peak_history["b1"] = 10**9
        assert any(w.code == "LOW_MEMORY" for w in session.run_node("b1").warnings)


def test_interrupt_restart_and_kernel_death(tmp_path: Path) -> None:
    write_notebook(
        tmp_path / "pipeline.ipynb", ["import time\nx = 1", "time.sleep(60)", "import os\nos._exit(1)"]
    )
    with LabSession(LabProject(tmp_path), "pipeline.ipynb", timeout_s=120) as session:
        session.run_node("b1")
        timer = threading.Timer(1.5, session.interrupt)
        timer.start()
        started = time.perf_counter()
        interrupted = session.run_node("b2")
        assert interrupted.status == "interrupted" and time.perf_counter() - started < 30
        assert session.is_alive() and session.evaluate("x") == "1"

        session.restart()
        assert session.last_run == {} and "x" not in session.variables()

        with pytest.raises(KernelDied, match="kernel died while running b3"):
            session.run_node("b3")
        session.restart()
        assert session.run_node("b1").status == "success"
