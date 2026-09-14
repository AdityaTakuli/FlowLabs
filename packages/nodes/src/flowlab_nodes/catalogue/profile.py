from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import numpy as np
import polars as pl
from flowspec import PortSchema, PortType, to_jsonable
from pydantic import BaseModel, ConfigDict, Field

from ..base import CompileContext, ExecContext, Node, PortDef
from ..common import TABLE_ONLY
from ..narration import VEGA_LITE_SCHEMA, chart_artifact, fmt, pct
from ..profiling import dtype_name
from ..registry import register


class OverviewParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    head_rows: int = Field(5, ge=0, le=50, title="Sample rows")


@register
class ProfileOverview(Node[OverviewParams]):
    """Row and column counts, dtypes, estimated memory and a head sample.

    Use it as the first look at any dataset. It never modifies data.
    """

    type = "profile.overview"
    title = "Overview"
    category = "profile"
    Params = OverviewParams
    inputs = {"in": PortDef(TABLE_ONLY)}
    outputs = {"out": PortDef((PortType.METRICS,))}

    def propagate(
        self, params: OverviewParams, inputs: Mapping[str, PortSchema], ctx: CompileContext
    ) -> dict[str, PortSchema]:
        return {"out": PortSchema.of_kind(PortType.METRICS)}

    def execute(self, params: OverviewParams, inputs: Mapping[str, Any], ctx: ExecContext) -> dict[str, Any]:
        df: pl.DataFrame = inputs["in"]
        nulls = df.null_count().row(0) if df.width else ()
        columns = [
            {
                "name": name,
                "dtype": dtype_name(dtype),
                "null_count": int(nulls[i]),
                "n_unique": int(df[name].drop_nulls().n_unique()),
            }
            for i, (name, dtype) in enumerate(df.schema.items())
        ]
        metrics = {
            "row_count": df.height,
            "column_count": df.width,
            "estimated_memory_bytes": int(df.estimated_size()),
            "columns": columns,
            "head": df.head(params.head_rows).to_dicts(),
        }
        return {"out": to_jsonable(metrics)}


class MissingnessParams(BaseModel):
    model_config = ConfigDict(extra="forbid")


@register
class ProfileMissingness(Node[MissingnessParams]):
    """Null counts per column, rows with any null, and the missingness correlation matrix.

    Correlated missingness (two columns that tend to be null together) suggests values are
    not missing at random, which matters when choosing an imputation strategy.
    """

    type = "profile.missingness"
    title = "Missingness"
    category = "profile"
    Params = MissingnessParams
    inputs = {"in": PortDef(TABLE_ONLY)}
    outputs = {"metrics": PortDef((PortType.METRICS,)), "chart": PortDef((PortType.CHART,))}

    def propagate(
        self, params: MissingnessParams, inputs: Mapping[str, PortSchema], ctx: CompileContext
    ) -> dict[str, PortSchema]:
        return {
            "metrics": PortSchema.of_kind(PortType.METRICS),
            "chart": PortSchema.of_kind(PortType.CHART),
        }

    def execute(
        self, params: MissingnessParams, inputs: Mapping[str, Any], ctx: ExecContext
    ) -> dict[str, Any]:
        df: pl.DataFrame = inputs["in"]
        n = df.height
        counts = dict(zip(df.columns, df.null_count().row(0), strict=True)) if df.width else {}
        columns: list[dict[str, Any]] = [
            {"name": c, "null_count": int(k), "null_frac": round(k / n, 4) if n else 0.0}
            for c, k in counts.items()
        ]
        rows_any = (
            int(df.select(pl.any_horizontal(pl.all().is_null())).to_series().sum()) if n and df.width else 0
        )
        with_nulls = [c["name"] for c in columns if c["null_count"]]
        corr: list[list[float | None]] | None = None
        if len(with_nulls) >= 2:
            ind = df.select([pl.col(c).is_null().cast(pl.Float64) for c in with_nulls]).to_numpy()
            with np.errstate(invalid="ignore", divide="ignore"):
                m = np.corrcoef(ind, rowvar=False)
            corr = [[None if np.isnan(v) else round(float(v), 4) for v in row] for row in m]

        metrics = {
            "row_count": n,
            "columns": columns,
            "rows_with_any_null": rows_any,
            "missingness_correlation": {"columns": with_nulls, "matrix": corr},
        }

        ranked = sorted(columns, key=lambda c: (-c["null_frac"], c["name"]))
        values = [{"column": c["name"], "missing_pct": pct(c["null_count"], n)} for c in ranked]
        basis: dict[str, Any] = {"column_count": df.width, "row_count": n}
        if n == 0:
            narration = "The table has no rows, so missingness cannot be assessed."
        elif not with_nulls:
            narration = f"No missing values across the {fmt(df.width)} columns."
        else:
            top = ranked[0]
            basis.update(
                columns_with_nulls=len(with_nulls),
                top_column_missing_pct=pct(top["null_count"], n),
                rows_with_any_null_pct=pct(rows_any, n),
            )
            narration = (
                f"{fmt(basis['columns_with_nulls'])} of {fmt(df.width)} columns contain missing "
                f"values. `{top['name']}` has the most, at {fmt(basis['top_column_missing_pct'])}% "
                f"of rows. {fmt(basis['rows_with_any_null_pct'])}% of rows have at least one "
                "missing value."
            )
        spec = {
            "$schema": VEGA_LITE_SCHEMA,
            "title": "Missing values by column",
            "data": {"values": values},
            "mark": {"type": "bar"},
            "encoding": {
                "y": {"field": "column", "type": "nominal", "sort": "-x", "title": None},
                "x": {"field": "missing_pct", "type": "quantitative", "title": "% missing"},
            },
        }
        return {"metrics": to_jsonable(metrics), "chart": chart_artifact(spec, narration, basis)}
