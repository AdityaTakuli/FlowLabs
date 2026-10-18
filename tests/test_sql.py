"""SQL: queries on your datasets (DuckDB) and on connected databases (SQLite and DuckDB files here;
PostgreSQL and MySQL when FLOWLABS_TEST_POSTGRES / FLOWLABS_TEST_MYSQL hold connection JSON)."""

from __future__ import annotations

import json
import os
import sqlite3
import stat

import pytest

from flowlabs.core import sql
from flowlabs.core.rpc import Engine

pytest.importorskip("duckdb")
pytest.importorskip("sqlalchemy")


@pytest.fixture
def engine(tmp_path):
    engine = Engine(tmp_path / "ws")
    engine.call("datasets.import_sample", {"sample_id": "churn"})
    engine.call("datasets.import_sample", {"sample_id": "iris"})
    return engine


@pytest.fixture
def shop(tmp_path):
    path = tmp_path / "shop.sqlite"
    with sqlite3.connect(path) as db:
        db.execute("create table orders(id integer primary key, city text, amount real, placed date)")
        db.executemany(
            "insert into orders(city, amount, placed) values (?, ?, ?)",
            [("Pune", 9.5, "2026-01-02"), ("Delhi", 20.0, "2026-01-03"), ("Pune", 4.25, "2026-01-04")],
        )
    return path


def test_statements_are_split_outside_quotes_and_comments():
    script = "select ';' as a; -- a comment; still a comment\nselect 2 /* ; */; ;"
    assert sql.split_statements(script) == ["select ';' as a", "-- a comment; still a comment\nselect 2 /* ; */"]
    assert not sql.writes("  -- note\n(select 1)") and not sql.writes("WITH x AS (select 1) select * from x")
    assert sql.writes("delete from t") and sql.writes("create table t(a int)") and sql.writes("drop table t")
    assert (
        sql.table_name("Customer churn (2024)") == "customer_churn_2024"
        and sql.table_name("2024 sales") == "t_2024_sales"
    )


def test_scripts_split_like_database_clients():
    # MySQL Workbench style: DELIMITER lines, and a trigger body with semicolons
    workbench = """USE parks_and_recreation;

DELIMITER $$
create trigger employee_insert
    after insert on employee_salary
    for each row
BEGIN
    insert into employee_demographics(employee_id) values(new.employee_id);
END $$
DELIMITER ;
select 1;"""
    assert sql.split_statements(workbench) == [
        "USE parks_and_recreation",
        "create trigger employee_insert\n    after insert on employee_salary\n    for each row\n"
        "BEGIN\n    insert into employee_demographics(employee_id) values(new.employee_id);\nEND",
        "select 1",
    ]
    # No DELIMITER needed: a routine's body stays whole, through IF and CASE, up to its own END
    body = (
        "create procedure p() begin if 1 then select case when 2 then 'x;' end; end if; select 3; end;"
        " select 4; begin; commit"
    )
    assert sql.split_statements(body) == [
        "create procedure p() begin if 1 then select case when 2 then 'x;' end; end if; select 3; end",
        "select 4",
        "begin",
        "commit",
    ]
    # PostgreSQL's dollar quotes
    assert sql.split_statements(
        "create function f() returns int as $$ begin return 1; end; $$ language sql; select $1"
    ) == [
        "create function f() returns int as $$ begin return 1; end; $$ language sql",
        "select $1",
    ]
    assert not sql.writes("USE shop") and sql.writes("create trigger t after insert on a begin select 1; end")


def test_a_trigger_can_be_created_on_a_connection(engine, shop):
    saved = engine.call(
        "sql.connection_save", {"connection": {"kind": "sqlite", "database": str(shop), "allow_changes": True}}
    )
    script = """create table audit(order_id integer, city text);
create trigger orders_audit after insert on orders
begin
    insert into audit values (new.id, new.city);
end;
insert into orders(city, amount, placed) values ('Goa', 1.0, '2026-02-01');"""
    engine.call("sql.run", {"sql": script, "connection_id": saved["id"]})
    with sqlite3.connect(shop) as db:
        assert db.execute("select * from audit").fetchall() == [(4, "Goa")]


