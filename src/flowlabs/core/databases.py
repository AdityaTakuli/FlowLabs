"""Databases: work in PostgreSQL, MySQL and MariaDB (and SQLite, or any database SQLAlchemy reaches)
the way pgAdmin and MySQL Workbench do, without leaving FlowLabs.

* Browse: databases, schemas, tables, views, functions, procedures, triggers and sequences, each
  table's columns, keys, indexes and size, and any object's CREATE script.
* Query: each query tab has its own session (one database connection kept open), so ``SET``,
  ``USE``, temporary tables and transactions carry over from one run to the next. A running query
  can be stopped: the server is asked to cancel it (``pg_cancel_backend``, ``KILL QUERY``).
  Results come back a page at a time; a whole result can be exported to CSV, Excel, JSON or Parquet.
* Edit: change, add and delete rows of a table with a primary key (reviewed as SQL first), and copy
  a FlowLabs dataset into a table.
* Admin: EXPLAIN plans as a tree, the queries running on the server, users and roles.

Connections come from sql.py (``connections.json``, passwords in the keychain). A connection that
does not allow changes is read-only twice over: statements that write are refused before they are
sent, and the session itself is read-only on the server (``SET SESSION ... READ ONLY``), so a
function that writes cannot slip through either.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import decimal
import hashlib
import json
import re
import threading
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from . import datasets, sources, sql
from .util import UserError, new_id
from .workspace import Workspace

PAGE_ROWS = 500
MAX_PAGE_ROWS = 10_000
MAX_RESULTS = 20  # result tabs from one run; later statements still run
SESSION_IDLE_S = 45 * 60
LINK_IDLE_S = 20 * 60
EXACT_COUNT_UNDER = 2_000_000  # tables estimated larger show the estimate instead of count(*)

# Statements a read-only session may run besides those that read: transaction control, and SET /
# USE that only pick options (but never the one that turns read-only off).
_SESSION_OK = {"begin", "start", "commit", "rollback", "savepoint", "release", "end", "set", "reset", "discard"}
_UNSAFE_SET = re.compile(r"transaction|read[\s_]*(only|write)|query_only|characteristics|session_replication_role",
                         re.I)  # fmt: skip
_ROWS_FIRST = {"select", "with", "values", "table"}
_WRITING_CTE = re.compile(r"\b(insert|update|delete|merge)\b", re.I)


class SessionGone(UserError):
    code = "session_gone"


# ------------------------------------------------------------------------------- connections


@dataclass
class Link:
    """An engine (a small pool of connections) to one database of a connection."""

    key: str
    engine: Any
    flavor: str  # postgresql, mysql, sqlite or another SQLAlchemy dialect name
    read_only: bool
    label: str
    last_used: float = field(default_factory=time.time)
    mariadb: bool = False
    server: str = ""


_links: dict[tuple[str, str], Link] = {}
_links_lock = threading.Lock()


def _connection(ws: Workspace, connection_id: str) -> tuple[dict[str, Any], sources.Source]:
    connection = sql._get_connection(ws, connection_id)
    source = sources.get(connection["kind"])
    if source.engine != "sqlalchemy":
        raise UserError(f"{source.label} is not a database server. Query it from a project's Analyze step.")
    return connection, source


def _fingerprint(*parts: Any) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()


def link(ws: Workspace, connection_id: str, database: str | None = None) -> Link:
    """The engine for ``database`` (the connection's own when None), made once and reused."""
    connection, source = _connection(ws, connection_id)
    values = dict(connection["values"])
    if database and source.id != "sqlite":
        values["database"] = database
    secrets = sql._secrets(ws, connection)
    read_only = not connection.get("allow_changes")
    key = _fingerprint(values, secrets, read_only)
    slot = (connection_id, database or "")
    with _links_lock:
        _close_idle_links()
        found = _links.get(slot)
        if found is not None and found.key == key:
            found.last_used = time.time()
            return found
        if found is not None:
            _links.pop(slot, None)
            found.engine.dispose()
    sql._require_driver(source, values)
    from sqlalchemy import create_engine

    reached = sources.connect_values(source, values, secrets)
    url = sources.sqlalchemy_url(source, reached, secrets)
    options = sources.engine_options(source, reached, sql.CONNECT_TIMEOUT_S)
    # a few pooled connections for browsing; query tabs and restores take their own and discard them
    pool = {} if source.id == "sqlite" else {"pool_size": 2, "max_overflow": 40, "pool_timeout": 20}
    try:
        # no_parameters: SQL without parameters goes to the driver as written, so a % in it (a LIKE
        # pattern, MySQL's 'user'@'%') is text, not a placeholder
        engine = create_engine(url, pool_pre_ping=True, pool_recycle=900, execution_options={"no_parameters": True},
                               **pool, **options)  # fmt: skip
    except ImportError as error:
        raise UserError(f"Connecting to this database needs its Python driver ({error})") from error
    made = Link(key, engine, engine.dialect.name, read_only, connection.get("name") or source.label)
    try:
        with engine.connect() as live:
            made.mariadb = bool(getattr(live.dialect, "is_mariadb", False))
            version = ".".join(str(v) for v in (live.dialect.server_version_info or ()))
            name = "MariaDB" if made.mariadb else sql._DIALECT_NAMES.get(made.flavor, source.label)
            made.server = f"{name} {version}".strip()
    except Exception as error:  # noqa: BLE001 - the server's own words
        engine.dispose()
        raise UserError(sql._friendly_connection_error(error)) from error
    with _links_lock:
        _links[slot] = made
    return made


def _close_idle_links() -> None:
    now = time.time()
    busy = {s.slot for s in _sessions.values()}
    for slot, item in list(_links.items()):
        if slot not in busy and now - item.last_used > LINK_IDLE_S:
            _links.pop(slot, None)
            item.engine.dispose()


def forget(connection_id: str) -> None:
    """Close everything open on a connection (it was edited or deleted)."""
    for session in [s for s in _sessions.values() if s.connection_id == connection_id]:
        close_session(session.id)
    with _links_lock:
        for slot in [s for s in _links if s[0] == connection_id]:
            _links.pop(slot).engine.dispose()


def _q(item: Link, name: str) -> str:
    return str(item.engine.dialect.identifier_preparer.quote(name))


def _qualified(item: Link, schema: str | None, name: str) -> str:
    return f"{_q(item, schema)}.{_q(item, name)}" if schema else _q(item, name)


def _read_only_sql(item: Link, session: bool) -> str | None:
    scope = "SESSION " if session else ""
    if item.flavor == "postgresql":
        return "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY" if session else "SET TRANSACTION READ ONLY"
    if item.flavor == "mysql":
        return f"SET {scope}TRANSACTION READ ONLY"
    if item.flavor == "sqlite":
        return "PRAGMA query_only = ON"
    return None


@contextlib.contextmanager
def _reading(item: Link) -> Iterator[Any]:
    """A pooled connection for browsing; on a read-only connection, inside a read-only transaction
    that is rolled back."""
    item.last_used = time.time()
    with item.engine.connect() as live:
        if item.read_only:
            statement = _read_only_sql(item, session=False)
            if statement:
                live.exec_driver_sql(statement)
        try:
            yield live
        finally:
            live.rollback()


def _rows(live: Any, statement: str, params: dict[str, Any] | None = None) -> list[tuple[Any, ...]]:
    from sqlalchemy import text

    return [tuple(r) for r in live.execute(text(statement), params or {}).fetchall()]


def _guard(item: Link, statements: list[str], *, session: bool = True) -> None:
    if not item.read_only:
        return
    for statement in statements:
        word = sql.first_word(statement)
        if word in sql.READ_WORDS:
            continue
        if session and word in _SESSION_OK and not (word == "set" and _UNSAFE_SET.search(statement)):
            continue
        raise sql.SqlError(
            f"This connection is read-only, and {word.upper() or 'this statement'} can change the database. "
            "Edit the connection and allow changes to run it."
        )


def _need_changes(item: Link) -> None:
    if item.read_only:
        raise UserError("This connection is read-only. Edit it and allow changes first.")


# ---------------------------------------------------------------------------------- values


def cell(value: Any) -> Any:
    """A database value as JSON: exact numbers as text when a float would round them."""
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value if value == value and value not in (float("inf"), float("-inf")) else str(value)
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        data = bytes(value)
        return "\\x" + data[:64].hex() + ("…" if len(data) > 64 else "")
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (dict, list)):
        return json.dumps(value, default=str, ensure_ascii=False)
    return str(value)


def _kind(sample: Any) -> str:
    if isinstance(sample, bool):
        return "boolean"
    if isinstance(sample, (int, float, decimal.Decimal)):
        return "number"
    if isinstance(sample, (dt.datetime, dt.date)):
        return "datetime"
    return "text"


def _columns_of(description: Any, rows: list[tuple[Any, ...]]) -> tuple[list[str], list[str]]:
    names = [str(d[0]) for d in description]
    kinds = []
    for index in range(len(names)):
        sample = next((r[index] for r in rows if r[index] is not None), None)
        kinds.append(_kind(sample))
    return names, kinds


# ---------------------------------------------------------------------------------- browsing


