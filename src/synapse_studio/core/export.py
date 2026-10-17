"""Export a trained model as a folder (and zip) that runs anywhere without Synapse.

Tables::

    model.joblib        the whole pipeline: raw rows in, predictions out
    synapse_runtime.py  the small module the pipeline needs (numpy, pandas, scikit-learn only)
    predict.py          python predict.py new_rows.csv  ->  predictions.csv
    serve.py            python serve.py  ->  POST JSON rows to http://127.0.0.1:8000/predict
    train.py            the same training, as a readable script you can edit and re-run
    schema.json         input columns, their types and allowed values; output classes
    example.csv         five rows in the expected input format
    requirements.txt    pinned to the versions that trained the model
    MODEL_CARD.md       what the model is, how it was trained and how well it did

Images: ``model.pt`` (TorchScript, needs only torch), ``model.onnx`` when the engine can write it,
``labels.json``, ``preprocess.json``, ``predict.py``, ``requirements.txt`` and ``MODEL_CARD.md``.
"""

from __future__ import annotations

import importlib
import inspect
import json
import shutil
import zipfile
from pathlib import Path
from typing import Any

import synapse_runtime as rt

from . import catalogue as cat
from . import datasets, env, training
from . import project as projects
from .util import UserError, new_id, now
from .workspace import Workspace

RUNTIME_FILE = Path(rt.__file__)


def _slug(text: str) -> str:
    cleaned = "".join(c if c.isalnum() else "-" for c in text.lower()).strip("-")
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned[:40] or "model"


# ------------------------------------------------------------------------------------ codegen


class _Emitter:
    """Python source for an estimator tree: ``ClassName(param=value)`` with changed params only."""

    def __init__(self) -> None:
        self.imports: dict[str, set[str]] = {}

    def _module(self, obj: Any) -> str:
        module = getattr(obj, "__module__", None) or type(obj).__module__
        name = getattr(obj, "__name__", None) or type(obj).__name__
        if module == "synapse_runtime":
            return module
        parts = module.split(".")
        for depth in range(1, len(parts) + 1):
            candidate = ".".join(parts[:depth])
            if candidate.split(".")[-1].startswith("_"):
                continue
            try:
                if hasattr(importlib.import_module(candidate), name):
                    return candidate
            except ImportError:
                continue
        return module

    def _need(self, obj: Any, name: str) -> None:
        self.imports.setdefault(self._module(obj), set()).add(name)

    def value(self, obj: Any, indent: int = 0) -> str:
        from sklearn.base import BaseEstimator

        if isinstance(obj, BaseEstimator):
            cls = type(obj)
            self._need(cls, cls.__name__)
            args = []
            for name, parameter in inspect.signature(cls.__init__).parameters.items():
                if name == "self" or parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
                    continue
                current = getattr(obj, name, parameter.default)
                if parameter.default is not inspect.Parameter.empty and _same(current, parameter.default):
                    continue
                args.append(f"{name}={self.value(current, indent)}")
            return f"{cls.__name__}({', '.join(args)})"
        if inspect.isfunction(obj) or inspect.isbuiltin(obj):
            self._need(obj, obj.__name__)
            return obj.__name__
        if hasattr(obj, "item") and not isinstance(obj, list | dict | tuple | str):
            return repr(obj.item())
        if isinstance(obj, dict):
            return "{" + ", ".join(f"{self.value(k)}: {self.value(v)}" for k, v in obj.items()) + "}"
        if isinstance(obj, list):
            return "[" + ", ".join(self.value(v) for v in obj) + "]"
        if isinstance(obj, tuple):
            inner = ", ".join(self.value(v) for v in obj)
            return f"({inner},)" if len(obj) == 1 else f"({inner})"
        return repr(obj)

    def import_lines(self) -> list[str]:
        return [f"from {module} import {', '.join(sorted(names))}" for module, names in sorted(self.imports.items())]


def _same(a: Any, b: Any) -> bool:
    try:
        return bool(a == b) and type(a) is type(b)
    except (TypeError, ValueError):
        return a is b