def test_queries_on_datasets(engine):
    tables = {t["name"]: t for t in engine.call("sql.tables")}
    assert set(tables) == {"customer_churn", "iris_flowers"}
    assert {"name": "churned", "type": "boolean"} in tables["customer_churn"]["columns"]

    grouped = engine.call(
        "sql.run",
        {"sql": "select plan_type, count(*) as n from customer_churn group by 1 order by n desc"},
    )
    assert grouped["columns"] == ["plan_type", "n"] and grouped["types"] == ["text", "integer"]
    assert sum(row[1] for row in grouped["rows"]) == 2000 and not grouped["truncated"]

    capped = engine.call("sql.run", {"sql": "select * from iris_flowers", "limit": 10})
    assert len(capped["rows"]) == 10 and capped["total"] == 150 and capped["truncated"]

    script = engine.call(
        "sql.run",
        {
            "sql": "create temp table big as select * from customer_churn where tenure_months > 24;\nselect count(*) from big"
        },
    )
    assert script["rows"][0][0] > 0
    assert "do not change them" in engine.call("sql.run", {"sql": "create table x as select 1 as a"})["message"]


def test_query_mistakes_say_where_and_what(engine):
    missing = engine.safe_call("sql.run", {"sql": "select * from iris"})["error"]
    assert (
        missing["user"] and missing["message"] == "There is no table iris. Your tables: customer_churn, iris_flowers."
    )
    parse = engine.safe_call("sql.run", {"sql": "select 1;\nselec 2"})["error"]
    assert parse["line"] == 2 and "syntax error" in parse["message"]
    overloads = engine.safe_call("sql.run", {"sql": "select avg(plan_type) from customer_churn"})["error"]
    assert "Candidate functions" not in overloads["message"]
    assert engine.safe_call("sql.run", {"sql": "  -- nothing\n"})["error"]["message"] == "write a query first"


def test_a_result_saved_as_a_dataset_can_be_queried_and_trained(engine):
    meta = engine.call(
        "sql.save", {"sql": "select * from customer_churn where tenure_months > 24", "name": "Loyal customers"}
    )
    assert meta["kind"] == "tabular" and meta["file"] == "data.parquet" and meta["source"].startswith("SQL: select")
    assert 0 < meta["rows"] < 2000 and meta["columns"] == 9
    assert engine.call("sql.run", {"sql": "select count(*) from loyal_customers"})["rows"][0][0] == meta["rows"]
    project = engine.call("projects.create", {"dataset_id": meta["id"], "target": "churned"})
    assert project["target"] == "churned"


def test_sqlite_connection_is_read_only_until_changes_are_allowed(engine, shop):
    given = {"kind": "sqlite", "database": str(shop)}
    assert engine.call("sql.connection_test", {"connection": given})["ok"]
    saved = engine.call("sql.connection_save", {"connection": given})
    assert saved["name"] == "shop.sqlite" and saved["allow_changes"] is False and saved["group"] == "Databases"
    tables = engine.call("sql.connection_tables", {"connection_id": saved["id"]})
    assert tables[0]["name"] == "orders" and [c["name"] for c in tables[0]["columns"]] == [
        "id",
        "city",
        "amount",
        "placed",
    ]

    by_city = engine.call(
        "sql.run",
        {
            "sql": "select city, sum(amount) as total from orders group by city order by city",
            "connection_id": saved["id"],
        },
    )
    assert by_city["rows"] == [["Delhi", 20.0], ["Pune", 13.75]] and by_city["types"] == ["text", "number"]

    refused = engine.safe_call("sql.run", {"sql": "delete from orders", "connection_id": saved["id"]})["error"]
    assert "read-only" in refused["message"] and "DELETE" in refused["message"]
    assert (
        engine.safe_call("sql.run", {"sql": "select * from nope", "connection_id": saved["id"]})["error"]["message"]
        == "no such table: nope"
    )

    engine.call("sql.connection_save", {"connection": {**saved, "allow_changes": True}})
    changed = engine.call(
        "sql.run", {"sql": "update orders set amount = amount * 2 where city = 'Pune'", "connection_id": saved["id"]}
    )
    assert changed["message"] == "Done. 2 rows changed."
    with sqlite3.connect(shop) as db:
        assert db.execute("select sum(amount) from orders").fetchone()[0] == pytest.approx(47.5)

    meta = engine.call("sql.save", {"sql": "select * from orders", "name": "orders", "connection_id": saved["id"]})
    assert meta["rows"] == 3 and meta["columns"] == 4
    engine.call("sql.connection_delete", {"connection_id": saved["id"]})
    assert engine.call("sql.connections") == []