def overview(ws: Workspace, connection_id: str) -> dict[str, Any]:
    """The connection's server, its databases and which one it opens in."""
    connection, source = _connection(ws, connection_id)
    item = link(ws, connection_id)
    default = connection["values"].get("database")
    with _reading(item) as live:
        if item.flavor == "postgresql":
            names = [r[0] for r in _rows(live, "select datname from pg_database where not datistemplate "
                                               "and datallowconn order by datname")]  # fmt: skip
            default = default or _rows(live, "select current_database()")[0][0]
            system: set[str] = set()
        elif item.flavor == "mysql":
            names = [r[0] for r in _rows(live, "show databases")]
            system = {"information_schema", "mysql", "performance_schema", "sys"}
        elif item.flavor == "sqlite":
            names, system, default = ["main"], set(), "main"
        else:
            names, system = [default or "default"], set()
    return {"connection_id": connection_id, "name": connection.get("name"), "kind": source.id,
            "flavor": item.flavor, "mariadb": item.mariadb, "server": item.server, "read_only": item.read_only,
            "default": default, "schemas": item.flavor == "postgresql",
            "databases": [{"name": n, "system": n in system} for n in names]}  # fmt: skip


def schemas(ws: Workspace, connection_id: str, database: str) -> list[dict[str, Any]]:
    item = link(ws, connection_id, database)
    if item.flavor != "postgresql":
        return [{"name": database, "system": False}]
    with _reading(item) as live:
        rows = _rows(live, "select nspname from pg_namespace where nspname !~ '^pg_(toast|temp)' order by "
                           "nspname = 'public' desc, nspname")  # fmt: skip
    system = {"pg_catalog", "information_schema"}
    return [{"name": r[0], "system": r[0] in system} for r in rows]


def _mysql_schema(item: Link, database: str, schema: str | None) -> str:
    return schema or database


def objects(ws: Workspace, connection_id: str, database: str, schema: str | None = None) -> dict[str, Any]:
    """Everything in a schema (a database, on MySQL), grouped, with row counts and sizes."""
    item = link(ws, connection_id, database)
    found: dict[str, list[dict[str, Any]]] = {"tables": [], "views": [], "functions": [], "procedures": [],
                                              "triggers": [], "sequences": []}  # fmt: skip
    with _reading(item) as live:
        if item.flavor == "postgresql":
            schema = schema or "public"
            for name, kind, rows, size, comment in _rows(live, """
                    select c.relname, c.relkind::text, case when c.reltuples < 0 then null else c.reltuples::bigint end,
                           pg_total_relation_size(c.oid), obj_description(c.oid, 'pg_class')
                    from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = :schema and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
                    order by c.relname""", {"schema": schema}):
                entry = {"name": name, "rows": int(rows) if kind in "rpm" and rows is not None else None, "bytes": int(size or 0),
                         "comment": comment or None}  # fmt: skip
                if kind in "rpf":
                    found["tables"].append({**entry, "kind": {"r": "table", "p": "partitioned table",
                                                              "f": "foreign table"}[kind]})  # fmt: skip
                elif kind in "vm":
                    found["views"].append({**entry, "kind": "materialized view" if kind == "m" else "view"})
                else:
                    found["sequences"].append({"name": name, "kind": "sequence"})
            for name, arguments, kind, returns in _rows(live, """
                    select p.proname, pg_get_function_identity_arguments(p.oid), p.prokind::text,
                           case when p.prokind = 'f' then pg_get_function_result(p.oid) end
                    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
                    where n.nspname = :schema and p.prokind in ('f', 'p') and d.objid is null
                    order by p.proname""", {"schema": schema}):
                group = "procedures" if kind == "p" else "functions"
                found[group].append({"name": name, "signature": arguments, "returns": returns,
                                     "kind": "procedure" if kind == "p" else "function"})  # fmt: skip
            for name, table in _rows(live, """
                    select t.tgname, c.relname from pg_trigger t
                    join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = :schema and not t.tgisinternal order by c.relname, t.tgname""",
                                     {"schema": schema}):  # fmt: skip
                found["triggers"].append({"name": name, "table": table, "kind": "trigger"})
        elif item.flavor == "mysql":
            schema = _mysql_schema(item, database, schema)
            for name, kind, rows, size, comment in _rows(live, """
                    select TABLE_NAME, TABLE_TYPE, TABLE_ROWS, coalesce(DATA_LENGTH, 0) + coalesce(INDEX_LENGTH, 0),
                           TABLE_COMMENT
                    from information_schema.TABLES where TABLE_SCHEMA = :schema order by TABLE_NAME""",
                                                         {"schema": schema}):  # fmt: skip
                if kind == "VIEW":
                    found["views"].append({"name": name, "kind": "view", "rows": None, "bytes": None})
                else:
                    found["tables"].append({"name": name, "kind": "table", "rows": None if rows is None else int(rows),
                                            "bytes": int(size or 0), "comment": comment or None})  # fmt: skip
            for name, kind in _rows(live, "select ROUTINE_NAME, ROUTINE_TYPE from information_schema.ROUTINES "
                                          "where ROUTINE_SCHEMA = :schema order by ROUTINE_NAME", {"schema": schema}):
                group = "procedures" if kind == "PROCEDURE" else "functions"
                found[group].append({"name": name, "kind": kind.lower()})
            for name, table in _rows(live, "select TRIGGER_NAME, EVENT_OBJECT_TABLE from information_schema.TRIGGERS "
                                           "where TRIGGER_SCHEMA = :schema order by 2, 1", {"schema": schema}):
                found["triggers"].append({"name": name, "table": table, "kind": "trigger"})
        elif item.flavor == "sqlite":
            for name, kind, table in _rows(live, "select name, type, tbl_name from sqlite_master "
                                                 "where name not like 'sqlite_%' order by name"):  # fmt: skip
                if kind == "table":
                    found["tables"].append({"name": name, "kind": "table", "rows": None, "bytes": None})
                elif kind == "view":
                    found["views"].append({"name": name, "kind": "view", "rows": None, "bytes": None})
                elif kind == "trigger":
                    found["triggers"].append({"name": name, "table": table, "kind": "trigger"})
        else:
            from sqlalchemy import inspect

            inspector = inspect(live)
            found["tables"] = [{"name": n, "kind": "table", "rows": None, "bytes": None}
                               for n in inspector.get_table_names(schema=schema)]  # fmt: skip
            found["views"] = [{"name": n, "kind": "view", "rows": None, "bytes": None}
                              for n in inspector.get_view_names(schema=schema)]  # fmt: skip
    return {"database": database, "schema": schema, **found}


def columns(ws: Workspace, connection_id: str, database: str, schema: str | None = None) -> dict[str, list[str]]:
    """Every table's column names in a schema, in one query: for the editor's completion."""
    item = link(ws, connection_id, database)
    with _reading(item) as live:
        if item.flavor in ("postgresql", "mysql"):
            where = schema or ("public" if item.flavor == "postgresql" else database)
            found = _rows(live, "select table_name, column_name from information_schema.columns "
                                "where table_schema = :schema order by table_name, ordinal_position limit 50000",
                          {"schema": where})  # fmt: skip
        else:
            from sqlalchemy import inspect

            inspector = inspect(live)
            found = [(t, c["name"]) for t in inspector.get_table_names(schema=schema)[:500]
                     for c in inspector.get_columns(t, schema=schema)]  # fmt: skip
    out: dict[str, list[str]] = {}
    for table_name, column in found:
        out.setdefault(str(table_name), []).append(str(column))
    return out


def diagram(ws: Workspace, connection_id: str, database: str, schema: str | None = None) -> dict[str, Any]:
    """Every table in a schema with its columns and keys, and the foreign keys between them: an ER
    diagram's content, read in a few bulk queries."""
    from sqlalchemy import inspect

    item = link(ws, connection_id, database)
    schema = _schema_for(item, database, schema)
    if item.flavor == "postgresql":
        schema = schema or "public"
    with _reading(item) as live:
        inspector = inspect(live)
        names = inspector.get_table_names(schema=schema)
        if len(names) > 400:
            raise UserError(f"{len(names)} tables are too many to draw; choose a smaller schema.")
        try:
            columns = inspector.get_multi_columns(schema=schema)
            keys = inspector.get_multi_pk_constraint(schema=schema)
            foreign = inspector.get_multi_foreign_keys(schema=schema)
        except NotImplementedError:
            columns = {(schema, n): inspector.get_columns(n, schema=schema) for n in names}
            keys = {(schema, n): inspector.get_pk_constraint(n, schema=schema) for n in names}
            foreign = {(schema, n): inspector.get_foreign_keys(n, schema=schema) for n in names}
    tables = []
    links = []
    for name in sorted(names):
        key = (schema, name)
        primary = set((keys.get(key) or {}).get("constrained_columns") or [])
        fks = foreign.get(key) or []
        referencing = {c for fk in fks for c in fk.get("constrained_columns") or []}
        tables.append({"name": name, "columns": [{"name": c["name"], "type": str(c["type"]).lower(),
                                                  "key": c["name"] in primary, "foreign": c["name"] in referencing,
                                                  "nullable": bool(c.get("nullable", True))}
                                                 for c in columns.get(key) or []]})  # fmt: skip
        for fk in fks:
            links.append({"name": fk.get("name"), "from": name, "columns": fk.get("constrained_columns") or [],
                          "to": fk.get("referred_table"), "to_schema": fk.get("referred_schema"),
                          "referred_columns": fk.get("referred_columns") or []})  # fmt: skip
    return {"schema": schema, "database": database, "tables": tables, "links": links}


def _reflect(item: Link, live: Any, schema: str | None, name: str) -> Any:
    from sqlalchemy import MetaData, Table
    from sqlalchemy.exc import NoSuchTableError

    try:
        return Table(name, MetaData(), schema=schema, autoload_with=live, resolve_fks=False)
    except NoSuchTableError as error:
        raise UserError(f"there is no table or view {name}" + (f" in {schema}" if schema else "")) from error


