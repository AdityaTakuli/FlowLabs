"""Train every model in a project and score it on held-out rows.

Order of work (the same order the canvas shows):

1. **Clean** the whole table (rows and columns), then drop rows without a target.
2. **Split** into training and test rows (stratified, random or by time).
3. **Training-set steps** (outlier removal, class balancing) touch training rows only.
4. Per model, a scikit-learn ``Pipeline``: clean columns → transforms → auto-prep → (auto-scale) →
   model. Everything learned is learned from training rows, so test scores are honest.
5. Optional tuning (random search with 3-fold cross-validation) and cross-validation.
6. Test-set scores, charts and feature importance; the fitted pipeline is saved as a
   ``SynapseModel`` that exports and predicts on raw rows.
"""

from __future__ import annotations

import copy
import io
import math
import time
import warnings
from collections.abc import Callable
from typing import Any

import numpy as np
import pandas as pd

import synapse_runtime as rt

from . import catalogue as cat
from . import datasets, env, evaluation
from . import project as projects
from .util import Cancelled, UserError, new_id, now, round_floats
from .workspace import Workspace

Emit = Callable[[dict[str, Any]], None]
TUNE_TRIALS = {"quick": 8, "thorough": 25}


class Job:
    """A running job: emits progress events and can be cancelled between steps."""

    def __init__(self, job_id: str, emit: Emit | None = None) -> None:
        self.id = job_id
        self._emit = emit
        self.cancelled = False

    def emit(self, kind: str, **payload: Any) -> None:
        if self._emit is not None:
            self._emit({"type": "job", "job_id": self.id, "kind": kind, **payload})

    def log(self, message: str) -> None:
        self.emit("log", message=message)

    def check(self) -> None:
        if self.cancelled:
            raise Cancelled()


# ----------------------------------------------------------------------------------- data prep


def prepare_split(project: dict[str, Any], raw: pd.DataFrame, cleaned: pd.DataFrame) -> dict[str, Any]:
    """Labelled rows split into train and test; X keeps the raw columns (the model's inputs)."""
    from sklearn.model_selection import train_test_split

    target, task = project["target"], project.get("task", "classification")
    data = cleaned.dropna(subset=[target])
    if task == "classification":
        labels = data[target]
        text = labels.astype(str)
        natives: dict[str, Any] = {}
        for value, key in zip(labels.tolist(), text.tolist(), strict=True):
            natives.setdefault(key, value.item() if isinstance(value, np.generic) else value)
        classes = sorted(natives)
        lookup = {c: i for i, c in enumerate(classes)}
        y = text.map(lookup).astype(int)
        class_values = [natives[c] for c in classes]
    else:
        y = pd.to_numeric(data[target], errors="coerce")
        y = y[y.notna()]
        data = data.loc[y.index]
        classes, class_values = [], []
    X = raw.loc[data.index].drop(columns=[target], errors="ignore")
    split = project.get("split") or {}
    test_size = float(split.get("test_size", 0.2))
    seed = int(split.get("seed", 42))
    time_column = split.get("time_column")
    if len(X) < 4:
        raise UserError("fewer than four labelled rows remain after cleaning")
    time_ordered = bool(time_column and time_column in raw.columns)
    if time_ordered:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            order_values = pd.to_datetime(raw.loc[X.index, time_column], errors="coerce", format="mixed")
        if order_values.isna().mean() > 0.5:
            order_values = pd.to_numeric(raw.loc[X.index, time_column], errors="coerce")
        order = np.argsort(order_values.to_numpy(), kind="stable")
        cut = int(round(len(order) * (1 - test_size)))
        train_index, test_index = X.index[order[:cut]], X.index[order[cut:]]
        X_train, X_test, y_train, y_test = X.loc[train_index], X.loc[test_index], y.loc[train_index], y.loc[test_index]
    else:
        shuffle = bool(split.get("shuffle", True))
        stratify = None
        if task == "classification" and split.get("stratify", True) and shuffle:
            counts = y.value_counts()
            n_test = math.ceil(len(y) * test_size)
            if counts.min() >= 2 and n_test >= len(counts) and len(y) - n_test >= len(counts):
                stratify = y
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=test_size, random_state=seed, shuffle=shuffle, stratify=stratify
        )
    if len(X_test) == 0 or len(X_train) < 2:
        raise UserError("the split left no test rows or too few training rows; adjust the test share")
    return {"X_train": X_train, "X_test": X_test, "y_train": y_train, "y_test": y_test, "classes": classes,
            "class_values": class_values, "time_ordered": time_ordered, "labelled": int(len(X))}  # fmt: skip


