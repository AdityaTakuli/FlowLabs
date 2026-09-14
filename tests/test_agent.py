"""Agent layer: snippet library, retrieval, composition, planning and the Groq client.

No test touches the network.
"""

from __future__ import annotations

import ast
import io
import json
import runpy
import urllib.error
from email.message import Message as HeaderMessage
from pathlib import Path
from typing import Any

import polars as pl
import pytest
from click.testing import CliRunner
from flowlab_agent import (
    CachedClient,
    DatasetDigest,
    GroqClient,
    LLMError,
    Message,
    Plan,
    PlanStep,
    ScriptedClient,
    Snippet,
    SnippetIndex,
    SnippetLibrary,
    UsageLog,
    compose,
    load_api_key,
    parse_plan,
    plan_goal,
)
from flowlab_agent.llm import GROQ_URL, estimate_tokens
from flowlab_agent.planner import build_messages
from flowlab_agent.snippets import ParamError, ParamSpec, coerce_value
from flowlab_engine.cli import main
from flowlab_nodes import infer_table_schema
from helpers import FIXTURES

LIBRARY = SnippetLibrary.load()
INDEX = SnippetIndex(LIBRARY)
CHURN = DatasetDigest.from_file(FIXTURES / "churn.csv")
GOOD_PLAN = json.dumps(
    {
        "target": "churned",
        "steps": [{"use": "model.gradient_boosting_classifier"}, {"use": "evaluate.classification_report"}],
        "note": "Boosted trees baseline for churn.",
    }
)


def fixture_file(name: str, fmt: str, directory: Path) -> Path:
    source = FIXTURES / f"{name}.csv"
    if fmt == "csv":
        return source
    frame = pl.read_csv(source)
    target = directory / f"{name}.{fmt}"
    if fmt == "parquet":
        frame.write_parquet(target)
    elif fmt == "tsv":
        frame.write_csv(target, separator="\t")
    elif fmt == "jsonl":
        frame.write_ndjson(target)
    elif fmt == "json":
        frame.write_json(target)
    elif fmt == "xlsx":
        frame.to_pandas().to_excel(target, index=False)
    return target


def run_script(script: str, directory: Path) -> dict[str, Any]:
    path = directory / "script.py"
    path.write_text(script)
    return runpy.run_path(str(path), run_name="__main__")


# ------------------------------------------------------------------------------ library


def test_library_is_valid_and_broad() -> None:
    assert LIBRARY.issues == []
    assert len(LIBRARY) >= 70
    assert set(LIBRARY.categories()) == {
        "clean",
        "evaluate",
        "explain",
        "export",
        "feature",
        "inspect",
        "load",
        "model",
        "prep",
        "split",
        "stats",
        "viz",
    }