def _schema_for(item: Link, database: str, schema: str | None) -> str | None:
    if item.flavor == "mysql":
        return _mysql_schema(item, database, schema)
    if item.flavor == "sqlite":
        return None
    return schema


def table(ws: Workspace, connection_id: str, database: str, schema: str | None, name: str) -> dict[str, Any]:
    """A table's or view's columns, keys, indexes, size and CREATE script."""
    from sqlalchemy import inspect

    item = link(ws, connection_id, database)
    schema = _schema_for(item, database, schema)
    with _reading(item) as live:
        inspector = inspect(live)
        try:
            columns = inspector.get_columns(name, schema=schema)
        except Exception as error:  # noqa: BLE001
            raise UserError(f"could not read {name}: {sql._friendly_connection_error(error)}") from error
        primary = inspector.get_pk_constraint(name, schema=schema) or {}
        keys = list(primary.get("constrained_columns") or [])

        def safely(read: Any) -> Any:
            try:
                return read(name, schema=schema)
            except Exception:  # noqa: BLE001 - not every database has every kind of constraint
                return []

        foreign = safely(inspector.get_foreign_keys)
        indexes = safely(inspector.get_indexes)
        uniques = safely(inspector.get_unique_constraints)
        checks = safely(inspector.get_check_constraints)
        try:
            comment = (inspector.get_table_comment(name, schema=schema) or {}).get("text")
        except Exception:  # noqa: BLE001
            comment = None
        view = name in set(inspector.get_view_names(schema=schema))
        if item.flavor == "postgresql" and not view:
            try:
                view = name in set(inspector.get_materialized_view_names(schema=schema))
            except Exception:  # noqa: BLE001
                pass
    referenced = {c for fk in foreign for c in fk.get("constrained_columns") or []}
    info = {
        "name": name, "schema": schema, "database": database, "view": view, "comment": comment,
        "columns": [{"name": c["name"], "type": str(c["type"]), "nullable": bool(c.get("nullable", True)),
                     "default": None if c.get("default") is None else str(c.get("default")),
                     "key": c["name"] in keys, "foreign": c["name"] in referenced,
                     "auto": bool(c.get("autoincrement") is True or (c.get("identity") or {})),
                     "comment": c.get("comment")} for c in columns],
        "primary_key": keys,
        "foreign_keys": [{"name": fk.get("name"), "columns": fk.get("constrained_columns"),
                          "references": ".".join(p for p in (fk.get("referred_schema"), fk.get("referred_table")) if p),
                          "referred_columns": fk.get("referred_columns"),
                          "on_delete": (fk.get("options") or {}).get("ondelete"),
                          "on_update": (fk.get("options") or {}).get("onupdate")} for fk in foreign],
        "indexes": [{"name": ix.get("name"), "columns": [c for c in ix.get("column_names") or [] if c],
                     "unique": bool(ix.get("unique"))} for ix in indexes],
        "uniques": [{"name": u.get("name"), "columns": u.get("column_names")} for u in uniques],
        "checks": [{"name": ch.get("name"), "sql": ch.get("sqltext")} for ch in checks],
        "editable": bool(keys) and not view and not item.read_only,
        "read_only": item.read_only,
    }  # fmt: skip
    try:
        info["ddl"] = ddl(ws, connection_id, database, schema, name, "view" if view else "table")
    except Exception as error:  # noqa: BLE001 - the rest of the table's details are still useful
        info["ddl"] = f"-- Could not build the CREATE statement: {error}"
    return info


def ddl(ws: Workspace, connection_id: str, database: str, schema: str | None, name: str, kind: str,
        signature: str | None = None, table_name: str | None = None) -> str:  # fmt: skip
    """The CREATE statement of a table, view, function, procedure, trigger or sequence."""
    item = link(ws, connection_id, database)
    schema = _schema_for(item, database, schema)
    with _reading(item) as live:
        return ddl_on(item, live, schema, name, kind, signature, table_name)


def ddl_on(item: Link, live: Any, schema: str | None, name: str, kind: str, signature: str | None = None,
           table_name: str | None = None) -> str:  # fmt: skip
    """``ddl`` on a connection that is already open (a backup reads everything in one snapshot)."""
    kind = kind.replace("materialized view", "view").replace("partitioned table", "table").replace(
        "foreign table", "table")
    if item.flavor == "mysql":
        what = {"table": "TABLE", "view": "VIEW", "function": "FUNCTION", "procedure": "PROCEDURE",
                "trigger": "TRIGGER"}.get(kind)  # fmt: skip
        if what is None:
            raise UserError(f"MySQL has no {kind}s")
        row = live.exec_driver_sql(f"SHOW CREATE {what} {_qualified(item, schema, name)}").fetchone()
        text = row[1] if what in ("TABLE", "VIEW") else row[2]
        return (text or "-- you are not allowed to see this definition") + ";"
    if item.flavor == "sqlite":
        rows = _rows(live, "select sql from sqlite_master where name = :name", {"name": name})
        if not rows:
            raise UserError(f"there is no {kind} {name}")
        return f"{rows[0][0]};"
    if item.flavor == "postgresql":
        schema = schema or "public"
        where = {"schema": schema, "name": name}
        if kind == "view":
            rows = _rows(live, """select c.relkind::text, pg_get_viewdef(c.oid, true) from pg_class c
                                  join pg_namespace n on n.oid = c.relnamespace
                                  where n.nspname = :schema and c.relname = :name""", where)  # fmt: skip
            if not rows:
                raise UserError(f"there is no view {name}")
            head = "CREATE MATERIALIZED VIEW" if rows[0][0] == "m" else "CREATE OR REPLACE VIEW"
            return f"{head} {_qualified(item, schema, name)} AS\n{rows[0][1].rstrip().rstrip(';')};"
        if kind in ("function", "procedure"):
            rows = _rows(live, """select pg_get_functiondef(p.oid) from pg_proc p
                                  join pg_namespace n on n.oid = p.pronamespace
                                  where n.nspname = :schema and p.proname = :name
                                    and pg_get_function_identity_arguments(p.oid) = :signature""",
                         {**where, "signature": signature or ""})  # fmt: skip
            if not rows:
                raise UserError(f"there is no {kind} {name}({signature or ''})")
            return rows[0][0].rstrip() + ";"
        if kind == "trigger":
            rows = _rows(live, """select pg_get_triggerdef(t.oid, true) from pg_trigger t
                                  join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
                                  where n.nspname = :schema and t.tgname = :name
                                    and (:table = '' or c.relname = :table)""",
                         {**where, "table": table_name or ""})  # fmt: skip
            if not rows:
                raise UserError(f"there is no trigger {name}")
            return rows[0][0] + ";"
        if kind == "sequence":
            rows = _rows(live, """select data_type::text, start_value, min_value, max_value, increment_by, cycle,
                                         cache_size from pg_sequences
                                  where schemaname = :schema and sequencename = :name""", where)  # fmt: skip
            if not rows:
                raise UserError(f"there is no sequence {name}")
            kind_, start, low, high, step, cycle, cache = rows[0]
            return (f"CREATE SEQUENCE {_qualified(item, schema, name)}\n    AS {kind_}\n    INCREMENT BY {step}\n"
                    f"    MINVALUE {low}\n    MAXVALUE {high}\n    START WITH {start}\n    CACHE {cache}"
                    f"{'' if cycle else chr(10) + '    NO CYCLE'};")  # fmt: skip
    if kind != "table":
        raise UserError(f"showing a {kind}'s definition is not supported for this database")
    return _table_ddl(item, live, schema, name)


def _table_ddl(item: Link, live: Any, schema: str | None, name: str) -> str:
    """CREATE TABLE (with keys, indexes and comments) rebuilt from what the database reports."""
    from sqlalchemy import MetaData, Table
    from sqlalchemy.schema import CreateIndex, CreateTable, SetColumnComment, SetTableComment

    metadata = MetaData()  # referenced tables load too, so the foreign keys can be written out
    reflected = Table(name, metadata, schema=schema, autoload_with=live)
    parts = [str(CreateTable(reflected).compile(dialect=item.engine.dialect)).strip() + ";"]
    for index in sorted(reflected.indexes, key=lambda i: i.name or ""):
        parts.append(str(CreateIndex(index).compile(dialect=item.engine.dialect)).strip() + ";")
    if item.flavor == "postgresql":
        if reflected.comment:
            parts.append(str(SetTableComment(reflected).compile(dialect=item.engine.dialect)) + ";")
        for column in reflected.columns:
            if column.comment:
                parts.append(str(SetColumnComment(column).compile(dialect=item.engine.dialect)) + ";")
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------------- sessions


@dataclass
class Session:
    id: str
    connection_id: str
    database: str
    link: Link
    live: Any  # a SQLAlchemy Connection in AUTOCOMMIT: transactions are whatever you run
    backend_id: Any = None
    autocommit: bool = True
    in_transaction: bool = False
    running: bool = False
    cancelled: bool = False
    last_used: float = field(default_factory=time.time)
    lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def slot(self) -> tuple[str, str]:
        return (self.connection_id, self.database)


_sessions: dict[str, Session] = {}


def _session(session_id: str) -> Session:
    session = _sessions.get(session_id)
    if session is None:
        raise SessionGone("This tab's connection was closed. Run the query again to reconnect.")
    session.last_used = time.time()
    return session


def _close_idle_sessions() -> None:
    now = time.time()
    for session in list(_sessions.values()):
        if not session.running and now - session.last_used > SESSION_IDLE_S:
            close_session(session.id)


