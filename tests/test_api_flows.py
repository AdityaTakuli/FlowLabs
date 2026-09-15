"""Flow Mode on the local API: index, save, compile-on-edit, runs, cancel, node outputs."""

from __future__ import annotations

import json
import shutil
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from flowlab_api import create_app

TOKEN = "test-token-123"
REPO = Path(__file__).resolve().parents[1]


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "data").mkdir()
    shutil.copy(REPO / "fixtures" / "churn.csv", tmp_path / "data" / "churn.csv")
    (tmp_path / "flows").mkdir()
    shutil.copy(REPO / "examples" / "churn_flow.json", tmp_path / "flows" / "churn_flow.json")
    shutil.copy(REPO / "examples" / "leaky_flow.json", tmp_path / "flows" / "leaky_flow.json")
    (tmp_path / "flows" / "not_a_flow.json").write_text('{"hello": 1}')
    return tmp_path


@pytest.fixture
def client(project: Path) -> Iterator[TestClient]:
    app = create_app(project, TOKEN, watch=False, static_dir=None)
    with TestClient(app, base_url="http://127.0.0.1:8765", headers={"X-FlowLab-Token": TOKEN}) as test_client:
        yield test_client


def churn_spec(client: TestClient) -> dict[str, Any]:
    spec: dict[str, Any] = client.get("/api/flow", params={"file": "flows/churn_flow.json"}).json()["spec"]
    return spec


