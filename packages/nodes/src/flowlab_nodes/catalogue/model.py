from __future__ import annotations

import math
import warnings
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
import polars as pl
from flowspec import ColumnSchema, ModelSchema, PortSchema, PortType, Role, Semantic, TableSchema
from pydantic import BaseModel, ConfigDict, Field
from sklearn import metrics as skm
from sklearn.ensemble import (
    ExtraTreesClassifier,
    ExtraTreesRegressor,
    GradientBoostingClassifier,
    GradientBoostingRegressor,
    RandomForestClassifier,
    RandomForestRegressor,
)
from sklearn.linear_model import ElasticNet, Lasso, LinearRegression, LogisticRegression, Ridge
from sklearn.naive_bayes import GaussianNB
from sklearn.neighbors import KNeighborsClassifier, KNeighborsRegressor
from sklearn.svm import SVC, SVR
from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor

from ..base import CompileContext, ExecContext, Node, NodeCompileError, NodeRuntimeError, PortDef
from ..common import (
    TABLE_OR_SPLIT,
    check_partition,
    feature_matrix,
    fit_frame,
    is_model_ready,
    pick_frame,
    resolve_columns,
)
from ..narration import VEGA_LITE_SCHEMA, chart_artifact, fmt, pct
from ..registry import register
from ..runtime_types import FittedModel

Task = Literal["classification", "regression"]


@dataclass(frozen=True)
class Algorithm:
    classifier: type | None
    regressor: type | None
    classifier_defaults: dict[str, Any] = field(default_factory=dict)
    regressor_defaults: dict[str, Any] = field(default_factory=dict)


ALGORITHMS: dict[str, Algorithm] = {
    "logistic_regression": Algorithm(LogisticRegression, None, {"max_iter": 1000}),
    "linear_regression": Algorithm(None, LinearRegression),
    "ridge": Algorithm(None, Ridge),
    "lasso": Algorithm(None, Lasso),
    "elastic_net": Algorithm(None, ElasticNet),
    "decision_tree": Algorithm(DecisionTreeClassifier, DecisionTreeRegressor),
    "random_forest": Algorithm(RandomForestClassifier, RandomForestRegressor),
    "extra_trees": Algorithm(ExtraTreesClassifier, ExtraTreesRegressor),
    "gradient_boosting": Algorithm(GradientBoostingClassifier, GradientBoostingRegressor),
    "svm": Algorithm(SVC, SVR, {"probability": True}),
    "knn": Algorithm(KNeighborsClassifier, KNeighborsRegressor),
    "gaussian_nb": Algorithm(GaussianNB, None),
}
AlgorithmName = Literal[
    "logistic_regression",
    "linear_regression",
    "ridge",
    "lasso",
    "elastic_net",
    "decision_tree",
    "random_forest",
    "extra_trees",
    "gradient_boosting",
    "svm",
    "knn",
    "gaussian_nb",
]
HyperValue = int | float | str | bool | None


def build_estimator(
    algorithm: str,
    task: Task,
    hyperparameters: Mapping[str, HyperValue],
    seed: int,
    class_weight: str,
) -> Any:
    algo = ALGORITHMS[algorithm]
    cls = algo.classifier if task == "classification" else algo.regressor
    if cls is None:
        raise NodeCompileError(
            "ALGORITHM_TASK_MISMATCH",
            f"{algorithm} does not support {task}",
            "Pick an algorithm that supports this task, or set task explicitly",
        )
    valid = set(cls().get_params())
    kwargs: dict[str, Any] = dict(
        algo.classifier_defaults if task == "classification" else algo.regressor_defaults
    )
    kwargs.update(hyperparameters)
    if "random_state" in valid and "random_state" not in hyperparameters:
        kwargs["random_state"] = seed
    if class_weight == "balanced":
        if "class_weight" not in valid:
            raise NodeCompileError(
                "PARAM_INVALID",
                f"{algorithm} does not support class_weight",
                "Use a balancing node or an algorithm with class weights",
            )
        kwargs["class_weight"] = "balanced"
    unknown = sorted(set(kwargs) - valid)
    if unknown:
        raise NodeCompileError(
            "PARAM_INVALID",
            f"unknown hyperparameters for {algorithm}: {unknown}",
            "Valid: " + ", ".join(sorted(valid)),
        )
    estimator = cls(**kwargs)
    validate = getattr(estimator, "_validate_params", None)
    if callable(validate):
        try:
            validate()
        except (ValueError, TypeError) as exc:
            raise NodeCompileError("PARAM_INVALID", f"{algorithm}: {exc}") from exc
    return estimator