def open_session(ws: Workspace, connection_id: str, database: str | None = None) -> dict[str, Any]:
    _close_idle_sessions()
    connection, _ = _connection(ws, connection_id)
    database = database or connection["values"].get("database") or ""
    item = link(ws, connection_id, database or None)
    try:
        # AUTOCOMMIT: transactions are whatever the script says. no_parameters: the SQL goes to the
        # driver as written, so a % or :name inside it is just text.
        live = item.engine.connect().execution_options(isolation_level="AUTOCOMMIT", no_parameters=True)
    except Exception as error:  # noqa: BLE001
        raise UserError(sql._friendly_connection_error(error)) from error
    session = Session(new_id("s"), connection_id, database, item, live)
    try:
        if item.read_only:
            statement = _read_only_sql(item, session=True)
            if statement:
                live.exec_driver_sql(statement)
        if item.flavor == "postgresql":
            session.backend_id = live.exec_driver_sql("select pg_backend_pid()").scalar()
        elif item.flavor == "mysql":
            session.backend_id = live.exec_driver_sql("select connection_id()").scalar()
    except Exception as error:  # noqa: BLE001
        live.close()
        raise UserError(sql._friendly_connection_error(error)) from error
    _sessions[session.id] = session
    return _describe(session)


def _where(session: Session) -> dict[str, Any]:
    try:
        if session.link.flavor == "postgresql":
            database, schema = session.live.exec_driver_sql("select current_database(), current_schema()").fetchone()
            return {"database": database, "schema": schema}
        if session.link.flavor == "mysql":
            return {"database": session.live.exec_driver_sql("select database()").scalar(), "schema": None}
    except Exception:  # noqa: BLE001 - an aborted transaction answers nothing until rolled back
        pass
    return {"database": session.database, "schema": None}


def _describe(session: Session, where: bool = True) -> dict[str, Any]:
    return {"session_id": session.id, "connection_id": session.connection_id, "flavor": session.link.flavor,
            "server": session.link.server, "read_only": session.link.read_only, "autocommit": session.autocommit,
            "in_transaction": session.in_transaction, "backend_id": session.backend_id,
            **(_where(session) if where else {"database": session.database, "schema": None})}  # fmt: skip


def close_session(session_id: str) -> None:
    session = _sessions.pop(session_id, None)
    if session is None:
        return
    try:
        if session.in_transaction:
            session.live.exec_driver_sql("ROLLBACK")
    except Exception:  # noqa: BLE001
        pass
    # discarded, not pooled: SET, USE, temporary tables and locks from the tab must not leak into
    # the connections used for browsing and editing
    with contextlib.suppress(Exception):
        session.live.invalidate()
    with contextlib.suppress(Exception):
        session.live.close()


def _transaction_word(statement: str) -> str | None:
    word = sql.first_word(statement)
    if word in ("begin", "start"):
        return "begin"
    if word in ("commit", "end"):
        return "commit"
    if word == "rollback" and not re.match(r"\s*rollback\s+(work\s+)?to\b", sql._strip_comments(statement), re.I):
        return "rollback"
    return None


def _fetch_postgres(session: Session, statement: str, limit: int) -> dict[str, Any]:
    """A SELECT through a server-side cursor: only the rows shown leave the server."""
    raw = session.live.connection.dbapi_connection
    plain = raw.cursor()
    own = not session.in_transaction
    if own:
        plain.execute("BEGIN")
    else:
        plain.execute("SAVEPOINT flowlabs_page")
    named = raw.cursor(name=f"flowlabs_{uuid.uuid4().hex[:12]}")
    try:
        named.execute(statement)
        rows = named.fetchmany(limit + 1)
        description = named.description
    except Exception:
        with contextlib.suppress(Exception):
            named.close()
        plain.execute("ROLLBACK" if own else "ROLLBACK TO SAVEPOINT flowlabs_page")
        raise
    named.close()
    plain.execute("COMMIT" if own else "RELEASE SAVEPOINT flowlabs_page")
    names, kinds = _columns_of(description, rows)
    return {"columns": names, "types": kinds, "rows": [[cell(v) for v in r] for r in rows[:limit]],
            "truncated": len(rows) > limit}  # fmt: skip


def _cursorable(item: Link, statement: str) -> bool:
    word = sql.first_word(statement)
    if word not in _ROWS_FIRST:
        return False
    body = sql._strip_comments(statement)
    if word == "with" and _WRITING_CTE.search(body):
        return False
    return not re.search(r"\binto\b|\bfor\s+(update|share|no\s+key|key)\b", body, re.I)


def _run_one(session: Session, statement: str, limit: int) -> dict[str, Any]:
    item, live = session.link, session.live
    word = sql.first_word(statement)
    if item.flavor == "postgresql" and _cursorable(item, statement):
        return _fetch_postgres(session, statement, limit)
    limited = item.flavor == "mysql" and word in _ROWS_FIRST
    if limited:  # what MySQL Workbench does: the server stops after the rows shown
        live.exec_driver_sql(f"SET SESSION sql_select_limit = {int(limit) + 1}")
    try:
        result = live.exec_driver_sql(statement)
        if result.returns_rows:
            rows = [tuple(r) for r in result.fetchmany(limit + 1)]
            result.close()
            names, kinds = _columns_of([(k,) for k in list(result.keys())], rows)
            return {"columns": names, "types": kinds, "rows": [[cell(v) for v in r] for r in rows[:limit]],
                    "truncated": len(rows) > limit}  # fmt: skip
        count = result.rowcount
        result.close()
        return {"rowcount": count if count is not None and count >= 0 else None}
    finally:
        if limited:
            live.exec_driver_sql("SET SESSION sql_select_limit = DEFAULT")


def _message(statement: str, outcome: dict[str, Any]) -> str:
    word = sql.first_word(statement).upper() or "Statement"
    count = outcome.get("rowcount")
    if count is None or word in ("CREATE", "ALTER", "DROP", "SET", "USE", "BEGIN", "START", "COMMIT", "ROLLBACK",
                                 "GRANT", "REVOKE"):  # fmt: skip
        return f"{word} done."
    return f"{word}: {count:,} {'row' if count == 1 else 'rows'} changed."


def _is_cancel(error: Exception) -> bool:
    original = getattr(error, "orig", error)
    if getattr(original, "sqlstate", None) == "57014":  # PostgreSQL query_canceled
        return True
    arguments: tuple[Any, ...] = tuple(getattr(original, "args", ()))
    return bool(arguments) and arguments[0] in (1317, 3024)  # MySQL: interrupted / timeout


def pick(script: str, cursor: int | None, backslash: bool = False) -> list[tuple[int, int, str]]:
    """The statements to run: all of them, or (with ``cursor``) the one the cursor is in or just
    after, as database editors do with Ctrl+Enter. ``backslash``: MySQL's string escapes."""
    spans = sql.statement_spans(script or "", backslash)
    if cursor is None or not spans:
        return spans
    before = [span for span in spans if span[0] <= cursor]
    if not before:
        return spans[:1]
    current = before[-1]
    following = spans[len(before)] if len(before) < len(spans) else None
    # in the blank lines after a statement's end, before the next one starts: the next one if the
    # cursor sits on its line, else the one that just ended
    if following and cursor > current[1] and script.count("\n", current[1], cursor) > script.count("\n", cursor, following[0]):
        return [following]
    return [current]


def execute(ws: Workspace, session_id: str, script: str, limit: int = PAGE_ROWS,
            cursor: int | None = None) -> dict[str, Any]:  # fmt: skip
    """Run a script in a tab's session (or, with ``cursor``, the statement under the cursor). Each
    statement gets a result or a message; the first error stops the script and says which statement
    and line."""
    session = _session(session_id)
    spans = pick(script, cursor, session.link.flavor == "mysql")
    if not spans:
        raise UserError("write a query first")
    _guard(session.link, [s[2] for s in spans])
    limit = max(1, min(int(limit), MAX_PAGE_ROWS))
    if not session.lock.acquire(blocking=False):
        raise UserError("A query is still running in this tab. Stop it, or open another tab.")
    results: list[dict[str, Any]] = []
    error: dict[str, Any] | None = None
    started_all = time.perf_counter()
    try:
        session.running, session.cancelled = True, False
        for index, (start, end, statement) in enumerate(spans):
            control = _transaction_word(statement)
            if not session.autocommit and not session.in_transaction and control is None:
                session.live.exec_driver_sql("BEGIN" if session.link.flavor != "mysql" else "START TRANSACTION")
                session.in_transaction = True
            started = time.perf_counter()
            try:
                outcome = _run_one(session, statement, limit)
            except Exception as failure:  # noqa: BLE001 - the database's words, with where it happened
                if session.link.flavor == "postgresql" and session.in_transaction:
                    session.in_transaction = True  # the transaction is now aborted until rolled back
                cancelled = session.cancelled or _is_cancel(failure)
                message = "Stopped." if cancelled else sql._friendly_connection_error(failure)
                line_in = sql._error_line(str(getattr(failure, "orig", failure)))
                line = script.count("\n", 0, start) + (line_in or 1)
                error = {"message": message, "statement": index, "line": line, "start": start, "end": end,
                         "cancelled": cancelled}  # fmt: skip
                break
            if control == "begin":
                session.in_transaction = True
            elif control in ("commit", "rollback"):
                session.in_transaction = False
            elif sql.first_word(statement) == "use" and session.link.flavor == "mysql":
                session.database = statement.split(None, 1)[1].strip().strip("`;")
            elapsed = round((time.perf_counter() - started) * 1000)
            entry = {"statement": index, "start": start, "end": end, "sql": statement[:400], "elapsed_ms": elapsed}
            if "columns" in outcome:
                if len([r for r in results if "columns" in r]) < MAX_RESULTS:
                    results.append({**entry, **outcome})
                else:
                    results.append({**entry, "message": "Result not shown (too many results in one run)."})
            else:
                results.append({**entry, "message": _message(statement, outcome), "rowcount": outcome.get("rowcount")})
    finally:
        session.running = False
        session.lock.release()
    return {"results": results, "error": error, "elapsed_ms": round((time.perf_counter() - started_all) * 1000),
            "session": _describe(session)}  # fmt: skip


