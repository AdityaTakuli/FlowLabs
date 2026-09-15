"""Persistence contracts for Code Mode (PRD II 10.2).

The API and database arrive with Part I Phase 1; these models fix the row shapes now so the
agent's local records map onto them 1:1. ``code_executions`` rows are ``kernel.ExecutionRecord``.
"""

from __future__ import annotations

import datetime as dt
from typing import Any, Literal

from pydantic import BaseModel, Field

from .codegraph import CodeGraph
from .project import LabProject


def _now() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="seconds")


class CodeProjectRow(BaseModel):
    """``local_path`` is a reference on the user's machine, never a copy of their files."""

    id: str
    workspace_id: str
    name: str
    local_path: str
    agent_id: str
    source_kind: Literal["notebook", "script", "repo_trace", "mixed"]
    created_by: str
    created_at: str = Field(default_factory=_now)
    last_opened_at: str | None = None


class CodeGraphRow(BaseModel):
    id: str
    project_id: str
    source_hash: str
    graph: dict[str, Any]
    analysed_at: str = Field(default_factory=_now)


class CodeSessionRow(BaseModel):
    id: str
    project_id: str
    agent_id: str
    kernel_id: str | None = None
    status: Literal["starting", "idle", "busy", "dead", "stopped"] = "starting"
    environment: dict[str, Any] = Field(default_factory=dict)
    started_at: str = Field(default_factory=_now)
    ended_at: str | None = None


class CodeSnapshotRow(BaseModel):
    """``sample_ref`` points under the project's ``.flowlab/`` unless preview upload is enabled."""

    id: str
    execution_id: str
    variable_name: str
    shape: list[int] | None = None
    dtypes: dict[str, str] = Field(default_factory=dict)
    null_counts: dict[str, int] = Field(default_factory=dict)
    sample_ref: str | None = None
    content_hash: str | None = None
    created_at: str = Field(default_factory=_now)


def graph_row(graph: CodeGraph, *, row_id: str, project_id: str) -> CodeGraphRow:
    source_hash = "|".join(f.hash for f in graph.source.files)
    return CodeGraphRow(
        id=row_id, project_id=project_id, source_hash=source_hash, graph=graph.model_dump(by_alias=True)
    )


def snapshot_rows(project: LabProject, snapshot: dict[str, Any]) -> list[CodeSnapshotRow]:
    """Flatten one local snapshot file into ``code_snapshots`` rows (one per produced variable)."""
    rows = []
    execution_id = str(snapshot["execution_id"])
    local = project.state_dir / "snapshots" / f"{execution_id}.json"
    for name, summary in (snapshot.get("after") or {}).items():
        shape = summary.get("shape")
        if shape is None and isinstance(summary.get("rows"), int):
            shape = [summary["rows"], len(summary.get("columns") or [])]
        null_counts = summary.get("null_counts")
        if null_counts is None and isinstance(summary.get("null_count"), int):
            null_counts = {name: summary["null_count"]}
        dtypes = summary.get("dtypes")
        if dtypes is None and summary.get("dtype"):
            dtypes = {name: str(summary["dtype"])}
        rows.append(
            CodeSnapshotRow(
                id=f"{execution_id}:{name}",
                execution_id=execution_id,
                variable_name=name,
                shape=shape,
                dtypes=dtypes or {},
                null_counts=null_counts or {},
                sample_ref=f"local:{project.relative(local)}#{name}" if "sample" in summary else None,
                content_hash=summary.get("hash"),
            )
        )
    return rows
