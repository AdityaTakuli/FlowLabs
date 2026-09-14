from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

import numpy as np
import polars as pl
from flowspec import ColumnSchema, PortSchema, Role, TableSchema
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sklearn.experimental import enable_iterative_imputer  # noqa: F401
from sklearn.impute import IterativeImputer, KNNImputer

from ..base import CompileContext, ExecContext, Node, NodeCompileError, PortDef
from ..common import (
    TABLE_OR_SPLIT,
    derived_table,
    fit_frame,
    map_frames,
    replace_columns,
    resolve_columns,
)
from ..profiling import POLARS_DTYPES
from ..registry import register

# --------------------------------------------------------------------------- drop_columns


class DropColumnsParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    columns: list[str] = Field(
        default_factory=list,
        title="Columns to drop",
        json_schema_extra={"x-widget": "column-multiselect"},
    )
    null_frac_gt: float | None = Field(
        None, ge=0, le=1, title="Drop if null fraction above", description="Rule-based drop."
    )
    cardinality_eq: int | None = Field(
        None, ge=0, title="Drop if distinct count equals", description="1 drops constant columns."
    )

    @model_validator(mode="after")
    def _one_rule(self) -> DropColumnsParams:
        if not self.columns and self.null_frac_gt is None and self.cardinality_eq is None:
            raise ValueError("give columns, null_frac_gt or cardinality_eq")
        return self


def _drop_set(params: DropColumnsParams, schema: TableSchema) -> list[str]:
    drop = {c.name for c in resolve_columns(schema, params.columns)}
    for col in schema.columns:
        if params.null_frac_gt is not None:
            if col.null_frac is None:
                raise NodeCompileError(
                    "STATS_UNAVAILABLE",
                    f"null fraction of '{col.name}' is unknown at this point in the flow",
                    "Place rule-based drop_columns directly after the dataset source",
                )
            if col.null_frac > params.null_frac_gt:
                drop.add(col.name)
        if params.cardinality_eq is not None:
            if col.cardinality is None:
                raise NodeCompileError(
                    "STATS_UNAVAILABLE",
                    f"cardinality of '{col.name}' is unknown at this point in the flow",
                    "Place rule-based drop_columns directly after the dataset source",
                )
            if col.cardinality == params.cardinality_eq:
                drop.add(col.name)
    return [c for c in schema.names if c in drop]


@register
class DropColumns(Node[DropColumnsParams]):
    """Remove columns by name or by rule (null fraction, cardinality).

    Drop identifiers and near-empty or constant columns before modelling. Rules are
    evaluated against the dataset profile, so the dropped set is known at compile time.
    """

    type = "clean.drop_columns"
    title = "Drop columns"
    category = "clean"
    Params = DropColumnsParams
    inputs = {"in": PortDef(TABLE_OR_SPLIT)}
    outputs = {"out": PortDef(TABLE_OR_SPLIT)}

    def propagate(
        self, params: DropColumnsParams, inputs: Mapping[str, PortSchema], ctx: CompileContext
    ) -> dict[str, PortSchema]:
        ps = inputs["in"]
        schema = ps.require_table()
        drop = _drop_set(params, schema)
        kept = [c for c in schema.columns if c.name not in drop]
        if not kept:
            raise NodeCompileError("EMPTY_SCHEMA", "this would drop every column")
        if not drop:
            ctx.warn("NOTHING_DROPPED", "no columns match the drop rules")
        for c in schema.columns:
            if c.name in drop and c.role == Role.TARGET:
                ctx.warn("TARGET_DROPPED", f"the target column '{c.name}' is dropped")
        return {"out": ps.with_table(derived_table(schema).model_copy(update={"columns": kept}))}

    def execute(
        self, params: DropColumnsParams, inputs: Mapping[str, Any], ctx: ExecContext
    ) -> dict[str, Any]:
        keep = ctx.output_schemas["out"].require_table().names
        return {"out": map_frames(inputs["in"], lambda df: df.select(keep))}


# --------------------------------------------------------------------------------- impute

Strategy = Literal["mean", "median", "mode", "constant", "ffill", "knn", "iterative"]
LEARNED = frozenset({"mean", "median", "mode", "knn", "iterative"})
NUMERIC_ONLY = frozenset({"mean", "median", "knn", "iterative"})


class ImputeParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    columns: list[str] = Field(
        default_factory=list,
        title="Columns to impute",
        description="Empty means every nullable feature column compatible with the strategy.",
        json_schema_extra={"x-widget": "column-multiselect"},
    )
    strategy: Strategy = Field(
        "median",
        json_schema_extra={
            "x-widget": "radio-cards",
            "x-descriptions": {
                "mean": "Column average. Sensitive to outliers and skew.",
                "median": "Middle value. Robust default for skewed numeric data.",
                "mode": "Most frequent value. Works for categories.",
                "constant": "A fixed value you choose, e.g. 0 or 'unknown'.",
                "ffill": "Carry the previous row forward. For ordered/time data only.",
                "knn": "Average of the k most similar rows. Uses the selected columns.",
                "iterative": "Models each column from the others (MICE-style).",
            },
        },
    )
    fill_value: float | int | str | bool | None = Field(None, title="Constant value")
    knn_neighbors: int = Field(5, ge=1, le=100)
    max_iter: int = Field(10, ge=1, le=100)
    seed: int | None = None

    @model_validator(mode="after")
    def _constant_needs_value(self) -> ImputeParams:
        if self.strategy == "constant" and self.fill_value is None:
            raise ValueError("strategy 'constant' requires fill_value")
        return self


def _impute_columns(params: ImputeParams, schema: TableSchema) -> list[ColumnSchema]:
    if params.columns:
        return resolve_columns(schema, params.columns)
    return [
        c
        for c in schema.columns
        if c.nullable and c.role == Role.FEATURE and (params.strategy not in NUMERIC_ONLY or c.is_numeric)
    ]


def _output_dtype(params: ImputeParams, col: ColumnSchema) -> str:
    if params.strategy in NUMERIC_ONLY:
        return "float64"
    value = params.fill_value
    if (
        params.strategy == "constant"
        and col.is_numeric
        and isinstance(value, float)
        and not value.is_integer()
    ):
        return "float64"
    return col.dtype


