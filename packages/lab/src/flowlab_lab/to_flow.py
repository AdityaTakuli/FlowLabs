"""Code → Flow conversion (PRD II 3.1, Phase 11).

For a *contiguous* run of blocks whose Tier B pattern maps to a Flow Mode node, produce a
draft Flow Spec with parameters extracted from literal arguments. Never automatic: the caller
shows the draft, what could not be converted and why, and the user confirms per section.
"""

from __future__ import annotations

import ast
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from flowspec import FlowSpec

from .blocks import sanitize_ipython
from .codegraph import CodeGraph, CodeNode

ALGORITHMS = {
    "LogisticRegression": "logistic_regression", "LinearRegression": "linear_regression", "Ridge": "ridge",
    "Lasso": "lasso", "ElasticNet": "elastic_net", "DecisionTreeClassifier": "decision_tree",
    "DecisionTreeRegressor": "decision_tree", "RandomForestClassifier": "random_forest",
    "RandomForestRegressor": "random_forest", "ExtraTreesClassifier": "extra_trees",
    "ExtraTreesRegressor": "extra_trees", "GradientBoostingClassifier": "gradient_boosting",
    "GradientBoostingRegressor": "gradient_boosting", "SVC": "svm", "SVR": "svm",
    "KNeighborsClassifier": "knn", "KNeighborsRegressor": "knn", "GaussianNB": "gaussian_nb",
}  # fmt: skip
SCALERS = {
    "StandardScaler": "standard",
    "MinMaxScaler": "minmax",
    "RobustScaler": "robust",
    "QuantileTransformer": "quantile",
}
OUTPUT_PORT = {"model.fit": "model", "model.evaluate": "predictions", "profile.missingness": "metrics"}
TERMINAL = {"profile.overview", "profile.missingness", "viz.distribution", "sink.export"}


class ConversionError(ValueError):
    pass


@dataclass
class Conversion:
    spec: dict[str, Any]
    converted: dict[str, str] = field(default_factory=dict)  # code block id -> flow node id
    skipped: list[tuple[str, str]] = field(default_factory=list)  # (block id, reason)
    notes: list[str] = field(default_factory=list)


def _calls(tree: ast.AST) -> list[ast.Call]:
    return [n for n in ast.walk(tree) if isinstance(n, ast.Call)]


def _name(call: ast.Call) -> str:
    func = call.func
    return func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else ""


def _literal(node: ast.AST | None) -> Any:
    if node is None:
        return None
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):  # DATA_DIR / "file.csv"
        return _literal(node.right)
    try:
        return ast.literal_eval(node)
    except (ValueError, SyntaxError, TypeError):
        return None


def _kwargs(call: ast.Call) -> dict[str, Any]:
    return {k.arg: _literal(k.value) for k in call.keywords if k.arg}


def _subscript_column(node: ast.AST | None) -> str | None:
    if isinstance(node, ast.Subscript):
        value = _literal(node.slice)
        return value if isinstance(value, str) else None
    return None


def _first(tree: ast.AST, names: set[str] | Callable[[str], bool]) -> ast.Call | None:
    match = names if callable(names) else names.__contains__
    return next((c for c in _calls(tree) if match(_name(c))), None)


Extracted = tuple[dict[str, Any], list[str]] | str  # (params, notes) or a reason it cannot convert


def _source(tree: ast.AST, state: dict[str, Any]) -> Extracted:
    call = _first(tree, lambda n: n.startswith("read_"))
    path = _literal(call.args[0]) if call and call.args else None
    if not isinstance(path, str):
        return "the file path is not a literal string"
    dataset = Path(path).stem
    ref = "primary" if not state["bindings"] else dataset
    state["bindings"][ref] = dataset
    state["source_ref"] = ref
    return {"dataset_ref": ref}, [f"dataset `{dataset}` must be registered (bound as '{ref}')"]


def _drop(tree: ast.AST, state: dict[str, Any]) -> Extracted:
    call = _first(tree, {"drop"})
    columns = _kwargs(call).get("columns") if call else None
    if isinstance(columns, str):
        columns = [columns]
    if not isinstance(columns, list) or not columns:
        return "the dropped columns are not a literal list"
    return {"columns": columns}, []


