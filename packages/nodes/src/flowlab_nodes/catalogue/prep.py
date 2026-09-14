from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any, Literal

import numpy as np
import polars as pl
from flowspec import ColumnSchema, PortSchema, PortType, Role, Semantic, TableSchema
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sklearn.model_selection import GroupShuffleSplit, train_test_split
from sklearn.preprocessing import MinMaxScaler, QuantileTransformer, RobustScaler, StandardScaler

from ..base import CompileContext, ExecContext, Node, NodeCompileError, NodeRuntimeError, PortDef
from ..common import (
    TABLE_ONLY,
    TABLE_OR_SPLIT,
    derived_table,
    fit_frame,
    map_frames,
    replace_columns,
    resolve_columns,
    take_rows,
)
from ..registry import register
from ..runtime_types import SplitTables

# ---------------------------------------------------------------------------------- split


class SplitParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    test_size: float = Field(0.2, gt=0, lt=1, title="Test fraction")
    val_size: float = Field(0.0, ge=0, lt=1, title="Validation fraction")
    stratify_by: str | None = Field(
        None,
        title="Stratify by",
        description="Keep class proportions equal across partitions.",
        json_schema_extra={"x-widget": "column-select"},
    )
    group_by: str | None = Field(
        None,
        title="Group by",
        description="Keep all rows of a group (e.g. a customer) in the same partition.",
        json_schema_extra={"x-widget": "column-select"},
    )
    time_based: bool = Field(False, description="Train on earlier rows, test on later rows.")
    time_column: str | None = Field(None, json_schema_extra={"x-widget": "column-select"})
    seed: int | None = None

    @model_validator(mode="after")
    def _consistent(self) -> SplitParams:
        if self.test_size + self.val_size >= 1:
            raise ValueError("test_size + val_size must be below 1")
        if self.time_based and not self.time_column:
            raise ValueError("time_based requires time_column")
        if self.time_based and (self.stratify_by or self.group_by):
            raise ValueError("time_based cannot be combined with stratify_by or group_by")
        if self.stratify_by and self.group_by:
            raise ValueError("stratify_by and group_by are mutually exclusive")
        return self


def _sizes(n: int, params: SplitParams) -> tuple[int, int, int]:
    n_test = math.ceil(n * params.test_size)
    n_val = math.ceil(n * params.val_size) if params.val_size else 0
    return n - n_test - n_val, n_val, n_test


def _partitions(params: SplitParams) -> list[str]:
    return ["train", "val", "test"] if params.val_size else ["train", "test"]


