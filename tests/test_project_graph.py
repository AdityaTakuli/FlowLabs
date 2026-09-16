"""Whole-project graph: folders, files, cross-file call arrows, language filter, caching."""

from __future__ import annotations

import os
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from flowlab_api import create_app
from flowlab_lab.project_graph import ProjectGraphBuilder

TOKEN = "test-token-123"

FILES = {
    "api/routes.py": "from services.users import find_user\n\ndef read(uid):\n    return find_user(uid)\n",
    "services/users.py": "from db.repo import load\n\ndef find_user(uid):\n    return load('users', uid)\n",
    "db/repo.py": "def load(table, key):\n    return {'table': table, 'key': key}\n",
    "web/app.ts": 'import { fmt } from "./fmt";\nexport function show(x: number) { return fmt(x); }\n',
    "web/fmt.ts": "export function fmt(x: number) { return String(x); }\n",
    "notebooks/eda.ipynb": '{"cells": [], "metadata": {}, "nbformat": 4, "nbformat_minor": 5}',
}


@pytest.fixture
def root(tmp_path: Path) -> Path:
    base = tmp_path / "proj"
    for name, text in FILES.items():
        (base / name).parent.mkdir(parents=True, exist_ok=True)
        (base / name).write_text(text)
    return base


def _pairs(graph) -> set[tuple[str, str]]:  # type: ignore[no-untyped-def]
    return {(e.from_, e.to) for e in graph.edges}


def test_files_folders_and_cross_file_arrows(root: Path) -> None:
    graph = ProjectGraphBuilder(root).build(sorted(FILES))
    assert {f.id for f in graph.files} == set(FILES) - {"notebooks/eda.ipynb"}  # notebooks stay cells
    assert _pairs(graph) == {
        ("api/routes.py", "services/users.py"),
        ("services/users.py", "db/repo.py"),
        ("web/app.ts", "web/fmt.ts"),
    }
    edge = next(e for e in graph.edges if e.from_ == "api/routes.py")
    assert edge.calls == 1 and edge.names == ["find_user"] and edge.units == [("read", "find_user")]
    folders = {f.id: f for f in graph.folders}
    assert folders["api"].parent == "" and folders["api"].files == 1 and folders[""].parent is None
    routes = next(f for f in graph.files if f.id == "api/routes.py")
    assert routes.units == 1 and routes.folder == "api" and routes.language_name == "Python"
    assert graph.languages == ["Python", "TypeScript"]


def test_language_filter_and_incremental_rebuild(root: Path) -> None:
    builder = ProjectGraphBuilder(root)
    only_ts = builder.build(sorted(FILES), language="TypeScript")
    assert {f.id for f in only_ts.files} == {"web/app.ts", "web/fmt.ts"}

    builder.build(sorted(FILES))
    repo = root / "db" / "repo.py"
    repo.write_text("def fetch(table, key):\n    return None\n")  # the callee is renamed away
    later = time.time() + 5
    os.utime(repo, (later, later))
    rebuilt = builder.build(sorted(FILES))
    assert ("services/users.py", "db/repo.py") not in _pairs(rebuilt)
    assert ("api/routes.py", "services/users.py") in _pairs(rebuilt)


@pytest.fixture
def client(root: Path, tmp_path: Path) -> Iterator[TestClient]:
    app = create_app(root, TOKEN, watch=False, static_dir=None, recents_path=tmp_path / "recent.json")
    with TestClient(app, base_url="http://127.0.0.1:8765", headers={"X-FlowLab-Token": TOKEN}) as test_client:
        yield test_client


def test_project_graph_endpoint(client: TestClient) -> None:
    payload = client.get("/api/project-graph").json()
    assert {(e["from"], e["to"]) for e in payload["edges"]} >= {("api/routes.py", "services/users.py")}
    assert {f["id"]: f["workspace"] for f in payload["files"]}["db/repo.py"] == "structure"
    only_python = client.get("/api/project-graph", params={"language": "Python"}).json()
    assert all(f["language_name"] == "Python" for f in only_python["files"])
