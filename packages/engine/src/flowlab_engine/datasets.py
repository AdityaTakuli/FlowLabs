"""Resolve dataset bindings to local files and profile them (Phase 0 stand-in for 9.3)."""

from __future__ import annotations

from pathlib import Path

from flowlab_nodes import infer_table_schema, read_table, table_hash
from flowlab_nodes.io import SUPPORTED_SUFFIXES
from flowspec import CompileIssue, FlowSpec, TableSchema


def find_dataset_file(data_dir: Path, dataset_id: str) -> Path | None:
    direct = data_dir / dataset_id
    if direct.is_file():
        return direct
    for suffix in SUPPORTED_SUFFIXES:
        candidate = data_dir / f"{dataset_id}{suffix}"
        if candidate.is_file():
            return candidate
    return None


def resolve_dataset_paths(spec: FlowSpec, data_dir: Path) -> tuple[dict[str, Path], list[CompileIssue]]:
    paths: dict[str, Path] = {}
    errors: list[CompileIssue] = []
    for ref, dataset_id in sorted(spec.dataset_bindings.items()):
        path = find_dataset_file(data_dir, dataset_id)
        if path is None:
            errors.append(
                CompileIssue(
                    node_id=None,
                    code="DATASET_NOT_FOUND",
                    severity="error",
                    message=f"no file for dataset '{dataset_id}' (bound as '{ref}') in {data_dir}",
                    suggestion="Expected " + ", ".join(f"{dataset_id}{s}" for s in SUPPORTED_SUFFIXES[:3]),
                )
            )
        else:
            paths[ref] = path
    return paths, errors


def profile_file(path: Path) -> TableSchema:
    df = read_table(path)
    return infer_table_schema(df, content_hash=table_hash(df))


def load_schemas(paths: dict[str, Path]) -> dict[str, TableSchema]:
    return {ref: profile_file(path) for ref, path in paths.items()}
