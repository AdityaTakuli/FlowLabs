"""Back up a database to a .sql file, and restore one, from the Databases page.

Two ways to back up:

* **Built in** (always there): FlowLabs writes the SQL itself. Structure first (types, sequences,
  functions, tables), then the rows as INSERT statements, then what depends on them (foreign
  keys, indexes, views, triggers). PostgreSQL rows are read as PostgreSQL's own text form, so
  every type (arrays, JSON, ranges, bytea...) comes back exactly as it was.
* **pg_dump / mysqldump**, when they are installed on the engine's computer: the database's own
  tools, for the most faithful copy.

Restore runs a .sql file: one made here, a pg_dump plain-text file (``COPY ... FROM stdin`` blocks
included) or a mysqldump file (``DELIMITER``, ``/*!...*/`` lines). A pg_dump custom-format file
(``-Fc``) is handed to pg_restore when it is installed.

Both run in the background and report progress as ``db_task`` events; both can be cancelled.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import decimal
import gzip
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from . import databases, sources, sql
from .util import Cancelled, UserError, new_id
from .workspace import Workspace

Emit = Callable[[dict[str, Any]], None]
BATCH_ROWS = 500
MAX_RESTORE_BYTES = 4 * 1024**3


class Task:
    """A backup or restore running in the background."""

    def __init__(self, task_id: str, emit: Emit) -> None:
        self.id, self._emit = task_id, emit
        self.cancelled = False
        self.backend: Any = None  # (link, backend id) of the statement running now, to cancel it
        self._last = 0.0

    def progress(self, done: float, total: float, message: str, force: bool = False) -> None:
        now = time.time()
        if force or now - self._last > 0.25:
            self._last = now
            self._emit({"type": "db_task", "task_id": self.id, "stage": "progress", "done": done, "total": total,
                        "message": message})  # fmt: skip

    def finish(self, stage: str, **payload: Any) -> None:
        self._emit({"type": "db_task", "task_id": self.id, "stage": stage, **payload})

    def check(self) -> None:
        if self.cancelled:
            raise Cancelled()


_tasks: dict[str, Task] = {}


def start(work: Callable[[Task], dict[str, Any]], emit: Emit, spawn: Callable[[Callable[[], None]], None] | None) -> dict[str, Any]:
    task = Task(new_id("k"), emit)
    _tasks[task.id] = task

    def run() -> None:
        try:
            task.finish("done", result=work(task))
        except Cancelled:
            task.finish("cancelled", message="Stopped.")
        except UserError as error:
            task.finish("error", message=str(error))
        except Exception as error:  # noqa: BLE001 - shown in the dialog
            task.finish("error", message=f"{type(error).__name__}: {error}")
        finally:
            _tasks.pop(task.id, None)

    if spawn is None:
        run()
    else:
        spawn(run)
    return {"task_id": task.id}


def cancel(task_id: str) -> dict[str, Any]:
    task = _tasks.get(task_id)
    if task is None:
        return {"cancelled": False}
    task.cancelled = True
    if task.backend:  # stop the statement that is running now
        item, backend_id = task.backend
        with contextlib.suppress(Exception), item.engine.connect() as other:
            if item.flavor == "postgresql":
                other.exec_driver_sql(f"select pg_cancel_backend({int(backend_id)})")
            elif item.flavor == "mysql":
                other.exec_driver_sql(f"KILL QUERY {int(backend_id)}")
    return {"cancelled": True}


# ------------------------------------------------------------------------------------ tools


def _tool(*names: str) -> str | None:
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return None


def tools() -> dict[str, Any]:
    """The database tools installed on the engine's computer."""
    return {"pg_dump": _tool("pg_dump"), "pg_restore": _tool("pg_restore"),
            "mysqldump": _tool("mysqldump", "mariadb-dump")}  # fmt: skip


def _target(ws: Workspace, database: str, schema: str | None, extension: str = "sql") -> Path:
    folder = ws.root / "exports" / "backups"
    folder.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^\w.-]+", "_", "-".join(p for p in (database, schema) if p))[:80] or "backup"
    return folder / f"{stem}-{time.strftime('%Y%m%d-%H%M%S')}.{extension}"


def _result(ws: Workspace, path: Path, **extra: Any) -> dict[str, Any]:
    return {"path": path.relative_to(ws.root).as_posix(), "name": path.name, "bytes": path.stat().st_size, **extra}


# ----------------------------------------------------------------------------------- literals


