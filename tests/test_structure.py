"""Structure graphs for any language, workspace routing, node edits and saved layouts. No kernel."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from flowlab_api import create_app
from flowlab_lab.languages import classify, summarise
from flowlab_lab.structure import StructureError, build_structure, edit_node, symbols_of

TOKEN = "test-token-123"

SERVICE_PY = '''from fastapi import FastAPI
app = FastAPI()


class Repo:
    def get(self, user_id):
        return self._load(user_id)

    def _load(self, user_id):
        return {"id": user_id}


@app.get("/users/{user_id}")
def read_user(user_id: int):
    """Return one user."""
    return Repo().get(user_id)
'''

ANALYSIS_PY = """import pandas as pd
df = pd.read_csv("data.csv")
df = df.dropna()
print(df.describe())
"""

APP_TS = """import { shared } from "./util";
export class Api {
  get(id: number) { return this.load(id); }
  load(id: number) { return fetch(`/users/${id}`).then((r) => shared(r)); }
}
function boot() { new Api().get(1); }
"""

UTIL_TS = "export function shared(value: unknown) { return value; }\n"

MAIN_GO = """package main

import "fmt"

type Server struct{}

func (s *Server) Handle(path string) string { return render(path) }

func render(path string) string { fmt.Println(path); return path }

