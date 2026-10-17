from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from helpers import fast, needs_torch

import flowlabs_runtime as rt
from flowlabs.core import datasets, env, training
from flowlabs.core import project as projects
from flowlabs.core.training import Job
from flowlabs.core.util import UserError


def test_new_project_adds_safe_fixes(ws, churn):
    project = projects.new_project(ws, churn["id"])
    assert project["target"] == "churned" and project["task"] == "classification"
    assert [s["op"] for s in project["clean"]] == ["drop_columns", "extract_datetime"]
    assert project["clean"][0]["params"]["columns"] == ["customer_id"]
    assert [m["algo"] for m in project["models"]][:2] == ["baseline", "logistic_regression"]
    assert projects.check(ws, project, env.packages()) == []


def test_train_classification_end_to_end(ws, churn):
    project = fast(projects.new_project(ws, churn["id"]), "baseline", "logistic_regression", "random_forest")
    project["transform"].append(projects._step("transform", "impute", {"columns": ["@numeric"]}))
    project["rows"].append(projects._step("rows", "balance_classes", {"method": "oversample"}))
    project["split"]["cv_folds"] = 3
    events: list[dict] = []
    result = training.run(ws, project, Job("job", events.append))
    assert result["status"] == "completed"
    done = [m for m in result["models"] if m["status"] == "done"]
    assert len(done) == 3
    forest = next(m for m in done if m["algo"] == "random_forest")
    assert forest["metrics"]["roc_auc"] > 0.65 and len(forest["cv"]["folds"]) == 3
    assert forest["importance"]["permutation"] and forest["importance"]["native"]
    assert forest["details"]["confusion"]["labels"] == ["False", "True"] and forest["details"]["roc"]
    assert result["best_model_id"] != next(m["id"] for m in done if m["algo"] == "baseline")
    assert result["data"]["train_classes"][0] == result["data"]["train_classes"][1]  # balanced
    kinds = [e["kind"] for e in events]
    assert kinds[0] == "started" and kinds[-1] == "done" and "model" in kinds
    model = training.load_model(ws, project["id"], result["id"], forest["id"])
    raw = datasets.load_frame(ws, churn["id"]).drop(columns=["churned"]).head(4)
    predictions = model.predict(raw)
    assert set(predictions) <= {True, False}
    assert model.predict_proba(raw).shape == (4, 2)
    assert model.predict({"tenure_months": 1, "contract": "month_to_month"}).shape == (1,)
    assert training.list_runs(ws, project["id"])[0]["id"] == result["id"]
    card = next(p for p in projects.list_projects(ws) if p["id"] == project["id"])
    assert card["best"]["label"] == forest["label"] or card["best"]["value"] is not None


def test_regression_with_tuning_and_time_split(ws):
    meta = datasets.import_sample(ws, "diabetes")
    project = fast(projects.new_project(ws, meta["id"]), "baseline", "linear_regression", "decision_tree")
    assert project["task"] == "regression"
    project["models"][2]["tune"] = "quick"
    project["split"]["time_column"] = "age"
    project["transform"].append(projects._step("transform", "power", {"columns": ["@numeric"]}))
    result = training.run(ws, project, Job("job"))
    linear = next(m for m in result["models"] if m["algo"] == "linear_regression")
    assert linear["metrics"]["r2"] > 0.2 and "scatter" in linear["details"]
    tree = next(m for m in result["models"] if m["algo"] == "decision_tree")
    assert len(tree["trials"]) == 8 and tree["best_params"]
    assert result["data"]["time_ordered"] is True