def _pg_text(value: str | None) -> str:
    return "NULL" if value is None else "'" + value.replace("'", "''") + "'"


def _mysql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, decimal.Decimal)):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        data = bytes(value)
        return "X'" + data.hex() + "'" if data else "''"
    if isinstance(value, dt.timedelta):
        seconds = int(value.total_seconds())
        sign, seconds = ("-" if seconds < 0 else ""), abs(seconds)
        micro = value.microseconds if seconds == int(abs(value.total_seconds())) else 0
        text = f"{sign}{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"
        return f"'{text}.{micro:06d}'" if micro else f"'{text}'"
    if isinstance(value, (set, frozenset)):
        value = ",".join(sorted(str(v) for v in value))
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        value = value.isoformat(sep=" ") if isinstance(value, dt.datetime) else value.isoformat()
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False)
    text = str(value)
    escaped = (text.replace("\\", "\\\\").replace("'", "\\'").replace("\0", "\\0").replace("\n", "\\n")
               .replace("\r", "\\r").replace("\x1a", "\\Z"))  # fmt: skip
    return f"'{escaped}'"


# ------------------------------------------------------------------------- built-in backup


class _Writer:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.handle = path.open("w", encoding="utf-8", newline="\n")

    def __call__(self, *parts: str) -> None:
        for part in parts:
            self.handle.write(part)
            if not part.endswith("\n"):
                self.handle.write("\n")

    def section(self, title: str) -> None:
        self.handle.write(f"\n--\n-- {title}\n--\n\n")

    def close(self) -> None:
        self.handle.close()


def backup(ws: Workspace, task: Task, connection_id: str, database: str, schema: str | None,
           options: dict[str, Any]) -> dict[str, Any]:  # fmt: skip
    """Write a .sql backup. ``options``: tables (names, or all), structure, data, drop (DROP ...
    IF EXISTS first), definers (MySQL: keep DEFINER), method (builtin, tool)."""
    item = databases.link(ws, connection_id, database)
    schema = databases._schema_for(item, database, schema)
    if options.get("method") == "tool":
        return _backup_with_tool(ws, task, connection_id, database, schema, options)
    path = _target(ws, database, schema if item.flavor == "postgresql" else None)
    out = _Writer(path)
    try:
        out(f"-- FlowLabs backup of {database}{'.' + schema if schema and item.flavor == 'postgresql' else ''}"
            f" ({item.server}), {dt.datetime.now().isoformat(timespec='seconds')}",
            "-- Restore it from FlowLabs (Databases > Restore), or with psql / mysql.")  # fmt: skip
        if item.flavor == "postgresql":
            counts = _backup_postgres(item, task, out, schema or "public", options)
        elif item.flavor == "mysql":
            counts = _backup_mysql(item, task, out, schema or database, options)
        elif item.flavor == "sqlite":
            counts = _backup_sqlite(item, task, out, options)
        else:
            raise UserError("Backups are made for PostgreSQL, MySQL, MariaDB and SQLite.")
    except BaseException:
        out.close()
        path.unlink(missing_ok=True)
        raise
    out.close()
    task.progress(1, 1, "Done", force=True)
    return _result(ws, path, **counts)


def _chosen(found: list[str], wanted: Any) -> list[str]:
    if not wanted:
        return found
    keep = set(wanted)
    return [name for name in found if name in keep]


def _postgres_rows(item: databases.Link, live: Any, schema: str, table: str, columns: list[str]) -> Iterator[list[tuple[Any, ...]]]:
    """The table's rows as PostgreSQL text (exact for every type), in batches, through a cursor."""
    raw = live.connection.dbapi_connection
    named = raw.cursor(name=f"flowlabs_backup_{uuid.uuid4().hex[:10]}")
    q = databases._q
    selected = ", ".join(f"{q(item, c)}::text" for c in columns) or "1"
    named.execute(f"select {selected} from {q(item, schema)}.{q(item, table)}")
    while True:
        rows = named.fetchmany(BATCH_ROWS)
        if not rows:
            break
        yield rows
    named.close()