def row_steps(steps: list[dict[str, Any]], X: pd.DataFrame, y: pd.Series, project: dict[str, Any],
              cleaner: rt.CleanOps) -> tuple[pd.DataFrame, pd.Series, str]:  # fmt: skip
    """Apply training-set steps (outliers, class balance). Returns X, y and what happened."""
    seed = int((project.get("split") or {}).get("seed", 42))
    return rt.training_rows(steps, X, y, project.get("task", "classification"), seed, cleaner)


# ------------------------------------------------------------------------------------- models


def build_pipeline(project: dict[str, Any], entry: dict[str, Any], params: dict[str, Any], ctx: dict[str, Any]) -> Any:
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler

    algo = cat.ALGO_BY_ID[entry["algo"]]
    steps: list[tuple[str, Any]] = [("clean", rt.CleanOps(projects.enabled(project.get("clean"))))]
    transforms = projects.enabled(project.get("transform"))
    for index, step in enumerate(transforms):
        definition = cat.OPS[step["op"]]
        assert definition.build is not None
        step_params = step.get("params") or {}
        steps.append((f"t{index}_{step['op']}",
                      rt.ColumnStep(definition.build(step_params), step_params.get("columns"), step["op"])))  # fmt: skip
    if project.get("auto_prep", True):
        steps.append(("auto_prep", rt.AutoPrep()))
    if algo.needs_scaling and project.get("auto_prep", True) and not any(s["op"] == "scale" for s in transforms):
        steps.append(("auto_scale", rt.ColumnStep(StandardScaler(), ["@numeric"], "scaled")))
    if algo.id in ("xgboost", "lightgbm"):
        steps.append(("to_array", rt.ToArray()))
    steps.append(("model", algo.build(project["task"], params, ctx)))
    return Pipeline(steps)


def _predict(pipeline: Any, X: pd.DataFrame, task: str) -> tuple[np.ndarray, np.ndarray | None]:
    pred = np.asarray(pipeline.predict(X))
    proba = None
    if task == "classification" and hasattr(pipeline, "predict_proba"):
        try:
            proba = np.asarray(pipeline.predict_proba(X), dtype=float)
        except (AttributeError, NotImplementedError):
            proba = None
    return pred, proba


def _metrics(pipeline: Any, X: pd.DataFrame, y: np.ndarray, task: str, n_classes: int) -> dict[str, float]:
    pred, proba = _predict(pipeline, X, task)
    if task == "classification":
        if proba is not None and proba.shape[1] < n_classes:  # a class missing from training rows
            full = np.zeros((len(proba), n_classes))
            model = pipeline.steps[-1][1]
            columns = [int(c) for c in getattr(model, "classes_", range(proba.shape[1]))]
            full[:, columns] = proba
            proba = full
        return evaluation.classification_metrics(y, pred.astype(int), proba, n_classes)
    return evaluation.regression_metrics(y, pred)


def _folds(task: str, y: np.ndarray, folds: int, seed: int, ordered: bool) -> list[tuple[np.ndarray, np.ndarray]]:
    from sklearn.model_selection import KFold, StratifiedKFold, TimeSeriesSplit

    if ordered:
        return list(TimeSeriesSplit(n_splits=folds).split(y))
    if task == "classification" and np.bincount(y).min() >= folds:
        return list(StratifiedKFold(n_splits=folds, shuffle=True, random_state=seed).split(np.zeros(len(y)), y))
    return list(KFold(n_splits=folds, shuffle=True, random_state=seed).split(y))


def _cv_score(project: dict[str, Any], entry: dict[str, Any], params: dict[str, Any], ctx: dict[str, Any],
              X: pd.DataFrame, y: np.ndarray, folds: list[tuple[np.ndarray, np.ndarray]], metric: str,
              n_classes: int, job: Job) -> list[float]:  # fmt: skip
    scores = []
    for train_index, test_index in folds:
        job.check()
        pipeline = build_pipeline(project, entry, params, ctx)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            pipeline.fit(X.iloc[train_index], y[train_index])
        values = _metrics(pipeline, X.iloc[test_index], y[test_index], project["task"], n_classes)
        scores.append(values.get(metric, float("nan")))
    return scores