@pytest.mark.parametrize("op,params", [
    ("encode", {"method": "onehot"}), ("encode", {"method": "target"}), ("encode", {"method": "frequency"}),
    ("encode", {"method": "ordinal"}), ("scale", {"method": "robust"}), ("clip_outliers", {}),
    ("discretize", {"columns": ["tenure_months"], "bins": 4}), ("polynomial", {"interaction_only": True}),
    ("select_k_best", {"k": 3}), ("variance_filter", {}), ("drop_correlated", {}), ("pca", {"components": 0.9}),
    ("impute", {"strategy": "knn"}), ("impute", {"strategy": "constant", "fill_value": "-1", "indicator": True}),
])  # fmt: skip
def test_every_transform_trains(ws, churn, op, params):
    project = fast(projects.new_project(ws, churn["id"]), "logistic_regression")
    if op in ("polynomial", "select_k_best", "variance_filter", "drop_correlated", "pca", "discretize"):
        project["transform"].append(projects._step("transform", "impute", {"columns": ["@numeric"]}))
    project["transform"].append(projects._step("transform", op, params))
    result = training.run(ws, project, Job("job"))
    model = result["models"][0]
    assert model["status"] == "done", model.get("error")


@pytest.mark.parametrize("op,params", [
    ("drop_duplicates", {}), ("drop_missing_rows", {}), ("filter_rows", {"column": "plan_type", "operator": "!=", "value": "pro"}),
    ("sample_rows", {"rows": 500}), ("change_type", {"columns": ["support_calls"], "to": "category"}),
    ("combine_columns", {"a": "monthly_charges", "b": "tenure_months", "operation": "divide", "name": "ratio"}),
    ("replace_values", {"column": "plan_type", "find": "plus", "replace": "basic"}),
    ("clean_text", {"columns": ["plan_type"], "case": "upper"}),
])  # fmt: skip
def test_every_clean_step_trains_and_previews(ws, churn, op, params):
    project = fast(projects.new_project(ws, churn["id"]), "random_forest")
    project["models"][0]["params"]["n_estimators"] = 20
    step = projects._step("clean", op, params)
    project["clean"].append(step)
    assert not [i for i in projects.check(ws, project, env.packages()) if i["level"] == "error"]
    preview = projects.preview(ws, project, step["id"])
    assert preview["header"]
    result = training.run(ws, project, Job("job"))
    assert result["models"][0]["status"] == "done", result["models"][0].get("error")


def test_outliers_smote_and_class_weight(ws):
    meta = datasets.import_sample(ws, "fraud")
    project = fast(projects.new_project(ws, meta["id"]), "logistic_regression")
    project["rows"] = [projects._step("rows", "remove_outliers", {"method": "zscore", "threshold": 4}),
                       projects._step("rows", "balance_classes", {"method": "smote"})]  # fmt: skip
    result = training.run(ws, project, Job("job"))
    assert "SMOTE" in result["data"]["row_steps"] and "outlier" in result["data"]["row_steps"]
    project["rows"] = [projects._step("rows", "balance_classes", {"method": "class_weight"})]
    result = training.run(ws, project, Job("job"))
    assert result["models"][0]["status"] == "done"


def test_checks_catch_mistakes(ws, churn):
    project = projects.new_project(ws, churn["id"])
    project["clean"].append(projects._step("clean", "drop_columns", {"columns": ["churned"]}))
    project["models"].append(projects.model_entry("linear_regression"))
    project["split"]["test_size"] = 0.9
    messages = " ".join(i["message"] for i in projects.check(ws, project, env.packages()))
    assert "drops the target" in messages and "cannot do classification" in messages and "60%" in messages
    with pytest.raises(UserError):
        training.run(ws, project, Job("job"))


def test_failed_model_does_not_stop_others(ws, churn):
    project = fast(projects.new_project(ws, churn["id"]), "logistic_regression", "random_forest")
    project["auto_prep"] = False
    result = training.run(ws, project, Job("job"))
    assert {m["status"] for m in result["models"]} == {"failed"}
    assert "Auto-prep" in result["models"][0]["error"]


def test_cancel_between_models(ws, churn):
    project = fast(projects.new_project(ws, churn["id"]), "baseline", "random_forest")
    job = Job("job")
    seen = []

    def emit(event):
        seen.append(event)
        if event["kind"] == "model" and event["status"] == "done":
            job.cancelled = True

    job._emit = emit
    from flowlabs.core.util import Cancelled

    with pytest.raises(Cancelled):
        training.run(ws, project, job)


