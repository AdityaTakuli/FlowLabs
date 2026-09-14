"""Model-specific request options for the Groq client."""

from __future__ import annotations

import io
import json
from typing import Any

import pytest
from flowlab_agent import GroqClient, Message
from flowlab_agent.llm import DEFAULT_GROQ_MODEL


class _Response(io.BytesIO):
    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


def _capture(model: str | None) -> tuple[GroqClient, dict[str, Any]]:
    seen: dict[str, Any] = {}

    def opener(request: Any, timeout: float) -> _Response:
        seen["body"] = json.loads(request.data)
        payload = {"choices": [{"message": {"content": "{}"}}], "usage": {}}
        return _Response(json.dumps(payload).encode())

    client = GroqClient("k", model, opener=opener)
    client.complete([Message("user", "u")])
    return client, seen


def test_default_model_is_gpt_oss_with_low_reasoning(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FLOWLAB_LLM_MODEL", raising=False)
    client, seen = _capture(None)
    assert client.model == DEFAULT_GROQ_MODEL == "openai/gpt-oss-20b"
    assert seen["body"]["reasoning_effort"] == "low"


def test_non_reasoning_models_get_no_reasoning_option() -> None:
    _, seen = _capture("qwen/qwen3.6-27b")
    assert "reasoning_effort" not in seen["body"]


def test_model_can_be_overridden_by_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FLOWLAB_LLM_MODEL", "openai/gpt-oss-120b")
    client, seen = _capture(None)
    assert client.model == "openai/gpt-oss-120b" and seen["body"]["reasoning_effort"] == "low"
