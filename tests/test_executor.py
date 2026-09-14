"""End-to-end execution tests, including the Phase 0 Definition of Done."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import polars as pl
import pytest
from click.testing import CliRunner
from flowlab_engine import compile_flow, execute_plan, load_schemas, resolve_dataset_paths
from flowlab_engine.artifacts import check_value
from flowlab_engine.cli import main
from flowlab_nodes import NodeRuntimeError, infer_table_schema
from flowspec import FlowSpec, PortSchema
from helpers import EXAMPLES, FIXTURES, ROOT, load_example


def _run(
    example: str, tmp: Path, cache: Path | None = None, data_dir: Path = FIXTURES, run_id: str | None = None
):  # type: ignore[no-untyped-def]
    spec = FlowSpec.model_validate(load_example(example))
    paths, errors = resolve_dataset_paths(spec, data_dir)
    assert not errors
    result = compile_flow(spec, load_schemas(paths))
    assert result.ok and result.plan, result.errors
    return execute_plan(result.plan, paths, runs_dir=tmp / "runs", cache_dir=cache, run_id=run_id)


def test_phase0_dod_churn_flow_writes_parquet_metrics_and_chart(tmp_path: Path) -> None:
    run = _run("churn_flow.json", tmp_path)
    assert run.status == "completed", run.error
    assert len(run.nodes) == 7 and all(n.status == "success" for n in run.nodes)

    (export,) = run.exports
    predictions = pl.read_parquet(export["path"])
    assert predictions.height == 400 and {"prediction", "probability"} <= set(predictions.columns)

    metrics = json.loads((run.run_dir / "nodes/n6/metrics.json").read_text())
    assert 0.5 < metrics["accuracy"] <= 1 and metrics["roc_auc"] > 0.6

    chart = json.loads((run.run_dir / "nodes/n6/chart.json").read_text())
    assert chart["spec"]["$schema"] == "https://vega.github.io/schema/vega-lite/v5.json"
    assert chart["narration"] and chart["narration_basis"]

    events = [json.loads(line) for line in (run.run_dir / "events.jsonl").read_text().splitlines()]
    assert events[0]["type"] == "run_started" and events[-1]["type"] == "run_completed"
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    manifest = json.loads((run.run_dir / "run.json").read_text())
    assert manifest["status"] == "completed" and manifest["runner_version"]


def test_phase0_dod_leaky_flow_fails_naming_the_node() -> None:
    spec = FlowSpec.model_validate(load_example("leaky_flow.json"))
    paths, _ = resolve_dataset_paths(spec, FIXTURES)
    result = compile_flow(spec, load_schemas(paths))
    assert not result.ok
    (err,) = result.errors
    assert err.code == "LEAKAGE_FIT_BEFORE_SPLIT" and err.node_id == "scale"
    assert "Standardise everything" in err.message


@pytest.mark.parametrize("example", ["churn_flow.json", "churn_full_flow.json"])
def test_phase0_dod_rerun_produces_identical_hashes(tmp_path: Path, example: str) -> None:
    first = _run(example, tmp_path, run_id="a")
    second = _run(example, tmp_path, run_id="b")
    assert first.status == second.status == "completed"
    assert first.output_hashes() == second.output_hashes()
    assert all(h for n in first.nodes for h in n.output_hashes.values())


def test_cached_rerun_hits_cache_with_identical_hashes(tmp_path: Path) -> None:
    cache = tmp_path / "cache"
    cold = _run("churn_flow.json", tmp_path, cache=cache, run_id="cold")
    warm = _run("churn_flow.json", tmp_path, cache=cache, run_id="warm")
    assert [n.status for n in warm.nodes] == ["cached"] * 6 + ["success"]
    assert cold.output_hashes() == warm.output_hashes()
    assert (warm.run_dir / "nodes/n5/model.joblib").is_file()
    assert Path(warm.exports[0]["path"]).is_file()


def test_full_flow_outputs(tmp_path: Path) -> None:
    run = _run("churn_full_flow.json", tmp_path)
    assert run.status == "completed", run.error
    for node, port in [
        ("missing", "chart"),
        ("tenure_hist", "out"),
        ("charges_hist", "out"),
        ("eval", "chart"),
    ]:
        chart = json.loads((run.run_dir / f"nodes/{node}/{port}.json").read_text())
        assert chart["narration"]
    assert sorted(Path(e["path"]).name for e in run.exports) == ["churn_test.csv", "churn_train.csv"]


def test_dataset_changed_after_compile_fails_the_run(tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    shutil.copy(FIXTURES / "churn.csv", data / "churn.csv")
    spec = FlowSpec.model_validate(load_example("churn_flow.json"))
    paths, _ = resolve_dataset_paths(spec, data)
    result = compile_flow(spec, load_schemas(paths))
    assert result.plan
    df = pl.read_csv(data / "churn.csv")
    df.head(1500).write_csv(data / "churn.csv")
    run = execute_plan(result.plan, paths, runs_dir=tmp_path / "runs")
    assert run.status == "failed" and run.error and run.error["code"] == "DATASET_CHANGED"
    assert [n.status for n in run.nodes] == ["failed"] + ["skipped"] * 6
    last = json.loads((run.run_dir / "events.jsonl").read_text().splitlines()[-1])
    assert last["type"] == "run_failed"


def test_schema_drift_is_detected() -> None:
    df = pl.DataFrame({"a": [1, 2]})
    schema = PortSchema.of_table(infer_table_schema(df))
    with pytest.raises(NodeRuntimeError) as err:
        check_value("out", schema, df.with_columns(pl.col("a").cast(pl.Float64)))
    assert err.value.code == "SCHEMA_DRIFT"


# ------------------------------------------------------------------------------------ CLI


def test_cli_run_compile_and_catalogue(tmp_path: Path) -> None:
    runner = CliRunner()
    ok = runner.invoke(
        main,
        [
            "run",
            str(EXAMPLES / "churn_flow.json"),
            "--data",
            str(FIXTURES),
            "--runs-dir",
            str(tmp_path / "runs"),
            "--no-cache",
        ],
    )
    assert ok.exit_code == 0, ok.output
    assert "[7/7] n7" in ok.output and "Run completed" in ok.output

    leaky = runner.invoke(
        main,
        [
            "run",
            str(EXAMPLES / "leaky_flow.json"),
            "--data",
            str(FIXTURES),
            "--runs-dir",
            str(tmp_path / "runs"),
        ],
    )
    assert leaky.exit_code == 1 and "LEAKAGE_FIT_BEFORE_SPLIT: [scale]" in leaky.output

    compiled = runner.invoke(
        main, ["compile", str(EXAMPLES / "leaky_flow.json"), "--data", str(FIXTURES), "--json"]
    )
    assert compiled.exit_code == 1
    assert json.loads(compiled.output)["errors"][0]["node_id"] == "scale"

    cat = runner.invoke(main, ["catalogue"])
    assert cat.output == (ROOT / "packages/nodes/nodes.schema.json").read_text()

    missing = runner.invoke(main, ["run", str(EXAMPLES / "churn_flow.json"), "--data", str(tmp_path)])
    assert missing.exit_code == 1 and "DATASET_NOT_FOUND" in missing.output