def _backup_postgres(item: databases.Link, task: Task, out: _Writer, schema: str, options: dict[str, Any]) -> dict[str, Any]:
    from sqlalchemy import MetaData, Table
    from sqlalchemy.schema import AddConstraint, CreateIndex, CreateTable, ForeignKeyConstraint

    structure, data, drop = options.get("structure", True), options.get("data", True), bool(options.get("drop"))
    q = databases._q
    qs = q(item, schema)
    dialect = item.engine.dialect
    rows_written = 0
    with item.engine.connect() as live:
        live = live.execution_options(isolation_level="REPEATABLE READ")  # one consistent snapshot
        live.exec_driver_sql("SET TRANSACTION READ ONLY")
        rows = databases._rows
        tables = _chosen([r[0] for r in rows(live, """
            select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = :s and c.relkind in ('r', 'p') and not c.relispartition order by c.relname""",
                                               {"s": schema})], options.get("tables"))  # fmt: skip
        views = [] if options.get("tables") else rows(live, """
            select c.relname, c.relkind::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = :s and c.relkind in ('v', 'm') order by c.oid""", {"s": schema})
        out("SET statement_timeout = 0;", "SET client_encoding = 'UTF8';", "SET standard_conforming_strings = on;",
            "SET check_function_bodies = false;", "SET client_min_messages = warning;")  # fmt: skip
        if schema != "public":
            out(f"CREATE SCHEMA IF NOT EXISTS {qs};")
        out(f"SET search_path = {qs}, public;")
        if structure and drop:
            out.section("Drop what is there")
            for name, kind in reversed(views):
                out(f"DROP {'MATERIALIZED VIEW' if kind == 'm' else 'VIEW'} IF EXISTS {qs}.{q(item, name)} CASCADE;")
            for name in tables:
                out(f"DROP TABLE IF EXISTS {qs}.{q(item, name)} CASCADE;")
        functions: list[tuple[Any, ...]] = []
        if structure:
            enums = [] if options.get("tables") else rows(live, """
                select t.typname, array_agg(e.enumlabel order by e.enumsortorder)
                from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
                where n.nspname = :s group by t.typname order by t.typname""", {"s": schema})
            if enums:
                out.section("Types")
                for name, labels in enums:
                    if drop:
                        out(f"DROP TYPE IF EXISTS {qs}.{q(item, name)} CASCADE;")
                    out(f"CREATE TYPE {qs}.{q(item, name)} AS ENUM ({', '.join(_pg_text(label) for label in labels)});")
            sequences = rows(live, """
                select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = :s and c.relkind = 'S'
                  and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'i')
                order by c.relname""", {"s": schema})
            if sequences:
                out.section("Sequences")
                for (name,) in sequences:
                    if drop:
                        out(f"DROP SEQUENCE IF EXISTS {qs}.{q(item, name)} CASCADE;")
                    out(_sequence_ddl(item, live, schema, name))
            functions = [] if options.get("tables") else rows(live, """
                select p.proname, pg_get_functiondef(p.oid), p.prokind::text,
                       pg_get_function_identity_arguments(p.oid)
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
                where n.nspname = :s and p.prokind in ('f', 'p') and d.objid is null order by p.oid""",
                {"s": schema})  # fmt: skip
            if functions:
                out.section("Functions and procedures")
                for name, definition, kind, arguments in functions:
                    if drop:
                        word = "PROCEDURE" if kind == "p" else "FUNCTION"
                        out(f"DROP {word} IF EXISTS {qs}.{q(item, name)}({arguments}) CASCADE;")
                    out(definition.rstrip() + ";")
        metadata = MetaData()
        reflected: dict[str, Any] = {}
        for index, name in enumerate(tables):
            task.check()
            task.progress(index, len(tables) * 2, f"Reading {name}")
            reflected[name] = Table(name, metadata, schema=schema, autoload_with=live)
        if structure:
            out.section("Tables")
            for name in tables:
                table = reflected[name]
                out(str(CreateTable(table, include_foreign_key_constraints=[]).compile(dialect=dialect)).strip() + ";")
                if table.comment:
                    out(f"COMMENT ON TABLE {qs}.{q(item, name)} IS {_pg_text(table.comment)};")
                for column in table.columns:
                    if column.comment:
                        out(f"COMMENT ON COLUMN {qs}.{q(item, name)}.{q(item, column.name)} IS {_pg_text(column.comment)};")
        if data:
            out.section("Rows")
            for index, name in enumerate(tables):
                task.check()
                task.progress(len(tables) + index, len(tables) * 2, f"Copying the rows of {name}")
                info = rows(live, """
                    select a.attname, a.attidentity::text, a.attgenerated::text from pg_attribute a
                    where a.attrelid = (:t)::regclass and a.attnum > 0 and not a.attisdropped
                    order by a.attnum""", {"t": f"{qs}.{q(item, name)}"})  # fmt: skip
                columns = [c for c, _, generated in info if not generated]
                overriding = " OVERRIDING SYSTEM VALUE" if any(identity == "a" for _, identity, _ in info) else ""
                head = f"INSERT INTO {qs}.{q(item, name)} ({', '.join(q(item, c) for c in columns)}){overriding} VALUES"
                for batch in _postgres_rows(item, live, schema, name, columns):
                    task.check()
                    values = ",\n  ".join("(" + ", ".join(_pg_text(v) for v in row) + ")" for row in batch)
                    out(f"{head}\n  {values};")
                    rows_written += len(batch)
                serials = rows(live, """
                    select a.attname from pg_attribute a
                    where a.attrelid = (:t)::regclass and a.attnum > 0 and not a.attisdropped
                      and pg_get_serial_sequence(:name, a.attname) is not null""",
                               {"t": f"{qs}.{q(item, name)}", "name": f"{qs}.{q(item, name)}"})
                for (column,) in serials:
                    target = _pg_text(f"{qs}.{q(item, name)}")
                    out(f"SELECT setval(pg_get_serial_sequence({target}, {_pg_text(column)}), "
                        f"coalesce(max({q(item, column)}), 1), max({q(item, column)}) IS NOT NULL) FROM {qs}.{q(item, name)};")  # fmt: skip
            if not options.get("tables"):
                for name, last, called in rows(live, """
                        select s.sequencename, s.last_value, s.last_value is not null from pg_sequences s
                        where s.schemaname = :s and s.last_value is not null""", {"s": schema}):
                    out(f"SELECT setval({_pg_text(f'{qs}.{q(item, name)}')}, {int(last)}, {'true' if called else 'false'});")
        if structure:
            keys = [c for name in tables for c in reflected[name].constraints if isinstance(c, ForeignKeyConstraint)
                    and c.referred_table.name in reflected]  # fmt: skip
            indexes = [ix for name in tables for ix in sorted(reflected[name].indexes, key=lambda i: i.name or "")]
            if keys or indexes:
                out.section("Foreign keys and indexes")
            for key in keys:
                out(str(AddConstraint(key).compile(dialect=dialect)).strip() + ";")
            for ix in indexes:
                out(str(CreateIndex(ix).compile(dialect=dialect)).strip() + ";")
            if views:
                out.section("Views")
                for name, _ in views:
                    out(databases.ddl_on(item, live, schema, name, "view"))
            triggers = [t for t in rows(live, """
                select pg_get_triggerdef(t.oid, true), c.relname from pg_trigger t
                join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = :s and not t.tgisinternal order by t.oid""", {"s": schema}) if t[1] in reflected]
            if triggers:
                out.section("Triggers")
                for definition, _ in triggers:
                    out(definition + ";")
        live.rollback()
    return {"tables": len(tables), "rows": rows_written, "views": len(views), "functions": len(functions)}