def infer_task(target: ColumnSchema) -> Task:
    if target.semantic in (Semantic.BINARY, Semantic.CATEGORICAL_NOMINAL, Semantic.CATEGORICAL_ORDINAL):
        return "classification"
    if target.semantic == Semantic.NUMERIC_CONTINUOUS:
        return "regression"
    if target.semantic == Semantic.NUMERIC_DISCRETE:
        return "classification" if (target.cardinality or 0) <= 10 else "regression"
    raise NodeCompileError(
        "TARGET_INVALID", f"cannot model target '{target.name}' of type {target.semantic.value}"
    )


def check_features(schema: TableSchema, features: list[str], target: str) -> list[ColumnSchema]:
    cols = resolve_columns(schema, features)
    for col in cols:
        if col.name == target:
            continue  # reported by the compiler's leakage rule
        if col.is_temporal:
            raise NodeCompileError(
                "SCHEMA_MISMATCH",
                f"feature '{col.name}' is a {col.dtype}; models need numeric features",
                f"Set role 'ignore' on '{col.name}' or derive numeric parts from it",
            )
        if not is_model_ready(col):
            raise NodeCompileError(
                "SCHEMA_MISMATCH",
                f"feature '{col.name}' is {col.semantic.value} ({col.dtype}); models need numeric features",
                f"Insert prep.encode before this node, or remove '{col.name}' from features",
            )
        if col.nullable:
            raise NodeCompileError(
                "NULLS_IN_FEATURES",
                f"feature '{col.name}' may contain missing values",
                "Insert clean.impute (after prep.split) before this node",
            )
    return cols


# ------------------------------------------------------------------------------------ fit


class FitParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task: Literal["auto", "classification", "regression"] = "auto"
    algorithm: AlgorithmName = Field(
        "random_forest",
        json_schema_extra={
            "x-widget": "select",
            "x-descriptions": {
                "logistic_regression": "Linear, interpretable coefficients. Strong baseline.",
                "random_forest": "Robust ensemble of trees; little tuning needed.",
                "gradient_boosting": "Sequential trees; often the most accurate on tabular data.",
            },
        },
    )
    target: str | None = Field(
        None,
        description="Defaults to the column with role 'target'.",
        json_schema_extra={"x-widget": "column-select"},
    )
    features: list[str] = Field(
        default_factory=list,
        description="Defaults to every column with role 'feature'.",
        json_schema_extra={"x-widget": "column-multiselect"},
    )
    hyperparameters: dict[str, HyperValue] = Field(default_factory=dict)
    class_weight: Literal["none", "balanced"] = "none"
    seed: int | None = None


def resolve_target(params: FitParams, schema: TableSchema) -> ColumnSchema:
    if params.target:
        (col,) = resolve_columns(schema, [params.target])
        return col
    targets = schema.targets()
    if len(targets) != 1:
        raise NodeCompileError(
            "TARGET_UNDEFINED",
            f"model.fit requires exactly one column with role 'target'; found {len(targets)}",
            "Set target on the dataset source or on this node",
        )
    return targets[0]


