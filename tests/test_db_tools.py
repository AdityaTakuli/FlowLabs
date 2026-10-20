"""Backup and restore, the table designer and the ER diagram (core/backup.py, core/design.py).

SQLite always; PostgreSQL and MySQL when FLOWLABS_TEST_PG_ADMIN / FLOWLABS_TEST_MYSQL_ADMIN hold a
connection (see test_databases.py). On a server the backups are restored into a new database and
compared, and pg_dump / mysqldump files are restored too when those tools are installed.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
from pathlib import Path

import pytest

from flowlabs.core import backup, databases, sql
from flowlabs.core.rpc import Engine


@pytest.fixture
def events() -> list:
    return []


@pytest.fixture
def engine(ws, events) -> Engine:
    return Engine(ws.root, emit=events.append)  # no spawn: tasks run before the call returns


def finished(events: list, task: dict) -> dict:
    return next(e for e in reversed(events) if e.get("task_id") == task["task_id"] and e["stage"] != "progress")


def uploaded(ws, relative: str, text: str | None = None) -> str:
    source = ws.root / relative
    target = ws.tmp / "uploads" / "test" / source.name
    target.parent.mkdir(parents=True, exist_ok=True)
    if text is None:
        shutil.copy(source, target)
    else:
        target.write_text(text)
    return str(target)


def test_mysql_strings_and_executable_comments_split_like_mysql():
    script = "insert into t values ('it\\'s; here', 'c:\\\\');\n/*!40101 SET NAMES utf8mb4 */;\nselect 1"
    assert len(sql.split_statements(script, backslash=True)) == 3
    assert sql.split_statements("select 'c:\\'; select 2") == ["select 'c:\\'", "select 2"]  # standard SQL
    assert sql.split_statements("select E'it\\'s; ok'; select 3") == ["select E'it\\'s; ok'", "select 3"]


def test_pg_dump_pieces():
    text = "SET x = 1;\n\\restrict abc\nCOPY public.t (a, b) FROM stdin;\n1\tx\n2\t\\N\n\\.\nselect 'COPY a FROM stdin;';\n"
    pieces = list(backup._pieces(text, "postgresql"))
    assert [p[0] for p in pieces] == ["script", "skip", "copy", "script"]
    assert pieces[2][1] == ("COPY public.t (a, b) FROM stdin", "1\tx\n2\t\\N\n")


def test_sqlite_backup_and_restore(engine, events, ws, tmp_path: Path):
    path = tmp_path / "a.sqlite"
    with sqlite3.connect(path) as db:
        db.executescript("create table t (id integer primary key, name text); insert into t values (1, 'it''s'), (2, null);")
    source = engine.call("sql.connection_save", {"connection": {"kind": "sqlite", "database": str(path), "allow_changes": True}})
    task = engine.call("db.backup", {"connection_id": source["id"], "database": "main", "options": {}})
    done = finished(events, task)
    assert done["stage"] == "done" and done["result"]["rows"] == 2
    copy = tmp_path / "b.sqlite"
    sqlite3.connect(copy).close()
    target = engine.call("sql.connection_save", {"connection": {"kind": "sqlite", "database": str(copy), "allow_changes": True}})
    task = engine.call("db.restore", {"connection_id": target["id"], "database": "main",
                                      "path": uploaded(ws, done["result"]["path"]), "options": {}})  # fmt: skip
    assert finished(events, task)["result"]["error_count"] == 0
    with sqlite3.connect(copy) as db:
        assert db.execute("select * from t order by id").fetchall() == [(1, "it's"), (2, None)]
    assert "restore a file you uploaded" in engine.safe_call("db.restore", {"connection_id": target["id"], "database": "main",
                                                                            "path": str(path)})["error"]["message"]  # fmt: skip
    databases.forget(source["id"])
    databases.forget(target["id"])


def test_restore_stops_or_goes_on(engine, events, ws, tmp_path: Path):
    path = tmp_path / "c.sqlite"
    sqlite3.connect(path).close()
    target = engine.call("sql.connection_save", {"connection": {"kind": "sqlite", "database": str(path), "allow_changes": True}})
    script = "create table a (x int);\ninsert into nope values (1);\ncreate table b (x int);\n"
    file = uploaded(ws, "x.sql", script)
    stopped = finished(events, engine.call("db.restore", {"connection_id": target["id"], "database": "main", "path": file,
                                                          "options": {"stop_on_error": True}}))["result"]  # fmt: skip
    assert stopped["stopped"] and stopped["errors"][0]["line"] == 2
    with sqlite3.connect(path) as db:
        assert [r[0] for r in db.execute("select name from sqlite_master")] == ["a"]
    on = finished(events, engine.call("db.restore", {"connection_id": target["id"], "database": "main", "path": file,
                                                     "options": {"stop_on_error": False}}))["result"]  # fmt: skip
    assert on["error_count"] == 2 and not on["stopped"]  # table a exists now, and nope still does not
    databases.forget(target["id"])


def test_design_a_sqlite_table(engine, tmp_path: Path):
    path = tmp_path / "d.sqlite"
    sqlite3.connect(path).close()
    cid = engine.call("sql.connection_save", {"connection": {"kind": "sqlite", "database": str(path), "allow_changes": True}})["id"]
    where = {"connection_id": cid, "database": "main"}
    people = {"name": "people", "columns": [{"was": None, "name": "id", "type": "INTEGER", "nullable": False, "primary": True, "auto": True},
                                            {"was": None, "name": "name", "type": "TEXT", "nullable": False}],
              "indexes": [{"was": None, "name": "people_name", "columns": ["name"], "unique": True}], "foreign_keys": [], "checks": []}  # fmt: skip
    assert engine.call("db.design_apply", {**where, "original": None, "design": people})["done"] == 2
    design = engine.call("db.design", {**where, "name": "people"})
    assert engine.call("db.design_sql", {**where, "original": "people", "design": design})["sql"] == []
    design["name"] = "persons"
    design["columns"][1]["name"] = "full_name"
    design["indexes"][0]["columns"] = ["full_name"]  # the form renames it everywhere
    design["columns"].append({"was": None, "name": "city", "type": "TEXT", "nullable": True})
    planned = engine.call("db.design_sql", {**where, "original": "people", "design": design})["sql"]
    assert planned[0].startswith("ALTER TABLE people RENAME TO persons")
    engine.call("db.design_apply", {**where, "original": "people", "design": design})
    after = engine.call("db.design", {**where, "name": "persons"})
    assert [c["name"] for c in after["columns"]] == ["id", "full_name", "city"]
    after["columns"][1]["type"] = "BLOB"
    assert "SQLite cannot change" in engine.safe_call("db.design_sql", {**where, "original": "persons", "design": after})["error"]["message"]
    blank = {**people, "columns": [{"was": None, "name": "", "type": "TEXT"}]}
    assert "every column needs a name" in engine.safe_call("db.design_sql", {**where, "original": None, "design": blank})["error"]["message"]
    diagram = engine.call("db.diagram", where)
    assert [t["name"] for t in diagram["tables"]] == ["persons"]
    databases.forget(cid)


@pytest.mark.parametrize("variable", ["FLOWLABS_TEST_PG_ADMIN", "FLOWLABS_TEST_MYSQL_ADMIN"])
def test_servers(engine, events, ws, variable):
    given = os.environ.get(variable)
    if not given:
        pytest.skip(f"set {variable} to test against a real server")
    cid = engine.call("sql.connection_save", {"connection": {**json.loads(given), "allow_changes": True}})["id"]
    overview = engine.call("db.overview", {"connection_id": cid})
    postgres = overview["flavor"] == "postgresql"
    home = overview["default"]
    session = engine.call("db.session_open", {"connection_id": cid, "database": home})["session_id"]
    source = "fl_src"
    if postgres:
        setup = (f"drop schema if exists {source} cascade; create schema {source}; set search_path to {source};"
                 "create table people (id int generated always as identity primary key, name text, tags text[], "
                 "meta jsonb, photo bytea);"
                 "insert into people (name, tags, meta, photo) values ('it''s', '{a,\"b c\"}', '{\"k\": 1}', '\\x00ff'),"
                 " (E'tab\\there', null, null, null);"
                 "create view v as select name from people; set search_path to public")  # fmt: skip
        check = f"select string_agg(name || coalesce(array_to_string(tags, '|'), '-') || coalesce(meta::text, '-') || coalesce(encode(photo, 'hex'), '-'), ';' order by id), (select count(*) from {source}.v) from {source}.people"
    else:
        setup = (f"drop database if exists {source}; create database {source}; use {source};"
                 "create table people (id int auto_increment primary key, name varchar(50), meta json, photo blob);"
                 "insert into people (name, meta, photo) values ('it\\'s \\\\ here', '{\"k\": \"a\\\\\\\\b\"}', x'00ff'), ('tab\\there', null, null);"
                 "create view v as select name from people;\n"
                 "DELIMITER $$\ncreate trigger people_t before insert on people for each row begin set new.name = coalesce(new.name, 'none'); end$$\nDELIMITER ;")  # fmt: skip
        check = f"select group_concat(concat_ws('|', name, coalesce(meta, '-'), hex(photo)) order by id separator ';'), (select count(*) from {source}.v) from {source}.people"
    assert engine.call("db.execute", {"session_id": session, "sql": setup})["error"] is None
    before = engine.call("db.execute", {"session_id": session, "sql": check})["results"][-1]["rows"]
    tools = engine.call("db.backup_tools")
    methods = ["builtin"] + (["tool"] if tools["pg_dump" if postgres else "mysqldump"] else [])
    for method in methods:
        database = home if postgres else source
        task = engine.call("db.backup", {"connection_id": cid, "database": database, "schema": source if postgres else None,
                                         "options": {"method": method, "drop": True}})  # fmt: skip
        done = finished(events, task)
        assert done["stage"] == "done", done
        text = (ws.root / done["result"]["path"]).read_text()
        copy = f"fl_copy_{method}"
        if postgres:
            engine.call("db.execute", {"session_id": session, "sql": f"drop database if exists {copy}; create database {copy}"})
            target_db = copy
        else:
            text = text.replace(f"`{source}`", copy).replace(f"USE {source};", f"USE {copy};")
            engine.call("db.execute", {"session_id": session, "sql": f"drop database if exists {copy}; create database {copy}"})
            target_db = copy
        task = engine.call("db.restore", {"connection_id": cid, "database": target_db, "path": uploaded(ws, f"r-{method}.sql", text),
                                          "options": {"one_transaction": True, "stop_on_error": True}})  # fmt: skip
        assert finished(events, task)["result"]["error_count"] == 0
        reader = engine.call("db.session_open", {"connection_id": cid, "database": target_db})["session_id"]
        after = engine.call("db.execute", {"session_id": reader, "sql": check.replace(f"{source}.", f"{copy}." if not postgres else f"{source}.")})
        assert after["results"][-1]["rows"] == before, method
        engine.call("db.session_close", {"session_id": reader})
    # the designer, on the server
    where = {"connection_id": cid, "database": home if postgres else source, "schema": source if postgres else None}
    design = engine.call("db.design", {**where, "name": "people"})
    assert engine.call("db.design_sql", {**where, "original": "people", "design": design})["sql"] == []
    design["columns"].append({"was": None, "name": "city", "type": "varchar(40)", "nullable": True, "default": "'Pune'"})
    design["indexes"].append({"was": None, "name": "people_city", "columns": ["city"], "unique": False})
    design["checks"].append({"was": None, "name": "people_city_ok", "sql": "city <> ''"})
    engine.call("db.design_apply", {**where, "original": "people", "design": design})
    again = engine.call("db.design", {**where, "name": "people"})
    assert "city" in [c["name"] for c in again["columns"]] and "people_city" in [i["name"] for i in again["indexes"]]
    assert engine.call("db.design_sql", {**where, "original": "people", "design": again})["sql"] == []
    assert [t["name"] for t in engine.call("db.diagram", where)["tables"]] == ["people"]
    databases.forget(cid)