def _sequence_ddl(item: databases.Link, live: Any, schema: str, name: str) -> str:
    found = databases._rows(live, """select data_type::text, start_value, min_value, max_value, increment_by, cycle,
                                            cache_size from pg_sequences where schemaname = :s and sequencename = :n""",
                            {"s": schema, "n": name})  # fmt: skip
    kind, start_value, low, high, step, cycle, cache = found[0]
    return (f"CREATE SEQUENCE {databases._qualified(item, schema, name)} AS {kind} INCREMENT BY {step} MINVALUE {low} "
            f"MAXVALUE {high} START WITH {start_value} CACHE {cache}{' CYCLE' if cycle else ''};")  # fmt: skip


_DEFINER = re.compile(r"\s*DEFINER\s*=\s*(`[^`]*`|'[^']*'|\S+)@(`[^`]*`|'[^']*'|\S+)", re.I)


def _backup_mysql(item: databases.Link, task: Task, out: _Writer, schema: str, options: dict[str, Any]) -> dict[str, Any]:
    structure, data, drop = options.get("structure", True), options.get("data", True), bool(options.get("drop"))
    keep_definer = bool(options.get("definers"))
    q = databases._q
    qs = q(item, schema)
    rows_written = 0

    def definer(text: str) -> str:
        return text if keep_definer else _DEFINER.sub("", text, count=1)

    with item.engine.connect() as live:
        live.exec_driver_sql("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        live.exec_driver_sql("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY")
        rows = databases._rows
        found = rows(live, "select TABLE_NAME, TABLE_TYPE from information_schema.TABLES where TABLE_SCHEMA = :s "
                           "order by TABLE_NAME", {"s": schema})  # fmt: skip
        tables = _chosen([n for n, kind in found if kind != "VIEW"], options.get("tables"))
        views = [] if options.get("tables") else [n for n, kind in found if kind == "VIEW"]
        out("SET NAMES utf8mb4;", "SET FOREIGN_KEY_CHECKS = 0;", "SET UNIQUE_CHECKS = 0;",
            "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';", f"CREATE DATABASE IF NOT EXISTS {qs};", f"USE {qs};")  # fmt: skip
        if structure and drop:
            out.section("Drop what is there")
            for name in views:
                out(f"DROP VIEW IF EXISTS {q(item, name)};")
            for name in tables:
                out(f"DROP TABLE IF EXISTS {q(item, name)};")
        if structure:
            out.section("Tables")
            for name in tables:
                create = live.exec_driver_sql(f"SHOW CREATE TABLE {qs}.{q(item, name)}").fetchone()[1]
                out(create + ";")
        if data:
            out.section("Rows")
            for index, name in enumerate(tables):
                task.check()
                task.progress(index, max(1, len(tables)), f"Copying the rows of {name}")
                columns = [r[0] for r in rows(live, """
                    select COLUMN_NAME from information_schema.COLUMNS where TABLE_SCHEMA = :s and TABLE_NAME = :t
                      and EXTRA not like '%GENERATED%' order by ORDINAL_POSITION""", {"s": schema, "t": name})]
                head = f"INSERT INTO {q(item, name)} ({', '.join(q(item, c) for c in columns)}) VALUES"
                result = live.execution_options(stream_results=True).exec_driver_sql(
                    f"select {', '.join(q(item, c) for c in columns)} from {qs}.{q(item, name)}")
                while True:
                    task.check()
                    batch = result.fetchmany(BATCH_ROWS)
                    if not batch:
                        break
                    values = ",\n  ".join("(" + ", ".join(_mysql_literal(v) for v in row) + ")" for row in batch)
                    out(f"{head}\n  {values};")
                    rows_written += len(batch)
                result.close()
        routines: list[tuple[Any, ...]] = []
        if structure:
            if views:
                out.section("Views")
                texts = {name: definer(live.exec_driver_sql(f"SHOW CREATE VIEW {qs}.{q(item, name)}").fetchone()[1])
                         for name in views}  # fmt: skip
                for name in _view_order(texts):
                    out(texts[name] + ";")
            routines = [] if options.get("tables") else rows(live, """
                select ROUTINE_NAME, ROUTINE_TYPE from information_schema.ROUTINES where ROUTINE_SCHEMA = :s
                order by ROUTINE_NAME""", {"s": schema})  # fmt: skip
            triggers = rows(live, "select TRIGGER_NAME, EVENT_OBJECT_TABLE from information_schema.TRIGGERS "
                                  "where TRIGGER_SCHEMA = :s order by ACTION_ORDER", {"s": schema})  # fmt: skip
            triggers = [t for t in triggers if t[1] in tables]
            if routines or triggers:
                out.section("Procedures, functions and triggers")
                out("DELIMITER ;;")
                for name, kind in routines:
                    if drop:
                        out(f"DROP {kind} IF EXISTS {q(item, name)};;")
                    text = live.exec_driver_sql(f"SHOW CREATE {kind} {qs}.{q(item, name)}").fetchone()[2]
                    if text:
                        out(definer(text) + ";;")
                for name, _ in triggers:
                    text = live.exec_driver_sql(f"SHOW CREATE TRIGGER {qs}.{q(item, name)}").fetchone()[2]
                    out(definer(text) + ";;")
                out("DELIMITER ;")
        out("SET FOREIGN_KEY_CHECKS = 1;", "SET UNIQUE_CHECKS = 1;")
        live.rollback()
        live.invalidate()  # its session settings (isolation level) stay out of the pool
    return {"tables": len(tables), "rows": rows_written, "views": len(views), "functions": len(routines)}


def _view_order(texts: dict[str, str]) -> list[str]:
    """Views that use other views come after them."""
    names = list(texts)
    uses = {n: {m for m in names if m != n and re.search(rf"[`.\s]{re.escape(m)}[`\s]", texts[n])} for n in names}
    ordered: list[str] = []
    while len(ordered) < len(names):
        ready = [n for n in names if n not in ordered and uses[n] <= set(ordered)]
        if not ready:  # a cycle, or a false match: keep the rest in name order
            ready = [n for n in names if n not in ordered]
        ordered.extend(ready)
    return ordered


def _backup_sqlite(item: databases.Link, task: Task, out: _Writer, options: dict[str, Any]) -> dict[str, Any]:
    with item.engine.connect() as live:
        raw = live.connection.dbapi_connection
        count = 0
        for line in raw.iterdump():
            task.check()
            if line in ("BEGIN TRANSACTION;", "COMMIT;"):
                continue
            if not options.get("data", True) and line.startswith("INSERT INTO"):
                continue
            out(line)
            count += line.startswith("INSERT INTO")
    return {"rows": count}


def _backup_with_tool(ws: Workspace, task: Task, connection_id: str, database: str, schema: str | None,
                      options: dict[str, Any]) -> dict[str, Any]:  # fmt: skip
    connection, source = databases._connection(ws, connection_id)
    values = {**connection["values"], "database": database}
    secrets = sql._secrets(ws, connection)
    reached = sources.connect_values(source, values, secrets)
    environment = dict(os.environ)
    path = _target(ws, database, schema if source.id == "postgresql" else None)
    extra_file: str | None = None
    if source.id == "postgresql":
        program = _tool("pg_dump")
        if not program:
            raise UserError("pg_dump is not installed on the engine's computer. Use the built-in backup.")
        environment.update({"PGPASSWORD": secrets.get("password", ""), "PGSSLMODE": str(values.get("sslmode") or "prefer"),
                            "PGCONNECT_TIMEOUT": "10"})  # fmt: skip
        if values.get("sslrootcert"):
            environment["PGSSLROOTCERT"] = str(values["sslrootcert"])
        command = [program, "--host", str(reached["host"]), "--port", str(reached.get("port") or 5432),
                   "--username", str(values.get("user") or ""), "--dbname", database, "--file", str(path),
                   "--no-owner", "--no-privileges", "--encoding", "UTF8"]  # fmt: skip
        if schema:
            command += ["--schema", schema]
        for name in options.get("tables") or []:
            command += ["--table", f"{schema or 'public'}.{name}"]
        if not options.get("data", True):
            command.append("--schema-only")
        if not options.get("structure", True):
            command.append("--data-only")
        if options.get("drop"):
            command += ["--clean", "--if-exists"]
    else:
        program = _tool("mysqldump", "mariadb-dump")
        if not program:
            raise UserError("mysqldump is not installed on the engine's computer. Use the built-in backup.")
        handle, extra_file = tempfile.mkstemp(suffix=".cnf")
        os.chmod(extra_file, 0o600)
        with os.fdopen(handle, "w") as cnf:
            cnf.write("[client]\npassword=" + secrets.get("password", "").replace("\\", "\\\\").replace('"', '\\"') + "\n")
        command = [program, f"--defaults-extra-file={extra_file}", "--host", str(reached["host"]),
                   "--port", str(reached.get("port") or 3306), "--user", str(values.get("user") or ""),
                   "--protocol=TCP", "--single-transaction", "--routines", "--triggers", "--hex-blob",
                   "--default-character-set=utf8mb4", f"--result-file={path}"]  # fmt: skip
        if values.get("ssl_mode") in ("require", "verify_ca", "verify_identity"):
            command.append("--ssl-mode=" + {"require": "REQUIRED", "verify_ca": "VERIFY_CA",
                                            "verify_identity": "VERIFY_IDENTITY"}[values["ssl_mode"]])  # fmt: skip
            if values.get("ssl_ca"):
                command.append(f"--ssl-ca={values['ssl_ca']}")
        if not options.get("data", True):
            command.append("--no-data")
        if not options.get("structure", True):
            command.append("--no-create-info")
        if not options.get("drop"):
            command.append("--skip-add-drop-table")
        command += ["--databases", database] if not options.get("tables") else [database, *options["tables"]]
    task.progress(0, 1, f"Running {Path(program).name}", force=True)
    lines: list[str] = []
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=environment,  # noqa: S603
                                   encoding="utf-8", errors="replace")  # fmt: skip
        assert process.stdout is not None
        reader = threading.Thread(target=lambda: lines.extend(process.stdout), daemon=True)  # type: ignore[arg-type]
        reader.start()
        while process.poll() is None:
            if task.cancelled:
                process.kill()
                raise Cancelled()
            size = path.stat().st_size if path.exists() else 0
            task.progress(0, 1, f"{Path(program).name}: {size / 1024 / 1024:.1f} MB written")
            time.sleep(0.3)
        reader.join(2)
        if process.returncode != 0:
            path.unlink(missing_ok=True)
            message = " ".join(line.strip() for line in lines if line.strip())[-600:]
            raise UserError(f"{Path(program).name} failed: {message or f'exit code {process.returncode}'}")
    finally:
        if extra_file:
            Path(extra_file).unlink(missing_ok=True)
    return _result(ws, path, tool=Path(program).name, notes=[line.strip() for line in lines if line.strip()][-5:])


