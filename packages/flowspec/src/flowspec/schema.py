"""Dataset schema contract (PRD Section 6.4) and typed port payload descriptions."""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .models import PortType

NUMERIC_DTYPES = frozenset(
    {"int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64", "float32", "float64"}
)
INTEGER_DTYPES = frozenset(d for d in NUMERIC_DTYPES if "int" in d)
TEMPORAL_DTYPES = frozenset({"date", "datetime", "time", "duration"})


class Semantic(StrEnum):
    NUMERIC_CONTINUOUS = "numeric_continuous"
    NUMERIC_DISCRETE = "numeric_discrete"
    CATEGORICAL_NOMINAL = "categorical_nominal"
    CATEGORICAL_ORDINAL = "categorical_ordinal"
    BINARY = "binary"
    DATETIME = "datetime"
    TEXT_FREE = "text_free"
    IDENTIFIER = "identifier"
    GEO = "geo"


class Role(StrEnum):
    FEATURE = "feature"
    TARGET = "target"
    IDENTIFIER = "identifier"
    IGNORE = "ignore"


class ColumnStats(BaseModel):
    model_config = ConfigDict(extra="forbid")

    min: float | None = None
    max: float | None = None
    mean: float | None = None
    std: float | None = None
    median: float | None = None
    skew: float | None = None


class ColumnSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    dtype: str
    role: Role = Role.FEATURE
    semantic: Semantic
    nullable: bool = True
    null_frac: float | None = None
    cardinality: int | None = None
    stats: ColumnStats | None = None
    categories: list[str] | None = None
    class_balance: dict[str, float] | None = None

    @property
    def is_numeric(self) -> bool:
        return self.dtype in NUMERIC_DTYPES

    @property
    def is_bool(self) -> bool:
        return self.dtype == "bool"

    @property
    def is_temporal(self) -> bool:
        return self.dtype in TEMPORAL_DTYPES

    def derive(self, **changes: Any) -> ColumnSchema:
        return self.model_copy(update=changes)


class TableSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")

    columns: list[ColumnSchema]
    row_count: int | None = None
    content_hash: str | None = None

    @property
    def names(self) -> list[str]:
        return [c.name for c in self.columns]

    def column(self, name: str) -> ColumnSchema | None:
        for c in self.columns:
            if c.name == name:
                return c
        return None

    def targets(self) -> list[ColumnSchema]:
        return [c for c in self.columns if c.role == Role.TARGET]


class ModelSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task: Literal["classification", "regression"]
    algorithm: str
    target: str
    features: list[str]
    classes: list[str] | None = None
    positive_class: str | None = None


class PortSchema(BaseModel):
    """Static description of what flows through a port, computed by type propagation."""

    model_config = ConfigDict(extra="forbid")

    kind: PortType
    table: TableSchema | None = None
    partitions: list[str] | None = None
    partition_rows: dict[str, int] | None = None
    model: ModelSchema | None = None

    @classmethod
    def of_table(cls, table: TableSchema) -> PortSchema:
        return cls(kind=PortType.TABLE, table=table)

    @classmethod
    def of_split(cls, table: TableSchema, partitions: list[str], rows: dict[str, int] | None) -> PortSchema:
        return cls(kind=PortType.TABLE_SPLIT, table=table, partitions=partitions, partition_rows=rows)

    @classmethod
    def of_kind(cls, kind: PortType) -> PortSchema:
        return cls(kind=kind)

    @classmethod
    def of_model(cls, model: ModelSchema) -> PortSchema:
        return cls(kind=PortType.MODEL, model=model)

    def with_table(self, table: TableSchema) -> PortSchema:
        return self.model_copy(update={"table": table})

    def require_table(self) -> TableSchema:
        if self.table is None:
            raise ValueError(f"port of kind {self.kind} carries no table schema")
        return self.table


class ColumnRef(BaseModel):
    """Convenience for JSON-Schema consumers; not used by the engine directly."""

    name: str = Field(min_length=1)
