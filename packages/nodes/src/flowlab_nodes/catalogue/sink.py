from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path, PurePosixPath
from typing import Any, Literal

import polars as pl
from flowspec import PortSchema, sha256_bytes
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..base import CompileContext, ExecContext, Node, NodeRuntimeError, PortDef
from ..common import TABLE_OR_SPLIT
from ..io import table_to_parquet_bytes
from ..registry import register
from ..runtime_types import SplitTables


class ExportParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    format: Literal["parquet", "csv"] = "parquet"
    destination: Literal["local"] = Field("local", description="Phase 0 supports local only.")
    path: str = Field(
        min_length=1,
        max_length=200,
        pattern=r"^[A-Za-z0-9_\-./]+$",
        description="Relative path inside the export directory. Extension is optional.",
    )

    @field_validator("path")
    @classmethod
    def _relative(cls, value: str) -> str:
        p = PurePosixPath(value)
        if p.is_absolute() or ".." in p.parts:
            raise ValueError("path must be relative and must not contain '..'")
        return value


@register
class Export(Node[ExportParams]):
    """Write a table (or each partition of a split) to storage.

    Sinks always run, even when their inputs are cached, so the file is guaranteed to exist
    after every run.
    """

    type = "sink.export"
    title = "Export"
    category = "sink"
    Params = ExportParams
    inputs = {"in": PortDef(TABLE_OR_SPLIT)}
    outputs = {}
    cacheable = False

    def propagate(
        self, params: ExportParams, inputs: Mapping[str, PortSchema], ctx: CompileContext
    ) -> dict[str, PortSchema]:
        return {}

    def execute(self, params: ExportParams, inputs: Mapping[str, Any], ctx: ExecContext) -> dict[str, Any]:
        value = inputs["in"]
        stem = params.path
        for ext in (".parquet", ".csv"):
            stem = stem.removesuffix(ext)
        frames = (
            {f"{stem}_{name}": df for name, df in value.parts.items()}
            if isinstance(value, SplitTables)
            else {stem: value}
        )
        root = ctx.export_dir.resolve()
        for rel, df in frames.items():
            target = (root / f"{rel}.{params.format}").resolve()
            if not target.is_relative_to(root):
                raise NodeRuntimeError("PATH_ESCAPE", f"export path escapes the export directory: {rel}")
            data = _encode(df, params.format)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            ctx.on_file(Path(target), sha256_bytes(data))
        return {}


def _encode(df: pl.DataFrame, fmt: str) -> bytes:
    if fmt == "parquet":
        return table_to_parquet_bytes(df)
    return df.write_csv().encode("utf-8")