@register
class Split(Node[SplitParams]):
    """Partition rows into train/test (and optionally validation).

    Everything that learns from data must sit after this node. Stratify on a classification
    target to keep class balance, group by an entity id when rows are not independent, and
    use a time-based split whenever rows are ordered in time.
    """

    type = "prep.split"
    title = "Train/test split"
    category = "prep"
    Params = SplitParams
    inputs = {"in": PortDef(TABLE_ONLY)}
    outputs = {"out": PortDef((PortType.TABLE_SPLIT,))}
    stochastic = True

    def propagate(
        self, params: SplitParams, inputs: Mapping[str, PortSchema], ctx: CompileContext
    ) -> dict[str, PortSchema]:
        schema = inputs["in"].require_table()
        if params.stratify_by:
            (col,) = resolve_columns(schema, [params.stratify_by])
            if col.semantic in (Semantic.NUMERIC_CONTINUOUS, Semantic.IDENTIFIER, Semantic.TEXT_FREE):
                raise NodeCompileError(
                    "SCHEMA_MISMATCH",
                    f"cannot stratify on '{col.name}' ({col.semantic.value})",
                    "Stratify on a categorical or binary column",
                )
        if params.group_by:
            resolve_columns(schema, [params.group_by])
        if params.time_based and params.time_column:
            (col,) = resolve_columns(schema, [params.time_column])
            if not (col.is_temporal or col.is_numeric):
                raise NodeCompileError(
                    "SCHEMA_MISMATCH",
                    f"time_column '{col.name}' must be a date, datetime or numeric column",
                    "Parse it with clean.datetime_parse first",
                )
        rows: dict[str, int] | None = None
        if schema.row_count is not None:
            n_train, n_val, n_test = _sizes(schema.row_count, params)
            if n_train < 1:
                raise NodeCompileError(
                    "SPLIT_TOO_SMALL",
                    f"{schema.row_count} rows leave no training rows at these fractions",
                )
            rows = {"train": n_train, "test": n_test}
            if params.val_size:
                rows["val"] = n_val
        return {"out": PortSchema.of_split(derived_table(schema), _partitions(params), rows)}

    def execute(self, params: SplitParams, inputs: Mapping[str, Any], ctx: ExecContext) -> dict[str, Any]:
        df: pl.DataFrame = inputs["in"]
        n = df.height
        n_train, n_val, n_test = _sizes(n, params)
        if n < 2 or n_train < 1:
            raise NodeRuntimeError("SPLIT_TOO_SMALL", f"cannot split {n} rows at these fractions")
        seed = params.seed if params.seed is not None else ctx.seed
        idx = np.arange(n)
        val_idx = np.array([], dtype=int)

        if params.time_based:
            assert params.time_column
            order = (
                df.select(pl.col(params.time_column))
                .with_row_index("__row")
                .sort([params.time_column, "__row"], nulls_last=True)["__row"]
                .to_numpy()
            )
            train_idx = order[:n_train]
            val_idx = order[n_train : n_train + n_val]
            test_idx = order[n_train + n_val :]
        elif params.group_by:
            groups = df[params.group_by].cast(pl.String).fill_null("__null__").to_numpy()
            gss = GroupShuffleSplit(n_splits=1, test_size=params.test_size, random_state=seed)
            rest, test_idx = next(gss.split(idx, groups=groups))
            train_idx = rest
            if params.val_size:
                rel = params.val_size / (1 - params.test_size)
                gss2 = GroupShuffleSplit(n_splits=1, test_size=rel, random_state=seed)
                tr, va = next(gss2.split(rest, groups=groups[rest]))
                train_idx, val_idx = rest[tr], rest[va]
            train_idx, val_idx, test_idx = np.sort(train_idx), np.sort(val_idx), np.sort(test_idx)
        else:
            strat = (
                df[params.stratify_by].cast(pl.String).fill_null("__null__").to_numpy()
                if params.stratify_by
                else None
            )
            try:
                rest, test_idx = train_test_split(idx, test_size=n_test, random_state=seed, stratify=strat)
                train_idx = rest
                if n_val:
                    train_idx, val_idx = train_test_split(
                        rest,
                        test_size=n_val,
                        random_state=seed,
                        stratify=strat[rest] if strat is not None else None,
                    )
            except ValueError as exc:
                raise NodeRuntimeError("SPLIT_FAILED", f"could not split: {exc}") from exc
            train_idx, val_idx, test_idx = np.sort(train_idx), np.sort(val_idx), np.sort(test_idx)

        parts = {"train": take_rows(df, train_idx)}
        if params.val_size:
            parts["val"] = take_rows(df, val_idx)
        parts["test"] = take_rows(df, test_idx)

        if df.width:
            train_hashes = set(parts["train"].hash_rows(seed=0).to_list())
            dupes = sum(1 for h in parts["test"].hash_rows(seed=0).to_list() if h in train_hashes)
            if dupes:
                ctx.warn(
                    "DUPLICATES_ACROSS_SPLITS",
                    f"{dupes} test rows also appear in train; metrics may be optimistic",
                )
        return {"out": SplitTables(parts)}


# --------------------------------------------------------------------------------- encode

EncodeMethod = Literal["onehot", "ordinal", "frequency", "target", "binary"]
MAX_ONEHOT = 50


class EncodeParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    columns: list[str] = Field(
        default_factory=list,
        title="Columns to encode",
        description="Empty means every categorical feature column.",
        json_schema_extra={
            "x-widget": "column-multiselect",
            "x-filter": {"semantic": ["categorical_nominal", "categorical_ordinal", "binary"]},
        },
    )
    method: EncodeMethod = Field(
        "onehot",
        json_schema_extra={
            "x-widget": "radio-cards",
            "x-descriptions": {
                "onehot": "One 0/1 column per category. Best for few categories.",
                "ordinal": "Integer code per category. Use when categories have an order.",
                "frequency": "Replace each category by how often it occurs in train.",
                "target": "Replace each category by its smoothed mean target in train.",
                "binary": "Category code written in bits. Compact for many categories.",
            },
        },
    )
    ordinal_order: dict[str, list[str]] = Field(
        default_factory=dict, description="Explicit category order per column for ordinal."
    )
    smoothing: float = Field(10.0, ge=0, description="Target encoding shrinkage toward the mean.")