@pytest.mark.parametrize("snippet", list(LIBRARY), ids=lambda s: s.id)
def test_snippet_runs_on_its_example(
    snippet: Snippet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    example = snippet.example
    if example.skip:
        pytest.skip(example.skip)
    digest = DatasetDigest.from_file(fixture_file(example.dataset, example.file, tmp_path))
    plan = Plan(target=example.target, steps=[PlanStep(use=snippet.id, with_=example.with_)])
    composed = compose(plan, LIBRARY, digest)
    assert composed.ok, composed.errors
    assert snippet.id in [s.snippet.id for s in composed.steps]
    monkeypatch.chdir(tmp_path)
    run_script(composed.script or "", tmp_path)


def test_placeholders_inside_string_literals_are_rejected(tmp_path: Path) -> None:
    (tmp_path / "inspect").mkdir()
    (tmp_path / "inspect" / "bad.toml").write_text(
        'id = "inspect.bad"\ntitle = "Bad snippet"\nrequires = ["df"]\n'
        "code = '''\nprint(\"column {{ column }}\")\n'''\n[params.column]\ntype = \"column\"\n"
    )
    issues = SnippetLibrary.load(tmp_path).issues
    assert any("inside a string literal" in i.message for i in issues)


def test_library_lint_catches_structural_mistakes(tmp_path: Path) -> None:
    (tmp_path / "viz").mkdir()
    (tmp_path / "viz" / "wrong_name.toml").write_text(
        "id = \"viz.other\"\ntitle = \"Mismatch\"\nrequires = [\"nope\"]\ncode = '''\nx = {{ a }}\n'''\n"
        '[params.b]\ntype = "int"\n'
    )
    messages = " | ".join(i.message for i in SnippetLibrary.load(tmp_path).issues)
    for expected in (
        "does not match file name",
        "unknown state tokens",
        "placeholders without params",
        "never used",
    ):
        assert expected in messages


@pytest.mark.parametrize(
    ("spec", "value", "expected"),
    [
        (ParamSpec(type="int", min=1, max=10), "5", 5),
        (ParamSpec(type="float"), "0.25", 0.25),
        (ParamSpec(type="bool"), "true", True),
        (ParamSpec(type="columns"), "tenure_months", ["tenure_months"]),
        (ParamSpec(type="choice", choices=["a", "b"], default="a"), None, "a"),
        (ParamSpec(type="columns", optional=True), [], None),
    ],
)
def test_param_coercion(spec: ParamSpec, value: Any, expected: Any) -> None:
    assert coerce_value(spec, value, "p", CHURN.names) == expected


@pytest.mark.parametrize(
    ("spec", "value", "message"),
    [
        (ParamSpec(type="int", max=10), 11, "<= 10"),
        (ParamSpec(type="int"), 2.5, "integer"),
        (ParamSpec(type="column"), "tenure", "did you mean 'tenure_months'"),
        (ParamSpec(type="choice", choices=["a"]), "b", "one of"),
        (ParamSpec(type="new_column"), "x); import os #", "identifier"),
        (ParamSpec(type="path"), "../../etc/passwd", "relative path"),
        (ParamSpec(type="column"), None, "required"),
        (ParamSpec(type="bool"), "yes", "true or false"),
    ],
)
def test_param_rejection(spec: ParamSpec, value: Any, message: str) -> None:
    with pytest.raises(ParamError, match=message):
        coerce_value(spec, value, "p", CHURN.names)


# ---------------------------------------------------------------------------- retrieval


def found(query: str, k: int = 12) -> list[str]:
    return [s.id for s, _ in INDEX.search(query, digest=CHURN, k=k)]


def test_retrieval_matches_intent() -> None:
    assert {"prep.impute_numeric", "clean.fill_constant", "prep.impute_categorical"} & set(
        found("fill in missing values", k=4)
    )
    assert {"stats.ttest", "stats.mann_whitney"} & set(
        found("is tenure significantly different between churned and retained customers", k=5)
    )
    predict = found("predict churn and explain what drives it")
    assert any(i.startswith("model.") for i in predict) and any(i.startswith("explain.") for i in predict)
    assert "viz.histogram" in found("plot the distribution of monthly charges", k=5)
    assert "model.kmeans" in found("segment customers into groups", k=5)


def test_retrieval_respects_limits_and_hides_auto_snippets() -> None:
    results = INDEX.search("chart plot graph visualize viz", digest=CHURN, k=20, per_category=3)
    assert sum(1 for s, _ in results if s.category == "viz") == 3
    everything = found("model predict evaluate prepare load read csv", k=50)
    assert not {"prep.ensure_numeric", "model.random_forest_auto", "evaluate.predict"} & set(everything)
    assert not any(i.startswith("load.") for i in everything)
    assert found("zzzz qqqq") == ["inspect.overview", "inspect.missing", "inspect.describe", "viz.histogram"]


# ----------------------------------------------------------------------------- composer


def test_compose_orders_steps_inserts_prerequisites_and_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plan = Plan(
        target="churned",
        steps=[
            PlanStep(use="evaluate.classification_report"),
            PlanStep(use="clean.drop_columns", with_={"columns": ["customer_id"]}),
            PlanStep(use="model.logistic_regression", with_={"class_weight": "balanced"}),
        ],
    )
    result = compose(plan, LIBRARY, CHURN, goal="predict churn")
    assert result.ok, result.errors
    assert [s.snippet.id for s in result.steps] == [
        "load.csv",
        "clean.drop_columns",
        "split.train_test",
        "prep.ensure_numeric",
        "model.logistic_regression",
        "evaluate.classification_report",
    ]
    assert [s.auto for s in result.steps] == [True, False, True, True, False, False]
    assert any("reordered" in a for a in result.adjustments)
    monkeypatch.chdir(tmp_path)
    namespace = run_script(result.script or "", tmp_path)
    assert len(namespace["y_pred"]) == 400


@pytest.mark.parametrize(
    ("plan", "message"),
    [
        (
            Plan(steps=[PlanStep(use="viz.histogrm", with_={"column": "tenure_months"})]),
            "did you mean 'viz.histogram'",
        ),
        (
            Plan(steps=[PlanStep(use="viz.histogram", with_={"column": "tenure"})]),
            "did you mean 'tenure_months'",
        ),
        (
            Plan(steps=[PlanStep(use="viz.histogram", with_={"column": "tenure_months", "colour": "red"})]),
            "unknown param 'colour'",
        ),
        (Plan(steps=[PlanStep(use="viz.histogram")]), "'column' is required"),
        (
            Plan(steps=[PlanStep(use="prep.scale", with_={"method": "zscore"})], target="churned"),
            "must be one of",
        ),
        (Plan(steps=[PlanStep(use="evaluate.classification_report")]), 'set "target"'),
        (
            Plan(target="churned", steps=[PlanStep(use="model.linear_regression")]),
            "needs a regression target",
        ),
        (Plan(target="churn", steps=[PlanStep(use="model.decision_tree")]), "target: unknown column"),
    ],
)
def test_compose_reports_actionable_errors(plan: Plan, message: str) -> None:
    result = compose(plan, LIBRARY, CHURN)
    assert not result.ok
    assert any(message in e for e in result.errors), result.errors


def test_compose_drops_duplicate_steps() -> None:
    step = PlanStep(use="viz.histogram", with_={"column": "tenure_months"})
    result = compose(Plan(steps=[step, step]), LIBRARY, CHURN)
    assert [s.snippet.id for s in result.steps] == ["load.csv", "viz.histogram"]
    assert result.adjustments == ["dropped duplicate step viz.histogram"]


def test_hostile_column_names_stay_literals(tmp_path: Path) -> None:
    hostile = 'x"); import os; os.system("echo pwned\'\n'
    frame = pl.DataFrame({hostile: [1, 2, 3], "ok": [4, 5, 6]})
    digest = DatasetDigest.from_schema(tmp_path / "hostile.csv", infer_table_schema(frame))
    result = compose(
        Plan(steps=[PlanStep(use="clean.drop_columns", with_={"columns": [hostile]})]), LIBRARY, digest
    )
    assert result.ok, result.errors
    tree = ast.parse(result.script or "")
    imported = {alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
    assert "os" not in imported
    assert not any(
        isinstance(n, ast.Call) and getattr(n.func, "attr", "") == "system" for n in ast.walk(tree)
    )


# ------------------------------------------------------------------------------ planner


def test_prompt_is_small_and_contains_no_code_or_rows() -> None:
    candidates = INDEX.search("predict churn", digest=CHURN)
    messages = build_messages("predict churn", CHURN, [s.signature() for s, _ in candidates])
    text = "\n".join(m.content for m in messages)
    assert estimate_tokens(messages) < 900
    assert "C00001" not in text  # no data rows
    for code_marker in ("X_train", "import ", ".fit(", "pd."):
        assert code_marker not in text


def test_plan_goal_happy_path(tmp_path: Path) -> None:
    client = ScriptedClient([GOOD_PLAN])
    log = UsageLog(tmp_path / "usage.jsonl")
    result = plan_goal("predict churn", CHURN, client, LIBRARY, usage_log=log)
    assert result.ok and len(result.attempts) == 1
    assert result.composed and "model.gradient_boosting_classifier" in (result.composed.script or "")
    assert result.tokens_spent > 0
    assert json.loads(log.path.read_text().splitlines()[0])["purpose"] == "plan"


def test_plan_goal_repairs_with_structured_errors() -> None:
    bad = json.dumps({"steps": [{"use": "viz.histogram", "with": {"column": "tenure"}}]})
    good = json.dumps({"steps": [{"use": "viz.histogram", "with": {"column": "tenure_months"}}]})
    client = ScriptedClient([bad, good])
    result = plan_goal("show tenure distribution", CHURN, client, LIBRARY)
    assert result.ok and len(result.attempts) == 2
    repair = client.calls[1][-1].content
    assert "did you mean 'tenure_months'" in repair
    assert [m.role for m in client.calls[1]] == ["system", "user", "assistant", "user"]


def test_plan_goal_gives_up_after_max_repairs() -> None:
    client = ScriptedClient(["not json", "{}", json.dumps({"steps": [{"use": "nope.nope"}]})])
    result = plan_goal("anything", CHURN, client, LIBRARY, max_repairs=2)
    assert not result.ok and len(result.attempts) == 3 and result.error


def test_plan_goal_surfaces_client_errors() -> None:
    result = plan_goal("anything", CHURN, ScriptedClient([]), LIBRARY)
    assert not result.ok and result.error and "ran out" in result.error


def test_parse_plan_tolerates_code_fences() -> None:
    plan, errors = parse_plan(f"Here you go:\n```json\n{GOOD_PLAN}\n```")
    assert plan is not None and not errors and plan.target == "churned"


# ---------------------------------------------------------------------------- LLM client


class FakeHTTPResponse(io.BytesIO):
    def __enter__(self) -> FakeHTTPResponse:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


def groq_payload(content: str) -> bytes:
    return json.dumps(
        {
            "model": "llama-3.1-8b-instant",
            "choices": [{"message": {"content": content}}],
            "usage": {"prompt_tokens": 512, "completion_tokens": 64},
        }
    ).encode()


def test_groq_request_shape_and_parsing() -> None:
    seen: dict[str, Any] = {}

    def opener(request: Any, timeout: float) -> FakeHTTPResponse:
        seen.update(url=request.full_url, headers=dict(request.header_items()), body=json.loads(request.data))
        return FakeHTTPResponse(groq_payload(GOOD_PLAN))

    client = GroqClient("gsk_secret", "llama-3.1-8b-instant", opener=opener)
    response = client.complete([Message("system", "s"), Message("user", "u")], max_tokens=300)
    assert seen["url"] == GROQ_URL
    assert seen["headers"]["Authorization"] == "Bearer gsk_secret"
    assert seen["body"] == {
        "model": "llama-3.1-8b-instant",
        "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}],
        "temperature": 0,
        "max_tokens": 300,
        "response_format": {"type": "json_object"},
    }
    assert (response.text, response.prompt_tokens, response.completion_tokens) == (GOOD_PLAN, 512, 64)
    assert "gsk_secret" not in repr(client)


def test_groq_retries_rate_limits_then_raises_on_auth_errors() -> None:
    attempts: list[int] = []
    sleeps: list[float] = []

    def flaky(request: Any, timeout: float) -> FakeHTTPResponse:
        attempts.append(1)
        if len(attempts) == 1:
            headers = HeaderMessage()
            headers["retry-after"] = "2"
            raise urllib.error.HTTPError(
                GROQ_URL, 429, "Too Many Requests", headers, io.BytesIO(b"slow down")
            )
        return FakeHTTPResponse(groq_payload("{}"))

    GroqClient("k", opener=flaky, sleep=sleeps.append).complete([Message("user", "u")])
    assert len(attempts) == 2 and sleeps == [2.0]

    def unauthorized(request: Any, timeout: float) -> FakeHTTPResponse:
        raise urllib.error.HTTPError(
            GROQ_URL, 401, "Unauthorized", HeaderMessage(), io.BytesIO(b"invalid api key")
        )

    with pytest.raises(LLMError, match="Groq HTTP 401: invalid api key"):
        GroqClient("k", opener=unauthorized, sleep=sleeps.append).complete([Message("user", "u")])


def test_cached_client_spends_tokens_once(tmp_path: Path) -> None:
    inner = ScriptedClient([GOOD_PLAN])
    client = CachedClient(inner, tmp_path / "cache")
    first = client.complete([Message("user", "same question")])
    second = client.complete([Message("user", "same question")])
    assert len(inner.calls) == 1
    assert not first.cached and second.cached and second.billed_tokens == 0 and second.text == first.text


def test_load_api_key_from_env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    assert load_api_key(search=[tmp_path]) is None
    (tmp_path / ".env").write_text('# comment\nexport GROQ_API_KEY="gsk_from_file"\n')
    assert load_api_key(search=[tmp_path]) == "gsk_from_file"
    monkeypatch.setenv("GROQ_API_KEY", "gsk_from_env")
    assert load_api_key(search=[tmp_path]) == "gsk_from_env"


# ---------------------------------------------------------------------------------- CLI


def test_cli_snippet_commands_and_dry_run() -> None:
    runner = CliRunner()
    check = runner.invoke(main, ["snippets", "check"])
    assert check.exit_code == 0 and "OK:" in check.output
    search = runner.invoke(
        main, ["snippets", "search", "compare groups", "--data", str(FIXTURES / "churn.csv")]
    )
    assert search.exit_code == 0 and "stats." in search.output
    dry = runner.invoke(main, ["ask", "predict churn", "--data", str(FIXTURES / "churn.csv"), "--dry-run"])
    assert dry.exit_code == 0 and "SNIPPETS:" in dry.output and "prompt tokens" in dry.output


def test_cli_ask_requires_a_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.chdir(tmp_path)
    result = CliRunner().invoke(main, ["ask", "predict churn", "--data", str(FIXTURES / "churn.csv")])
    assert result.exit_code != 0 and "GROQ_API_KEY" in result.output


def test_cli_compose_from_plan_file(tmp_path: Path) -> None:
    plan = tmp_path / "plan.json"
    plan.write_text(
        json.dumps(
            {
                "steps": [
                    {"use": "inspect.overview"},
                    {"use": "viz.bar_counts", "with": {"column": "plan_type"}},
                ]
            }
        )
    )
    out = tmp_path / "gen" / "script.py"
    result = CliRunner().invoke(
        main, ["compose", str(plan), "--data", str(FIXTURES / "churn.csv"), "--out", str(out), "--run"]
    )
    assert result.exit_code == 0, result.output
    assert out.is_file() and (out.parent / "outputs" / "bar_plan_type.png").is_file()
