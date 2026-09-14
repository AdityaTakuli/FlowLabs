"""FlowLab Flow Spec: the contract shared by UI, agent, compiler and runners."""

from __future__ import annotations

import json
from typing import Any

from .hashing import canonical_json, sha256_bytes, sha256_text, to_jsonable
from .models import SPEC_VERSION, EdgeSpec, FlowMeta, FlowSpec, NodeSpec, PortType, Position
from .plan import (
    CompileIssue,
    CompileResult,
    ExecutionPlan,
    PlanStep,
    RunEvent,
    RunEventType,
    StepInput,
)
from .schema import (
    INTEGER_DTYPES,
    NUMERIC_DTYPES,
    TEMPORAL_DTYPES,
    ColumnSchema,
    ColumnStats,
    ModelSchema,
    PortSchema,
    Role,
    Semantic,
    TableSchema,
)


def flow_spec_json_schema() -> dict[str, Any]:
    return FlowSpec.model_json_schema()


def load_flow_spec(text: str) -> FlowSpec:
    return FlowSpec.model_validate(json.loads(text))


__all__ = [
    "INTEGER_DTYPES",
    "NUMERIC_DTYPES",
    "SPEC_VERSION",
    "TEMPORAL_DTYPES",
    "ColumnSchema",
    "ColumnStats",
    "CompileIssue",
    "CompileResult",
    "EdgeSpec",
    "ExecutionPlan",
    "FlowMeta",
    "FlowSpec",
    "ModelSchema",
    "NodeSpec",
    "PlanStep",
    "PortSchema",
    "PortType",
    "Position",
    "Role",
    "RunEvent",
    "RunEventType",
    "Semantic",
    "StepInput",
    "TableSchema",
    "canonical_json",
    "flow_spec_json_schema",
    "load_flow_spec",
    "sha256_bytes",
    "sha256_text",
    "to_jsonable",
]
