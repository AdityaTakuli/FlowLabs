"""Architecture view API: deterministic analysis, consent-gated model naming, budget, feedback. No network."""

from __future__ import annotations

import json
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from flowlab_agent import LLMResponse, Message
from flowlab_api import create_app
from test_segregation import ML_REPO, write

TOKEN = "test-token-123"
WS = "ws://127.0.0.1:8765/api/ws"


class NamingClient:
    """Stands in for Groq: names every cluster in the fingerprints it receives."""

    model = "scripted-architect"

    def __init__(self) -> None:
        self.calls = 0

    def complete(self, messages: Sequence[Message], *, max_tokens: int = 700, json_mode: bool = True) -> LLMResponse:
        self.calls += 1
        system, user = messages[0].content, messages[1].content
        payload = json.loads(user.split("\n", 1)[1].split("\n", 1)[0])
        if "TASK: CLASSIFY" in system:
            text = json.dumps({"archetypes": [{"cluster_id": p["cluster_id"], "archetype": "utility", "reason": "Generic."} for p in payload]})
        elif "TASK: CONTRACTS" in system:
            text = json.dumps({"contracts": [{"cluster_id": p["cluster_id"], "responsibility": "Handles one step."} for p in payload]})
        else:
            text = json.dumps({
                "components": [
                    {"cluster_id": p["cluster_id"], "name": f"Churn {p['cluster_id']} stage", "archetype": "service",
                     "responsibility": "Handles one step of the churn workflow.", "confidence": "medium"}
                    for p in payload
                ],
                "changes": [],
            })  # fmt: skip
        return LLMResponse(text=text, model=self.model, prompt_tokens=len(user) // 4, completion_tokens=len(text) // 4)


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = write(tmp_path / "ml", {k: v for k, v in ML_REPO.items() if not k.startswith((".venv", "node_modules"))})
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.chdir(tmp_path)
    return root


@pytest.fixture
def naming() -> NamingClient:
    return NamingClient()


@pytest.fixture
def client(project: Path, naming: NamingClient, tmp_path: Path) -> Iterator[TestClient]:
    app = create_app(project, TOKEN, watch=False, static_dir=None, recents_path=tmp_path / "recent.json", llm_client_factory=lambda _: naming)
    with TestClient(app, base_url="http://127.0.0.1:8765", headers={"X-FlowLab-Token": TOKEN}) as test_client:
        yield test_client


def test_routes_need_the_token(project: Path, tmp_path: Path) -> None:
    app = create_app(project, TOKEN, watch=False, static_dir=None, recents_path=tmp_path / "r.json")
    with TestClient(app, base_url="http://127.0.0.1:8765") as anonymous:
        assert anonymous.get("/api/architecture").status_code == 401
        assert anonymous.post("/api/architecture/analyse", json={}).status_code == 401


def test_deterministic_analysis_is_stored_and_announced(client: TestClient, project: Path, naming: NamingClient) -> None:
    missing = client.get("/api/architecture")
    assert missing.status_code == 404 and missing.json()["code"] == "NO_ARCHITECTURE"
    with client.websocket_connect(f"{WS}?token={TOKEN}") as ws:
        assert ws.receive_json()["type"] == "hello"
        manifest = client.post("/api/architecture/analyse", json={}).json()
        event = ws.receive_json()
    assert event["type"] == "architecture_ready" and event["data"]["components"] == len(manifest["components"])
    assert manifest["llm"]["status"] == "skipped" and naming.calls == 0
    assert any(f["code"] == "LEAKAGE_FIT_BEFORE_SPLIT" for f in manifest["findings"])
    assert all(e["from"] and e["to"] for e in manifest["edges"])  # serialised with the "from" alias
    assert client.get("/api/architecture").json() == manifest
    assert (project / ".flowlab" / "architecture" / "manifest.json").is_file()


def test_model_naming_needs_consent_and_a_key(project: Path, tmp_path: Path) -> None:
    app = create_app(project, TOKEN, watch=False, static_dir=None, recents_path=tmp_path / "r.json")
    with TestClient(app, base_url="http://127.0.0.1:8765", headers={"X-FlowLab-Token": TOKEN}) as client:
        refused = client.post("/api/architecture/analyse", json={"use_llm": True})
        assert refused.status_code == 428 and "never function bodies" in refused.json()["message"]
        no_key = client.post("/api/architecture/analyse", json={"use_llm": True, "confirm_external": True})
        assert no_key.status_code == 412 and no_key.json()["code"] == "NO_API_KEY"


def test_model_naming_budget_and_confirmation(client: TestClient, naming: NamingClient) -> None:
    over = client.post("/api/architecture/analyse", json={"use_llm": True, "confirm_external": True, "max_tokens": 1000}).json()
    assert over["llm"]["status"] == "over_budget" and naming.calls == 0
    assert over["llm"]["estimated_tokens"] > 1000

    named = client.post(
        "/api/architecture/analyse",
        json={"use_llm": True, "confirm_external": True, "max_tokens": 1000, "allow_over_budget": True},
    ).json()
    assert named["llm"]["status"] == "used" and naming.calls > 0
    assert all(c["name"].startswith("Churn c") and c["decided_by"] == "llm" for c in named["components"])


def test_feedback_is_stored_anonymised(client: TestClient, project: Path) -> None:
    assert client.post("/api/architecture/feedback", json={"component_id": "cmp_1", "correction": "wrong"}).status_code == 404
    manifest = client.post("/api/architecture/analyse", json={}).json()
    component = next(c for c in manifest["components"] if len(c["units"]) >= 2)
    unit_names = {u["name"] for u in manifest["units"] if u["component_id"] == component["id"]}
    saved = client.post(
        "/api/architecture/feedback", json={"component_id": component["id"], "correction": "These belong with training."}
    ).json()
    assert saved == {"stored": True, "path": ".flowlab/architecture/feedback.jsonl"}
    text = (project / ".flowlab" / "architecture" / "feedback.jsonl").read_text()
    entry: dict[str, Any] = json.loads(text.splitlines()[0])
    assert entry["correction"] == "These belong with training." and entry["fingerprint"]["unit_count"] == len(component["units"])
    assert not any(name in text for name in unit_names if len(name) > 4)  # SEG-100: anonymised
    assert client.post("/api/architecture/feedback", json={"unit_id": "u_nope", "correction": "wrong"}).status_code == 404
    assert client.post("/api/architecture/feedback", json={"correction": "wrong"}).status_code == 422