def _trials(algo: cat.Algo, base: dict[str, Any], count: int, seed: int) -> list[dict[str, Any]]:
    import itertools

    names = list(algo.search)
    grid = [dict(zip(names, combo, strict=True)) for combo in itertools.product(*(algo.search[n] for n in names))]
    rng = np.random.default_rng(seed)
    chosen = [grid[i] for i in rng.permutation(len(grid))[:count]]
    return [{**base, **combo} for combo in chosen]


def _schema(raw: pd.DataFrame, input_columns: list[str], used: list[str]) -> dict[str, Any]:
    columns = []
    for column in input_columns:
        series = raw[column]
        kind = rt.column_kind(series)
        entry: dict[str, Any] = {"name": column, "kind": kind, "used": column in used}
        values = series.dropna()
        if kind == "numeric" and len(values):
            numbers = pd.to_numeric(values, errors="coerce").dropna()
            entry.update(min=float(numbers.min()), max=float(numbers.max()), median=float(numbers.median()),
                         integer=bool((numbers % 1 == 0).all()))  # fmt: skip
        elif kind in ("categorical", "boolean"):
            entry["values"] = [str(v) for v in values.astype(str).value_counts().index[:60]]
        entry["example"] = values.iloc[0].item() if len(values) and isinstance(values.iloc[0], np.generic) else (
            values.iloc[0] if len(values) else None)  # fmt: skip
        if isinstance(entry["example"], pd.Timestamp):
            entry["example"] = entry["example"].isoformat()
        columns.append(entry)
    return {"columns": columns}


def used_inputs(project: dict[str, Any], input_columns: list[str]) -> list[str]:
    dropped: set[str] = set()
    for step in projects.enabled(project.get("clean")):
        if step["op"] == "drop_columns":
            dropped.update(step["params"].get("columns") or [])
    return [c for c in input_columns if c not in dropped]


# ---------------------------------------------------------------------------------------- run


