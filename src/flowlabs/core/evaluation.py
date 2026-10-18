"""Scores and charts for a trained model, computed on rows it never saw."""

from __future__ import annotations

import math
import warnings
from typing import Any

import numpy as np
import pandas as pd

from .util import round_floats

HIGHER_IS_BETTER = {"accuracy", "balanced_accuracy", "f1_macro", "f1_weighted", "precision_macro", "recall_macro",
                    "roc_auc", "r2"}  # fmt: skip
METRIC_LABELS = {
    "accuracy": "Accuracy", "balanced_accuracy": "Balanced accuracy", "f1_macro": "F1 (macro)",
    "f1_weighted": "F1 (weighted)", "precision_macro": "Precision (macro)", "recall_macro": "Recall (macro)",
    "roc_auc": "ROC AUC", "log_loss": "Log loss", "r2": "R²", "rmse": "RMSE", "mae": "MAE", "mape": "MAPE",
}  # fmt: skip


def _downsample(xs: np.ndarray, ys: np.ndarray, points: int = 120) -> list[list[float]]:
    if len(xs) > points:
        index = np.unique(np.linspace(0, len(xs) - 1, points).astype(int))
        xs, ys = xs[index], ys[index]
    return [[round(float(x), 4), round(float(y), 4)] for x, y in zip(xs, ys, strict=True)]


def classification_metrics(
    y: np.ndarray, pred: np.ndarray, proba: np.ndarray | None, n_classes: int
) -> dict[str, float]:
    from sklearn import metrics as m

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        out = {
            "accuracy": m.accuracy_score(y, pred),
            "balanced_accuracy": m.balanced_accuracy_score(y, pred),
            "f1_macro": m.f1_score(y, pred, average="macro", zero_division=0),
            "f1_weighted": m.f1_score(y, pred, average="weighted", zero_division=0),
            "precision_macro": m.precision_score(y, pred, average="macro", zero_division=0),
            "recall_macro": m.recall_score(y, pred, average="macro", zero_division=0),
        }
        if proba is not None and len(np.unique(y)) > 1:
            labels = list(range(n_classes))
            try:
                if n_classes == 2:
                    out["roc_auc"] = m.roc_auc_score(y, proba[:, 1])
                else:
                    out["roc_auc"] = m.roc_auc_score(y, proba, multi_class="ovr", labels=labels)
            except ValueError:
                pass
            try:
                out["log_loss"] = m.log_loss(y, np.clip(proba, 1e-15, 1), labels=labels)
            except ValueError:
                pass
    return {k: float(v) for k, v in out.items() if v is not None and math.isfinite(float(v))}


def regression_metrics(y: np.ndarray, pred: np.ndarray) -> dict[str, float]:
    from sklearn import metrics as m

    y = np.asarray(y, dtype=float)
    pred = np.asarray(pred, dtype=float)
    out = {
        "r2": m.r2_score(y, pred) if len(y) > 1 else float("nan"),
        "rmse": math.sqrt(m.mean_squared_error(y, pred)),
        "mae": m.mean_absolute_error(y, pred),
    }
    nonzero = np.abs(y) > 1e-12
    if nonzero.any():
        out["mape"] = float(np.mean(np.abs((y[nonzero] - pred[nonzero]) / y[nonzero])) * 100)
    return {k: float(v) for k, v in out.items() if math.isfinite(float(v))}


def classification_details(
    y: np.ndarray, pred: np.ndarray, proba: np.ndarray | None, classes: list[str]
) -> dict[str, Any]:
    from sklearn import metrics as m

    n = len(classes)
    shown = list(range(n))
    if n > 25:  # keep the matrix readable: the most common classes
        shown = list(pd.Series(y).value_counts().index[:25])
    matrix = m.confusion_matrix(y, pred, labels=shown).tolist()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        precision, recall, f1, support = m.precision_recall_fscore_support(
            y, pred, labels=list(range(n)), zero_division=0
        )
    details: dict[str, Any] = {
        "confusion": {"labels": [classes[i] for i in shown], "matrix": matrix},
        "per_class": [
            {
                "label": classes[i],
                "precision": float(precision[i]),
                "recall": float(recall[i]),
                "f1": float(f1[i]),
                "support": int(support[i]),
            }
            for i in range(n)
        ],  # fmt: skip
    }
    if proba is not None and n == 2 and len(np.unique(y)) == 2:
        fpr, tpr, _ = m.roc_curve(y, proba[:, 1])
        prec, rec, _ = m.precision_recall_curve(y, proba[:, 1])
        details["roc"] = _downsample(fpr, tpr)
        details["pr"] = _downsample(rec[::-1], prec[::-1])
        details["positive_class"] = classes[1]
        # how well probabilities match reality: predicted vs observed share in 10 bins
        bins = np.clip((proba[:, 1] * 10).astype(int), 0, 9)
        details["calibration"] = [[round(float(proba[bins == b, 1].mean()), 3), round(float(y[bins == b].mean()), 3),
                                   int((bins == b).sum())] for b in range(10) if (bins == b).any()]  # fmt: skip
    if proba is not None and 2 <= n <= 8 and len(proba) == len(y):
        details["separation"] = separation(y, proba, classes)
    return round_floats(details, 4)


