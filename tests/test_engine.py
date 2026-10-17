from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from flowlabs.core.rpc import Engine
from flowlabs.server.app import create_app

TOKEN = "test-token"


def test_rpc_engine_inline(tmp_path):
    events: list[dict] = []
    engine = Engine(tmp_path, emit=events.append)
    catalogue = engine.call("catalogue.get")
    assert {"clean", "rows", "transform", "models", "samples", "image_models"} <= set(catalogue)
    assert any(m["id"] == "neural_network" and m["available"] for m in catalogue["models"])
    meta = engine.call("datasets.import_sample", {"sample_id": "iris"})
    project = engine.call("projects.create", {"dataset_id": meta["id"]})
    project["models"] = [engine.call("projects.new_model", {"algo": "knn"})]
    step = engine.call("projects.new_step", {"op": "scale"})
    assert step["params"]["method"] == "standard"
    project["transform"].append(step)
    assert engine.call("projects.check", {"project": project}) == []
    assert engine.call("train.start", {"project": project, "job_id": "j1"}) == {"job_id": "j1"}
    done = [e for e in events if e.get("kind") == "done"]
    assert done and done[0]["job_id"] == "j1"
    run = engine.call("runs.get", {"project_id": project["id"], "run_id": done[0]["run_id"]})
    assert run["models"][0]["metrics"]["accuracy"] > 0.85
    assert engine.safe_call("nope")["error"]["user"] is True
    assert engine.safe_call("projects.get", {"project_id": "missing"})["error"]["message"].startswith(
        "project not found"
    )


@pytest.fixture
def client(tmp_path: Path):
    app = create_app(tmp_path / "ws", TOKEN, allowed_origins=["https://app.example"])
    with TestClient(app, base_url="http://127.0.0.1:8899") as test_client:
        app.state.kernel.wait_ready()
        yield test_client


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


def test_server_security(client):
    assert client.get("/api/health").json()["app"] == "flowlabs"
    assert client.post("/api/rpc", json={"method": "engine.ping"}).status_code == 401
    assert (
        client.post("/api/rpc", json={"method": "engine.ping"}, headers={"Authorization": "Bearer nope"}).status_code
        == 401
    )
    rebinding = client.get("/api/health", headers={"Host": "evil.example:8899"})
    assert rebinding.status_code == 403
    preflight = client.options("/api/rpc", headers={"Origin": "https://app.example", "Access-Control-Request-Method": "POST",
                                                    "Access-Control-Request-Private-Network": "true"})  # fmt: skip
    assert preflight.status_code == 204
    assert preflight.headers["access-control-allow-private-network"] == "true"
    assert client.options("/api/rpc", headers={"Origin": "https://evil.example"}).status_code == 403
    cross = client.post(
        "/api/rpc", json={"method": "engine.ping"}, headers={**_auth(), "Origin": "https://evil.example"}
    )
    assert cross.status_code == 403
    allowed = client.post(
        "/api/rpc", json={"method": "engine.ping"}, headers={**_auth(), "Origin": "https://app.example"}
    )
    assert allowed.json() == {"result": {"pong": True}}
    assert allowed.headers["access-control-allow-origin"] == "https://app.example"
    for path in ("/api/files/../../etc/passwd", "/api/files/%2e%2e/%2e%2e/etc/passwd", "/api/files/exports/../../x"):
        response = client.get(path, headers=_auth())
        assert "root:" not in response.text and response.status_code in (200, 403, 404)
    assert client.get("/").status_code == 200


def test_server_upload_train_poll_download(client, tmp_path):
    csv = tmp_path / "toy.csv"
    rows = ["x,y,label"] + [f"{i % 7},{(i * 3) % 11},{'a' if i % 7 > 3 else 'b'}" for i in range(120)]
    csv.write_text("\n".join(rows))
    meta = client.post("/api/upload?filename=toy.csv", content=csv.read_bytes(), headers=_auth()).json()["result"]
    assert meta["rows"] == 120
    call = lambda method, **params: client.post(
        "/api/rpc", json={"method": method, "params": params}, headers=_auth()
    ).json()  # noqa: E731
    project = call("projects.create", dataset_id=meta["id"])["result"]
    assert project["target"] == "label"
    project["models"] = [call("projects.new_model", algo="logistic_regression")["result"]]
    assert call("train.start", project=project, job_id="job-1") == {"result": {"job_id": "job-1"}}
    seq, done = 0, None
    deadline = time.monotonic() + 120
    while done is None and time.monotonic() < deadline:
        batch = client.get(f"/api/events?since={seq}&timeout=5", headers=_auth()).json()
        seq = batch["seq"]
        done = next((e for e in batch["events"] if e.get("job_id") == "job-1" and e["kind"] in ("done", "error")), None)
    assert done and done["kind"] == "done", done
    run = call("runs.get", project_id=project["id"], run_id=done["run_id"])["result"]
    built = call("export.build", project_id=project["id"], run_id=run["id"], model_id=run["models"][0]["id"])["result"]
    download = client.get(f"/api/files/{built['zip']['path']}?token={TOKEN}")
    assert download.status_code == 200 and download.content[:2] == b"PK"
    kernel = client.get("/api/kernel", headers=_auth()).json()
    assert kernel["status"] == "ready" and kernel["info"]["python"]
    interpreters = client.get("/api/interpreters", headers=_auth()).json()
    assert interpreters[0]["source"] == "builtin" and interpreters[0]["ready"]


def test_kernel_restart_and_dead_kernel(client):
    restarted = client.post("/api/kernel/restart", headers=_auth()).json()
    assert restarted["status"] in ("starting", "ready")
    client.app.state.kernel.wait_ready()
    assert client.post("/api/rpc", json={"method": "engine.ping"}, headers=_auth()).json()["result"]["pong"]
    client.app.state.kernel.process.kill()
    time.sleep(1)
    answer = client.post("/api/rpc", json={"method": "engine.ping"}, headers=_auth()).json()
    assert answer["error"]["kernel"] is True
    assert client.post("/api/kernel/install", json={"packages": ["evilpkg"]}, headers=_auth()).status_code == 400
