"""Unit tests for every Phase 0 node: happy paths, edge cases and param/schema validation."""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import numpy as np
import polars as pl
import pytest
from flowlab_nodes import (
    CompileContext,
    ExecContext,
    NodeCompileError,
    NodeRuntimeError,
    SplitTables,
    all_nodes,
    catalogue_json,
    get_node,
    infer_table_schema,
    table_hash,
)
from flowlab_nodes.narration import ungrounded_numbers
from flowspec import PortSchema, PortType
from helpers import ROOT, propagate, run_node, split_frame, table_port
from pydantic import ValidationError


def split_port(train: pl.DataFrame, test: pl.DataFrame, **source: object) -> tuple[SplitTables, PortSchema]:
    whole = table_port(pl.concat([train, test]), **source)
    ps = PortSchema.of_split(whole.require_table(), ["train", "test"], None)
    return SplitTables({"train": train, "test": test}), ps


def assert_grounded(chart: dict[str, object]) -> None:
    assert ungrounded_numbers(chart["narration"], chart["narration_basis"]) == []  # type: ignore[arg-type]
    assert chart["spec"]["$schema"].startswith("https://vega.github.io/schema/vega-lite/")  # type: ignore[index]


# ------------------------------------------------------------------------------ catalogue


def test_catalogue_has_the_phase0_nodes() -> None:
    assert {n.type for n in all_nodes()} == {
        "source.dataset",
        "profile.overview",
        "profile.missingness",
        "clean.impute",
        "clean.drop_columns",
        "prep.split",
        "prep.encode",
        "prep.scale",
        "model.fit",
        "model.evaluate",
        "viz.distribution",
        "sink.export",
    }


@pytest.mark.parametrize("node", all_nodes(), ids=lambda n: n.type)
def test_every_node_is_documented_and_schema_described(node: object) -> None:
    assert len(node.doc()) > 40  # type: ignore[attr-defined]
    schema = node.Params.model_json_schema()  # type: ignore[attr-defined]
    assert schema["type"] == "object"
    assert all(p.types for p in node.inputs.values())  # type: ignore[attr-defined]


def test_committed_catalogue_schema_has_not_drifted() -> None:
    committed = (ROOT / "packages/nodes/nodes.schema.json").read_text()
    assert committed == catalogue_json(), "run `make catalogue` and commit nodes.schema.json"


# ----------------------------------------------------------------------------- source


def test_source_applies_target_and_overrides(tmp_path: Path) -> None:
    df = pl.DataFrame(
        {"id": list(range(60)), "grade": [i % 3 for i in range(60)], "y": [i % 2 == 0 for i in range(60)]}
    )
    path = tmp_path / "d.csv"
    df.write_csv(path)
    schema = infer_table_schema(df, content_hash=table_hash(pl.read_csv(path, try_parse_dates=True)))
    impl = get_node("source.dataset")
    assert impl
    params = impl.parse_params(
        {
            "dataset_ref": "d",
            "target": "y",
            "semantic_overrides": {"grade": "categorical_ordinal"},
            "role_overrides": {"id": "ignore"},
        }
    )
    out = impl.propagate(params, {}, CompileContext("s", 0, {"d": "d"}, {"d": schema}))["out"].require_table()
    assert out.column("y").role == "target"  # type: ignore[union-attr]
    assert out.column("grade").semantic == "categorical_ordinal"  # type: ignore[union-attr]
    assert out.column("id").role == "ignore"  # type: ignore[union-attr]

    ctx = ExecContext("s", 0, {}, {}, {"d": path}, {"d": schema.content_hash or ""}, tmp_path)
    assert impl.execute(params, {}, ctx)["out"].shape == (60, 3)
    stale = ExecContext("s", 0, {}, {}, {"d": path}, {"d": "sha256:stale"}, tmp_path)
    with pytest.raises(NodeRuntimeError) as err:
        impl.execute(params, {}, stale)
    assert err.value.code == "DATASET_CHANGED"