def run(ws: Workspace, project: dict[str, Any], job: Job, packages: dict[str, Any] | None = None) -> dict[str, Any]:
    """Train the project's models. Writes ``runs/<project>/<run>/`` and returns the results."""
    packages = packages if packages is not None else env.packages()
    issues = [i for i in projects.check(ws, project, packages) if i["level"] == "error"]
    if issues:
        raise UserError(issues[0]["message"])
    if project.get("kind") == "image":
        from . import images

        return images.run(ws, project, job, packages)
    import joblib

    started, clock = now(), time.monotonic()
    run_id = new_id("r")
    run_dir = ws.runs / project["id"] / run_id
    (run_dir / "models").mkdir(parents=True, exist_ok=True)
    task, target = project["task"], project["target"]
    metric = projects.primary_metric(project)
    models = [m for m in project["models"] if m.get("enabled", True)]
    job.emit("started", run_id=run_id, models=[{"id": m["id"], "label": m.get("label") or m["algo"]} for m in models])

    job.emit("stage", stage="clean", message="Cleaning the table")
    raw = datasets.load_frame(ws, project["dataset_id"])
    clean_steps = projects.enabled(project.get("clean"))
    cleaner = rt.CleanOps(clean_steps)
    cleaned = cleaner.apply(raw, rows=True)
    job.check()
    job.emit("stage", stage="split", message="Splitting into training and test rows")
    split = prepare_split(project, raw, cleaned)
    X_train, y_train_series = split["X_train"], split["y_train"]
    X_test, y_test = split["X_test"], split["y_test"].to_numpy()
    row_message = ""
    row_ops = projects.enabled(project.get("rows"))
    if row_ops:
        job.emit("stage", stage="rows", message="Preparing the training rows")
        X_train, y_train_series, row_message = row_steps(row_ops, X_train, y_train_series, project, cleaner)
    y_train = y_train_series.to_numpy()
    n_classes = len(split["classes"])
    weighted = any(s["op"] == "balance_classes" and (s.get("params") or {}).get("method") == "class_weight"
                   for s in row_ops)  # fmt: skip
    uses_xgboost = any(m["algo"] == "xgboost" for m in models)
    ctx = {"n_jobs": 1 if env.in_browser() else -1, "class_weight": weighted,
           "device": "cuda" if uses_xgboost and any(g["kind"] == "cuda" for g in env.gpus()) else "cpu"}  # fmt: skip
    input_columns = [str(c) for c in raw.columns if c != target]
    used = used_inputs(project, input_columns)
    schema = _schema(raw, input_columns, used)
    folds_n = int((project.get("split") or {}).get("cv_folds") or 0)
    seed = int((project.get("split") or {}).get("seed", 42))
    results: list[dict[str, Any]] = []
    auto_report: list[dict[str, str]] = []
    features_out = None

    for index, entry in enumerate(models):
        job.check()
        algo = cat.ALGO_BY_ID[entry["algo"]]
        label = entry.get("label") or algo.label
        record: dict[str, Any] = {"id": entry["id"], "algo": algo.id, "label": label, "family": algo.family,
                                  "status": "running", "params": entry.get("params") or {}}  # fmt: skip
        job.emit("model", model_id=entry["id"], status="running", index=index, total=len(models), label=label)
        try:
            params = copy.deepcopy(entry.get("params") or {})
            fit_clock = time.monotonic()
            tune = entry.get("tune", "off")
            if tune in TUNE_TRIALS and algo.search:
                sub = X_train
                sub_y = y_train
                if len(sub) > 20_000:
                    pick = np.random.default_rng(seed).choice(len(sub), 20_000, replace=False)
                    sub, sub_y = sub.iloc[pick], sub_y[pick]
                folds = _folds(task, sub_y, 3, seed, split["time_ordered"])
                trials: list[dict[str, Any]] = []
                candidates = _trials(algo, params, TUNE_TRIALS[tune], seed)
                for number, candidate in enumerate(candidates, 1):
                    scores = _cv_score(project, entry, candidate, ctx, sub, sub_y, folds, metric, n_classes, job)
                    value = float(np.nanmean(scores)) if scores else float("nan")
                    tried = {k: candidate[k] for k in algo.search}
                    trials.append({"params": tried, "score": value})
                    job.emit("trial", model_id=entry["id"], trial=number, of=len(candidates), params=tried, score=value)
                ranked = [t for t in trials if math.isfinite(t["score"])]
                if ranked:
                    best_trial = max(ranked, key=lambda t: evaluation.score(metric, {metric: t["score"]}))
                    params.update(best_trial["params"])
                    record["best_params"] = best_trial["params"]
                record["trials"] = round_floats(trials)
            if folds_n >= 2:
                folds = _folds(task, y_train, folds_n, seed, split["time_ordered"])
                scores = _cv_score(project, entry, params, ctx, X_train, y_train, folds, metric, n_classes, job)
                finite = [s for s in scores if math.isfinite(s)]
                record["cv"] = round_floats({"metric": metric, "folds": scores,
                                             "mean": float(np.mean(finite)) if finite else None,
                                             "std": float(np.std(finite)) if finite else None})  # fmt: skip
            pipeline = build_pipeline(project, entry, params, ctx)
            model = pipeline.steps[-1][1]
            if algo.deep:
                epochs = int(params.get("epochs", 60))

                def on_epoch(epoch: int, values: dict[str, float], _id: str = entry["id"], _n: int = epochs) -> bool:
                    job.emit("epoch", model_id=_id, epoch=epoch, epochs=_n, metrics=round_floats(values))
                    return not job.cancelled

                model._on_epoch = on_epoch
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                pipeline.fit(X_train, y_train)
            job.check()
            record["fit_seconds"] = round(time.monotonic() - fit_clock, 3)
            if algo.deep:
                model._on_epoch = None
                record["history"] = round_floats(model.history_)
                record["backend"] = model.backend_
                record["device"] = getattr(model, "device_", "cpu")
                record["parameters"] = model.parameter_count()
            predict_clock = time.monotonic()
            pred, proba = _predict(pipeline, X_test, task)
            record["predict_ms_per_row"] = round(1000 * (time.monotonic() - predict_clock) / max(1, len(X_test)), 4)
            record["metrics"] = round_floats(_metrics(pipeline, X_test, y_test, task, n_classes))
            train_view = X_train if len(X_train) <= 5000 else X_train.sample(5000, random_state=seed)
            train_y = y_train if len(X_train) <= 5000 else y_train[X_train.index.get_indexer(train_view.index)]
            record["train_metrics"] = round_floats(_metrics(pipeline, train_view, train_y, task, n_classes))
            if task == "classification":
                if proba is not None and proba.shape[1] < n_classes:
                    full = np.zeros((len(proba), n_classes))
                    full[:, [int(c) for c in model.classes_]] = proba
                    proba = full
                record["details"] = evaluation.classification_details(y_test, pred.astype(int), proba,
                                                                      [str(c) for c in split["classes"]])  # fmt: skip
            else:
                record["details"] = evaluation.regression_details(y_test, pred)
            if "auto_prep" in pipeline.named_steps and not auto_report:
                auto_report = pipeline.named_steps["auto_prep"].report_
            if features_out is None:
                try:
                    features_out = int(pipeline[:-1].transform(X_test.head(2)).shape[1])
                except Exception:  # noqa: BLE001
                    features_out = None
            importance: dict[str, Any] = {"native": evaluation.native_importance(_named(pipeline), X_test)}
            if algo.id != "baseline":
                job.emit(
                    "model", model_id=entry["id"], status="explaining", index=index, total=len(models), label=label
                )
                scorer = _Scorer(task, n_classes, metric)
                importance["permutation"] = evaluation.permutation_importance(pipeline, X_test[used], y_test, scorer)
            record["importance"] = importance
            synapse_model = rt.SynapseModel(
                pipeline, task, target, input_columns, split["class_values"] or None, schema,
                {"project_id": project["id"], "project": project["name"], "run_id": run_id, "model_id": entry["id"],
                 "model_label": label, "algo": algo.id, "params": params, "metric": metric,
                 "metrics": record["metrics"], "trained_at": now(), "packages": env.packages()},
            )  # fmt: skip
            buffer = io.BytesIO()
            joblib.dump(synapse_model, buffer, compress=3)
            artifact = run_dir / "models" / f"{entry['id']}.joblib"
            artifact.write_bytes(buffer.getvalue())
            record["artifact"] = ws.relative(artifact)
            record["size_kb"] = round(len(buffer.getvalue()) / 1024, 1)
            record["status"] = "done"
        except Cancelled:
            record["status"] = "cancelled"
            results.append(record)
            job.emit("model", model_id=entry["id"], status="cancelled", index=index, total=len(models), label=label)
            raise
        except Exception as error:  # noqa: BLE001 - one failing model must not stop the others
            record["status"] = "failed"
            record["error"] = _friendly(error)
        results.append(record)
        job.emit("model", model_id=entry["id"], status=record["status"], index=index, total=len(models), label=label,
                 metrics=record.get("metrics"), error=record.get("error"))  # fmt: skip

    done = [r for r in results if r["status"] == "done"]
    best = max(done, key=lambda r: evaluation.score(metric, r["metrics"]), default=None) if done else None
    if best and best["algo"] == "baseline" and len(done) > 1:
        others = [r for r in done if r["algo"] != "baseline"]
        best = max(others, key=lambda r: evaluation.score(metric, r["metrics"]))
    warnings_found = _result_warnings(done, best, metric, task, split)
    result = {
        "id": run_id, "project_id": project["id"], "status": "completed" if done else "failed",
        "started": started, "finished": now(), "seconds": round(time.monotonic() - clock, 2), "task": task,
        "target": target, "metric": metric, "metric_label": evaluation.METRIC_LABELS.get(metric, metric),
        "classes": [str(c) for c in split["classes"]], "best_model_id": best["id"] if best else None,
        "data": {"rows": int(len(raw)), "labelled": split["labelled"], "train_rows": int(len(X_train)),
                 "test_rows": int(len(X_test)), "features_in": len(used), "features_out": features_out,
                 "auto_prep": auto_report, "row_steps": row_message, "time_ordered": split["time_ordered"],
                 "train_classes": (np.bincount(y_train, minlength=n_classes).tolist() if task == "classification" else None)},
        "models": results, "warnings": warnings_found, "project": project, "schema": schema,
        "engine": {"python": env.info(probe_gpu=False)["python"], "browser": env.in_browser()},
    }  # fmt: skip
    ws.write_json(run_dir / "results.json", result)
    stored = projects.get(ws, project["id"]) if projects.project_path(ws, project["id"]).is_file() else project
    stored["last_run"] = run_id
    projects.save(ws, stored)
    job.emit("done", run_id=run_id, best_model_id=result["best_model_id"])
    return result


