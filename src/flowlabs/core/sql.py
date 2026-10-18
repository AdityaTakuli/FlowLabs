"""SQL: query your datasets with DuckDB, or connect to a database you already have.

Every table dataset is a SQL table named after the dataset (``Customer churn`` is
``customer_churn``). Queries run in a fresh in-memory DuckDB each time, so they never change the
stored datasets: to keep a result, save it as a new dataset.

Connections (PostgreSQL, MySQL/MariaDB, SQLite, DuckDB, or any SQLAlchemy URL) are kept in
``<workspace>/connections.json``, readable only by you, and run on the computer the engine runs on.
They are read-only unless you allow changes: a read-only connection refuses statements that write
and rolls back whatever it ran.
"""

from __future__ import annotations

import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import pandas as pd

from . import datasets
from .util import UserError, frame_rows, new_id, now
from .workspace import Workspace

PREVIEW_ROWS = 500
MAX_PREVIEW_ROWS = 5000
CONNECT_TIMEOUT_S = 10
READ_WORDS = {"select", "with", "show", "describe", "desc", "explain", "pragma", "values", "table", "from", "summarize"}
KINDS: dict[str, dict[str, Any]] = {
    "postgresql": {"label": "PostgreSQL", "driver": "postgresql+psycopg", "port": 5432, "package": "psycopg[binary]"},
    "mysql": {"label": "MySQL or MariaDB", "driver": "mysql+pymysql", "port": 3306, "package": "pymysql"},
    "sqlite": {"label": "SQLite file", "driver": "sqlite", "file": True},
    "duckdb": {"label": "DuckDB file", "file": True},
    "url": {"label": "Other (SQLAlchemy URL)"},
}
SECRET_FIELDS = ("password", "url")
_DIALECT_NAMES = {
    "postgresql": "PostgreSQL",
    "mysql": "MySQL",
    "sqlite": "SQLite",
    "mssql": "SQL Server",
    "oracle": "Oracle",
}


# --------------------------------------------------------------------------------- statements


def _strip_comments(sql: str) -> str:
    return re.sub(r"--[^\n]*|/\*.*?\*/", " ", sql, flags=re.S)


def split_statements(sql: str) -> list[str]:
    """Split a script on semicolons that are outside quotes and comments."""
    statements, current, i, quote = [], [], 0, ""
    while i < len(sql):
        char = sql[i]
        if quote:
            current.append(char)
            if char == quote:
                quote = ""
        elif char in "'\"`":
            quote = char
            current.append(char)
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
        elif char == ";":
            statements.append("".join(current))
            current = []
        else:
            current.append(char)
        i += 1
    statements.append("".join(current))
    return [s.strip() for s in statements if _strip_comments(s).strip()]


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


def tables(ws: Workspace) -> list[dict[str, Any]]:
    """The datasets as SQL tables, with their columns (read from the stored file, no query)."""
    listed = []
    for name, meta in dataset_tables(ws).items():
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


