"""Flow → Code eject (PRD II 3.1): readable, runnable, faithful to the engine, analysable by Code Mode."""

from __future__ import annotations

import json
import runpy
from pathlib import Path
from typing import Any

import nbformat
import pytest
from flowlab_engine import compile_flow, execute_plan, load_schemas, resolve_dataset_paths
from flowlab_lab import analyse_text
from flowlab_lab.eject import EjectError, eject_flow, eject_plan
from flowlab_lab.kernel import LabSession
from flowlab_lab.project import LabProject
from flowspec import FlowSpec
from helpers import EXAMPLES, FIXTURES


def spec(name: str) -> FlowSpec:
    return FlowSpec.model_validate_json((EXAMPLES / name).read_text())


def run_script(text: str, directory: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    path = directory / "ejected.py"
    path.write_text(text)
    monkeypatch.chdir(directory)
    return runpy.run_path(str(path), run_name="__main__")


def engine_metrics(flow: FlowSpec, tmp_path: Path) -> dict[str, Any]:
    paths, _ = resolve_dataset_paths(flow, FIXTURES)
    plan = compile_flow(flow, load_schemas(paths)).plan
    assert plan is not None
    run = execute_plan(plan, paths, runs_dir=tmp_path / "runs")
    evaluate = next(s.node_id for s in plan.steps if s.node_type == "model.evaluate")
    return json.loads((run.run_dir / "nodes" / evaluate / "metrics.json").read_text())


def test_ejected_script_reproduces_engine_metrics(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    flow = spec("churn_flow.json")
    namespace = run_script(eject_flow(flow, FIXTURES, fmt="py"), tmp_path, monkeypatch)
    engine = engine_metrics(flow, tmp_path)
    ejected = namespace["n6_metrics"]
    for key in ("accuracy", "balanced_accuracy", "precision", "recall", "f1", "roc_auc"):
        assert ejected[key] == pytest.approx(engine[key], abs=1e-6), key
    assert namespace["n6_predictions"].shape[0] == 400
    assert (tmp_path / "flowlab_outputs" / "churn_test_predictions.parquet").is_file()


def test_every_phase0_node_type_ejects_and_runs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    flow = spec("churn_full_flow.json")
    text = eject_flow(flow, FIXTURES, fmt="py")
    assert {n.type for n in flow.nodes} >= {
        "profile.overview", "profile.missingness", "viz.distribution", "clean.drop_columns", "prep.scale", "sink.export"
    }  # fmt: skip
    namespace = run_script(text, tmp_path, monkeypatch)
    assert namespace["eval_metrics"]["accuracy"] == pytest.approx(
        engine_metrics(flow, tmp_path)["accuracy"], abs=1e-6
    )
    outputs = tmp_path / "flowlab_outputs"
    assert (outputs / "prepared" / "churn_train.csv").is_file() and (
        outputs / "tenure_hist_tenure_months.png"
    ).is_file()


def test_ejected_code_graph_mirrors_the_flow() -> None:
    flow = spec("churn_flow.json")
    graph = analyse_text("ejected.py", eject_flow(flow, FIXTURES, fmt="py"))
    blocks = [n.id for n in graph.code_nodes()]
    assert len(blocks) == len(flow.nodes) + 1  # setup cell + one cell per node
    block_of = {node.id: blocks[i + 1] for i, node in enumerate(flow.nodes)}
    code_edges = {(e.from_, e.to) for e in graph.edges}
    for edge in flow.edges:
        assert (block_of[edge.source], block_of[edge.target]) in code_edges, edge
    assert not [w for w in graph.warnings if w.severity == "error"]


def test_ejected_notebook_is_valid_and_runs_in_code_mode(tmp_path: Path) -> None:
    notebook = eject_flow(spec("churn_flow.json"), FIXTURES, fmt="ipynb")
    nbformat.validate(nbformat.reads(notebook, as_version=4))
    cells = json.loads(notebook)["cells"]
    assert cells[0]["cell_type"] == "markdown" and "FlowLab will not re-import" in "".join(cells[0]["source"])
    (tmp_path / "churn.ipynb").write_text(notebook)
    with LabSession(LabProject(tmp_path), "churn.ipynb", timeout_s=120) as session:
        records = session.execute(None, mode="all")
        assert [r.status for r in records] == ["success"] * 8
        producer = next(n.id for n in session.graph.code_nodes() if "n6_predictions" in n.defines)
        assert session.inspect(producer, "n6_predictions")["rows"] == 400  # type: ignore[index]


def test_unsupported_node_types_are_refused() -> None:
    flow = spec("churn_flow.json")
    paths, _ = resolve_dataset_paths(flow, FIXTURES)
    plan = compile_flow(flow, load_schemas(paths)).plan
    assert plan is not None
    plan.steps[1].node_type = "stat.ttest"
    with pytest.raises(EjectError, match="no code template for node types: stat.ttest"):
        eject_plan(plan, paths)
