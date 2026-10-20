"""SQL: query your datasets with DuckDB, or connect to a database you already have.

Every table dataset is a SQL table named after the dataset (``Customer churn`` is
``customer_churn``). Queries run in a fresh in-memory DuckDB each time, so they never change the
stored datasets: to keep a result, save it as a new dataset.

Connections (databases, warehouses and cloud storage: see sources.py) are kept in
``<workspace>/connections.json``; their passwords, keys and tokens in the keychain (vault.py). They
run on the computer the engine runs on, and are read-only unless you allow changes: a read-only
connection refuses statements that write and rolls back whatever it ran.
"""

from __future__ import annotations

import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import pandas as pd

from . import datasets, plugins, sources, vault
from .util import UserError, frame_rows, new_id, now
from .workspace import Workspace

PREVIEW_ROWS = 500
MAX_PREVIEW_ROWS = 5000
CONNECT_TIMEOUT_S = 10
# Statements that change nothing (USE only picks the database the next ones run in)
READ_WORDS = {
    "select",
    "with",
    "show",
    "describe",
    "desc",
    "explain",
    "pragma",
    "values",
    "table",
    "from",
    "summarize",
    "use",
}
_DIALECT_NAMES = {
    "postgresql": "PostgreSQL",
    "mysql": "MySQL",
    "sqlite": "SQLite",
    "mssql": "SQL Server",
    "oracle": "Oracle",
    "snowflake": "Snowflake",
    "bigquery": "BigQuery",
    "databricks": "Databricks",
}


# --------------------------------------------------------------------------------- statements


def _strip_comments(sql: str) -> str:
    # /*!50001 ... */ and /*+ ... */ are not comments to MySQL: mysqldump writes views and triggers in them
    return re.sub(r"--[^\n]*|/\*(?![!+]).*?\*/", " ", sql, flags=re.S)


# The statements whose body can hold semicolons, between BEGIN and its END
_ROUTINE = re.compile(
    r"\s*create\s+(?:or\s+replace\s+)?(?:definer\s*=\s*\S+\s+)?(?:temp\w*\s+)?(?:trigger|procedure|function|event)\b",
    re.I,
)
_DELIMITER = re.compile(r"[ \t]*delimiter[ \t]+(\S+)[ \t]*(?:\r?\n|$)", re.I)
_DOLLAR_QUOTE = re.compile(r"\$(?:[A-Za-z_]\w*)?\$")
_WORD = re.compile(r"[A-Za-z_]\w*")
_NEXT_WORD = re.compile(r"\s+([A-Za-z]+)")
_ENDS_WITHOUT_BLOCK = {"if", "loop", "while", "repeat"}  # END IF and the like close no BEGIN or CASE


def split_statements(sql: str, backslash: bool = False) -> list[str]:
    """Split a script into statements, the way database clients do (see ``statement_spans``)."""
    return [text for _, _, text in statement_spans(sql, backslash)]