def _local_connection(ws: Workspace, sql: str) -> Any:
    """An in-memory DuckDB with the datasets the query names registered as tables."""
    duckdb = _duckdb()
    connection = duckdb.connect()
    words = {w.lower() for w in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", sql)}
    for name, meta in dataset_tables(ws).items():
        if name in words:
            connection.register(name, datasets.load_frame(ws, meta["id"]))
    return connection


def _run_local(ws: Workspace, sql: str, limit: int | None) -> tuple[pd.DataFrame | None, int | None, str | None]:
    duckdb = _duckdb()
    connection = _local_connection(ws, sql)
    try:
        relation = connection.sql(sql)
        if relation is None:
            return None, None, "Done. Queries on your datasets do not change them: save a result to keep it."
        if limit is None:
            return relation.df(), None, None
        relation.to_table("__flowlabs_result")
        total = connection.sql("select count(*) from __flowlabs_result").fetchone()[0]
        return connection.sql(f"select * from __flowlabs_result limit {int(limit)}").df(), int(total), None
    except duckdb.Error as error:
        message = str(error)
        missing = re.search(r"Table with name (\S+) does not exist", message)
        if missing:
            names = ", ".join(sorted(dataset_tables(ws))) or "none yet: import a dataset first"
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


def _connections_file(ws: Workspace) -> Path:
    return ws.root / "connections.json"


def _read_connections(ws: Workspace) -> list[dict[str, Any]]:
    path = _connections_file(ws)
    if not path.is_file():
        return []
    try:
        return list(ws.read_json(path))
    except ValueError:
        return []


def _write_connections(ws: Workspace, connections: list[dict[str, Any]]) -> None:
    path = _connections_file(ws)
    ws.write_json(path, connections)
    try:
        os.chmod(path, 0o600)  # it holds passwords: only you can read it
    except OSError:
        pass


def _public(connection: dict[str, Any]) -> dict[str, Any]:
    shown = {k: v for k, v in connection.items() if k not in SECRET_FIELDS}
    shown["password_set"] = bool(connection.get("password"))
    if connection.get("url"):
        shown["url"] = _hide_password(connection["url"])
    shown["kind_label"] = KINDS.get(connection.get("kind", ""), {}).get("label", connection.get("kind"))
    return shown


def _hide_password(url: str) -> str:
    try:
        from sqlalchemy.engine import make_url

        return make_url(url).render_as_string(hide_password=True)
    except Exception:  # noqa: BLE001 - not a URL SQLAlchemy understands: hide everything after the scheme
        return re.sub(r"//[^@/]*@", "//***@", url)


def list_connections(ws: Workspace) -> list[dict[str, Any]]:
    return [_public(c) for c in _read_connections(ws)]


def kinds() -> list[dict[str, Any]]:
    return [
        {"id": k, "label": v["label"], "port": v.get("port"), "file": bool(v.get("file"))} for k, v in KINDS.items()
    ]


def _clean_connection(given: dict[str, Any], previous: dict[str, Any] | None) -> dict[str, Any]:
    kind = str(given.get("kind") or "")
    if kind not in KINDS:
        raise UserError("choose a database type")
    connection: dict[str, Any] = {
        "id": (previous or {}).get("id") or new_id("c"),
        "kind": kind,
        "name": str(given.get("name") or "").strip(),
        "allow_changes": bool(given.get("allow_changes")),
        "created": (previous or {}).get("created") or now(),
    }
    if kind == "url":
        url = str(given.get("url") or "").strip()
        if not url or "***" in url:  # the masked URL came back unchanged: keep the stored one
            url = (previous or {}).get("url", "")
        if "://" not in url:
            raise UserError("enter a database URL, e.g. mssql+pyodbc://user:password@host/db")
        connection["url"] = url
    elif KINDS[kind].get("file"):
        path = str(given.get("database") or "").strip()
        if not path:
            raise UserError("enter the path of the database file")
        connection["database"] = str(Path(path).expanduser())
    else:
        host = str(given.get("host") or "").strip()
        if not host:
            raise UserError("enter the server's host name or address")
        connection.update(host=host, database=str(given.get("database") or "").strip(),
                          user=str(given.get("user") or "").strip())  # fmt: skip
        port = given.get("port") or KINDS[kind]["port"]
        try:
            connection["port"] = int(port)
        except (TypeError, ValueError) as error:
            raise UserError("the port must be a number") from error
        password = given.get("password")
        connection["password"] = (previous or {}).get("password", "") if password in (None, "") else str(password)
    if not connection["name"]:
        connection["name"] = connection.get("database") or connection.get("host") or KINDS[kind]["label"]
        connection["name"] = Path(connection["name"]).name if KINDS[kind].get("file") else connection["name"]
    return connection


def save_connection(ws: Workspace, given: dict[str, Any]) -> dict[str, Any]:
    stored = _read_connections(ws)
    previous = next((c for c in stored if c["id"] == given.get("id")), None)
    connection = _clean_connection(given, previous)
    _write_connections(ws, [c for c in stored if c["id"] != connection["id"]] + [connection])
    return _public(connection)


def delete_connection(ws: Workspace, connection_id: str) -> None:
    _write_connections(ws, [c for c in _read_connections(ws) if c["id"] != connection_id])


def _get_connection(ws: Workspace, connection_id: str) -> dict[str, Any]:
    for connection in _read_connections(ws):
        if connection["id"] == connection_id:
            return connection
    raise UserError("that connection was deleted")


def _url(connection: dict[str, Any]) -> Any:
    from sqlalchemy.engine import URL, make_url

    kind = connection["kind"]
    if kind == "url":
        return make_url(connection["url"])
    if kind == "sqlite":
        return URL.create("sqlite", database=connection["database"])
    return URL.create(KINDS[kind]["driver"], username=connection.get("user") or None,
                      password=connection.get("password") or None, host=connection.get("host"),
                      port=connection.get("port"), database=connection.get("database") or None)  # fmt: skip


def _sqlalchemy_engine(connection: dict[str, Any]) -> Any:
    if sys.platform == "emscripten" and connection["kind"] not in ("sqlite",):
        raise UserError("The browser cannot reach a database server. Use the desktop app, or run `flowlabs engine`.")
    try:
        from sqlalchemy import create_engine
        from sqlalchemy.pool import NullPool
    except ImportError as error:
        raise UserError("Connecting to a database needs SQLAlchemy. Install it from the Engine menu.") from error
    url = _url(connection)
    if connection["kind"] == "sqlite" and not Path(connection["database"]).is_file():
        raise UserError(f"there is no SQLite file at {connection['database']}")
    connect_args: dict[str, Any] = {}
    if url.get_backend_name() in ("postgresql", "mysql", "mariadb"):
        connect_args["connect_timeout"] = CONNECT_TIMEOUT_S
    try:
        return create_engine(url, poolclass=NullPool, connect_args=connect_args)
    except ImportError as error:  # the database's driver
        package = KINDS.get(connection["kind"], {}).get("package")
        hint = f"{package}: pip install {package}" if package else f"its Python driver ({error})"
        raise UserError(f"Connecting to this database needs {hint}") from error


def _duckdb_file(connection: dict[str, Any]) -> Any:
    duckdb = _duckdb()
    path = connection["database"]
    if not Path(path).is_file() and not connection.get("allow_changes"):
        raise UserError(f"there is no DuckDB file at {path}")
    try:
        return duckdb.connect(path, read_only=not connection.get("allow_changes"))
    except duckdb.Error as error:
        raise UserError(f"could not open {path}: {_tidy_message(str(error))}") from error


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
    connection = _clean_connection(given, stored)
    started = time.perf_counter()
    if connection["kind"] == "duckdb":
        _duckdb_file(connection).close()
        return {"ok": True, "message": "Opened the DuckDB file.", "elapsed_ms": _ms(started)}
    engine = _sqlalchemy_engine(connection)
    try:
        with engine.connect() as live:
            version = live.dialect.server_version_info
            name = (
                "MariaDB"
                if getattr(live.dialect, "is_mariadb", False)
                else _DIALECT_NAMES.get(engine.dialect.name, engine.dialect.name)
            )
        shown = ".".join(str(v) for v in version) if version else ""
        return {"ok": True, "message": f"Connected to {name} {shown}".strip() + ".", "elapsed_ms": _ms(started)}
    except Exception as error:  # noqa: BLE001 - shown to the user as is
        return {"ok": False, "message": _friendly_connection_error(error), "elapsed_ms": _ms(started)}
    finally:
        engine.dispose()


def connection_tables(ws: Workspace, connection_id: str) -> list[dict[str, Any]]:
    connection = _get_connection(ws, connection_id)
    if connection["kind"] == "duckdb":
        live = _duckdb_file(connection)
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

    engine = _sqlalchemy_engine(connection)
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
    connection: dict[str, Any], sql: str, limit: int | None
) -> tuple[pd.DataFrame | None, int | None, str | None]:
    statements = split_statements(sql)
    allowed = bool(connection.get("allow_changes"))
    if not allowed:
        for statement in statements:
            if writes(statement):
                raise SqlError(
                    f"This connection is read-only, and {first_word(statement).upper()} changes the database. "
                    "Edit the connection and allow changes to run it."
                )
    if connection["kind"] == "duckdb":
        return _run_duckdb_file(connection, statements, limit)
    from sqlalchemy import text

    engine = _sqlalchemy_engine(connection)
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
    connection: dict[str, Any], statements: list[str], limit: int | None
) -> tuple[pd.DataFrame | None, int | None, str | None]:
    duckdb = _duckdb()
    live = _duckdb_file(connection)
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


