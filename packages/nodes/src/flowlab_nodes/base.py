"""Node base class and execution/compile contexts (PRD Section 7)."""

from __future__ import annotations

import builtins
import inspect
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar, Generic, TypeVar

from flowspec import PortSchema, PortType, TableSchema
from pydantic import BaseModel

P = TypeVar("P", bound=BaseModel)


@dataclass(frozen=True)
class PortDef:
    types: tuple[PortType, ...]
    required: bool = True
    description: str = ""


class NodeCompileError(Exception):
    """Raised during type propagation. Becomes a node-attributed compile error."""

    def __init__(self, code: str, message: str, suggestion: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.suggestion = suggestion


class NodeRuntimeError(Exception):
    """Raised during execution with a stable error code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Issue:
    code: str
    message: str
    suggestion: str | None = None


@dataclass
class CompileContext:
    node_id: str
    seed: int
    dataset_bindings: Mapping[str, str]
    dataset_schemas: Mapping[str, TableSchema]
    warnings: list[Issue] = field(default_factory=list)

    def warn(self, code: str, message: str, suggestion: str | None = None) -> None:
        self.warnings.append(Issue(code, message, suggestion))

    def dataset_schema(self, ref: str) -> TableSchema:
        if ref not in self.dataset_bindings:
            bound = ", ".join(sorted(self.dataset_bindings)) or "none"
            raise NodeCompileError(
                "UNBOUND_DATASET",
                f"dataset_ref '{ref}' is not declared in dataset_bindings (bound: {bound})",
                f"Add '{ref}' to the flow's dataset_bindings",
            )
        schema = self.dataset_schemas.get(ref)
        if schema is None:
            raise NodeCompileError(
                "DATASET_NOT_FOUND",
                f"Dataset '{self.dataset_bindings[ref]}' (bound as '{ref}') could not be found",
            )
        return schema


def _noop_warning(code: str, message: str) -> None:
    return None


def _noop_log(message: str) -> None:
    return None


def _noop_file(path: Path, content_hash: str) -> None:
    return None


@dataclass
class ExecContext:
    node_id: str
    seed: int
    input_schemas: Mapping[str, PortSchema]
    output_schemas: Mapping[str, PortSchema]
    dataset_paths: Mapping[str, Path]
    dataset_hashes: Mapping[str, str]
    export_dir: Path
    on_warning: Callable[[str, str], None] = _noop_warning
    on_log: Callable[[str], None] = _noop_log
    on_file: Callable[[Path, str], None] = _noop_file

    def warn(self, code: str, message: str) -> None:
        self.on_warning(code, message)

    def log(self, message: str) -> None:
        self.on_log(message)

    def input_table(self, port: str = "in") -> TableSchema:
        return self.input_schemas[port].require_table()


class Node(Generic[P]):
    """A registered node type.

    Subclasses declare typed ports, a pydantic ``Params`` model (its JSON Schema is the
    param form), a static ``propagate`` used by the compiler, and a pure ``execute``.
    """

    type: ClassVar[str]
    title: ClassVar[str]
    category: ClassVar[str]
    Params: builtins.type[P]  # `type` is shadowed by the class attribute above
    inputs: ClassVar[Mapping[str, PortDef]] = {}
    outputs: ClassVar[Mapping[str, PortDef]] = {}

    cacheable: ClassVar[bool] = True
    stochastic: ClassVar[bool] = False
    resamples_rows: ClassVar[bool] = False
    is_hypothesis_test: ClassVar[bool] = False
    is_correction: ClassVar[bool] = False

    def learns_from_data(self, params: P) -> bool:
        """True when the node fits parameters on its input rows (leakage-relevant)."""
        return False

    def cache_inputs(self, params: P, ctx: CompileContext) -> list[str]:
        """Extra content hashes that feed the cache key (e.g. a dataset's content hash)."""
        return []

    def propagate(
        self, params: P, inputs: Mapping[str, PortSchema], ctx: CompileContext
    ) -> dict[str, PortSchema]:
        raise NotImplementedError

    def execute(self, params: P, inputs: Mapping[str, Any], ctx: ExecContext) -> dict[str, Any]:
        raise NotImplementedError

    def parse_params(self, raw: Mapping[str, Any]) -> P:
        return self.Params.model_validate(dict(raw))

    @classmethod
    def doc(cls) -> str:
        return inspect.cleandoc(cls.__doc__ or "")
