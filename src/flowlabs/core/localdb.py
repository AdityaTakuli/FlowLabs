"""Query tabs on your own datasets: a DuckDB session per tab, the same way databases.py keeps a
database session per tab. The project's SQL view uses one editor for both.

Each session is an in-memory DuckDB. The datasets a query names are attached as tables when it
first runs (``data`` is the project's own dataset), so temporary tables, ``SET`` and earlier
results last from one run to the next. Nothing here changes a dataset: to keep a result, save it as
a dataset.
"""

from __future__ import annotations

import contextlib
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from . import databases, datasets, sql
from .util import UserError, new_id
from .workspace import Workspace

LOCAL = "local"
_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


@dataclass
class LocalSession:
    id: str
    dataset_id: str | None
    con: Any
    attached: dict[str, str] = field(default_factory=dict)  # table name -> dataset id
    running: bool = False
    cancelled: bool = False
    in_transaction: bool = False
    last_used: float = field(default_factory=time.time)
    lock: threading.Lock = field(default_factory=threading.Lock)


sessions: dict[str, LocalSession] = {}


def owns(session_id: str) -> bool:
    return session_id in sessions


def _get(session_id: str) -> LocalSession:
    session = sessions.get(session_id)
    if session is None:
        raise databases.SessionGone("This tab's session was closed. Run the query again to start a new one.")
    session.last_used = time.time()
    return session


def _close_idle() -> None:
    now = time.time()
    for session in list(sessions.values()):
        if not session.running and now - session.last_used > databases.SESSION_IDLE_S:
            close_session(session.id)


def open_session(ws: Workspace, dataset_id: str | None) -> dict[str, Any]:
    _close_idle()
    duckdb = sql._duckdb()
    session = LocalSession(new_id("l"), dataset_id or None, duckdb.connect())
    sessions[session.id] = session
    return describe(session)


def describe(session: LocalSession) -> dict[str, Any]:
    import duckdb

    return {"session_id": session.id, "connection_id": LOCAL, "flavor": "duckdb", "server": f"DuckDB {duckdb.__version__}",
            "read_only": False, "autocommit": True, "in_transaction": session.in_transaction, "backend_id": None,
            "database": session.dataset_id, "schema": None}  # fmt: skip


def close_session(session_id: str) -> None:
    session = sessions.pop(session_id, None)
    if session is not None:
        with contextlib.suppress(Exception):
            session.con.close()


def _attach(ws: Workspace, session: LocalSession, script: str) -> None:
    """Attach the datasets the script names that are not attached yet."""
    words = {w.lower() for w in _WORD.findall(script)}
    wanted: dict[str, str] = {}
    for name, meta in sql.dataset_tables(ws).items():
        if name in words and not (session.dataset_id and name == sql.PROJECT_TABLE):
            wanted[name] = meta["id"]
    if session.dataset_id and sql.PROJECT_TABLE in words:
        wanted[sql.PROJECT_TABLE] = session.dataset_id
    for name, dataset_id in wanted.items():
        if session.attached.get(name) == dataset_id:
            continue
        exists = session.con.execute(
            "select count(*) from duckdb_tables() where table_name = ? and temporary", [name]
        ).fetchone()[0]
        if exists:  # a temporary table of that name, made in this tab, comes first
            continue
        session.con.register(name, datasets.load_frame(ws, dataset_id))
        session.attached[name] = dataset_id


def _kind(type_name: str) -> str:
    upper = type_name.upper()
    if upper == "BOOLEAN":
        return "boolean"
    if any(word in upper for word in ("INT", "DECIMAL", "DOUBLE", "FLOAT", "REAL", "NUMERIC", "HUGEINT")):
        return "number"
    if any(word in upper for word in ("DATE", "TIME")):
        return "datetime"
    return "text"


def _missing_table(ws: Workspace, session: LocalSession, message: str) -> str:
    missing = re.search(r"Table with name (\S+) does not exist", message)
    if not missing:
        return sql._tidy_message(message)
    names = (
        ", ".join(([sql.PROJECT_TABLE] if session.dataset_id else []) + sorted(sql.dataset_tables(ws))) or "none yet"
    )
    return f"There is no table {missing.group(1)}. Your tables: {names}."