def cancel(ws: Workspace, session_id: str) -> dict[str, Any]:
    """Ask the server to stop the query running in a tab."""
    session = _session(session_id)
    if not session.running:
        return {"cancelled": False}
    session.cancelled = True
    item = session.link
    try:
        if item.flavor == "postgresql" and session.backend_id:
            with item.engine.connect() as other:
                other.exec_driver_sql(f"select pg_cancel_backend({int(session.backend_id)})")
        elif item.flavor == "mysql" and session.backend_id:
            with item.engine.connect() as other:
                other.exec_driver_sql(f"KILL QUERY {int(session.backend_id)}")
        elif item.flavor == "sqlite":
            session.live.connection.dbapi_connection.interrupt()
        else:
            raise UserError("This database cannot stop a query from FlowLabs.")
    except UserError:
        raise
    except Exception as error:  # noqa: BLE001
        raise UserError(f"Could not stop the query: {sql._friendly_connection_error(error)}") from error
    return {"cancelled": True}


def finish_transaction(ws: Workspace, session_id: str, commit: bool) -> dict[str, Any]:
    session = _session(session_id)
    if session.running:
        raise UserError("Wait for the query to finish, or stop it first.")
    with session.lock:
        session.live.exec_driver_sql("COMMIT" if commit else "ROLLBACK")
        session.in_transaction = False
    return _describe(session)


def set_autocommit(ws: Workspace, session_id: str, on: bool) -> dict[str, Any]:
    session = _session(session_id)
    if session.in_transaction and on:
        raise UserError("Commit or roll back the open transaction first.")
    session.autocommit = bool(on)
    return _describe(session)


# ---------------------------------------------------------------------------------- export


EXPORT_FORMATS = {"csv": "CSV", "xlsx": "Excel", "json": "JSON", "parquet": "Parquet"}
EXCEL_MAX_ROWS = 1_048_575


def _chunks(item: Link, live: Any, statement: str, size: int = 20_000) -> Iterator[pd.DataFrame]:
    if item.flavor == "postgresql":
        raw = live.connection.dbapi_connection
        named = raw.cursor(name=f"flowlabs_export_{uuid.uuid4().hex[:10]}")
        named.execute(statement)
        names = None
        while True:
            rows = named.fetchmany(size)
            names = names or [d.name for d in named.description]
            if not rows:
                break
            yield pd.DataFrame([[cell_export(v) for v in r] for r in rows], columns=names)
        named.close()
        return
    result = live.execution_options(stream_results=True, yield_per=size, no_parameters=True).exec_driver_sql(statement)
    if not result.returns_rows:
        raise UserError("the query returned no table to export")
    names = list(result.keys())
    while True:
        rows = result.fetchmany(size)
        if not rows:
            break
        yield pd.DataFrame([[cell_export(v) for v in r] for r in rows], columns=names)


def cell_export(value: Any) -> Any:
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (uuid.UUID, dict, list, bytes, bytearray, memoryview, dt.timedelta)):
        return cell(value)
    return value


def export_query(ws: Workspace, connection_id: str, database: str | None, script: str, fmt: str,
                 name: str | None = None, cursor: int | None = None) -> dict[str, Any]:  # fmt: skip
    """Run a query in full (the statement under ``cursor``, or the script's last) and write its
    result to a file to download."""
    if fmt not in EXPORT_FORMATS:
        raise UserError("export as CSV, Excel, JSON or Parquet")
    item = link(ws, connection_id, database or None)
    statements = [span[2] for span in pick(script, cursor, item.flavor == "mysql")]
    if not statements:
        raise UserError("write a query first")
    statement = statements[-1]
    _guard(item, [statement], session=False)
    if sql.first_word(statement) not in sql.READ_WORDS:
        raise UserError("Export runs a query that reads, such as SELECT. Run changes in the editor.")
    folder = ws.root / "exports" / "sql"
    folder.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^\w.-]+", "_", (name or "query").strip())[:60].strip("_") or "query"
    target = folder / f"{stem}-{time.strftime('%Y%m%d-%H%M%S')}.{fmt}"
    total = 0
    started = time.perf_counter()
    with item.engine.connect() as live:
        if item.read_only:
            ro = _read_only_sql(item, session=False)
            if ro:
                live.exec_driver_sql(ro)
        try:
            frames = _chunks(item, live, statement)
            if fmt == "csv":
                for index, frame in enumerate(frames):
                    frame.to_csv(target, mode="a", header=index == 0, index=False)
                    total += len(frame)
                if total == 0:
                    target.write_text("")
            elif fmt == "json":
                with target.open("w", encoding="utf-8") as out:
                    out.write("[")
                    for frame in frames:
                        for record in frame.to_json(orient="records", date_format="iso", lines=True).splitlines():
                            out.write(("," if total else "") + "\n" + record)
                            total += 1
                    out.write("\n]\n")
            else:
                whole = pd.concat(list(frames), ignore_index=True)
                total = len(whole)
                whole = sql._plain_values(whole)
                if fmt == "xlsx":
                    if total > EXCEL_MAX_ROWS:
                        raise UserError(f"Excel holds at most {EXCEL_MAX_ROWS:,} rows; this result has {total:,}. "
                                        "Export it as CSV or Parquet.")  # fmt: skip
                    for column in whole.columns:
                        if pd.api.types.is_datetime64tz_dtype(whole[column]):
                            whole[column] = whole[column].dt.tz_localize(None)
                    whole.to_excel(target, index=False, sheet_name=stem[:31] or "Result")
                else:
                    whole.columns = [str(c) for c in whole.columns]
                    whole.to_parquet(target, index=False)
        except ValueError as error:
            if "No objects to concatenate" in str(error):
                pd.DataFrame().to_csv(target) if fmt != "parquet" else pd.DataFrame().to_parquet(target)
            else:
                target.unlink(missing_ok=True)
                raise UserError(str(error)) from error
        except UserError:
            target.unlink(missing_ok=True)
            raise
        except Exception as error:  # noqa: BLE001
            target.unlink(missing_ok=True)
            raise sql.SqlError(sql._friendly_connection_error(error)) from error
        finally:
            live.rollback()
    return {"path": target.relative_to(ws.root).as_posix(), "name": target.name, "rows": total,
            "bytes": target.stat().st_size, "elapsed_ms": round((time.perf_counter() - started) * 1000)}  # fmt: skip


def save_dataset(ws: Workspace, connection_id: str, database: str | None, script: str, name: str,
                 cursor: int | None = None) -> dict[str, Any]:  # fmt: skip
    """Keep a query's whole result as a FlowLabs dataset, ready for a project."""
    written = export_query(ws, connection_id, database, script, "parquet", name or "query", cursor)
    path = ws.root / written["path"]
    try:
        return datasets.import_file(ws, path, f"{(name or 'query result').strip()}.parquet")
    finally:
        path.unlink(missing_ok=True)


# ------------------------------------------------------------------------------- table data


def _coerce(column: Any, value: Any) -> Any:
    """A value typed in the grid (text) as the column's Python type."""
    if value is None:
        return None
    try:
        kind = column.type.python_type
    except NotImplementedError:
        return value
    if isinstance(value, kind) and not (kind is int and isinstance(value, bool)):
        return value
    text = str(value)
    try:
        if kind is bool:
            lowered = text.strip().lower()
            if lowered in ("true", "t", "1", "yes"):
                return True
            if lowered in ("false", "f", "0", "no"):
                return False
            raise ValueError(text)
        if kind is int:
            return int(text)
        if kind is float:
            return float(text)
        if kind is decimal.Decimal:
            return decimal.Decimal(text)
        if kind is dt.datetime:
            return dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
        if kind is dt.date:
            return dt.date.fromisoformat(text[:10])
        if kind is dt.time:
            return dt.time.fromisoformat(text)
        if kind is uuid.UUID:
            return uuid.UUID(text)
        if kind in (dict, list):
            return json.loads(text)
    except (ValueError, decimal.InvalidOperation) as error:
        raise UserError(f"{column.name}: {text!r} is not a valid {column.type}") from error
    return value


def rows(ws: Workspace, connection_id: str, database: str, schema: str | None, name: str, offset: int = 0,
         limit: int = 200, order: list[dict[str, Any]] | None = None, where: str | None = None) -> dict[str, Any]:  # fmt: skip
    """A page of a table's rows, for viewing and editing."""
    from sqlalchemy import func, select, text

    item = link(ws, connection_id, database)
    schema = _schema_for(item, database, schema)
    limit = max(1, min(int(limit), 2000))
    if where and ";" in sql._strip_comments(where):
        raise UserError("the filter is one condition, without semicolons")
    with _reading(item) as live:
        reflected = _reflect(item, live, schema, name)
        keys = [c.name for c in reflected.primary_key.columns]
        query = select(reflected)
        counting = select(func.count()).select_from(reflected)
        if where and where.strip():
            query = query.where(text(where))
            counting = counting.where(text(where))
        for part in order or []:
            column = reflected.columns.get(str(part.get("column")))
            if column is not None:
                query = query.order_by(column.desc() if part.get("desc") else column.asc())
        if not order and keys:
            query = query.order_by(*[reflected.columns[k] for k in keys])
        try:
            fetched = live.execute(query.offset(int(offset)).limit(limit)).fetchall()
            estimate = _estimate(item, live, schema, name)
            exact = bool(where) or estimate is None or estimate < EXACT_COUNT_UNDER
            total = int(live.execute(counting).scalar() or 0) if exact or estimate is None else estimate
        except Exception as error:  # noqa: BLE001
            raise sql.SqlError(sql._friendly_connection_error(error)) from error
    columns = [{"name": c.name, "type": str(c.type), "nullable": bool(c.nullable), "key": c.primary_key,
                "default": c.server_default is not None or bool(c.autoincrement is True and c.primary_key)}
               for c in reflected.columns]  # fmt: skip
    return {"columns": columns, "primary_key": keys, "rows": [[cell(v) for v in r] for r in fetched],
            "offset": int(offset), "total": total, "exact": bool(exact), "editable": bool(keys) and not item.read_only,
            "read_only": item.read_only}  # fmt: skip