def _impute(tree: ast.AST, state: dict[str, Any]) -> Extracted:
    imputer = _first(tree, {"SimpleImputer"})
    if imputer is not None:
        strategy = _kwargs(imputer).get("strategy", "mean")
        mapping = {"most_frequent": "mode", "constant": "constant"}
        params: dict[str, Any] = {"strategy": mapping.get(strategy, strategy)}
        if params["strategy"] == "constant":
            params["fill_value"] = _kwargs(imputer).get("fill_value", 0)
        return params, []
    call = _first(tree, {"fillna"})
    if call is None or not call.args:
        return "no fillna/SimpleImputer arguments to read"
    argument = call.args[0]
    if isinstance(argument, ast.Call) and _name(argument) in ("median", "mean", "mode"):
        return {"strategy": _name(argument)}, ["imputation fits on the train partition in Flow Mode"]
    value = _literal(argument)
    if value is None:
        return "the fill value is not a literal"
    return {"strategy": "constant", "fill_value": value}, []


def _split(tree: ast.AST, state: dict[str, Any]) -> Extracted:
    call = _first(tree, {"train_test_split"})
    if call is None:
        return "no train_test_split call"
    kwargs = _kwargs(call)
    params: dict[str, Any] = {"test_size": kwargs.get("test_size") or 0.25}
    if isinstance(kwargs.get("random_state"), int):
        params["seed"] = kwargs["random_state"]
    stratify = next((k.value for k in call.keywords if k.arg == "stratify"), None)
    if _subscript_column(stratify):
        params["stratify_by"] = _subscript_column(stratify)
    target = _subscript_column(call.args[1]) if len(call.args) > 1 else None
    notes = []
    if target:
        state["target"] = target
    else:
        notes.append("could not tell which column is the target; set it on the dataset node")
    if "test_size" not in kwargs:
        notes.append("sklearn's default test_size of 0.25 was assumed")
    return params, notes


def _encode(tree: ast.AST, state: dict[str, Any]) -> Extracted:
    call = _first(tree, {"get_dummies", "OneHotEncoder", "OrdinalEncoder"})
    if call is None:
        return "no recognised encoder call"
    params: dict[str, Any] = {"method": "ordinal" if _name(call) == "OrdinalEncoder" else "onehot"}
    columns = _kwargs(call).get("columns")
    if isinstance(columns, list):
        params["columns"] = columns
    return params, ["encoders fit on the train partition in Flow Mode"]


def _scale(tree: ast.AST, state: dict[str, Any]) -> Extracted:
    call = _first(tree, set(SCALERS))
    return ({"method": SCALERS[_name(call)]}, []) if call else "no recognised scaler"


def _fit(tree: ast.AST, state: dict[str, Any]) -> Extracted:
    call = _first(tree, set(ALGORITHMS))
    if call is None:
        return "the estimator is not one of the Flow Mode algorithms"
    kwargs = {k: v for k, v in _kwargs(call).items() if v is not None}
    params: dict[str, Any] = {"algorithm": ALGORITHMS[_name(call)]}
    if isinstance(kwargs.pop("random_state", None), int):
        params["seed"] = _kwargs(call)["random_state"]
    if kwargs.get("class_weight") == "balanced":
        params["class_weight"] = kwargs.pop("class_weight")
    kwargs.pop("class_weight", None)
    if kwargs:
        params["hyperparameters"] = kwargs
    return params, []


def _viz(tree: ast.AST, state: dict[str, Any]) -> Extracted:
    for call in _calls(tree):
        for candidate in [*call.args, call.func]:
            column = _subscript_column(candidate.value if isinstance(candidate, ast.Attribute) else candidate)
            if column:
                chart = "box" if "box" in _name(call) else "histogram"
                return {"column": column, "chart": chart}, []
    return "could not tell which column is plotted"


def _export(tree: ast.AST, state: dict[str, Any]) -> Extracted:
    call = _first(tree, {"to_csv", "to_parquet"})
    path = _literal(call.args[0]) if call and call.args else None
    if not isinstance(path, str):
        return "the export path is not a literal string"
    assert call is not None
    file_format = "csv" if _name(call) == "to_csv" else "parquet"
    return {"path": Path(path).with_suffix("").as_posix(), "format": file_format}, []