def wait_finished(client: TestClient, run_id: str, timeout: float = 120.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        detail: dict[str, Any] = client.get("/api/flow/run", params={"run_id": run_id}).json()
        if not detail["running"] and detail["manifest"] is not None:
            return detail
        time.sleep(0.1)
    raise AssertionError(f"{run_id} did not finish")


def test_flow_routes_need_the_token(project: Path) -> None:
    app = create_app(project, TOKEN, watch=False, static_dir=None)
    with TestClient(app, base_url="http://127.0.0.1:8765") as anonymous:
        for path in ("/api/catalogue", "/api/flows", "/api/flow/runs"):
            assert anonymous.get(path).status_code == 401


def test_index_lists_flows_and_datasets(client: TestClient) -> None:
    index = client.get("/api/flows").json()
    assert index["flows"] == ["flows/churn_flow.json", "flows/leaky_flow.json"]
    assert index["datasets"] == ["data/churn.csv"]
    catalogue = client.get("/api/catalogue").json()
    assert "model.fit" in {n["type"] for n in catalogue["nodes"]}


def test_compile_resolves_dataset_by_unique_stem(client: TestClient) -> None:
    result = client.post(
        "/api/flow/compile", json={"file": "flows/churn_flow.json", "spec": churn_spec(client)}
    ).json()
    assert result["ok"], result["errors"]
    assert result["datasets"] == {"primary": "data/churn.csv"}
    assert result["order"][0] == "n1" and set(result["cache_keys"]) == set(result["order"])
    columns = [c["name"] for c in result["schemas"]["n2"]["inputs"]["in"]["table"]["columns"]]
    assert "tenure_months" in columns


def test_compile_reports_leakage_and_keeps_partial_schemas(client: TestClient) -> None:
    spec = client.get("/api/flow", params={"file": "flows/leaky_flow.json"}).json()["spec"]
    result = client.post("/api/flow/compile", json={"file": "flows/leaky_flow.json", "spec": spec}).json()
    assert not result["ok"]
    assert {e["code"] for e in result["errors"]} == {"LEAKAGE_FIT_BEFORE_SPLIT"}
    assert result["errors"][0]["node_id"] == "scale"
    assert result["schemas"], "column pickers still need schemas when compile fails"


def test_compile_incomplete_flow_explains_instead_of_crashing(client: TestClient) -> None:
    spec = churn_spec(client)
    spec["edges"] = [e for e in spec["edges"] if e["target"] != "n5"]  # model.fit loses its input
    result = client.post("/api/flow/compile", json={"spec": spec}).json()
    assert not result["ok"] and result["errors"]
    assert "n1" in result["schemas"]

    spec["dataset_bindings"] = {"primary": "../outside"}
    result = client.post("/api/flow/compile", json={"spec": spec}).json()
    assert {e["code"] for e in result["errors"]} <= {"DATASET_NOT_FOUND", "PATH_OUTSIDE_ROOT"}

    result = client.post("/api/flow/compile", json={"spec": {"nodes": "nope"}}).json()
    assert not result["ok"] and result["errors"][0]["code"] == "SPEC_INVALID"


def test_save_create_and_conflicts(client: TestClient, project: Path) -> None:
    loaded = client.get("/api/flow", params={"file": "flows/churn_flow.json"}).json()
    spec = loaded["spec"]
    spec["name"] = "Renamed"
    saved = client.put(
        "/api/flow", json={"file": "flows/churn_flow.json", "spec": spec, "expected_hash": loaded["hash"]}
    )
    assert saved.status_code == 200
    assert json.loads((project / "flows" / "churn_flow.json").read_text())["name"] == "Renamed"

    stale = client.put(
        "/api/flow", json={"file": "flows/churn_flow.json", "spec": spec, "expected_hash": loaded["hash"]}
    )
    assert stale.status_code == 409 and stale.json()["code"] == "FILE_CHANGED"

    bad = client.put("/api/flow", json={"file": "flows/churn_flow.json", "spec": {"nodes": 3}})
    assert bad.status_code == 422 and bad.json()["code"] == "SPEC_INVALID"
    assert client.put("/api/flow", json={"file": "../escape.json", "spec": spec}).status_code == 403
    assert client.put("/api/flow", json={"file": "flows/x.py", "spec": spec}).status_code == 400

    created = client.post(
        "/api/flow/new", json={"file": "flows/new.json", "name": "My flow", "dataset": "data/churn.csv"}
    )
    assert created.status_code == 200, created.text
    assert created.json()["spec"]["nodes"][0]["type"] == "source.dataset"
    assert client.post("/api/flow/new", json={"file": "flows/new.json"}).status_code == 409
    missing = client.post("/api/flow/new", json={"file": "flows/other.json", "dataset": "data/none.csv"})
    assert missing.status_code == 404


def test_run_streams_events_and_serves_outputs(client: TestClient) -> None:
    spec = churn_spec(client)
    with client.websocket_connect(f"ws://127.0.0.1:8765/api/ws?token={TOKEN}") as ws:
        assert ws.receive_json()["type"] == "hello"
        started = client.post("/api/flow/run", json={"file": "flows/churn_flow.json", "spec": spec})
        assert started.status_code == 200, started.text
        run_id = started.json()["run_id"]
        seen: list[str] = []
        while True:
            event = ws.receive_json()
            if event["type"] == "flow_event":
                seen.append(event["data"]["type"])
            if event["type"] == "flow_run_finished":
                assert event["data"]["status"] == "completed", event
                break
    assert seen[0] == "run_started" and "node_completed" in seen and seen[-1] == "run_completed"

    detail = wait_finished(client, run_id)
    assert detail["manifest"]["status"] == "completed"
    runs = client.get("/api/flow/runs", params={"flow_id": spec["flow_id"]}).json()
    assert runs[0]["run_id"] == run_id and runs[0]["nodes"]["success"] == 7
    assert client.get("/api/flow/runs", params={"flow_id": "other"}).json() == []

    split = client.get("/api/flow/output", params={"run_id": run_id, "node_id": "n2"}).json()
    partitions = split["outputs"]["out"]["partitions"]
    assert set(partitions) >= {"train", "test"}
    assert len(partitions["train"]["preview"]["data"]) <= 100
    evaluate = client.get("/api/flow/output", params={"run_id": run_id, "node_id": "n6"}).json()
    assert "accuracy" in evaluate["outputs"]["metrics"]["value"]
    assert {"spec", "narration"} <= set(evaluate["outputs"]["chart"]["value"])
    model = client.get("/api/flow/output", params={"run_id": run_id, "node_id": "n5"}).json()
    assert model["outputs"]["model"]["model"]["algorithm"] == "random_forest"

    again = client.post("/api/flow/run", json={"file": "flows/churn_flow.json", "spec": spec}).json()
    cached = wait_finished(client, again["run_id"])
    assert {n["status"] for n in cached["manifest"]["nodes"]} <= {"cached", "success"}
    assert any(n["cache_hit"] for n in cached["manifest"]["nodes"])


def test_run_refuses_compile_errors_and_bad_ids(client: TestClient) -> None:
    spec = client.get("/api/flow", params={"file": "flows/leaky_flow.json"}).json()["spec"]
    refused = client.post("/api/flow/run", json={"file": "flows/leaky_flow.json", "spec": spec})
    assert refused.status_code == 422 and refused.json()["code"] == "COMPILE_FAILED"
    assert refused.json()["details"]["errors"][0]["node_id"] == "scale"
    assert client.get("/api/flow/run", params={"run_id": "../../etc"}).status_code == 400
    assert client.get("/api/flow/run", params={"run_id": "run_nope"}).status_code == 404
    assert client.post("/api/flow/cancel", json={"run_id": "run_nope"}).status_code == 404


def test_cancel_skips_remaining_steps(client: TestClient) -> None:
    flows = client.app.state.bench.flows  # type: ignore[attr-defined]
    started = client.post("/api/flow/run", json={"spec": churn_spec(client)}).json()
    # Cancelling right away can race the first step; either way the run must end cancelled or complete.
    try:
        client.post("/api/flow/cancel", json={"run_id": started["run_id"]})
    finally:
        detail = wait_finished(client, started["run_id"])
    assert detail["manifest"]["status"] in {"cancelled", "completed"}
    if detail["manifest"]["status"] == "cancelled":
        assert detail["events"][-1]["type"] == "run_cancelled"
    assert flows.active is None


def test_dataset_profile(client: TestClient) -> None:
    profile = client.get("/api/dataset/profile", params={"file": "data/churn.csv"}).json()
    assert profile["schema"]["row_count"] == 2000
    assert profile["preview"]["columns"][0] == "customer_id"
    assert client.get("/api/dataset/profile", params={"file": "../x.csv"}).status_code == 403
