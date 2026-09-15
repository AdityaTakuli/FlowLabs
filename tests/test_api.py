"""Local API behind the web canvas: security guard, graph, edits, transforms, kernel, events."""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from flowlab_api import create_app

TOKEN = "test-token-123"
WS = "ws://127.0.0.1:8765/api/ws"  # absolute: TestClient otherwise sends Host: testserver
SCRIPT = (
    "# %% Load\nimport pandas as pd\nraw = pd.DataFrame({'a': [1, None, 3, 4], 'b': list('wxyz')})\n\n"
    "# %% Clean\nclean = raw.dropna()\n\n"
    "# %% Report\ntotal = clean['a'].sum()\nprint('total', total)\n"
)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "pipeline.py").write_text(SCRIPT)
    (tmp_path / "notes.txt").write_text("not code")
    return tmp_path


@pytest.fixture
def client(project: Path) -> Iterator[TestClient]:
    app = create_app(project, TOKEN, watch=False, static_dir=None)
    with TestClient(app, base_url="http://127.0.0.1:8765", headers={"X-FlowLab-Token": TOKEN}) as test_client:
        yield test_client


def wait_for(client: TestClient, predicate: Any, timeout: float = 60.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state: dict[str, Any] = client.get("/api/state", params={"file": "pipeline.py"}).json()
        if predicate(state):
            return state
        time.sleep(0.1)
    raise AssertionError(f"timed out; last state: {json.dumps(state)[:2000]}")


# ------------------------------------------------------------------------------- security


def test_token_and_host_are_required(project: Path) -> None:
    app = create_app(project, TOKEN, watch=False, static_dir=None)
    with TestClient(app, base_url="http://127.0.0.1:8765") as anonymous:
        assert anonymous.get("/api/health").status_code == 200
        assert anonymous.get("/api/project").status_code == 401
        assert anonymous.get("/api/project", headers={"X-FlowLab-Token": "wrong"}).status_code == 401
        assert anonymous.get("/api/project", headers={"X-FlowLab-Token": TOKEN}).status_code == 200
    with TestClient(
        app, base_url="http://evil.example:8765", headers={"X-FlowLab-Token": TOKEN}
    ) as rebinding:
        response = rebinding.get("/api/project")
        assert response.status_code == 403 and response.json()["code"] == "FORBIDDEN_HOST"


def test_websocket_requires_token_and_loopback_origin(client: TestClient) -> None:
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect), client.websocket_connect(f"{WS}?token=wrong") as ws:
        ws.receive_json()
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect(f"{WS}?token={TOKEN}", headers={"origin": "https://evil.example"}) as ws,
    ):
        ws.receive_json()
    with client.websocket_connect(f"{WS}?token={TOKEN}", headers={"origin": "http://localhost:5173"}) as ws:
        assert ws.receive_json()["type"] == "hello"


def test_paths_are_confined(client: TestClient, project: Path) -> None:
    (project.parent / "outside.py").write_text("x = 1\n")
    assert client.get("/api/graph", params={"file": "../outside.py"}).json()["code"] == "PATH_OUTSIDE_ROOT"
    assert client.get("/api/graph", params={"file": "notes.txt"}).json()["code"] == "UNSUPPORTED_FILE"
    assert client.get("/api/graph", params={"file": "missing.py"}).status_code == 404


# ---------------------------------------------------------------------------- graph & edits


def test_project_and_graph(client: TestClient) -> None:
    info = client.get("/api/project").json()
    assert info["files"] == ["pipeline.py"] and "never data rows" in info["badge"]
    payload = client.get("/api/graph", params={"file": "pipeline.py"}).json()
    graph = payload["graph"]
    assert [n["id"] for n in graph["nodes"]] == ["b1", "b2", "b3"]
    assert {(e["from"], e["to"], e["variable"]) for e in graph["edges"]} == {
        ("b1", "b2", "raw"),
        ("b2", "b3", "clean"),
    }
    assert payload["hash"].startswith("sha256:") and payload["secrets_warning"] is None


def test_preview_does_not_write_and_edit_saves(client: TestClient, project: Path) -> None:
    preview = client.post(
        "/api/graph/preview",
        json={"file": "pipeline.py", "node_id": "b3", "source": "# %% Report\nsummary = raw.describe()\n"},
    ).json()
    edges = {(e["from"], e["to"], e["variable"]) for e in preview["graph"]["edges"]}
    assert ("b1", "b3", "raw") in edges and ("b2", "b3", "clean") not in edges
    assert (project / "pipeline.py").read_text() == SCRIPT

    broken = client.post(
        "/api/graph/preview", json={"file": "pipeline.py", "node_id": "b3", "source": "x = (\n"}
    ).json()
    assert broken["parse_error"] and broken["parse_error_line"] == 1

    current = client.get("/api/graph", params={"file": "pipeline.py"}).json()["hash"]
    saved = client.post(
        "/api/transform",
        json={"file": "pipeline.py", "op": "edit", "node_ids": ["b2"], "params": {"source": "clean = raw.fillna(0)\n"},
              "expected_hash": current},
    ).json()  # fmt: skip
    assert saved["message"] == "edited b2"
    assert "# %% Clean\nclean = raw.fillna(0)\n\n# %% Report" in (project / "pipeline.py").read_text()

    stale = client.post(
        "/api/transform",
        json={"file": "pipeline.py", "op": "edit", "node_ids": ["b2"], "params": {"source": "clean = raw\n"},
              "expected_hash": current},
    )  # fmt: skip
    assert stale.status_code == 409 and stale.json()["code"] == "FILE_CHANGED"