@register
class Impute(Node[ImputeParams]):
    """Fill missing values.

    Mean, median, mode, KNN and iterative imputation learn from data, so on a split they are
    fit on the train partition only and applied to every partition. Placing a learning
    imputer before ``prep.split`` is a leakage error.
    """

    type = "clean.impute"
    title = "Impute missing"
    category = "clean"
    Params = ImputeParams
    inputs = {"in": PortDef(TABLE_OR_SPLIT)}
    outputs = {"out": PortDef(TABLE_OR_SPLIT)}

    def learns_from_data(self, params: ImputeParams) -> bool:
        return params.strategy in LEARNED

    def propagate(
        self, params: ImputeParams, inputs: Mapping[str, PortSchema], ctx: CompileContext
    ) -> dict[str, PortSchema]:
        ps = inputs["in"]
        schema = ps.require_table()
        cols = _impute_columns(params, schema)
        if not cols:
            ctx.warn("NOTHING_TO_IMPUTE", "no nullable columns match this imputer")
        updated: dict[str, ColumnSchema] = {}
        for col in cols:
            if col.is_temporal:
                raise NodeCompileError(
                    "SCHEMA_MISMATCH", f"clean.impute does not support temporal column '{col.name}'"
                )
            if params.strategy in NUMERIC_ONLY and not col.is_numeric:
                raise NodeCompileError(
                    "SCHEMA_MISMATCH",
                    f"clean.impute strategy '{params.strategy}' needs numeric columns; "
                    f"'{col.name}' is {col.semantic.value}",
                    "Use strategy 'mode' or 'constant' for this column",
                )
            if params.strategy == "constant":
                _check_constant(col, params.fill_value)
            if col.role == Role.TARGET:
                ctx.warn("IMPUTING_TARGET", f"imputing the target column '{col.name}'")
            if col.null_frac == 1.0:
                ctx.warn("ALL_NULL_COLUMN", f"'{col.name}' is entirely null")
            learned = params.strategy in LEARNED
            categories = col.categories
            if params.strategy == "constant" and categories is not None:
                categories = sorted({*categories, str(params.fill_value)})
            updated[col.name] = col.derive(
                dtype=_output_dtype(params, col),
                nullable=params.strategy == "ffill",
                null_frac=None if params.strategy == "ffill" else 0.0,
                stats=None,
                class_balance=None,
                categories=None if params.strategy in NUMERIC_ONLY else categories,
                cardinality=col.cardinality if not learned else None,
            )
        return {"out": ps.with_table(replace_columns(derived_table(schema), updated))}

    def execute(self, params: ImputeParams, inputs: Mapping[str, Any], ctx: ExecContext) -> dict[str, Any]:
        in_schema = ctx.input_table()
        out_schema = ctx.output_schemas["out"].require_table()
        cols = [c.name for c in _impute_columns(params, in_schema)]
        value = inputs["in"]
        casts = [pl.col(c).cast(POLARS_DTYPES[_dtype(out_schema, c)]) for c in cols]
        train = fit_frame(value).with_columns(casts)
        strategy = params.strategy

        if strategy in ("mean", "median", "mode"):
            fills: dict[str, Any] = {}
            for c in cols:
                s = train[c].drop_nulls()
                if s.len() == 0:
                    ctx.warn("ALL_NULL_IN_FIT", f"'{c}' has no values to learn from; left as is")
                    continue
                if strategy == "mean":
                    fills[c] = s.mean()
                elif strategy == "median":
                    fills[c] = s.median()
                else:
                    fills[c] = s.mode().sort()[0]

            def apply(df: pl.DataFrame) -> pl.DataFrame:
                df = df.with_columns(casts)
                return df.with_columns(
                    [
                        pl.col(c).fill_null(pl.lit(v, dtype=POLARS_DTYPES[_dtype(out_schema, c)]))
                        for c, v in fills.items()
                    ]
                )

        elif strategy == "constant":
            fill = params.fill_value

            def apply(df: pl.DataFrame) -> pl.DataFrame:
                df = df.with_columns(casts)
                return df.with_columns(
                    [
                        pl.col(c).fill_null(pl.lit(fill, dtype=POLARS_DTYPES[_dtype(out_schema, c)]))
                        for c in cols
                    ]
                )

        elif strategy == "ffill":

            def apply(df: pl.DataFrame) -> pl.DataFrame:
                return df.with_columns(casts).with_columns([pl.col(c).forward_fill() for c in cols])

        else:
            x_train = train.select(cols).to_numpy().astype(float) if cols else np.empty((0, 0))
            usable = [c for i, c in enumerate(cols) if x_train.size and not np.isnan(x_train[:, i]).all()]
            for c in cols:
                if c not in usable:
                    ctx.warn("ALL_NULL_IN_FIT", f"'{c}' has no values to learn from; left as is")
            imputer: Any = None
            if usable and train.height:
                seed = params.seed if params.seed is not None else ctx.seed
                imputer = (
                    KNNImputer(n_neighbors=min(params.knn_neighbors, train.height))
                    if strategy == "knn"
                    else IterativeImputer(random_state=seed, max_iter=params.max_iter)
                )
                imputer.fit(train.select(usable).to_numpy().astype(float))

            def apply(df: pl.DataFrame) -> pl.DataFrame:
                df = df.with_columns(casts)
                if imputer is None or df.height == 0:
                    return df
                y = imputer.transform(df.select(usable).to_numpy().astype(float))
                return df.with_columns(
                    [pl.Series(c, y[:, i], dtype=pl.Float64) for i, c in enumerate(usable)]
                )

        return {"out": map_frames(value, apply)}


def _dtype(schema: TableSchema, name: str) -> str:
    col = schema.column(name)
    assert col is not None
    return col.dtype


def _check_constant(col: ColumnSchema, value: Any) -> None:
    ok = (
        (col.is_numeric and isinstance(value, int | float) and not isinstance(value, bool))
        or (col.is_bool and isinstance(value, bool))
        or (col.dtype == "string" and isinstance(value, str))
    )
    if col.is_numeric and col.dtype.startswith(("int", "uint")) and isinstance(value, float):
        ok = ok and value.is_integer()
    if not ok:
        raise NodeCompileError(
            "SCHEMA_MISMATCH",
            f"fill_value {value!r} does not match the {col.dtype} column '{col.name}'",
            "Use a fill_value of the column's type",
        )
