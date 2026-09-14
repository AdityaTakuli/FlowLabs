"""FlowLab node catalogue: implementations, registry and profiling."""

from . import catalogue as _catalogue  # noqa: F401  (registers nodes)
from .base import (
    CompileContext,
    ExecContext,
    Issue,
    Node,
    NodeCompileError,
    NodeRuntimeError,
    PortDef,
)
from .io import read_table, table_hash, table_to_parquet_bytes
from .profiling import dtype_name, frame_signature, infer_table_schema, schema_signature
from .registry import all_nodes, catalogue, catalogue_json, get_node, node_types, register, temporary_node
from .runtime_types import FittedModel, SplitTables

__all__ = [
    "CompileContext",
    "ExecContext",
    "FittedModel",
    "Issue",
    "Node",
    "NodeCompileError",
    "NodeRuntimeError",
    "PortDef",
    "SplitTables",
    "all_nodes",
    "catalogue",
    "catalogue_json",
    "dtype_name",
    "frame_signature",
    "get_node",
    "infer_table_schema",
    "node_types",
    "read_table",
    "register",
    "schema_signature",
    "table_hash",
    "table_to_parquet_bytes",
    "temporary_node",
]
