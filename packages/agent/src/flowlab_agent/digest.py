"""Compact, deterministic dataset summary for the LLM prompt (no raw rows, ever)."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from flowlab_nodes import infer_table_schema, read_table
from flowspec import Semantic, TableSchema

KINDS = {
    Semantic.NUMERIC_CONTINUOUS: "num",
    Semantic.NUMERIC_DISCRETE: "int",
    Semantic.CATEGORICAL_NOMINAL: "cat",
    Semantic.CATEGORICAL_ORDINAL: "cat",
    Semantic.BINARY: "bin",
    Semantic.DATETIME: "date",
    Semantic.TEXT_FREE: "text",
    Semantic.IDENTIFIER: "id",
    Semantic.GEO: "geo",
}
MAX_LISTED_COLUMNS = 40


@dataclass(frozen=True)
class ColumnInfo:
    name: str
    kind: str
    null_pct: float
    cardinality: int | None

    def text(self) -> str:
        out = f"{self.name}:{self.kind}"
        if self.kind in ("cat", "bin", "int") and self.cardinality is not None:
            out += f"({self.cardinality})"
        if self.null_pct:
            out += f",{self.null_pct:g}%null"
        return out


@dataclass(frozen=True)
class DatasetDigest:
    path: Path
    row_count: int
    columns: tuple[ColumnInfo, ...]

    @classmethod
    def from_schema(cls, path: Path, schema: TableSchema) -> DatasetDigest:
        columns = tuple(
            ColumnInfo(
                name=c.name,
                kind=KINDS.get(c.semantic, "num"),
                null_pct=round(100 * (c.null_frac or 0.0), 1),
                cardinality=c.cardinality,
            )
            for c in schema.columns
        )
        return cls(path=path, row_count=schema.row_count or 0, columns=columns)

    @classmethod
    def from_file(cls, path: Path) -> DatasetDigest:
        if path.suffix.lower() in (".xlsx", ".xls"):
            import pandas as pd
            import polars as pl

            frame = pl.from_pandas(pd.read_excel(path))
        else:
            frame = read_table(path)
        return cls.from_schema(path, infer_table_schema(frame))

    @property
    def names(self) -> list[str]:
        return [c.name for c in self.columns]

    def column(self, name: str) -> ColumnInfo | None:
        return next((c for c in self.columns if c.name == name), None)

    def task_for(self, target: str) -> str | None:
        col = self.column(target)
        if col is None:
            return None
        if col.kind in ("bin", "cat") or (col.kind == "int" and (col.cardinality or 0) <= 10):
            return "classification"
        if col.kind in ("num", "int"):
            return "regression"
        return None

    @property
    def signals(self) -> set[str]:
        kinds = {c.kind for c in self.columns}
        found = set()
        if any(c.null_pct for c in self.columns):
            found.add("has_nulls")
        if "cat" in kinds:
            found.add("has_categorical")
        if "date" in kinds:
            found.add("has_datetime")
        if "text" in kinds:
            found.add("has_text")
        if len(self.columns) > 60:
            found.add("wide")
        return found

    def text(self) -> str:
        listed = self.columns[:MAX_LISTED_COLUMNS]
        parts = [f"rows={self.row_count}", *(c.text() for c in listed)]
        rest = self.columns[MAX_LISTED_COLUMNS:]
        if rest:
            counts = Counter(c.kind for c in rest)
            parts.append(
                f"+{len(rest)} more (" + ", ".join(f"{k}:{n}" for k, n in sorted(counts.items())) + ")"
            )
        return " | ".join(parts)
