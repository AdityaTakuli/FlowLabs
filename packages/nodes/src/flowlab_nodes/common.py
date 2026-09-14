"""Helpers shared by node implementations."""

from __future__ import annotations

import difflib
from collections.abc import Callable, Mapping, Sequence
from typing import Any

import numpy as np
import polars as pl
from flowspec import ColumnSchema, PortSchema, PortType, TableSchema

from .base import NodeCompileError, NodeRuntimeError
from .runtime_types import SplitTables

TABLE_ONLY = (PortType.TABLE,)
TABLE_OR_SPLIT = (PortType.TABLE, PortType.TABLE_SPLIT)


def resolve_columns(schema: TableSchema, names: Sequence[str]) -> list[ColumnSchema]:
    missing = [n for n in names if schema.column(n) is None]
    if missing:
        close = difflib.get_close_matches(missing[0], schema.names, n=1)
        suggestion = (
            f"Did you mean '{close[0]}'?" if close else "Available columns: " + ", ".join(schema.names[:12])
        )
        raise NodeCompileError(
            "COLUMN_NOT_FOUND",
            "Column(s) not found: " + ", ".join(f"'{m}'" for m in missing),
            suggestion,
        )
    return [c for n in names if (c := schema.column(n)) is not None]


def replace_columns(schema: TableSchema, updated: Mapping[str, ColumnSchema]) -> TableSchema:
    return schema.model_copy(update={"columns": [updated.get(c.name, c) for c in schema.columns]})


def split_rows_unknown(schema: TableSchema) -> TableSchema:
    return schema.model_copy(update={"row_count": None, "content_hash": None})


def derived_table(schema: TableSchema) -> TableSchema:
    """Schema for a node output: row count kept, content hash dropped."""
    return schema.model_copy(update={"content_hash": None})


def check_partition(ps: PortSchema, partition: str) -> None:
    if ps.kind == PortType.TABLE_SPLIT and partition not in (ps.partitions or []):
        raise NodeCompileError(
            "PARTITION_NOT_FOUND",
            f"Partition '{partition}' does not exist; available: {ps.partitions}",
        )


def fit_frame(value: pl.DataFrame | SplitTables) -> pl.DataFrame:
    """Rows a learning node may fit on: the train partition of a split, else the table."""
    return value.train if isinstance(value, SplitTables) else value


def map_frames(
    value: pl.DataFrame | SplitTables, fn: Callable[[pl.DataFrame], pl.DataFrame]
) -> pl.DataFrame | SplitTables:
    return value.map(fn) if isinstance(value, SplitTables) else fn(value)


def pick_frame(value: pl.DataFrame | SplitTables, partition: str) -> pl.DataFrame:
    if isinstance(value, SplitTables):
        if partition not in value.parts:
            raise NodeRuntimeError("PARTITION_NOT_FOUND", f"partition '{partition}' missing")
        return value.parts[partition]
    return value


def take_rows(df: pl.DataFrame, indices: np.ndarray[Any, Any]) -> pl.DataFrame:
    return df.select(pl.all().gather([int(i) for i in indices]))


def is_model_ready(col: ColumnSchema) -> bool:
    return col.is_numeric or col.is_bool


def feature_matrix(df: pl.DataFrame, features: Sequence[str]) -> np.ndarray[Any, Any]:
    if not features:
        raise NodeRuntimeError("NO_FEATURES", "no feature columns")
    x = df.select([pl.col(f).cast(pl.Float64) for f in features]).to_numpy()
    if x.size and np.isnan(x).any():
        bad = [f for i, f in enumerate(features) if np.isnan(x[:, i]).any()]
        raise NodeRuntimeError(
            "NULLS_IN_FEATURES", f"feature columns contain missing values at runtime: {bad}"
        )
    return x
