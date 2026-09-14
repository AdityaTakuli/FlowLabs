"""Provider-abstracted LLM client (PRD 5.2). Groq is the default; nothing else is required.

Uses only the standard library for HTTP, so no SDK dependency.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any, Literal, Protocol

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b"
# Reasoning models spend completion tokens thinking; selecting snippets needs very little.
LOW_REASONING_PREFIXES = ("openai/gpt-oss",)
RETRYABLE = frozenset({429, 500, 502, 503, 504})


class LLMError(Exception):
    pass


@dataclass(frozen=True)
class Message:
    role: Literal["system", "user", "assistant"]
    content: str


@dataclass(frozen=True)
class LLMResponse:
    text: str
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached: bool = False

    @property
    def billed_tokens(self) -> int:
        return 0 if self.cached else self.prompt_tokens + self.completion_tokens


class LLMClient(Protocol):
    model: str

    def complete(
        self, messages: Sequence[Message], *, max_tokens: int = 700, json_mode: bool = True
    ) -> LLMResponse: ...


def load_api_key(env_var: str = "GROQ_API_KEY", search: Sequence[Path] | None = None) -> str | None:
    """Read the key from the environment, else from a ``.env`` file (never logged)."""
    value = os.environ.get(env_var)
    if value:
        return value.strip()
    for directory in search if search is not None else (Path.cwd(),):
        env_file = directory / ".env"
        if not env_file.is_file():
            continue
        for line in env_file.read_text(encoding="utf-8").splitlines():
            key, sep, raw = line.strip().partition("=")
            if sep and key.strip().removeprefix("export ").strip() == env_var:
                return raw.strip().strip("'\"") or None
    return None


Opener = Callable[..., Any]


class GroqClient:
    def __init__(
        self,
        api_key: str,
        model: str | None = None,
        *,
        timeout: float = 60.0,
        max_retries: int = 3,
        opener: Opener = urllib.request.urlopen,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if not api_key:
            raise LLMError("a Groq API key is required")
        self._api_key = api_key
        self.model = model or os.environ.get("FLOWLAB_LLM_MODEL") or DEFAULT_GROQ_MODEL
        self.timeout = timeout
        self.max_retries = max_retries
        self._open = opener
        self._sleep = sleep

    def __repr__(self) -> str:  # never expose the key
        return f"GroqClient(model={self.model!r})"

    def complete(
        self, messages: Sequence[Message], *, max_tokens: int = 700, json_mode: bool = True
    ) -> LLMResponse:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": [asdict(m) for m in messages],
            "temperature": 0,
            "max_tokens": max_tokens,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        if self.model.startswith(LOW_REASONING_PREFIXES):
            body["reasoning_effort"] = "low"
        request = urllib.request.Request(
            GROQ_URL,
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
                "User-Agent": "flowlab/0.1",
            },
        )
        for attempt in range(self.max_retries + 1):
            try:
                with self._open(request, timeout=self.timeout) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                break
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", "replace")[:300] if exc.fp else ""
                if exc.code in RETRYABLE and attempt < self.max_retries:
                    retry_after = exc.headers.get("retry-after") if exc.headers else None
                    try:
                        wait = float(retry_after) if retry_after else 2.0**attempt
                    except ValueError:
                        wait = 2.0**attempt
                    self._sleep(min(wait, 30.0))
                    continue
                raise LLMError(f"Groq HTTP {exc.code}: {detail}") from None
            except urllib.error.URLError as exc:
                raise LLMError(f"could not reach Groq: {exc.reason}") from None
        try:
            text = payload["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError):
            raise LLMError("unexpected response shape from Groq") from None
        usage = payload.get("usage") or {}
        return LLMResponse(
            text=text,
            model=str(payload.get("model", self.model)),
            prompt_tokens=int(usage.get("prompt_tokens", 0)),
            completion_tokens=int(usage.get("completion_tokens", 0)),
        )


class CachedClient:
    """Disk cache keyed by the exact request. Identical questions cost zero tokens."""

    def __init__(self, inner: LLMClient, directory: Path) -> None:
        self.inner = inner
        self.model = inner.model
        self.directory = directory

    def _key(self, messages: Sequence[Message], max_tokens: int, json_mode: bool) -> str:
        blob = json.dumps(
            {
                "model": self.model,
                "messages": [asdict(m) for m in messages],
                "max_tokens": max_tokens,
                "json": json_mode,
            },
            sort_keys=True,
        )
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def complete(
        self, messages: Sequence[Message], *, max_tokens: int = 700, json_mode: bool = True
    ) -> LLMResponse:
        path = self.directory / f"{self._key(messages, max_tokens, json_mode)}.json"
        if path.is_file():
            return replace(LLMResponse(**json.loads(path.read_text(encoding="utf-8"))), cached=True)
        response = self.inner.complete(messages, max_tokens=max_tokens, json_mode=json_mode)
        self.directory.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(response)), encoding="utf-8")
        return response


@dataclass
class ScriptedClient:
    """Returns canned replies in order. For tests and offline demos."""

    replies: list[str]
    model: str = "scripted"
    calls: list[list[Message]] = field(default_factory=list)

    def complete(
        self, messages: Sequence[Message], *, max_tokens: int = 700, json_mode: bool = True
    ) -> LLMResponse:
        self.calls.append(list(messages))
        if len(self.calls) > len(self.replies):
            raise LLMError("scripted client ran out of replies")
        text = self.replies[len(self.calls) - 1]
        prompt = sum(len(m.content) for m in messages) // 4
        return LLMResponse(
            text=text, model=self.model, prompt_tokens=prompt, completion_tokens=len(text) // 4
        )


class UsageLog:
    """Append-only JSONL record of tokens spent per request."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def record(self, response: LLMResponse, purpose: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "ts": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
            "purpose": purpose,
            "model": response.model,
            "prompt_tokens": response.prompt_tokens,
            "completion_tokens": response.completion_tokens,
            "cached": response.cached,
        }
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")


def estimate_tokens(messages: Sequence[Message]) -> int:
    return sum(len(m.content) for m in messages) // 4 + 4 * len(messages)
