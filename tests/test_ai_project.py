"""The AI panel changing a machine learning project: what the model is shown, and how its proposed
changes are checked before the page applies them. The model is a small local server."""

from __future__ import annotations

import json

import pytest
from test_ai import Fake, chat

from flowlabs.core import ai, ai_project, datasets, env
from flowlabs.core import project as projects

PACKAGES = {"torch": False, "xgboost": False, "lightgbm": False, "torchvision": False}


def action(**fields) -> dict:
    base = {"type": "project", "sql": "", "run": False, "sheet": "", "start": "", "values": [], "change": "",
            "stage": "", "op": "", "item": "", "params_json": "", "target": "", "metric": ""}  # fmt: skip
    return {**base, **fields}


@pytest.fixture
def churn(ws):
    dataset = datasets.import_sample(ws, "churn")
    return projects.new_project(ws, dataset["id"], "Churn", "churned")


def test_the_model_sees_the_project_and_what_can_be_added(churn):
    text = ai_project.describe(churn, PACKAGES)
    model = churn["models"][1]
    assert f"id {model['id']}: {model['label']}" in text
    assert "Clean steps you can add (stage clean):" in text and "drop_columns (Drop columns)" in text
    assert "random_forest (Random forest)" in text and "n_estimators: int 10..3000" in text
    assert "xgboost" not in text  # not installed here: never offered
    assert "Metrics: auto, f1_macro, accuracy" in text and "code" not in text.split("Models you can add:")[1]


def test_steps_and_models_are_checked_and_their_settings_coerced(churn):
    model = churn["models"][1]
    found = ai_project.actions(
        [
            action(change="train"),
            action(
                change="add_step", op="drop_columns", params_json=json.dumps({"columns": "customer_id", "bogus": 1})
            ),
            action(change="add_model", op="random_forest", params_json='{"n_estimators": "9000", "max_depth": 6.4}'),
            action(change="update", item=model["id"], params_json='{"enabled": false, "tune": "quick"}'),
            action(change="settings", metric="accuracy", target=""),
            action(change="settings", metric="r2"),  # a regression metric on a classifier: nothing left to do
            action(change="add_model", op="xgboost"),  # not installed
            action(change="add_step", op="no_such_step"),
            action(change="remove", item="missing-id"),
            action(change="add_step", op="custom_clean"),  # code steps come from the Python view, not a chat
            {"type": "sql", "sql": "select 1"},
        ],
        churn,
        PACKAGES,
    )
    assert [a["change"] for a in found] == ["add_step", "add_model", "update", "settings", "train"]
    step, forest, update, settings, train = found
    assert step["stage"] == "clean" and step["params"] == {"columns": ["customer_id"]} and step["dropped"] == ["bogus"]
    assert step["label"] == "Add clean step: Drop columns"
    assert forest["params"] == {"n_estimators": 3000, "max_depth": 6}  # clamped to the allowed range, made whole
    assert update["item"] == model["id"] and update["params"] == {"enabled": False, "tune": "quick"}
    assert update["stage"] == "models" and update["label"] == f"Change {model['label']}"
    assert settings["metric"] == "accuracy" and settings["label"] == "Set metric accuracy"
    assert train["label"] == "Train the models"


def test_an_update_that_changes_nothing_real_is_dropped(churn):
    model = churn["models"][1]
    assert (
        ai_project.actions([action(change="update", item=model["id"], params_json='{"nope": 3}')], churn, PACKAGES)
        == []
    )
    assert (
        ai_project.actions([action(change="update", item=model["id"], params_json="not json")], churn, PACKAGES) == []
    )
    assert ai_project.actions([action(change="train")], None, PACKAGES) == []


def test_chat_sends_the_project_and_returns_checked_changes(ws, churn):
    reply = {
        "message": "I added a random forest with more trees and turned off the baseline.",
        "actions": [
            action(change="add_model", op="random_forest", params_json='{"n_estimators": 400}'),
            action(change="update", item=churn["models"][0]["id"], params_json='{"enabled": false}'),
            action(change="train"),
        ],
    }
    fake = Fake([(200, chat(json.dumps(reply)))])
    try:
        ai.configure(ws, provider="custom", base_url=fake.url + "/v1", model="local")
        answer = ai.chat(ws, [{"role": "user", "content": "try a bigger forest and train"}],
                         view="the machine learning project", context="Last training: none.", can=["project"],
                         dataset_id=churn["dataset_id"], project=churn, packages=env.packages())  # fmt: skip
    finally:
        fake.close()
    assert [a["change"] for a in answer["actions"]] == ["add_model", "update", "train"]
    assert answer["actions"][0]["params"] == {"n_estimators": 400}
    system = fake.requests[0]["body"]["messages"][0]["content"]
    assert '"project" changes the machine learning project' in system
    assert f"id {churn['models'][0]['id']}" in system and "Models you can add:" in system
    assert fake.requests[0]["body"]["response_format"] == {"type": "json_object"}
    # Claude gets the strict schema: every field is required there
    assert "params_json" in ai.CHAT_SCHEMA["properties"]["actions"]["items"]["required"]


def test_project_changes_need_the_project(ws, churn):
    reply = {"message": "Done.", "actions": [action(change="train")]}
    fake = Fake([(200, chat(json.dumps(reply)))])
    try:
        ai.configure(ws, provider="custom", base_url=fake.url + "/v1", model="local")
        answer = ai.chat(ws, [{"role": "user", "content": "train"}], can=["project"])  # no project sent
    finally:
        fake.close()
    assert answer["actions"] == []
    assert '"project" changes' not in fake.requests[0]["body"]["messages"][0]["content"]
