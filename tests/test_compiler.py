"""Compiler tests. Every semantic rule (PRD 8.5) has a positive and a negative case."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from flowlab_nodes import Node, PortDef, temporary_node
from flowlab_nodes.common import TABLE_OR_SPLIT
from flowspec import PortSchema, PortType
from helpers import (
    CHURN_SOURCE,
    compile_spec,
    flow,
    issues,
    load_example,
    model_flow,
    warning_codes,
)
from pydantic import BaseModel, ConfigDict

SRC = ("src", "source.dataset", CHURN_SOURCE)


def error_codes(spec: dict[str, Any]) -> list[tuple[str | None, str]]:
    return issues(compile_spec(spec))


# -------------------------------------------------------------------------- baseline


def test_valid_model_flow_compiles_to_a_plan() -> None:
    result = compile_spec(model_flow())
    assert result.ok, result.errors
    assert result.plan and [s.node_id for s in result.plan.steps] == [
        "src",
        "split",
        "impute",
        "encode",
        "fit",
        "eval",
    ]
    assert result.plan.dataset_hashes["primary"].startswith("sha256:")
    fit = result.plan.steps[4]
    assert (
        fit.output_schemas["model"].model and "plan_type=basic" in fit.output_schemas["model"].model.features
    )


def test_example_flows() -> None:
    assert compile_spec(load_example("churn_flow.json")).ok
    assert compile_spec(load_example("churn_full_flow.json")).ok
    assert error_codes(load_example("leaky_flow.json")) == [("scale", "LEAKAGE_FIT_BEFORE_SPLIT")]


# ------------------------------------------------------------------------ structural


def test_spec_shape_errors_are_reported_not_raised() -> None:
    result = compile_spec({"flow_id": "x", "nodes": [{"id": "a"}]})
    assert not result.ok and {i.code for i in result.errors} == {"SPEC_INVALID"}
    assert any(i.node_id == "a" for i in result.errors)


def test_structural_errors() -> None:
    assert error_codes(flow([SRC, ("x", "prep.scael", {})], ["src->x"])) == [("x", "UNKNOWN_NODE_TYPE")]
    assert (
        compile_spec(flow([SRC, ("x", "prep.scael", {})], ["src->x"])).errors[0].suggestion
        == "Did you mean 'prep.scale'?"
    )
    assert error_codes(flow([SRC, SRC], [])) == [("src", "DUPLICATE_NODE_ID")]
    assert error_codes(flow([SRC, ("s", "prep.scale", {})], [])) == [("s", "MISSING_INPUT")]
    assert error_codes(flow([SRC, ("s", "prep.scale", {})], ["src->s.nope"])) == [
        ("s", "UNKNOWN_PORT"),
        ("s", "MISSING_INPUT"),
    ]
    assert error_codes(flow([SRC, ("s", "prep.scale", {})], ["src->s", "src->s"])) == [
        ("s", "MULTIPLE_INPUTS")
    ]
    assert error_codes(flow([SRC, ("ev", "model.evaluate", {})], ["src->ev.model", "src->ev.data"])) == [
        ("ev", "PORT_TYPE_MISMATCH"),
        ("ev", "MISSING_INPUT"),
    ]
    assert error_codes(flow([SRC, ("s", "prep.scale", {})], ["src->ghost"])) == [
        (None, "EDGE_UNKNOWN_NODE"),
        ("s", "MISSING_INPUT"),
    ]


def test_cycles_are_detected_and_attributed() -> None:
    spec = flow(
        [
            SRC,
            ("a", "clean.drop_columns", {"columns": ["customer_id"]}),
            ("b", "clean.drop_columns", {"columns": ["contract"]}),
        ],
        ["a->b", "b->a"],
    )
    errs = compile_spec(spec).errors
    assert {(e.node_id, e.code) for e in errs} == {("a", "CYCLE_DETECTED"), ("b", "CYCLE_DETECTED")}
    assert "a -> b -> a" in errs[0].message


def test_param_validation_errors_are_node_attributed() -> None:
    spec = flow([SRC, ("s", "prep.split", {"test_size": 1.5, "unknown": 1})], ["src->s"])
    assert issues(compile_spec(spec)) == [("s", "PARAM_INVALID"), ("s", "PARAM_INVALID")]


def test_unbound_dataset() -> None:
    spec = flow([("src", "source.dataset", {"dataset_ref": "other"})], [])
    assert error_codes(spec) == [("src", "UNBOUND_DATASET")]


# ------------------------------------------------------------------ type propagation


def test_scaling_a_categorical_column_is_a_schema_mismatch() -> None:
    spec = model_flow(
        post=[
            ("impute", "clean.impute", {"strategy": "median"}),
            ("scale", "prep.scale", {"columns": ["plan_type"]}),
        ]
    )
    result = compile_spec(spec)
    (err,) = result.errors
    assert (err.node_id, err.code) == ("scale", "SCHEMA_MISMATCH")
    assert err.message == "prep.scale expects numeric columns; 'plan_type' is categorical_nominal"


def test_errors_do_not_cascade_downstream() -> None:
    spec = model_flow(post=[("encode", "prep.encode", {"columns": ["nope"]})])
    assert error_codes(spec) == [("encode", "COLUMN_NOT_FOUND")]


def test_unencoded_and_unimputed_features_are_caught() -> None:
    assert error_codes(model_flow(post=[("impute", "clean.impute", {"strategy": "median"})])) == [
        ("fit", "SCHEMA_MISMATCH")
    ]
    assert error_codes(model_flow(post=[("encode", "prep.encode", {})])) == [("fit", "NULLS_IN_FEATURES")]


# ----------------------------------------------------- leakage: fit before split (8.5)


def test_leakage_scale_before_split() -> None:
    pre = [("fill", "clean.impute", {"strategy": "constant", "fill_value": 0}), ("scale", "prep.scale", {})]
    result = compile_spec(model_flow(pre=pre, post=[("encode", "prep.encode", {})]))
    assert issues(result) == [("scale", "LEAKAGE_FIT_BEFORE_SPLIT")]
    assert "prep.split 'split'" in result.errors[0].message


def test_no_leakage_scale_after_split() -> None:
    post = [
        ("impute", "clean.impute", {"strategy": "median"}),
        ("encode", "prep.encode", {}),
        ("scale", "prep.scale", {}),
    ]
    assert compile_spec(model_flow(post=post)).ok


def test_leakage_encode_before_split() -> None:
    spec = model_flow(
        pre=[("encode", "prep.encode", {})], post=[("impute", "clean.impute", {"strategy": "median"})]
    )
    assert error_codes(spec) == [("encode", "LEAKAGE_FIT_BEFORE_SPLIT")]


def test_leakage_learned_impute_before_split_but_constant_is_fine() -> None:
    median = model_flow(
        pre=[("impute", "clean.impute", {"strategy": "median"})], post=[("encode", "prep.encode", {})]
    )
    assert error_codes(median) == [("impute", "LEAKAGE_FIT_BEFORE_SPLIT")]
    constant = model_flow(
        pre=[("impute", "clean.impute", {"strategy": "constant", "fill_value": 0})],
        post=[("encode", "prep.encode", {})],
    )
    assert compile_spec(constant).ok


def test_learning_transform_without_downstream_model_is_allowed() -> None:
    spec = flow(
        [SRC, ("scale", "prep.scale", {}), ("hist", "viz.distribution", {"column": "tenure_months"})],
        ["src->scale", "scale->hist"],
    )
    assert compile_spec(spec).ok


# -------------------------------------------------------------- leakage: target (8.5)


def test_leakage_target_in_features() -> None:
    features = ["tenure_months", "monthly_charges", "churned"]
    assert error_codes(model_flow(fit={"algorithm": "logistic_regression", "features": features})) == [
        ("fit", "LEAKAGE_TARGET_IN_FEATURES")
    ]
    assert compile_spec(model_flow(fit={"algorithm": "logistic_regression", "features": features[:2]})).ok


def test_target_definition() -> None:
    no_target = {"dataset_ref": "primary", "role_overrides": {"signup_date": "ignore"}}
    assert error_codes(model_flow(source=no_target)) == [("fit", "TARGET_UNDEFINED")]
    assert compile_spec(model_flow(source=no_target, fit={"target": "churned"})).ok


# ---------------------------------------------------------- leakage: resampling (8.5)


class _ResampleParams(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _Resample(Node[_ResampleParams]):
    """Test-only resampling node used to exercise the resampling leakage rule."""

    type = "test.resample"
    title = "Resample"
    category = "test"
    Params = _ResampleParams
    inputs = {"in": PortDef(TABLE_OR_SPLIT)}
    outputs = {"out": PortDef(TABLE_OR_SPLIT)}
    resamples_rows = True

    def propagate(
        self, params: _ResampleParams, inputs: Mapping[str, PortSchema], ctx: Any
    ) -> dict[str, PortSchema]:
        return {"out": inputs["in"]}


def test_leakage_resampling_outside_split() -> None:
    with temporary_node(_Resample):
        bad = model_flow(pre=[("bal", "test.resample", {})])
        assert error_codes(bad) == [("bal", "LEAKAGE_RESAMPLING")]
        good = model_flow(
            post=[
                ("impute", "clean.impute", {"strategy": "median"}),
                ("encode", "prep.encode", {}),
                ("bal", "test.resample", {}),
            ]
        )
        assert compile_spec(good).ok


# ------------------------------------------------------------------- warnings (8.5)


def test_temporal_leakage_warning() -> None:
    dated = {"dataset_ref": "primary", "target": "churned"}
    post = [
        ("impute", "clean.impute", {"strategy": "median"}),
        ("encode", "prep.encode", {}),
        ("drop", "clean.drop_columns", {"columns": ["signup_date"]}),
    ]
    assert "TEMPORAL_LEAKAGE_RISK" in warning_codes(compile_spec(model_flow(source=dated, post=post)))
    assert "TEMPORAL_LEAKAGE_RISK" not in warning_codes(compile_spec(model_flow()))
    timed = model_flow(source=dated, post=post, split={"time_based": True, "time_column": "signup_date"})
    assert "TEMPORAL_LEAKAGE_RISK" not in warning_codes(compile_spec(timed))


def test_class_imbalance_warning() -> None:
    source = {"dataset_ref": "primary", "target": "is_fraud"}
    plain = compile_spec(
        model_flow(source=source, post=[], split={"stratify_by": "is_fraud"}, dataset="imbalanced_2pct")
    )
    assert plain.ok and "CLASS_IMBALANCE" in warning_codes(plain)
    weighted = model_flow(
        source=source,
        post=[],
        split={"stratify_by": "is_fraud"},
        dataset="imbalanced_2pct",
        fit={"algorithm": "logistic_regression", "class_weight": "balanced"},
    )
    assert "CLASS_IMBALANCE" not in warning_codes(compile_spec(weighted))
    assert "CLASS_IMBALANCE" not in warning_codes(compile_spec(model_flow()))


def test_small_n_warning() -> None:
    tiny = model_flow(
        source={"dataset_ref": "primary", "target": "score"},
        post=[("encode", "prep.encode", {})],
        split={},
        fit={"algorithm": "linear_regression"},
        dataset="tiny_30",
    )
    result = compile_spec(tiny)
    assert result.ok
    assert ("split", "SMALL_N") in issues(result, "warning")
    assert ("src", "SMALL_N") not in issues(result, "warning")  # exactly 30 rows is not "fewer than 30"
    assert "SMALL_N" not in warning_codes(compile_spec(model_flow()))


class _TestParams(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _HypothesisTest(Node[_TestParams]):
    """Test-only hypothesis test node used to exercise the multiple comparisons rule."""

    type = "test.hypothesis"
    title = "Test"
    category = "test"
    Params = _TestParams
    inputs = {"in": PortDef((PortType.TABLE,))}
    outputs = {"out": PortDef((PortType.METRICS,))}
    is_hypothesis_test = True

    def propagate(
        self, params: _TestParams, inputs: Mapping[str, PortSchema], ctx: Any
    ) -> dict[str, PortSchema]:
        return {"out": PortSchema.of_kind(PortType.METRICS)}


class _Correction(_HypothesisTest):
    """Test-only correction node used to exercise the multiple comparisons rule."""

    type = "test.correction"
    is_hypothesis_test = False
    is_correction = True


def test_multiple_comparisons_warning() -> None:
    with temporary_node(_HypothesisTest), temporary_node(_Correction):
        tests = [(f"t{i}", "test.hypothesis", {}) for i in range(6)]
        edges = [f"src->t{i}" for i in range(6)]
        assert "MULTIPLE_COMPARISONS" in warning_codes(compile_spec(flow([SRC, *tests], edges)))
        corrected = flow([SRC, *tests, ("c", "test.correction", {})], [*edges, "src->c"])
        assert "MULTIPLE_COMPARISONS" not in warning_codes(compile_spec(corrected))
        assert "MULTIPLE_COMPARISONS" not in warning_codes(compile_spec(flow([SRC, *tests[:5]], edges[:5])))


def test_evaluation_warnings() -> None:
    on_train = compile_spec(model_flow(evaluate={"partition": "train"}))
    assert ("eval", "EVAL_ON_TRAIN") in issues(on_train, "warning")
    assert "EVAL_ON_TRAIN" not in warning_codes(compile_spec(model_flow()))


def test_split_mismatch_warning() -> None:
    base = model_flow()
    base["nodes"] += [
        {"id": "split2", "type": "prep.split", "params": {"seed": 999}},
        {"id": "impute2", "type": "clean.impute", "params": {"strategy": "median"}},
        {"id": "encode2", "type": "prep.encode", "params": {}},
    ]
    base["edges"] = [e for e in base["edges"] if not (e["target"] == "eval" and e["target_port"] == "data")]
    for i, (a, b, port) in enumerate(
        [
            ("src", "split2", "in"),
            ("split2", "impute2", "in"),
            ("impute2", "encode2", "in"),
            ("encode2", "eval", "data"),
        ]
    ):
        base["edges"].append(
            {"id": f"x{i}", "source": a, "source_port": "out", "target": b, "target_port": port}
        )
    assert ("eval", "SPLIT_MISMATCH") in issues(compile_spec(base), "warning")
    assert "SPLIT_MISMATCH" not in warning_codes(compile_spec(model_flow()))


def test_no_holdout_warning() -> None:
    spec = flow(
        [
            SRC,
            ("fill", "clean.impute", {"strategy": "constant", "fill_value": 0}),
            (
                "fit",
                "model.fit",
                {"algorithm": "random_forest", "features": ["tenure_months", "support_calls"]},
            ),
        ],
        ["src->fill", "fill->fit.train"],
    )
    result = compile_spec(spec)
    assert result.ok and ("fit", "NO_HOLDOUT") in issues(result, "warning")