def _encode_columns(params: EncodeParams, schema: TableSchema) -> list[ColumnSchema]:
    if params.columns:
        return resolve_columns(schema, params.columns)
    return [
        c
        for c in schema.columns
        if c.role == Role.FEATURE
        and (
            c.semantic in (Semantic.CATEGORICAL_NOMINAL, Semantic.CATEGORICAL_ORDINAL)
            or (c.semantic == Semantic.BINARY and c.dtype == "string")
        )
    ]


def _bits(n_categories: int) -> int:
    return max(1, math.ceil(math.log2(n_categories + 1)))


def _encoded_schema(params: EncodeParams, col: ColumnSchema) -> list[ColumnSchema]:
    base = {"role": Role.FEATURE, "nullable": False, "null_frac": 0.0, "stats": None, "class_balance": None}
    cats = col.categories or []
    if params.method == "onehot":
        return [
            ColumnSchema(
                name=f"{col.name}={c}",
                dtype="int8",
                semantic=Semantic.BINARY,
                cardinality=2,
                categories=["0", "1"],
                **base,
            )
            for c in cats
        ]
    if params.method == "binary":
        return [
            ColumnSchema(
                name=f"{col.name}_bin{i}",
                dtype="int8",
                semantic=Semantic.BINARY,
                cardinality=2,
                categories=["0", "1"],
                **base,
            )
            for i in range(_bits(len(cats)))
        ]
    if params.method == "ordinal":
        return [
            col.derive(
                dtype="int64", semantic=Semantic.NUMERIC_DISCRETE, categories=None, cardinality=None, **base
            )
        ]
    return [
        col.derive(
            dtype="float64", semantic=Semantic.NUMERIC_CONTINUOUS, categories=None, cardinality=None, **base
        )
    ]


def _positive_class(target: ColumnSchema) -> str | None:
    return target.categories[-1] if target.categories and len(target.categories) == 2 else None


