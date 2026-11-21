"""Ask AI: questions in plain English become SQL, written by a model you choose.

Providers: Groq, Google Gemini, OpenAI (GPT), Anthropic (Claude), GitHub Models (GPT, Llama and
others with a GitHub token; Copilot plans get higher limits), the local gateways FreeLLMAPI and
OmniRoute (one endpoint in front of many providers' keys), and any OpenAI-compatible endpoint (a
company gateway, LM Studio, Ollama, vLLM...). Keys come from the provider's environment variable or are kept
in the system keychain (vault.py). Chat subscriptions (ChatGPT Plus, Claude Pro, Copilot) are not
API keys: these services only let other apps in through their APIs.

What is sent: your question, the table and column names with their types, and up to three example
values of each text column, so the model spells categories right. When fixing a failed query, the
query and its error message too. Rows of data are never sent.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from flowlabs import __version__

from . import datasets, plugins, sources, sql, vault
from .util import UserError
from .workspace import Workspace

TIMEOUT_S = 60
CLAUDE_TIMEOUT_S = 120  # Claude thinks before it answers
MAX_TABLES = 30
MAX_COLUMNS = 80
ANTHROPIC_PACKAGES = ("anthropic>=1.0",)


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    api: str  # "openai": chat completions; "anthropic": the Claude Messages API through its SDK
    url: str  # chat completions URL; "" when you give the address (gateways, custom)
    env: str | None
    models: tuple[str, ...]
    key_url: str
    key_help: str
    steps: tuple[str, ...]  # how to get a key, one step per line ({url} is key_url)
    key_optional: bool = False
    base_default: str = ""  # gateways: where they listen when run on this computer


PROVIDERS: dict[str, Provider] = {p.id: p for p in [
    Provider("groq", "Groq", "openai", "https://api.groq.com/openai/v1/chat/completions", "GROQ_API_KEY",
             ("llama-3.3-70b-versatile", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.1-8b-instant"),
             "https://console.groq.com/keys", "Free, fast. Keys start with gsk_.",
             ("Open console.groq.com and sign in with Google, GitHub or an email address. It is free.",
              "Open API Keys in the menu, or go straight to {url}.",
              "Click Create API Key, name it FlowLabs, and copy the key. Groq shows it only once.",
              "Paste it below and click Use Groq.")),
    Provider("gemini", "Google Gemini", "openai",
             "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", "GEMINI_API_KEY",
             ("gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"),
             "https://aistudio.google.com/apikey", "A free tier with a Google account. Keys start with AIza.",
             ("Open Google AI Studio at {url} and sign in with your Google account.",
              "Click Create API key. Pick a Google Cloud project, or let AI Studio make one.",
              "Copy the key. The free tier has daily limits; add billing in Google Cloud for more.",
              "Paste it below and click Use Google Gemini.")),
    Provider("openai", "OpenAI (GPT)", "openai", "https://api.openai.com/v1/chat/completions", "OPENAI_API_KEY",
             ("gpt-5-mini", "gpt-5", "gpt-4.1-mini", "gpt-4.1"),
             "https://platform.openai.com/api-keys",
             "Billed per use. A ChatGPT Plus or Pro plan does not include API use.",
             ("Open platform.openai.com and sign in (the same account as ChatGPT works).",
              "Under Settings, Billing, add a few dollars of credit: the API is paid separately from ChatGPT.",
              "Open API keys ({url}), click Create new secret key, name it FlowLabs, and copy it (shown once).",
              "Paste it below and click Use OpenAI (GPT).")),
    Provider("anthropic", "Anthropic (Claude)", "anthropic", "", "ANTHROPIC_API_KEY",
             ("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"),
             "https://console.anthropic.com/settings/keys",
             "Billed per use. A Claude Pro or Max plan does not include API use.",
             ("Open console.anthropic.com and sign up or sign in.",
              "Under Plans & Billing, buy some credits: the API is paid separately from the Claude app.",
              "Open API keys ({url}), click Create Key, name it FlowLabs, and copy it (shown once).",
              "Paste it below. The first time, click Install it: Claude uses Anthropic's Python package.")),
    Provider("github", "GitHub Models", "openai", "https://models.github.ai/inference/chat/completions", "GITHUB_TOKEN",
             ("openai/gpt-4.1", "openai/gpt-4.1-mini", "openai/gpt-5-mini", "meta/Llama-3.3-70B-Instruct",
              "deepseek/DeepSeek-V3-0324"),
             "https://github.com/settings/personal-access-tokens/new",
             "GPT, Llama, DeepSeek and more with a GitHub account. Free with limits; Copilot plans get more.",
             ("Sign in to github.com and open {url} (Settings, Developer settings, Fine-grained tokens).",
              "Name the token FlowLabs and pick when it expires.",
              "Under Permissions, Account permissions, set Models to Read-only. Nothing else is needed.",
              "Click Generate token, copy it, and paste it below.")),
    Provider("freellmapi", "FreeLLMAPI (local)", "openai", "", None, ("auto", "auto:fast", "auto:smartest", "auto:coding"),
             "http://localhost:3001",
             "Your own gateway: many providers' free keys behind one endpoint, picked and switched for you.",
             ("Start it on this computer: in the freellmapi folder run `docker compose up -d`, or use its desktop app.",
              "Open {url}. On the Keys page, add the providers you have keys for (Gemini, Groq, Mistral...).",
              "Copy the unified API key from the top of the Keys page, and paste it below.",
              "Leave the model as auto to let FreeLLMAPI choose, or click Load models to pick one."),
             key_optional=True, base_default="http://localhost:3001/v1"),
    Provider("omniroute", "OmniRoute (local)", "openai", "", None, (),
             "http://localhost:20128",
             "Your own gateway: connect providers once in its dashboard, use them all from one endpoint.",
             ("Start it on this computer: in the omniroute folder run `docker compose up -d`.",
              "Open {url} and connect the providers you use in its dashboard.",
              "If you turned on API keys there, create one for FlowLabs and paste it below.",
              "Click Load models and pick a model or a combo."),
             key_optional=True, base_default="http://localhost:20128/v1"),
    Provider("custom", "Custom endpoint", "openai", "", None, (),
             "", "Any server with an OpenAI-style /v1/chat/completions: a company gateway, LM Studio, Ollama, vLLM.",
             ("Find the server's address: the part before /chat/completions, e.g. https://llm.example.com/v1.",
              "If it needs a key, create one in that service's dashboard.",
              "Enter the address and key below, then click Load models, or type the model's name."),
             key_optional=True),
]}  # fmt: skip
URL_PROVIDERS = {"freellmapi", "omniroute", "custom"}  # you give (or confirm) the address
DEFAULT_PROVIDER = "groq"
# Claude models whose refusals another Claude model can take over on Anthropic's side
CLAUDE_FALLBACKS = {"claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"}

SYSTEM = """You write SQL for a data tool. Answer with JSON only: {{"sql": "...", "explanation": "..."}}.
Rules:
- Write one query in the {dialect} dialect that answers the question, using only the tables and columns listed.
- Quote a column with double quotes when its name has spaces or capitals.
- Read only: SELECT or WITH. Write INSERT, UPDATE, DELETE, CREATE or DROP only when the question asks to change data.
- {default_table}
- Give readable column names with AS, round decimals to 2 places, and order results helpfully.
- The explanation is one or two plain sentences for a non-expert: what the query returns.
- If the question cannot be answered from these tables, return an empty sql and say why in the explanation."""

ANSWER_SCHEMA = {
    "type": "object",
    "properties": {"sql": {"type": "string"}, "explanation": {"type": "string"}},
    "required": ["sql", "explanation"],
    "additionalProperties": False,
}


def _file(ws: Workspace) -> Path:
    return ws.root / "ai.json"


def _write(ws: Workspace, saved: dict[str, Any]) -> None:
    path = _file(ws)
    ws.write_json(path, saved)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _saved(ws: Workspace) -> dict[str, Any]:
    try:
        saved = dict(json.loads(_file(ws).read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return {}
    if saved.get("base_url"):  # before per-provider addresses
        saved.setdefault("base_urls", {}).setdefault("custom", saved.pop("base_url"))
        _write(ws, saved)
    if saved.get("key"):  # FlowLabs 0.5.6 kept the Groq key in this file: move it to the keychain
        vault.put(ws, "ai:groq", str(saved.pop("key")))
        if saved.get("model"):
            saved.setdefault("models", {})["groq"] = saved.pop("model")
        _write(ws, saved)
    return saved


def _provider(ws: Workspace, provider_id: str | None = None) -> Provider:
    chosen = provider_id or _saved(ws).get("provider") or DEFAULT_PROVIDER
    if chosen not in PROVIDERS:
        raise UserError("choose one of the AI providers in the list")
    return PROVIDERS[str(chosen)]


def _key(ws: Workspace, provider: Provider) -> tuple[str | None, str | None]:
    if provider.env and os.environ.get(provider.env):
        return os.environ[provider.env], "environment"
    key = vault.get(ws, f"ai:{provider.id}")
    return (key, "saved") if key else (None, None)


def _model(ws: Workspace, provider: Provider) -> str:
    chosen = (_saved(ws).get("models") or {}).get(provider.id)
    return str(chosen or (provider.models[0] if provider.models else ""))


def _base_url(ws: Workspace, provider: Provider) -> str:
    """The chat completions URL of a gateway or custom endpoint (yours, or where it listens by default)."""
    saved = (_saved(ws).get("base_urls") or {}).get(provider.id)
    if saved:
        return str(saved)
    return _chat_url(provider.base_default) if provider.base_default else ""


def _needs_package(provider: Provider) -> bool:
    return provider.api == "anthropic" and bool(plugins.missing(["anthropic"]))


def _ready(ws: Workspace, provider: Provider) -> bool:
    key, _ = _key(ws, provider)
    if provider.id in URL_PROVIDERS:
        return bool(_base_url(ws, provider)) and bool(_model(ws, provider))
    return bool(key) and not _needs_package(provider)


def status(ws: Workspace) -> dict[str, Any]:
    current = _provider(ws)
    listed = []
    for provider in PROVIDERS.values():
        _, source = _key(ws, provider)
        listed.append({"id": provider.id, "label": provider.label, "models": list(provider.models),
                       "model": _model(ws, provider), "key_url": provider.key_url, "key_help": provider.key_help,
                       "steps": [step.replace("{url}", provider.key_url) for step in provider.steps],
                       "env": provider.env, "source": source, "configured": _ready(ws, provider),
                       "needs_url": provider.id in URL_PROVIDERS, "key_optional": provider.key_optional,
                       "base_url": _base_url(ws, provider).removesuffix("/chat/completions"),
                       "local": bool(provider.base_default), "needs_package": _needs_package(provider)})  # fmt: skip
    _, source = _key(ws, current)
    return {"provider": current.id, "provider_label": current.label, "configured": _ready(ws, current),
            "source": source, "model": _model(ws, current), "models": list(current.models),
            "base_url": _base_url(ws, current), "providers": listed, "available": sys.platform != "emscripten"}  # fmt: skip


def _chat_url(base: str) -> str:
    base = base.strip().rstrip("/")
    if not re.match(r"^https?://[^\s/]+", base):
        raise UserError("the endpoint is a web address, e.g. https://llm.example.com/v1")
    return base if base.endswith("/chat/completions") else base + "/chat/completions"


def configure(ws: Workspace, key: str | None = None, model: str | None = None, provider: str | None = None,
              base_url: str | None = None) -> dict[str, Any]:  # fmt: skip
    """Use ``provider`` from now on; save its key (None keeps it, "" removes it), model and endpoint."""
    chosen = _provider(ws, provider)
    saved = _saved(ws)
    if key is not None:
        key = key.strip()
        if key and not re.fullmatch(r"[A-Za-z0-9_\-.:+/=]{16,400}", key):
            raise UserError(f"that does not look like a {chosen.label} API key")
        if key:
            vault.put(ws, f"ai:{chosen.id}", key)
        else:
            vault.delete(ws, f"ai:{chosen.id}")
    if model is not None and model.strip():
        saved.setdefault("models", {})[chosen.id] = model.strip()[:120]
    if base_url is not None:
        urls = saved.setdefault("base_urls", {})
        if base_url.strip():
            urls[chosen.id] = _chat_url(base_url)
        else:
            urls.pop(chosen.id, None)
    saved["provider"] = chosen.id
    _write(ws, saved)
    return status(ws)


def _examples(frame: Any, column: str) -> list[str]:
    """A few common values of a category column. None from numbers, nor from columns of mostly
    unique values (IDs, names, emails): they would not help, and they are the private ones."""
    values = frame[column].dropna()
    if values.dtype.kind in "ifbM" or values.nunique() > max(20, len(values) // 2):
        return []
    return [str(v)[:40] for v in values.astype(str).value_counts().index[:3]]


def schema(ws: Workspace, connection_id: str | None, dataset_id: str | None) -> tuple[str, str]:
    """The tables the query may use, as text for the model, and the SQL dialect."""
    lines: list[str] = []
    if connection_id:
        connection = sql._get_connection(ws, connection_id)
        source = sources.SOURCES.get(connection["kind"])
        dialect = source.dialect if source else "standard SQL"
        for table in sql.connection_tables(ws, connection_id)[:MAX_TABLES]:
            columns = ", ".join(f"{c['name']} {c['type']}" for c in table["columns"][:MAX_COLUMNS])
            lines.append(f"{table['name']}({columns})")
        return "\n".join(lines), dialect
    for table in sql.tables(ws, dataset_id)[:MAX_TABLES]:
        try:
            frame = datasets.load_frame(ws, table["dataset_id"])
        except Exception:  # noqa: BLE001 - unreadable: names only
            frame = None
        parts = []
        for column in table["columns"][:MAX_COLUMNS]:
            examples = _examples(frame, column["name"]) if frame is not None else []
            hint = f" e.g. {', '.join(repr(e) for e in examples)}" if examples else ""
            parts.append(f"  {column['name']} {column['type']}{hint}")
        note = "  -- this project's data" if table["name"] == sql.PROJECT_TABLE else ""
        lines.append(f"{table['name']} ({table.get('rows') or '?'} rows){note}\n" + "\n".join(parts))
    return "\n".join(lines), "DuckDB (like PostgreSQL)"


def _endpoint(provider: Provider, base_url: str) -> str:
    """The provider's chat completions URL; ``FLOWLABS_AI_URL`` points every provider elsewhere (tests)."""
    return os.environ.get("FLOWLABS_AI_URL") or (base_url if provider.id in URL_PROVIDERS else provider.url)