def _execute(ws: Workspace, sql: str, connection_id: str | None, limit: int | None) -> tuple[Any, Any, Any]:
    if not split_statements(sql or ""):
        raise UserError("write a query first")
    if connection_id:
        return _run_connection(_get_connection(ws, connection_id), sql, limit)
    return _run_local(ws, sql, limit)


def run(ws: Workspace, sql: str, connection_id: str | None = None, limit: int = PREVIEW_ROWS) -> dict[str, Any]:
    """Run a query; the first ``limit`` rows of the last statement's result come back."""
    limit = max(1, min(int(limit), MAX_PREVIEW_ROWS))
    started = time.perf_counter()
    frame, total, message = _execute(ws, sql, connection_id, limit)
    elapsed = _ms(started)
    if frame is None:
        return {"columns": [], "types": [], "rows": [], "total": 0, "truncated": False, "elapsed_ms": elapsed,
                "message": message}  # fmt: skip
    frame.columns = [str(c) for c in frame.columns]
    return {"columns": list(frame.columns), "types": [_pandas_type(frame[c]) for c in frame.columns],
            "rows": frame_rows(frame, len(frame)), "total": total, "truncated": total is None or total > len(frame),
            "elapsed_ms": elapsed, "message": None}  # fmt: skip


def save_result(ws: Workspace, sql: str, name: str, connection_id: str | None = None) -> dict[str, Any]:
    """Run the query in full and keep its result as a new dataset."""
    frame, _, message = _execute(ws, sql, connection_id, None)
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
