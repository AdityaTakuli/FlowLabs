"""Canonical JSON and content hashing.

Every hash in FlowLab (spec hashes, cache keys, artifact hashes) goes through these
helpers so that the same logical value always produces the same bytes.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
from typing import Any


def to_jsonable(value: Any) -> Any:
    """Convert numpy scalars, dates, pydantic models etc. into plain JSON values.

    Non-finite floats become ``None`` so that artifacts are always valid JSON.
    """
    if value is None or isinstance(value, bool | str):
        return value
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(k): to_jsonable(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [to_jsonable(v) for v in value]
    if isinstance(value, dt.datetime | dt.date | dt.time):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return value.total_seconds()
    if hasattr(value, "model_dump"):
        return to_jsonable(value.model_dump(mode="json"))
    if hasattr(value, "tolist"):  # numpy arrays and numpy scalars
        return to_jsonable(value.tolist())
    return str(value)


def canonical_json(value: Any) -> str:
    return json.dumps(
        to_jsonable(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))
