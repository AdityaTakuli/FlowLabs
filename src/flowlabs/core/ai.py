"""Ask AI: questions in plain English become SQL, written by a model on Groq.

The key comes from the ``GROQ_API_KEY`` environment variable, or is saved in ``<workspace>/ai.json``
(readable only by you). What is sent to Groq: your question, the table and column names with their
types, and up to three example values of each text column, so the model spells categories right.
When fixing a failed query, the query and its error message too. Rows of data are never sent.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from flowlabs import __version__

from . import datasets, sql
from .util import UserError
from .workspace import Workspace

API = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_MODEL = "llama-3.3-70b-versatile"
MODELS = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.1-8b-instant"]
TIMEOUT_S = 40
MAX_TABLES = 30
MAX_COLUMNS = 80

SYSTEM = """You write SQL for a data tool. Answer with JSON only: {{"sql": "...", "explanation": "..."}}.
Rules:
- Write one query in the {dialect} dialect that answers the question, using only the tables and columns listed.
- Quote a column with double quotes when its name has spaces or capitals.
- Read only: SELECT or WITH. Write INSERT, UPDATE, DELETE, CREATE or DROP only when the question asks to change data.
- {default_table}
- Give readable column names with AS, round decimals to 2 places, and order results helpfully.
- The explanation is one or two plain sentences for a non-expert: what the query returns.
- If the question cannot be answered from these tables, return an empty sql and say why in the explanation."""


def _file(ws: Workspace) -> Path:
    return ws.root / "ai.json"


def _saved(ws: Workspace) -> dict[str, Any]:
    try:
        return dict(json.loads(_file(ws).read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return {}


def _key(ws: Workspace) -> tuple[str | None, str | None]:
    if os.environ.get("GROQ_API_KEY"):
        return os.environ["GROQ_API_KEY"], "environment"
    key = _saved(ws).get("key")
    return (str(key), "saved") if key else (None, None)


def status(ws: Workspace) -> dict[str, Any]:
    key, source = _key(ws)
    return {"provider": "Groq", "configured": bool(key), "source": source, "model": _saved(ws).get("model") or DEFAULT_MODEL,
            "models": MODELS, "available": sys.platform != "emscripten"}  # fmt: skip


def configure(ws: Workspace, key: str | None, model: str | None) -> dict[str, Any]:
    """Save the key (None keeps it, "" removes it) and the model."""
    saved = _saved(ws)
    if key is not None:
        key = key.strip()
        if key and not re.fullmatch(r"[A-Za-z0-9_\-]{20,200}", key):
            raise UserError("that does not look like a Groq API key (they start with gsk_)")
        if key:
            saved["key"] = key
        else:
            saved.pop("key", None)
    if model:
        saved["model"] = str(model).strip()[:100]
    path = _file(ws)
    ws.write_json(path, saved)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
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
        dialect = sql.KINDS.get(connection["kind"], {}).get("label", "standard SQL")
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


def _endpoint() -> str:
    """Groq's chat completions, or another OpenAI-compatible endpoint (a proxy, a local model)."""
    return os.environ.get("FLOWLABS_AI_URL") or API


def _ask(key: str, model: str, messages: list[dict[str, str]]) -> str:
    body = json.dumps({"model": model, "messages": messages, "temperature": 0.1, "max_tokens": 900,
                       "response_format": {"type": "json_object"}}).encode()  # fmt: skip
    request = urllib.request.Request(_endpoint(), data=body, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                                                              "User-Agent": f"FlowLabs/{__version__}"})  # fmt: skip
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as reply:  # noqa: S310 - a fixed https URL
            return str(json.loads(reply.read())["choices"][0]["message"]["content"])
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            detail = json.loads(error.read()).get("error", {}).get("message", "")
        except Exception:  # noqa: BLE001
            pass
        if error.code == 401:
            raise UserError("Groq did not accept the API key. Check it in Ask AI's settings.") from error
        if error.code == 429:
            raise UserError("Groq's rate limit was reached. Wait a minute and ask again.") from error
        raise UserError(f"Groq answered {error.code}: {detail or error.reason}") from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise UserError("Could not reach Groq. Check the internet connection.") from error


def write_sql(ws: Workspace, question: str, connection_id: str | None = None, dataset_id: str | None = None,
              current: str = "", error: str | None = None) -> dict[str, Any]:  # fmt: skip
    """Plain English to SQL: {"sql", "explanation", "model"}."""
    if sys.platform == "emscripten":
        raise UserError("Ask AI needs the desktop app or an engine: the browser version cannot reach Groq.")
    key, _ = _key(ws)
    if not key:
        raise UserError("Add a Groq API key first.")
    question = question.strip()
    if not question and not error:
        raise UserError("Ask a question first.")
    tables, dialect = schema(ws, connection_id, dataset_id)
    default = (f"When the question says 'my data', 'the data' or names no table, use the table {sql.PROJECT_TABLE}."
               if dataset_id and not connection_id else "Pick the tables the question needs.")  # fmt: skip
    prompt = f"Tables:\n{tables}\n\nQuestion: {question or 'Fix the query below.'}"
    if error and current.strip():
        prompt += f"\n\nThis query failed:\n{current.strip()}\n\nError: {error}\nWrite a corrected query."
    model = str(_saved(ws).get("model") or DEFAULT_MODEL)
    answer = _ask(key, model, [{"role": "system", "content": SYSTEM.format(dialect=dialect, default_table=default)},
                                {"role": "user", "content": prompt}])  # fmt: skip
    try:
        parsed = json.loads(answer)
    except ValueError:
        found = re.search(r"```(?:sql)?\s*(.+?)```", answer, re.S)
        parsed = {"sql": found.group(1) if found else "", "explanation": ""}
    query = str(parsed.get("sql") or "").strip()
    return {"sql": query, "explanation": str(parsed.get("explanation") or "").strip(), "model": model}