def statement_spans(sql: str, backslash: bool = False) -> list[tuple[int, int, str]]:
    """Each statement of a script with where it starts and ends in it: ``(start, end, text)``.

    Statements end at semicolons outside quotes and comments. Also:

    * a ``DELIMITER $$`` line, as in the mysql client and MySQL Workbench, makes ``$$`` end
      statements instead, until the next DELIMITER line;
    * the body of CREATE TRIGGER, PROCEDURE, FUNCTION or EVENT stays whole from BEGIN to its END,
      semicolons included, with no DELIMITER needed;
    * PostgreSQL's dollar quotes (``$$ ... $$``, ``$body$ ... $body$``) are quotes;
    * with ``backslash`` (MySQL and MariaDB), a backslash escapes the next character in a string, so
      ``'it\'s'`` is one string. PostgreSQL's ``E'...'`` strings escape the same way.
    """
    statements: list[tuple[int, str]] = []
    current: list[str] = []
    delimiter, quote, depth, i, start = ";", "", 0, 0, 0
    escapes = False  # backslashes escape inside the open quote

    def finish() -> None:
        nonlocal current, depth
        statements.append((start, "".join(current)))
        current, depth = [], 0

    while i < len(sql):
        char = sql[i]
        if quote:
            if escapes and char == "\\" and i + 1 < len(sql):
                current.append(sql[i : i + 2])
                i += 2
                continue
            if sql.startswith(quote, i):
                current.append(quote)
                i += len(quote)
                quote = ""
            else:
                current.append(char)
                i += 1
            continue
        if i == 0 or sql[i - 1] == "\n":
            command = _DELIMITER.match(sql, i)
            if command:
                if _strip_comments("".join(current)).strip():
                    finish()
                current, depth = [], 0
                delimiter = command.group(1)
                i = start = command.end()
                continue
        if sql.startswith(delimiter, i) and (depth == 0 or delimiter != ";"):
            finish()
            i += len(delimiter)
            start = i
            continue
        if char in "'\"`":
            quote = char
            e_string = char == "'" and i > 0 and sql[i - 1] in "eE" and (i < 2 or not (sql[i - 2].isalnum() or sql[i - 2] == "_"))
            escapes = char != "`" and (backslash or e_string)
            current.append(char)
        elif char == "$" and (dollar := _DOLLAR_QUOTE.match(sql, i)):
            quote = dollar.group(0)
            current.append(quote)
            i += len(quote)
            continue
        elif (char.isalpha() or char == "_") and (i == 0 or not (sql[i - 1].isalnum() or sql[i - 1] in "_$.")):
            word = _WORD.match(sql, i).group(0)  # type: ignore[union-attr]  # a letter starts a word
            lower = word.lower()
            if lower in ("begin", "case", "end") and _ROUTINE.match(_strip_comments("".join(current))):
                if lower != "end":
                    depth += 1
                elif depth > 0:
                    following = _NEXT_WORD.match(sql, i + len(word))
                    if not (following and following.group(1).lower() in _ENDS_WITHOUT_BLOCK):
                        depth -= 1
            current.append(word)
            i += len(word)
            continue
        elif sql.startswith("--", i):
            end = sql.find("\n", i)
            end = len(sql) if end < 0 else end
            current.append(sql[i:end])
            i = end
            continue
        elif sql.startswith("/*", i):
            end = sql.find("*/", i + 2)
            end = len(sql) if end < 0 else end + 2
            current.append(sql[i:end])
            i = end
            continue
        else:
            current.append(char)
        i += 1
    statements.append((start, "".join(current)))
    spans = []
    for begin, text in statements:
        if not _strip_comments(text).strip():
            continue
        lead = len(text) - len(text.lstrip())
        spans.append((begin + lead, begin + len(text.rstrip()), text.strip()))
    return spans


def first_word(statement: str) -> str:
    match = re.match(r"[\s(]*([A-Za-z]+)", _strip_comments(statement))
    return match.group(1).lower() if match else ""


def writes(statement: str) -> bool:
    return first_word(statement) not in READ_WORDS


def _error_line(message: str) -> int | None:
    match = re.search(r"LINE (\d+):", message)
    return int(match.group(1)) if match else None


class SqlError(UserError):
    """A query the database refused; ``line`` is where, when the database says."""

    def __init__(self, message: str, line: int | None = None) -> None:
        super().__init__(message)
        self.line = line


# ----------------------------------------------------------------------------- your datasets


def _duckdb() -> Any:
    try:
        import duckdb
    except ImportError as error:
        raise UserError(
            "SQL needs the duckdb package. Install it from the Engine menu (pip install duckdb)."
        ) from error
    return duckdb


def table_name(name: str) -> str:
    slug = re.sub(r"[^0-9a-zA-Z]+", "_", name).strip("_").lower() or "table"
    return f"t_{slug}" if slug[0].isdigit() else slug


def dataset_tables(ws: Workspace) -> dict[str, dict[str, Any]]:
    """SQL table name -> dataset meta, for every table dataset (oldest keeps the plain name)."""
    found: dict[str, dict[str, Any]] = {}
    for meta in sorted(datasets.list_datasets(ws), key=lambda m: m.get("created", "")):
        if meta.get("kind") != "tabular":
            continue
        base = name = table_name(str(meta.get("name", "table")))
        n = 2
        while name in found:
            name, n = f"{base}_{n}", n + 1
        found[name] = meta
    return found


PROJECT_TABLE = "data"


