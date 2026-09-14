"""Shared test helpers: fixture schemas, flow builders and single-node runners."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

import polars as pl
from flowlab_engine.artifacts import check_value
from flowlab_engine.compiler import compile_flow
from flowlab_engine.datasets import find_dataset_file, profile_file
from flowlab_nodes import CompileContext, ExecContext, get_node, infer_table_schema
from flowspec import CompileResult, PortSchema, TableSchema

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "fixtures"
EXAMPLES = ROOT / "examples"


@cache
def fixture_schema(name: str) -> TableSchema:
    path = find_dataset_file(FIXTURES, name)
    assert path is not None, name
    return profile_file(path)


def load_example(name: str) -> dict[str, Any]:
    return json.loads((EXAMPLES / name).read_text())


def compile_spec(spec: Mapping[str, Any]) -> CompileResult:
    schemas = {ref: fixture_schema(ds) for ref, ds in spec.get("dataset_bindings", {}).items()}
    return compile_flow(spec, schemas)


def issues(result: CompileResult, severity: str = "error") -> list[tuple[str | None, str]]:
    items = result.errors if severity == "error" else result.warnings
    return [(i.node_id, i.code) for i in items]


def warning_codes(result: CompileResult) -> set[str]:
    return {i.code for i in result.warnings}


def _edge(i: int, text: str) -> dict[str, str]:
    left, right = (part.strip() for part in text.split("->"))
    source, _, source_port = left.partition(".")
    target, _, target_port = right.partition(".")
    return {
        "id": f"e{i}",
        "source": source,
        "source_port": source_port or "out",
        "target": target,
        "target_port": target_port or "in",
    }


def flow(
    nodes: list[tuple[str, str, dict[str, Any]]],
    edges: list[str],
    dataset: str = "churn",
    seed: int = 42,
) -> dict[str, Any]:
    return {
        "flow_id": "flw_test",
        "name": "test flow",
        "dataset_bindings": {"primary": dataset},
        "nodes": [{"id": nid, "type": t, "params": p} for nid, t, p in nodes],
        "edges": [_edge(i, e) for i, e in enumerate(edges)],
        "meta": {"seed": seed},
    }


CHURN_SOURCE = {"dataset_ref": "primary", "target": "churned", "role_overrides": {"signup_date": "ignore"}}
DEFAULT_POST = [
    ("impute", "clean.impute", {"strategy": "median"}),
    ("encode", "prep.encode", {"method": "onehot"}),
]


def model_flow(
    pre: list[tuple[str, str, dict[str, Any]]] | None = None,
    post: list[tuple[str, str, dict[str, Any]]] | None = None,
    *,
    source: dict[str, Any] | None = None,
    split: dict[str, Any] | None = None,
    fit: dict[str, Any] | None = None,
    evaluate: dict[str, Any] | None = None,
    dataset: str = "churn",
) -> dict[str, Any]:
    """source -> pre... -> split -> post... -> fit ; fit.model + last -> evaluate."""
    pre = pre or []
    post = DEFAULT_POST if post is None else post
    chain = [
        ("src", "source.dataset", source or CHURN_SOURCE),
        *pre,
        ("split", "prep.split", split or {"stratify_by": "churned"} if dataset == "churn" else split or {}),
        *post,
    ]
    nodes = [
        *chain,
        ("fit", "model.fit", fit or {"algorithm": "logistic_regression"}),
        ("eval", "model.evaluate", evaluate or {}),
    ]
    ids = [n[0] for n in chain]
    edges = [f"{a}->{b}" for a, b in zip(ids, ids[1:], strict=False)]
    edges += [f"{ids[-1]}->fit.train", "fit.model->eval.model", f"{ids[-1]}->eval.data"]
    return flow(nodes, edges, dataset=dataset)


# ------------------------------------------------------------------------ single node runs


def table_port(df: pl.DataFrame, **source_params: Any) -> PortSchema:
    """The PortSchema a source.dataset would emit for ``df`` with the given params."""
    schema = infer_table_schema(df, content_hash="sha256:test")
    ctx = CompileContext("src", 0, {"d": "d"}, {"d": schema})
    impl = get_node("source.dataset")
    assert impl is not None
    return impl.propagate(impl.parse_params({"dataset_ref": "d", **source_params}), {}, ctx)["out"]


@dataclass
class NodeRun:
    outputs: dict[str, Any]
    schemas: dict[str, PortSchema]
    compile_warnings: list[str]
    runtime_warnings: list[str]
    files: list[Path]


def propagate(
    node_type: str, params: dict[str, Any], inputs: dict[str, PortSchema]
) -> tuple[dict[str, PortSchema], list[str]]:
    impl = get_node(node_type)
    assert impl is not None
    ctx = CompileContext("t", 0, {}, {})
    out = impl.propagate(impl.parse_params(params), inputs, ctx)
    return out, [w.code for w in ctx.warnings]


def run_node(
    node_type: str,
    params: dict[str, Any],
    inputs: dict[str, Any],
    schemas: dict[str, PortSchema],
    *,
    seed: int = 0,
    export_dir: Path | None = None,
) -> NodeRun:
    impl = get_node(node_type)
    assert impl is not None
    parsed = impl.parse_params(params)
    cctx = CompileContext("t", seed, {}, {})
    out_schemas = impl.propagate(parsed, schemas, cctx)
    runtime: list[str] = []
    files: list[Path] = []
    on_file: Callable[[Path, str], None] = lambda p, h: files.append(p)  # noqa: E731
    ectx = ExecContext(
        node_id="t",
        seed=seed,
        input_schemas=schemas,
        output_schemas=out_schemas,
        dataset_paths={},
        dataset_hashes={},
        export_dir=export_dir or Path("/nonexistent"),
        on_warning=lambda code, message: runtime.append(code),
        on_file=on_file,
    )
    outputs = impl.execute(parsed, inputs, ectx)
    for port, schema in out_schemas.items():
        check_value(port, schema, outputs[port])
    return NodeRun(outputs, out_schemas, [w.code for w in cctx.warnings], runtime, files)


def split_frame(
    df: pl.DataFrame, source: dict[str, Any] | None = None, **params: Any
) -> tuple[Any, PortSchema]:
    run = run_node("prep.split", params, {"in": df}, {"in": table_port(df, **(source or {}))})
    return run.outputs["out"], run.schemas["out"]
