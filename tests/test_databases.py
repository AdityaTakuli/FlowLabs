"""Databases (core/databases.py): browse, query in sessions, edit, export, explain, administer.

Everything runs against a SQLite file here. The same checks run against real servers when
FLOWLABS_TEST_PG_ADMIN / FLOWLABS_TEST_MYSQL_ADMIN hold a connection (JSON, a user that may create
tables, roles and users), e.g. with Docker:

    docker run -d -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16-alpine
    FLOWLABS_TEST_PG_ADMIN='{"kind": "postgresql", "host": "127.0.0.1", "port": 55432, "user": "postgres",
                             "password": "pw", "database": "postgres", "sslmode": "disable"}'
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path

import pytest

from flowlabs.core import databases, sources, sql
from flowlabs.core.rpc import Engine

SETUP = """
create table customers (id integer primary key, name text not null, city text);
create table orders (id integer primary key, customer_id integer references customers(id), total numeric(10, 2),
                     note varchar(200));
create index orders_customer on orders (customer_id);
insert into customers values (1, 'Ada', 'London'), (2, 'Lin', 'Pune'), (3, 'Sam', null);
insert into orders values (10, 1, 25.50, 'first: 10:30 50%'), (11, 1, 7.25, null), (12, 2, 99.99, 'big');
create view big_orders as select * from orders where total > 20;
"""


@pytest.fixture
def engine(ws) -> Engine:
    return Engine(ws.root)


@pytest.fixture
def lite(engine, tmp_path: Path) -> dict:
    path = tmp_path / "shop.sqlite"
    with sqlite3.connect(path) as db:
        db.executescript(SETUP)
    saved = engine.call("sql.connection_save", {"connection": {"kind": "sqlite", "database": str(path),
                                                               "name": "shop", "allow_changes": True}})  # fmt: skip
    yield saved
    databases.forget(saved["id"])


def test_statement_under_the_cursor():
    script = "select 1;\n\nselect 2;\nselect 3"
    assert [s[2] for s in databases.pick(script, 3)] == ["select 1"]
    assert [s[2] for s in databases.pick(script, 10)] == ["select 1"]  # the blank line after it
    assert [s[2] for s in databases.pick(script, 11)] == ["select 2"]  # the start of the next line
    assert [s[2] for s in databases.pick(script, len(script))] == ["select 3"]
    assert len(databases.pick(script, None)) == 3
    spans = sql.statement_spans("select 1;\n  -- note\nselect 2 ;")
    assert spans[1][0] == 12 and spans[1][2] == "-- note\nselect 2"


def test_browse(engine, lite):
    overview = engine.call("db.overview", {"connection_id": lite["id"]})
    assert overview["flavor"] == "sqlite" and overview["databases"][0]["name"] == "main"
    found = engine.call("db.objects", {"connection_id": lite["id"], "database": "main"})
    assert [t["name"] for t in found["tables"]] == ["customers", "orders"]
    assert [v["name"] for v in found["views"]] == ["big_orders"]
    info = engine.call("db.table", {"connection_id": lite["id"], "database": "main", "name": "orders"})
    assert info["primary_key"] == ["id"] and info["editable"]
    assert info["foreign_keys"][0]["references"] == "customers"
    assert [ix["name"] for ix in info["indexes"]] == ["orders_customer"]
    assert "CREATE TABLE orders" in info["ddl"]
    assert engine.call("db.columns", {"connection_id": lite["id"], "database": "main"})["customers"] == ["id", "name", "city"]


def test_a_session_keeps_its_state(engine, lite):
    session = engine.call("db.session_open", {"connection_id": lite["id"]})["session_id"]
    run = engine.call("db.execute", {"session_id": session, "sql": "create temp table t (a int); insert into t values (1), (2)"})
    assert run["error"] is None and run["results"][1]["message"] == "INSERT: 2 rows changed."
    again = engine.call("db.execute", {"session_id": session, "sql": "select sum(a) as s from t"})
    assert again["results"][0]["rows"] == [[3]]
    # a % and a :name in the SQL are text, not placeholders
    text = engine.call("db.execute", {"session_id": session, "sql": "select note from orders where id = 10"})
    assert text["results"][0]["rows"] == [["first: 10:30 50%"]]


def test_results_errors_and_limits(engine, lite):
    session = engine.call("db.session_open", {"connection_id": lite["id"]})["session_id"]
    run = engine.call("db.execute", {"session_id": session, "sql": "select * from customers;\nselect * from nope;\nselect 1",
                                     "limit": 2})  # fmt: skip
    assert run["results"][0]["truncated"] and len(run["results"][0]["rows"]) == 2
    assert run["error"]["statement"] == 1 and run["error"]["line"] == 2 and "nope" in run["error"]["message"]
    picked = engine.call("db.execute", {"session_id": session, "sql": "select 1 as a;\nselect 2 as b", "cursor": 17})
    assert picked["results"][0]["columns"] == ["b"]


def test_transactions(engine, lite):
    session = engine.call("db.session_open", {"connection_id": lite["id"]})["session_id"]
    engine.call("db.autocommit", {"session_id": session, "on": False})
    run = engine.call("db.execute", {"session_id": session, "sql": "update customers set name = 'X' where id = 1"})
    assert run["session"]["in_transaction"]
    assert not engine.call("db.rollback", {"session_id": session})["in_transaction"]
    check = engine.call("db.execute", {"session_id": session, "sql": "select name from customers where id = 1"})
    assert check["results"][0]["rows"] == [["Ada"]]
    engine.call("db.rollback", {"session_id": session})
    assert engine.safe_call("db.execute", {"session_id": "s_gone", "sql": "select 1"})["error"]["code"] == "session_gone"


def test_read_only_connections(engine, lite):
    engine.call("sql.connection_save", {"connection": {**lite, "allow_changes": False}})
    session = engine.call("db.session_open", {"connection_id": lite["id"]})["session_id"]
    refused = engine.safe_call("db.execute", {"session_id": session, "sql": "delete from orders"})
    assert "read-only" in refused["error"]["message"]
    escape = engine.safe_call("db.execute", {"session_id": session, "sql": "pragma query_only = off"})
    assert "error" in escape or engine.call("db.execute", {"session_id": session, "sql": "select 1"})
    assert "read-only" in engine.safe_call("db.apply", {"connection_id": lite["id"], "database": "main", "name": "orders",
                                                         "changes": {"deletes": [{"key": {"id": 10}}]}})["error"]["message"]  # fmt: skip


def test_edit_rows(engine, lite):
    where = {"connection_id": lite["id"], "database": "main", "name": "orders"}
    page = engine.call("db.rows", {**where, "order": [{"column": "total", "desc": True}], "limit": 2})
    assert page["total"] == 3 and page["rows"][0][0] == 12 and page["editable"]
    changes = {"updates": [{"key": {"id": "10"}, "values": {"note": "edited", "total": "30.10"}}],
               "inserts": [{"id": 13, "customer_id": 3, "total": "1.5", "note": "it's new"}],
               "deletes": [{"key": {"id": 11}}]}  # fmt: skip
    preview = engine.call("db.apply", {**where, "changes": changes, "preview": True})["sql"]
    assert any("it''s new" in line for line in preview)
    assert engine.call("db.apply", {**where, "changes": changes})["saved"] == {"update": 1, "insert": 1, "delete": 1}
    stale = engine.safe_call("db.apply", {**where, "changes": {"deletes": [{"key": {"id": 11}}]}})
    assert "Nothing was saved" in stale["error"]["message"]
    filtered = engine.call("db.rows", {**where, "where": "note = 'edited'"})
    assert filtered["total"] == 1 and filtered["rows"][0][2] in ("30.10", 30.1)


def test_export_and_save_as_dataset(engine, lite, ws):
    for fmt in ("csv", "xlsx", "json", "parquet"):
        written = engine.call("db.export", {"connection_id": lite["id"], "database": "main", "sql": "select * from customers",
                                            "format": fmt, "name": "customers"})  # fmt: skip
        assert written["rows"] == 3 and (ws.root / written["path"]).is_file()
    meta = engine.call("db.save_dataset", {"connection_id": lite["id"], "database": "main",
                                           "sql": "select * from orders", "name": "orders"})  # fmt: skip
    assert meta["rows"] == 3 and meta["name"] == "orders"


def test_import_a_dataset(engine, lite, churn):
    done = engine.call("db.import", {"connection_id": lite["id"], "database": "main", "name": "churn",
                                     "dataset_id": churn["id"], "mode": "create"})  # fmt: skip
    assert done["rows"] == 2000
    again = engine.safe_call("db.import", {"connection_id": lite["id"], "database": "main", "name": "churn",
                                           "dataset_id": churn["id"], "mode": "create"})  # fmt: skip
    assert "already exists" in again["error"]["message"]


def test_explain(engine, lite):
    session = engine.call("db.session_open", {"connection_id": lite["id"]})["session_id"]
    plan = engine.call("db.explain", {"session_id": session, "sql": "select * from orders where customer_id = 1"})
    labels = json.dumps(plan["tree"])
    assert "orders_customer" in labels


def test_stop_a_running_query(engine, lite):
    session = engine.call("db.session_open", {"connection_id": lite["id"]})["session_id"]
    slow = "with recursive n(i) as (select 1 union all select i + 1 from n where i < 100000000) select count(*) from n"
    outcome: dict = {}
    worker = threading.Thread(target=lambda: outcome.update(engine.call("db.execute", {"session_id": session, "sql": slow})))
    worker.start()
    time.sleep(0.5)
    assert engine.call("db.cancel", {"session_id": session})["cancelled"]
    worker.join(10)
    assert outcome["error"]["cancelled"]
    assert engine.call("db.execute", {"session_id": session, "sql": "select 1 as a"})["results"][0]["rows"] == [[1]]


def test_ssh_and_ssl_fields():
    mysql = sources.get("mysql")
    assert [f.name for f in sources.visible(mysql, {})][-2:] == ["ssl_mode", "ssh"]
    shown = [f.name for f in sources.visible(mysql, {"ssh": True, "ssh_auth": "password", "ssl_mode": "verify_ca"})]
    assert "ssl_ca" in shown and "ssh_password" in shown and "ssh_key" not in shown
    assert sources._mysql_tls({"ssl_mode": "require"}) is not None
    assert sources._mysql_tls({"ssl_mode": "off"}) is None
    url = sources.sqlalchemy_url(sources.get("postgresql"), {"host": "h", "sslmode": "verify-full"}, {})
    assert url.query["sslrootcert"] == "system"


@pytest.mark.parametrize("variable", ["FLOWLABS_TEST_PG_ADMIN", "FLOWLABS_TEST_MYSQL_ADMIN"])
def test_servers(engine, variable):
    given = os.environ.get(variable)
    if not given:
        pytest.skip(f"set {variable} to test against a real server")
    saved = engine.call("sql.connection_save", {"connection": {**json.loads(given), "allow_changes": True}})
    cid = saved["id"]
    overview = engine.call("db.overview", {"connection_id": cid})
    database = overview["default"]
    schema = "public" if overview["flavor"] == "postgresql" else None
    session = engine.call("db.session_open", {"connection_id": cid, "database": database})["session_id"]
    setup = "drop view if exists big_orders; drop table if exists orders; drop table if exists customers;" + SETUP
    assert engine.call("db.execute", {"session_id": session, "sql": setup})["error"] is None
    found = engine.call("db.objects", {"connection_id": cid, "database": database, "schema": schema})
    assert {"customers", "orders"} <= {t["name"] for t in found["tables"]}
    info = engine.call("db.table", {"connection_id": cid, "database": database, "schema": schema, "name": "orders"})
    assert info["primary_key"] == ["id"] and "CREATE" in info["ddl"]
    run = engine.call("db.execute", {"session_id": session, "sql": "select note from orders where id = 10"})
    assert run["results"][0]["rows"] == [["first: 10:30 50%"]]
    slow = "select pg_sleep(5)" if overview["flavor"] == "postgresql" else "select sleep(5) from customers"
    outcome: dict = {}
    worker = threading.Thread(target=lambda: outcome.update(engine.call("db.execute", {"session_id": session, "sql": slow})))
    worker.start()
    time.sleep(1)
    engine.call("db.cancel", {"session_id": session})
    worker.join(10)
    assert outcome["error"] is None or outcome["error"]["cancelled"]
    plan = engine.call("db.explain", {"session_id": session, "sql": "select * from orders", "analyze": True})
    assert plan["tree"]["label"]
    assert engine.call("db.activity", {"connection_id": cid})["sessions"]
    user = {"name": "flowlabs_test_user", "password": "pa'ss%", "host": "%"}
    engine.safe_call("db.user_change", {"connection_id": cid, "action": "drop", "params": user})
    assert engine.call("db.user_change", {"connection_id": cid, "action": "create", "params": user})["done"]
    assert "••••" in engine.call("db.user_change", {"connection_id": cid, "action": "password", "params": user,
                                                     "preview": True})["sql"][0]  # fmt: skip
    assert engine.call("db.user_change", {"connection_id": cid, "action": "drop", "params": user})["done"]
    engine.call("sql.connection_save", {"connection": {**json.loads(given), "id": cid, "allow_changes": False}})
    reader = engine.call("db.session_open", {"connection_id": cid, "database": database})["session_id"]
    refused = engine.safe_call("db.execute", {"session_id": reader, "sql": "delete from orders"})
    assert "read-only" in refused["error"]["message"]
