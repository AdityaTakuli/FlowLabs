"""Runtime payloads carried on ports during execution."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

import polars as pl


@dataclass
class SplitTables:
    """Payload of a ``table_split`` port. Partition order is significant."""

    parts: dict[str, pl.DataFrame]

    @property
    def train(self) -> pl.DataFrame:
        return self.parts["train"]

    def map(self, fn: Any) -> SplitTables:
        return SplitTables({name: fn(df) for name, df in self.parts.items()})


@dataclass
class FittedModel:
    """Payload of a ``model`` port."""

    estimator: Any
    task: Literal["classification", "regression"]
    algorithm: str
    target: str
    features: list[str]
    classes: list[str] | None = None
    fit_rows: int = 0
    meta: dict[str, Any] = field(default_factory=dict)