# ----------------------------------------------------------------------------------- restore

_COPY = re.compile(r"^\s*COPY\s+.+\s+FROM\s+stdin\b.*;\s*$", re.I)


def _read_text(path: Path) -> str:
    if path.stat().st_size > MAX_RESTORE_BYTES:
        raise UserError("The file is larger than 4 GB. Restore it with psql or the mysql client.")
    with path.open("rb") as handle:
        head = handle.read(5)
    if head[:2] == b"\x1f\x8b":
        with gzip.open(path, "rt", encoding="utf-8", errors="replace") as handle:
            return handle.read()
    return path.read_text(encoding="utf-8", errors="replace")


def _pieces(text: str, flavor: str) -> Iterator[tuple[str, Any, int]]:
    """The file as runnable pieces: ("script", sql, line) and, in pg_dump files, ("copy", (statement,
    data), line) and ("skip", meta-command, line)."""
    if flavor != "postgresql":
        yield ("script", text, 1)
        return
    lines = text.split("\n")
    chunk: list[str] = []
    start = 1
    index = 0
    while index < len(lines):
        line = lines[index]
        if _COPY.match(line) and not chunk_open(chunk):
            if chunk:
                yield ("script", "\n".join(chunk), start)
            copy_line = index + 1
            data: list[str] = []
            index += 1
            while index < len(lines) and lines[index] != "\\.":
                data.append(lines[index])
                index += 1
            yield ("copy", (line.strip().rstrip(";"), "\n".join(data) + ("\n" if data else "")), copy_line)
            index += 1
            chunk, start = [], index + 1
            continue
        if line.startswith("\\") and not chunk_open(chunk):
            if chunk:
                yield ("script", "\n".join(chunk), start)
            yield ("skip", line.strip(), index + 1)
            index += 1
            chunk, start = [], index + 1
            continue
        chunk.append(line)
        index += 1
    if chunk:
        yield ("script", "\n".join(chunk), start)