def _estimate(item: Link, live: Any, schema: str | None, name: str) -> int | None:
    try:
        if item.flavor == "postgresql":
            value = _rows(live, "select greatest(c.reltuples, 0)::bigint from pg_class c join pg_namespace n on "
                                "n.oid = c.relnamespace where n.nspname = :s and c.relname = :n",
                          {"s": schema or "public", "n": name})  # fmt: skip
        elif item.flavor == "mysql":
            value = _rows(live, "select TABLE_ROWS from information_schema.TABLES where TABLE_SCHEMA = :s "
                                "and TABLE_NAME = :n", {"s": schema, "n": name})  # fmt: skip
        else:
            return None
        return int(value[0][0]) if value and value[0][0] is not None else None
    except Exception:  # noqa: BLE001
        return None


def apply_changes(ws: Workspace, connection_id: str, database: str, schema: str | None, name: str,
                  changes: dict[str, Any], preview: bool = False) -> dict[str, Any]:  # fmt: skip
    """Save edits from the grid in one transaction: ``updates`` [{key, values}], ``inserts``
    [{column: value}], ``deletes`` [{key}]. Each update and delete must touch exactly one row, or
    nothing is saved. ``preview`` returns the SQL without running it."""
    from sqlalchemy import and_, delete, insert, update

    item = link(ws, connection_id, database)
    _need_changes(item)
    schema = _schema_for(item, database, schema)
    with item.engine.connect() as live:
        reflected = _reflect(item, live, schema, name)
        live.rollback()
    keys = [c for c in reflected.primary_key.columns]
    if not keys:
        raise UserError(f"{name} has no primary key, so its rows cannot be told apart. Edit it with SQL instead.")

    def match(key: dict[str, Any]) -> Any:
        missing = [c.name for c in keys if c.name not in key]
        if missing:
            raise UserError(f"the row's key is missing {', '.join(missing)}")
        return and_(*[c == _coerce(c, key[c.name]) for c in keys])

    def typed(values: dict[str, Any]) -> dict[str, Any]:
        out = {}
        for column_name, value in values.items():
            column = reflected.columns.get(column_name)
            if column is None:
                raise UserError(f"{name} has no column {column_name}")
            out[column_name] = _coerce(column, value)
        return out

    statements: list[tuple[str, Any, bool]] = []  # (kind, statement, must touch one row)
    for change in changes.get("updates") or []:
        if change.get("values"):
            statements.append(("update", update(reflected).where(match(change["key"])).values(**typed(change["values"])), True))
    for values in changes.get("inserts") or []:
        statements.append(("insert", insert(reflected).values(**typed(values)), False))
    for change in changes.get("deletes") or []:
        statements.append(("delete", delete(reflected).where(match(change["key"])), True))
    if not statements:
        raise UserError("there are no changes to save")
    if preview:
        return {"sql": [_literal(item, s) for _, s, _ in statements]}
    counts = {"update": 0, "insert": 0, "delete": 0}
    with item.engine.connect() as live:
        transaction = live.begin()
        try:
            for kind, statement, single in statements:
                touched = live.execute(statement).rowcount
                if single and touched != 1:
                    raise UserError(
                        f"A {kind} would change {touched} rows instead of 1: the row was changed or deleted "
                        "since you loaded it. Nothing was saved; reload the table and try again."
                    )
                counts[kind] += 1
            transaction.commit()
        except UserError:
            transaction.rollback()
            raise
        except Exception as error:  # noqa: BLE001
            transaction.rollback()
            raise sql.SqlError(sql._friendly_connection_error(error)) from error
    return {"saved": counts}


def _literal(item: Link, statement: Any) -> str:
    try:
        return str(statement.compile(dialect=item.engine.dialect, compile_kwargs={"literal_binds": True})) + ";"
    except Exception:  # noqa: BLE001 - a type without a literal form: show the parameters instead
        compiled = statement.compile(dialect=item.engine.dialect)
        return f"{compiled};  -- {dict(compiled.params)}"


def import_dataset(ws: Workspace, connection_id: str, database: str, schema: str | None, name: str,
                   dataset_id: str, mode: str = "create") -> dict[str, Any]:  # fmt: skip
    """Copy a FlowLabs dataset into a table: ``create`` a new one, ``append`` or ``replace``."""
    item = link(ws, connection_id, database)
    _need_changes(item)
    schema = _schema_for(item, database, schema)
    name = name.strip()
    if not name:
        raise UserError("name the table")
    if mode not in ("create", "append", "replace"):
        raise UserError("choose create, append or replace")
    frame = datasets.load_frame(ws, dataset_id)
    frame.columns = [str(c) for c in frame.columns]
    started = time.perf_counter()
    try:
        with item.engine.begin() as live:
            frame.to_sql(name, live, schema=schema, if_exists={"create": "fail"}.get(mode, mode), index=False,
                         chunksize=2000, method="multi")  # fmt: skip
    except ValueError as error:
        if "already exists" in str(error):
            raise UserError(f"a table named {name} already exists: choose append or replace") from error
        raise UserError(str(error)) from error
    except Exception as error:  # noqa: BLE001
        raise sql.SqlError(sql._friendly_connection_error(error)) from error
    return {"table": name, "schema": schema, "rows": len(frame),
            "elapsed_ms": round((time.perf_counter() - started) * 1000)}  # fmt: skip


# ---------------------------------------------------------------------------------- explain


def explain(ws: Workspace, session_id: str, script: str, analyze: bool = False,
            cursor: int | None = None) -> dict[str, Any]:  # fmt: skip
    """The plan of a query (the statement under ``cursor``, or the script's last) as a tree. With
    ``analyze`` the query really runs; for statements that write, inside a transaction that is
    rolled back."""
    session = _session(session_id)
    item = session.link
    statements = [span[2] for span in pick(script, cursor, item.flavor == "mysql")]
    if not statements:
        raise UserError("write a query first")
    statement = statements[-1]
    _guard(item, [statement])
    word = sql.first_word(statement)
    if word in ("explain", "analyze", "describe", "desc"):
        raise UserError("Write the query itself; FlowLabs adds EXPLAIN.")
    if not session.lock.acquire(blocking=False):
        raise UserError("A query is still running in this tab.")
    try:
        session.running, session.cancelled = True, False
        writes = sql.writes(statement)
        wrap = analyze and writes and not session.in_transaction
        live = session.live
        if wrap:
            live.exec_driver_sql("BEGIN" if item.flavor != "mysql" else "START TRANSACTION")
        try:
            if item.flavor == "postgresql":
                options = "FORMAT JSON, ANALYZE true, BUFFERS true" if analyze else "FORMAT JSON"
                raw = live.exec_driver_sql(f"EXPLAIN ({options}) {statement}").scalar()
                plan = raw if isinstance(raw, list) else json.loads(raw)
                return {"flavor": item.flavor, "analyze": analyze, **_postgres_plan(plan),
                        "raw": json.dumps(plan, indent=2)}  # fmt: skip
            if item.flavor == "mysql" and item.mariadb:
                prefix = "ANALYZE FORMAT=JSON" if analyze else "EXPLAIN FORMAT=JSON"
                raw = live.exec_driver_sql(f"{prefix} {statement}").scalar()
                plan = json.loads(raw)
                return {"flavor": item.flavor, "analyze": analyze, "tree": _json_plan(plan), "raw": json.dumps(plan, indent=2),
                        "totals": {}}  # fmt: skip
            if item.flavor == "mysql":
                prefix = "EXPLAIN ANALYZE" if analyze else "EXPLAIN FORMAT=TREE"
                text = "\n".join(str(r[0]) for r in live.exec_driver_sql(f"{prefix} {statement}").fetchall())
                return {"flavor": item.flavor, "analyze": analyze, "tree": _tree_plan(text), "raw": text, "totals": {}}
            if item.flavor == "sqlite":
                found = live.exec_driver_sql(f"EXPLAIN QUERY PLAN {statement}").fetchall()
                return {"flavor": item.flavor, "analyze": False, "tree": _sqlite_plan(found),
                        "raw": "\n".join(str(r[3]) for r in found), "totals": {}}  # fmt: skip
            raise UserError("Plans are shown for PostgreSQL, MySQL, MariaDB and SQLite.")
        except UserError:
            raise
        except Exception as error:  # noqa: BLE001
            raise sql.SqlError(sql._friendly_connection_error(error), sql._error_line(str(getattr(error, "orig", error)))) from error
        finally:
            if wrap:
                with contextlib.suppress(Exception):
                    live.exec_driver_sql("ROLLBACK")
    finally:
        session.running = False
        session.lock.release()