@register
class Encode(Node[EncodeParams]):
    """Turn categorical columns into numbers a model can use.

    Encoders learn the category vocabulary (and, for target encoding, per-category target
    means) from the train partition only. One-hot columns are derived from the profiled
    category list so the output schema is known before execution; categories unseen in
    train encode as all zeros.
    """

    type = "prep.encode"
    title = "Encode categories"
    category = "prep"
    Params = EncodeParams
    inputs = {"in": PortDef(TABLE_OR_SPLIT)}
    outputs = {"out": PortDef(TABLE_OR_SPLIT)}

    def learns_from_data(self, params: EncodeParams) -> bool:
        return True

    def propagate(
        self, params: EncodeParams, inputs: Mapping[str, PortSchema], ctx: CompileContext
    ) -> dict[str, PortSchema]:
        ps = inputs["in"]
        schema = ps.require_table()
        cols = _encode_columns(params, schema)
        if not cols:
            ctx.warn("NOTHING_TO_ENCODE", "no categorical feature columns to encode")
        resolve_columns(schema, list(params.ordinal_order))
        encoded = {c.name for c in cols}
        for col in cols:
            if col.role == Role.TARGET:
                raise NodeCompileError(
                    "ENCODE_TARGET",
                    f"'{col.name}' is the target; models handle class labels directly",
                    f"Remove '{col.name}' from columns",
                )
            if col.semantic in (Semantic.NUMERIC_CONTINUOUS, Semantic.DATETIME, Semantic.TEXT_FREE):
                raise NodeCompileError(
                    "SCHEMA_MISMATCH",
                    f"prep.encode expects categorical columns; '{col.name}' is {col.semantic.value}",
                    "Use feature.binning for numeric columns, or override the semantic type",
                )
            if params.method in ("onehot", "binary") and col.categories is None:
                raise NodeCompileError(
                    "HIGH_CARDINALITY",
                    f"'{col.name}' has too many (or unknown) categories for {params.method} encoding",
                    "Use frequency or target encoding",
                )
            if params.method == "onehot" and len(col.categories or []) > 20:
                ctx.warn("WIDE_ONEHOT", f"one-hot on '{col.name}' adds {len(col.categories or [])} columns")
            if col.nullable:
                ctx.warn("NULLS_ENCODED", f"missing values in '{col.name}' encode as unknown")
        if params.method == "target" and cols:
            targets = schema.targets()
            if len(targets) != 1:
                raise NodeCompileError(
                    "TARGET_UNDEFINED",
                    "target encoding needs exactly one column with role 'target'",
                    "Set target on the dataset source",
                )
            t = targets[0]
            if not (t.is_numeric and t.semantic != Semantic.BINARY) and _positive_class(t) is None:
                raise NodeCompileError(
                    "UNSUPPORTED_TARGET",
                    "target encoding supports numeric or binary targets only",
                    "Use onehot or frequency encoding",
                )
        columns: list[ColumnSchema] = []
        for col in schema.columns:
            if col.name in encoded:
                columns.extend(_encoded_schema(params, col))
            else:
                columns.append(col)
        names = [c.name for c in columns]
        if len(set(names)) != len(names):
            raise NodeCompileError("DUPLICATE_COLUMN", "encoded column names collide with existing columns")
        return {"out": ps.with_table(derived_table(schema).model_copy(update={"columns": columns}))}

    def execute(self, params: EncodeParams, inputs: Mapping[str, Any], ctx: ExecContext) -> dict[str, Any]:
        schema = ctx.input_table()
        out_names = ctx.output_schemas["out"].require_table().names
        cols = _encode_columns(params, schema)
        value = inputs["in"]
        train = fit_frame(value)
        exprs: list[pl.Expr] = []
        for col in cols:
            s = pl.col(col.name).cast(pl.String)
            vocab = sorted({str(v) for v in train[col.name].cast(pl.String).drop_nulls().unique().to_list()})
            if params.method == "onehot":
                for cat in col.categories or []:
                    name = f"{col.name}={cat}"
                    exprs.append(
                        (
                            (s == cat).fill_null(False).cast(pl.Int8) if cat in vocab else pl.lit(0, pl.Int8)
                        ).alias(name)
                    )
            elif params.method in ("ordinal", "binary"):
                order = params.ordinal_order.get(col.name) or vocab
                offset = 0 if params.method == "ordinal" else 1
                mapping = {cat: i + offset for i, cat in enumerate(order)}
                unknown = -1 if params.method == "ordinal" else 0
                codes = s.replace_strict(mapping, default=unknown, return_dtype=pl.Int64).fill_null(unknown)
                if params.method == "ordinal":
                    exprs.append(codes.alias(col.name))
                else:
                    for bit in range(_bits(len(col.categories or []))):
                        exprs.append(((codes // (2**bit)) % 2).cast(pl.Int8).alias(f"{col.name}_bin{bit}"))
            elif params.method == "frequency":
                n = max(train.height, 1)
                freq = {
                    str(k): cnt / n
                    for k, cnt in train[col.name].cast(pl.String).drop_nulls().value_counts().iter_rows()
                }
                exprs.append(
                    s.replace_strict(freq, default=0.0, return_dtype=pl.Float64)
                    .fill_null(0.0)
                    .alias(col.name)
                )
            else:
                target = schema.targets()[0]
                pos = _positive_class(target)
                y = (
                    (pl.col(target.name).cast(pl.String) == pos).cast(pl.Float64)
                    if pos is not None
                    else pl.col(target.name).cast(pl.Float64)
                )
                stats = (
                    train.filter(pl.col(target.name).is_not_null())
                    .select(s.alias("__cat"), y.alias("__y"))
                    .drop_nulls("__cat")
                )
                global_mean = float(stats["__y"].mean() or 0.0) if stats.height else 0.0  # type: ignore[arg-type]
                grouped = stats.group_by("__cat").agg(pl.col("__y").sum().alias("s"), pl.len().alias("n"))
                m = params.smoothing
                enc = {
                    str(row[0]): (row[1] + m * global_mean) / (row[2] + m) if row[2] + m else global_mean
                    for row in grouped.iter_rows()
                }
                exprs.append(
                    s.replace_strict(enc, default=global_mean, return_dtype=pl.Float64)
                    .fill_null(global_mean)
                    .alias(col.name)
                )

        def apply(df: pl.DataFrame) -> pl.DataFrame:
            return df.with_columns(exprs).select(out_names) if exprs else df

        return {"out": map_frames(value, apply)}


# ---------------------------------------------------------------------------------- scale

ScaleMethod = Literal["standard", "minmax", "robust", "quantile"]


class ScaleParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    columns: list[str] = Field(
        default_factory=list,
        title="Columns to scale",
        description="Empty means every non-binary numeric feature column.",
        json_schema_extra={
            "x-widget": "column-multiselect",
            "x-filter": {"semantic": ["numeric_continuous", "numeric_discrete"]},
        },
    )
    method: ScaleMethod = Field(
        "standard",
        json_schema_extra={
            "x-widget": "radio-cards",
            "x-descriptions": {
                "standard": "Mean 0, SD 1. Default choice for most models.",
                "minmax": "Rescale to the 0-1 range. Sensitive to outliers.",
                "robust": "Uses median and IQR — better when outliers are present.",
                "quantile": "Maps values to their train quantile. Removes skew entirely.",
            },
        },
    )
    seed: int | None = None


def _scale_columns(params: ScaleParams, schema: TableSchema) -> list[ColumnSchema]:
    if params.columns:
        return resolve_columns(schema, params.columns)
    return [
        c
        for c in schema.columns
        if c.role == Role.FEATURE
        and c.is_numeric
        and c.semantic in (Semantic.NUMERIC_CONTINUOUS, Semantic.NUMERIC_DISCRETE)
    ]


@register
class Scale(Node[ScaleParams]):
    """Rescale numeric columns.

    Scalers learn centre and spread from the train partition only and apply the same
    transform to every partition. Distance-based and linear models benefit; tree models
    do not need scaling.
    """

    type = "prep.scale"
    title = "Scale numeric"
    category = "prep"
    Params = ScaleParams
    inputs = {"in": PortDef(TABLE_OR_SPLIT)}
    outputs = {"out": PortDef(TABLE_OR_SPLIT)}

    def learns_from_data(self, params: ScaleParams) -> bool:
        return True

    def propagate(
        self, params: ScaleParams, inputs: Mapping[str, PortSchema], ctx: CompileContext
    ) -> dict[str, PortSchema]:
        ps = inputs["in"]
        schema = ps.require_table()
        cols = _scale_columns(params, schema)
        if not cols:
            ctx.warn("NOTHING_TO_SCALE", "no numeric feature columns to scale")
        updated: dict[str, ColumnSchema] = {}
        for col in cols:
            if not col.is_numeric:
                raise NodeCompileError(
                    "SCHEMA_MISMATCH",
                    f"prep.scale expects numeric columns; '{col.name}' is {col.semantic.value}",
                    f"Insert prep.encode before prep.scale, or remove '{col.name}' from columns",
                )
            if col.role == Role.TARGET:
                ctx.warn("SCALING_TARGET", f"scaling the target column '{col.name}'")
            updated[col.name] = col.derive(
                dtype="float64",
                semantic=Semantic.NUMERIC_CONTINUOUS,
                stats=None,
                categories=None,
                class_balance=None,
                cardinality=None,
            )
        return {"out": ps.with_table(replace_columns(derived_table(schema), updated))}

    def execute(self, params: ScaleParams, inputs: Mapping[str, Any], ctx: ExecContext) -> dict[str, Any]:
        cols = [c.name for c in _scale_columns(params, ctx.input_table())]
        value = inputs["in"]
        if not cols:
            return {"out": value}
        train = fit_frame(value)
        if train.height == 0:
            raise NodeRuntimeError("EMPTY_TRAINING_DATA", "cannot fit a scaler on zero rows")
        seed = params.seed if params.seed is not None else ctx.seed
        scaler: Any = {
            "standard": StandardScaler(),
            "minmax": MinMaxScaler(),
            "robust": RobustScaler(),
            "quantile": QuantileTransformer(n_quantiles=min(1000, train.height), random_state=seed),
        }[params.method]
        scaler.fit(train.select(cols).cast(pl.Float64).to_numpy())

        def apply(df: pl.DataFrame) -> pl.DataFrame:
            x = df.select(cols).cast(pl.Float64).to_numpy()
            y = scaler.transform(x) if df.height else x
            return df.with_columns(
                [pl.Series(c, y[:, i], dtype=pl.Float64).fill_nan(None) for i, c in enumerate(cols)]
            )

        return {"out": map_frames(value, apply)}
