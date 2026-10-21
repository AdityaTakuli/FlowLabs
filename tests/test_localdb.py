"""Query tabs on your own datasets (core/localdb.py), through the same db.* calls as a database."""

from __future__ import annotations

import threading
import time

import pytest

from flowlabs.core import localdb
from flowlabs.core.rpc import Engine


@pytest.fixture
def engine(ws) -> Engine:
    return Engine(ws.root)


@pytest.fixture
def iris(engine) -> str:
    return engine.call("datasets.import_sample", {"sample_id": "iris"})["id"]


@pytest.fixture
def session(engine, iris):
    opened = engine.call("db.session_open", {"connection_id": "local", "database": iris})
    yield opened["session_id"]
    engine.call("db.session_close", {"session_id": opened["session_id"]})


def run(engine, session, sql, **extra):
    return engine.call("db.execute", {"session_id": session, "sql": sql, **extra})


def test_open_describes_a_duckdb_session(engine, iris, session):
    assert localdb.owns(session)
    described = localdb.describe(localdb.sessions[session])
    assert described["flavor"] == "duckdb" and described["database"] == iris


def test_data_is_the_project_dataset_and_temp_tables_last(engine, session):
    out = run(engine, session, "create temp table few as select * from data limit 3;\nselect count(*) as n from few;")
    assert out["error"] is None
    first, second = out["results"]
    assert "columns" not in first and first["message"]  # a CREATE ... AS is a message, not a table
    assert second["rows"] == [[3]]
    again = run(engine, session, "select count(*) from few")  # the next run, same session
    assert again["results"][0]["rows"] == [[3]]
    whole = run(engine, session, "select count(*) from data")
    assert whole["results"][0]["rows"] == [[150]]


def test_other_datasets_are_tables(engine, session):
    engine.call("datasets.import_sample", {"sample_id": "churn"})
    out = run(engine, session, "select count(*) > 0 from customer_churn")
    assert out["error"] is None and out["results"][0]["rows"] == [[True]]


def test_statement_under_the_cursor_and_limit(engine, session):
    script = "select 1 as a;\nselect * from data;"
    out = run(engine, session, script, cursor=script.index("from"), limit=10)
    (only,) = out["results"]
    assert len(only["rows"]) == 10 and only["truncated"]


def test_errors_name_the_line_and_the_tables(engine, session):
    out = run(engine, session, "select 1;\nselect * from nope;")
    assert len(out["results"]) == 1
    assert out["error"]["line"] == 2
    assert "There is no table nope" in out["error"]["message"] and "data" in out["error"]["message"]


def test_stop_interrupts_a_long_query(engine, session):
    outcome: dict = {}
    worker = threading.Thread(target=lambda: outcome.update(run(engine, session,
                              "select sum(a.range * b.range) from range(400000000) a, range(400) b")))  # fmt: skip
    worker.start()
    for _ in range(100):
        if localdb.sessions[session].running:
            break
        time.sleep(0.02)
    time.sleep(0.2)
    assert engine.call("db.cancel", {"session_id": session})["cancelled"]
    worker.join(30)
    assert not worker.is_alive()
    assert outcome["error"]["cancelled"]


def test_transactions(engine, session):
    run(engine, session, "create temp table t (x int)")
    out = run(engine, session, "begin; insert into t values (1);")
    assert out["session"]["in_transaction"]
    after = engine.call("db.rollback", {"session_id": session})
    assert not after["in_transaction"]
    assert run(engine, session, "select count(*) from t")["results"][0]["rows"] == [[0]]


def test_explain(engine, session):
    plan = engine.call("db.explain", {"session_id": session, "sql": "select count(*) from data where sepal_length > 5"})
    assert plan["flavor"] == "duckdb" and plan["raw"]


def test_export_and_save_as_dataset(engine, iris, ws):
    sql = "select species, count(*) as n from data group by species"
    for fmt in ("csv", "xlsx", "json", "parquet"):
        out = engine.call("db.export", {"connection_id": "local", "database": iris, "sql": sql, "format": fmt})
        assert out["rows"] == 3 and (ws.root / out["path"]).is_file()
    saved = engine.call(
        "db.save_dataset", {"connection_id": "local", "database": iris, "sql": sql, "name": "by species"}
    )
    assert saved["rows"] == 3


def test_columns_for_completion(engine, iris):
    found = engine.call("db.columns", {"connection_id": "local", "database": iris})
    assert "sepal_length" in found["data"]


def test_a_closed_session_says_so(engine, iris):
    opened = engine.call("db.session_open", {"connection_id": "local", "database": iris})["session_id"]
    engine.call("db.session_close", {"session_id": opened})
    with pytest.raises(Exception) as caught:
        engine.call("db.execute", {"session_id": opened, "sql": "select 1"})
    assert getattr(caught.value, "code", None) == "session_gone"
