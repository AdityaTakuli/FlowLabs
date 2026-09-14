from __future__ import annotations

import datetime as dt

import polars as pl
import pytest
from flowlab_nodes import NodeRuntimeError, infer_table_schema, table_hash
from flowlab_nodes.narration import chart_artifact, fmt, ungrounded_numbers
from flowspec import Role, Semantic
from helpers import FIXTURES, fixture_schema


def test_semantic_inference() -> None:
    n = 60
    df = pl.DataFrame(
        {
            "customer_id": [f"C{i}" for i in range(n)],
            "flag": [i % 2 == 0 for i in range(n)],
            "calls": [i % 5 for i in range(n)],
            "amount": [i * 1.37 for i in range(n)],
            "plan": ["a", "b", "c"] * 20,
            "yes_no": ["yes", "no"] * 30,
            "day": [dt.date(2026, 1, 1) + dt.timedelta(days=i) for i in range(n)],
            "empty": pl.Series([None] * n, dtype=pl.Float64),
        }
    )
    schema = infer_table_schema(df)
    col = {c.name: c for c in schema.columns}
    assert col["customer_id"].semantic == Semantic.IDENTIFIER
    assert col["customer_id"].role == Role.IDENTIFIER
    assert col["flag"].semantic == Semantic.BINARY
    assert col["calls"].semantic == Semantic.NUMERIC_DISCRETE
    assert col["amount"].semantic == Semantic.NUMERIC_CONTINUOUS
    assert col["plan"].semantic == Semantic.CATEGORICAL_NOMINAL
    assert col["plan"].categories == ["a", "b", "c"]
    assert col["plan"].class_balance == {"a": 0.3333, "b": 0.3333, "c": 0.3333}
    assert col["yes_no"].semantic == Semantic.BINARY
    assert col["day"].semantic == Semantic.DATETIME
    assert col["empty"].null_frac == 1.0 and col["empty"].nullable
    assert col["amount"].stats is not None and col["amount"].stats.max == pytest.approx(59 * 1.37)


def test_empty_table_profile() -> None:
    schema = infer_table_schema(pl.DataFrame({"a": pl.Series([], dtype=pl.Int64)}))
    assert schema.row_count == 0 and schema.columns[0].cardinality == 0


@pytest.mark.parametrize("name", sorted(p.stem for p in FIXTURES.glob("*.csv")))
def test_every_fixture_profiles(name: str) -> None:
    schema = fixture_schema(name)
    assert schema.row_count and schema.content_hash and schema.content_hash.startswith("sha256:")


def test_fixture_expectations() -> None:
    churn = {c.name: c for c in fixture_schema("churn").columns}
    assert churn["churned"].semantic == Semantic.BINARY
    assert churn["signup_date"].semantic == Semantic.DATETIME
    assert churn["customer_id"].role == Role.IDENTIFIER
    assert churn["tenure_months"].nullable
    fraud = fixture_schema("imbalanced_2pct").column("is_fraud")
    assert fraud and fraud.class_balance and fraud.class_balance["true"] < 0.05
    assert fixture_schema("wide_500").row_count == 120 and len(fixture_schema("wide_500").columns) == 501


def test_table_hash_is_deterministic_and_content_sensitive() -> None:
    df = pl.DataFrame({"a": [1, 2, 3], "b": ["x", "y", None]})
    assert table_hash(df) == table_hash(df.clone())
    assert table_hash(df) != table_hash(df.with_columns(pl.col("a") + 1))


def test_fmt() -> None:
    assert fmt(3.0) == "3"
    assert fmt(81.7512) == "81.75"
    assert fmt(0.123456) == "0.1235"
    assert fmt(-0.00001) == "0"


def test_ungrounded_numbers_detects_invented_values() -> None:
    basis = {"accuracy_pct": 81.75, "n": 400}
    assert ungrounded_numbers("On `test_2024` (400 rows) accuracy is 81.75%.", basis) == []
    assert ungrounded_numbers("Accuracy is 91.2% on 400 rows.", basis) == ["91.2"]


def test_chart_artifact_refuses_ungrounded_narration() -> None:
    with pytest.raises(NodeRuntimeError) as err:
        chart_artifact({}, "The mean is 42.", {"mean": 41.0})
    assert err.value.code == "NARRATION_UNGROUNDED"