def test_source_errors() -> None:
    df = pl.DataFrame({"a": [1, 2]})
    with pytest.raises(NodeCompileError) as err:
        table_port(df, target="nope")
    assert err.value.code == "COLUMN_NOT_FOUND"
    impl = get_node("source.dataset")
    assert impl
    with pytest.raises(NodeCompileError) as err:
        impl.propagate(impl.parse_params({"dataset_ref": "x"}), {}, CompileContext("s", 0, {}, {}))
    assert err.value.code == "UNBOUND_DATASET"


# ---------------------------------------------------------------------------- profile


def test_overview_and_empty_table() -> None:
    df = pl.DataFrame({"a": [1, None, 3], "b": ["x", "y", "y"]})
    run = run_node("profile.overview", {"head_rows": 2}, {"in": df}, {"in": table_port(df)})
    m = run.outputs["out"]
    assert m["row_count"] == 3 and len(m["head"]) == 2
    assert m["columns"][0] == {"name": "a", "dtype": "int64", "null_count": 1, "n_unique": 2}
    empty = df.clear()
    assert (
        run_node("profile.overview", {}, {"in": empty}, {"in": table_port(empty)}).outputs["out"]["row_count"]
        == 0
    )


def test_missingness_metrics_and_narration() -> None:
    df = pl.DataFrame({"a": [1, None, 3, None], "b": ["x", None, "y", "z"], "c": [1, 2, 3, 4]})
    run = run_node("profile.missingness", {}, {"in": df}, {"in": table_port(df)})
    metrics, chart = run.outputs["metrics"], run.outputs["chart"]
    assert metrics["rows_with_any_null"] == 2
    assert metrics["missingness_correlation"]["columns"] == ["a", "b"]
    assert chart["narration"].startswith("2 of 3 columns contain missing values. `a` has the most, at 50%")
    assert_grounded(chart)
    clean = pl.DataFrame({"c": [1, 2]})
    assert (
        "No missing values"
        in run_node("profile.missingness", {}, {"in": clean}, {"in": table_port(clean)}).outputs["chart"][
            "narration"
        ]
    )


# ------------------------------------------------------------------------- drop_columns


def test_drop_columns_by_name_and_rule() -> None:
    df = pl.DataFrame({"a": [1, None, None, 4], "b": [1, 1, 1, 1], "c": [1, 2, 3, 4]})
    port = table_port(df)
    with pytest.raises(NodeCompileError) as err:
        propagate(
            "clean.drop_columns", {"columns": ["c"], "null_frac_gt": 0.4, "cardinality_eq": 1}, {"in": port}
        )
    assert err.value.code == "EMPTY_SCHEMA"
    run = run_node("clean.drop_columns", {"null_frac_gt": 0.4}, {"in": df}, {"in": port})
    assert run.outputs["out"].columns == ["b", "c"]
    with pytest.raises(ValidationError):
        propagate("clean.drop_columns", {}, {"in": port})


def test_drop_columns_on_split() -> None:
    value, ps = split_port(pl.DataFrame({"a": [1, 2], "b": [3, 4]}), pl.DataFrame({"a": [5], "b": [6]}))
    run = run_node("clean.drop_columns", {"columns": ["a"]}, {"in": value}, {"in": ps})
    assert [df.columns for df in run.outputs["out"].parts.values()] == [["b"], ["b"]]


# ------------------------------------------------------------------------------ impute


def test_median_impute_fits_on_train_only() -> None:
    train = pl.DataFrame({"x": [1.0, 2.0, 3.0, None]})
    test = pl.DataFrame({"x": [1000.0, None]})
    value, ps = split_port(train, test)
    run = run_node("clean.impute", {"strategy": "median"}, {"in": value}, {"in": ps})
    assert run.outputs["out"].parts["test"]["x"].to_list() == [1000.0, 2.0]
    assert run.schemas["out"].require_table().column("x").nullable is False  # type: ignore[union-attr]


def test_impute_int_mean_becomes_float_and_mode_keeps_dtype() -> None:
    df = pl.DataFrame({"n": [1, None, 2], "s": ["a", None, "a"]})
    run = run_node("clean.impute", {"columns": ["n"], "strategy": "mean"}, {"in": df}, {"in": table_port(df)})
    assert run.outputs["out"]["n"].to_list() == [1.0, 1.5, 2.0]
    run = run_node("clean.impute", {"columns": ["s"], "strategy": "mode"}, {"in": df}, {"in": table_port(df)})
    assert run.outputs["out"]["s"].to_list() == ["a", "a", "a"]


