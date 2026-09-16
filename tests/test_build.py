"""Build mode: purposes catalogue, pipeline ordering/checks, name analysis, validated LLM glue, API run."""

from __future__ import annotations

import json
import shutil
import time
from collections.abc import Iterator, Sequence
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from flowlab_agent import DatasetDigest, LLMResponse, Message, SnippetLibrary
from flowlab_agent.builder import (
    Cell,
    Pipeline,
    catalogue,
    check,
    connect,
    finalize,
    order_nodes,
    unresolved_names,
    validate_glue,
)
from flowlab_api import create_app
from helpers import FIXTURES

LIBRARY = SnippetLibrary.load()
NUMERIC = DatasetDigest.from_file(FIXTURES / "clean_numeric.csv")
TOKEN = "test-token-123"


class GlueClient:
    """Stands in for Groq: answers the connect prompt with a fixed JSON body."""

    model = "scripted-glue"

    def __init__(self, answer: dict[str, object]) -> None:
        self.answer = answer
        self.prompts: list[str] = []

    def complete(self, messages: Sequence[Message], *, max_tokens: int = 700, json_mode: bool = True) -> LLMResponse:
        self.prompts.append(messages[-1].content)
        return LLMResponse(text=json.dumps(self.answer), model=self.model, prompt_tokens=100, completion_tokens=20)


def regression_pipeline(**changes: object) -> dict[str, object]:
    data: dict[str, object] = {
        "name": "numeric regression",
        "dataset": "clean_numeric.csv",
        "target": "y",
        "nodes": [
            {"id": "load", "snippet": "load.csv", "y": 0},
            {"id": "split", "snippet": "split.train_test", "y": 100},
            {"id": "scale", "snippet": "prep.scale", "params": {"method": "robust"}, "y": 200},
            {"id": "ridge", "snippet": "model.ridge", "y": 300},
            {"id": "metrics", "snippet": "evaluate.regression_metrics", "y": 400},
        ],
        "edges": [
            {"from": "load", "to": "split"},
            {"from": "split", "to": "scale"},
            {"from": "scale", "to": "ridge"},
            {"from": "ridge", "to": "metrics"},
        ],
    }
    data.update(changes)
    return data


def test_catalogue_covers_every_purpose_with_techniques_and_examples() -> None:
    purposes = {p["id"]: p for p in catalogue(LIBRARY)}
    assert list(purposes) == ["data", "explore", "clean", "features", "split", "preprocess", "model", "evaluate", "explain", "visualize", "export"]
    models = purposes["model"]["snippets"]
    groups = {s["group"] for s in models}
    assert {"Classification", "Regression", "Clustering", "Deep learning (PyTorch)", "Tuning and automatic"} <= groups
    names = {s["id"] for s in models}
    assert {"model.svm_classifier", "model.knn_classifier", "model.lasso", "model.dbscan", "model.torch_mlp"} <= names
    prep_groups = {s["group"] for s in purposes["preprocess"]["snippets"]}
    assert {"Imputation", "Encoding", "Scaling and normalization", "Transforms", "Selection and reduction", "Class balancing"} <= prep_groups
    scale = next(s for s in purposes["preprocess"]["snippets"] if s["id"] == "prep.scale")
    assert "StandardScaler" in scale["example"] and scale["params"]["method"]["choices"] == ["standard", "minmax", "robust"]


def test_order_follows_edges_then_stage_and_reports_loops() -> None:
    shuffled = regression_pipeline()
    shuffled["nodes"] = list(reversed(shuffled["nodes"]))  # type: ignore[call-overload]
    ordered, issues = order_nodes(Pipeline.model_validate(shuffled), LIBRARY)
    assert [n.id for n in ordered] == ["load", "split", "scale", "ridge", "metrics"] and issues == []

    looped = regression_pipeline(edges=[{"from": "scale", "to": "ridge"}, {"from": "ridge", "to": "scale"}])
    _, issues = order_nodes(Pipeline.model_validate(looped), LIBRARY)
    assert issues and issues[0].severity == "error" and "loop" in issues[0].message


def test_check_validates_params_tasks_and_missing_steps() -> None:
    assert [i for i in check(Pipeline.model_validate(regression_pipeline()), LIBRARY, NUMERIC) if i.severity == "error"] == []
    wrong = regression_pipeline()
    wrong["nodes"][3] = {"id": "ridge", "snippet": "model.logistic_regression", "y": 300}  # type: ignore[index]
    wrong["nodes"][2]["params"] = {"method": "zscore"}  # type: ignore[index]
    messages = [i.message for i in check(Pipeline.model_validate(wrong), LIBRARY, NUMERIC)]
    assert any("classification target" in m for m in messages)
    assert any("'method' must be one of" in m for m in messages)
    no_split = regression_pipeline(nodes=[{"id": "m", "snippet": "model.ridge"}], edges=[])
    infos = [i.message for i in check(Pipeline.model_validate(no_split), LIBRARY, NUMERIC) if i.severity == "info"]
    assert any("model-ready features" in m for m in infos)


def test_unresolved_names_follow_source_order_and_scopes() -> None:
    cells = ["x = 1", "y = x + z", "def f(a):\n    local = a + w\n    return local", "[i for i in range(3)]",
             "if True:\n    q = 1\n    print(q)", "k += 1", "class A:\n    b = 1\n    c = b"]  # fmt: skip
    assert unresolved_names(cells) == [set(), {"z"}, {"w"}, set(), set(), {"k"}, set()]