def _named(pipeline: Any) -> Any:
    """The pipeline without the ToArray step, so importances keep column names."""
    if "to_array" not in pipeline.named_steps:
        return pipeline
    from sklearn.pipeline import Pipeline

    return Pipeline([s for s in pipeline.steps if s[0] != "to_array"][:-1] + [pipeline.steps[-1]])


class _Scorer:
    """``scorer(pipeline, X, y)``: the run's metric, higher is better."""

    def __init__(self, task: str, n_classes: int, metric: str) -> None:
        self.task, self.n_classes, self.metric = task, n_classes, metric

    def __call__(self, pipeline: Any, X: pd.DataFrame, y: np.ndarray) -> float:
        values = _metrics(pipeline, X, y, self.task, self.n_classes)
        value = evaluation.score(self.metric, values)
        if not math.isfinite(value):
            value = evaluation.score("accuracy" if self.task == "classification" else "r2", values)
        return value


def _result_warnings(done: list[dict[str, Any]], best: dict[str, Any] | None, metric: str, task: str,
                     split: dict[str, Any]) -> list[str]:  # fmt: skip
    found = []
    if best is None:
        return ["No model finished training. Open a model to see its error."]
    baseline = next((r for r in done if r["algo"] == "baseline"), None)
    best_value = best["metrics"].get(metric)
    if baseline and best is not baseline and best_value is not None:
        base_value = baseline["metrics"].get(metric)
        if base_value is not None and evaluation.score(metric, {metric: best_value}) - evaluation.score(
            metric, {metric: base_value}
        ) < 0.02 * max(1.0, abs(base_value)):
            found.append(
                "The best model barely beats guessing. The features may not hold enough signal for this target."
            )
    train_value = (best.get("train_metrics") or {}).get(metric)
    if train_value is not None and best_value is not None and metric in evaluation.HIGHER_IS_BETTER:
        if train_value - best_value > 0.15:
            found.append(f"{best['label']} scores much better on training rows ({train_value:.2f}) than on test rows "
                         f"({best_value:.2f}): it is overfitting. Try a simpler model, more data, or regularization.")  # fmt: skip
    if best_value is not None and metric in ("accuracy", "f1_macro", "roc_auc", "r2") and best_value > 0.995:
        found.append("Near-perfect test score. Check that no column gives away the answer (data leakage).")
    if len(split["X_test"]) < 50:
        found.append(f"Only {len(split['X_test'])} test rows: scores can swing a lot. Use cross-validation.")
    return found


