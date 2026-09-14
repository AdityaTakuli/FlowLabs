"""Node registry and catalogue export (the shared-truth JSON Schema, PRD Section 22)."""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, TypeVar

from .base import Node

_REGISTRY: dict[str, Node[Any]] = {}

N = TypeVar("N", bound=type[Node[Any]])


def register(cls: N) -> N:
    if cls.type in _REGISTRY:
        raise ValueError(f"node type '{cls.type}' is already registered")
    _REGISTRY[cls.type] = cls()
    return cls


def get_node(node_type: str) -> Node[Any] | None:
    return _REGISTRY.get(node_type)


def node_types() -> list[str]:
    return sorted(_REGISTRY)


def all_nodes() -> list[Node[Any]]:
    return [_REGISTRY[t] for t in node_types()]


@contextmanager
def temporary_node(cls: type[Node[Any]]) -> Iterator[None]:
    """Register a node for the duration of a block (used by tests)."""
    register(cls)
    try:
        yield
    finally:
        _REGISTRY.pop(cls.type, None)


def catalogue() -> dict[str, Any]:
    nodes = []
    for node in all_nodes():
        nodes.append(
            {
                "type": node.type,
                "title": node.title,
                "category": node.category,
                "description": node.doc(),
                "inputs": {
                    name: {
                        "types": [t.value for t in port.types],
                        "required": port.required,
                        "description": port.description,
                    }
                    for name, port in node.inputs.items()
                },
                "outputs": {
                    name: {"types": [t.value for t in port.types], "description": port.description}
                    for name, port in node.outputs.items()
                },
                "params_schema": node.Params.model_json_schema(),
                "flags": {
                    "cacheable": node.cacheable,
                    "stochastic": node.stochastic,
                    "resamples_rows": node.resamples_rows,
                    "is_hypothesis_test": node.is_hypothesis_test,
                    "is_correction": node.is_correction,
                },
            }
        )
    return {"catalogue_version": "1", "nodes": nodes}


def catalogue_json() -> str:
    return json.dumps(catalogue(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"
