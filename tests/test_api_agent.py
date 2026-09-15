"""Agent panel on the local API: consent, prompt preview, ask, recompose, save. No network."""

from __future__ import annotations

import json
import shutil
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from flowlab_agent import ScriptedClient
from flowlab_api import create_app

TOKEN = "test-token-123"
REPO = Path(__file__).resolve().parents[1]
PLAN = json.dumps(
    {
        "target": "churned",
        "steps": [{"use": "model.logistic_regression"}, {"use": "evaluate.classification_report"}],
        "note": "Explainable baseline.",
    }
)


class Scripted:
    """Hands every request a fresh scripted client and remembers what was sent."""

    def __init__(self, replies: list[str]) -> None:
        self.replies = replies
        self.clients: list[ScriptedClient] = []

    def __call__(self, model: str | None) -> ScriptedClient:
        client = ScriptedClient(list(self.replies))
        self.clients.append(client)
        return client

    @property
    def calls(self) -> int:
        return sum(len(c.calls) for c in self.clients)


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "project"
    (root / "data").mkdir(parents=True)
    shutil.copy(REPO / "fixtures" / "churn.csv", root / "data" / "churn.csv")
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.chdir(tmp_path)  # keep the repo's own .env out of key lookup
    return root


@pytest.fixture
def scripted() -> Scripted:
    return Scripted([PLAN])


@pytest.fixture
def client(project: Path, scripted: Scripted) -> Iterator[TestClient]:
    app = create_app(project, TOKEN, watch=False, static_dir=None, llm_client_factory=scripted)
    with TestClient(app, base_url="http://127.0.0.1:8765", headers={"X-FlowLab-Token": TOKEN}) as test_client:
        yield test_client


def ask(client: TestClient, **overrides: Any) -> Any:
    body = {"goal": "What drives churn?", "dataset": "data/churn.csv", "confirm_external": True, **overrides}
    return client.post("/api/agent/ask", json=body)


def test_routes_need_the_token(project: Path) -> None:
    app = create_app(project, TOKEN, watch=False, static_dir=None)
    with TestClient(app, base_url="http://127.0.0.1:8765") as anonymous:
        assert anonymous.get("/api/agent/status").status_code == 401
        assert anonymous.post("/api/agent/ask", json={}).status_code == 401


def test_without_a_key_status_says_so_and_ask_explains(project: Path) -> None:
    app = create_app(project, TOKEN, watch=False, static_dir=None)
    with TestClient(app, base_url="http://127.0.0.1:8765", headers={"X-FlowLab-Token": TOKEN}) as client:
        status = client.get("/api/agent/status").json()
        assert status["configured"] is False and status["snippets"] > 50 and "never" not in status["sends"]
        response = ask(client)
        assert response.status_code == 412 and response.json()["code"] == "NO_API_KEY"
        # preview needs no key and makes no call
        assert (
            client.post("/api/agent/preview", json={"goal": "x", "dataset": "data/churn.csv"}).status_code
            == 200
        )


def test_key_in_project_env_file_is_found(project: Path) -> None:
    (project / ".env").write_text("GROQ_API_KEY=gsk_test_value\n")
    app = create_app(project, TOKEN, watch=False, static_dir=None)
    with TestClient(app, base_url="http://127.0.0.1:8765", headers={"X-FlowLab-Token": TOKEN}) as client:
        body = client.get("/api/agent/status").text
        assert json.loads(body)["configured"] is True and "gsk_test_value" not in body


def test_preview_shows_exactly_what_is_sent_without_calling(client: TestClient, scripted: Scripted) -> None:
    preview = client.post(
        "/api/agent/preview", json={"goal": "predict churn", "dataset": "data/churn.csv"}
    ).json()
    assert [m["role"] for m in preview["messages"]] == ["system", "user"]
    text = "\n".join(m["content"] for m in preview["messages"])
    assert "churned" in text and "C00001" not in text  # column names yes, rows never
    assert 0 < preview["estimated_tokens"] < 900 and preview["candidates"]
    assert scripted.calls == 0


def test_ask_requires_explicit_consent(client: TestClient, scripted: Scripted) -> None:
    refused = ask(client, confirm_external=False)
    assert refused.status_code == 428 and refused.json()["code"] == "CONSENT_REQUIRED"
    assert scripted.calls == 0