def _http_error(provider: Provider, error: urllib.error.HTTPError) -> UserError:
    detail = ""
    try:
        body = json.loads(error.read())
        found = body.get("error", body) if isinstance(body, dict) else {}
        detail = str(found.get("message", "") if isinstance(found, dict) else found)
    except Exception:  # noqa: BLE001
        pass
    if error.code in (401, 403):
        return UserError(
            f"{provider.label} did not accept the key. Check it in Ask AI's settings."
            + (f" ({detail})" if detail else "")
        )
    if error.code == 404:
        return UserError(f"{provider.label} has no such model or address." + (f" {detail}" if detail else ""))
    if error.code == 429:
        return UserError(f"{provider.label}'s rate limit was reached. Wait a minute and ask again.")
    return UserError(f"{provider.label} answered {error.code}: {detail or error.reason}")


def _ask_openai(provider: Provider, key: str | None, model: str, url: str, messages: list[dict[str, str]]) -> str:
    body: dict[str, Any] = {"model": model, "messages": messages, "response_format": {"type": "json_object"}}
    if provider.id == "openai":
        body["max_completion_tokens"] = 4000  # GPT-5 models think first; they take no temperature
    else:
        body.update(max_tokens=900, temperature=0.1)
    headers = {"Content-Type": "application/json", "User-Agent": f"FlowLabs/{__version__}"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    if provider.id == "github":
        headers["Accept"] = "application/vnd.github+json"

    def send(payload: dict[str, Any]) -> str:
        request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers)
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as reply:  # noqa: S310 - the provider's https URL
            return str(json.loads(reply.read())["choices"][0]["message"]["content"] or "")

    try:
        try:
            return send(body)
        except urllib.error.HTTPError as error:
            if error.code != 400:
                raise
            # some servers and models take no JSON mode: ask again without it (the prompt asks for JSON)
            body.pop("response_format", None)
            return send(body)
    except urllib.error.HTTPError as error:
        raise _http_error(provider, error) from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise UserError(f"Could not reach {provider.label}. Check the internet connection and the address.") from error
    except (KeyError, IndexError, ValueError) as error:
        raise UserError(f"{provider.label} sent an answer FlowLabs could not read.") from error