@register
class ModelFit(Node[FitParams]):
    """Fit a supervised model on the train partition.

    The target defaults to the column with role ``target`` and the features to every
    column with role ``feature``. Features must be numeric and free of missing values, which
    the compiler checks before anything runs.
    """

    type = "model.fit"
    title = "Fit model"
    category = "model"
    Params = FitParams
    inputs = {"train": PortDef(TABLE_OR_SPLIT, description="Uses the train partition of a split")}
    outputs = {"model": PortDef((PortType.MODEL,))}
    stochastic = True

    def learns_from_data(self, params: FitParams) -> bool:
        return True

    def propagate(
        self, params: FitParams, inputs: Mapping[str, PortSchema], ctx: CompileContext
    ) -> dict[str, PortSchema]:
        schema = inputs["train"].require_table()
        target = resolve_target(params, schema)
        task: Task = infer_task(target) if params.task == "auto" else params.task
        if task == "regression" and not target.is_numeric:
            raise NodeCompileError(
                "TARGET_INVALID", f"regression needs a numeric target; '{target.name}' is {target.dtype}"
            )
        features = params.features or [
            c.name for c in schema.columns if c.role == Role.FEATURE and c.name != target.name
        ]
        if not features:
            raise NodeCompileError("NO_FEATURES", "no feature columns are available")
        check_features(schema, features, target.name)
        build_estimator(
            params.algorithm,
            task,
            params.hyperparameters,
            params.seed if params.seed is not None else ctx.seed,
            params.class_weight,
        )
        if target.nullable:
            ctx.warn("TARGET_HAS_NULLS", f"rows with a missing '{target.name}' are dropped before fitting")
        classes = target.categories if task == "classification" else None
        model = ModelSchema(
            task=task,
            algorithm=params.algorithm,
            target=target.name,
            features=features,
            classes=classes,
            positive_class=classes[-1] if classes and len(classes) == 2 else None,
        )
        return {"model": PortSchema.of_model(model)}

    def execute(self, params: FitParams, inputs: Mapping[str, Any], ctx: ExecContext) -> dict[str, Any]:
        spec = ctx.output_schemas["model"].model
        assert spec is not None
        df = fit_frame(inputs["train"]).filter(pl.col(spec.target).is_not_null())
        if df.height == 0:
            raise NodeRuntimeError("EMPTY_TRAINING_DATA", "no training rows with a target value")
        x = feature_matrix(df, spec.features)
        if spec.task == "classification":
            y = np.asarray(df[spec.target].cast(pl.String).to_list(), dtype=object)
            if len(set(y.tolist())) < 2:
                raise NodeRuntimeError("SINGLE_CLASS", "training data contains a single class")
        else:
            y = df[spec.target].cast(pl.Float64).to_numpy()
        seed = params.seed if params.seed is not None else ctx.seed
        estimator = build_estimator(
            spec.algorithm, spec.task, params.hyperparameters, seed, params.class_weight
        )
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                estimator.fit(x, y)
        except ValueError as exc:
            raise NodeRuntimeError("FIT_FAILED", str(exc)) from exc
        classes = [str(c) for c in estimator.classes_] if spec.task == "classification" else None
        return {
            "model": FittedModel(
                estimator=estimator,
                task=spec.task,
                algorithm=spec.algorithm,
                target=spec.target,
                features=list(spec.features),
                classes=classes,
                fit_rows=df.height,
            )
        }


# ------------------------------------------------------------------------------- evaluate


class EvaluateParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    partition: Literal["test", "val", "train"] = Field(
        "test", description="Which partition to score when the data input is a split."
    )
    positive_class: str | None = Field(None, description="Binary classification positive label.")


def _r6(value: float) -> float | None:
    v = float(value)
    return round(v, 6) if math.isfinite(v) else None