def chunk_open(chunk: list[str]) -> bool:
    """Whether the text so far ends inside a quote or a dollar-quoted body (a COPY line there is text)."""
    if not chunk:
        return False
    text = "\n".join(chunk)
    spans = sql.statement_spans(text + "\n;")
    return bool(spans) and spans[-1][1] > len(text)


def restore(ws: Workspace, task: Task, connection_id: str, database: str, path: str, options: dict[str, Any]) -> dict[str, Any]:
    """Run a .sql file in the database. ``options``: one_transaction (PostgreSQL), stop_on_error."""
    item = databases.link(ws, connection_id, database)
    databases._need_changes(item)
    source = Path(path)
    if not source.is_file():
        raise UserError("the file to restore was not found; choose it again")
    with source.open("rb") as handle:
        if handle.read(5) == b"PGDMP":
            return _restore_with_tool(ws, task, connection_id, database, source, options)
    text = _read_text(source)
    whole = bool(options.get("one_transaction")) and item.flavor == "postgresql"
    stop = bool(options.get("stop_on_error", True))
    errors: list[dict[str, Any]] = []
    skipped: list[str] = []
    done_statements = 0
    total = max(1, len(text))
    position = 0
    with item.engine.connect() as live:
        live = live.execution_options(isolation_level="AUTOCOMMIT", no_parameters=True)
        backend = None
        with contextlib.suppress(Exception):
            backend = live.exec_driver_sql("select pg_backend_pid()" if item.flavor == "postgresql"
                                           else "select connection_id()").scalar()  # fmt: skip
        task.backend = (item, backend) if backend else None
        if whole:
            live.exec_driver_sql("BEGIN")
        try:
            for kind, piece, first_line in _pieces(text, item.flavor):
                if kind == "skip":
                    skipped.append(piece)
                    continue
                if kind == "copy":
                    task.check()
                    statement, data = piece
                    try:
                        raw = live.connection.dbapi_connection
                        with raw.cursor() as cursor, cursor.copy(statement) as copy:
                            copy.write(data.encode("utf-8"))
                        done_statements += 1
                    except Exception as error:  # noqa: BLE001
                        errors.append({"line": first_line, "sql": statement[:200], "message": _message(error)})
                        if stop or whole:
                            break
                    position += len(data)
                    task.progress(position, total, f"{done_statements:,} statements run")
                    continue
                failed = False
                for start, _, statement in sql.statement_spans(piece, item.flavor == "mysql"):
                    task.check()
                    line = first_line + piece.count("\n", 0, start)
                    try:
                        result = live.exec_driver_sql(statement)
                        result.close()
                        done_statements += 1
                    except Exception as error:  # noqa: BLE001
                        if task.cancelled:
                            raise Cancelled() from error
                        errors.append({"line": line, "sql": statement[:200], "message": _message(error)})
                        if stop or whole:
                            failed = True
                            break
                    position = min(total, position + len(statement))
                    task.progress(position, total, f"{done_statements:,} statements run")
                if failed:
                    break
                if len(errors) > 200:
                    break
            if whole:
                live.exec_driver_sql("ROLLBACK" if errors else "COMMIT")
        except BaseException:
            if whole:
                with contextlib.suppress(Exception):
                    live.exec_driver_sql("ROLLBACK")
            raise
        finally:
            # a dump leaves LOCK TABLES, SET FOREIGN_KEY_CHECKS = 0 and the like on its connection:
            # throw the connection away rather than give it back to the pool
            task.backend = None
            with contextlib.suppress(Exception):
                live.invalidate()
    task.progress(1, 1, "Done", force=True)
    rolled_back = whole and bool(errors)
    return {"statements": done_statements, "errors": errors[:50], "error_count": len(errors), "skipped": skipped[:20],
            "rolled_back": rolled_back, "stopped": bool(errors) and (stop or whole)}  # fmt: skip