def _ask_claude(key: str, model: str, system: str, prompt: str) -> str:
    """Claude through Anthropic's SDK, with its answer held to the JSON shape FlowLabs reads."""
    try:
        import anthropic
    except ImportError as error:
        raise UserError("Claude needs the anthropic package. Install it in Ask AI's settings.") from error
    client = anthropic.Anthropic(api_key=key, timeout=CLAUDE_TIMEOUT_S, max_retries=1)
    params: dict[str, Any] = {"model": model, "max_tokens": 16000, "system": system,
                              "messages": [{"role": "user", "content": prompt}],
                              "output_config": {"format": {"type": "json_schema", "schema": ANSWER_SCHEMA}}}  # fmt: skip
    try:
        if model in CLAUDE_FALLBACKS:  # a declined request is taken over by another Claude model
            response: Any = client.beta.messages.create(
                betas=["server-side-fallback-2026-07-01"], fallbacks="default", **params
            )
        else:
            response = client.messages.create(**params)
    except anthropic.AuthenticationError as error:
        raise UserError("Anthropic did not accept the API key. Check it in Ask AI's settings.") from error
    except anthropic.PermissionDeniedError as error:
        raise UserError(f"This Anthropic key may not use {model}.") from error
    except anthropic.NotFoundError as error:
        raise UserError(f"Anthropic has no model called {model}.") from error
    except anthropic.RateLimitError as error:
        raise UserError("Anthropic's rate limit was reached. Wait a minute and ask again.") from error
    except anthropic.APIStatusError as error:
        raise UserError(f"Anthropic answered {error.status_code}: {error.message}") from error
    except anthropic.APIConnectionError as error:
        raise UserError("Could not reach Anthropic. Check the internet connection.") from error
    if response.stop_reason == "refusal":
        raise UserError("Claude declined to answer this question. Try asking it another way.")
    return next((block.text for block in response.content if block.type == "text"), "")


