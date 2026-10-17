"""Code steps: every step and model can be shown as Python, edited, and still train and export."""

from __future__ import annotations

import zipfile

import pandas as pd
import pytest
from helpers import fast

import flowlabs_runtime as rt
from flowlabs.core import codegen, datasets, export, training
from flowlabs.core import project as projects
from flowlabs.core.rpc import Engine
from flowlabs.core.training import Job

CLEAN_CASES = [
    ("drop_columns", {"columns": ["customer_id"]}),
    ("change_type", {"columns": ["tenure_months"], "to": "numeric"}),
    ("change_type", {"columns": ["has_partner"], "to": "boolean"}),
    ("change_type", {"columns": ["signup_date"], "to": "datetime"}),
    ("change_type", {"columns": ["support_calls"], "to": "category"}),
    ("clean_text", {"columns": ["@categorical"], "case": "upper", "strip": True}),
    ("replace_values", {"column": "plan_type", "find": "plus", "replace": ""}),
    ("extract_datetime", {"columns": ["signup_date"], "parts": ["year", "month", "weekday", "is_weekend", "quarter"],
                          "drop_original": True}),
    ("combine_columns", {"a": "monthly_charges", "b": "tenure_months", "operation": "divide", "name": "per_month"}),
    ("combine_columns", {"a": "monthly_charges", "b": "support_calls", "operation": "subtract", "name": ""}),
    ("drop_duplicates", {"columns": ["plan_type", "contract"]}),
    ("drop_missing_rows", {"columns": ["@all"], "how": "any"}),
    ("filter_rows", {"column": "tenure_months", "operator": ">=", "value": "12"}),
    ("filter_rows", {"column": "contract", "operator": "==", "value": "two_year"}),
    ("filter_rows", {"column": "plan_type", "operator": "not contains", "value": "plu"}),
    ("sample_rows", {"rows": 50, "seed": 3}),
]  # fmt: skip


@pytest.mark.parametrize(("op", "params"), CLEAN_CASES)
def test_clean_steps_as_code_do_the_same(ws, churn, op, params):
    frame = datasets.load_frame(ws, churn["id"]).head(400)
    expected = rt.apply_clean_op(frame, op, params, rows=True)
    code = codegen.clean_code(op, params, frame)
    compile(code, "generated", "exec")
    got = rt.apply_clean_op(frame, "custom_clean", {"code": code}, rows=True)
    pd.testing.assert_frame_equal(got.reset_index(drop=True), expected.reset_index(drop=True), check_dtype=False)


def _score(ws, project):
    result = training.run(ws, project, Job("job"))
    record = result["models"][0]
    assert record["status"] == "done", record.get("error")
    return record["metrics"]


def _as_code(ws, project, stage, item_id):
    """Swap one item for the code step FlowLabs generates for it, as the app's Edit as code button does."""
    answer = Engine(ws.root).call("projects.step_code", {"project": project, "stage": stage, "item_id": item_id})
    replacement = answer["replacement"]
    if stage == "models":
        entry = projects.model_entry("custom_model", replacement["params"])
        project["models"] = [entry if m["id"] == item_id else m for m in project["models"]]
    else:
        step = projects._step(stage, replacement["op"], replacement["params"])
        project[stage] = [step if s["id"] == item_id else s for s in project[stage]]
    return answer["code"]


def test_every_kind_of_step_trains_the_same_as_code(ws, churn):
    project = fast(projects.new_project(ws, churn["id"]), "random_forest")
    project["models"][0]["params"].update(n_estimators=40)
    project["clean"].append(projects._step("clean", "clean_text", {"columns": ["@categorical"], "case": "lower"}))
    project["rows"].append(projects._step("rows", "balance_classes", {"method": "oversample"}))
    project["rows"].append(projects._step("rows", "remove_outliers", {"method": "iqr", "threshold": 3.0}))
    project["transform"].append(projects._step("transform", "encode", {"method": "onehot"}))
    project["transform"].append(projects._step("transform", "scale", {"method": "robust"}))
    before = _score(ws, project)

    for stage in ("clean", "rows", "transform"):
        for step in list(project[stage]):
            _as_code(ws, project, stage, step["id"])
    code = _as_code(ws, project, "models", project["models"][0]["id"])
    assert "RandomForestClassifier(" in code and "n_estimators=40" in code
    assert all(s["op"].startswith("custom_") for stage in ("clean", "rows", "transform") for s in project[stage])
    assert _score(ws, project) == before