def train_script(project: dict[str, Any], record: dict[str, Any], dataset_name: str) -> str:
    """A standalone script that repeats this model's training."""
    params = {**(record.get("params") or {}), **(record.get("best_params") or {})}
    entry = {"algo": record["algo"], "params": params}
    ctx = {"n_jobs": -1, "class_weight": any(
        s["op"] == "balance_classes" and s["params"].get("method") == "class_weight"
        for s in projects.enabled(project.get("rows"))), "device": "cpu"}  # fmt: skip
    pipeline = training.build_pipeline(project, entry, params, ctx)
    emitter = _Emitter()
    emitter._need(rt.SynapseModel, "SynapseModel")
    clean = projects.enabled(project.get("clean"))
    rows = projects.enabled(project.get("rows"))
    steps = []
    for name, step in pipeline.steps:
        if name == "clean":
            emitter._need(rt.CleanOps, "CleanOps")
            steps.append('    ("clean", CleanOps(CLEAN_STEPS)),')
        else:
            steps.append(f"    ({name!r}, {emitter.value(step)}),")
    split = project.get("split") or {}
    task, target = project["task"], project["target"]
    metrics = "accuracy_score, f1_score" if task == "classification" else "mean_absolute_error, r2_score"
    clean_literal = json.dumps([{"op": s["op"], "params": s["params"]} for s in clean], indent=4)
    rows_literal = json.dumps([{"op": s["op"], "params": s["params"]} for s in rows], indent=4)
    lines = [
        f'"""Train “{record["label"]}” for {project["name"]} exactly as Synapse did.',
        "",
        "    pip install -r requirements.txt",
        f"    python train.py {dataset_name}",
        "",
        "Writes model.joblib. Change any step below and run it again.",
        f"Generated by Synapse {env.info(probe_gpu=False)['synapse']} on {now()[:10]}.",
        '"""',
        "",
        "import sys",
        "from pathlib import Path",
        "",
        "import joblib",
        "import pandas as pd",
        f"from sklearn.metrics import {metrics}",
        "from sklearn.model_selection import train_test_split",
        "from sklearn.pipeline import Pipeline",
        "",
        "sys.path.insert(0, str(Path(__file__).resolve().parent))  # finds synapse_runtime.py next to this file",
        "",
        "@@IMPORTS@@",
        "",
        f"DATA = sys.argv[1] if len(sys.argv) > 1 else {dataset_name!r}",
        f"TARGET = {target!r}",
        f"TEST_SIZE = {float(split.get('test_size', 0.2))!r}",
        f"SEED = {int(split.get('seed', 42))!r}",
        "",
        "# Clean: run on the whole table. Row steps (duplicates, filters) only apply while training.",
        f"CLEAN_STEPS = {_py(clean_literal)}",
        "",
        "# Training-set steps: touch training rows only (outliers, class balance).",
        f"ROW_STEPS = {_py(rows_literal)}",
        "",
        "# Everything below is learned from training rows only, so test scores stay honest.",
        "pipeline = Pipeline([",
        *steps,
        "])",
        "",
        "",
        "def read(path):",
        "    suffix = Path(path).suffix.lower()",
        '    if suffix in (".xlsx", ".xls"):',
        "        return pd.read_excel(path)",
        '    if suffix in (".parquet", ".pq"):',
        "        return pd.read_parquet(path)",
        '    if suffix in (".json", ".jsonl"):',
        '        return pd.read_json(path, lines=suffix == ".jsonl")',
        '    return pd.read_csv(path, sep=None, engine="python")',
        "",
        "",
        "frame = read(DATA)",
        "cleaned = CleanOps(CLEAN_STEPS).apply(frame, rows=True).dropna(subset=[TARGET])",
    ]
    if task == "classification":
        lines += [
            "labels = cleaned[TARGET].astype(str)",
            "CLASSES = sorted(labels.unique())",
            "y = labels.map({c: i for i, c in enumerate(CLASSES)})",
            "X = frame.loc[cleaned.index].drop(columns=[TARGET])",
        ]
    else:
        lines += [
            'y = pd.to_numeric(cleaned[TARGET], errors="coerce").dropna()',
            "X = frame.loc[y.index].drop(columns=[TARGET])",
        ]
    if split.get("time_column"):
        lines += [
            f'order = pd.to_datetime(X[{split["time_column"]!r}], errors="coerce", format="mixed").argsort(kind="stable")',
            "cut = int(round(len(X) * (1 - TEST_SIZE)))",
            "X_train, X_test = X.iloc[order[:cut]], X.iloc[order[cut:]]",
            "y_train, y_test = y.iloc[order[:cut]], y.iloc[order[cut:]]",
        ]
    else:
        stratify = "y" if task == "classification" and split.get("stratify", True) else "None"
        lines += [
            "X_train, X_test, y_train, y_test = train_test_split(",
            f"    X, y, test_size=TEST_SIZE, random_state=SEED, shuffle={bool(split.get('shuffle', True))}, stratify={stratify}",
            ")",
        ]
    if rows:
        emitter._need(rt.training_rows, "training_rows")
        lines += [
            f"X_train, y_train, note = training_rows(ROW_STEPS, X_train, y_train, {task!r}, SEED, CleanOps(CLEAN_STEPS))",
            "print(note)",
        ]
    lines += ["", "pipeline.fit(X_train, y_train)", "predicted = pipeline.predict(X_test)"]
    if task == "classification":
        lines += [
            'print(f"accuracy {accuracy_score(y_test, predicted.astype(int)):.4f}")',
            "print(f\"F1 (macro) {f1_score(y_test, predicted.astype(int), average='macro'):.4f}\")",
            "natives = dict(zip(labels, cleaned[TARGET]))",
            'model = SynapseModel(pipeline, "classification", TARGET, list(X.columns), [natives[c] for c in CLASSES])',
        ]
    else:
        lines += [
            'print(f"R² {r2_score(y_test, predicted):.4f}")',
            'print(f"MAE {mean_absolute_error(y_test, predicted):.4f}")',
            'model = SynapseModel(pipeline, "regression", TARGET, list(X.columns))',
        ]
    lines += ['joblib.dump(model, "model.joblib", compress=3)', 'print("saved model.joblib")', ""]
    return "\n".join(lines).replace("@@IMPORTS@@", "\n".join(emitter.import_lines()))