def test_constant_and_ffill() -> None:
    df = pl.DataFrame({"n": [1, None, 3], "s": [None, "b", None]})
    run = run_node(
        "clean.impute",
        {"columns": ["n"], "strategy": "constant", "fill_value": 0},
        {"in": df},
        {"in": table_port(df)},
    )
    assert run.outputs["out"]["n"].to_list() == [1, 0, 3] and run.outputs["out"]["n"].dtype == pl.Int64
    run = run_node("clean.impute", {"strategy": "ffill"}, {"in": df}, {"in": table_port(df)})
    assert run.outputs["out"]["s"].to_list() == [None, "b", "b"]


@pytest.mark.parametrize("strategy", ["knn", "iterative"])
def test_model_based_imputers(strategy: str) -> None:
    rng = np.random.default_rng(0)
    a = rng.normal(size=50)
    b = a * 2 + rng.normal(scale=0.1, size=50)
    df = pl.DataFrame({"a": a, "b": [None if i % 7 == 0 else v for i, v in enumerate(b)]})
    first = run_node("clean.impute", {"strategy": strategy}, {"in": df}, {"in": table_port(df)})
    second = run_node("clean.impute", {"strategy": strategy}, {"in": df}, {"in": table_port(df)})
    assert first.outputs["out"]["b"].null_count() == 0
    assert first.outputs["out"].equals(second.outputs["out"])


def test_impute_edge_cases_and_errors() -> None:
    df = pl.DataFrame({"x": pl.Series([None, None], dtype=pl.Float64), "s": ["a", None]})
    run = run_node(
        "clean.impute", {"columns": ["x"], "strategy": "median"}, {"in": df}, {"in": table_port(df)}
    )
    assert "ALL_NULL_COLUMN" in run.compile_warnings and "ALL_NULL_IN_FIT" in run.runtime_warnings
    with pytest.raises(NodeCompileError) as err:
        propagate("clean.impute", {"columns": ["s"], "strategy": "mean"}, {"in": table_port(df)})
    assert err.value.code == "SCHEMA_MISMATCH"
    with pytest.raises(NodeCompileError) as err:
        propagate(
            "clean.impute",
            {"columns": ["x"], "strategy": "constant", "fill_value": "zero"},
            {"in": table_port(df)},
        )
    assert err.value.code == "SCHEMA_MISMATCH"
    with pytest.raises(ValidationError):
        propagate("clean.impute", {"strategy": "constant"}, {"in": table_port(df)})


# ------------------------------------------------------------------------------- split


