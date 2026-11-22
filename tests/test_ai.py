"""Ask AI's providers: keys in the keychain, the request each API gets, and how answers are read.
Every provider is played by a small local server: nothing leaves this computer."""

from __future__ import annotations

import dataclasses
import importlib.util
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from flowlabs.core import ai, datasets, vault
from flowlabs.core.util import UserError

HAS_ANTHROPIC = importlib.util.find_spec("anthropic") is not None
ANSWER = {"sql": "select count(*) as customers from data", "explanation": "How many customers there are."}


class Fake:
    """A chat API that records each request and answers with ``replies`` in turn (status, body)."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.requests: list[dict] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                fake.requests.append(
                    {"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body}
                )
                status, reply = fake.replies.pop(0) if len(fake.replies) > 1 else fake.replies[0]
                data = json.dumps(reply).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):  # noqa: N802
                fake.requests.append(
                    {"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": None}
                )
                status, reply = fake.replies.pop(0) if len(fake.replies) > 1 else fake.replies[0]
                data = json.dumps(reply).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()


def chat(content: str) -> dict:
    return {"choices": [{"message": {"role": "assistant", "content": content}}]}


@pytest.fixture(autouse=True)
def no_env_keys(monkeypatch):
    for name in (
        "GROQ_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GITHUB_TOKEN",
        "GEMINI_API_KEY",
        "FLOWLABS_AI_URL",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def churn_id(ws):
    return datasets.import_sample(ws, "churn")["id"]


def test_every_provider_is_listed_and_groq_is_the_default(ws):
    status = ai.status(ws)
    assert status["provider"] == "groq" and not status["configured"]
    ids = [p["id"] for p in status["providers"]]
    assert ids == ["groq", "gemini", "openai", "anthropic", "github", "freellmapi", "omniroute", "custom"]
    for provider in status["providers"]:  # every provider says how to get its key
        assert len(provider["steps"]) >= 3 and "{url}" not in " ".join(provider["steps"])
    claude = next(p for p in status["providers"] if p["id"] == "anthropic")
    assert claude["model"] == "claude-opus-5-5" and claude["env"] == "ANTHROPIC_API_KEY"
    assert next(p for p in status["providers"] if p["id"] == "custom")["needs_url"]


def test_keys_go_to_the_keychain_never_to_the_settings_file(ws):
    status = ai.configure(ws, key="sk-proj-" + "a" * 40, model="gpt-4.1-mini", provider="openai")
    assert status["provider"] == "openai" and status["configured"] and status["model"] == "gpt-4.1-mini"
    assert vault.get(ws, "ai:openai") == "sk-proj-" + "a" * 40
    assert "sk-proj" not in (ws.root / "ai.json").read_text() and "sk-proj" not in json.dumps(status)
    # each provider keeps its own key and model; switching back keeps them
    ai.configure(ws, key="gsk_" + "b" * 40, provider="groq")
    assert ai.status(ws)["provider"] == "groq"
    assert ai.configure(ws, provider="openai")["model"] == "gpt-4.1-mini"
    assert not ai.configure(ws, key="", provider="openai")["configured"]


def test_an_old_groq_key_moves_into_the_keychain(ws):
    ws.write_json(ws.root / "ai.json", {"key": "gsk_" + "c" * 40, "model": "llama-3.1-8b-instant"})
    status = ai.status(ws)
    assert status["configured"] and status["model"] == "llama-3.1-8b-instant" and status["source"] == "saved"
    assert "gsk_" not in (ws.root / "ai.json").read_text()


def test_environment_keys_win(ws, monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "github_pat_" + "d" * 40)
    status = ai.configure(ws, provider="github")
    assert status["configured"] and status["source"] == "environment"


def test_mistakes_in_settings(ws):
    with pytest.raises(UserError, match="does not look like"):
        ai.configure(ws, key="no spaces please", provider="openai")
    with pytest.raises(UserError, match="AI providers"):
        ai.configure(ws, provider="copilot")
    with pytest.raises(UserError, match="web address"):
        ai.configure(ws, provider="custom", base_url="llm.example.com")


def test_custom_endpoint_gets_an_openai_request(ws, churn_id):
    fake = Fake([(200, chat(json.dumps(ANSWER)))])
    try:
        status = ai.configure(ws, provider="custom", base_url=fake.url + "/v1/", model="company-llm", key="k" * 20)
        assert status["configured"] and status["base_url"] == fake.url + "/v1/chat/completions"
        assert next(p for p in status["providers"] if p["id"] == "custom")["base_url"] == fake.url + "/v1"
        answer = ai.write_sql(ws, "how many customers?", dataset_id=churn_id)
    finally:
        fake.close()
    assert answer["sql"] == ANSWER["sql"] and answer["provider"] == "Custom endpoint"
    sent = fake.requests[0]
    assert sent["path"] == "/v1/chat/completions" and sent["headers"]["authorization"] == "Bearer " + "k" * 20
    assert sent["body"]["model"] == "company-llm" and sent["body"]["response_format"] == {"type": "json_object"}
    assert "data (2000 rows)" in sent["body"]["messages"][1]["content"]


def test_a_server_without_json_mode_is_asked_again_and_fences_are_read(ws, churn_id):
    fenced = "```json\n" + json.dumps(ANSWER) + "\n```"
    fake = Fake([(400, {"error": {"message": "response_format is not supported"}}), (200, chat(fenced))])
    try:
        ai.configure(ws, provider="custom", base_url=fake.url, model="local")  # no key: a local server
        answer = ai.write_sql(ws, "how many customers?", dataset_id=churn_id)
    finally:
        fake.close()
    assert answer["sql"] == ANSWER["sql"]
    assert "response_format" in fake.requests[0]["body"] and "response_format" not in fake.requests[1]["body"]
    assert "authorization" not in fake.requests[0]["headers"]


@pytest.mark.parametrize(("provider", "key"), [("openai", "sk-" + "e" * 40), ("github", "github_pat_" + "f" * 40)])
def test_hosted_providers(ws, churn_id, monkeypatch, provider, key):
    fake = Fake([(200, chat(json.dumps(ANSWER)))])
    monkeypatch.setenv("FLOWLABS_AI_URL", fake.url + "/chat/completions")
    try:
        ai.configure(ws, provider=provider, key=key)
        ai.write_sql(ws, "how many customers?", dataset_id=churn_id)
    finally:
        fake.close()
    body, headers = fake.requests[0]["body"], fake.requests[0]["headers"]
    if provider == "openai":  # GPT-5 models: no temperature, completion tokens include thinking
        assert "temperature" not in body and body["max_completion_tokens"] == 4000 and body["model"] == "gpt-5-mini"
    else:
        assert headers["accept"] == "application/vnd.github+json" and body["model"] == "openai/gpt-4.1"


def test_a_rejected_key_is_explained(ws, churn_id, monkeypatch):
    fake = Fake([(401, {"error": {"message": "Invalid API key"}})])
    monkeypatch.setenv("FLOWLABS_AI_URL", fake.url)
    try:
        ai.configure(ws, provider="groq", key="gsk_" + "g" * 40)
        with pytest.raises(UserError, match="Groq did not accept the key"):
            ai.write_sql(ws, "how many customers?", dataset_id=churn_id)
    finally:
        fake.close()


def test_claude_without_its_package_says_how_to_get_it(ws, churn_id, monkeypatch):
    monkeypatch.setattr(ai.plugins, "missing", lambda modules: list(modules))
    status = ai.configure(ws, provider="anthropic", key="sk-ant-" + "h" * 40)
    assert not status["configured"] and next(p for p in status["providers"] if p["id"] == "anthropic")["needs_package"]
    with pytest.raises(UserError, match="Install it in Ask AI's settings"):
        ai.write_sql(ws, "how many customers?", dataset_id=churn_id)


def _claude_reply(text: str, stop: str = "end_turn") -> dict:
    return {"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
            "content": [{"type": "text", "text": text}] if text else [], "stop_reason": stop,
            "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 10}}  # fmt: skip


@pytest.mark.skipif(not HAS_ANTHROPIC, reason="the anthropic package is not installed")
def test_claude_through_anthropics_sdk(ws, churn_id, monkeypatch):
    fake = Fake([(200, _claude_reply(json.dumps(ANSWER)))])
    monkeypatch.setenv("ANTHROPIC_BASE_URL", fake.url)
    try:
        ai.configure(ws, provider="anthropic", key="sk-ant-" + "i" * 40)
        answer = ai.write_sql(ws, "how many customers?", dataset_id=churn_id)
        ai.configure(ws, provider="anthropic", model="claude-haiku-5-5")
        ai.write_sql(ws, "how many customers?", dataset_id=churn_id)
    finally:
        fake.close()
    assert answer["sql"] == ANSWER["sql"]
    first, second = fake.requests
    key = "sk-ant-" + "i" * 40
    assert first["path"].startswith("/v1/messages")
    assert key in (first["headers"].get("x-api-key"), first["headers"].get("authorization", "").removeprefix("Bearer "))
    body = first["body"]
    assert body["model"] == "claude-opus-5-5" and "temperature" not in body
    assert body["output_config"]["format"]["schema"]["required"] == ["sql", "explanation"]
    assert body["fallbacks"] == "default" and "server-side-fallback" in first["headers"]["anthropic-beta"]
    assert "data (2000 rows)" in body["messages"][0]["content"] and "SQL" in body["system"]
    # Haiku has no server-side fallback: a plain request
    assert second["body"]["model"] == "claude-haiku-5-5" and "fallbacks" not in second["body"]


@pytest.mark.skipif(not HAS_ANTHROPIC, reason="the anthropic package is not installed")
def test_claude_refusals_and_bad_keys(ws, churn_id, monkeypatch):
    fake = Fake(
        [
            (200, _claude_reply("", "refusal")),
            (401, {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}),
        ]
    )
    monkeypatch.setenv("ANTHROPIC_BASE_URL", fake.url)
    try:
        ai.configure(ws, provider="anthropic", key="sk-ant-" + "j" * 40)
        with pytest.raises(UserError, match="declined"):
            ai.write_sql(ws, "how many customers?", dataset_id=churn_id)
        with pytest.raises(UserError, match="did not accept the API key"):
            ai.write_sql(ws, "how many customers?", dataset_id=churn_id)
    finally:
        fake.close()


def test_local_gateways_need_no_setup_beyond_a_key(ws, churn_id, monkeypatch):
    status = ai.configure(ws, provider="freellmapi")
    assert status["configured"] and status["model"] == "auto"  # where it listens, and its own router
    assert status["base_url"] == "http://localhost:3001/v1/chat/completions"
    fake = Fake([(200, chat(json.dumps(ANSWER)))])
    try:
        ai.configure(ws, provider="freellmapi", base_url=fake.url + "/v1", key="freellmapi-" + "k" * 30)
        answer = ai.write_sql(ws, "how many customers?", dataset_id=churn_id)
    finally:
        fake.close()
    assert answer["sql"] == ANSWER["sql"] and fake.requests[0]["path"] == "/v1/chat/completions"
    assert fake.requests[0]["body"]["model"] == "auto"
    assert fake.requests[0]["headers"]["authorization"] == "Bearer freellmapi-" + "k" * 30
    # OmniRoute has no model until you pick one
    assert not ai.configure(ws, provider="omniroute")["configured"]


def test_models_are_listed_from_the_endpoint(ws):
    fake = Fake([(200, {"object": "list", "data": [{"id": "zeta"}, {"id": "auto"}, {"id": "models/gemini-x"}]})])
    try:
        names = ai.models(ws, "custom", base_url=fake.url + "/v1", key="k" * 20)
    finally:
        fake.close()
    assert names == ["auto", "gemini-x", "zeta"]
    assert (
        fake.requests[0]["path"] == "/v1/models"
        and fake.requests[0]["headers"]["authorization"] == "Bearer " + "k" * 20
    )
    with pytest.raises(UserError, match="Is it running"):
        ai.models(ws, "custom", base_url="http://127.0.0.1:9/v1")


def test_detect_local_gateways(monkeypatch):
    up = Fake([(401, {"error": {"message": "missing key"}})])
    try:
        monkeypatch.setitem(
            ai.PROVIDERS, "freellmapi", dataclasses.replace(ai.PROVIDERS["freellmapi"], base_default=up.url + "/v1")
        )
        monkeypatch.setitem(
            ai.PROVIDERS,
            "omniroute",
            dataclasses.replace(ai.PROVIDERS["omniroute"], base_default="http://127.0.0.1:9/v1"),
        )
        found = ai.detect()
    finally:
        up.close()
    assert found["freellmapi"] == {"running": True, "needs_key": True, "url": up.url + "/v1"}
    assert found["omniroute"]["running"] is False


def test_answers_that_are_not_json(ws, churn_id):
    assert ai._parse_answer("Sure! Here you go:\n```sql\nselect 1\n```") == {"sql": "select 1", "explanation": ""}
    assert ai._parse_answer("Try: SELECT count(*) FROM data")["sql"] == "SELECT count(*) FROM data"
    assert ai._parse_answer("with t as (select 1) select * from t")["sql"].startswith("with t as")
    assert ai._parse_answer("Answer:\nselect 42")["sql"] == "select 42"
    for prose in ("I cannot help with that.", "You could select the best plan yourself.", "Done with it"):
        assert ai._parse_answer(prose)["sql"] == "", prose
    assert ai._parse_answer('```json\n{"sql": "select 2", "explanation": "x"}\n```')["sql"] == "select 2"
    fake = Fake([(200, chat("I cannot help with that."))])
    try:
        ai.configure(ws, provider="custom", base_url=fake.url, model="local")
        with pytest.raises(UserError, match="answered without SQL: I cannot help with that"):
            ai.write_sql(ws, "how many customers?", dataset_id=churn_id)
    finally:
        fake.close()


# ------------------------------------------------------------------ the AI panel

QUERY = {"type": "sql", "sql": "select plan_type, count(*) from data group by 1", "run": True,
         "sheet": "", "start": "", "values": []}  # fmt: skip
CELLS = {"type": "cells", "sql": "", "run": False, "sheet": "", "start": "d1",
         "values": [["Total"], ["=SUM(B2:B10)"]]}  # fmt: skip


def _custom(ws, fake):
    ai.configure(ws, provider="custom", base_url=fake.url + "/v1", model="local")


def test_a_question_about_a_query_gets_sql_to_put_in_the_editor(ws, churn_id):
    reply = {"message": "Customers per plan.", "actions": [QUERY, CELLS]}
    fake = Fake([(200, chat(json.dumps(reply)))])
    try:
        _custom(ws, fake)
        answer = ai.chat(
            ws,
            [{"role": "user", "content": "customers per plan"}],
            view="SQL editor",
            context="Current query:\nselect * from data",
            can=["sql"],
            dataset_id=churn_id,
        )
    finally:
        fake.close()
    # the sheet edit is dropped: this page has no sheet
    assert answer["message"] == "Customers per plan." and answer["actions"] == [
        {"type": "sql", "sql": QUERY["sql"], "run": True}
    ]
    system, question = fake.requests[0]["body"]["messages"]
    assert system["role"] == "system" and question == {"role": "user", "content": "customers per plan"}
    text = system["content"]
    assert "data (2000 rows)" in text and "select * from data" in text and "this project's data" in text
    assert '"sql" replaces the query' in text and '"cells" writes' not in text and "DuckDB" in text
    assert fake.requests[0]["body"]["max_tokens"] == 4000


def test_a_sheet_gets_cells_and_the_conversation_goes_along(ws):
    reply = {"message": "Added a total.", "actions": [CELLS, QUERY, {**CELLS, "start": "not a cell"}]}
    fake = Fake([(200, chat(json.dumps(reply)))])
    history = [
        {"role": "assistant", "content": "Hi! How can I help?"},  # a greeting first: dropped
        {"role": "user", "content": "what is in column B?"},
        {"role": "assistant", "content": "Sales per month."},
        {"role": "user", "content": "add a total"},
        {"role": "user", "content": "in D"},  # two in a row are joined
    ]
    try:
        _custom(ws, fake)
        answer = ai.chat(ws, history, view="Sheet1 of Sales", context="A1: Month, B1: Sales", can=["cells"])
    finally:
        fake.close()
    assert answer["actions"] == [{"type": "cells", "sheet": "", "start": "D1", "values": [["Total"], ["=SUM(B2:B10)"]]}]
    sent = fake.requests[0]["body"]["messages"]
    assert [m["role"] for m in sent] == ["system", "user", "assistant", "user"]
    assert sent[-1]["content"] == "add a total\n\nin D"
    assert "Tables:" not in sent[0]["content"] and '"cells" writes' in sent[0]["content"]


def test_plain_text_answers_and_odd_values(ws):
    parsed = ai._parse_chat("Here it is:\n```sql\nselect 1\n```\nIt counts.", {"sql"})
    assert parsed == {
        "message": "Here it is:\n\nIt counts.",
        "actions": [{"type": "sql", "sql": "select 1", "run": False}],
    }
    assert ai._parse_chat("```sql\nselect 1\n```", set())["actions"] == []  # nothing to put it in
    wrapped = (
        'Sure: {"message": "ok", "actions": [{"type": "cells", "start": "$A$1", "values": [[1, 2.0, true, null]]}]}'
    )
    assert ai._parse_chat(wrapped, {"cells"})["actions"][0] == {
        "type": "cells", "sheet": "", "start": "A1", "values": [["1", "2", "TRUE", ""]]
    }  # fmt: skip
    too_many = {"type": "cells", "start": "A1", "values": [["x"] * 100] * 30}
    assert ai._actions([too_many], {"cells"}) == []


def test_mistakes(ws):
    with pytest.raises(UserError, match="Add a Groq API key"):
        ai.chat(ws, [{"role": "user", "content": "hi"}])
    fake = Fake([(200, chat(json.dumps({"message": "", "actions": []})))])
    try:
        _custom(ws, fake)
        with pytest.raises(UserError, match="Ask something first"):
            ai.chat(ws, [{"role": "assistant", "content": "hello"}])
        with pytest.raises(UserError, match="empty answer"):
            ai.chat(ws, [{"role": "user", "content": "hi"}])
    finally:
        fake.close()


def test_a_database_that_is_down_does_not_stop_the_chat(ws, monkeypatch):
    def down(*args):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(ai, "schema", down)
    fake = Fake([(200, chat(json.dumps({"message": "It is down.", "actions": []})))])
    try:
        _custom(ws, fake)
        answer = ai.chat(ws, [{"role": "user", "content": "why?"}], can=["sql"], connection_id="c1")
    finally:
        fake.close()
    assert answer["message"] == "It is down."
    assert "could not be listed: connection refused" in fake.requests[0]["body"]["messages"][0]["content"]


@pytest.mark.skipif(not HAS_ANTHROPIC, reason="the anthropic package is not installed")
def test_claude_holds_the_conversation_to_the_answer_shape(ws, churn_id, monkeypatch):
    fake = Fake([(200, _claude_reply(json.dumps({"message": "Done.", "actions": [QUERY]})))])
    monkeypatch.setenv("ANTHROPIC_BASE_URL", fake.url)
    try:
        ai.configure(ws, provider="anthropic", key="sk-ant-" + "k" * 40)
        answer = ai.chat(
            ws,
            [{"role": "user", "content": "per plan"}, {"role": "assistant", "content": "Which?"},
             {"role": "user", "content": "all"}],
            can=["sql"],
            dataset_id=churn_id,
        )  # fmt: skip
    finally:
        fake.close()
    assert answer["actions"][0]["sql"] == QUERY["sql"]
    body = fake.requests[0]["body"]
    assert [m["role"] for m in body["messages"]] == ["user", "assistant", "user"]
    assert "FlowLabs" in body["system"] and body["thinking"] == {"type": "adaptive"}
    assert body["output_config"]["format"]["schema"]["required"] == ["message", "actions"]
