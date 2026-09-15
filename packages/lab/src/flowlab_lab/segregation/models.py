"""Two-level architecture manifest: Components and Units (Code Segregation Bylaws §2, §6, §7)."""

from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

MANIFEST_VERSION = "1.0"
UNASSIGNED = "__unassigned__"

Confidence = Literal["high", "medium", "low"]
Severity = Literal["error", "warning", "info"]
UnitKind = Literal[
    "function", "method", "class", "cell_block", "module_script", "route_handler", "config_block"
]
DecidedBy = Literal["llm", "rule", "cluster"]
EdgeKind = Literal["call", "dataflow"]

# §6.1 — a closed vocabulary. Adding one means editing the bylaws and bumping the prompt version.
ARCHETYPES: dict[str, str] = {
    "ingestion": "Reads data from source systems into memory.",
    "validation": "Asserts schema, range and quality expectations.",
    "cleaning": "Handles nulls, duplicates, outliers and type correction.",
    "feature_engineering": "Derives, encodes, scales and selects features.",
    "splitting": "Partitions data into train, validation and test sets.",
    "training": "Fits models.",
    "tuning": "Searches hyperparameter space.",
    "evaluation": "Computes metrics and diagnostic plots.",
    "explainability": "Attributes predictions to features.",
    "inference": "Applies a fitted model to new data.",
    "experiment_tracking": "Logs runs, parameters and artifacts.",
    "visualization": "Produces charts and figures.",
    "entrypoint": "Starts the process.",
    "routing": "Maps requests to handlers.",
    "controller": "Handles requests and responses.",
    "service": "Implements business logic and use cases.",
    "repository": "Accesses persisted data.",
    "domain_model": "Defines entities, value objects and business types.",
    "schema": "Defines serialisation contracts.",
    "middleware": "Processes requests across handlers.",
    "auth": "Authenticates and authorises callers.",
    "client_adapter": "Calls external services.",
    "background_job": "Runs asynchronous and scheduled work.",
    "orchestration": "Defines pipelines and DAGs.",
    "persistence": "Stores artifacts and files.",
    "configuration": "Provides settings, constants and environment values.",
    "observability": "Emits logs, metrics and traces.",
    "utility": "Provides helpers used across components.",
}

# §6.3 layer orders
ML_PIPELINE = (
    "ingestion",
    "validation",
    "cleaning",
    "feature_engineering",
    "splitting",
    "training",
    "tuning",
    "evaluation",
    "explainability",
)
BACKEND_LAYERS = ("entrypoint", "routing", "controller", "service", "repository", "domain_model")
CROSS_CUTTING = ("configuration", "observability", "schema", "utility")

# SEG-052 / SEG-059 / SEG-058: archetypes that must not be merged into a neighbour of another kind
SEPARATE_ARCHETYPES = frozenset(
    {
        *ML_PIPELINE,
        "inference",
        *BACKEND_LAYERS[1:],
        "middleware",
        "auth",
        "client_adapter",
        "background_job",
        "configuration",
        "visualization",
        "schema",
    }
)

BANNED_NAMES = frozenset(
    {"utils", "helpers", "common", "misc", "core", "shared", "lib", "base", "main", "stuff"}
)

_RANK: dict[str, int] = {"low": 0, "medium": 1, "high": 2}


def min_confidence(*levels: Confidence) -> Confidence:
    """SEG-072: confidence propagates upward as a minimum."""
    return min(levels, key=lambda level: _RANK[level]) if levels else "high"


class Span(BaseModel):
    file: str
    line_start: int
    line_end: int


class FileRecord(BaseModel):
    path: str
    language: Literal["python", "notebook"]
    role: Literal["source", "test", "migration"]
    loc: int
    sloc: int
    content_hash: str
    mtime: int
    parse_error: str | None = None


class Unit(BaseModel):
    id: str
    component_id: str | None = None
    kind: UnitKind
    name: str
    qualified_name: str
    file: str
    line_start: int
    line_end: int
    signature: str | None = None
    decorators: list[str] = Field(default_factory=list)
    docstring_first_line: str | None = None
    loc: int
    sloc: int
    defines: list[str] = Field(default_factory=list)
    uses: list[str] = Field(default_factory=list)
    calls: list[str] = Field(default_factory=list)
    raises: list[str] = Field(default_factory=list)
    returns_type: str | None = None
    is_async: bool = False
    is_generator: bool = False
    complexity: int = 1
    side_effects: list[str] = Field(default_factory=list)
    entry_point: bool = False
    confidence: Confidence = "high"
    archetype_hint: str | None = None
    tests: list[str] = Field(default_factory=list)


class Component(BaseModel):
    id: str
    name: str
    archetype: str
    responsibility: str
    units: list[str]
    public_surface: list[str]
    depends_on: list[str]
    files: list[str]
    spans: list[Span]
    sloc: int
    confidence: Confidence
    decided_by: DecidedBy
    archetype_decided_by: DecidedBy = "rule"
    archetype_confidence: Confidence = "high"
    reason: str


class ArchEdge(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_: str = Field(alias="from")
    to: str
    kind: EdgeKind
    via: list[str]
    confidence: Confidence
    observed: bool = False


class Finding(BaseModel):
    code: str
    severity: Severity
    message: str
    law: str
    component_id: str | None = None
    unit_id: str | None = None
    unit_ids: list[str] = Field(default_factory=list)
    file: str | None = None
    line: int | None = None


class LlmReport(BaseModel):
    status: Literal["skipped", "used", "partial", "failed", "over_budget"] = "skipped"
    estimated_tokens: int = 0
    tokens_used: int = 0
    calls: int = 0
    cached_calls: int = 0
    notes: list[str] = Field(default_factory=list)


class Stats(BaseModel):
    files: int
    units: int
    components: int
    unassigned_units: int
    sloc: int
    tokens_used: int = 0
    estimated_tokens: int = 0
    clustering: str


class Manifest(BaseModel):
    manifest_version: str = MANIFEST_VERSION
    project_id: str
    analysed_at: str
    commit: str | None
    stats: Stats
    components: list[Component]
    units: list[Unit]
    edges: list[ArchEdge]
    findings: list[Finding]
    unassigned: list[str]
    files: list[FileRecord]
    llm: LlmReport = Field(default_factory=LlmReport)

    def to_json(self) -> str:
        return self.model_dump_json(by_alias=True, indent=2)

    def architecture_key(self) -> str:
        """Everything that must be identical for the same code (SEG-006); timestamps and mtimes excluded."""
        data = self.model_dump(mode="json", by_alias=True, exclude={"analysed_at"})
        for record in data["files"]:
            record.pop("mtime", None)
        return json.dumps(data, sort_keys=True)