def _frame(n: int = 100) -> pl.DataFrame:
    return pl.DataFrame(
        {
            "i": list(range(n)),
            "y": [i % 4 == 0 for i in range(n)],
            "g": [i // 5 for i in range(n)],
            "day": [dt.date(2026, 1, 1) + dt.timedelta(days=(i * 37) % n) for i in range(n)],
        }
    )


def test_stratified_split_sizes_and_balance() -> None:
    value, ps = split_frame(_frame(), test_size=0.2, stratify_by="y", seed=1)
    assert ps.partition_rows == {"train": 80, "test": 20}
    assert value.parts["test"].height == 20 and value.parts["test"]["y"].sum() == 5
    assert value.parts["train"]["i"].is_sorted()


def test_split_is_seed_deterministic() -> None:
    a, _ = split_frame(_frame(), seed=3)
    b, _ = split_frame(_frame(), seed=3)
    c, _ = split_frame(_frame(), seed=4)
    assert a.parts["test"].equals(b.parts["test"])
    assert not a.parts["test"].equals(c.parts["test"])


def test_time_based_group_and_val_splits() -> None:
    value, _ = split_frame(_frame(), time_based=True, time_column="day")
    assert value.parts["test"]["day"].min() > value.parts["train"]["day"].max()
    value, _ = split_frame(_frame(), group_by="g", seed=0)
    assert not set(value.parts["train"]["g"]) & set(value.parts["test"]["g"])
    value, ps = split_frame(_frame(), test_size=0.2, val_size=0.2)
    assert list(value.parts) == ["train", "val", "test"] and ps.partitions == ["train", "val", "test"]
    assert [df.height for df in value.parts.values()] == [60, 20, 20]


def test_split_edge_cases() -> None:
    one = _frame(1)
    with pytest.raises(NodeCompileError) as err:
        split_frame(one)
    assert err.value.code == "SPLIT_TOO_SMALL"
    with pytest.raises(NodeCompileError) as err:
        propagate("prep.split", {"stratify_by": "i"}, {"in": table_port(_frame())})
    assert err.value.code == "SCHEMA_MISMATCH"
    dupes = pl.DataFrame({"a": [1] * 40})
    run = run_node("prep.split", {}, {"in": dupes}, {"in": table_port(dupes)})
    assert "DUPLICATES_ACROSS_SPLITS" in run.runtime_warnings
    with pytest.raises(ValidationError):
        propagate("prep.split", {"test_size": 0.6, "val_size": 0.5}, {"in": table_port(dupes)})


# ------------------------------------------------------------------------------ encode

TRAIN = pl.DataFrame({"plan": ["a", "b", "a"], "y": [True, True, False]})
TEST = pl.DataFrame({"plan": ["c", "a"], "y": [False, True]})


def test_onehot_uses_train_vocabulary_and_profile_categories() -> None:
    value, ps = split_port(TRAIN, TEST, target="y")
    run = run_node("prep.encode", {"method": "onehot"}, {"in": value}, {"in": ps})
    test = run.outputs["out"].parts["test"]
    assert test.columns == ["plan=a", "plan=b", "plan=c", "y"]
    assert test.row(0) == (0, 0, 0, False)  # 'c' never seen in train
    assert test.row(1) == (1, 0, 0, True)


def test_ordinal_frequency_target_binary() -> None:
    value, ps = split_port(TRAIN, TEST, target="y")
    out = run_node("prep.encode", {"method": "ordinal"}, {"in": value}, {"in": ps}).outputs["out"]
    assert out.parts["test"]["plan"].to_list() == [-1, 0]
    out = run_node("prep.encode", {"method": "frequency"}, {"in": value}, {"in": ps}).outputs["out"]
    assert out.parts["test"]["plan"].to_list() == [0.0, pytest.approx(2 / 3)]
    out = run_node("prep.encode", {"method": "target", "smoothing": 0}, {"in": value}, {"in": ps}).outputs[
        "out"
    ]
    assert out.parts["train"]["plan"].to_list() == [0.5, 1.0, 0.5]
    assert out.parts["test"]["plan"].to_list() == [pytest.approx(2 / 3), 0.5]
    out = run_node("prep.encode", {"method": "binary"}, {"in": value}, {"in": ps}).outputs["out"]
    assert out.parts["train"].columns == ["plan_bin0", "plan_bin1", "y"]
    assert out.parts["train"].row(1)[:2] == (0, 1)  # 'b' -> code 2 -> bits 0,1


def test_encode_errors() -> None:
    value, ps = split_port(TRAIN, TEST, target="y")
    with pytest.raises(NodeCompileError) as err:
        propagate("prep.encode", {"columns": ["y"]}, {"in": ps})
    assert err.value.code == "ENCODE_TARGET"
    floats = table_port(pl.DataFrame({"f": [i * 0.5 for i in range(60)]}))
    with pytest.raises(NodeCompileError) as err:
        propagate("prep.encode", {"columns": ["f"]}, {"in": floats})
    assert err.value.code == "SCHEMA_MISMATCH"
    many = table_port(pl.DataFrame({"s": [f"v{i % 55}" for i in range(110)]}))
    with pytest.raises(NodeCompileError) as err:
        propagate("prep.encode", {"columns": ["s"], "method": "onehot"}, {"in": many})
    assert err.value.code == "HIGH_CARDINALITY"
    propagate("prep.encode", {"columns": ["s"], "method": "frequency"}, {"in": many})


# ------------------------------------------------------------------------------- scale


def test_standard_scaler_fits_on_train() -> None:
    value, ps = split_port(pl.DataFrame({"x": [1.0, 2.0, 3.0, None]}), pl.DataFrame({"x": [10.0]}))
    run = run_node("prep.scale", {"method": "standard"}, {"in": value}, {"in": ps})
    train = run.outputs["out"].parts["train"]["x"]
    assert train.drop_nulls().mean() == pytest.approx(0.0) and train.null_count() == 1
    assert run.outputs["out"].parts["test"]["x"][0] == pytest.approx((10 - 2) / np.std([1, 2, 3]))


@pytest.mark.parametrize("method", ["minmax", "robust", "quantile"])
def test_other_scalers_run(method: str) -> None:
    df = pl.DataFrame({"x": [float(i) for i in range(50)]})
    out = run_node("prep.scale", {"method": method}, {"in": df}, {"in": table_port(df)}).outputs["out"]
    assert out["x"].dtype == pl.Float64 and out.height == 50


def test_scale_rejects_categorical_with_prd_message() -> None:
    port = table_port(pl.DataFrame({"plan_type": ["basic", "pro"] * 10, "x": list(range(20))}))
    with pytest.raises(NodeCompileError) as err:
        propagate("prep.scale", {"columns": ["plan_type"]}, {"in": port})
    assert err.value.code == "SCHEMA_MISMATCH"
    assert "prep.scale expects numeric columns; 'plan_type' is binary" in err.value.message
    assert err.value.suggestion and "Insert prep.encode" in err.value.suggestion


# ------------------------------------------------------------------------ fit/evaluate


def _xy(n: int = 300, regression: bool = False) -> pl.DataFrame:
    rng = np.random.default_rng(5)
    x1, x2 = rng.normal(size=n), rng.normal(size=n)
    y = 2 * x1 + rng.normal(scale=0.2, size=n) if regression else (x1 + 0.1 * x2) > 0
    return pl.DataFrame({"x1": x1, "x2": x2, "y": y})


@pytest.mark.parametrize(
    ("regression", "algorithm"),
    [
        (False, "logistic_regression"),
        (False, "random_forest"),
        (True, "linear_regression"),
        (True, "gradient_boosting"),
    ],
)
def test_fit_and_evaluate(regression: bool, algorithm: str) -> None:
    df = _xy(regression=regression)
    value, ps = split_frame(df, source={"target": "y"}, seed=0)
    fit = run_node("model.fit", {"algorithm": algorithm}, {"train": value}, {"train": ps})
    model_ps = fit.schemas["model"]
    assert model_ps.model and model_ps.model.task == ("regression" if regression else "classification")
    assert fit.outputs["model"].fit_rows == 240
    ev = run_node(
        "model.evaluate", {}, {"model": fit.outputs["model"], "data": value}, {"model": model_ps, "data": ps}
    )
    m = ev.outputs["metrics"]
    if regression:
        assert m["r2"] > 0.9
    else:
        assert (
            m["accuracy"] > 0.85
            and m["roc_auc"] > 0.9
            and m["confusion_matrix"]["labels"] == ["false", "true"]
        )
    assert ev.outputs["predictions"].height == 60
    assert_grounded(ev.outputs["chart"])


def test_fit_compile_errors() -> None:
    df = _xy().with_columns(pl.Series("cat", ["a", "b", "c"] * 100), pl.Series("gap", [None, 1.0, 2.0] * 100))
    value, ps = split_frame(df, source={"target": "y"})
    cases = [
        ({"features": ["x1", "cat"]}, "SCHEMA_MISMATCH"),
        ({"features": ["x1", "gap"]}, "NULLS_IN_FEATURES"),
        ({"features": ["x1"], "hyperparameters": {"bogus": 1}}, "PARAM_INVALID"),
        ({"features": ["x1"], "hyperparameters": {"C": -1.0}}, "PARAM_INVALID"),
        ({"features": ["x1"], "algorithm": "linear_regression"}, "ALGORITHM_TASK_MISMATCH"),
        ({"features": ["x1"], "algorithm": "knn", "class_weight": "balanced"}, "PARAM_INVALID"),
    ]
    for params, code in cases:
        with pytest.raises(NodeCompileError) as err:
            propagate("model.fit", params, {"train": ps})
        assert err.value.code == code, params
    no_target, no_target_ps = split_frame(_xy())
    with pytest.raises(NodeCompileError) as err:
        propagate("model.fit", {}, {"train": no_target_ps})
    assert err.value.code == "TARGET_UNDEFINED"


def test_single_class_training_fails_at_runtime() -> None:
    df = _xy().with_columns(pl.lit(True).alias("y"))
    value, ps = split_frame(df, source={"target": "y"})
    with pytest.raises(NodeRuntimeError) as err:
        run_node("model.fit", {}, {"train": value}, {"train": ps})
    assert err.value.code == "SINGLE_CLASS"


def test_evaluate_compile_errors() -> None:
    value, ps = split_frame(_xy(), source={"target": "y"})
    model_ps, _ = propagate("model.fit", {}, {"train": ps})
    with pytest.raises(NodeCompileError) as err:
        propagate("model.evaluate", {"partition": "val"}, {"model": model_ps["model"], "data": ps})
    assert err.value.code == "PARTITION_NOT_FOUND"
    _, narrow = split_frame(_xy().drop("x2"), source={"target": "y"})
    with pytest.raises(NodeCompileError) as err:
        propagate("model.evaluate", {}, {"model": model_ps["model"], "data": narrow})
    assert err.value.code == "FEATURES_MISSING"


# --------------------------------------------------------------------------------- viz


@pytest.mark.parametrize("chart", ["histogram", "box", "ecdf"])
def test_numeric_distribution_charts(chart: str) -> None:
    df = pl.DataFrame({"x": [float(i) ** 1.5 for i in range(200)] + [None] * 10})
    out = run_node(
        "viz.distribution", {"column": "x", "chart": chart}, {"in": df}, {"in": table_port(df)}
    ).outputs["out"]
    assert out["narration"].startswith("`x` ranges from 0 to")
    assert "4.76% of values are missing" in out["narration"]
    assert_grounded(out)


def test_categorical_and_empty_distributions() -> None:
    df = pl.DataFrame({"s": ["a", "b", "a", None], "e": pl.Series([None] * 4, dtype=pl.Float64)})
    out = run_node("viz.distribution", {"column": "s"}, {"in": df}, {"in": table_port(df)}).outputs["out"]
    assert out["narration"].startswith("`s` has 2 distinct values. The most common is `a` at 50%")
    assert_grounded(out)
    out = run_node("viz.distribution", {"column": "e"}, {"in": df}, {"in": table_port(df)}).outputs["out"]
    assert out["narration"] == "`e` has no non-missing values."
    with pytest.raises(NodeCompileError) as err:
        propagate("viz.distribution", {"column": "s", "chart": "box"}, {"in": table_port(df)})
    assert err.value.code == "SCHEMA_MISMATCH"


def test_distribution_on_split_partition() -> None:
    value, ps = split_port(pl.DataFrame({"x": [1.0, 2.0]}), pl.DataFrame({"x": [100.0]}))
    out = run_node(
        "viz.distribution", {"column": "x", "partition": "test"}, {"in": value}, {"in": ps}
    ).outputs["out"]
    assert out["narration_basis"]["max"] == 100.0


# -------------------------------------------------------------------------------- sink


def test_export_table_and_split(tmp_path: Path) -> None:
    df = pl.DataFrame({"a": [1, 2], "b": ["x", "y"]})
    run = run_node(
        "sink.export", {"path": "out/table.parquet"}, {"in": df}, {"in": table_port(df)}, export_dir=tmp_path
    )
    assert pl.read_parquet(tmp_path / "out/table.parquet").equals(df) and len(run.files) == 1
    value, ps = split_port(df, df)
    run_node(
        "sink.export", {"path": "parts", "format": "csv"}, {"in": value}, {"in": ps}, export_dir=tmp_path
    )
    assert sorted(p.name for p in tmp_path.glob("parts_*.csv")) == ["parts_test.csv", "parts_train.csv"]


@pytest.mark.parametrize("bad", ["../escape", "/abs/path", "a/../../b", "semi;colon"])
def test_export_rejects_unsafe_paths(bad: str) -> None:
    with pytest.raises(ValidationError):
        get_node("sink.export").parse_params({"path": bad})  # type: ignore[union-attr]


def test_ports_are_typed() -> None:
    assert get_node("model.evaluate").inputs["model"].types == (PortType.MODEL,)  # type: ignore[union-attr]
