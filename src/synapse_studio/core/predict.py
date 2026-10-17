"""Use a trained model: one row from a form, a whole file, or an image."""

from __future__ import annotations

import base64
from collections import OrderedDict
from typing import Any

import numpy as np
import pandas as pd

from . import datasets, training
from .util import UserError, frame_rows, jsonable, new_id
from .workspace import Workspace

_MODELS: OrderedDict[str, Any] = OrderedDict()


def _model(ws: Workspace, project_id: str, run_id: str, model_id: str) -> Any:
    key = f"{project_id}/{run_id}/{model_id}"
    if key not in _MODELS:
        _MODELS[key] = training.load_model(ws, project_id, run_id, model_id)
        while len(_MODELS) > 3:
            _MODELS.popitem(last=False)
    _MODELS.move_to_end(key)
    return _MODELS[key]


def _coerce(model: Any, rows: list[dict[str, Any]]) -> pd.DataFrame:
    """Form values arrive as text; turn numbers back into numbers using the model's schema."""
    frame = pd.DataFrame(rows)
    kinds = {c["name"]: c["kind"] for c in (model.schema or {}).get("columns", [])}
    for column in frame.columns:
        if kinds.get(column) == "numeric":
            frame[column] = pd.to_numeric(frame[column].replace("", np.nan), errors="coerce")
        else:
            frame[column] = frame[column].replace("", np.nan)
    return frame


def predict_rows(
    ws: Workspace, project_id: str, run_id: str, model_id: str, rows: list[dict[str, Any]]
) -> dict[str, Any]:
    model = _model(ws, project_id, run_id, model_id)
    if not rows:
        raise UserError("give at least one row")
    frame = _coerce(model, rows)
    out: dict[str, Any] = {"predictions": [jsonable(v) for v in model.predict(frame)], "task": model.task}
    if model.task == "classification":
        probabilities = model.predict_proba(frame)
        out["classes"] = list(probabilities.columns)
        out["probabilities"] = [[round(float(v), 4) for v in row] for row in probabilities.to_numpy()]
    return out


def predict_dataset(ws: Workspace, project_id: str, run_id: str, model_id: str, dataset_id: str) -> dict[str, Any]:
    model = _model(ws, project_id, run_id, model_id)
    frame = datasets.load_frame(ws, dataset_id)
    missing = [c for c in model.input_columns if c not in frame.columns and c in _used(model)]
    out = frame.copy()
    out["predicted_" + model.target] = model.predict(frame)
    if model.task == "classification":
        for column, values in model.predict_proba(frame).items():
            out["probability_" + column] = values.round(4)
    folder = ws.exports / project_id / "predictions"
    folder.mkdir(parents=True, exist_ok=True)
    meta = datasets.get_meta(ws, dataset_id)
    path = folder / f"{new_id('pred')}-{meta['name'][:30]}.csv"
    out.to_csv(path, index=False)
    shown = out.head(50)
    return {"path": ws.relative(path), "name": path.name, "rows": int(len(out)), "missing_columns": missing,
            "header": [str(c) for c in shown.columns], "preview": frame_rows(shown, 50)}  # fmt: skip


def _used(model: Any) -> set[str]:
    return {c["name"] for c in (model.schema or {}).get("columns", []) if c.get("used")}


def predict_image(ws: Workspace, project_id: str, run_id: str, model_id: str, image: str) -> dict[str, Any]:
    from . import images

    result = training.get_run(ws, project_id, run_id)
    record = next((m for m in result["models"] if m["id"] == model_id), None)
    if record is None or not record.get("artifact"):
        raise UserError("that model did not finish training")
    payload = image.split(",", 1)[1] if image.startswith("data:") else image
    return images.predict_image(ws.inside(record["artifact"]), base64.b64decode(payload))
