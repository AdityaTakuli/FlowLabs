"""Flow Spec models (PRD Section 6). The single source of truth for the spec shape."""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field

from .hashing import canonical_json, sha256_text

SPEC_VERSION: Final = "1.0"


class PortType(StrEnum):
    TABLE = "table"
    TABLE_SPLIT = "table_split"
    MODEL = "model"
    TRANSFORMER = "transformer"
    METRICS = "metrics"
    CHART = "chart"
    REPORT = "report"


class Position(BaseModel):
    """Canvas position. UI-only: never affects execution or cache keys."""

    model_config = ConfigDict(extra="forbid")

    x: float = 0.0
    y: float = 0.0


class NodeSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=64)
    type: str = Field(min_length=1)
    label: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    position: Position = Field(default_factory=Position)


class EdgeSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    source: str
    source_port: str = "out"
    target: str
    target_port: str = "in"


class FlowMeta(BaseModel):
    model_config = ConfigDict(extra="allow")

    seed: int = 42
    generated_from_prompt: str | None = None
    agent_plan: str | None = None


class FlowSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    spec_version: Literal["1.0"] = SPEC_VERSION
    flow_id: str = Field(min_length=1)
    name: str
    description: str = ""
    created_by: Literal["agent", "user"] = "user"
    dataset_bindings: dict[str, str] = Field(default_factory=dict)
    nodes: list[NodeSpec]
    edges: list[EdgeSpec] = Field(default_factory=list)
    meta: FlowMeta = Field(default_factory=FlowMeta)

    def execution_view(self) -> dict[str, Any]:
        """The spec with UI-only fields (position, label, name, description) removed."""
        return {
            "spec_version": self.spec_version,
            "dataset_bindings": self.dataset_bindings,
            "nodes": sorted(
                ({"id": n.id, "type": n.type, "params": n.params} for n in self.nodes),
                key=lambda n: n["id"],
            ),
            "edges": sorted(
                (
                    {
                        "source": e.source,
                        "source_port": e.source_port,
                        "target": e.target,
                        "target_port": e.target_port,
                    }
                    for e in self.edges
                ),
                key=lambda e: (e["target"], e["target_port"]),
            ),
            "seed": self.meta.seed,
        }

    def execution_hash(self) -> str:
        return sha256_text(canonical_json(self.execution_view()))