@pytest.mark.parametrize(
    ("code", "problem"),
    [
        ("scaled = features.copy()", None),
        ("import numpy as np\nscaled = np.asarray(features)", None),
        ("import os\nos.remove('x')", "import of 'os'"),
        ("data = open('secrets').read()", "'open'"),
        ("features.to_csv('leak.csv')", "'.to_csv'"),
        ("x = ().__class__", "dunder"),
        ("x = (", "not valid Python"),
        ("\n".join(f"v{i} = {i}" for i in range(25)), "more than 20 lines"),
    ],
)
def test_glue_validation(code: str, problem: str | None) -> None:
    result = validate_glue(code)
    assert (result is None) if problem is None else (result is not None and problem in result)


def test_connect_inserts_only_valid_glue_before_the_right_cell() -> None:
    cells = [Cell("Setup", "import pandas as pd\nSEED = 1"), Cell("load", "features = pd.DataFrame({'a': [1, 2]})", node="n1"),
             Cell("use", "print(scaled.shape)", node="n2")]  # fmt: skip
    client = GlueClient({"glue": [
        {"before_cell": 2, "code": "scaled = features.astype(float)", "why": "the next cell expects scaled"},
        {"before_cell": 2, "code": "import subprocess\nsubprocess.run(['ls'])", "why": "bad"},
        {"before_cell": 99, "code": "x = 1", "why": "out of range"},
    ], "notes": "renamed features"})  # fmt: skip
    merged, notes, tokens = connect(cells, NUMERIC, "y", client)
    assert [c.title for c in merged] == ["Setup", "load", "Glue: the next cell expects scaled", "use"]
    assert merged[2].glue and tokens == 120
    assert any("subprocess" in n for n in notes) and any("invalid position" in n for n in notes)
    assert "reads undefined: scaled" in client.prompts[0] and "rows" not in client.prompts[0].split("CELLS:")[1][:0]
    assert unresolved_names([c.code for c in merged]) == [set(), set(), set(), set()]


def test_finalize_is_deterministic_without_gaps(tmp_path: Path) -> None:
    client = GlueClient({"glue": []})
    result = finalize(Pipeline.model_validate(regression_pipeline()), LIBRARY, NUMERIC, output_dir=tmp_path, client=client)
    assert result.ok and not result.llm_used and client.prompts == []  # no gaps: zero tokens
    assert [c.node for c in result.cells] == [None, "load", "split", "scale", None, "ridge", "metrics"]
    assert result.cells[4].auto and result.cells[4].snippet == "prep.ensure_numeric"
    assert "no glue was needed" in result.notes and result.script and "{node:ridge}" in result.script


# ------------------------------------------------------------------------------- API
@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    root = tmp_path / "project"
    root.mkdir()
    shutil.copy(FIXTURES / "clean_numeric.csv", root / "clean_numeric.csv")
    app = create_app(root, TOKEN, watch=False, static_dir=None, recents_path=tmp_path / "recent.json",
                     llm_client_factory=lambda _: GlueClient({"glue": [], "notes": "nothing to add"}))  # fmt: skip
    with TestClient(app, base_url="http://127.0.0.1:8765", headers={"X-FlowLab-Token": TOKEN}) as test_client:
        yield test_client


def test_build_api_create_finalize_and_run_in_a_kernel(client: TestClient) -> None:
    catalogue_payload = client.get("/api/build/catalogue").json()
    assert len(catalogue_payload["purposes"]) == 11 and catalogue_payload["llm_configured"] is True
    assert client.get("/api/build/datasets").json() == ["clean_numeric.csv"]
    columns = client.get("/api/build/dataset", params={"file": "clean_numeric.csv"}).json()["columns"]
    assert {c["name"]: c["task"] for c in columns}["y"] == "regression"

    created = client.post("/api/build/pipeline/new", json={"name": "Numeric regression", "dataset": "clean_numeric.csv"}).json()
    file = created["file"]
    assert file == "pipelines/numeric_regression.pipeline.json" and created["pipeline"]["nodes"][0]["snippet"] == "load.csv"
    pipeline = regression_pipeline(name="Numeric regression")
    assert client.put("/api/build/pipeline", json={"file": file, "pipeline": pipeline}).status_code == 200
    assert client.get("/api/build/pipelines").json() == [{"file": file, "name": "Numeric regression", "nodes": 5}]
    assert client.post("/api/build/check", json={"pipeline": pipeline}).json()["order"] == ["load", "split", "scale", "ridge", "metrics"]

    refused = client.post("/api/build/finalize", json={"file": file, "pipeline": pipeline, "use_llm": True})
    assert refused.status_code == 428
    final = client.post("/api/build/finalize", json={"file": file, "pipeline": pipeline}).json()
    assert final["ok"] and final["script_file"] == "pipelines/numeric_regression.py"
    blocks = final["blocks"]
    assert {v["node"] for v in blocks.values() if v["kind"] == "node"} == {"load", "split", "scale", "ridge", "metrics"}
    assert any(v["kind"] == "auto" for v in blocks.values()) and blocks["b1"]["kind"] == "setup"

    started = client.post("/api/build/run", json={"script_file": final["script_file"]}).json()
    assert started["plan"] == sorted(blocks, key=lambda b: int(b[1:]))
    state: dict[str, object] = {}
    for _ in range(120):
        state = client.get("/api/state", params={"file": final["script_file"]}).json()
        nodes = state["nodes"]  # type: ignore[index]
        if all(n["state"] in ("success", "error") for n in nodes.values()) and state["kernel"]["status"] == "idle":  # type: ignore[index]
            break
        time.sleep(0.5)
    nodes = state["nodes"]  # type: ignore[index]
    assert all(n["state"] == "success" for n in nodes.values()), {k: v["state"] for k, v in nodes.items()}
    ridge_block = next(b for b, v in blocks.items() if v["node"] == "ridge")
    assert "Ridge" in nodes[ridge_block]["values"]["model"]["text"]
    client.post("/api/kernel/stop", json={"file": final["script_file"]})
