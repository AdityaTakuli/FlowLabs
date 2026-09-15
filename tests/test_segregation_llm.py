"""Stages 4–6: fingerprints only, budgets, caching, validation with retry, fallback. No network."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from flowlab_lab.segregation import SegregationOptions, analyse
from flowlab_lab.segregation.llm import Completion, name_problem, responsibility_problem
from flowlab_lab.segregation.validate import structural_violations
from test_segregation import ML_REPO, NOTEBOOK, write

Responder = Callable[[list[dict[str, str]], int], str]


class FakeModel:
    model = "fake-model"

    def __init__(self, respond: Responder) -> None:
        self.respond = respond
        self.prompts: list[list[dict[str, str]]] = []

    def complete(self, messages: list[dict[str, str]], *, max_tokens: int) -> Completion:
        self.prompts.append(messages)
        text = self.respond(messages, len(self.prompts))
        return Completion(
            text=text,
            prompt_tokens=sum(len(m["content"]) for m in messages) // 4,
            completion_tokens=len(text) // 4,
        )


def fingerprints(messages: list[dict[str, str]]) -> list[dict[str, Any]]:
    content = messages[1]["content"]
    marker = "CLUSTERS:\n" if "CLUSTERS:\n" in content else "COMPONENTS:\n"
    return json.loads(content.split(marker, 1)[1].split("\n", 1)[0])


def stage(messages: list[dict[str, str]]) -> str:
    system = messages[0]["content"]
    return "stage5" if "TASK: CLASSIFY" in system else "stage6" if "TASK: CONTRACTS" in system else "stage4"


def good_reply(messages: list[dict[str, str]], _: int, *, archetype: bool = True) -> str:
    kind = stage(messages)
    items = fingerprints(messages if len(messages) == 2 else messages[:2])
    if kind == "stage4":
        components = []
        for fp in items:
            entry = {"cluster_id": fp["cluster_id"], "name": f"Customer {fp['cluster_id']} stage",
                     "responsibility": "Handles one step of the churn workflow.", "confidence": "medium"}  # fmt: skip
            if archetype:
                entry["archetype"] = "service"
            components.append(entry)
        return json.dumps({"components": components, "changes": []})
    if kind == "stage5":
        return json.dumps(
            {
                "archetypes": [
                    {
                        "cluster_id": s["cluster_id"],
                        "archetype": "utility",
                        "confidence": "low",
                        "reason": "Generic helpers.",
                    }
                    for s in items
                ]
            }
        )
    return json.dumps(
        {"contracts": [{"cluster_id": s["cluster_id"], "responsibility": "Handles one step."} for s in items]}
    )


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = write(tmp_path / "ml", ML_REPO)
    (root / "analysis.ipynb").write_text(json.dumps(NOTEBOOK))
    return root


def options(tmp_path: Path, **extra: Any) -> SegregationOptions:
    return SegregationOptions(use_git=False, use_llm=True, cache_dir=tmp_path / "cache", **extra)


def test_prompts_carry_fingerprints_never_code(repo: Path, tmp_path: Path) -> None:
    model = FakeModel(good_reply)
    analyse(repo, options(tmp_path), completer=model)
    assert model.prompts
    everything = "\n".join(m["content"] for prompt in model.prompts for m in prompt)
    for forbidden in (
        "dropna(subset",
        "More detail that must never",
        "return pd.read_csv",
        "test_drop_bad_rows",
        "site.py",
        "def upgrade",
    ):
        assert forbidden not in everything  # SEG-089
    stage4 = [p for p in model.prompts if stage(p) == "stage4"]
    assert "You never\nreceive source code" in stage4[0][0]["content"]  # SEG-088 static prefix
    for prompt in stage4:
        prints = fingerprints(prompt)
        assert len(prints) <= 12 and all(len(fp["units"]) <= 12 for fp in prints)  # SEG-084
        assert len({fp["cluster_id"] for fp in prints}) == len(prints)  # never the same fingerprint twice
        assert all(
            len(u.get("sig", "")) <= 100 and len(u.get("doc", "")) <= 120
            for fp in prints
            for u in fp["units"]
        )


def test_names_are_applied_and_traceable(repo: Path, tmp_path: Path) -> None:
    deterministic = analyse(repo, SegregationOptions(use_git=False)).manifest
    result = analyse(repo, options(tmp_path), completer=FakeModel(good_reply)).manifest
    assert structural_violations(result) == []
    assert result.llm.status == "used" and result.llm.tokens_used > 0 and result.stats.tokens_used > 0
    assert all(
        c.name.startswith("Customer c") and c.decided_by == "llm" and c.reason for c in result.components
    )
    before = {frozenset(c.units): c for c in deterministic.components}
    for component in result.components:
        old = before[frozenset(component.units)]
        if old.archetype_confidence != "low":  # rules win for confidently classified components (SEG-038)
            assert component.archetype == old.archetype and component.archetype_decided_by == "rule"
        else:
            assert component.archetype == "service" and component.archetype_decided_by == "llm"


def test_budget_checkpoint_stops_before_any_call(repo: Path, tmp_path: Path) -> None:
    model = FakeModel(good_reply)
    result = analyse(repo, options(tmp_path, max_tokens=10), completer=model).manifest
    assert model.prompts == []  # SEG-007
    assert result.llm.status == "over_budget" and result.llm.estimated_tokens > 10
    assert all(c.name.startswith("cluster_") for c in result.components)


def test_cache_makes_reanalysis_free_and_identical(repo: Path, tmp_path: Path) -> None:
    first_model = FakeModel(good_reply)
    first = analyse(repo, options(tmp_path), completer=first_model).manifest
    second_model = FakeModel(good_reply)
    second = analyse(repo, options(tmp_path), completer=second_model).manifest
    assert second_model.prompts == [] and second.llm.cached_calls >= len(first_model.prompts)  # SEG-086
    assert [c.name for c in first.components] == [c.name for c in second.components]  # SEG-006


def test_invalid_output_is_retried_once_then_deterministic_stands(repo: Path, tmp_path: Path) -> None:
    def banned(messages: list[dict[str, str]], _: int) -> str:
        if stage(messages) != "stage4":
            return good_reply(messages, 0)
        prints = fingerprints(messages[:2])
        return json.dumps(
            {
                "components": [
                    {
                        "cluster_id": fp["cluster_id"],
                        "name": "utils",
                        "responsibility": "Does stuff.",
                        "archetype": "service",
                    }
                    for fp in prints
                ],
                "changes": [],
            }
        )

    model = FakeModel(banned)
    result = analyse(repo, options(tmp_path), completer=model).manifest
    stage4 = [p for p in model.prompts if stage(p) == "stage4"]
    assert len(stage4) % 2 == 0 and any(
        "SEG-062" in p[-1]["content"] for p in stage4 if len(p) == 4
    )  # SEG-094 retry
    assert all(not c.name.lower().startswith("utils") for c in result.components)
    assert result.llm.status in ("partial", "failed") and any("rejected twice" in n for n in result.llm.notes)
    assert structural_violations(result) == []


def test_merging_pipeline_stages_is_rejected(repo: Path, tmp_path: Path) -> None:
    def merge_split_and_train(messages: list[dict[str, str]], _: int) -> str:
        if stage(messages) != "stage4":
            return good_reply(messages, 0)
        prints = fingerprints(messages[:2])

        def cluster_with(name: str) -> str | None:
            return next(
                (fp["cluster_id"] for fp in prints if any(u["name"] == name for u in fp["units"])), None
            )

        split, train = cluster_with("split_data"), cluster_with("train_model")
        if len(messages) == 2 and split and train:
            return json.dumps(
                {
                    "components": [],
                    "changes": [{"op": "merge", "clusters": [split, train], "reason": "Both are modelling."}],
                }
            )
        return good_reply(messages, 0)

    model = FakeModel(merge_split_and_train)
    result = analyse(repo, options(tmp_path), completer=model).manifest
    retries = [p for p in model.prompts if stage(p) == "stage4" and len(p) == 4]
    assert any("SEG-052" in p[-1]["content"] for p in retries)
    homes = {u.name: u.component_id for u in result.units}
    assert homes["split_data"] != homes["train_model"]


def test_split_change_is_applied_with_reason(repo: Path, tmp_path: Path) -> None:
    def split_evaluation(messages: list[dict[str, str]], _: int) -> str:
        if stage(messages) != "stage4":
            return good_reply(messages, 0)
        prints = fingerprints(messages[:2])
        target = next(
            (fp for fp in prints if {"evaluate", "report"} <= {u["name"] for u in fp["units"]}), None
        )
        reply = json.loads(good_reply(messages, 0))
        if target:
            ids = {u["name"]: u["id"] for u in target["units"]}
            reply["changes"] = [
                {
                    "op": "split",
                    "cluster": target["cluster_id"],
                    "partition": [[ids["evaluate"]], [ids["report"]]],
                    "reason": "Reporting is separate from scoring.",
                }
            ]
        return json.dumps(reply)

    result = analyse(repo, options(tmp_path), completer=FakeModel(split_evaluation)).manifest
    homes = {u.name: u.component_id for u in result.units}
    assert homes["evaluate"] != homes["report"]
    by_id = {c.id: c for c in result.components}
    assert "Reporting is separate from scoring." in by_id[str(homes["report"])].reason
    assert structural_violations(result) == []


def test_stage5_only_sees_ambiguous_components(repo: Path, tmp_path: Path) -> None:
    deterministic = analyse(repo, SegregationOptions(use_git=False)).manifest
    ambiguous = {
        frozenset(c.units)
        for c in deterministic.components
        if c.archetype_confidence == "low"
        and c.archetype_decided_by != "rule"
        or c.reason.endswith("is ambiguous.")
    }
    model = FakeModel(lambda m, n: good_reply(m, n, archetype=False))
    result = analyse(repo, options(tmp_path), completer=model).manifest
    stage5 = [p for p in model.prompts if stage(p) == "stage5"]
    if not ambiguous:
        assert stage5 == []
        return
    assert stage5
    llm_classified = {frozenset(c.units) for c in result.components if c.archetype_decided_by == "llm"}
    assert llm_classified and llm_classified <= ambiguous


def test_secrets_are_redacted_before_sending(tmp_path: Path) -> None:
    root = write(tmp_path / "leaky", {
        "client.py": '''
            import requests

            def call_api(path):
                """Uses key gsk_abcdefghijklmnopqrstuvwxyz0123 for the demo."""
                return requests.get(path)

            def call_twice(path):
                return call_api(path), call_api(path)

            def call_thrice(path):
                return call_twice(path), call_api(path)
        ''',
    })  # fmt: skip
    model = FakeModel(good_reply)
    result = analyse(root, options(tmp_path), completer=model).manifest
    everything = "\n".join(m["content"] for prompt in model.prompts for m in prompt)
    assert "gsk_abcdefghijklmnopqrstuvwxyz0123" not in everything and "«masked:groq_key»" in everything
    assert any("SEG-090" in n for n in result.llm.notes)


def test_provider_failure_keeps_deterministic_result(repo: Path, tmp_path: Path) -> None:
    def broken(messages: list[dict[str, str]], _: int) -> str:
        raise ConnectionError("provider down")

    result = analyse(repo, options(tmp_path), completer=FakeModel(broken)).manifest
    assert result.llm.status == "failed" and all(c.name.startswith("cluster_") for c in result.components)
    assert structural_violations(result) == []


@pytest.mark.parametrize(
    ("name", "ok"),
    [
        ("Customer feature builder", True),
        ("utils", False),
        ("Core pipeline stage", False),
        ("Pandas layer", False),
        ("Loader", False),
    ],
)
def test_name_rules(name: str, ok: bool) -> None:
    assert (name_problem(name, set()) is None) is ok


@pytest.mark.parametrize(
    ("text", "ok"),
    [
        ("Derives per-customer aggregate and encoded features from transaction history.", True),
        ("Loads and cleans data.", False),
        ("Loads raw data", False),
        ("Load raw data.", False),
        ("Loads raw data. Cleans it.", False),
    ],
)
def test_responsibility_rules(text: str, ok: bool) -> None:
    assert (responsibility_problem(text) is None) is ok