@register
class ModelEvaluate(Node[EvaluateParams]):
    """Score a fitted model on held-out data.

    Classification reports accuracy against the majority-class baseline, balanced accuracy,
    precision, recall, F1, ROC AUC and a confusion matrix. Regression reports R-squared,
    MAE, RMSE and a predicted-vs-actual plot. Evaluating on the train partition is flagged.
    """

    type = "model.evaluate"
    title = "Evaluate model"
    category = "model"
    Params = EvaluateParams
    inputs = {
        "model": PortDef((PortType.MODEL,)),
        "data": PortDef(TABLE_OR_SPLIT, description="Uses the chosen partition of a split"),
    }
    outputs = {
        "metrics": PortDef((PortType.METRICS,)),
        "chart": PortDef((PortType.CHART,)),
        "predictions": PortDef((PortType.TABLE,)),
    }

    def propagate(
        self, params: EvaluateParams, inputs: Mapping[str, PortSchema], ctx: CompileContext
    ) -> dict[str, PortSchema]:
        model = inputs["model"].model
        assert model is not None
        data = inputs["data"]
        schema = data.require_table()
        check_partition(data, params.partition)
        missing = [f for f in [*model.features, model.target] if schema.column(f) is None]
        if missing:
            raise NodeCompileError(
                "FEATURES_MISSING",
                f"evaluation data lacks columns the model needs: {missing}",
                "Connect data that went through the same preprocessing as the training data",
            )
        check_features(schema, model.features, model.target)
        if params.positive_class is not None and (
            model.task != "classification" or (model.classes and params.positive_class not in model.classes)
        ):
            raise NodeCompileError(
                "PARAM_INVALID", f"positive_class '{params.positive_class}' is not a target class"
            )
        extra: list[ColumnSchema] = []
        for name in ("prediction", "probability"):
            if schema.column(name) is not None:
                raise NodeCompileError("DUPLICATE_COLUMN", f"data already has a column named '{name}'")
        if model.task == "classification":
            extra.append(
                ColumnSchema(
                    name="prediction",
                    dtype="string",
                    semantic=Semantic.CATEGORICAL_NOMINAL,
                    role=Role.IGNORE,
                    nullable=False,
                )
            )
            if model.classes is None or len(model.classes) == 2:
                extra.append(
                    ColumnSchema(
                        name="probability",
                        dtype="float64",
                        semantic=Semantic.NUMERIC_CONTINUOUS,
                        role=Role.IGNORE,
                        nullable=False,
                    )
                )
        else:
            extra.append(
                ColumnSchema(
                    name="prediction",
                    dtype="float64",
                    semantic=Semantic.NUMERIC_CONTINUOUS,
                    role=Role.IGNORE,
                    nullable=False,
                )
            )
        predictions = TableSchema(columns=[*schema.columns, *extra])
        if data.kind == PortType.TABLE_SPLIT and data.partition_rows:
            predictions.row_count = data.partition_rows.get(params.partition)
        return {
            "metrics": PortSchema.of_kind(PortType.METRICS),
            "chart": PortSchema.of_kind(PortType.CHART),
            "predictions": PortSchema.of_table(predictions),
        }

    def execute(self, params: EvaluateParams, inputs: Mapping[str, Any], ctx: ExecContext) -> dict[str, Any]:
        fm: FittedModel = inputs["model"]
        df = pick_frame(inputs["data"], params.partition)
        if df.height == 0:
            raise NodeRuntimeError("EMPTY_EVALUATION_DATA", "no rows to evaluate on")
        x = feature_matrix(df, fm.features)
        est = fm.estimator
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            pred = est.predict(x)
        mask = df[fm.target].is_not_null().to_numpy()
        n_eval = int(mask.sum())
        if n_eval == 0:
            raise NodeRuntimeError("EMPTY_EVALUATION_DATA", "no rows with a target value")
        partition = params.partition if ctx.input_schemas["data"].kind == PortType.TABLE_SPLIT else "data"

        if fm.task == "classification":
            assert fm.classes is not None
            pred_s = np.asarray([str(p) for p in pred], dtype=object)
            out = df.with_columns(pl.Series("prediction", pred_s.tolist(), dtype=pl.String))
            binary = len(fm.classes) == 2
            pos = params.positive_class or (fm.classes[-1] if binary else None)
            proba = None
            if binary:
                if pos not in fm.classes:
                    raise NodeRuntimeError(
                        "PARAM_INVALID", f"positive_class '{pos}' was not seen in training"
                    )
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    proba = est.predict_proba(x)[:, fm.classes.index(str(pos))]
                out = out.with_columns(pl.Series("probability", proba, dtype=pl.Float64))
            elif "probability" in ctx.output_schemas["predictions"].require_table().names:
                out = out.with_columns(pl.lit(None, pl.Float64).alias("probability"))
            y_true = np.asarray(df[fm.target].cast(pl.String).to_list(), dtype=object)[mask]
            metrics, chart = _classification_report(
                y_true, pred_s[mask], proba[mask] if proba is not None else None, fm.classes, pos, partition
            )
        else:
            out = df.with_columns(pl.Series("prediction", pred, dtype=pl.Float64))
            y_true = df[fm.target].cast(pl.Float64).to_numpy()[mask]
            metrics, chart = _regression_report(y_true, np.asarray(pred, dtype=float)[mask], partition)
        metrics.update(
            algorithm=fm.algorithm,
            task=fm.task,
            target=fm.target,
            partition=partition,
            n_features=len(fm.features),
        )
        return {"metrics": metrics, "chart": chart, "predictions": out}