def _node(label: str, detail: list[str], **numbers: Any) -> dict[str, Any]:
    return {"label": label, "detail": [d for d in detail if d], "children": [],
            **{k: v for k, v in numbers.items() if v is not None}}  # fmt: skip


_FULL_SCANS = ("Seq Scan", "Table scan", "full scan", "ALL")


def _hint(node: dict[str, Any]) -> None:
    rows = node.get("actual_rows", node.get("rows")) or 0
    if any(word in node["label"] for word in _FULL_SCANS) and rows >= 10_000:
        node["hint"] = "Reads the whole table. An index on the columns in the filter may make this faster."


def _postgres_plan(plan: list[dict[str, Any]]) -> dict[str, Any]:
    top = plan[0]

    def walk(data: dict[str, Any]) -> dict[str, Any]:
        kind = data.get("Node Type", "?")
        target = data.get("Relation Name") or data.get("Index Name") or data.get("CTE Name") or data.get("Function Name")
        label = f"{kind} on {target}" if target and kind not in ("Index Scan", "Index Only Scan") else kind
        if kind in ("Index Scan", "Index Only Scan") and data.get("Relation Name"):
            label = f"{kind} on {data['Relation Name']} using {data.get('Index Name')}"
        detail = [f"{k}: {data[k]}" for k in ("Join Type", "Filter", "Index Cond", "Hash Cond", "Merge Cond",
                                               "Join Filter", "Recheck Cond", "Strategy", "Sort Method")
                  if data.get(k)]  # fmt: skip
        if data.get("Sort Key"):
            detail.append("Sort Key: " + ", ".join(data["Sort Key"]))
        if data.get("Group Key"):
            detail.append("Group Key: " + ", ".join(data["Group Key"]))
        if data.get("Rows Removed by Filter"):
            detail.append(f"Rows removed by filter: {data['Rows Removed by Filter']:,}")
        loops = data.get("Actual Loops") or 1
        node = _node(label, detail, cost=data.get("Total Cost"), rows=data.get("Plan Rows"),
                     actual_rows=None if data.get("Actual Rows") is None else data["Actual Rows"] * loops,
                     time_ms=None if data.get("Actual Total Time") is None else round(data["Actual Total Time"] * loops, 3))  # fmt: skip
        _hint(node)
        node["children"] = [walk(child) for child in data.get("Plans") or []]
        return node

    totals = {k: top[v] for k, v in (("planning_ms", "Planning Time"), ("execution_ms", "Execution Time")) if v in top}
    return {"tree": walk(top["Plan"]), "totals": totals}


_TREE_LINE = re.compile(r"^(?P<indent>\s*)-> (?P<label>.*?)(?:\s+\(cost=(?P<cost>[\d.e+]+)\s+rows=(?P<rows>[\d.e+]+)\))?"
                        r"(?:\s+\(actual time=[\d.e+]+\.\.(?P<time>[\d.e+]+) rows=(?P<arows>[\d.e+]+) loops=(?P<loops>\d+)\))?\s*$")  # fmt: skip


def _tree_plan(text: str) -> dict[str, Any]:
    """MySQL's EXPLAIN FORMAT=TREE (and EXPLAIN ANALYZE) as nodes."""
    root = _node("Query", [])
    stack: list[tuple[int, dict[str, Any]]] = [(-1, root)]
    for line in text.splitlines():
        match = _TREE_LINE.match(line)
        if not match:
            if stack[-1][1] is not root and line.strip():
                stack[-1][1]["detail"].append(line.strip())
            continue
        depth = len(match.group("indent"))
        loops = int(match.group("loops") or 1)
        node = _node(match.group("label"), [],
                     cost=float(match.group("cost")) if match.group("cost") else None,
                     rows=float(match.group("rows")) if match.group("rows") else None,
                     actual_rows=round(float(match.group("arows")) * loops) if match.group("arows") else None,
                     time_ms=round(float(match.group("time")) * loops, 3) if match.group("time") else None)  # fmt: skip
        _hint(node)
        while stack and stack[-1][0] >= depth:
            stack.pop()
        stack[-1][1]["children"].append(node)
        stack.append((depth, node))
    return root["children"][0] if len(root["children"]) == 1 else root


def _json_plan(plan: dict[str, Any]) -> dict[str, Any]:
    """MariaDB's (and older MySQL's) EXPLAIN FORMAT=JSON as nodes."""

    def walk(name: str, data: Any) -> dict[str, Any] | None:
        if not isinstance(data, dict):
            return None
        if "table_name" in data:
            access = data.get("access_type", "")
            label = {"ALL": "Full table scan", "index": "Full index scan", "range": "Index range scan",
                     "ref": "Index lookup", "eq_ref": "Unique index lookup", "const": "Single row"}.get(access, access)
            node = _node(f"{label} on {data['table_name']}",
                         [f"Index: {data['key']}" if data.get("key") else "",
                          f"Possible indexes: {', '.join(data['possible_keys'])}" if data.get("possible_keys") else "",
                          f"Condition: {data['attached_condition']}" if data.get("attached_condition") else ""],
                         rows=data.get("rows") or data.get("rows_examined_per_scan"), actual_rows=data.get("r_rows"),
                         time_ms=data.get("r_total_time_ms"), cost=(data.get("cost_info") or {}).get("prefix_cost") or data.get("cost"))  # fmt: skip
            if access == "ALL":
                node["label"] = node["label"].replace("Full table scan", "Full table scan (ALL)")
            _hint(node)
            return node
        node = _node(name.replace("_", " ").capitalize(), [])
        for key, value in data.items():
            values = value if isinstance(value, list) else [value]
            for entry in values:
                if isinstance(entry, dict) and "table" in entry and len(entry) == 1:
                    entry = entry["table"]
                child = walk(key, entry)
                if child is not None:
                    node["children"].append(child)
        if not node["children"]:
            return None
        return node["children"][0] if len(node["children"]) == 1 and name not in ("query_block",) else node

    return walk("query_block", plan.get("query_block", plan)) or _node("Query", [])


def _sqlite_plan(found: list[tuple[Any, ...]]) -> dict[str, Any]:
    root = _node("Query", [])
    nodes: dict[int, dict[str, Any]] = {0: root}
    for identifier, parent, _, detail in found:
        node = _node(str(detail), [])
        if str(detail).startswith("SCAN ") and "USING" not in str(detail):
            node["label"] = "Table scan: " + str(detail)[5:]
        nodes[int(identifier)] = node
        nodes.get(int(parent), root)["children"].append(node)
    return root


# ------------------------------------------------------------------------------------ admin


def activity(ws: Workspace, connection_id: str) -> dict[str, Any]:
    """The sessions on the server and what each is running."""
    item = link(ws, connection_id)
    mine = {s.backend_id for s in _sessions.values() if s.connection_id == connection_id}
    with _reading(item) as live:
        if item.flavor == "postgresql":
            found = _rows(live, """
                select pid, usename, datname, application_name, client_addr::text, state,
                       coalesce(wait_event_type || ': ' || wait_event, ''),
                       extract(epoch from now() - coalesce(query_start, backend_start))::float, query
                from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid()
                order by query_start nulls last""")
            sessions = [{"id": r[0], "user": r[1], "database": r[2], "app": r[3], "client": r[4], "state": r[5],
                         "waiting": r[6] or None, "seconds": round(r[7] or 0, 1), "query": r[8],
                         "mine": r[0] in mine} for r in found]  # fmt: skip
            stats = _rows(live, """select version(), extract(epoch from now() - pg_postmaster_start_time())::bigint,
                                          (select count(*) from pg_stat_activity), current_setting('max_connections'),
                                          pg_database_size(current_database())""")[0]  # fmt: skip
            server = {"version": stats[0].split(" on ")[0], "uptime_s": stats[1], "connections": stats[2],
                      "max_connections": int(stats[3]), "database_bytes": stats[4]}  # fmt: skip
        elif item.flavor == "mysql":
            own = live.exec_driver_sql("select connection_id()").scalar()
            found = [r for r in live.exec_driver_sql("SHOW FULL PROCESSLIST").fetchall() if r[0] != own]
            sessions = [{"id": r[0], "user": r[1], "client": r[2], "database": r[3], "state": r[4] if r[4] != "Query"
                         else (r[6] or "running"), "seconds": float(r[5] or 0), "query": r[7], "app": None,
                         "waiting": r[6] if r[4] == "Query" and r[6] else None, "mine": r[0] in mine}
                        for r in found if r[4] != "Daemon"]  # fmt: skip
            status = dict(live.exec_driver_sql("SHOW GLOBAL STATUS WHERE Variable_name IN "
                                               "('Uptime', 'Threads_connected', 'Questions')").fetchall())  # fmt: skip
            limit = live.exec_driver_sql("select @@max_connections, version()").fetchone()
            server = {"version": item.server, "uptime_s": int(status.get("Uptime", 0)),
                      "connections": int(status.get("Threads_connected", 0)), "max_connections": int(limit[0]),
                      "queries": int(status.get("Questions", 0))}  # fmt: skip
        else:
            raise UserError("Server activity is shown for PostgreSQL, MySQL and MariaDB.")
    return {"server": server, "sessions": sessions, "read_only": item.read_only}


