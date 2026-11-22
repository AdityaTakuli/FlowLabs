"""What the AI panel may change in a machine learning project, and how its proposals are checked.

The model sees the project (target, metric, every step and model with its id and settings) and the
catalogue of steps and models it may add, each with its settings' names and allowed values. It
answers with "project" actions; this module keeps only those that name a real step, model or
setting, coerces every value to its parameter's type and range, and labels each for the panel.
The page then applies them with the same calls the Pipeline tab uses, so a change by the AI is
indistinguishable from one made by hand, and each can be undone.
"""

from __future__ import annotations

import json
from typing import Any

from . import catalogue as cat
from .project import CLASSIFICATION_METRICS, REGRESSION_METRICS

CHANGES = ("add_step", "add_model", "update", "remove", "settings", "train")
STAGE_NAMES = {"clean": "Clean", "rows": "Training rows", "transform": "Transform"}
TUNE_LEVELS = ("off", "quick", "thorough")
MAX_PROJECT_ACTIONS = 12
SKIP_TYPES = ("code",)  # code is edited in the Python view, never written by the assistant in one line


def _param_text(param: dict[str, Any]) -> str:
    kind = param["type"]
    if kind == "select":
        values = "|".join(json.dumps(o["value"]) for o in param.get("options", []))
        return f"{param['name']}: one of {values}"
    if kind in ("int", "float"):
        return f"{param['name']}: {kind} {param.get('min')}..{param.get('max')} (default {param.get('default')})"
    if kind == "columns":
        return f"{param['name']}: list of column names (or @numeric, @categorical, @all)"
    if kind == "column":
        return f"{param['name']}: one column name"
    if kind == "layers":
        types = ", ".join(param.get("layer_types", []))
        return f'{param["name"]}: list of layers such as {{"type": "dense", "units": 64, "activation": "relu"}} (types: {types})'
    return f"{param['name']}: {kind}"


def _entry_text(identifier: str, label: str, params: list[dict[str, Any]]) -> str:
    shown = [_param_text(p) for p in params if p["type"] not in SKIP_TYPES]
    return f"  - {identifier} ({label})" + (f": {'; '.join(shown)}" if shown else "")


def _algos(project: dict[str, Any], packages: dict[str, Any]) -> list[tuple[str, str, list[dict[str, Any]]]]:
    if project.get("kind") == "image":
        return [(m["id"], m["label"], m["params"]) for m in cat.IMAGE_ALGOS if packages.get(m["needs"])]
    task = project.get("task")
    return [
        (a.id, a.label, a.params)
        for a in cat.ALGOS
        if task in a.tasks and cat.algo_available(a, packages) and a.id != "custom_model"
    ]


def _metrics(project: dict[str, Any]) -> list[str]:
    table = REGRESSION_METRICS if project.get("task") == "regression" else CLASSIFICATION_METRICS
    return [identifier for identifier, _ in table]


def describe(project: dict[str, Any], packages: dict[str, Any]) -> str:
    """The project and everything that can be added to it, for the prompt."""
    lines = [f'Project "{project.get("name")}": {project.get("task")} of "{project.get("target") or "(none)"}", '
             f'metric {project.get("metric")}, kind {project.get("kind")}.']  # fmt: skip
    for stage, name in STAGE_NAMES.items():
        steps = project.get(stage) or []
        if steps:
            lines.append(f"{name} steps, in order:")
            for step in steps:
                op = cat.OPS.get(step.get("op"))
                params = {
                    k: v for k, v in (step.get("params") or {}).items() if not isinstance(v, str) or "\n" not in v
                }
                state = "" if step.get("enabled", True) else " (off)"
                lines.append(
                    f"  - id {step['id']}: {op.label if op else step.get('op')}{state} {json.dumps(params)[:300]}"
                )
    lines.append("Models:")
    for model in project.get("models") or []:
        params = {k: v for k, v in (model.get("params") or {}).items() if not isinstance(v, str) or "\n" not in v}
        state = "" if model.get("enabled", True) else " (off)"
        tune = "" if model.get("tune", "off") == "off" else f" tuning {model['tune']}"
        lines.append(f"  - id {model['id']}: {model.get('label')}{state}{tune} {json.dumps(params)[:300]}")
    if project.get("kind") != "image":
        for stage, name in STAGE_NAMES.items():
            ops = [op for op in cat.OPS.values() if op.stage == stage and not op.id.startswith("custom_")]
            lines.append(f"{name} steps you can add (stage {stage}):")
            lines.extend(_entry_text(op.id, op.label, op.params) for op in ops)
    lines.append("Models you can add:")
    lines.extend(_entry_text(identifier, label, params) for identifier, label, params in _algos(project, packages))
    lines.append(f"Metrics: {', '.join(_metrics(project))}. Tuning levels: {', '.join(TUNE_LEVELS)}.")
    return "\n".join(lines)