def test_ask_composes_a_cell_script_and_caches(client: TestClient, project: Path) -> None:
    proposal = ask(client).json()
    assert proposal["ok"] and proposal["proposal_id"] and proposal["error"] is None
    ids = [s["id"] for s in proposal["steps"]]
    assert ids[0] == "load.csv" and proposal["steps"][0]["auto"]
    assert "model.logistic_regression" in ids and "split.train_test" in ids
    assert proposal["script"].startswith("# %% Setup")
    assert str(project / "generated" / "outputs") in proposal["script"]
    assert proposal["plan"]["steps"][0] == {"use": "model.logistic_regression", "with": {}}
    assert proposal["tokens_spent"] > 0 and proposal["suggested_file"] == "generated/what_drives_churn.py"

    again = ask(client).json()
    assert again["attempts"][0]["cached"] is True and again["tokens_spent"] == 0
    usage = client.get("/api/agent/status").json()["usage"]
    assert usage == {"requests": 2, "cached": 1, "tokens": proposal["tokens_spent"]}
    assert (project / ".flowlab" / "llm_usage.jsonl").is_file()


def test_failed_plans_are_reported_not_saved(project: Path) -> None:
    app = create_app(
        project, TOKEN, watch=False, static_dir=None, llm_client_factory=Scripted(["not json", "{}", "{}"])
    )
    with TestClient(app, base_url="http://127.0.0.1:8765", headers={"X-FlowLab-Token": TOKEN}) as client:
        proposal = ask(client, use_cache=False).json()
        assert not proposal["ok"] and proposal["proposal_id"] is None and len(proposal["attempts"]) == 3
        assert proposal["error"]


def test_recompose_edited_plan_costs_nothing(client: TestClient, scripted: Scripted) -> None:
    proposal = ask(client).json()
    calls = scripted.calls
    plan = proposal["plan"]
    plan["steps"] = [{"use": "viz.histogram", "with": {"column": "tenure_months"}}]
    body = {"goal": proposal["goal"], "dataset": "data/churn.csv", "plan": plan}
    recomposed = client.post("/api/agent/compose", json=body).json()
    assert recomposed["ok"] and recomposed["attempts"] == [] and "viz.histogram" in recomposed["script"]
    assert scripted.calls == calls

    plan["steps"] = [{"use": "viz.histogrm", "with": {"column": "tenure_months"}}]
    broken = client.post("/api/agent/compose", json={**body, "plan": plan}).json()
    assert not broken["ok"] and "did you mean 'viz.histogram'" in broken["error"]
    invalid = client.post("/api/agent/compose", json={**body, "plan": {"steps": "nope"}})
    assert invalid.status_code == 422 and invalid.json()["code"] == "PLAN_INVALID"


def test_save_writes_a_script_code_mode_can_open(client: TestClient, project: Path) -> None:
    proposal = ask(client).json()
    pid = proposal["proposal_id"]
    saved = client.post("/api/agent/save", json={"proposal_id": pid, "file": "generated/churn.py"})
    assert saved.status_code == 200 and saved.json() == {"file": "generated/churn.py"}
    assert (project / "generated" / "churn.py").read_text() == proposal["script"]
    graph = client.get("/api/graph", params={"file": "generated/churn.py"}).json()["graph"]
    assert len([n for n in graph["nodes"] if n["kind"] == "code"]) == len(proposal["steps"]) + 1

    again = client.post("/api/agent/save", json={"proposal_id": pid, "file": "generated/churn.py"})
    assert again.status_code == 409 and again.json()["code"] == "FILE_EXISTS"
    overwrite = {"proposal_id": pid, "file": "generated/churn.py", "overwrite": True}
    assert client.post("/api/agent/save", json=overwrite).status_code == 200
    outside = client.post("/api/agent/save", json={"proposal_id": pid, "file": "../escape.py"})
    assert outside.status_code == 403
    assert client.post("/api/agent/save", json={"proposal_id": pid, "file": "notes.txt"}).status_code == 400
    assert client.post("/api/agent/save", json={"proposal_id": "nope", "file": "a.py"}).status_code == 404


def test_datasets_are_confined_and_snippets_searchable(client: TestClient, project: Path) -> None:
    (project.parent / "outside.csv").write_text("a\n1\n")
    assert ask(client, dataset="../outside.csv").status_code == 403
    assert ask(client, dataset="data/churn.txt").status_code == 400
    assert ask(client, dataset="data/missing.csv").status_code == 404
    assert ask(client, goal="   ").json()["code"] == "EMPTY_GOAL"
    found = client.get("/api/agent/snippets", params={"q": "histogram distribution"}).json()
    assert "viz.histogram" in [s["id"] for s in found]
