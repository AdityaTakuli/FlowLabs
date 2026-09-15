"""Repo tracing (PRD II 7, 14): fixture repos with known dataflow, partial and failed traces."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from flowlab_lab.project import LabProject
from flowlab_lab.trace import compare_traces, trace_project

FILES = {
    "pipeline/__init__.py": "",
    "pipeline/load.py": "import pandas as pd\n\n\ndef load(path):\n    return pd.read_csv(path)\n",
    "pipeline/clean.py": (
        "def clean(frame):\n    frame = frame.dropna()\n    return frame[frame['value'] > 0]\n"
    ),
    "pipeline/model.py": (
        "from sklearn.linear_model import LinearRegression\n\n\n"
        "def fit(frame):\n"
        "    model = LinearRegression()\n"
        "    model.fit(frame[['value']], frame['target'])\n"
        "    return model\n"
    ),
    "train.py": (
        "import argparse\n"
        "from pipeline.load import load\n"
        "from pipeline.clean import clean\n"
        "from pipeline.model import fit\n"
        "\n"
        "parser = argparse.ArgumentParser()\n"
        "parser.add_argument('--config', default='dev')\n"
        "config = parser.parse_args().config\n"
        "df = load('data.csv')\n"
        "if config == 'prod':\n"
        "    df = df.sample(frac=1.0, random_state=0)\n"
        "model = fit(clean(df))\n"
        "print('coef', round(float(model.coef_[0]), 2))\n"
    ),
    "data.csv": "value,target\n1,2\n2,4\n,5\n3,6\n-1,0\n4,8\n",
}


@pytest.fixture
def repo(tmp_path: Path) -> LabProject:
    for name, text in FILES.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return LabProject(tmp_path)


def site_edges(graph) -> set[tuple[str, str, str]]:  # type: ignore[no-untyped-def]
    def where(node_id: str) -> str:
        node = graph.node(node_id)
        return f"{node.file}:{node.lines[0]}"

    return {(where(e.from_), where(e.to), e.variable) for e in graph.edges}


def test_trace_follows_objects_across_modules(repo: LabProject) -> None:
    graph = trace_project(repo, "python train.py --config dev", timeout_s=120)
    edges = site_edges(graph)
    assert ("pipeline/load.py:5", "pipeline/clean.py:2", "DataFrame") in edges
    assert ("pipeline/clean.py:2", "pipeline/clean.py:3", "DataFrame") in edges
    assert ("pipeline/clean.py:3", "pipeline/model.py:6", "DataFrame") in edges
    labels = {f"{n.file}:{n.lines[0]}": n.label for n in graph.nodes}
    assert labels["pipeline/load.py:5"].startswith("read_csv")
    assert graph.source.kind == "repo_trace" and graph.source.trace_command == "python train.py --config dev"
    assert graph.source.traced_at and not graph.partial
    scope = next(w for w in graph.warnings if w.code == "TRACE_SCOPE")
    assert "one execution with one configuration" in scope.message
    assert {g.label for g in graph.groups} >= {"clean (pipeline/clean.py)", "fit (pipeline/model.py)"}
    assert all(
        not f.path.startswith(("/", "..")) and "site-packages" not in f.path for f in graph.source.files
    )
    assert (repo.state_dir / "traces").glob("*.graph.json")


def test_different_configurations_produce_comparable_traces(repo: LabProject) -> None:
    dev = trace_project(repo, ["python", "train.py", "--config", "dev"], timeout_s=120)
    prod = trace_project(repo, ["python", "train.py", "--config", "prod"], timeout_s=120)
    difference = compare_traces(dev, prod)
    assert difference["nodes_only_in_b"] == ["train.py:11"]
    assert "pipeline/load.py:5 -> train.py:11 [DataFrame]" in difference["edges_only_in_b"]
    assert difference["nodes_only_in_a"] == []


def test_timeouts_keep_a_partial_graph(repo: LabProject) -> None:
    (repo.root / "slow.py").write_text(
        "import time\nimport pandas as pd\nframe = pd.DataFrame({'a': [1, 2]})\ncopy = frame.copy()\ntime.sleep(60)\n"
    )
    started = time.perf_counter()
    graph = trace_project(repo, "python slow.py", timeout_s=3)
    assert time.perf_counter() - started < 30
    assert graph.partial and any(w.code == "TRACE_PARTIAL" for w in graph.warnings)
    assert any(n.file == "slow.py" and n.lines[0] == 4 for n in graph.nodes)


def test_failing_runs_and_hot_loops(repo: LabProject) -> None:
    (repo.root / "loop.py").write_text(
        "import pandas as pd\nframe = pd.DataFrame({'a': [1]})\nfor _ in range(300):\n    frame = frame.copy()\n"
        "raise RuntimeError('boom')\n"
    )
    graph = trace_project(repo, "python loop.py", timeout_s=120, max_per_site=20)
    failure = next(w for w in graph.warnings if w.code == "TRACE_FAILED")
    assert "RuntimeError: boom" in failure.message
    hot = next(n for n in graph.nodes if n.file == "loop.py" and n.lines[0] == 4)
    assert "sampled" in hot.flags
