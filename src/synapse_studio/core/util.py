"""Small helpers shared by the core: JSON-safe values, ids, timestamps."""

from __future__ import annotations

import datetime as dt
import math
import secrets
from typing import Any

import numpy as np
import pandas as pd


def new_id(prefix: str) -> str:
    return f"{prefix}_{dt.datetime.now(dt.UTC):%y%m%d%H%M%S}_{secrets.token_hex(3)}"


def now() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="seconds")


def jsonable(value: Any) -> Any:
    """Convert numpy/pandas values (and NaN) into plain JSON values."""
    if value is None or isinstance(value, str | bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, list | tuple | set):
        return [jsonable(v) for v in value]
    if isinstance(value, np.ndarray):
        return [jsonable(v) for v in value.tolist()]
    if isinstance(value, pd.Timestamp | dt.datetime | dt.date):
        return None if pd.isna(value) else value.isoformat()
    if isinstance(value, pd.Timedelta | dt.timedelta):
        return str(value)
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return str(value)


def frame_rows(frame: pd.DataFrame, limit: int = 50, offset: int = 0) -> list[list[Any]]:
    """Rows of a DataFrame as JSON-safe lists."""
    part = frame.iloc[offset : offset + limit]
    return [[jsonable(v) for v in row] for row in part.itertuples(index=False, name=None)]


def round_floats(value: Any, digits: int = 5) -> Any:
    if isinstance(value, float):
        return float(f"{value:.{digits}g}") if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: round_floats(v, digits) for k, v in value.items()}
    if isinstance(value, list):
        return [round_floats(v, digits) for v in value]
    return value


class Cancelled(Exception):
    """The user stopped the job."""


class UserError(Exception):
    """A problem the user can fix; the message is shown as is."""
