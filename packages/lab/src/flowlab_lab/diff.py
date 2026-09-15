"""Structural diff of the data at two points in a pipeline (PRD II 8.2)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

TABULAR = ("dataframe", "series", "ndarray")


def _rows(summary: dict[str, Any]) -> int | None:
    rows = summary.get("rows")
    return int(rows) if isinstance(rows, int) else None


def _nulls(summary: dict[str, Any]) -> int | None:
    if isinstance(summary.get("null_counts"), dict):
        return sum(int(v) for v in summary["null_counts"].values())
    value = summary.get("null_count")
    return int(value) if isinstance(value, int) else None


def _fmt_int(value: int | None) -> str:
    return "?" if value is None else f"{value:,}"


def _fmt_mb(value: Any) -> str:
    return "?" if not isinstance(value, int | float) else f"{value / 1_048_576:.1f} MB"


@dataclass
class DataDiff:
    label_a: str
    label_b: str
    kind_a: str | None
    kind_b: str | None
    rows_a: int | None
    rows_b: int | None
    columns_a: list[str]
    columns_b: list[str]
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    retyped: list[tuple[str, str, str]] = field(default_factory=list)
    nulls_a: int | None = None
    nulls_b: int | None = None
    memory_a: int | None = None
    memory_b: int | None = None
    same_content: bool | None = None

    @property
    def row_delta(self) -> int | None:
        if self.rows_a is None or self.rows_b is None:
            return None
        return self.rows_b - self.rows_a

    def format(self) -> str:
        lines = [f"{self.label_a} → {self.label_b}"]
        if self.kind_a != self.kind_b:
            lines.append(f"Kind:     {self.kind_a} → {self.kind_b}")
        delta = self.row_delta
        change = ""
        if delta is not None:
            percent = f", {delta / self.rows_a:+.1%}" if self.rows_a else ""
            change = f"   ({delta:+,}{percent})"
        lines.append(f"Rows:     {_fmt_int(self.rows_a)} → {_fmt_int(self.rows_b)}{change}")
        if self.columns_a or self.columns_b:
            column_delta = len(self.columns_b) - len(self.columns_a)
            lines.append(f"Columns:  {len(self.columns_a)} → {len(self.columns_b)}   ({column_delta:+})")
            if self.added:
                lines.append(
                    f"  added:    {', '.join(self.added[:12])}{' …' if len(self.added) > 12 else ''}"
                )
            if self.removed:
                lines.append(
                    f"  removed:  {', '.join(self.removed[:12])}{' …' if len(self.removed) > 12 else ''}"
                )
            for column, before, after in self.retyped[:12]:
                lines.append(f"  retyped:  {column}: {before} → {after}")
        lines.append(f"Nulls:    {_fmt_int(self.nulls_a)} → {_fmt_int(self.nulls_b)}")
        lines.append(f"Memory:   {_fmt_mb(self.memory_a)} → {_fmt_mb(self.memory_b)}")
        if self.same_content is not None:
            lines.append("Content:  identical" if self.same_content else "Content:  changed")
        return "\n".join(lines)


def diff_summaries(
    a: dict[str, Any], b: dict[str, Any], *, label_a: str = "a", label_b: str = "b"
) -> DataDiff:
    columns_a = [str(c) for c in a.get("columns") or []]
    columns_b = [str(c) for c in b.get("columns") or []]
    dtypes_a: dict[str, str] = a.get("dtypes") or {}
    dtypes_b: dict[str, str] = b.get("dtypes") or {}
    hash_a, hash_b = a.get("hash"), b.get("hash")
    return DataDiff(
        label_a=label_a,
        label_b=label_b,
        kind_a=a.get("kind"),
        kind_b=b.get("kind"),
        rows_a=_rows(a),
        rows_b=_rows(b),
        columns_a=columns_a,
        columns_b=columns_b,
        added=[c for c in columns_b if c not in columns_a],
        removed=[c for c in columns_a if c not in columns_b],
        retyped=[
            (c, dtypes_a[c], dtypes_b[c])
            for c in columns_b
            if c in dtypes_a and c in dtypes_b and dtypes_a[c] != dtypes_b[c]
        ],
        nulls_a=_nulls(a),
        nulls_b=_nulls(b),
        memory_a=a.get("memory_bytes"),
        memory_b=b.get("memory_bytes"),
        same_content=(hash_a == hash_b) if hash_a and hash_b else None,
    )


def pick_variables(
    after_a: dict[str, dict[str, Any]], after_b: dict[str, dict[str, Any]], variable: str | None = None
) -> tuple[str, str] | None:
    """Choose what to compare: an explicit variable, a shared tabular name, or the largest table."""
    if variable:
        return (variable, variable) if variable in after_a and variable in after_b else None

    def tabular(summaries: dict[str, dict[str, Any]]) -> list[str]:
        names = [n for n, s in summaries.items() if s.get("kind") in TABULAR]
        return sorted(names, key=lambda n: -(summaries[n].get("rows") or 0))

    shared = [n for n in tabular(after_b) if n in tabular(after_a)]
    if shared:
        return shared[0], shared[0]
    left, right = tabular(after_a), tabular(after_b)
    return (left[0], right[0]) if left and right else None
