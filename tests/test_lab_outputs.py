"""Rich block outputs: mimebundle selection, local storage, eviction, kernel capture, API serving."""

from __future__ import annotations

import base64
import json
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from flowlab_api import create_app
from flowlab_lab.kernel import LabEvent, LabSession
from flowlab_lab.outputs import OutputStore
from flowlab_lab.project import LabProject

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
TOKEN = "test-token-123"


def test_richest_representation_wins(tmp_path: Path) -> None:
    store = OutputStore(tmp_path)
    vega = {"$schema": "https://vega.github.io/schema/vega-lite/v5.json", "mark": "bar"}
    chart = store.capture(
        "ex_000000000001", 0,
        {"application/vnd.vegalite.v5+json": vega, "image/png": base64.b64encode(PNG).decode(), "text/plain": "<Chart>"},
    )  # fmt: skip
    assert (chart.kind, chart.stored, chart.plain) == ("vega", True, "<Chart>")
    found = store.read("ex_000000000001", 0)
    assert found is not None and found[0] == "application/json" and json.loads(found[1]) == vega

    table = store.capture("ex_000000000001", 1, {"text/html": ["<table>", "</table>"], "text/plain": "df"})
    assert table.kind == "html" and store.read("ex_000000000001", 1) == ("text/html", b"<table></table>")

    image = store.capture(
        "ex_000000000001", 2, {"image/png": base64.b64encode(PNG).decode()}, {"image/png": {"width": 640}}
    )
    assert image.kind == "image" and image.width == 640 and image.size_bytes == len(PNG)
    assert store.read("ex_000000000001", 2) == ("image/png", PNG)


def test_plain_text_is_not_stored_and_bad_ids_are_rejected(tmp_path: Path) -> None:
    store = OutputStore(tmp_path)
    text = store.capture("ex_000000000002", 0, {"text/plain": "42"})
    assert (text.kind, text.stored, text.plain) == ("text", False, "42")
    assert store.read("ex_000000000002", 0) is None
    assert store.read("../../etc/passwd", 0) is None
    assert store.read("ex_000000000002", -1) is None


def test_oversized_outputs_are_flagged_and_old_ones_evicted(tmp_path: Path) -> None:
    store = OutputStore(tmp_path, max_bytes=2500, max_item_bytes=1000)
    huge = store.capture("ex_000000000003", 0, {"text/html": "x" * 5000, "text/plain": "big"})
    assert huge.truncated and not huge.stored and store.read("ex_000000000003", 0) is None
    for i in range(4):
        assert store.capture(f"ex_00000000001{i}", 0, {"text/html": "y" * 900}).stored
        time.sleep(0.01)
    assert store.read("ex_000000000010", 0) is None  # oldest evicted
    assert store.read("ex_000000000013", 0) is not None


@pytest.fixture
def notebook(tmp_path: Path) -> Path:
    cells = [
        "from IPython.display import HTML, display\ndisplay(HTML('<b>hello</b>'))",
        "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])\nplt.show()",
        "1 + 1",
    ]
    (tmp_path / "plots.ipynb").write_text(json.dumps({
        "cells": [{"cell_type": "code", "source": c, "metadata": {}, "outputs": [], "execution_count": None} for c in cells],
        "metadata": {}, "nbformat": 4, "nbformat_minor": 5,
    }))  # fmt: skip
    return tmp_path


def test_kernel_records_html_images_and_results(notebook: Path) -> None:
    events: list[LabEvent] = []
    with LabSession(LabProject(notebook), "plots.ipynb", on_event=events.append, timeout_s=120) as session:
        html, plot, result = session.execute(None, mode="all")
        assert [o.kind for o in html.rich_outputs] == ["html"]
        assert session.output_store.read(html.execution_id, 0) == ("text/html", b"<b>hello</b>")
        assert [o.kind for o in plot.rich_outputs] == ["image"]
        payload = session.output_store.read(plot.execution_id, 0)
        assert payload is not None and payload[0] == "image/png" and payload[1].startswith(b"\x89PNG")
        assert [(o.kind, o.plain) for o in result.rich_outputs] == [("text", "2")]
    display = [e for e in events if e.type == "display"]
    assert (
        display[0].data["output"]["kind"] == "html" and display[0].data["execution_id"] == html.execution_id
    )


@pytest.fixture
def client(notebook: Path) -> Iterator[TestClient]:
    app = create_app(notebook, TOKEN, watch=False, static_dir=None)
    with TestClient(app, base_url="http://127.0.0.1:8765", headers={"X-FlowLab-Token": TOKEN}) as test_client:
        yield test_client


def test_api_serves_outputs_sandboxed(client: TestClient, notebook: Path) -> None:
    (notebook / "other.py").write_text("x = 1\n")
    client.post("/api/kernel/start", json={"file": "plots.ipynb"})
    try:
        client.post("/api/execute", json={"file": "plots.ipynb", "mode": "all"})
        deadline = time.monotonic() + 120
        state: dict[str, Any] = {}
        while time.monotonic() < deadline:
            state = client.get("/api/state", params={"file": "plots.ipynb"}).json()
            if state["kernel"]["status"] == "idle" and state["nodes"]["b3"]["last_run"]:
                break
            time.sleep(0.2)
        record = state["nodes"]["b2"]["last_run"]
        assert record["rich_outputs"][0]["kind"] == "image"
        params = {"file": "plots.ipynb", "execution_id": record["execution_id"], "index": 0}
        response = client.get("/api/output", params=params)
        assert response.status_code == 200 and response.headers["content-type"] == "image/png"
        assert response.headers["content-security-policy"] == "sandbox"
        assert response.content.startswith(b"\x89PNG")

        assert client.get("/api/output", params={**params, "index": 5}).status_code == 404
        assert client.get("/api/output", params={**params, "file": "other.py"}).status_code == 404
        assert client.get("/api/output", params={**params, "execution_id": "../x"}).status_code == 400
        anonymous = client.get("/api/output", params=params, headers={"X-FlowLab-Token": "nope"})
        assert anonymous.status_code == 401
    finally:
        client.post("/api/kernel/stop", json={"file": "plots.ipynb"})