def test_passwords_stay_on_the_engine(engine, tmp_path):
    saved = engine.call("sql.connection_save", {"connection": {"kind": "postgresql", "host": "db.example", "user": "me",
                                                               "password": "s3cret", "database": "shop"}})  # fmt: skip
    assert saved["values"]["port"] == 5432 and saved["values"]["sslmode"] == "prefer"
    assert saved["password_set"] and saved["secrets_set"] == ["password"] and "s3cret" not in json.dumps(saved)
    assert "s3cret" not in json.dumps(engine.call("sql.connections"))
    stored = tmp_path / "ws" / "connections.json"
    secrets = tmp_path / "ws" / ".secrets.json"
    assert "s3cret" not in stored.read_text() and "s3cret" in secrets.read_text()  # the keychain's stand-in in tests
    if os.name != "nt":
        assert stat.S_IMODE(stored.stat().st_mode) == 0o600 and stat.S_IMODE(secrets.stat().st_mode) == 0o600
    renamed = engine.call(
        "sql.connection_save", {"connection": {**saved, "name": "Shop", "values": {**saved["values"], "password": ""}}}
    )
    assert renamed["name"] == "Shop" and renamed["password_set"] and "s3cret" in secrets.read_text()  # blank keeps it

    url = engine.call("sql.connection_save", {"connection": {"kind": "url", "url": "postgresql+psycopg://u:pw@h/db"}})
    assert url["secrets_set"] == ["url"] and "pw@h" not in stored.read_text()
    engine.call("sql.connection_delete", {"connection_id": url["id"]})
    assert "pw@h" not in secrets.read_text()  # deleting a connection deletes its secrets

    refused = engine.call(
        "sql.connection_test", {"connection": {"kind": "postgresql", "host": "127.0.0.1", "port": 1, "database": "x"}}
    )
    assert refused["ok"] is False and refused["message"]
    assert (
        "enter the host"
        in engine.safe_call("sql.connection_save", {"connection": {"kind": "postgresql"}})["error"]["message"]
    )


def test_connections_saved_before_sources_still_work(engine, tmp_path, shop):
    stored = tmp_path / "ws" / "connections.json"
    stored.write_text(json.dumps([{"id": "c_old", "kind": "sqlite", "name": "old shop", "allow_changes": False, "database": str(shop)},
                                  {"id": "c_pg", "kind": "postgresql", "name": "old pg", "host": "h", "port": 5432, "user": "u",
                                   "password": "legacy-pw", "database": "d"}]))  # fmt: skip
    listed = {c["id"]: c for c in engine.call("sql.connections")}
    assert listed["c_old"]["values"]["database"] == str(shop) and listed["c_pg"]["password_set"]
    assert engine.call("sql.run", {"sql": "select count(*) from orders", "connection_id": "c_old"})["rows"] == [[3]]
    engine.call("sql.connection_save", {"connection": {**listed["c_pg"], "name": "pg"}})
    assert "legacy-pw" not in stored.read_text() and "legacy-pw" in (tmp_path / "ws" / ".secrets.json").read_text()


def test_every_source_draws_its_form(engine):
    kinds = {k["id"]: k for k in engine.call("sql.kinds")}
    assert {
        "postgresql",
        "mysql",
        "sqlserver",
        "oracle",
        "snowflake",
        "bigquery",
        "redshift",
        "databricks",
        "s3",
        "azure",
        "gcs",
    } <= set(kinds)
    snowflake = kinds["snowflake"]
    assert snowflake["group"] == "Warehouses" and snowflake["packages"] == ["snowflake-sqlalchemy"]
    assert [f["name"] for f in snowflake["fields"]][:3] == ["account", "user", "auth"]
    assert next(f for f in snowflake["fields"] if f["name"] == "password")["when"] == ["auth", ["password"]]
    assert kinds["postgresql"]["needs"] == []  # bundled