def test_transform_refusal_and_revert(client: TestClient, project: Path) -> None:
    refused = client.post(
        "/api/transform",
        json={"file": "pipeline.py", "op": "reorder", "node_ids": ["b2"], "params": {"after": "b3"}},
    )
    assert refused.status_code == 422
    body = refused.json()
    assert body["code"] == "DEPENDENCY_VIOLATION"
    assert body["details"]["blocking_edge"] == {"from": "b2", "to": "b3", "variable": "clean"}

    needs_confirm = client.post(
        "/api/transform", json={"file": "pipeline.py", "op": "delete", "node_ids": ["b2"]}
    )
    assert needs_confirm.json()["details"]["downstream"] == ["b3"]

    done = client.post(
        "/api/transform", json={"file": "pipeline.py", "op": "duplicate", "node_ids": ["b3"]}
    ).json()
    assert "total_copy" in (project / "pipeline.py").read_text() and done["backup"].endswith(".bak")
    reverted = client.post("/api/revert", json={"file": "pipeline.py"}).json()
    assert reverted["restored_from"] and (project / "pipeline.py").read_text() == SCRIPT


# ----------------------------------------------------------------------- kernel & execution


def test_kernel_run_state_inspect_diff_and_events(client: TestClient, project: Path) -> None:
    assert (
        client.post("/api/execute", json={"file": "pipeline.py", "mode": "all"}).json()["code"] == "NO_KERNEL"
    )
    kernel = client.post("/api/kernel/start", json={"file": "pipeline.py"}).json()
    try:
        assert kernel["status"] == "idle" and kernel["pid"] and kernel["python"]
        with client.websocket_connect(f"{WS}?token={TOKEN}") as ws:
            assert ws.receive_json()["type"] == "hello"
            plan = client.post(
                "/api/execute", json={"file": "pipeline.py", "node_id": "b3", "mode": "to"}
            ).json()
            assert plan["plan"] == ["b1", "b2", "b3"]
            seen: list[dict[str, Any]] = []
            while not seen or seen[-1]["type"] != "run_finished":
                seen.append(ws.receive_json())
        types = [e["type"] for e in seen]
        assert types[0] == "run_started" and types.count("node_completed") == 3
        assert any(e["type"] == "stream" and e["data"]["text"] == "total 8.0\n" for e in seen)
        assert seen[-1]["data"]["error"] is None

        state = wait_for(client, lambda s: s["kernel"]["status"] == "idle")
        assert {k: v["state"] for k, v in state["nodes"].items()} == {
            "b1": "success",
            "b2": "success",
            "b3": "success",
        }
        assert (
            state["nodes"]["b2"]["last_run"]["rows_in"] == 4
            and state["nodes"]["b2"]["last_run"]["rows_out"] == 3
        )
        assert state["resources"]["ram_total_mb"] > 0

        inspected = client.get("/api/inspect", params={"file": "pipeline.py", "node_id": "b2"}).json()
        assert (
            inspected["after"]["clean"]["rows"] == 3
            and len(inspected["after"]["clean"]["sample"]["data"]) == 3
        )
        diff = client.get("/api/diff", params={"file": "pipeline.py", "node_a": "b1", "node_b": "b2"}).json()
        assert diff["row_delta"] == -1 and "Rows:     4 → 3" in diff["text"]
        assert len(client.get("/api/history", params={"file": "pipeline.py", "node_id": "b2"}).json()) == 1

        # editing an upstream block marks descendants stale; "stale" re-runs exactly those
        client.post(
            "/api/transform",
            json={"file": "pipeline.py", "op": "edit", "node_ids": ["b1"],
                  "params": {"source": "# %% Load\nimport pandas as pd\nraw = pd.DataFrame({'a': [1, 2, 3, 4]})\n"}},
        )  # fmt: skip
        state = client.get("/api/state", params={"file": "pipeline.py"}).json()
        assert {k: v["state"] for k, v in state["nodes"].items()} == {
            "b1": "stale",
            "b2": "stale",
            "b3": "stale",
        }
        assert client.post("/api/execute", json={"file": "pipeline.py", "mode": "stale"}).json()["plan"] == [
            "b1",
            "b2",
            "b3",
        ]
        wait_for(client, lambda s: s["kernel"]["status"] == "idle" and s["nodes"]["b3"]["state"] == "success")
        diff = client.get("/api/diff", params={"file": "pipeline.py", "node_a": "b1", "node_b": "b2"}).json()
        assert diff["row_delta"] == 0
        runs = client.get("/api/history", params={"file": "pipeline.py", "node_id": "b2"}).json()
        across = client.get(
            "/api/diff",
            params={
                "file": "pipeline.py",
                "execution_a": runs[1]["execution_id"],
                "execution_b": runs[0]["execution_id"],
            },
        ).json()
        assert across["rows_a"] == 3 and across["rows_b"] == 4

        # a long block can be interrupted while the server stays responsive
        client.post(
            "/api/transform",
            json={"file": "pipeline.py", "op": "insert", "node_ids": ["b3"], "params": {"source": "import time\ntime.sleep(60)"}},
        )  # fmt: skip
        client.post("/api/execute", json={"file": "pipeline.py", "node_id": "b4", "mode": "node"})
        wait_for(client, lambda s: s["kernel"]["status"] == "busy" and s["kernel"]["running"] == "b4")
        busy = client.post("/api/execute", json={"file": "pipeline.py", "mode": "all"})
        assert busy.status_code == 409 and busy.json()["code"] == "KERNEL_BUSY"
        client.post("/api/kernel/interrupt", json={"file": "pipeline.py"})
        state = wait_for(client, lambda s: s["kernel"]["status"] == "idle", timeout=30)
        assert state["nodes"]["b4"]["state"] == "interrupted"
    finally:
        client.post("/api/kernel/stop", json={"file": "pipeline.py"})
    assert client.get("/api/state", params={"file": "pipeline.py"}).json()["kernel"]["status"] == "none"