def _coerce(param: dict[str, Any], value: Any) -> tuple[bool, Any]:
    """(usable, value) for one setting, in the parameter's type and range."""
    kind = param["type"]
    try:
        if kind in ("int", "float"):
            number = float(value)
            lo, hi = param.get("min"), param.get("max")
            if lo is not None:
                number = max(float(lo), number)
            if hi is not None:
                number = min(float(hi), number)
            return True, int(round(number)) if kind == "int" else number
        if kind == "bool":
            if isinstance(value, str):
                return value.strip().lower() in ("true", "false", "yes", "no", "1", "0"), value.strip().lower() in (
                    "true", "yes", "1")  # fmt: skip
            return True, bool(value)
        if kind == "select":
            for option in param.get("options", []):
                if option["value"] == value or str(option["value"]) == str(value):
                    return True, option["value"]
            return False, None
        if kind in ("columns", "parts"):
            items = [value] if isinstance(value, str) else value
            return isinstance(items, list), [str(v) for v in items if str(v).strip()] if isinstance(items, list) else []
        if kind == "column":
            return isinstance(value, str) and bool(value.strip()), str(value).strip()
        if kind == "layers":
            ok = isinstance(value, list) and all(isinstance(layer, dict) and layer.get("type") for layer in value)
            return ok, value
        if kind == "text":
            return True, str(value)
    except (TypeError, ValueError):
        return False, None
    return False, None  # code and anything unknown


def _params(spec: list[dict[str, Any]], raw: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    by_name = {p["name"]: p for p in spec}
    kept: dict[str, Any] = {}
    dropped: list[str] = []
    for name, value in raw.items():
        param = by_name.get(name)
        if param is None or param["type"] in SKIP_TYPES:
            dropped.append(name)
            continue
        usable, coerced = _coerce(param, value)
        if usable:
            kept[name] = coerced
        else:
            dropped.append(name)
    return kept, dropped


def _raw_params(item: dict[str, Any]) -> dict[str, Any]:
    raw = item.get("params_json")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except ValueError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _find(project: dict[str, Any], item_id: str) -> tuple[str, dict[str, Any]] | None:
    for stage in (*STAGE_NAMES, "models"):
        for entry in project.get(stage) or []:
            if entry.get("id") == item_id:
                return stage, entry
    return None


def _spec_of(project: dict[str, Any], stage: str, entry: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    if stage == "models":
        if project.get("kind") == "image":
            found = next((m for m in cat.IMAGE_ALGOS if m["id"] == entry.get("algo")), None)
            return (found["label"], found["params"]) if found else (str(entry.get("label")), [])
        algo = cat.ALGO_BY_ID.get(entry.get("algo", ""))
        return (algo.label, algo.params) if algo else (str(entry.get("label")), [])
    op = cat.OPS.get(entry.get("op", ""))
    return (op.label, op.params) if op else (str(entry.get("op")), [])


def validate(raw: dict[str, Any], project: dict[str, Any], packages: dict[str, Any]) -> dict[str, Any] | None:
    """One "project" action in the shape the page applies, or None when it names nothing real."""
    change = str(raw.get("change") or "").strip()
    params = _raw_params(raw)
    action: dict[str, Any] = {"type": "project", "change": change, "stage": "", "op": "", "item": "", "params": {},
                              "target": "", "metric": "", "label": "", "dropped": []}  # fmt: skip
    if change == "add_step":
        op = cat.OPS.get(str(raw.get("op") or "").strip())
        if op is None or op.id.startswith("custom_") or project.get("kind") == "image":
            return None
        kept, dropped = _params(op.params, params)
        action.update(stage=op.stage, op=op.id, params=kept, dropped=dropped,
                      label=f"Add {STAGE_NAMES[op.stage].lower()} step: {op.label}")  # fmt: skip
        return action
    if change == "add_model":
        wanted = str(raw.get("op") or "").strip()
        found = next(((i, label, spec) for i, label, spec in _algos(project, packages) if i == wanted), None)
        if found is None:
            return None
        identifier, label, spec = found
        kept, dropped = _params(spec, params)
        action.update(op=identifier, params=kept, dropped=dropped, label=f"Add model: {label}")
        return action
    if change in ("update", "remove"):
        item_id = str(raw.get("item") or "").strip()
        located = _find(project, item_id)
        if located is None:
            return None
        stage, entry = located
        label, spec = _spec_of(project, stage, entry)
        action.update(stage=stage, item=item_id)
        if change == "remove":
            action["label"] = f"Remove {label}"
            return action
        extra: dict[str, Any] = {}
        if "enabled" in params:
            extra["enabled"] = str(params.pop("enabled")).strip().lower() in ("true", "1", "yes")
        if "tune" in params and stage == "models":
            tune = str(params.pop("tune")).strip().lower()
            if tune in TUNE_LEVELS:
                extra["tune"] = tune
        kept, dropped = _params(spec, params)
        if not kept and not extra:
            return None
        action.update(params={**kept, **extra}, dropped=dropped, label=f"Change {label}")
        return action
    if change == "settings":
        target = str(raw.get("target") or "").strip()
        metric = str(raw.get("metric") or "").strip()
        if metric and metric not in _metrics(project):
            metric = ""
        if not target and not metric:
            return None
        said = [f"target {target}" if target else "", f"metric {metric}" if metric else ""]
        action.update(target=target, metric=metric, label="Set " + " and ".join(s for s in said if s))
        return action
    if change == "train":
        action["label"] = "Train the models"
        return action
    return None


def actions(raw: Any, project: dict[str, Any] | None, packages: dict[str, Any]) -> list[dict[str, Any]]:
    if not project:
        return []
    found: list[dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, dict) and item.get("type") == "project":
            checked = validate(item, project, packages)
            if checked is not None:
                found.append(checked)
        if len(found) >= MAX_PROJECT_ACTIONS:
            break
    trains = [a for a in found if a["change"] == "train"]
    return [a for a in found if a["change"] != "train"] + trains[:1]  # training runs last, once