def _py(literal: str) -> str:
    """JSON text as Python literal text."""
    return literal.replace(": true", ": True").replace(": false", ": False").replace(": null", ": None")


# ----------------------------------------------------------------------------------- templates

PREDICT_PY = '''"""Make predictions with the exported model.

    pip install -r requirements.txt
    python predict.py new_rows.csv                  # writes predictions.csv
    python predict.py new_rows.csv -o scored.csv

In your own code:

    import joblib, pandas as pd
    model = joblib.load("model.joblib")
    model.predict(pd.read_csv("new_rows.csv"))
"""

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # finds synapse_runtime.py next to this file

import joblib  # noqa: E402
import pandas as pd  # noqa: E402


def read(path):
    suffix = Path(path).suffix.lower()
    if suffix in (".xlsx", ".xls"):
        return pd.read_excel(path)
    if suffix in (".parquet", ".pq"):
        return pd.read_parquet(path)
    if suffix in (".json", ".jsonl"):
        return pd.read_json(path, lines=suffix == ".jsonl")
    return pd.read_csv(path, sep=None, engine="python")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", help="CSV, Excel, Parquet or JSON file with the input columns")
    parser.add_argument("-o", "--output", default="predictions.csv")
    args = parser.parse_args()
    model = joblib.load(HERE / "model.joblib")
    rows = read(args.input)
    out = rows.copy()
    out["predicted_" + model.target] = model.predict(rows)
    if model.task == "classification":
        for column, values in model.predict_proba(rows).items():
            out["probability_" + column] = values.round(4)
    out.to_csv(args.output, index=False)
    print(f"wrote {len(out)} predictions to {args.output}")


if __name__ == "__main__":
    main()
'''