def _classification_report(
    y_true: np.ndarray[Any, Any],
    y_pred: np.ndarray[Any, Any],
    proba: np.ndarray[Any, Any] | None,
    classes: list[str],
    pos: str | None,
    partition: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    labels = sorted({*classes, *(str(v) for v in y_true)})
    n = len(y_true)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        acc = skm.accuracy_score(y_true, y_pred)
        bacc = skm.balanced_accuracy_score(y_true, y_pred)
        if pos is not None:
            kw: dict[str, Any] = {"pos_label": pos, "average": "binary", "zero_division": 0}
        else:
            kw = {"labels": labels, "average": "macro", "zero_division": 0}
        precision = skm.precision_score(y_true, y_pred, **kw)
        recall = skm.recall_score(y_true, y_pred, **kw)
        f1 = skm.f1_score(y_true, y_pred, **kw)
        auc = None
        if proba is not None and pos is not None and len(set(y_true.tolist())) == 2:
            auc = skm.roc_auc_score((y_true == pos).astype(int), proba)
    values, counts = np.unique(y_true, return_counts=True)
    baseline = float(counts.max()) / n
    cm = skm.confusion_matrix(y_true, y_pred, labels=labels)
    metrics: dict[str, Any] = {
        "n_samples": n,
        "accuracy": _r6(acc),
        "balanced_accuracy": _r6(bacc),
        "precision": _r6(precision),
        "recall": _r6(recall),
        "f1": _r6(f1),
        "roc_auc": _r6(auc) if auc is not None else None,
        "majority_baseline": _r6(baseline),
        "averaging": "binary" if pos is not None else "macro",
        "positive_class": pos,
        "confusion_matrix": {"labels": labels, "matrix": cm.tolist()},
        "class_distribution": {str(v): int(c) for v, c in zip(values, counts, strict=True)},
    }
    basis: dict[str, Any] = {
        "n_samples": n,
        "accuracy_pct": pct(acc, 1),
        "baseline_pct": pct(baseline, 1),
        "balanced_accuracy_pct": pct(bacc, 1),
        "precision_pct": pct(precision, 1),
        "recall_pct": pct(recall, 1),
        "f1_pct": pct(f1, 1),
    }
    text = (
        f"On the `{partition}` partition ({fmt(n)} rows) accuracy is {fmt(basis['accuracy_pct'])}% "
        f"against a majority-class baseline of {fmt(basis['baseline_pct'])}%. Balanced accuracy is "
        f"{fmt(basis['balanced_accuracy_pct'])}%."
    )
    if pos is not None:
        text += (
            f" For the positive class `{pos}`, precision is {fmt(basis['precision_pct'])}% and "
            f"recall is {fmt(basis['recall_pct'])}%."
        )
    else:
        text += f" Macro-averaged F1 is {fmt(basis['f1_pct'])}%."
    if auc is not None:
        basis["roc_auc"] = round(float(auc), 4)
        text += f" ROC AUC is {fmt(basis['roc_auc'])}."
    if acc < baseline:
        text += (
            " Accuracy is below always predicting the most common class, so judge this model on"
            " balanced accuracy and recall instead."
        )
    elif acc - baseline < 0.02:
        text += " The model barely beats always predicting the most common class."
    cells = [
        {"actual": a, "predicted": p, "count": int(cm[i][j])}
        for i, a in enumerate(labels)
        for j, p in enumerate(labels)
    ]
    spec = {
        "$schema": VEGA_LITE_SCHEMA,
        "title": "Confusion matrix",
        "data": {"values": cells},
        "encoding": {
            "x": {"field": "predicted", "type": "nominal", "sort": labels},
            "y": {"field": "actual", "type": "nominal", "sort": labels},
        },
        "layer": [
            {"mark": "rect", "encoding": {"color": {"field": "count", "type": "quantitative"}}},
            {"mark": {"type": "text"}, "encoding": {"text": {"field": "count", "type": "quantitative"}}},
        ],
    }
    return metrics, chart_artifact(spec, text, basis)


def _regression_report(
    y_true: np.ndarray[Any, Any], y_pred: np.ndarray[Any, Any], partition: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    n = len(y_true)
    r2 = skm.r2_score(y_true, y_pred) if n > 1 else float("nan")
    mae = skm.mean_absolute_error(y_true, y_pred)
    rmse = math.sqrt(skm.mean_squared_error(y_true, y_pred))
    metrics = {
        "n_samples": n,
        "r2": _r6(r2),
        "mae": _r6(mae),
        "rmse": _r6(rmse),
        "median_absolute_error": _r6(skm.median_absolute_error(y_true, y_pred)),
    }
    basis: dict[str, Any] = {"n_samples": n, "mae": round(mae, 4), "rmse": round(rmse, 4)}
    text = f"On the `{partition}` partition ({fmt(n)} rows)"
    if metrics["r2"] is not None:
        basis["r2"] = round(float(r2), 4)
        text += f" R-squared is {fmt(basis['r2'])},"
    text += f" mean absolute error is {fmt(basis['mae'])} and RMSE is {fmt(basis['rmse'])}."
    step = max(1, math.ceil(n / 1000))
    points = [
        {"actual": float(a), "predicted": float(p)}
        for a, p in zip(y_true[::step], y_pred[::step], strict=True)
    ]
    spec = {
        "$schema": VEGA_LITE_SCHEMA,
        "title": "Predicted vs actual",
        "data": {"values": points},
        "mark": {"type": "point", "opacity": 0.5},
        "encoding": {
            "x": {"field": "actual", "type": "quantitative"},
            "y": {"field": "predicted", "type": "quantitative"},
        },
    }
    return metrics, chart_artifact(spec, text, basis)