def stop_session(ws: Workspace, connection_id: str, backend_id: int, terminate: bool = False) -> dict[str, Any]:
    """Cancel a session's running query, or end the session (``terminate``)."""
    item = link(ws, connection_id)
    if terminate:
        _need_changes(item)
    with item.engine.connect() as live:
        try:
            if item.flavor == "postgresql":
                function = "pg_terminate_backend" if terminate else "pg_cancel_backend"
                done = live.exec_driver_sql(f"select {function}({int(backend_id)})").scalar()
            elif item.flavor == "mysql":
                live.exec_driver_sql(f"KILL {'' if terminate else 'QUERY '}{int(backend_id)}")
                done = True
            else:
                raise UserError("Stopping sessions is supported for PostgreSQL, MySQL and MariaDB.")
        except UserError:
            raise
        except Exception as error:  # noqa: BLE001
            raise UserError(sql._friendly_connection_error(error)) from error
    return {"done": bool(done)}


def users(ws: Workspace, connection_id: str) -> dict[str, Any]:
    item = link(ws, connection_id)
    with _reading(item) as live:
        if item.flavor == "postgresql":
            found = _rows(live, """
                select r.rolname, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
                       r.rolconnlimit, r.rolvaliduntil::text,
                       array(select b.rolname from pg_auth_members m join pg_roles b on b.oid = m.roleid
                             where m.member = r.oid order by 1)
                from pg_roles r where r.rolname !~ '^pg_' order by r.rolcanlogin desc, r.rolname""")
            people = [{"name": r[0], "host": None, "login": r[1], "superuser": r[2], "create_db": r[3],
                       "create_role": r[4], "replication": r[5],
                       "connection_limit": None if r[6] < 0 else r[6], "valid_until": r[7],
                       "member_of": list(r[8] or [])} for r in found]  # fmt: skip
            current = _rows(live, "select current_user")[0][0]
        elif item.flavor == "mysql":
            current = _rows(live, "select current_user()")[0][0]
            try:
                found = _rows(live, "select User, Host from mysql.user order by User, Host")
            except Exception:  # noqa: BLE001 - not allowed to read mysql.user
                return {"flavor": item.flavor, "current": current, "users": [], "read_only": item.read_only,
                        "note": "Your user is not allowed to list accounts (it needs SELECT on mysql.user)."}  # fmt: skip
            people = [{"name": r[0], "host": r[1], "login": True} for r in found]
        else:
            raise UserError("Users and roles are shown for PostgreSQL, MySQL and MariaDB.")
    return {"flavor": item.flavor, "current": current, "users": people, "read_only": item.read_only}


def grants(ws: Workspace, connection_id: str, user: str, host: str | None = None) -> dict[str, Any]:
    item = link(ws, connection_id)
    with _reading(item) as live:
        if item.flavor == "mysql":
            account = f"{_literal_text(item, user)}@{_literal_text(item, host or '%')}"
            try:
                found = [r[0] for r in live.exec_driver_sql(f"SHOW GRANTS FOR {account}").fetchall()]
            except Exception as error:  # noqa: BLE001
                raise UserError(sql._friendly_connection_error(error)) from error
            return {"statements": found}
        if item.flavor == "postgresql":
            databases = _rows(live, """select datname, has_database_privilege(:u, datname, 'CONNECT'),
                                              has_database_privilege(:u, datname, 'CREATE'),
                                              has_database_privilege(:u, datname, 'TEMP')
                                       from pg_database where not datistemplate order by 1""", {"u": user})  # fmt: skip
            schema_rights = _rows(live, """select nspname, has_schema_privilege(:u, nspname, 'USAGE'),
                                                  has_schema_privilege(:u, nspname, 'CREATE')
                                           from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema'
                                           order by 1""", {"u": user})  # fmt: skip
            tables = _rows(live, """select table_schema, table_name, string_agg(privilege_type, ', ' order by privilege_type)
                                    from information_schema.role_table_grants where grantee = :u
                                      and table_schema not in ('pg_catalog', 'information_schema')
                                    group by 1, 2 order by 1, 2 limit 500""", {"u": user})  # fmt: skip
            return {"databases": [{"name": r[0], "connect": r[1], "create": r[2], "temp": r[3]} for r in databases],
                    "schemas": [{"name": r[0], "usage": r[1], "create": r[2]} for r in schema_rights],
                    "tables": [{"schema": r[0], "name": r[1], "privileges": r[2]} for r in tables]}  # fmt: skip
    raise UserError("Grants are shown for PostgreSQL, MySQL and MariaDB.")


def _literal_text(item: Link, value: str) -> str:
    if item.flavor == "mysql":
        return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"
    return "'" + str(value).replace("'", "''") + "'"


_PRIVILEGES = {
    "postgresql": {"database": ("CONNECT", "CREATE", "TEMPORARY", "ALL"), "schema": ("USAGE", "CREATE", "ALL"),
                   "tables": ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "ALL")},
    "mysql": {"database": ("SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX",
                           "CREATE VIEW", "SHOW VIEW", "EXECUTE", "CREATE ROUTINE", "ALTER ROUTINE", "TRIGGER",
                           "EVENT", "LOCK TABLES", "CREATE TEMPORARY TABLES", "REFERENCES", "ALL PRIVILEGES"),
              "tables": ("SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX", "TRIGGER",
                         "REFERENCES", "ALL PRIVILEGES")},
}  # fmt: skip


def privileges(ws: Workspace, connection_id: str) -> dict[str, Any]:
    item = link(ws, connection_id)
    return {"flavor": item.flavor, "scopes": {k: list(v) for k, v in _PRIVILEGES.get(item.flavor, {}).items()}}


def user_change(ws: Workspace, connection_id: str, action: str, params: dict[str, Any], preview: bool = False) -> dict[str, Any]:
    """Create, change or drop a user, or grant and revoke privileges. ``preview`` returns the SQL with
    passwords hidden; otherwise it runs."""
    item = link(ws, connection_id)
    _need_changes(item)
    statements, shown = _user_sql(item, action, params)
    if preview:
        return {"sql": shown}
    with item.engine.connect() as live:
        transaction = live.begin()
        try:
            for statement in statements:
                live.exec_driver_sql(statement)
            transaction.commit()
        except Exception as error:  # noqa: BLE001
            transaction.rollback()
            raise UserError(sql._friendly_connection_error(error)) from error
    return {"done": True, "sql": shown}


def _user_sql(item: Link, action: str, p: dict[str, Any]) -> tuple[list[str], list[str]]:
    name = str(p.get("name") or "").strip()
    if not name:
        raise UserError("enter the user's name")
    password = str(p.get("password") or "")
    hidden = "'••••••••'"
    mysql = item.flavor == "mysql"
    if item.flavor not in ("postgresql", "mysql"):
        raise UserError("Users are managed for PostgreSQL, MySQL and MariaDB.")
    who = f"{_literal_text(item, name)}@{_literal_text(item, str(p.get('host') or '%'))}" if mysql else _q(item, name)
    secret = _literal_text(item, password)
    if action == "create":
        if mysql:
            sql_text = f"CREATE USER {who}" + (" IDENTIFIED BY {}" if password else "")
        else:
            options = ["LOGIN" if p.get("login", True) else "NOLOGIN"]
            options += [word for flag, word in (("superuser", "SUPERUSER"), ("create_db", "CREATEDB"),
                                                ("create_role", "CREATEROLE")) if p.get(flag)]  # fmt: skip
            sql_text = f"CREATE ROLE {who} WITH {' '.join(options)}" + (" PASSWORD {}" if password else "")
        return [sql_text.format(secret) + ";"], [sql_text.format(hidden) + ";"]
    if action == "password":
        if not password:
            raise UserError("enter the new password")
        sql_text = f"ALTER USER {who} IDENTIFIED BY {{}}" if mysql else f"ALTER ROLE {who} WITH PASSWORD {{}}"
        return [sql_text.format(secret) + ";"], [sql_text.format(hidden) + ";"]
    if action == "drop":
        statement = f"DROP USER {who};" if mysql else f"DROP ROLE {who};"
        return [statement], [statement]
    if action in ("grant", "revoke"):
        scope = str(p.get("scope") or "")
        allowed = _PRIVILEGES[item.flavor].get(scope)
        chosen = [str(x).upper() for x in p.get("privileges") or []]
        if not allowed:
            raise UserError("choose what to grant on")
        if not chosen or any(x not in allowed for x in chosen):
            raise UserError("choose privileges from the list")
        target = str(p.get("target") or "").strip()
        if not target:
            raise UserError("choose the database, schema or table")
        listed = ", ".join(chosen)
        if mysql:
            database, _, table_name = target.partition(".")
            on = f"{_q(item, database)}.{_q(item, table_name) if table_name and scope == 'tables' else '*'}"
        elif scope == "database":
            on = f"DATABASE {_q(item, target)}"
        elif scope == "schema":
            on = f"SCHEMA {_q(item, target)}"
        else:
            schema_name, _, table_name = target.partition(".")
            on = (f"ALL TABLES IN SCHEMA {_q(item, schema_name)}" if not table_name or table_name == "*"
                  else f"TABLE {_qualified(item, schema_name, table_name)}")  # fmt: skip
        statement = (f"GRANT {listed} ON {on} TO {who};" if action == "grant"
                     else f"REVOKE {listed} ON {on} FROM {who};")  # fmt: skip
        return [statement], [statement]
    if action == "member" and not mysql:
        role = str(p.get("role") or "").strip()
        if not role:
            raise UserError("choose the role")
        statement = f"GRANT {_q(item, role)} TO {who};" if p.get("add", True) else f"REVOKE {_q(item, role)} FROM {who};"
        return [statement], [statement]
    raise UserError(f"unknown change {action}")


def close_all() -> None:
    for session_id in list(_sessions):
        close_session(session_id)
    with _links_lock:
        for item in _links.values():
            item.engine.dispose()
        _links.clear()