SERVE_PY = '''"""A tiny prediction server using only the Python standard library (plus the model's packages).

    python serve.py                 # http://127.0.0.1:8000
    python serve.py --port 9000 --host 0.0.0.0

    GET  /          input schema
    POST /predict   {"rows": [{"column": value, ...}, ...]}
                    -> {"predictions": [...], "probabilities": [{"class": p, ...}, ...]}
"""

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import joblib  # noqa: E402
import pandas as pd  # noqa: E402

MODEL = joblib.load(HERE / "model.joblib")
SCHEMA = json.loads((HERE / "schema.json").read_text(encoding="utf-8"))


def native(value):
    return value.item() if hasattr(value, "item") else value


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(200, SCHEMA)

    def do_POST(self):
        if self.path.rstrip("/") != "/predict":
            return self.reply(404, {"error": "POST to /predict"})
        try:
            payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            rows = pd.DataFrame(payload["rows"] if isinstance(payload, dict) else payload)
            body = {"predictions": [native(v) for v in MODEL.predict(rows)]}
            if MODEL.task == "classification":
                body["probabilities"] = MODEL.predict_proba(rows).round(4).to_dict(orient="records")
            self.reply(200, body)
        except Exception as error:  # noqa: BLE001
            self.reply(400, {"error": str(error)})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    print(f"serving {MODEL} on http://{args.host}:{args.port}")
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
'''

IMAGE_PREDICT_PY = '''"""Classify images with the exported network (needs torch, pillow and numpy).

    pip install -r requirements.txt
    python predict.py photo.jpg [more.png ...]
"""

import json
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image

HERE = Path(__file__).resolve().parent
LABELS = json.loads((HERE / "labels.json").read_text(encoding="utf-8"))
PREP = json.loads((HERE / "preprocess.json").read_text(encoding="utf-8"))
MODEL = torch.jit.load(str(HERE / "model.pt"), map_location="cpu").eval()


def prepare(path):
    image = Image.open(path).convert("L" if PREP["channels"] == 1 else "RGB")
    image = image.resize((PREP["size"], PREP["size"]), Image.Resampling.BILINEAR)
    array = np.asarray(image, dtype=np.float32) / 255.0
    if array.ndim == 2:
        array = array[:, :, None]
    if PREP["normalize"]:
        array = (array - np.asarray(PREP["mean"], np.float32)) / np.asarray(PREP["std"], np.float32)
    return torch.as_tensor(np.ascontiguousarray(array.transpose(2, 0, 1)))[None]


for path in sys.argv[1:]:
    with torch.no_grad():
        probs = torch.softmax(MODEL(prepare(path)), dim=1)[0]
    top = torch.argsort(probs, descending=True)[:3]
    print(path, "->", ", ".join(f"{LABELS[i]} {probs[i]:.1%}" for i in top.tolist()))
'''


def _requirements(packages: dict[str, Any], extra: list[str]) -> str:
    pins = {"numpy": "numpy", "pandas": "pandas", "sklearn": "scikit-learn", "scipy": "scipy", "joblib": "joblib"}
    lines = []
    for module, dist in [*pins.items(), *[(e, e) for e in extra]]:
        version = packages.get(module)
        exact = module in ("sklearn", "xgboost", "lightgbm") and version not in (None, "installed")
        lines.append(
            f"{dist}=={version}" if exact else (f"{dist}>={version}" if version and version != "installed" else dist)
        )
    return "\n".join(lines) + "\n"


