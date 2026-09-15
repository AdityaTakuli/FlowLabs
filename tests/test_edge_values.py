"""Data on edges: HTTP responses, JSON payloads and per-variable value labels from real runs."""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from flowlab_api import create_app
from flowlab_api.service import short_value

TOKEN = "test-token-123"


class UsersApi(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - http.server naming
        body = json.dumps({"items": [{"id": i, "name": f"user{i}"} for i in range(3)], "page": 1}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: Any) -> None:
        pass


@pytest.fixture
def api_url() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), UsersApi)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()


def test_short_values() -> None:
    assert short_value({"kind": "dataframe", "rows": 2000, "columns": ["a"] * 9}) == "DataFrame 2,000×9"
    assert short_value(
        {"kind": "response", "status": 404, "reason": "Not Found", "content_type": "text/html"}
    ) == ("404 Not Found · html")
    assert short_value({"kind": "collection", "container": "dict", "length": 2}) == "dict · 2 keys"
    assert short_value(
        {"kind": "estimator", "type": "sklearn.linear_model.LogisticRegression", "fitted": True}
    ) == ("LogisticRegression (fitted)")
    assert short_value({"kind": "scalar", "repr": "'" + "x" * 80 + "'"}).endswith("…")
    assert short_value({"kind": "object", "error": "boom"}) == "could not summarise"


def test_edges_carry_api_responses_json_and_tables(tmp_path: Path, api_url: str) -> None:
    (tmp_path / "api.py").write_text(
        f"# %% Fetch users\nimport requests\nresp = requests.get({api_url + '/users'!r}, timeout=10)\n\n"
        "# %% Parse\npayload = resp.json()\nusers = payload['items']\n\n"
        "# %% Table\nimport pandas as pd\ntable = pd.DataFrame(users)\n"
    )
    app = create_app(tmp_path, TOKEN, watch=False, static_dir=None, recents_path=tmp_path / "recent.json")
    with TestClient(app, base_url="http://127.0.0.1:8765", headers={"X-FlowLab-Token": TOKEN}) as client:
        client.post("/api/kernel/start", json={"file": "api.py"})
        try:
            assert client.post("/api/execute", json={"file": "api.py", "mode": "all"}).status_code == 200
            deadline = time.monotonic() + 120
            state: dict[str, Any] = {}
            while time.monotonic() < deadline:
                state = client.get("/api/state", params={"file": "api.py"}).json()
                if state["kernel"]["status"] == "idle" and state["nodes"]["b3"]["last_run"]:
                    break
                time.sleep(0.2)
            assert all(n["state"] == "success" for n in state["nodes"].values()), state["nodes"]
            values = {node_id: entry["values"] for node_id, entry in state["nodes"].items()}
            assert values["b1"]["resp"] == {"kind": "response", "text": "200 OK · json"}
            assert values["b2"]["payload"]["text"] == "dict · 2 keys"
            assert values["b2"]["users"]["text"] == "list · 3 items"
            assert values["b3"]["table"]["text"] == "DataFrame 3×2"

            graph = client.get("/api/graph", params={"file": "api.py"}).json()["graph"]
            assert ("b1", "b2", "resp") in {(e["from"], e["to"], e["variable"]) for e in graph["edges"]}

            resp = client.get("/api/inspect", params={"file": "api.py", "node_id": "b1"}).json()["after"][
                "resp"
            ]
            assert (resp["status"], resp["method"], resp["body_format"]) == (200, "GET", "json")
            assert resp["url"].endswith("/users") and resp["headers"]["Content-Type"] == "application/json"
            assert json.loads(resp["body"])["page"] == 1 and resp["size_bytes"] > 0

            parsed = client.get("/api/inspect", params={"file": "api.py", "node_id": "b2"}).json()["after"]
            assert json.loads(parsed["users"]["preview"])[0] == {"id": 0, "name": "user0"}
            assert parsed["payload"]["keys"] == ["items", "page"]
        finally:
            client.post("/api/kernel/stop", json={"file": "api.py"})