def _ask(provider: Provider, key: str | None, model: str, base_url: str, messages: list[dict[str, str]]) -> str:
    if provider.api == "anthropic":
        return _ask_claude(str(key), model, messages[0]["content"], messages[1]["content"])
    return _ask_openai(provider, key, model, _endpoint(provider, base_url), messages)


def _get_json(url: str, key: str | None, timeout: float) -> Any:
    headers = {"User-Agent": f"FlowLabs/{__version__}", "Accept": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as reply:  # noqa: S310 - the provider's own URL
        return json.loads(reply.read())


def models(ws: Workspace, provider_id: str, base_url: str | None = None, key: str | None = None) -> list[str]:
    """The models an endpoint offers (OpenAI-style GET /models), for the model list in the settings."""
    provider = _provider(ws, provider_id)
    key = (key or "").strip() or _key(ws, provider)[0]
    if provider.api == "anthropic":
        try:
            import anthropic
        except ImportError:
            return list(provider.models)
        if not key:
            raise UserError("Add the Anthropic API key first.")
        try:
            return [m.id for m in anthropic.Anthropic(api_key=key, timeout=20, max_retries=0).models.list(limit=100)]
        except anthropic.AuthenticationError as error:
            raise UserError("Anthropic did not accept the API key.") from error
        except anthropic.APIError as error:
            raise UserError(f"Could not list Anthropic's models: {error}") from error
    if provider.id == "github":
        return list(provider.models)  # GitHub's catalog has its own API; these are the common ones
    chat = _chat_url(base_url) if base_url and base_url.strip() else _endpoint(provider, _base_url(ws, provider))
    if not chat:
        raise UserError("Enter the endpoint's address first.")
    try:
        found = _get_json(chat.removesuffix("/chat/completions") + "/models", key, 15)
    except urllib.error.HTTPError as error:
        raise _http_error(provider, error) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise UserError(f"Could not reach {chat.removesuffix('/chat/completions')}. Is it running?") from error
    except ValueError as error:
        raise UserError("The endpoint's model list is not JSON.") from error
    items = found.get("data", found.get("models", [])) if isinstance(found, dict) else found
    names = []
    for item in items if isinstance(items, list) else []:
        name = item.get("id") or item.get("name") if isinstance(item, dict) else item
        if name:
            names.append(str(name).removeprefix("models/"))  # Gemini names models "models/..."
    return sorted(dict.fromkeys(names), key=str.lower)[:500]


def detect() -> dict[str, dict[str, Any]]:
    """Which local gateways answer on this computer: running, and whether they want a key."""
    found = {}
    for provider in PROVIDERS.values():
        if not provider.base_default:
            continue
        state = {"running": False, "needs_key": False, "url": provider.base_default}
        try:
            _get_json(provider.base_default + "/models", None, 1.5)
            state["running"] = True
        except urllib.error.HTTPError as error:
            state["running"] = error.code < 500 or error.code == 503
            state["needs_key"] = error.code in (401, 403)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            pass
        found[provider.id] = state
    return found


def install_sdk(on_line: Any) -> int:
    """pip install the Anthropic SDK (into ~/.flowlabs/plugins in the desktop app)."""
    return plugins.install(list(ANTHROPIC_PACKAGES), on_line)


def write_sql(ws: Workspace, question: str, connection_id: str | None = None, dataset_id: str | None = None,
              current: str = "", error: str | None = None) -> dict[str, Any]:  # fmt: skip
    """Plain English to SQL: {"sql", "explanation", "model"}."""
    if sys.platform == "emscripten":
        raise UserError("Ask AI needs the desktop app or an engine: the browser version cannot reach AI providers.")
    provider = _provider(ws)
    key, _ = _key(ws, provider)
    if provider.id in URL_PROVIDERS:
        if not _base_url(ws, provider) or not _model(ws, provider):
            raise UserError("Add the endpoint's address and a model name in Ask AI's settings first.")
    elif not key:
        raise UserError(f"Add a {provider.label} API key first.")
    elif _needs_package(provider):
        raise UserError("Claude needs the anthropic package. Install it in Ask AI's settings.")
    question = question.strip()
    if not question and not error:
        raise UserError("Ask a question first.")
    tables, dialect = schema(ws, connection_id, dataset_id)
    default = (f"When the question says 'my data', 'the data' or names no table, use the table {sql.PROJECT_TABLE}."
               if dataset_id and not connection_id else "Pick the tables the question needs.")  # fmt: skip
    prompt = f"Tables:\n{tables}\n\nQuestion: {question or 'Fix the query below.'}"
    if error and current.strip():
        prompt += f"\n\nThis query failed:\n{current.strip()}\n\nError: {error}\nWrite a corrected query."
    model = _model(ws, provider)
    answer = _ask(provider, key, model, _base_url(ws, provider),
                  [{"role": "system", "content": SYSTEM.format(dialect=dialect, default_table=default)},
                   {"role": "user", "content": prompt}])  # fmt: skip
    try:
        parsed = json.loads(re.sub(r"^```(?:json)?\s*|\s*```$", "", answer.strip()))
    except ValueError:
        found = re.search(r"```(?:sql)?\s*(.+?)```", answer, re.S)
        parsed = {"sql": found.group(1) if found else "", "explanation": ""}
    query = str(parsed.get("sql") or "").strip()
    return {
        "sql": query,
        "explanation": str(parsed.get("explanation") or "").strip(),
        "model": model,
        "provider": provider.label,
    }