def execute(ws: Workspace, session_id: str, script: str, limit: int = databases.PAGE_ROWS,
            cursor: int | None = None) -> dict[str, Any]:  # fmt: skip
    """Like databases.execute, on your datasets."""
    import duckdb

    session = _get(session_id)
    spans = databases.pick(script, cursor)
    if not spans:
        raise UserError("write a query first")
    limit = max(1, min(int(limit), databases.MAX_PAGE_ROWS))
    if not session.lock.acquire(blocking=False):
        raise UserError("A query is still running in this tab. Stop it, or wait for it.")
    results: list[dict[str, Any]] = []
    error: dict[str, Any] | None = None
    started_all = time.perf_counter()
    try:
        session.running, session.cancelled = True, False
        _attach(ws, session, " ".join(s[2] for s in spans))
        for index, (start, end, statement) in enumerate(spans):
            started = time.perf_counter()
            entry = {"statement": index, "start": start, "end": end, "sql": statement[:400]}
            try:
                word = sql.first_word(statement)
                cursor_ = session.con.execute(statement)
                description = cursor_.description
                # DuckDB answers INSERT, CREATE ... AS with a Count column and BEGIN, SET with Success
                status = (len(description or []) == 1 and description[0][0] in ("Count", "Success")
                          and word not in sql.READ_WORDS)  # fmt: skip
                if description and not status:
                    rows = cursor_.fetchmany(limit + 1)
                    names = [str(d[0]) for d in description]
                    kinds = [_kind(str(d[1])) for d in description]
                    entry |= {"columns": names, "types": kinds, "rows": [[databases.cell(v) for v in r] for r in rows[:limit]],
                              "truncated": len(rows) > limit}  # fmt: skip
                else:
                    row = cursor_.fetchone() if description else None
                    count = row[0] if row else None
                    count = count if description and description[0][0] == "Count" else None
                    entry |= {"message": databases._message(statement, {"rowcount": count}), "rowcount": count}
                if word in ("begin", "start"):
                    session.in_transaction = True
                elif word in ("commit", "rollback", "end", "abort"):
                    session.in_transaction = False
            except duckdb.Error as failure:
                cancelled = session.cancelled or isinstance(failure, duckdb.InterruptException)
                text = str(failure)
                line_in = sql._error_line(text)
                error = {"message": "Stopped." if cancelled else _missing_table(ws, session, text), "statement": index,
                         "line": script.count("\n", 0, start) + (line_in or 1), "start": start, "end": end,
                         "cancelled": cancelled}  # fmt: skip
                break
            entry["elapsed_ms"] = round((time.perf_counter() - started) * 1000)
            results.append(entry)
            if len([r for r in results if "columns" in r]) > databases.MAX_RESULTS:
                break
    finally:
        session.running = False
        session.lock.release()
    return {"results": results, "error": error, "elapsed_ms": round((time.perf_counter() - started_all) * 1000),
            "session": describe(session)}  # fmt: skip


def cancel(session_id: str) -> dict[str, Any]:
    session = _get(session_id)
    if not session.running:
        return {"cancelled": False}
    session.cancelled = True
    session.con.interrupt()
    return {"cancelled": True}


def explain(
    ws: Workspace, session_id: str, script: str, analyze: bool = False, cursor: int | None = None
) -> dict[str, Any]:
    """DuckDB's plan, as DuckDB prints it."""
    import duckdb

    session = _get(session_id)
    statements = [s[2] for s in databases.pick(script, cursor)]
    if not statements:
        raise UserError("write a query first")
    statement = statements[-1]
    if sql.first_word(statement) in ("explain", "analyze", "describe", "desc"):
        raise UserError("Write the query itself; FlowLabs adds EXPLAIN.")
    _attach(ws, session, statement)
    try:
        rows = session.con.execute(f"EXPLAIN {'ANALYZE ' if analyze else ''}{statement}").fetchall()
    except duckdb.Error as error:
        raise sql.SqlError(_missing_table(ws, session, str(error)), sql._error_line(str(error))) from error
    text = "\n\n".join(str(r[-1]) for r in rows)
    return {"flavor": "duckdb", "analyze": analyze, "raw": text, "totals": {},
            "tree": {"label": "DuckDB's plan", "detail": [], "children": []}}  # fmt: skip


def columns(ws: Workspace, dataset_id: str | None) -> dict[str, list[str]]:
    return {t["name"]: [c["name"] for c in t["columns"]] for t in sql.tables(ws, dataset_id)}


def export(ws: Workspace, dataset_id: str | None, script: str, fmt: str, name: str | None = None,
           cursor: int | None = None) -> dict[str, Any]:  # fmt: skip
    """The whole result of a query on your datasets, as a file to download."""
    if fmt not in databases.EXPORT_FORMATS:
        raise UserError("export as CSV, Excel, JSON or Parquet")
    statements = [s[2] for s in databases.pick(script, cursor)]
    if not statements:
        raise UserError("write a query first")
    statement = statements[-1]
    if sql.first_word(statement) not in sql.READ_WORDS:
        raise UserError("Export runs a query that reads, such as SELECT.")
    started = time.perf_counter()
    frame, _, _ = sql._execute(ws, statement, None, None, 0, dataset_id)
    if frame is None:
        raise UserError("the query returned no table to export")
    folder = ws.root / "exports" / "sql"
    folder.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^\w.-]+", "_", (name or "query").strip())[:60].strip("_") or "query"
    target = folder / f"{stem}-{time.strftime('%Y%m%d-%H%M%S')}.{fmt}"
    frame.columns = [str(c) for c in frame.columns]
    if fmt == "csv":
        frame.to_csv(target, index=False)
    elif fmt == "json":
        frame.to_json(target, orient="records", date_format="iso", force_ascii=False)
    elif fmt == "parquet":
        sql._plain_values(frame).to_parquet(target, index=False)
    else:
        if len(frame) > databases.EXCEL_MAX_ROWS:
            raise UserError(f"Excel holds at most {databases.EXCEL_MAX_ROWS:,} rows; export it as CSV or Parquet.")
        frame.to_excel(target, index=False, sheet_name=stem[:31] or "Result")
    return {"path": target.relative_to(ws.root).as_posix(), "name": target.name, "rows": len(frame),
            "bytes": target.stat().st_size, "elapsed_ms": round((time.perf_counter() - started) * 1000)}  # fmt: skip


def save_dataset(
    ws: Workspace, dataset_id: str | None, script: str, name: str, cursor: int | None = None
) -> dict[str, Any]:
    statements = [s[2] for s in databases.pick(script, cursor)]
    if not statements:
        raise UserError("write a query first")
    return sql.save_result(ws, statements[-1], name or "query result", None, dataset_id)


def finish_transaction(session_id: str, commit: bool) -> dict[str, Any]:
    session = _get(session_id)
    with session.lock:
        with contextlib.suppress(Exception):  # DuckDB says so if no transaction is open
            session.con.execute("COMMIT" if commit else "ROLLBACK")
        session.in_transaction = False
    return describe(session)
