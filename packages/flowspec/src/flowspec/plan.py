"""Compiler output contracts (PRD Section 8.1) and run events (Section 8.3)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .schema import PortSchema


class CompileIssue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    node_id: str | None
    code: str
    severity: Literal["error", "warning"]
    message: str
    suggestion: str | None = None


class StepInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    node_id: str
    port: str


class PlanStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: int
    node_id: str
    node_type: str
    label: str | None = None
    params: dict[str, Any]
    inputs: dict[str, StepInput]
    input_schemas: dict[str, PortSchema]
    output_schemas: dict[str, PortSchema]
    cache_key: str
    cacheable: bool = True


class ExecutionPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plan_version: Literal["1"] = "1"
    flow_id: str
    flow_name: str
    spec_hash: str
    seed: int
    runner_version: str
    dataset_bindings: dict[str, str]
    dataset_hashes: dict[str, str]
    steps: list[PlanStep]
    warnings: list[CompileIssue] = Field(default_factory=list)


class CompileResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok: bool
    errors: list[CompileIssue] = Field(default_factory=list)
    warnings: list[CompileIssue] = Field(default_factory=list)
    plan: ExecutionPlan | None = None


RunEventType = Literal[
    "run_started",
    "node_started",
    "node_progress",
    "node_log",
    "node_warning",
    "node_completed",
    "node_failed",
    "artifact_written",
    "run_completed",
    "run_failed",
    "run_cancelled",
]


class RunEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    run_id: str
    seq: int
    type: RunEventType
    ts: str
    node_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
