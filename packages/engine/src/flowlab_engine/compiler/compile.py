"""compile(flow_spec, dataset_schemas) -> ExecutionPlan | CompileErrors (PRD Section 8.1)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from flowlab_nodes import CompileContext, NodeCompileError
from flowspec import (
    CompileIssue,
    CompileResult,
    ExecutionPlan,
    FlowSpec,
    PlanStep,
    PortSchema,
    StepInput,
    TableSchema,
    canonical_json,
    sha256_text,
)
from pydantic import BaseModel, ValidationError

from ..version import runner_version as current_runner_version
from .graph import FlowGraph, build_graph
from .semantic import TypedGraph, run_semantic_checks


def node_cache_key(
    node_type: str,
    params: Mapping[str, Any],
    input_keys: list[str],
    runner_version: str,
    seed: int,
) -> str:
    """sha256(node_type | canonical params | sorted inputs | runner_version | seed).

    Position, label and node id never enter the key.
    """
    payload = "|".join(
        [node_type, canonical_json(params), ",".join(sorted(input_keys)), runner_version, str(seed)]
    )
    return sha256_text(payload)


def _spec_errors(exc: ValidationError, raw: Any) -> list[CompileIssue]:
    issues = []
    for err in exc.errors():
        loc = list(err["loc"])
        node_id = None
        if len(loc) >= 2 and loc[0] == "nodes" and isinstance(loc[1], int) and isinstance(raw, dict):
            try:
                node_id = raw["nodes"][loc[1]].get("id")
            except (KeyError, IndexError, AttributeError, TypeError):
                node_id = None
        issues.append(
            CompileIssue(
                node_id=node_id,
                code="SPEC_INVALID",
                severity="error",
                message=f"{'.'.join(str(p) for p in loc) or 'spec'}: {err['msg']}",
            )
        )
    return issues


def _fail(errors: list[CompileIssue], warnings: list[CompileIssue]) -> CompileResult:
    return CompileResult(ok=False, errors=errors, warnings=warnings, plan=None)


def compile_flow(
    spec: FlowSpec | Mapping[str, Any],
    dataset_schemas: Mapping[str, TableSchema],
    *,
    runner_version: str | None = None,
) -> CompileResult:
    if not isinstance(spec, FlowSpec):
        try:
            spec = FlowSpec.model_validate(dict(spec))
        except ValidationError as exc:
            return _fail(_spec_errors(exc, spec), [])
    version = runner_version or current_runner_version()
    seed = spec.meta.seed

    graph, errors, warnings = build_graph(spec)
    if graph is None:
        return _fail(errors, warnings)

    params, errors = _validate_params(graph)
    if errors:
        return _fail(errors, warnings)

    inputs, outputs, errors, prop_warnings = _propagate(graph, params, dataset_schemas, seed)
    warnings.extend(prop_warnings)

    semantic = run_semantic_checks(TypedGraph(graph, params, inputs, outputs))
    errors.extend(i for i in semantic if i.severity == "error")
    warnings.extend(i for i in semantic if i.severity == "warning")
    if errors:
        return _fail(errors, warnings)

    keys: dict[str, str] = {}
    steps: list[PlanStep] = []
    for index, nid in enumerate(graph.order):
        node = graph.nodes[nid]
        impl = graph.impls[nid]
        ctx = CompileContext(nid, seed, spec.dataset_bindings, dataset_schemas)
        dumped = params[nid].model_dump(mode="json")
        input_keys = [f"{port}<-{keys[e.source]}:{e.source_port}" for port, e in graph.inbound[nid].items()]
        input_keys += [f"extra:{h}" for h in impl.cache_inputs(params[nid], ctx)]
        keys[nid] = node_cache_key(node.type, dumped, input_keys, version, seed)
        steps.append(
            PlanStep(
                index=index,
                node_id=nid,
                node_type=node.type,
                label=node.label,
                params=dumped,
                inputs={
                    p: StepInput(node_id=e.source, port=e.source_port) for p, e in graph.inbound[nid].items()
                },
                input_schemas=dict(inputs[nid]),
                output_schemas=dict(outputs[nid]),
                cache_key=keys[nid],
                cacheable=impl.cacheable,
            )
        )

    plan = ExecutionPlan(
        flow_id=spec.flow_id,
        flow_name=spec.name,
        spec_hash=spec.execution_hash(),
        seed=seed,
        runner_version=version,
        dataset_bindings=dict(spec.dataset_bindings),
        dataset_hashes={
            ref: schema.content_hash
            for ref, schema in dataset_schemas.items()
            if ref in spec.dataset_bindings and schema.content_hash
        },
        steps=steps,
        warnings=warnings,
    )
    return CompileResult(ok=True, errors=[], warnings=warnings, plan=plan)


def _validate_params(graph: FlowGraph) -> tuple[dict[str, BaseModel], list[CompileIssue]]:
    params: dict[str, BaseModel] = {}
    errors: list[CompileIssue] = []
    for nid in graph.order:
        impl = graph.impls[nid]
        try:
            params[nid] = impl.parse_params(graph.nodes[nid].params)
        except ValidationError as exc:
            for err in exc.errors():
                loc = ".".join(str(p) for p in err["loc"]) or "params"
                errors.append(
                    CompileIssue(
                        node_id=nid,
                        code="PARAM_INVALID",
                        severity="error",
                        message=f"{impl.type}: {loc}: {err['msg']}",
                    )
                )
    return params, errors


def _propagate(
    graph: FlowGraph,
    params: Mapping[str, BaseModel],
    dataset_schemas: Mapping[str, TableSchema],
    seed: int,
) -> tuple[
    dict[str, dict[str, PortSchema]],
    dict[str, dict[str, PortSchema]],
    list[CompileIssue],
    list[CompileIssue],
]:
    inputs: dict[str, dict[str, PortSchema]] = {}
    outputs: dict[str, dict[str, PortSchema]] = {}
    errors: list[CompileIssue] = []
    warnings: list[CompileIssue] = []

    for nid in graph.order:
        impl = graph.impls[nid]
        inbound = graph.inbound[nid]
        if any(e.source not in outputs for e in inbound.values()):
            continue  # an upstream node failed; don't cascade errors
        node_inputs = {port: outputs[e.source][e.source_port] for port, e in inbound.items()}
        mismatch = [(port, ps) for port, ps in node_inputs.items() if ps.kind not in impl.inputs[port].types]
        if mismatch:
            port, ps = mismatch[0]
            errors.append(
                CompileIssue(
                    node_id=nid,
                    code="PORT_TYPE_MISMATCH",
                    severity="error",
                    message=f"input '{port}' receives {ps.kind.value}, but accepts "
                    f"{'/'.join(impl.inputs[port].types)}",
                )
            )
            continue
        ctx = CompileContext(nid, seed, graph.spec.dataset_bindings, dataset_schemas)
        try:
            node_outputs = impl.propagate(params[nid], node_inputs, ctx)
        except NodeCompileError as exc:
            errors.append(
                CompileIssue(
                    node_id=nid,
                    code=exc.code,
                    severity="error",
                    message=exc.message,
                    suggestion=exc.suggestion,
                )
            )
            continue
        if set(node_outputs) != set(impl.outputs):
            raise RuntimeError(f"{impl.type}.propagate returned ports {sorted(node_outputs)}")
        inputs[nid] = node_inputs
        outputs[nid] = node_outputs
        warnings.extend(
            CompileIssue(
                node_id=nid, code=w.code, severity="warning", message=w.message, suggestion=w.suggestion
            )
            for w in ctx.warnings
        )
    return inputs, outputs, errors, warnings