def _friendly(error: Exception) -> str:
    text = str(error) or type(error).__name__
    if isinstance(error, MemoryError):
        return "Out of memory. Use a sample of the rows or a lighter model."
    if "could not convert string to float" in text or "dtype('O')" in text:
        return "This model needs numbers only. Turn on Auto-prep or add an Encode categories step."
    if "Input contains NaN" in text or "NaN" in text and "missing" not in text:
        return "This model cannot handle missing values. Turn on Auto-prep or add a Fill missing values step."
    return text[:500]


# ---------------------------------------------------------------------------------- run access


def list_runs(ws: Workspace, project_id: str) -> list[dict[str, Any]]:
    found = []
    for path in sorted((ws.runs / project_id).glob("*/results.json"), reverse=True):
        try:
            result = ws.read_json(path)
        except ValueError:
            continue
        best = next((m for m in result["models"] if m["id"] == result.get("best_model_id")), None)
        found.append({"id": result["id"], "status": result["status"], "finished": result.get("finished"),
                      "seconds": result.get("seconds"), "metric": result.get("metric"),
                      "metric_label": result.get("metric_label"), "best_label": best["label"] if best else None,
                      "best_value": (best or {}).get("metrics", {}).get(result.get("metric", ""), None),
                      "models": len(result["models"])})  # fmt: skip
    return found


def get_run(ws: Workspace, project_id: str, run_id: str) -> dict[str, Any]:
    path = ws.runs / project_id / run_id / "results.json"
    if not path.is_file():
        raise UserError("run not found")
    return dict(ws.read_json(path))


def delete_run(ws: Workspace, project_id: str, run_id: str) -> None:
    ws.remove(ws.runs / project_id / run_id)


def load_model(ws: Workspace, project_id: str, run_id: str, model_id: str) -> Any:
    import joblib

    result = get_run(ws, project_id, run_id)
    record = next((m for m in result["models"] if m["id"] == model_id), None)
    if record is None or not record.get("artifact"):
        raise UserError("that model did not finish training")
    return joblib.load(ws.inside(record["artifact"]))
