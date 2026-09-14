"""Deterministic schema inference and column statistics (PRD Sections 6.4 and 9.3)."""

from __future__ import annotations

import math
import re
from typing import Any

import polars as pl
from flowspec import ColumnSchema, ColumnStats, Role, Semantic, TableSchema

MAX_CATEGORIES = 50
MAX_BALANCE_CLASSES = 20
DISCRETE_MAX_CARDINALITY = 20
_ID_NAME = re.compile(r"(^id$|_id$|^id_|uuid|guid)", re.IGNORECASE)


def dtype_name(dtype: pl.DataType) -> str:
    if isinstance(dtype, pl.Boolean):
        return "bool"
    if isinstance(dtype, pl.String | pl.Categorical | pl.Enum):
        return "string"
    if isinstance(dtype, pl.Datetime):
        return "datetime"
    if isinstance(dtype, pl.Date):
        return "date"
    if isinstance(dtype, pl.Time):
        return "time"
    if isinstance(dtype, pl.Duration):
        return "duration"
    if isinstance(dtype, pl.Null):
        return "null"
    if isinstance(dtype, pl.Decimal):
        return "decimal"
    return str(dtype).lower()


POLARS_DTYPES: dict[str, pl.DataType] = {
    "int8": pl.Int8(),
    "int16": pl.Int16(),
    "int32": pl.Int32(),
    "int64": pl.Int64(),
    "uint8": pl.UInt8(),
    "uint16": pl.UInt16(),
    "uint32": pl.UInt32(),
    "uint64": pl.UInt64(),
    "float32": pl.Float32(),
    "float64": pl.Float64(),
    "bool": pl.Boolean(),
    "string": pl.String(),
}


def _clean(value: Any, digits: int = 6) -> float | None:
    if value is None:
        return None
    v = float(value)
    return round(v, digits) if math.isfinite(v) else None


def _numeric_stats(s: pl.Series) -> ColumnStats:
    f = s.cast(pl.Float64)
    return ColumnStats(
        min=_clean(f.min()),
        max=_clean(f.max()),
        mean=_clean(f.mean()),
        std=_clean(f.std()),
        median=_clean(f.median()),
        skew=_clean(f.skew()) if f.len() > 2 else None,
    )


def infer_column(s: pl.Series, n_rows: int) -> ColumnSchema:
    dtype = dtype_name(s.dtype)
    null_count = s.null_count()
    non_null = s.drop_nulls()
    n = non_null.len()
    cardinality = non_null.n_unique() if n else 0
    stats: ColumnStats | None = None

    if dtype == "bool":
        semantic = Semantic.BINARY
    elif s.dtype.is_numeric():
        is_int = s.dtype.is_integer()
        if cardinality == 2:
            semantic = Semantic.BINARY
        elif is_int and _ID_NAME.search(s.name) and n and cardinality >= 0.9 * n:
            semantic = Semantic.IDENTIFIER
        elif is_int and cardinality <= DISCRETE_MAX_CARDINALITY:
            semantic = Semantic.NUMERIC_DISCRETE
        else:
            semantic = Semantic.NUMERIC_CONTINUOUS
        if n:
            stats = _numeric_stats(non_null)
    elif dtype in ("date", "datetime"):
        semantic = Semantic.DATETIME
    elif dtype == "string":
        mean_len = float(non_null.str.len_chars().mean() or 0.0) if n else 0.0  # type: ignore[arg-type]
        if cardinality == 2:
            semantic = Semantic.BINARY
        elif n and _ID_NAME.search(s.name) and cardinality >= 0.9 * n:
            semantic = Semantic.IDENTIFIER
        elif n and mean_len > 40 and cardinality > 0.5 * n:
            semantic = Semantic.TEXT_FREE
        elif n >= 50 and cardinality == n:
            semantic = Semantic.IDENTIFIER
        else:
            semantic = Semantic.CATEGORICAL_NOMINAL
    else:
        semantic = Semantic.TEXT_FREE

    categories: list[str] | None = None
    class_balance: dict[str, float] | None = None
    if cardinality <= MAX_CATEGORIES and semantic not in (
        Semantic.DATETIME,
        Semantic.TEXT_FREE,
        Semantic.IDENTIFIER,
    ):
        categories = [str(v) for v in non_null.unique().sort().cast(pl.String).to_list()]
        if n and cardinality <= MAX_BALANCE_CLASSES:
            counts = non_null.cast(pl.String).value_counts()
            class_balance = {
                str(row[0]): round(row[1] / n, 4)
                for row in sorted(counts.iter_rows(), key=lambda r: str(r[0]))
            }

    return ColumnSchema(
        name=s.name,
        dtype=dtype,
        role=Role.IDENTIFIER if semantic == Semantic.IDENTIFIER else Role.FEATURE,
        semantic=semantic,
        nullable=null_count > 0,
        null_frac=round(null_count / n_rows, 4) if n_rows else 0.0,
        cardinality=cardinality,
        stats=stats,
        categories=categories,
        class_balance=class_balance,
    )


def infer_table_schema(df: pl.DataFrame, content_hash: str | None = None) -> TableSchema:
    return TableSchema(
        columns=[infer_column(df[name], df.height) for name in df.columns],
        row_count=df.height,
        content_hash=content_hash,
    )


def frame_signature(df: pl.DataFrame) -> list[tuple[str, str]]:
    return [(name, dtype_name(dtype)) for name, dtype in df.schema.items()]


def schema_signature(schema: TableSchema) -> list[tuple[str, str]]:
    return [(c.name, c.dtype) for c in schema.columns]