def test_preview_every_stage(ws, churn):
    project = projects.new_project(ws, churn["id"])
    project["rows"].append(projects._step("rows", "balance_classes", {"method": "undersample"}))
    project["transform"].append(projects._step("transform", "scale", {}))
    ids = [None, *(s["id"] for s in project["clean"]), "split", project["rows"][0]["id"], project["transform"][0]["id"],
           "auto_prep"]  # fmt: skip
    titles = [projects.preview(ws, project, i)["title"] for i in ids]
    assert titles == ["Dataset", "Drop columns", "Date parts", "Split", "Balance classes", "Scale numbers", "Auto-prep"]
    drop = projects.preview(ws, project, project["clean"][0]["id"])
    assert {"name": "customer_id", "state": "removed", "kind": "categorical"} in drop["columns"]
    balance = projects.preview(ws, project, project["rows"][0]["id"])
    assert (
        all(c["state"] == "same" for c in balance["columns"]) and balance["after_shape"][0] < balance["before_shape"][0]
    )
    auto = projects.preview(ws, project, "auto_prep")
    assert any(r["action"] == "onehot" for r in auto["report"])


def test_numpy_network_learns():
    rng = np.random.default_rng(0)
    X = rng.normal(size=(600, 4)).astype(np.float32)
    y = (X[:, 0] + X[:, 1] ** 2 > 0.8).astype(int)
    model = rt.NeuralNetClassifier(
        layers=[{"type": "dense", "units": 32, "activation": "relu"}, {"type": "batchnorm"},
                {"type": "dropout", "rate": 0.1}, {"type": "dense", "units": 16, "activation": "gelu"}],
        epochs=80, backend="numpy", learning_rate=0.01,
    )  # fmt: skip
    model.fit(X, y)
    assert model.backend_ == "numpy" and (model.predict(X) == y).mean() > 0.9
    regressor = rt.NeuralNetRegressor(
        epochs=120, backend="numpy", learning_rate=0.01, optimizer="adamw", weight_decay=1e-4
    )
    target = X[:, 0] * 3 - X[:, 2]
    regressor.fit(X, target)
    assert np.corrcoef(regressor.predict(X), target)[0, 1] > 0.95


@needs_torch
def test_torch_network_matches_numpy_inference():
    rng = np.random.default_rng(1)
    X = rng.normal(size=(400, 5)).astype(np.float32)
    y = (X.sum(axis=1) > 0).astype(int)
    model = rt.NeuralNetClassifier(layers=[{"type": "dense", "units": 16, "activation": "tanh"}, {"type": "batchnorm"},
                                           {"type": "dense", "units": 8, "activation": "elu"}],
                                   epochs=40, backend="torch", device="cpu")  # fmt: skip
    model.fit(X, y)
    assert model.backend_ == "torch"
    import torch

    with torch.no_grad():
        torch_probs = torch.softmax(model.to_torch()(torch.as_tensor(X)), dim=1).numpy()
    assert np.allclose(torch_probs, model.predict_proba(X), atol=1e-4)
    assert (model.predict(X) == y).mean() > 0.9


def test_network_in_a_project_streams_epochs(ws, churn):
    project = fast(projects.new_project(ws, churn["id"]), "neural_network")
    project["models"][0]["params"].update(epochs=6, backend="numpy")
    events: list[dict] = []
    result = training.run(ws, project, Job("job", events.append))
    model = result["models"][0]
    assert model["status"] == "done" and model["backend"] == "numpy" and model["parameters"] > 100
    epochs = [e for e in events if e["kind"] == "epoch"]
    assert epochs and set(epochs[0]["metrics"]) >= {"loss", "val_loss", "val_accuracy"}


def test_runtime_column_step_keeps_names():
    from sklearn.preprocessing import OneHotEncoder

    frame = pd.DataFrame({"colour": ["red", "blue", "red"], "size": [1.0, 2.0, 3.0]})
    step = rt.ColumnStep(OneHotEncoder(sparse_output=False, handle_unknown="ignore"), ["@categorical"], "encode").fit(
        frame
    )
    out = step.transform(frame)
    assert list(out.columns) == ["size", "colour_blue", "colour_red"]
    missing = step.transform(pd.DataFrame({"size": [1.0]}))  # a column absent at prediction time
    assert list(missing.columns) == ["size", "colour_blue", "colour_red"]
