from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

import numpy as np
import polars as pl
from flowspec import PortSchema, PortType, Semantic
from pydantic import BaseModel, ConfigDict, Field

from ..base import CompileContext, ExecContext, Node, NodeCompileError, PortDef
from ..common import TABLE_OR_SPLIT, check_partition, pick_frame, resolve_columns
from ..narration import VEGA_LITE_SCHEMA, chart_artifact, fmt, pct
from ..registry import register

MAX_RAW_POINTS = 5000
MAX_BARS = 30


class DistributionParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    column: str = Field(title="Column", json_schema_extra={"x-widget": "column-select"})
    chart: Literal["histogram", "box", "ecdf"] = Field(
        "histogram",
        json_schema_extra={
            "x-widget": "radio-cards",
            "x-descriptions": {
                "histogram": "Counts per value range. Shows shape and skew.",
                "box": "Median, quartiles and outliers at a glance.",
                "ecdf": "Share of values at or below each point. No binning choices.",
            },
        },
    )
    bins: int = Field(30, ge=5, le=200)
    partition: str = Field("train", description="Partition to plot when the input is a split.")


def _skew_phrase(skew: float) -> str:
    size = abs(skew)
    if size < 0.5:
        return "approximately symmetric"
    side = "right" if skew > 0 else "left"
    return f"{'moderately' if size < 1 else 'strongly'} {side}-skewed"


@register
class VizDistribution(Node[DistributionParams]):
    """Plot the distribution of one column with a written finding.

    Numeric columns support histogram, box and ECDF charts; categorical columns render as a
    bar chart of the most frequent values. The narration states range, centre, skew and
    missingness using only the computed values in ``narration_basis``.
    """

    type = "viz.distribution"
    title = "Distribution"
    category = "viz"
    Params = DistributionParams
    inputs = {"in": PortDef(TABLE_OR_SPLIT)}
    outputs = {"out": PortDef((PortType.CHART,))}

    def propagate(
        self, params: DistributionParams, inputs: Mapping[str, PortSchema], ctx: CompileContext
    ) -> dict[str, PortSchema]:
        ps = inputs["in"]
        (col,) = resolve_columns(ps.require_table(), [params.column])
        check_partition(ps, params.partition)
        if not col.is_numeric and params.chart != "histogram":
            raise NodeCompileError(
                "SCHEMA_MISMATCH",
                f"a {params.chart} chart needs a numeric column; '{col.name}' is {col.semantic.value}",
                "Use chart 'histogram', which renders categories as bars",
            )
        if col.semantic in (Semantic.IDENTIFIER, Semantic.TEXT_FREE):
            ctx.warn(
                "UNINFORMATIVE_CHART",
                f"'{col.name}' is {col.semantic.value}; its distribution is rarely useful",
            )
        return {"out": PortSchema.of_kind(PortType.CHART)}

    def execute(
        self, params: DistributionParams, inputs: Mapping[str, Any], ctx: ExecContext
    ) -> dict[str, Any]:
        df = pick_frame(inputs["in"], params.partition)
        s = df[params.column]
        n = s.len()
        missing = s.null_count()
        values = s.drop_nulls()
        name = params.column
        basis: dict[str, Any] = {"rows": n, "missing": missing, "missing_pct": pct(missing, n)}

        if values.len() == 0:
            empty = {"$schema": VEGA_LITE_SCHEMA, "title": name, "data": {"values": []}, "mark": "bar"}
            return {"out": chart_artifact(empty, f"`{name}` has no non-missing values.", basis)}

        if not s.dtype.is_numeric():
            return {"out": self._categorical(name, values, n, basis)}

        v = values.cast(pl.Float64).to_numpy()
        skew = float(values.cast(pl.Float64).skew() or 0.0) if len(v) > 2 else 0.0
        basis.update(
            min=round(float(v.min()), 4),
            max=round(float(v.max()), 4),
            mean=round(float(v.mean()), 4),
            median=round(float(np.median(v)), 4),
            std=round(float(v.std(ddof=1)), 4) if len(v) > 1 else 0.0,
            skew=round(skew, 2),
            bins=params.bins,
        )
        narration = (
            f"`{name}` ranges from {fmt(basis['min'])} to {fmt(basis['max'])} with a median of "
            f"{fmt(basis['median'])} and a mean of {fmt(basis['mean'])}. The distribution is "
            f"{_skew_phrase(skew)} (skewness {fmt(basis['skew'])})."
        )
        if missing:
            narration += f" {fmt(basis['missing_pct'])}% of values are missing."
        if abs(skew) >= 1:
            narration += " The median is a more representative centre than the mean here."

        if params.chart == "histogram":
            counts, edges = np.histogram(v, bins=params.bins)
            data = [
                {"bin_start": float(edges[i]), "bin_end": float(edges[i + 1]), "count": int(c)}
                for i, c in enumerate(counts)
            ]
            spec: dict[str, Any] = {
                "$schema": VEGA_LITE_SCHEMA,
                "title": f"Distribution of {name}",
                "data": {"values": data},
                "mark": "bar",
                "encoding": {
                    "x": {
                        "field": "bin_start",
                        "type": "quantitative",
                        "bin": {"binned": True},
                        "title": name,
                    },
                    "x2": {"field": "bin_end"},
                    "y": {"field": "count", "type": "quantitative"},
                },
            }
        elif params.chart == "box":
            step = max(1, -(-len(v) // MAX_RAW_POINTS))
            spec = {
                "$schema": VEGA_LITE_SCHEMA,
                "title": f"Distribution of {name}",
                "data": {"values": [{name: float(x)} for x in v[::step]]},
                "mark": {"type": "boxplot", "extent": 1.5},
                "encoding": {"x": {"field": name, "type": "quantitative"}},
            }
        else:
            sorted_v = np.sort(v)
            positions = np.unique(np.linspace(0, len(sorted_v) - 1, num=min(200, len(sorted_v))).astype(int))
            data = [{"value": float(sorted_v[i]), "ecdf": (i + 1) / len(sorted_v)} for i in positions]
            spec = {
                "$schema": VEGA_LITE_SCHEMA,
                "title": f"ECDF of {name}",
                "data": {"values": data},
                "mark": {"type": "line", "interpolate": "step-after"},
                "encoding": {
                    "x": {"field": "value", "type": "quantitative", "title": name},
                    "y": {"field": "ecdf", "type": "quantitative", "title": "cumulative share"},
                },
            }
        return {"out": chart_artifact(spec, narration, basis)}

    @staticmethod
    def _categorical(name: str, values: pl.Series, n: int, basis: dict[str, Any]) -> dict[str, Any]:
        counts = values.cast(pl.String).value_counts()
        rows = sorted(counts.iter_rows(), key=lambda r: (-r[1], str(r[0])))
        top_value, top_count = rows[0]
        basis.update(distinct=len(rows), top_pct=pct(top_count, n))
        narration = (
            f"`{name}` has {fmt(len(rows))} distinct values. The most common is `{top_value}` at "
            f"{fmt(basis['top_pct'])}% of rows."
        )
        if basis["missing"]:
            narration += f" {fmt(basis['missing_pct'])}% of values are missing."
        spec = {
            "$schema": VEGA_LITE_SCHEMA,
            "title": f"Distribution of {name}",
            "data": {"values": [{"value": str(r[0]), "count": int(r[1])} for r in rows[:MAX_BARS]]},
            "mark": "bar",
            "encoding": {
                "y": {"field": "value", "type": "nominal", "sort": "-x", "title": name},
                "x": {"field": "count", "type": "quantitative"},
            },
        }
        return chart_artifact(spec, narration, basis)