def _model_card(
    project: dict[str, Any], result: dict[str, Any], record: dict[str, Any], dataset: dict[str, Any]
) -> str:
    metric = result["metric"]
    lines = [
        f"# {project['name']}: {record['label']}",
        "",
        f"Trained with [Synapse](https://github.com/AdityaTakuli/Synapse) on {result['finished'][:10]}.",
        "",
        "## What it predicts",
        "",
        f"- **Target:** `{result['target']}` ({result['task']})",
    ]
    if result.get("classes"):
        shown = ", ".join(f"`{c}`" for c in result["classes"][:20])
        lines.append(f"- **Classes:** {shown}{' …' if len(result['classes']) > 20 else ''}")
    data = result.get("data") or {}
    lines += [
        f"- **Dataset:** {dataset.get('name')} ({data.get('rows')} rows)",
        f"- **Training rows:** {data.get('train_rows')} · **test rows:** {data.get('test_rows')}",
        "",
        "## How well it does (on test rows it never saw)",
        "",
        "| Metric | Test | Training |",
        "| --- | --- | --- |",
    ]
    for name, value in (record.get("metrics") or {}).items():
        train_value = (record.get("train_metrics") or {}).get(name)
        marker = " ← chosen metric" if name == metric else ""
        train_text = f"{train_value:.4g}" if isinstance(train_value, float) else "–"
        lines.append(f"| {name}{marker} | {value:.4g} | {train_text} |")
    if record.get("cv"):
        cv = record["cv"]
        lines += [
            "",
            f"Cross-validation ({len(cv['folds'])} folds, {cv['metric']}): {cv['mean']:.4g} ± {cv['std']:.4g}",
        ]
    lines += ["", "## How it was trained", ""]
    for step in projects.enabled(project.get("clean")):
        lines.append(f"- Clean: {cat.OPS[step['op']].label} `{json.dumps(step['params'])}`")
    for step in projects.enabled(project.get("rows")):
        lines.append(f"- Training rows: {cat.OPS[step['op']].label} `{json.dumps(step['params'])}`")
    for step in projects.enabled(project.get("transform")):
        lines.append(f"- Transform: {cat.OPS[step['op']].label} `{json.dumps(step['params'])}`")
    if project.get("kind") != "image" and project.get("auto_prep", True):
        lines.append("- Auto-prep: " + "; ".join(f"{r['column']}: {r['detail']}" for r in data.get("auto_prep") or []))
    params = {**(record.get("params") or {}), **(record.get("best_params") or {})}
    lines += [f"- Model: {record['label']} `{json.dumps(params)}`", ""]
    importance = (record.get("importance") or {}).get("permutation") or []
    if importance:
        lines += ["## Most influential inputs", ""]
        lines += [
            f"{i + 1}. `{f['feature']}` (score drop {f['value']:.4g} when shuffled)"
            for i, f in enumerate(importance[:10])
        ]
        lines.append("")
    lines += [
        "## Limits",
        "",
        "- The model learned from the rows above; it may be wrong on data unlike them.",
        "- Check fairness and leakage before relying on it for decisions about people.",
        "",
    ]
    return "\n".join(lines)


# --------------------------------------------------------------------------------------- build


