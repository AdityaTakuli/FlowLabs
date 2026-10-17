"""Projects: one dataset, one target, and the pipeline that turns them into models.

A project is plain JSON (``projects/<id>.json``)::

    {"id", "name", "kind": "tabular" | "image", "dataset_id", "target", "task",
     "clean":     [{"id", "op", "params", "enabled"}],      # whole table, before the split
     "split":     {"test_size", "stratify", "shuffle", "seed", "time_column", "cv_folds"},
     "rows":      [{"id", "op", "params", "enabled"}],      # training rows only
     "transform": [{"id", "op", "params", "enabled"}],      # learned from training rows
     "auto_prep": true,
     "models":    [{"id", "algo", "params", "tune", "enabled", "label"}],
     "metric":    "auto",
     "image":     {...image preprocessing...}}

Learned steps are always fitted on the training rows only, so preprocessing cannot leak test data
into training. That is what makes the scores on the Results page honest.
"""

from __future__ import annotations

import copy
from typing import Any

import pandas as pd

import flowlabs_runtime as rt

from . import catalogue as cat
from . import datasets
from .util import UserError, jsonable, new_id, now
from .workspace import Workspace

CLASSIFICATION_METRICS = [("auto", "Automatic"), ("f1_macro", "F1 (macro)"), ("accuracy", "Accuracy"),
                          ("balanced_accuracy", "Balanced accuracy"), ("roc_auc", "ROC AUC"),
                          ("precision_macro", "Precision (macro)"), ("recall_macro", "Recall (macro)"),
                          ("log_loss", "Log loss")]  # fmt: skip
REGRESSION_METRICS = [("auto", "Automatic"), ("r2", "R²"), ("rmse", "RMSE"), ("mae", "MAE"), ("mape", "MAPE")]

DEFAULT_MODELS = {
    "classification": ["baseline", "logistic_regression", "random_forest", "hist_gradient_boosting"],
    "regression": ["baseline", "linear_regression", "random_forest", "hist_gradient_boosting"],
}