def tables(ws: Workspace, dataset_id: str | None = None) -> list[dict[str, Any]]:
    """The datasets as SQL tables, with their columns (read from the stored file, no query).
    Inside a project, ``data`` is that project's dataset and comes first."""
    listed = []
    named = list(dataset_tables(ws).items())
    if dataset_id:
        meta = datasets.get_meta(ws, dataset_id)
        named.insert(0, (PROJECT_TABLE, {**meta, "name": "this project's data"}))
    for name, meta in named:
        try:
            frame = datasets.load_frame(ws, meta["id"])
            columns = [{"name": str(c), "type": _pandas_type(frame[c])} for c in frame.columns]
        except Exception:  # noqa: BLE001 - one unreadable dataset must not hide the others
            columns = []
        listed.append({"name": name, "dataset_id": meta["id"], "label": meta.get("name"), "rows": meta.get("rows"),
                       "columns": columns})  # fmt: skip
    return listed


def _pandas_type(series: pd.Series) -> str:
    kind = series.dtype.kind
    return {"i": "integer", "u": "integer", "f": "number", "b": "boolean", "M": "date"}.get(kind, "text")


def _local_connection(ws: Workspace, sql: str, dataset_id: str | None = None, prepare: Any = None) -> Any:
    """An in-memory DuckDB with the datasets the query names registered as tables (``data``: the
    project's own dataset, when there is one). ``prepare`` sets it up first (cloud storage)."""
    duckdb = _duckdb()
    connection = duckdb.connect()
    if prepare is not None:
        try:
            prepare(connection)
        except duckdb.Error as error:
            connection.close()
            raise UserError(f"could not set up the storage connection: {_tidy_message(str(error))}") from error
    words = {w.lower() for w in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", sql)}
    for name, meta in dataset_tables(ws).items():
        if name in words and not (dataset_id and name == PROJECT_TABLE):
            connection.register(name, datasets.load_frame(ws, meta["id"]))
    if dataset_id and PROJECT_TABLE in words:
        connection.register(PROJECT_TABLE, datasets.load_frame(ws, dataset_id))
    return connection


def _run_local(
    ws: Workspace, sql: str, limit: int | None, offset: int = 0, dataset_id: str | None = None, prepare: Any = None
) -> tuple[pd.DataFrame | None, int | None, str | None]:
    duckdb = _duckdb()
    connection = _local_connection(ws, sql, dataset_id, prepare)
    try:
        relation = connection.sql(sql)
        if relation is None:
            return None, None, "Done. Queries on your datasets do not change them: save a result to keep it."
        if limit is None:
            return relation.df(), None, None
        relation.to_table("__flowlabs_result")
        total = connection.sql("select count(*) from __flowlabs_result").fetchone()[0]
        page = f"select * from __flowlabs_result limit {int(limit)} offset {max(0, int(offset))}"
        return connection.sql(page).df(), int(total), None
    except duckdb.Error as error:
        message = str(error)
        missing = re.search(r"Table with name (\S+) does not exist", message)
        if missing:
            names = (
                ", ".join(([PROJECT_TABLE] if dataset_id else []) + sorted(dataset_tables(ws)))
                or "none yet: import a dataset first"
            )
            raise SqlError(
                f"There is no table {missing.group(1)}. Your tables: {names}.", _error_line(message)
            ) from error
        raise SqlError(_tidy_message(message), _error_line(message)) from error
    finally:
        connection.close()


def _tidy_message(message: str) -> str:
    message = re.sub(r"\n+LINE \d+:.*", "", message, flags=re.S).strip()
    return re.sub(r"\n\s*Candidate functions:.*", "", message, flags=re.S).strip()  # DuckDB's long overload lists


# ------------------------------------------------------------------------------ connections


class DriverMissing(UserError):
    """The source's Python driver is not installed yet; the Connect dialog offers to install it."""


def _connections_file(ws: Workspace) -> Path:
    return ws.root / "connections.json"


LEGACY_FIELDS = ("host", "port", "database", "user")


def _read_connections(ws: Workspace) -> list[dict[str, Any]]:
    path = _connections_file(ws)
    if not path.is_file():
        return []
    try:
        stored = list(ws.read_json(path))
    except ValueError:
        return []
    for connection in stored:  # connections saved before sources.py: flat fields, secrets in the file
        if "values" not in connection:
            connection["values"] = {k: connection[k] for k in LEGACY_FIELDS if connection.get(k) not in (None, "")}
            connection["legacy_secrets"] = {k: connection[k] for k in ("password", "url") if connection.get(k)}
            connection["secret_names"] = list(connection["legacy_secrets"])
    return stored


def _write_connections(ws: Workspace, connections: list[dict[str, Any]]) -> None:
    path = _connections_file(ws)
    kept = [
        {k: v for k, v in c.items() if k not in ("legacy_secrets", "password", "url", *LEGACY_FIELDS)}
        for c in connections
    ]
    ws.write_json(path, kept)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _secret_key(connection_id: str, name: str) -> str:
    return f"connection:{connection_id}:{name}"


def _secrets(ws: Workspace, connection: dict[str, Any]) -> dict[str, str]:
    found = dict(connection.get("legacy_secrets") or {})
    for name in connection.get("secret_names") or []:
        value = vault.get(ws, _secret_key(connection["id"], name))
        if value is not None:
            found[name] = value
    return found


def _public(connection: dict[str, Any]) -> dict[str, Any]:
    source = sources.SOURCES.get(connection.get("kind", ""))
    names = list(connection.get("secret_names") or [])
    return {"id": connection["id"], "kind": connection.get("kind"), "name": connection.get("name"),
            "kind_label": source.label if source else connection.get("kind"), "group": source.group if source else "",
            "allow_changes": bool(connection.get("allow_changes")), "created": connection.get("created"),
            "values": dict(connection.get("values") or {}), "secrets_set": names,
            "password_set": "password" in names}  # fmt: skip


def list_connections(ws: Workspace) -> list[dict[str, Any]]:
    return [_public(c) for c in _read_connections(ws)]


def kinds() -> list[dict[str, Any]]:
    return sources.describe()


def _form(given: dict[str, Any]) -> dict[str, Any]:
    """The Connect form's values: ``values`` from the app, or flat fields."""
    form = dict(given.get("values") or {})
    for key, value in given.items():
        if key not in (
            "id",
            "kind",
            "name",
            "allow_changes",
            "values",
            "created",
            "kind_label",
            "group",
            "secrets_set",
            "password_set",
        ):
            form.setdefault(key, value)
    return form


def _clean_connection(
    ws: Workspace, given: dict[str, Any], previous: dict[str, Any] | None
) -> tuple[dict[str, Any], dict[str, str]]:
    kind = str(given.get("kind") or "")
    source = sources.get(kind)
    values, secrets = sources.clean(
        source, _form(given), _secrets(ws, previous) if previous and previous.get("kind") == kind else {}
    )
    connection: dict[str, Any] = {
        "id": (previous or {}).get("id") or new_id("c"),
        "kind": kind,
        "name": str(given.get("name") or "").strip() or sources.default_name(source, values),
        "allow_changes": bool(given.get("allow_changes")),
        "created": (previous or {}).get("created") or now(),
        "values": values,
        "secret_names": sorted(secrets),
    }
    return connection, secrets


def save_connection(ws: Workspace, given: dict[str, Any]) -> dict[str, Any]:
    stored = _read_connections(ws)
    previous = next((c for c in stored if c["id"] == given.get("id")), None)
    connection, secrets = _clean_connection(ws, given, previous)
    for name in set((previous or {}).get("secret_names") or []) - set(secrets):
        vault.delete(ws, _secret_key(connection["id"], name))
    places = {vault.put(ws, _secret_key(connection["id"], name), value) for name, value in secrets.items()}
    connection["secret_store"] = "keychain" if places == {"keychain"} else ("file" if places else None)
    _write_connections(ws, [c for c in stored if c["id"] != connection["id"]] + [connection])
    return _public(connection)


def delete_connection(ws: Workspace, connection_id: str) -> None:
    stored = _read_connections(ws)
    for connection in stored:
        if connection["id"] == connection_id:
            for name in connection.get("secret_names") or []:
                vault.delete(ws, _secret_key(connection_id, name))
    _write_connections(ws, [c for c in stored if c["id"] != connection_id])


def _get_connection(ws: Workspace, connection_id: str) -> dict[str, Any]:
    for connection in _read_connections(ws):
        if connection["id"] == connection_id:
            return connection
    raise UserError("that connection was deleted")


def _require_driver(source: sources.Source, values: dict[str, Any] | None = None) -> None:
    from . import tunnel

    absent = plugins.missing(list(source.modules)) if source.modules else []
    if absent:
        size = f", about {source.size_mb} MB" if source.size_mb else ""
        raise DriverMissing(
            f"{source.label} needs its driver ({', '.join(source.packages)}{size}). Install it in the connection's settings."
        )
    if values and tunnel.wanted(values) and plugins.missing(list(tunnel.MODULES)):
        raise DriverMissing("Connecting through SSH needs paramiko (about 6 MB). Install it in the connection's settings.")


def _sqlalchemy_engine(source: sources.Source, values: dict[str, Any], secrets: dict[str, str]) -> Any:
    if sys.platform == "emscripten" and source.id != "sqlite":
        raise UserError("The browser cannot reach a database server. Use the desktop app, or run `flowlabs engine`.")
    _require_driver(source, values)
    try:
        from sqlalchemy import create_engine
        from sqlalchemy.pool import NullPool
    except ImportError as error:
        raise UserError("Connecting to a database needs SQLAlchemy. Install it from the Engine menu.") from error
    if source.id == "sqlite" and not Path(values["database"]).is_file():
        raise UserError(f"there is no SQLite file at {values['database']}")
    values = sources.connect_values(source, values, secrets)  # through an SSH tunnel when asked
    url = sources.sqlalchemy_url(source, values, secrets)
    try:
        return create_engine(url, poolclass=NullPool, **sources.engine_options(source, values, CONNECT_TIMEOUT_S))
    except ImportError as error:  # the database's driver (a SQLAlchemy URL to something not installed)
        raise UserError(f"Connecting to this database needs its Python driver ({error})") from error


def _duckdb_file(values: dict[str, Any], allow_changes: bool) -> Any:
    duckdb = _duckdb()
    path = values["database"]
    if not Path(path).is_file() and not allow_changes:
        raise UserError(f"there is no DuckDB file at {path}")
    try:
        return duckdb.connect(path, read_only=not allow_changes)
    except duckdb.Error as error:
        raise UserError(f"could not open {path}: {_tidy_message(str(error))}") from error


def _storage(source: sources.Source, values: dict[str, Any], secrets: dict[str, str]) -> Any:
    if sys.platform == "emscripten":
        raise UserError("The browser cannot reach cloud storage. Use the desktop app, or run `flowlabs engine`.")
    return lambda connection: sources.prepare_storage(connection, source, values, secrets)


def _friendly_connection_error(error: Exception) -> str:
    original = getattr(error, "orig", None) or error
    arguments: tuple[Any, ...] = tuple(getattr(original, "args", ()))
    if len(arguments) == 2 and isinstance(arguments[0], int):  # MySQL: (code, message)
        return str(arguments[1])[:400]
    lines = str(original).strip().splitlines() or [type(original).__name__]
    return lines[0][:400]


def _plain_values(frame: pd.DataFrame) -> pd.DataFrame:
    """Database values pandas keeps as Python objects (Decimal, date, UUID...) as numbers, dates or text."""
    import datetime as dt
    import decimal

    for column in frame.columns:
        if frame[column].dtype != object:
            continue
        values = frame[column].dropna()
        if values.empty:
            continue
        kinds = set(values.map(type))
        if kinds <= {decimal.Decimal, int, float}:
            frame[column] = pd.to_numeric(frame[column].map(lambda v: None if v is None else float(v)))
        elif kinds <= {dt.date, dt.datetime, pd.Timestamp}:
            frame[column] = pd.to_datetime(frame[column], errors="coerce")
        elif not kinds <= {str}:
            frame[column] = frame[column].map(lambda v: v if v is None or isinstance(v, str) else str(v))
    return frame


def test_connection(ws: Workspace, given: dict[str, Any]) -> dict[str, Any]:
    stored = next((c for c in _read_connections(ws) if c["id"] == given.get("id")), None)
    connection, secrets = _clean_connection(ws, given, stored)
    source = sources.get(connection["kind"])
    values = connection["values"]
    started = time.perf_counter()
    if source.engine == "duckdb":
        _duckdb_file(values, connection["allow_changes"]).close()
        return {"ok": True, "message": "Opened the DuckDB file.", "elapsed_ms": _ms(started)}
    if source.engine == "storage":
        try:
            live = _local_connection(ws, "", None, _storage(source, values, secrets))
            try:
                found = sources.list_files(live, source, values, limit=1000)
            finally:
                live.close()
        except UserError as error:
            return {"ok": False, "message": str(error), "elapsed_ms": _ms(started)}
        except Exception as error:  # noqa: BLE001 - DuckDB's own message: wrong key, no such bucket...
            return {"ok": False, "message": _tidy_message(str(error))[:400], "elapsed_ms": _ms(started)}
        where = sources.storage_root(source, values)
        return {"ok": True, "message": f"Found {len(found)} data files in {where}.", "elapsed_ms": _ms(started)}
    from . import tunnel

    try:
        engine = _sqlalchemy_engine(source, values, secrets)
    except tunnel.UnknownHostKey as error:
        return {"ok": False, "message": str(error), "ssh_fingerprint": error.fingerprint, "elapsed_ms": _ms(started)}
    except DriverMissing:
        raise
    except UserError as error:
        return {"ok": False, "message": str(error), "elapsed_ms": _ms(started)}
    try:
        with engine.connect() as live:
            version = live.dialect.server_version_info
            name = (
                "MariaDB"
                if getattr(live.dialect, "is_mariadb", False)
                else _DIALECT_NAMES.get(engine.dialect.name, source.label)
            )
        shown = ".".join(str(v) for v in version) if version else ""
        return {"ok": True, "message": f"Connected to {name} {shown}".strip() + ".", "elapsed_ms": _ms(started)}
    except Exception as error:  # noqa: BLE001 - shown to the user as is
        return {"ok": False, "message": _friendly_connection_error(error), "elapsed_ms": _ms(started)}
    finally:
        engine.dispose()


def connection_tables(ws: Workspace, connection_id: str) -> list[dict[str, Any]]:
    connection = _get_connection(ws, connection_id)
    source = sources.get(connection["kind"])
    values, secrets = connection["values"], _secrets(ws, connection)
    if source.engine == "storage":
        live = _local_connection(ws, "", None, _storage(source, values, secrets))
        try:
            return sources.list_files(live, source, values)
        except Exception as error:  # noqa: BLE001
            raise UserError(_tidy_message(str(error))[:400]) from error
        finally:
            live.close()
    if source.engine == "duckdb":
        live = _duckdb_file(values, bool(connection.get("allow_changes")))
        try:
            rows = live.sql(
                "select table_name, column_name, data_type from information_schema.columns "
                "where table_schema = current_schema() order by table_name, ordinal_position"
            ).fetchall()
        finally:
            live.close()
        found: dict[str, list[dict[str, str]]] = {}
        for table, column, kind in rows:
            found.setdefault(table, []).append({"name": column, "type": str(kind).lower()})
        return [{"name": t, "columns": c} for t, c in found.items()]
    from sqlalchemy import inspect

    engine = _sqlalchemy_engine(source, values, secrets)
    try:
        inspector = inspect(engine)
        names = sorted(inspector.get_table_names())[:200] + sorted(inspector.get_view_names())[:50]
        listed = []
        for name in names:
            try:
                columns = [{"name": c["name"], "type": str(c["type"]).lower()} for c in inspector.get_columns(name)]
            except Exception:  # noqa: BLE001
                columns = []
            listed.append({"name": name, "columns": columns})
        return listed
    except UserError:
        raise
    except Exception as error:  # noqa: BLE001
        raise UserError(_friendly_connection_error(error)) from error
    finally:
        engine.dispose()


def _run_connection(
    ws: Workspace,
    connection: dict[str, Any],
    sql: str,
    limit: int | None,
    offset: int = 0,
    dataset_id: str | None = None,
) -> tuple[pd.DataFrame | None, int | None, str | None]:
    statements = split_statements(sql, backslash=connection.get("kind") == "mysql")
    allowed = bool(connection.get("allow_changes"))
    if not allowed:
        for statement in statements:
            if writes(statement):
                raise SqlError(
                    f"This connection is read-only, and {first_word(statement).upper()} changes the data. "
                    "Edit the connection and allow changes to run it."
                )
    source = sources.get(connection["kind"])
    values, secrets = connection["values"], _secrets(ws, connection)
    if source.engine == "storage":  # files in the cloud, read by DuckDB next to your datasets
        return _run_local(ws, sql, limit, offset, dataset_id, _storage(source, values, secrets))
    if source.engine == "duckdb":
        return _run_duckdb_file(values, allowed, statements, limit)
    from sqlalchemy import text

    engine = _sqlalchemy_engine(source, values, secrets)
    frame, changed = None, 0
    try:
        with engine.connect() as live:
            transaction = live.begin()
            try:
                for statement in statements:
                    result = live.execute(text(statement).execution_options(no_parameters=True))
                    if result.returns_rows:
                        keys = list(result.keys())
                        rows = result.fetchall() if limit is None else result.fetchmany(limit + 1)
                        frame = _plain_values(pd.DataFrame([tuple(r) for r in rows], columns=keys))
                    else:
                        frame = None
                        changed += max(result.rowcount or 0, 0)
                if allowed:
                    transaction.commit()
                else:
                    transaction.rollback()
            except Exception:
                transaction.rollback()
                raise
    except UserError:
        raise
    except Exception as error:  # noqa: BLE001 - the database's own message is the useful part
        message = _friendly_connection_error(error)
        raise SqlError(message, _error_line(str(getattr(error, "orig", error)))) from error
    finally:
        engine.dispose()
    if frame is None:
        return None, None, f"Done. {changed} rows changed." if changed else "Done."
    total = None if limit is not None and len(frame) > limit else len(frame)
    return (frame if limit is None else frame.head(limit)), total, None


def _run_duckdb_file(
    values: dict[str, Any], allowed: bool, statements: list[str], limit: int | None
) -> tuple[pd.DataFrame | None, int | None, str | None]:
    duckdb = _duckdb()
    live = _duckdb_file(values, allowed)
    try:
        relation = None
        for statement in statements:
            relation = live.sql(statement)
        if relation is None:
            return None, None, "Done."
        frame = relation.df() if limit is None else relation.limit(limit + 1).df()
        total = None if limit is not None and len(frame) > limit else len(frame)
        return (frame if limit is None else frame.head(limit)), total, None
    except duckdb.Error as error:
        message = str(error)
        raise SqlError(_tidy_message(message), _error_line(message)) from error
    finally:
        live.close()


# ------------------------------------------------------------------------------------ running


def _ms(started: float) -> int:
    return round((time.perf_counter() - started) * 1000)


def _execute(
    ws: Workspace,
    sql: str,
    connection_id: str | None,
    limit: int | None,
    offset: int = 0,
    dataset_id: str | None = None,
) -> tuple[Any, Any, Any]:
    if not split_statements(sql or ""):
        raise UserError("write a query first")
    if connection_id:
        return _run_connection(ws, _get_connection(ws, connection_id), sql, limit, offset, dataset_id)
    return _run_local(ws, sql, limit, offset, dataset_id)


def run(
    ws: Workspace,
    sql: str,
    connection_id: str | None = None,
    limit: int = PREVIEW_ROWS,
    offset: int = 0,
    dataset_id: str | None = None,
) -> dict[str, Any]:
    """Run a query; ``limit`` rows of the last statement's result come back, from ``offset`` (paging
    works on your datasets; a connection gives the first rows). ``dataset_id``: the project's table."""
    limit = max(1, min(int(limit), MAX_PREVIEW_ROWS))
    started = time.perf_counter()
    frame, total, message = _execute(ws, sql, connection_id, limit, offset, dataset_id)
    elapsed = _ms(started)
    if frame is None:
        return {"columns": [], "types": [], "rows": [], "total": 0, "truncated": False, "elapsed_ms": elapsed,
                "message": message}  # fmt: skip
    frame.columns = [str(c) for c in frame.columns]
    return {"columns": list(frame.columns), "types": [_pandas_type(frame[c]) for c in frame.columns],
            "rows": frame_rows(frame, len(frame)), "total": total, "truncated": total is None or total > len(frame),
            "elapsed_ms": elapsed, "message": None}  # fmt: skip


def save_result(
    ws: Workspace, sql: str, name: str, connection_id: str | None = None, dataset_id: str | None = None
) -> dict[str, Any]:
    """Run the query in full and keep its result as a new dataset."""
    frame, _, message = _execute(ws, sql, connection_id, None, 0, dataset_id)
    if frame is None:
        raise UserError(message or "the query returned no table")
    frame = _plain_values(frame.copy())  # Parquet needs one type per column
    frame.columns = [str(c) for c in frame.columns]
    dataset_id = new_id("d")
    folder = ws.datasets / dataset_id
    folder.mkdir(parents=True)
    try:
        frame.to_parquet(folder / "data.parquet", index=False)
        source = "SQL: " + " ".join(sql.split())[:160]
        meta = datasets._table_meta(ws, dataset_id, name.strip() or "query result", "data.parquet", source)
        return datasets._write_meta(ws, dataset_id, meta)
    except Exception:
        ws.remove(folder)
        raise
