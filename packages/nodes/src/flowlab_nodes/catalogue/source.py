from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from flowspec import PortSchema, PortType, Role, Semantic
from pydantic import BaseModel, ConfigDict, Field

from ..base import CompileContext, ExecContext, Node, NodeCompileError, NodeRuntimeError, PortDef
from ..common import resolve_columns
from ..io import read_table, table_hash
from ..registry import register


class DatasetParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dataset_ref: str = Field(
        min_length=1,
        title="Dataset",
        description="Logical dataset name declared in the flow's dataset_bindings.",
        json_schema_extra={"x-widget": "dataset-select"},
    )
    target: str | None = Field(
        None,
        title="Target column",
        description="Marks this column with role 'target' for downstream modelling.",
        json_schema_extra={"x-widget": "column-select"},
    )
    semantic_overrides: dict[str, Semantic] = Field(
        default_factory=dict,
        title="Semantic overrides",
        description="Correct inferred semantics, e.g. an integer that is really a category.",
    )
    role_overrides: dict[str, Role] = Field(
        default_factory=dict,
        title="Role overrides",
        description="Set a column's role to feature, target, identifier or ignore.",
    )


@register
class SourceDataset(Node[DatasetParams]):
    """Load a registered dataset.

    The output schema is the dataset's inferred schema with any semantic and role
    overrides applied. Use ``target`` to declare what a model should predict and
    ``role_overrides`` to exclude columns (``ignore``) from default feature sets.
    """

    type = "source.dataset"
    title = "Dataset"
    category = "source"
    Params = DatasetParams
    inputs = {}
    outputs = {"out": PortDef((PortType.TABLE,), description="The loaded table")}

    def cache_inputs(self, params: DatasetParams, ctx: CompileContext) -> list[str]:
        return [ctx.dataset_schema(params.dataset_ref).content_hash or ""]

    def propagate(
        self, params: DatasetParams, inputs: Mapping[str, PortSchema], ctx: CompileContext
    ) -> dict[str, PortSchema]:
        schema = ctx.dataset_schema(params.dataset_ref)
        referenced = [*params.semantic_overrides, *params.role_overrides]
        if params.target:
            referenced.append(params.target)
        resolve_columns(schema, referenced)

        columns = []
        for col in schema.columns:
            update: dict[str, Any] = {}
            if col.name in params.semantic_overrides:
                update["semantic"] = params.semantic_overrides[col.name]
                if update["semantic"] == Semantic.IDENTIFIER:
                    update["role"] = Role.IDENTIFIER
                elif col.role == Role.IDENTIFIER:
                    update["role"] = Role.FEATURE
            if col.name in params.role_overrides:
                update["role"] = params.role_overrides[col.name]
            if params.target == col.name:
                if col.semantic in (Semantic.IDENTIFIER, Semantic.TEXT_FREE, Semantic.DATETIME) and (
                    col.name not in params.semantic_overrides
                ):
                    raise NodeCompileError(
                        "TARGET_INVALID",
                        f"'{col.name}' is {col.semantic} and cannot be a prediction target",
                        "Choose another target or override its semantic type",
                    )
                update["role"] = Role.TARGET
            columns.append(col.derive(**update) if update else col)
        return {"out": PortSchema.of_table(schema.model_copy(update={"columns": columns}))}

    def execute(self, params: DatasetParams, inputs: Mapping[str, Any], ctx: ExecContext) -> dict[str, Any]:
        path = ctx.dataset_paths.get(params.dataset_ref)
        if path is None:
            raise NodeRuntimeError("DATASET_NOT_FOUND", f"no file for '{params.dataset_ref}'")
        df = read_table(path)
        expected = ctx.dataset_hashes.get(params.dataset_ref)
        if expected and table_hash(df) != expected:
            raise NodeRuntimeError(
                "DATASET_CHANGED",
                f"dataset '{params.dataset_ref}' changed since the flow was compiled; recompile",
            )
        return {"out": df}