def test_code_steps_export_and_predict_without_flowlabs(ws, churn, tmp_path):
    from test_export_images import _run

    project = fast(projects.new_project(ws, churn["id"]), "custom_model")
    project["models"][0]["params"]["code"] = (
        "from sklearn.linear_model import LogisticRegression\n\nmodel = LogisticRegression(C=0.5, max_iter=500)\n"
    )
    project["clean"].append(projects._step("clean", "custom_clean", {"code": (
        "def clean(df):\n    df = df.copy()\n    df['charge_per_call'] = df['monthly_charges'] / (df['support_calls'] + 1)\n"
        "    return df\n")}))  # fmt: skip
    project["transform"].append(projects._step("transform", "custom_transform", {"columns": ["@numeric"], "code": (
        "def fit(X, y):\n    return X.mean(), X.std().replace(0, 1)\n\n\n"
        "def transform(X, state):\n    mean, std = state\n    return (X - mean) / std\n")}))  # fmt: skip
    result = training.run(ws, project, Job("job"))
    record = result["models"][0]
    assert record["status"] == "done", record.get("error")
    assert record["metrics"]["accuracy"] > 0.6
    built = export.build(ws, project["id"], result["id"], record["id"], include_data=True)
    with zipfile.ZipFile(ws.inside(built["zip"]["path"])) as bundle:
        bundle.extractall(tmp_path / "out")
    folder = next((tmp_path / "out").iterdir())
    _run(["predict.py", "example.csv", "-o", "scored.csv"], folder)
    scored = pd.read_csv(folder / "scored.csv")
    assert "predicted_churned" in scored.columns and len(scored) > 0
    script = (folder / "train.py").read_text(encoding="utf-8")
    assert "charge_per_call" in script  # the code travels with the training script


def test_code_mistakes_are_reported_with_their_line(ws, churn):
    project = fast(projects.new_project(ws, churn["id"]), "custom_model")
    project["models"][0]["params"]["code"] = "model = (\n"
    project["clean"].append(projects._step("clean", "custom_clean", {"code": (
        "def clean(df):\n    df = df.copy()\n    return df['no_such_column']\n")}))  # fmt: skip
    project["transform"].append(projects._step("transform", "custom_transform", {"code": "x = 1\n"}))
    issues = projects.check(ws, project)
    messages = " | ".join(i["message"] for i in issues if i["level"] == "error")
    assert "line 3" in messages and "KeyError" in messages  # the clean step's runtime error
    assert "line 1" in messages  # the model's syntax error
    assert "define transform(...) or transformer = ..." in messages


def test_a_failing_model_code_step_explains_itself(ws, churn):
    project = fast(projects.new_project(ws, churn["id"]), "custom_model", "logistic_regression")
    project["models"][0]["params"]["code"] = (
        "class Broken:\n    def fit(self, X, y):\n        raise RuntimeError('nope')\n\n"
        "    def predict(self, X):\n        return X\n\n\nmodel = Broken()\n"
    )
    result = training.run(ws, project, Job("job"))
    broken, fine = result["models"]
    assert broken["status"] == "failed" and "line 3" in broken["error"] and "nope" in broken["error"], broken
    assert fine["status"] == "done"


def test_a_network_written_as_code_streams_epochs(ws, churn):
    project = fast(projects.new_project(ws, churn["id"]), "neural_network")
    project["models"][0]["params"].update(epochs=4, backend="numpy")
    _as_code(ws, project, "models", project["models"][0]["id"])
    assert "NeuralNetClassifier(" in project["models"][0]["params"]["code"]
    events = []
    job = Job("job", events.append)
    result = training.run(ws, project, job)
    record = result["models"][0]
    assert record["status"] == "done", record.get("error")
    assert len(record["history"]) == 4 and any(e["kind"] == "epoch" for e in events)
