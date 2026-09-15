"""Open folders and files from anywhere, recent folders, and importing a file into the project."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from flowlab_api import create_app

TOKEN = "test-token-123"
WS = "ws://127.0.0.1:8765/api/ws"


@pytest.fixture
def machine(tmp_path: Path) -> Path:
    alpha = tmp_path / "alpha"
    (alpha / ".secret").mkdir(parents=True)
    (alpha / "node_modules").mkdir()
    (alpha / "pkg").mkdir()
    (alpha / "pkg" / "pyproject.toml").write_text("")
    (alpha / "main.py").write_text("x = 1\ny = x + 1\n")
    (alpha / "notes.txt").write_text("not code")
    beta = tmp_path / "beta"
    beta.mkdir()
    notebook = {
        "cells": [
            {"cell_type": "code", "source": "a = 1", "metadata": {}, "outputs": [], "execution_count": None}
        ],
        "metadata": {},
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    (beta / "analysis.ipynb").write_text(json.dumps(notebook))
    return tmp_path


@pytest.fixture
def client(machine: Path) -> Iterator[TestClient]:
    app = create_app(
        machine / "alpha", TOKEN, watch=False, static_dir=None, recents_path=machine / "state" / "recent.json"
    )
    with TestClient(app, base_url="http://127.0.0.1:8765", headers={"X-FlowLab-Token": TOKEN}) as test_client:
        yield test_client


def test_new_routes_need_the_token(machine: Path) -> None:
    app = create_app(machine / "alpha", TOKEN, watch=False, static_dir=None, recents_path=machine / "r.json")
    with TestClient(app, base_url="http://127.0.0.1:8765") as anonymous:
        assert anonymous.get("/api/fs/browse").status_code == 401
        assert anonymous.post("/api/project/open", json={"path": str(machine)}).status_code == 401
        assert anonymous.post("/api/files/import", json={"name": "a.py", "content": ""}).status_code == 401


def test_browse_lists_folders_and_code_files(client: TestClient, machine: Path) -> None:
    listing = client.get("/api/fs/browse", params={"path": str(machine / "alpha")}).json()
    assert [(e["name"], e["kind"]) for e in listing["entries"]] == [("pkg", "dir"), ("main.py", "file")]
    assert listing["entries"][0]["is_project"] is True
    assert listing["parent"] == str(machine) and listing["root"] == str(machine / "alpha")

    hidden = client.get("/api/fs/browse", params={"path": str(machine / "alpha"), "hidden": True}).json()
    assert ".secret" in [e["name"] for e in hidden["entries"]]
    assert client.get("/api/fs/browse").json()["path"] == str(
        machine / "alpha"
    )  # defaults to the open project

    missing = client.get("/api/fs/browse", params={"path": str(machine / "nope")})
    assert missing.status_code == 404
    file = client.get("/api/fs/browse", params={"path": str(machine / "alpha" / "main.py")})
    assert file.status_code == 400 and file.json()["code"] == "NOT_A_FOLDER"


def test_open_folder_switches_every_service(client: TestClient, machine: Path) -> None:
    beta = machine / "beta"
    with client.websocket_connect(f"{WS}?token={TOKEN}") as ws:
        assert ws.receive_json()["type"] == "hello"
        opened = client.post("/api/project/open", json={"path": str(beta)}).json()
        assert opened == {"root": str(beta), "file": None}
        event = ws.receive_json()
        assert event["type"] == "project_changed" and event["data"]["root"] == str(beta)

    info = client.get("/api/project").json()
    assert info["root"] == str(beta) and info["files"] == ["analysis.ipynb"]
    assert client.get("/api/graph", params={"file": "analysis.ipynb"}).status_code == 200
    assert client.get("/api/graph", params={"file": "main.py"}).status_code == 404
    assert client.get("/api/flows").json() == {"flows": [], "datasets": []}
    assert (beta / ".flowlab").is_dir()
    assert client.get("/api/fs/recent").json()[:2] == [str(beta), str(machine / "alpha")]


def test_opening_another_folder_stops_its_kernels(client: TestClient, machine: Path) -> None:
    assert client.post("/api/kernel/start", json={"file": "main.py"}).json()["status"] == "idle"
    session = client.app.state.bench.service.sessions["main.py"]  # type: ignore[attr-defined]
    assert session.is_alive()
    client.post("/api/project/open", json={"path": str(machine / "beta")})
    assert not session.is_alive()


def test_open_a_file_opens_its_folder(client: TestClient, machine: Path) -> None:
    opened = client.post("/api/project/open", json={"path": str(machine / "beta" / "analysis.ipynb")}).json()
    assert opened == {"root": str(machine / "beta"), "file": "analysis.ipynb"}
    again = client.post("/api/project/open", json={"path": str(machine / "beta")})
    assert again.status_code == 200

    def code(path: str) -> tuple[int, str]:
        response = client.post("/api/project/open", json={"path": path})
        return response.status_code, response.json()["code"]

    assert code(str(machine / "alpha" / "notes.txt")) == (400, "UNSUPPORTED_FILE")
    assert code("/") == (400, "FOLDER_TOO_BROAD")
    assert code(str(machine / "missing")) == (404, "PATH_NOT_FOUND")
    assert client.get("/api/project").json()["root"] == str(machine / "beta")  # failures change nothing


def test_import_file_from_this_computer(client: TestClient, machine: Path) -> None:
    first = client.post(
        "/api/files/import", json={"name": "script.py", "content": "a = 1\nb = a * 2\n"}
    ).json()
    assert first == {"file": "imported/script.py"}
    second = client.post("/api/files/import", json={"name": "script.py", "content": "c = 3\n"}).json()
    assert second == {"file": "imported/script_2.py"}
    sneaky = client.post("/api/files/import", json={"name": "../../evil.py", "content": "x = 1\n"}).json()
    assert sneaky == {"file": "imported/evil.py"} and not (machine / "evil.py").exists()

    graph = client.get("/api/graph", params={"file": "imported/script.py"}).json()["graph"]
    assert graph["nodes"] and graph["source"]["files"][0]["path"] == "imported/script.py"

    assert client.post("/api/files/import", json={"name": "data.csv", "content": "a\n"}).status_code == 400
    broken = client.post("/api/files/import", json={"name": "nb.ipynb", "content": "{not json"})
    assert broken.status_code == 422 and broken.json()["code"] == "NOT_A_NOTEBOOK"
    huge = client.post("/api/files/import", json={"name": "big.py", "content": "x" * (5 * 1024 * 1024 + 1)})
    assert huge.status_code == 413