def test_urls_for_warehouses():
    from flowlabs.core import sources

    url = sources.sqlalchemy_url(sources.get("snowflake"), {"account": "org-acct", "user": "me", "auth": "password", "warehouse": "WH",
                                                            "database": "DB", "schema": "PUBLIC", "role": "ANALYST"}, {"password": "p@ss"})  # fmt: skip
    assert (
        url.drivername == "snowflake"
        and url.host == "org-acct"
        and url.database == "DB/PUBLIC"
        and url.password == "p@ss"
    )
    assert dict(url.query) == {"warehouse": "WH", "role": "ANALYST"}
    sso = sources.sqlalchemy_url(
        sources.get("snowflake"), {"account": "a", "user": "me", "auth": "externalbrowser"}, {}
    )
    assert sso.password is None and dict(sso.query)["authenticator"] == "externalbrowser"
    bq = sources.get("bigquery")
    assert str(sources.sqlalchemy_url(bq, {"project": "p1", "dataset": "sales"}, {})) == "bigquery://p1/sales"
    assert sources.engine_options(bq, {"auth": "keyfile", "keyfile": "/k.json"}, 10)["credentials_path"] == "/k.json"
    databricks = sources.sqlalchemy_url(
        sources.get("databricks"), {"host": "adb.net", "http_path": "/sql/1", "catalog": "main"}, {"token": "dapi"}
    )
    assert (
        databricks.username == "token"
        and databricks.password == "dapi"
        and dict(databricks.query) == {"http_path": "/sql/1", "catalog": "main"}
    )
    oracle = sources.sqlalchemy_url(sources.get("oracle"), {"host": "o", "port": 1521, "service": "ORCLPDB1"}, {})
    assert oracle.drivername == "oracle+oracledb" and dict(oracle.query) == {"service_name": "ORCLPDB1"}
    redshift = sources.sqlalchemy_url(sources.get("redshift"), {"host": "r", "port": 5439, "database": "dev"}, {})
    assert dict(redshift.query) == {"sslmode": "require"}
    assert sources.storage_root(sources.get("s3"), {"bucket": "b", "prefix": "/sales/2026/"}) == "s3://b/sales/2026/"
    assert sources.storage_root(sources.get("azure"), {"container": "c"}) == "az://c/"
    assert sources.reader("s3://b/x.parquet") == "read_parquet('s3://b/x.parquet')" and sources.reader(
        "az://c/y.csv.gz"
    ).startswith("read_csv_auto")


def test_a_missing_driver_is_offered_for_install(engine, monkeypatch):
    from flowlabs.core import plugins

    monkeypatch.setattr(plugins, "missing", lambda modules: list(modules))
    saved = engine.call(
        "sql.connection_save", {"connection": {"kind": "snowflake", "account": "a", "user": "u", "password": "p"}}
    )
    error = engine.safe_call("sql.run", {"sql": "select 1", "connection_id": saved["id"]})["error"]
    assert "Snowflake needs its driver (snowflake-sqlalchemy, about 60 MB)" in error["message"]
    assert next(k for k in engine.call("sql.kinds") if k["id"] == "snowflake")["installable"]


def test_duckdb_file_connection(engine, tmp_path):
    import duckdb

    path = tmp_path / "warehouse.duckdb"
    with duckdb.connect(str(path)) as db:
        db.execute("create table sales as select range as id, range * 1.5 as amount from range(100)")
    saved = engine.call("sql.connection_save", {"connection": {"kind": "duckdb", "database": str(path)}})
    assert engine.call("sql.connection_tables", {"connection_id": saved["id"]})[0]["name"] == "sales"
    result = engine.call("sql.run", {"sql": "select count(*), sum(amount) from sales", "connection_id": saved["id"]})
    assert result["rows"] == [[100, 7425.0]]
    assert (
        "read-only"
        in engine.safe_call("sql.run", {"sql": "drop table sales", "connection_id": saved["id"]})["error"]["message"]
    )