def _message(error: Exception) -> str:
    return sql._friendly_connection_error(error)


def _restore_with_tool(ws: Workspace, task: Task, connection_id: str, database: str, source: Path,
                       options: dict[str, Any]) -> dict[str, Any]:  # fmt: skip
    program = _tool("pg_restore")
    if not program:
        raise UserError("This is a pg_dump custom-format file, which needs pg_restore. Install the PostgreSQL client "
                        "tools, or make a plain-text dump (pg_dump without -Fc).")  # fmt: skip
    connection, src = databases._connection(ws, connection_id)
    values = {**connection["values"], "database": database}
    secrets = sql._secrets(ws, connection)
    reached = sources.connect_values(src, values, secrets)
    environment = {**os.environ, "PGPASSWORD": secrets.get("password", ""),
                   "PGSSLMODE": str(values.get("sslmode") or "prefer")}  # fmt: skip
    command = [program, "--host", str(reached["host"]), "--port", str(reached.get("port") or 5432),
               "--username", str(values.get("user") or ""), "--dbname", database, "--no-owner", "--no-privileges",
               str(source)]  # fmt: skip
    if options.get("one_transaction"):
        command.insert(1, "--single-transaction")
    if options.get("stop_on_error", True):
        command.insert(1, "--exit-on-error")
    task.progress(0, 1, "Running pg_restore", force=True)
    process = subprocess.run(command, capture_output=True, text=True, env=environment, timeout=24 * 3600)  # noqa: S603
    lines = [line for line in (process.stderr or "").splitlines() if line.strip()]
    if process.returncode != 0 and options.get("stop_on_error", True):
        raise UserError("pg_restore failed: " + " ".join(lines)[-600:])
    return {"statements": None, "errors": [{"line": None, "sql": "", "message": line} for line in lines[:50]],
            "error_count": len(lines), "skipped": [], "rolled_back": False, "tool": "pg_restore",
            "stopped": process.returncode != 0}  # fmt: skip


def stored_upload(ws: Workspace, path: str) -> Path:
    """A file uploaded for restoring, which must be inside the workspace's tmp folder."""
    found = Path(path).resolve()
    if ws.tmp.resolve() not in found.parents:
        raise UserError("restore a file you uploaded")
    return found