def _step(stage: str, op: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    definition = cat.OPS[op]
    merged = {**cat.defaults(definition.params), **(params or {})}
    return {"id": new_id(stage[0]), "op": op, "params": merged, "enabled": True}


def model_entry(algo_id: str, params: dict[str, Any] | None = None, image: bool = False) -> dict[str, Any]:
    if image:
        definition = next((m for m in cat.IMAGE_ALGOS if m["id"] == algo_id), None)
        if definition is None:
            raise UserError(f"unknown image model {algo_id}")
        label, defaults = definition["label"], cat.defaults(definition["params"])
    else:
        if algo_id not in cat.ALGO_BY_ID:
            raise UserError(f"unknown model {algo_id}")
        algo = cat.ALGO_BY_ID[algo_id]
        label, defaults = algo.label, cat.defaults(algo.params)
    return {"id": new_id("m"), "algo": algo_id, "label": label, "params": {**copy.deepcopy(defaults), **(params or {})},
            "tune": "off", "enabled": True}  # fmt: skip


def new_project(ws: Workspace, dataset_id: str, name: str | None = None, target: str | None = None,
                packages: dict[str, Any] | None = None) -> dict[str, Any]:  # fmt: skip
    """A ready-to-train project, with the safe fixes from the data profile already added."""
    meta = datasets.get_meta(ws, dataset_id)
    project: dict[str, Any] = {
        "id": new_id("p"), "name": name or meta["name"], "kind": meta["kind"], "dataset_id": dataset_id,
        "created": now(), "updated": now(), "clean": [], "rows": [], "transform": [], "auto_prep": True,
        "split": {"test_size": 0.2, "stratify": True, "shuffle": True, "seed": 42, "time_column": None, "cv_folds": 0},
        "metric": "auto", "models": [], "notes": [],
    }  # fmt: skip
    if meta["kind"] == "image":
        project.update(target="label", task="classification", image=cat.defaults(cat.IMAGE_PREP))
        have_torchvision = bool((packages or {}).get("torchvision"))
        side = _image_side(ws, dataset_id)
        if side and side < 64:  # tiny images: a small CNN beats ImageNet features, and trains in seconds
            project["image"]["size"] = max(16, min(32, side))
            project["notes"].append(
                f"Images are small ({side}px), so a custom CNN at {project['image']['size']}px is the default."
            )
        use_pretrained = have_torchvision and not (side and side < 64)
        project["models"] = [model_entry("pretrained" if use_pretrained else "cnn", image=True)]
        return save(ws, project)
    frame = datasets.load_frame(ws, dataset_id)
    chosen = target if target in frame.columns else (meta.get("sample") or {}).get("target")
    chosen = chosen if chosen in frame.columns else datasets.guess_target(frame)
    project["target"] = chosen
    project["task"] = datasets.guess_task(frame[chosen])
    rows = len(frame)
    columns = [datasets.profile_column(frame[c], rows) for c in frame.columns]
    for suggestion in datasets.suggestions(frame, columns, chosen):
        fix = suggestion.get("fix")
        if suggestion.get("auto") and fix and fix["stage"] == "clean":
            step = _step("clean", fix["op"], fix["params"])
            step["note"] = suggestion["message"]
            project["clean"].append(step)
            project["notes"].append(f"Added “{cat.OPS[fix['op']].label}”: {suggestion['message']}")
    order = {"change_type": 0, "clean_text": 1, "drop_columns": 2, "extract_datetime": 3}
    project["clean"].sort(key=lambda s: order.get(s["op"], 9))
    project["models"] = [model_entry(a) for a in DEFAULT_MODELS[project["task"]]]
    if rows > 50_000:  # SVMs and k-NN get slow; the defaults are all fine at this size
        project["notes"].append("Large dataset: tree models and gradient boosting are the quickest to train.")
    return save(ws, project)


def _image_side(ws: Workspace, dataset_id: str) -> int | None:
    """The shorter side of the first image, or None when it cannot be read."""
    try:
        from PIL import Image

        files = next(iter(datasets.image_classes(datasets.image_root(ws, dataset_id)).values()))
        with Image.open(files[0]) as image:
            return int(min(image.size))
    except Exception:  # noqa: BLE001 - only a hint for defaults
        return None


def project_path(ws: Workspace, project_id: str) -> Any:
    return ws.projects / f"{project_id}.json"


def get(ws: Workspace, project_id: str) -> dict[str, Any]:
    path = project_path(ws, project_id)
    if not path.is_file():
        raise UserError("project not found; it may have been deleted")
    return dict(ws.read_json(path))


def save(ws: Workspace, project: dict[str, Any]) -> dict[str, Any]:
    if not project.get("id"):
        raise UserError("a project needs an id")
    project["updated"] = now()
    ws.write_json(project_path(ws, project["id"]), project)
    return project


def list_projects(ws: Workspace) -> list[dict[str, Any]]:
    found = []
    for path in ws.projects.glob("*.json"):
        try:
            project = ws.read_json(path)
        except ValueError:
            continue
        summary = {k: project.get(k) for k in ("id", "name", "kind", "dataset_id", "target", "task", "created",
                                               "updated", "last_run")}  # fmt: skip
        summary["models"] = len(project.get("models", []))
        summary["best"] = _best_of_last_run(ws, project)
        found.append(summary)
    return sorted(found, key=lambda p: p.get("updated") or "", reverse=True)


def _best_of_last_run(ws: Workspace, project: dict[str, Any]) -> dict[str, Any] | None:
    """The best model of the latest run, for project cards: label, metric and value."""
    run_id = project.get("last_run")
    if not run_id:
        return None
    path = ws.runs / project["id"] / run_id / "results.json"
    try:
        result = ws.read_json(path)
    except (OSError, ValueError):
        return None
    best = next((m for m in result.get("models", []) if m.get("id") == result.get("best_model_id")), None)
    if best is None:
        return None
    metric = result.get("metric")
    return {"label": best.get("label"), "metric": metric, "metric_label": result.get("metric_label"),
            "value": (best.get("metrics") or {}).get(metric), "finished": result.get("finished")}  # fmt: skip


def delete(ws: Workspace, project_id: str) -> None:
    ws.remove(project_path(ws, project_id))
    ws.remove(ws.runs / project_id)
    ws.remove(ws.exports / project_id)


def duplicate(ws: Workspace, project_id: str) -> dict[str, Any]:
    project = copy.deepcopy(get(ws, project_id))
    project.update(id=new_id("p"), name=f"{project['name']} (copy)", created=now(), last_run=None)
    return save(ws, project)


# ------------------------------------------------------------------------------------- checks


def enabled(steps: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    return [s for s in steps or [] if s.get("enabled", True)]


def _columns_used(step: dict[str, Any]) -> list[str]:
    params = step.get("params") or {}
    used: list[str] = []
    for key in ("columns",):
        used += [c for c in params.get(key) or [] if isinstance(c, str) and not c.startswith("@")]
    for key in ("column", "a", "b"):
        if isinstance(params.get(key), str) and params.get(key):
            used.append(params[key])
    return used


def primary_metric(project: dict[str, Any]) -> str:
    metric = project.get("metric") or "auto"
    if metric != "auto":
        return str(metric)
    return "f1_macro" if project.get("task") == "classification" else "r2"


def check(ws: Workspace, project: dict[str, Any], packages: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Problems that would stop training (errors) or weaken the result (warnings)."""
    issues: list[dict[str, Any]] = []

    def add(level: str, stage: str, message: str, step: str | None = None) -> None:
        issues.append({"level": level, "stage": stage, "message": message, "step": step})

    packages = packages or {}
    models = [m for m in project.get("models", []) if m.get("enabled", True)]
    if not models:
        add("error", "models", "Add at least one model to train.")
    split = project.get("split") or {}
    test_size = float(split.get("test_size", 0.2))
    if not 0.05 <= test_size <= 0.6:
        add("error", "split", "Keep between 5% and 60% of rows for testing.")
    if project.get("kind") == "image":
        if not packages.get("torch"):
            add("error", "models", "Image models need PyTorch. Connect an engine with PyTorch installed (Engine menu).")
        for model in models:
            if model["algo"] == "pretrained" and not packages.get("torchvision"):
                add("error", "models", "Pretrained networks need torchvision in this engine.", model["id"])
            size = int((project.get("image") or {}).get("size", 64))
            if model["algo"] == "pretrained" and size < 64:
                add("warning", "prep", "Pretrained networks work best with images of at least 96 pixels.")
        meta = datasets.get_meta(ws, project["dataset_id"])
        if min((meta.get("classes") or {"": 0}).values()) < 2:
            add("error", "data", "Every class needs at least two images.")
        return issues

    for model in models:
        algo = cat.ALGO_BY_ID.get(model["algo"])
        if algo is None:
            add("error", "models", f"Unknown model {model['algo']}.", model["id"])
            continue
        if project.get("task") not in algo.tasks:
            add("error", "models", f"{algo.label} cannot do {project.get('task')}.", model["id"])
        if not cat.algo_available(algo, packages):
            add("error", "models", f"{algo.label} needs the {algo.needs} package in this engine.", model["id"])
        if algo.id == "svm" and int(datasets.get_meta(ws, project["dataset_id"]).get("rows", 0)) > 20_000:
            add("warning", "models", "SVMs get very slow above 20,000 rows.", model["id"])
        if algo.deep and model["params"].get("backend") == "torch" and not packages.get("torch"):
            add("error", "models", "PyTorch is not installed in this engine; set Train with to NumPy.", model["id"])
    frame = datasets.load_frame(ws, project["dataset_id"])
    target = project.get("target")
    if target not in frame.columns:
        add("error", "data", "Choose the column to predict (the target).")
        return issues
    task = project.get("task")
    sample = frame.head(500)
    columns = set(sample.columns)
    for step in enabled(project.get("clean")):
        missing = [c for c in _columns_used(step) if c not in columns]
        if missing:
            add(
                "error",
                "clean",
                f"“{cat.OPS[step['op']].label}” uses {', '.join(missing)}, which no longer exist.",
                step["id"],
            )
        if step["op"] == "drop_columns" and target in (step["params"].get("columns") or []):
            add("error", "clean", f"This step drops the target column {target}.", step["id"])
        if step["op"] == "combine_columns" and target in (step["params"].get("a"), step["params"].get("b")):
            add("error", "clean", "A feature built from the target leaks the answer into the model.", step["id"])
        if step["op"] == "combine_columns" and not (step["params"].get("a") and step["params"].get("b")):
            add("error", "clean", "Choose both columns to combine.", step["id"])
        if step["op"] in ("filter_rows", "replace_values") and not step["params"].get("column"):
            add("error", "clean", "Choose a column for this step.", step["id"])
        try:
            sample = rt.apply_clean_op(sample, step["op"], step.get("params") or {}, rows=True)
        except Exception as error:  # noqa: BLE001 - reported to the user
            add("error", "clean", f"“{cat.OPS[step['op']].label}” failed: {error}", step["id"])
        columns = set(sample.columns)
    if target not in columns:
        add("error", "clean", f"The target {target} is removed by a Clean step.")
        return issues
    features = [c for c in columns if c != target]
    if not features:
        add("error", "clean", "No feature columns are left to learn from.")
    y = frame[target].dropna()
    if task == "classification":
        counts = y.astype(str).value_counts()
        if len(counts) < 2:
            add("error", "data", f"{target} has only one value; there is nothing to predict.")
        elif len(counts) > 100:
            add("warning", "data", f"{target} has {len(counts)} different values. Is this a regression problem?")
        if len(counts) and counts.min() < 2 and split.get("stratify", True):
            add("warning", "split", "Some classes have a single row, so the split cannot keep class shares.")
    elif not rt.is_numeric_series(frame[target]):
        converted = pd.to_numeric(frame[target], errors="coerce")
        if converted.notna().mean() < 0.9:
            add(
                "error",
                "data",
                f"{target} is not numeric, so it cannot be predicted with regression. Switch to classification.",
            )
    if len(y) < 30:
        add("warning", "data", "Fewer than 30 labelled rows: scores will be unreliable.")
    if split.get("time_column") and split["time_column"] not in frame.columns:
        add("error", "split", "The column used to order rows by time no longer exists.")
    for step in enabled(project.get("transform")):
        missing = [c for c in _columns_used(step) if c not in columns]
        if missing:
            add("warning", "transform", f"“{cat.OPS[step['op']].label}” skips {', '.join(missing)}, which no longer exist.",
                step["id"])  # fmt: skip
    if not project.get("auto_prep", True):
        text = [c for c in features if not (rt.is_numeric_series(sample[c]) or rt.is_bool_series(sample[c]))]
        if text:
            add("warning", "transform", "Auto-prep is off and some columns are not numbers; most models will fail.")
    for step in enabled(project.get("rows")):
        if step["op"] == "balance_classes" and task != "classification":
            add("error", "rows", "Balancing classes only applies to classification.", step["id"])
    metric = primary_metric(project)
    valid = {m for m, _ in (CLASSIFICATION_METRICS if task == "classification" else REGRESSION_METRICS)}
    if metric not in valid:
        add("error", "models", f"{metric} is not a {task} metric.")
    return issues


# ------------------------------------------------------------------------------------ preview


def _same_values(a: pd.Series, b: pd.Series) -> bool:
    if len(a) != len(b):
        return False
    left, right = a.reset_index(drop=True), b.reset_index(drop=True)
    try:
        if rt.is_numeric_series(left) and rt.is_numeric_series(right):
            return bool(((left == right) | (left.isna() & right.isna())).all())
        return bool(((left.astype(str) == right.astype(str)) | (left.isna() & right.isna())).all())
    except (TypeError, ValueError):
        return False


def _column_states(before: pd.DataFrame, after: pd.DataFrame) -> list[dict[str, Any]]:
    rows_changed = len(before) != len(after)  # row steps: columns themselves are untouched
    states = []
    for column in after.columns:
        if column not in before.columns:
            state = "added"
        elif rows_changed or _same_values(before[column], after[column]):
            state = "same"
        else:
            state = "changed"
        states.append({"name": str(column), "state": state, "kind": rt.column_kind(after[column])})
    removed = [{"name": str(c), "state": "removed", "kind": rt.column_kind(before[c])} for c in before.columns
               if c not in after.columns]  # fmt: skip
    return states + removed


def preview(ws: Workspace, project: dict[str, Any], step_id: str | None, limit: int = 30) -> dict[str, Any]:
    """The table before and after one step, so each step's effect is visible.

    Clean steps run on the whole table. Training-set steps and transforms run on the training rows
    after a split, exactly as in training.
    """
    from .training import prepare_split, row_steps

    if project.get("kind") == "image":
        raise UserError("previews are for tables")
    frame = datasets.load_frame(ws, project["dataset_id"])
    if len(frame) > 50_000:
        frame = frame.sample(50_000, random_state=0)
    target = project.get("target")
    clean = enabled(project.get("clean"))
    before = frame
    current = frame
    note = ""

    def result(before: pd.DataFrame, after: pd.DataFrame, title: str) -> dict[str, Any]:
        shown = after.head(limit)
        return {"title": title, "note": note, "before_shape": list(before.shape), "after_shape": list(after.shape),
                "columns": _column_states(before, after), "header": [str(c) for c in shown.columns],
                "rows": [[jsonable(v) for v in row] for row in shown.itertuples(index=False, name=None)]}  # fmt: skip

    if step_id in (None, "dataset"):
        return result(frame, frame, "Dataset")
    for step in clean:
        before = current
        current = rt.apply_clean_op(current, step["op"], step.get("params") or {}, rows=True)
        if step["id"] == step_id:
            return result(before, current, cat.OPS[step["op"]].label)
    if target not in current.columns:
        raise UserError("the target column is missing after the Clean steps")
    split = prepare_split(project, frame, current)
    X_train, y_train = split["X_train"], split["y_train"]
    cleaner = rt.CleanOps(clean)
    prepared = cleaner.transform(X_train)
    if step_id == "split":
        note = (f"{len(split['X_train'])} training rows, {len(split['X_test'])} test rows"
                f"{' (ordered by time)' if split['time_ordered'] else ''}.")  # fmt: skip
        return result(prepared, prepared, "Split")
    for step in enabled(project.get("rows")):
        before = prepared
        X_train, y_train, message = row_steps([step], X_train, y_train, project, cleaner)
        prepared = cleaner.transform(X_train)
        if step["id"] == step_id:
            note = message
            return result(before, prepared, cat.OPS[step["op"]].label)
    current_frame = prepared
    for step in enabled(project.get("transform")):
        definition = cat.OPS[step["op"]]
        assert definition.build is not None
        transformer = rt.ColumnStep(
            definition.build(step.get("params") or {}), step["params"].get("columns"), step["op"]
        )
        before = current_frame
        current_frame = transformer.fit(current_frame, y_train.to_numpy()).transform(current_frame)
        if step["id"] == step_id:
            if not transformer.columns_:
                note = "No columns matched this step's selection, so it changes nothing."
            return result(before, current_frame, definition.label)
    if step_id == "auto_prep":
        auto = rt.AutoPrep().fit(current_frame)
        after = auto.transform(current_frame)
        out = result(current_frame, after, "Auto-prep")
        out["report"] = auto.report_
        return out
    raise UserError("that step is not in the pipeline any more")