@pytest.mark.parametrize("variable", ["FLOWLABS_TEST_POSTGRES", "FLOWLABS_TEST_MYSQL"])
def test_database_servers(engine, variable):
    """e.g. FLOWLABS_TEST_POSTGRES='{"kind": "postgresql", "host": "127.0.0.1", "port": 5432, "user": "postgres",
    "password": "...", "database": "shop"}' with a table sales(region text, amount numeric, sold_on date)."""
    given = os.environ.get(variable)
    if not given:
        pytest.skip(f"set {variable} to test against a real server")
    saved = engine.call("sql.connection_save", {"connection": json.loads(given)})
    assert engine.call("sql.connection_test", {"connection": json.loads(given) | {"id": saved["id"]}})["ok"]
    result = engine.call(
        "sql.run",
        {
            "sql": "select region, sum(amount) as total, min(sold_on) as first from sales group by region",
            "connection_id": saved["id"],
        },
    )
    assert result["types"] == ["text", "number", "date"]
    meta = engine.call("sql.save", {"sql": "select * from sales", "name": "sales", "connection_id": saved["id"]})
    assert meta["rows"] > 0


def test_inside_a_project_data_is_its_dataset(engine):
    churn = next(t for t in engine.call("sql.tables") if t["name"] == "customer_churn")
    tables = engine.call("sql.tables", {"dataset_id": churn["dataset_id"]})
    assert tables[0]["name"] == "data" and tables[0]["rows"] == 2000
    page = engine.call(
        "sql.run",
        {
            "sql": "select customer_id from data order by customer_id",
            "dataset_id": churn["dataset_id"],
            "limit": 50,
            "offset": 100,
        },
    )
    assert page["total"] == 2000 and len(page["rows"]) == 50 and page["rows"][0][0] == "C00100"
    assert (
        "Your tables: data, customer_churn"
        in engine.safe_call("sql.run", {"sql": "select * from nope", "dataset_id": churn["dataset_id"]})["error"][
            "message"
        ]
    )
    meta = engine.call(
        "sql.save",
        {"sql": "select * from data where support_calls > 3", "name": "Callers", "dataset_id": churn["dataset_id"]},
    )
    assert 0 < meta["rows"] < 2000


def test_ask_ai_sends_the_schema_and_returns_sql(engine, monkeypatch, tmp_path):
    from flowlabs.core import ai

    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    assert engine.call("ai.status")["configured"] is False
    assert "Add a Groq API key" in engine.safe_call("ai.sql", {"question": "how many rows?"})["error"]["message"]
    assert "does not look like" in engine.safe_call("ai.configure", {"key": "nope"})["error"]["message"]
    status = engine.call("ai.configure", {"key": "gsk_" + "a" * 40, "model": "llama-3.1-8b-instant"})
    assert status["configured"] and status["source"] == "saved" and status["model"] == "llama-3.1-8b-instant"
    assert "gsk_" not in json.dumps(status)

    asked = {}

    def fake(key, model, messages):
        asked.update(key=key, model=model, messages=messages)
        return json.dumps(
            {
                "sql": "select plan_type, count(*) as customers from data group by 1",
                "explanation": "Customers per plan.",
            }
        )

    monkeypatch.setattr(ai, "_ask", fake)
    churn = next(t for t in engine.call("sql.tables") if t["name"] == "customer_churn")
    answer = engine.call("ai.sql", {"question": "customers per plan", "dataset_id": churn["dataset_id"]})
    assert answer["sql"].startswith("select plan_type") and answer["explanation"] == "Customers per plan."
    prompt = asked["messages"][1]["content"]
    assert "data (2000 rows)" in prompt and "plan_type text e.g." in prompt and "customers per plan" in prompt
    assert "C00001" not in prompt  # no examples from ID-like columns
    assert "use the table data" in asked["messages"][0]["content"]
    assert engine.call("ai.configure", {"key": ""})["configured"] is False