def build(ws: Workspace, project_id: str, run_id: str, model_id: str, include_data: bool = False) -> dict[str, Any]:
    result = training.get_run(ws, project_id, run_id)
    record = next((m for m in result["models"] if m["id"] == model_id), None)
    if record is None or record.get("status") != "done":
        raise UserError("that model did not finish training")
    project = result["project"]
    dataset = datasets.get_meta(ws, project["dataset_id"])
    export_id = new_id("x")
    folder_name = f"{_slug(project['name'])}-{_slug(record['label'])}"
    folder = ws.exports / project_id / export_id / folder_name
    folder.mkdir(parents=True)
    packages = env.packages()
    card = _model_card(project, result, record, dataset)
    (folder / "MODEL_CARD.md").write_text(card, encoding="utf-8")
    notes: list[str] = []
    if project.get("kind") == "image":
        _image_files(ws, record, result, folder, packages, notes)
    else:
        shutil.copyfile(ws.inside(record["artifact"]), folder / "model.joblib")
        shutil.copyfile(RUNTIME_FILE, folder / "synapse_runtime.py")
        (folder / "predict.py").write_text(PREDICT_PY, encoding="utf-8")
        (folder / "serve.py").write_text(SERVE_PY, encoding="utf-8")
        data_name = "data" + Path(dataset["file"]).suffix
        (folder / "train.py").write_text(train_script(project, record, data_name), encoding="utf-8")
        schema = {"target": result["target"], "task": result["task"], "classes": result.get("classes"),
                  "model": record["label"], "metric": result["metric"], "metrics": record.get("metrics"),
                  **(result.get("schema") or {})}  # fmt: skip
        (folder / "schema.json").write_text(json.dumps(schema, indent=1, default=str), encoding="utf-8")
        frame = datasets.load_frame(ws, project["dataset_id"])
        frame.drop(columns=[result["target"]], errors="ignore").head(5).to_csv(folder / "example.csv", index=False)
        if include_data:
            shutil.copyfile(datasets.data_file(ws, project["dataset_id"]), folder / data_name)
        else:
            notes.append(f"train.py expects the training data as {data_name} (or pass a path).")
        extra = [m for m in ("xgboost", "lightgbm") if record["algo"] == m]
        (folder / "requirements.txt").write_text(_requirements(packages, extra), encoding="utf-8")
    archive = folder.parent / f"{folder_name}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(folder.rglob("*")):
            if path.is_file():
                bundle.write(path, Path(folder_name) / path.relative_to(folder))
    files = [{"name": p.name, "path": ws.relative(p), "size": p.stat().st_size} for p in sorted(folder.iterdir())
             if p.is_file()]  # fmt: skip
    return {"id": export_id, "folder": ws.relative(folder), "zip": {"name": archive.name, "path": ws.relative(archive),
            "size": archive.stat().st_size}, "files": files, "notes": notes, "model_card": card,
            "created": now()}  # fmt: skip


def _image_files(ws: Workspace, record: dict[str, Any], result: dict[str, Any], folder: Path,
                 packages: dict[str, Any], notes: list[str]) -> None:  # fmt: skip
    import torch

    from . import images

    net, checkpoint = images.load_checkpoint(ws.inside(record["artifact"]))
    size, n_channels = checkpoint["size"], checkpoint["channels"]
    example = torch.zeros(1, n_channels, size, size)
    traced = torch.jit.trace(net, example)
    traced.save(str(folder / "model.pt"))
    try:
        torch.onnx.export(net, (example,), str(folder / "model.onnx"), input_names=["image"], output_names=["logits"],
                          dynamic_axes={"image": {0: "batch"}, "logits": {0: "batch"}}, dynamo=False)  # fmt: skip
    except Exception as error:  # noqa: BLE001 - ONNX is a bonus format
        (folder / "model.onnx").unlink(missing_ok=True)
        notes.append(f"ONNX export was skipped ({str(error)[:120]}). Install the onnx package in the engine to add it.")
    prep = checkpoint["image"]
    normalize = prep.get("normalize", "imagenet") == "imagenet"
    mean = list(images.IMAGENET_MEAN) if n_channels == 3 else [0.449]
    std = list(images.IMAGENET_STD) if n_channels == 3 else [0.226]
    (folder / "labels.json").write_text(json.dumps(checkpoint["classes"], indent=1), encoding="utf-8")
    (folder / "preprocess.json").write_text(json.dumps({"size": size, "channels": n_channels, "normalize": normalize,
                                                        "mean": mean, "std": std}, indent=1), encoding="utf-8")  # fmt: skip
    (folder / "predict.py").write_text(IMAGE_PREDICT_PY, encoding="utf-8")
    torch_version = (packages.get("torch") or "").split("+")[0]
    torch_line = f"torch>={torch_version}" if torch_version else "torch"
    (folder / "requirements.txt").write_text(f"{torch_line}\npillow\nnumpy\n", encoding="utf-8")


def list_exports(ws: Workspace, project_id: str) -> list[dict[str, Any]]:
    found = []
    for archive in sorted((ws.exports / project_id).glob("*/*.zip"), reverse=True):
        found.append({"id": archive.parent.name, "zip": {"name": archive.name, "path": ws.relative(archive),
                      "size": archive.stat().st_size}})  # fmt: skip
    return found