def separation(y: np.ndarray, proba: np.ndarray, classes: list[str], bins: int = 20) -> dict[str, Any]:
    """How far apart the classes sit in the model's probabilities: one histogram per true class.
    Two classes: the probability of the second class. More: the probability given to the true class."""
    edges = np.linspace(0, 1, bins + 1)
    y = np.asarray(y).astype(int)
    if len(classes) == 2:
        values, axis = proba[:, 1], f"probability of {classes[1]}"
    else:
        values, axis = (
            proba[np.arange(len(y)), np.clip(y, 0, proba.shape[1] - 1)],
            "probability given to the true class",
        )
    groups = [{"label": label, "counts": np.histogram(values[y == i], bins=edges)[0].tolist()}
              for i, label in enumerate(classes) if (y == i).any()]  # fmt: skip
    return {"axis": axis, "edges": edges.round(3).tolist(), "groups": groups}


def regression_details(y: np.ndarray, pred: np.ndarray) -> dict[str, Any]:
    y = np.asarray(y, dtype=float)
    pred = np.asarray(pred, dtype=float)
    rng = np.random.default_rng(0)
    index = rng.choice(len(y), size=min(400, len(y)), replace=False) if len(y) else np.array([], dtype=int)
    residuals = y - pred
    counts, edges = np.histogram(residuals, bins=24) if len(residuals) else (np.array([]), np.array([]))
    return round_floats({
        "scatter": [[float(y[i]), float(pred[i])] for i in index],
        "residual_histogram": {"edges": edges.tolist(), "counts": counts.tolist()},
        "range": [float(min(y.min(), pred.min())), float(max(y.max(), pred.max()))] if len(y) else [0, 1],
    }, 5)  # fmt: skip


def score(metric: str, values: dict[str, float]) -> float:
    """A number where higher is better, for ranking models."""
    value = values.get(metric)
    if value is None:
        return -math.inf
    return value if metric in HIGHER_IS_BETTER else -value


def native_importance(pipeline: Any, X: pd.DataFrame) -> list[dict[str, Any]]:
    """Importances the model itself reports (tree importances, absolute linear weights)."""
    model = pipeline.steps[-1][1]
    values = getattr(model, "feature_importances_", None)
    if values is None and hasattr(model, "coef_"):
        coef = np.asarray(model.coef_, dtype=float)
        values = np.abs(coef).mean(axis=0) if coef.ndim > 1 else np.abs(coef)
    if values is None:
        return []
    try:
        names = list(pipeline[:-1].transform(X.head(2)).columns)
    except Exception:  # noqa: BLE001 - the importance chart is optional
        return []
    values = np.asarray(values, dtype=float).reshape(-1)
    if len(names) != len(values):
        return []
    total = float(np.abs(values).sum()) or 1.0
    order = np.argsort(-np.abs(values))[:20]
    return [{"feature": str(names[i]), "value": round(float(values[i]) / total, 4)} for i in order]


def permutation_importance(model: Any, X: pd.DataFrame, y: np.ndarray, metric_fn: Any, rows: int = 1500,
                           repeats: int = 3, seed: int = 0) -> list[dict[str, Any]]:  # fmt: skip
    """How much the score drops when one input column is shuffled: the column's real influence."""
    rng = np.random.default_rng(seed)
    if len(X) > rows:
        index = rng.choice(len(X), size=rows, replace=False)
        X, y = X.iloc[index], y[index]
    X = X.reset_index(drop=True)
    base = metric_fn(model, X, y)
    found: list[dict[str, Any]] = []
    for column in X.columns:
        drops = []
        for _ in range(repeats):
            shuffled = X.copy()
            shuffled[column] = rng.permutation(shuffled[column].to_numpy())
            drops.append(base - metric_fn(model, shuffled, y))
        found.append({"feature": str(column), "value": round(float(np.mean(drops)), 5),
                      "std": round(float(np.std(drops)), 5)})  # fmt: skip
    found.sort(key=lambda f: -f["value"])
    return found[:25]