func main() { s := &Server{}; s.Handle("/") }
"""


def _calls(graph):  # type: ignore[no-untyped-def]
    return {(e.from_, e.to) for e in graph.edges if e.kind == "call"}


def test_workspace_routing_separates_analysis_from_application_code() -> None:
    assert classify("analysis.ipynb", None).workspace == "cells"  # type: ignore[union-attr]
    assert classify("explore.py", ANALYSIS_PY).workspace == "cells"  # type: ignore[union-attr]
    assert classify("cells.py", "# %%\nx = 1\n").workspace == "cells"  # type: ignore[union-attr]
    backend = classify("service.py", SERVICE_PY)
    assert backend is not None and backend.workspace == "structure" and "fastapi" in backend.reason
    go = classify("main.go", MAIN_GO)
    assert go is not None and go.workspace == "structure" and not go.can_run_cells
    assert classify("README.md", "# hi") is None
    languages = summarise(["a.py", "b.py", "c.ts", "d.tsx", "e.go"])
    assert [(lang.name, lang.files) for lang in languages] == [("Python", 2), ("TypeScript", 2), ("Go", 1)]


def test_python_structure_links_methods_constructors_and_decorated_routes() -> None:
    graph = build_structure("service.py", SERVICE_PY)
    ids = {n.id: n for n in graph.nodes}
    assert {"Repo (class definition)", "Repo.get", "Repo._load", "read_user"} <= set(ids)
    assert ids["Repo.get"].parent == "Repo (class definition)" and ids["Repo.get"].kind == "method"
    assert ids["read_user"].source.startswith('@app.get("/users/{user_id}")')  # decorators travel with the node
    assert ids["read_user"].doc == "Return one user."
    assert {("Repo.get", "Repo._load"), ("read_user", "Repo.get"), ("read_user", "Repo (class definition)")} <= _calls(
        graph
    )
    edge = next(e for e in graph.edges if (e.from_, e.to) == ("Repo.get", "Repo._load"))
    assert edge.sites[0].line == 7 and "self._load(user_id)" in edge.sites[0].text


def test_typescript_and_go_graphs_with_cross_file_symbols() -> None:
    ts = build_structure("app.ts", APP_TS, symbols_of("util.ts", UTIL_TS))
    assert {("Api.get", "Api.load"), ("boot", "Api.get"), ("Api.load", "util.ts::shared")} <= _calls(ts)
    external = next(n for n in ts.nodes if n.kind == "external")
    assert external.file == "util.ts" and not external.editable

    go = build_structure("main.go", MAIN_GO)
    assert {("Handle", "render"), ("main", "Handle")} <= _calls(go)
    assert go.language == "go" and go.monaco == "go" and not go.problems


@pytest.mark.parametrize(
    ("path", "source", "expected"),
    [
        ("A.java", "class A { int m(int x){ return helper(x); } static int helper(int y){ return y; } }", ("A.m", "A.helper")),
        ("s.rs", "struct S; impl S { fn run(&self) -> i32 { helper(1) } }\nfn helper(y: i32) -> i32 { y }\n", ("S.run", "helper")),
        ("a.rb", "class A\n  def m(x)\n    helper(x)\n  end\nend\ndef helper(y)\n  y\nend\n", ("A.m", "helper")),
        ("a.cpp", "int helper(int y){ return y; }\nclass A { public: int m(int x){ return helper(x); } };\n", ("A.m", "helper")),
        ("a.kt", "class A { fun m(x: Int): Int = helper(x) }\nfun helper(y: Int): Int = y\n", ("A.m", "helper")),
    ],
)  # fmt: skip
def test_other_languages(path: str, source: str, expected: tuple[str, str]) -> None:
    assert expected in _calls(build_structure(path, source))


def test_edits_replace_one_node_and_refuse_broken_syntax() -> None:
    edited = edit_node("service.py", SERVICE_PY, "Repo._load", '    def _load(self, user_id):\n        return {"id": user_id, "ok": True}\n')
    assert '"ok": True' in edited and edited.count("def _load") == 1 and "def read_user" in edited
    assert build_structure("service.py", edited).nodes  # still parses
    with pytest.raises(StructureError) as broken:
        edit_node("service.py", SERVICE_PY, "Repo._load", "    def _load(self, user_id:\n        return 1\n")
    assert broken.value.code == "SYNTAX_ERROR" and broken.value.details["line"] in (1, 2)
    with pytest.raises(StructureError) as missing:
        edit_node("service.py", SERVICE_PY, "Nope.nothing", "def x(): pass")
    assert missing.value.code == "UNKNOWN_NODE"


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    root = tmp_path / "proj"
    (root / "web").mkdir(parents=True)
    (root / "service.py").write_text(SERVICE_PY)
    (root / "explore.py").write_text(ANALYSIS_PY)
    (root / "web" / "app.ts").write_text(APP_TS)
    (root / "web" / "util.ts").write_text(UTIL_TS)
    (root / "main.go").write_text(MAIN_GO)
    (root / "notes.md").write_text("# not code")
    app = create_app(root, TOKEN, watch=False, static_dir=None, recents_path=tmp_path / "recent.json")
    with TestClient(app, base_url="http://127.0.0.1:8765", headers={"X-FlowLab-Token": TOKEN}) as test_client:
        yield test_client


def test_project_reports_languages_and_workspaces(client: TestClient) -> None:
    info = client.get("/api/project").json()
    assert info["files"] == ["explore.py", "service.py"]  # cells can run Python only
    assert info["code_files"] == ["explore.py", "main.go", "service.py", "web/app.ts", "web/util.ts"]
    assert info["file_info"]["explore.py"]["workspace"] == "cells"
    assert info["file_info"]["service.py"]["workspace"] == "structure"
    assert info["file_info"]["web/app.ts"]["monaco"] == "typescript"
    assert [lang["name"] for lang in info["languages"]] == ["Python", "TypeScript", "Go"]


def test_structure_edit_preview_revert_and_conflicts(client: TestClient) -> None:
    graph = client.get("/api/structure", params={"file": "web/app.ts"}).json()
    assert graph["workspace"] == "structure" and any(n["kind"] == "external" for n in graph["nodes"])
    assert any(e["from"] == "Api.load" and e["to"] == "web/util.ts::shared" for e in graph["edges"])

    bad = client.post("/api/structure/preview", json={"file": "web/app.ts", "node_id": "boot", "source": "function boot( {"})
    assert bad.status_code == 200 and bad.json()["ok"] is False

    stale = client.post(
        "/api/structure/edit", json={"file": "web/app.ts", "node_id": "boot", "source": "function boot() {}", "expected_hash": "0" * 64}
    )
    assert stale.status_code == 409 and stale.json()["code"] == "FILE_CHANGED"

    saved = client.post(
        "/api/structure/edit",
        json={"file": "web/app.ts", "node_id": "boot", "source": "function boot() { new Api().load(2); }", "expected_hash": graph["hash"]},
    ).json()
    assert ("boot", "Api.load") in {(e["from"], e["to"]) for e in saved["edges"]}
    refused = client.post("/api/structure/edit", json={"file": "web/app.ts", "node_id": "boot", "source": "function boot( {"})
    assert refused.status_code == 422 and refused.json()["code"] == "SYNTAX_ERROR"

    restored = client.post("/api/structure/revert", json={"file": "web/app.ts"}).json()
    assert ("boot", "Api.get") in {(e["from"], e["to"]) for e in restored["edges"]}
    assert client.get("/api/structure", params={"file": "../etc/passwd.py"}).status_code == 403
    assert client.get("/api/structure", params={"file": "notes.md"}).status_code == 400


def test_layouts_are_saved_per_file_and_view(client: TestClient) -> None:
    assert client.get("/api/layout", params={"file": "main.go"}).json()["positions"] == {}
    saved = client.put("/api/layout", json={"file": "main.go", "view": "structure", "positions": {"main": {"x": 10.26, "y": -4}}})
    assert saved.json()["saved"] == 1
    assert client.get("/api/layout", params={"file": "main.go"}).json()["positions"] == {"main": {"x": 10.3, "y": -4.0}}
    assert client.get("/api/layout", params={"file": "main.go", "view": "cells"}).json()["positions"] == {}
    assert client.put("/api/layout", json={"file": "main.go", "view": "../x", "positions": {}}).status_code == 400
