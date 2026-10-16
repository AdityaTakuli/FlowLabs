"""The desktop app: bundled canvas, local server lifecycle, and choosing the Python for kernels."""

from __future__ import annotations

import json
import os
import socket
import sys
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from flowlab_api import create_app
from flowlab_api.app import DEFAULT_STATIC
from flowlab_api.desktop import Server, default_workspace, free_port
from flowlab_lab.interpreters import InterpreterError, default_interpreter, discover, kernelspec_for
from flowlab_lab.kernel import LabSession
from flowlab_lab.project import LabProject

TOKEN = "test-token-123"


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "analysis.py").write_text("# %% one\nvalue = 21 * 2\nprint(value)\n")
    return root


@pytest.fixture
def client(project: Path, tmp_path: Path) -> Iterator[TestClient]:
    app = create_app(project, TOKEN, watch=False, static_dir=None, recents_path=tmp_path / "recent.json")
    with TestClient(app, base_url="http://127.0.0.1:8765", headers={"X-FlowLab-Token": TOKEN}) as test_client:
        yield test_client


# ------------------------------------------------------------------- interpreters
def test_discovery_keeps_environments_apart_and_reports_ipykernel(project: Path) -> None:
    found = discover(project)
    mine = next(i for i in found if i.path == os.path.normpath(os.path.abspath(sys.executable)))
    assert mine.source == "current" and mine.ipykernel is True and mine.version
    assert len({i.path for i in found}) == len(found)  # a venv is not merged into its base Python
    assert default_interpreter(project) is not None and default_interpreter(project).ipykernel  # type: ignore[union-attr]


def test_kernelspec_is_written_for_the_chosen_interpreter(tmp_path: Path) -> None:
    name, specs = kernelspec_for(sys.executable, directory=tmp_path / "kernels")
    spec = json.loads((specs / name / "kernel.json").read_text())
    assert spec["argv"][:3] == [str(Path(sys.executable)), "-m", "ipykernel_launcher"]
    assert spec["argv"][-2:] == ["-f", "{connection_file}"]
    assert name.startswith("flowlab-") and spec["language"] == "python"

    with pytest.raises(InterpreterError, match="does not exist"):
        kernelspec_for(str(tmp_path / "nope" / "python"), directory=tmp_path)
    shell = tmp_path / "not-python.sh"
    shell.write_text("#!/bin/sh\nexit 3\n")
    shell.chmod(0o755)
    with pytest.raises(InterpreterError, match="did not answer"):
        kernelspec_for(str(shell), directory=tmp_path)


def test_kernel_starts_from_the_chosen_interpreter(project: Path) -> None:
    session = LabSession(LabProject(project), "analysis.py", timeout_s=120, python_path=sys.executable)
    session.start()
    try:
        record = session.run_node("b1")
        assert record.status == "success" and "42" in record.stdout
        assert session.environment["executable"] == sys.executable
    finally:
        session.shutdown()


def test_interpreter_api_saves_the_choice_and_refuses_unusable_ones(client: TestClient, project: Path) -> None:
    payload = client.get("/api/interpreters").json()
    assert payload["configured"] is None and payload["packaged"] is False
    assert any(i["path"] == os.path.normpath(os.path.abspath(sys.executable)) for i in payload["interpreters"])

    chosen = client.post("/api/interpreters", json={"path": sys.executable}).json()
    assert chosen["configured"] == sys.executable
    assert json.loads((project / ".flowlab" / "lab.json").read_text())["python_path"] == sys.executable

    refused = client.post("/api/interpreters", json={"path": str(project / "analysis.py")})
    assert refused.status_code == 422 and refused.json()["code"] == "INTERPRETER_UNUSABLE"
    assert client.post("/api/interpreters", json={"path": None}).json()["configured"] is None


# ------------------------------------------------------------------------ the app
def test_the_canvas_is_bundled_into_the_package() -> None:
    assert (DEFAULT_STATIC / "index.html").is_file(), "run python scripts/bundle_web.py"
    assert any(DEFAULT_STATIC.glob("assets/*.js"))


def test_bundled_canvas_is_served(project: Path, tmp_path: Path) -> None:
    app = create_app(project, TOKEN, watch=False, recents_path=tmp_path / "recent.json")
    with TestClient(app, base_url="http://127.0.0.1:8765") as anonymous:
        page = anonymous.get("/")
        assert page.status_code == 200 and "<title>FlowLab</title>" in page.text


def test_free_port_and_server_lifecycle(project: Path) -> None:
    port = free_port()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as taken:
        taken.bind(("127.0.0.1", port))
        other = free_port(port)
    assert other != port

    server = Server(project, other, "tkn")
    server.start()
    try:
        assert server.url == f"http://127.0.0.1:{other}/?token=tkn"
        with urllib.request.urlopen(f"http://127.0.0.1:{other}/api/health", timeout=10) as response:
            assert json.loads(response.read())["status"] == "ok"
    finally:
        server.stop()
    with pytest.raises(OSError):
        urllib.request.urlopen(f"http://127.0.0.1:{other}/api/health", timeout=2)


def test_default_workspace_prefers_recents_then_creates_one(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    (home / ".flowlab").mkdir(parents=True)
    monkeypatch.setenv("FLOWLAB_HOME", str(home / ".flowlab"))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))

    fresh = default_workspace()
    assert fresh == home / "FlowLab" and fresh.is_dir()
    assert (fresh / "ml-lab" / "03_torch_training.ipynb").is_file()  # examples ship with the app

    recent = tmp_path / "recent-project"
    recent.mkdir()
    (home / ".flowlab" / "recent.json").write_text(json.dumps([str(recent)]))
    assert default_workspace() == recent
