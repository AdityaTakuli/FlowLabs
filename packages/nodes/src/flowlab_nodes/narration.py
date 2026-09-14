"""Templated narration bound to ``narration_basis`` (PRD Section 7.7).

Every number that appears in a narration string must be present in its basis. Column
names and category values are wrapped in backticks and excluded from the check.
"""

from __future__ import annotations

import re
from typing import Any

from flowspec import to_jsonable

from .base import NodeRuntimeError

VEGA_LITE_SCHEMA = "https://vega.github.io/schema/vega-lite/v5.json"

_NUMBER = re.compile(r"(?<![\w.])-?\d+(?:\.\d+)?(?!\w)")
_QUOTED = re.compile(r"`[^`]*`")


def fmt(value: float | int) -> str:
    """Format a number the way narrations print it. Basis values are compared in this form."""
    v = float(value)
    if v.is_integer() and abs(v) < 1e15:
        return str(int(v))
    decimals = 2 if abs(v) >= 1 else 4
    text = f"{v:.{decimals}f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def _basis_numbers(value: Any, out: set[str]) -> None:
    if isinstance(value, bool) or value is None:
        return
    if isinstance(value, int | float):
        out.add(fmt(value))
    elif isinstance(value, dict):
        for v in value.values():
            _basis_numbers(v, out)
    elif isinstance(value, list | tuple):
        for v in value:
            _basis_numbers(v, out)


def ungrounded_numbers(narration: str, basis: dict[str, Any]) -> list[str]:
    allowed: set[str] = set()
    _basis_numbers(to_jsonable(basis), allowed)
    tokens = _NUMBER.findall(_QUOTED.sub("", narration))
    return [t for t in tokens if fmt(float(t)) not in allowed]


def chart_artifact(spec: dict[str, Any], narration: str, basis: dict[str, Any]) -> dict[str, Any]:
    bad = ungrounded_numbers(narration, basis)
    if bad:
        raise NodeRuntimeError(
            "NARRATION_UNGROUNDED",
            f"narration references numbers not present in narration_basis: {bad}",
        )
    return to_jsonable({"spec": spec, "narration": narration, "narration_basis": basis})  # type: ignore[no-any-return]


def r2(value: float | None) -> float | None:
    return None if value is None else round(float(value), 2)


def pct(numerator: float, denominator: float) -> float:
    return round(100.0 * numerator / denominator, 2) if denominator else 0.0