EXTRACTORS: dict[str, Callable[[ast.AST, dict[str, Any]], Extracted]] = {
    "source.dataset": _source,
    "clean.drop_columns": _drop,
    "clean.impute": _impute,
    "prep.split": _split,
    "prep.encode": _encode,
    "prep.scale": _scale,
    "model.fit": _fit,
    "model.evaluate": lambda tree, state: ({}, []),
    "profile.overview": lambda tree, state: ({}, []),
    "profile.missingness": lambda tree, state: ({}, []),
    "viz.distribution": _viz,
    "sink.export": _export,
}


def _parse(node: CodeNode, notebook: bool) -> ast.AST:
    return ast.parse(sanitize_ipython(node.source)[0] if notebook else node.source)


def convert_section(graph: CodeGraph, node_ids: list[str], *, flow_id: str = "flw_converted") -> Conversion:
    code_ids = [n.id for n in graph.code_nodes()]
    unknown = [n for n in node_ids if n not in code_ids]
    if unknown or not node_ids:
        raise ConversionError(f"unknown blocks: {unknown or 'none selected'}")
    positions = sorted(code_ids.index(n) for n in node_ids)
    if positions != list(range(positions[0], positions[-1] + 1)):
        raise ConversionError("select a contiguous run of blocks; conversion works section by section")
    ordered = [code_ids[i] for i in positions]
    notebook = graph.source.kind == "notebook"
    state: dict[str, Any] = {"bindings": {}}
    result = Conversion(spec={})
    nodes: list[dict[str, Any]] = []
    types: dict[str, str] = {}
    for block_id in ordered:
        node = graph.node(block_id)
        assert node is not None
        node_type = node.matched_pattern
        if node_type not in EXTRACTORS:
            reason = f"`{node_type}` has no Flow Mode node yet" if node_type else "no recognised pattern"
            result.skipped.append((block_id, reason))
            continue
        extracted = EXTRACTORS[node_type](_parse(node, notebook), state)
        if isinstance(extracted, str):
            result.skipped.append((block_id, extracted))
            continue
        params, notes = extracted
        flow_node_id = f"c_{block_id}"
        result.converted[block_id] = flow_node_id
        types[flow_node_id] = node_type
        result.notes += [f"{block_id}: {note}" for note in notes]
        nodes.append({"id": flow_node_id, "type": node_type, "label": node.label, "params": params})
    if state.get("target") and state.get("source_ref"):
        for flow_node in nodes:
            if flow_node["type"] == "source.dataset":
                flow_node["params"]["target"] = state["target"]

    edges: list[dict[str, str]] = []
    claimed: set[tuple[str, str]] = set()
    for block_id in reversed(ordered):  # nearest upstream source wins each input port
        target = result.converted.get(block_id)
        if target is None:
            continue
        sources = sorted(
            {
                e.from_
                for e in graph.edges
                if e.to == block_id and e.from_ in result.converted and e.kind != "import"
            },
            key=code_ids.index,
            reverse=True,
        )
        for source_block in sources:
            source = result.converted[source_block]
            if types[source] in TERMINAL:
                continue
            port = "in"
            if types[target] == "model.fit":
                port = "train"
            elif types[target] == "model.evaluate":
                port = "model" if types[source] == "model.fit" else "data"
            if (target, port) in claimed:
                continue
            claimed.add((target, port))
            edges.append({
                "id": f"e{len(edges) + 1}",
                "source": source, "source_port": OUTPUT_PORT.get(types[source], "out"),
                "target": target, "target_port": port,
            })  # fmt: skip
    result.spec = {
        "flow_id": flow_id,
        "name": f"Converted from {graph.source.files[0].path if graph.source.files else 'code'}",
        "description": f"Draft converted from blocks {', '.join(ordered)}. Review before running.",
        "created_by": "user",
        "dataset_bindings": state["bindings"],
        "nodes": nodes,
        "edges": sorted(edges, key=lambda e: e["id"]),
        "meta": {
            "seed": 42,
            "converted_from": {"blocks": ordered, "skipped": [b for b, _ in result.skipped]},
        },
    }
    FlowSpec.model_validate(result.spec)
    return result
