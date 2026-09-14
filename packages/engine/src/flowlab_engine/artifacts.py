"""Artifact serialisation and content hashing per port type (PRD Section 6.3)."""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import joblib
import polars as pl
from flowlab_nodes import FittedModel, NodeRuntimeError, SplitTables, table_to_parquet_bytes
from flowlab_nodes.profiling import frame_signature, schema_signature
from flowspec import PortSchema, PortType, canonical_json, sha256_bytes, sha256_text, to_jsonable

JSON_KINDS = (PortType.METRICS, PortType.CHART, PortType.REPORT)


def check_value(port: str, schema: PortSchema, value: Any) -> None:
    """Validate a runtime payload against its compiled port schema."""
    expected: dict[PortType, type | tuple[type, ...]] = {
        PortType.TABLE: pl.DataFrame,
        PortType.TABLE_SPLIT: SplitTables,
        PortType.MODEL: FittedModel,
        PortType.TRANSFORMER: object,
        PortType.METRICS: dict,
        PortType.CHART: dict,
        PortType.REPORT: dict,
    }
    if not isinstance(value, expected[schema.kind]):
        raise NodeRuntimeError(
            "OUTPUT_TYPE_MISMATCH", f"port '{port}' produced {type(value).__name__}, expected {schema.kind}"
        )
    if schema.kind == PortType.CHART and not (
        isinstance(value, dict) and {"spec", "narration", "narration_basis"} <= value.keys()
    ):
        raise NodeRuntimeError("OUTPUT_TYPE_MISMATCH", f"chart on '{port}' lacks spec/narration/basis")
    frames: list[tuple[str, pl.DataFrame]] = []
    if isinstance(value, pl.DataFrame):
        frames = [(port, value)]
    elif isinstance(value, SplitTables):
        if schema.partitions is not None and list(value.parts) != schema.partitions:
            raise NodeRuntimeError(
                "SCHEMA_DRIFT", f"'{port}' partitions {list(value.parts)} != {schema.partitions}"
            )
        frames = [(f"{port}.{k}", v) for k, v in value.parts.items()]
    if frames and schema.table is not None:
        want = schema_signature(schema.table)
        for name, df in frames:
            got = frame_signature(df)
            if got != want:
                diff = sorted(set(got) ^ set(want)) or "column order"
                raise NodeRuntimeError("SCHEMA_DRIFT", f"'{name}' does not match its compiled schema: {diff}")


def write_value(kind: PortType, value: Any, directory: Path, port: str) -> str:
    """Write a payload under ``directory`` and return its content hash."""
    directory.mkdir(parents=True, exist_ok=True)
    if kind == PortType.TABLE:
        data = table_to_parquet_bytes(value)
        (directory / f"{port}.parquet").write_bytes(data)
        return sha256_bytes(data)
    if kind == PortType.TABLE_SPLIT:
        part_dir = directory / port
        part_dir.mkdir(parents=True, exist_ok=True)
        hashes = {}
        for name, df in value.parts.items():
            data = table_to_parquet_bytes(df)
            (part_dir / f"{name}.parquet").write_bytes(data)
            hashes[name] = sha256_bytes(data)
        (part_dir / "_partitions.json").write_text(json.dumps(list(value.parts)))
        return sha256_text(canonical_json({"partitions": list(value.parts), "hashes": hashes}))
    if kind in (PortType.MODEL, PortType.TRANSFORMER):
        buf = io.BytesIO()
        joblib.dump(value, buf)
        data = buf.getvalue()
        (directory / f"{port}.joblib").write_bytes(data)
        return sha256_bytes(data)
    if kind in JSON_KINDS:
        data = (json.dumps(to_jsonable(value), indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode()
        (directory / f"{port}.json").write_bytes(data)
        return sha256_bytes(data)
    raise ValueError(f"unsupported port kind {kind}")


def read_value(kind: PortType, directory: Path, port: str) -> Any:
    if kind == PortType.TABLE:
        return pl.read_parquet(directory / f"{port}.parquet")
    if kind == PortType.TABLE_SPLIT:
        part_dir = directory / port
        names = json.loads((part_dir / "_partitions.json").read_text())
        return SplitTables({n: pl.read_parquet(part_dir / f"{n}.parquet") for n in names})
    if kind in (PortType.MODEL, PortType.TRANSFORMER):
        return joblib.load(directory / f"{port}.joblib")
    if kind in JSON_KINDS:
        return json.loads((directory / f"{port}.json").read_text())
    raise ValueError(f"unsupported port kind {kind}")
