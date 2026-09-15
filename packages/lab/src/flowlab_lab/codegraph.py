"""CodeGraph (PRD II 10.1) and edge construction (5.4).

The graph is a projection of the source: always regenerable, never authoritative.
"""

from __future__ import annotations

import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .blocks import CELL_MARKER, Block, SourceFile, segment_text
from .patterns import match_calls
from .symbols import BlockSymbols, Confidence, analyse_block

_RANK = {"high": 2, "medium": 1, "low": 0}


class FileRef(BaseModel):
    path: str
    hash: str


class GraphSource(BaseModel):
    kind: Literal["notebook", "script", "repo_trace"]
    files: list[FileRef]
    trace_command: str | None = None
    traced_at: str | None = None


class CodeNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    kind: Literal["code", "undefined", "trace"] = "code"
    file: str
    cell_index: int | None = None
    lines: list[int]
    source: str = ""
    source_hash: str = ""
    label: str
    defines: list[str] = Field(default_factory=list)
    uses: list[str] = Field(default_factory=list)
    mutates: list[str] = Field(default_factory=list)
    imports: list[str] = Field(default_factory=list)
    calls: list[str] = Field(default_factory=list)
    side_effects: list[str] = Field(default_factory=list)
    conditional_defines: list[str] = Field(default_factory=list)
    loop_carried: list[str] = Field(default_factory=list)
    flags: list[str] = Field(default_factory=list)
    matched_pattern: str | None = None
    confidence: Confidence = "high"
    execution_count: int | None = None
    group: str | None = None


class CodeEdge(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_: str = Field(alias="from")
    to: str
    variable: str
    kind: Literal["dataflow", "mutation", "alias", "import"] = "dataflow"
    confidence: Confidence = "high"


class GraphWarning(BaseModel):
    node_id: str | None = None
    code: str
    message: str
    severity: Literal["info", "warning", "error"] = "warning"


class NodeGroup(BaseModel):
    id: str
    label: str
    node_ids: list[str]


class CodeGraph(BaseModel):
    graph_version: Literal["1.0"] = "1.0"
    project_id: str | None = None
    source: GraphSource
    nodes: list[CodeNode]
    edges: list[CodeEdge] = Field(default_factory=list)
    warnings: list[GraphWarning] = Field(default_factory=list)
    groups: list[NodeGroup] = Field(default_factory=list)
    environment: dict[str, Any] | None = None
    partial: bool = False
    analysis_ms: float | None = None

    def node(self, node_id: str) -> CodeNode | None:
        return next((n for n in self.nodes if n.id == node_id), None)

    def code_nodes(self) -> list[CodeNode]:
        return [n for n in self.nodes if n.kind != "undefined"]

    def position(self, node_id: str) -> int:
        return next(i for i, n in enumerate(self.nodes) if n.id == node_id)

    def parents(self, node_id: str) -> list[str]:
        return list(dict.fromkeys(e.from_ for e in self.edges if e.to == node_id))

    def children(self, node_id: str) -> list[str]:
        return list(dict.fromkeys(e.to for e in self.edges if e.from_ == node_id))

    def ancestors(self, node_id: str) -> set[str]:
        found: set[str] = set()
        stack = self.parents(node_id)
        while stack:
            current = stack.pop()
            if current not in found:
                found.add(current)
                stack.extend(self.parents(current))
        return found

    def descendants(self, node_id: str) -> set[str]:
        found: set[str] = set()
        stack = self.children(node_id)
        while stack:
            current = stack.pop()
            if current not in found:
                found.add(current)
                stack.extend(self.children(current))
        return found

    def in_source_order(self, node_ids: set[str] | list[str]) -> list[str]:
        wanted = set(node_ids)
        return [n.id for n in self.nodes if n.id in wanted and n.kind != "undefined"]

    def warnings_for(self, node_id: str) -> list[GraphWarning]:
        return [w for w in self.warnings if w.node_id == node_id]

    def to_json(self) -> str:
        return self.model_dump_json(by_alias=True, indent=2)

    def to_mermaid(self) -> str:
        lines = ["flowchart TD"]
        for node in self.nodes:
            label = node.label.replace('"', "'")
            shape = f'{{{{"{label}"}}}}' if node.kind == "undefined" else f'["{node.id}: {label}"]'
            lines.append(f"    {_mermaid_id(node.id)}{shape}")
        for edge in self.edges:
            arrow = "-.->" if edge.kind == "mutation" or edge.confidence == "low" else "-->"
            lines.append(f"    {_mermaid_id(edge.from_)} {arrow}|{edge.variable}| {_mermaid_id(edge.to)}")
        return "\n".join(lines)


def _mermaid_id(node_id: str) -> str:
    return node_id.replace(":", "_").replace(".", "_")


def _label(block: Block, symbols: BlockSymbols, pattern_label: str | None, number: int) -> str:
    if block.title:
        return block.title
    if "definition" in symbols.flags:
        return "def " + ", ".join(symbols.defines[:3])
    if pattern_label:
        return pattern_label
    for line in block.source.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#") and not CELL_MARKER.match(stripped):
            text = stripped.lstrip("#").strip()
            if text:
                return text[:60]
            continue
        break
    defined = [d for d in symbols.defines if d not in symbols.imports]
    if symbols.imports and not defined:
        return "Imports"
    if defined:
        return ", ".join(defined[:3]) + ("…" if len(defined) > 3 else "")
    if symbols.calls:
        return symbols.calls[0].rsplit(".", 1)[-1]
    return f"Block {number}"


def _weaker(a: Confidence, b: Confidence) -> Confidence:
    return a if _RANK[a] <= _RANK[b] else b


def build_graph(
    source_file: SourceFile, *, use_patterns: bool = True, project_id: str | None = None
) -> CodeGraph:
    started = time.perf_counter()
    notebook = source_file.kind == "notebook"
    blocks = source_file.code_blocks
    aliases: dict[str, str] = {}
    types: dict[str, str] = {}
    symbols: dict[str, BlockSymbols] = {}
    for block in blocks:
        sym = analyse_block(block.source, aliases=aliases, types=types, notebook=notebook)
        aliases.update(sym.import_map)
        types.update(sym.constructed)
        symbols[block.id] = sym

    order = {b.id: i for i, b in enumerate(blocks)}
    definers: dict[str, list[str]] = defaultdict(list)
    for block in blocks:
        for name in symbols[block.id].defines:
            definers[name].append(block.id)
    mutated = {name for s in symbols.values() for name in s.mutates}
    risky_aliases = {
        name for s in symbols.values() for pair in s.aliases if set(pair) & mutated for name in pair
    }

    nodes: list[CodeNode] = []
    edges: dict[tuple[str, str, str], CodeEdge] = {}
    warnings: list[GraphWarning] = []
    last_writer: dict[str, tuple[str, str, bool]] = {}
    consumers: dict[str, list[str]] = defaultdict(list)
    undefined: dict[str, list[str]] = defaultdict(list)
    mutations: list[tuple[str, str]] = []

    for number, block in enumerate(blocks, 1):
        sym = symbols[block.id]
        # Calls inside a function body don't describe what the definition block itself does.
        pattern = match_calls(sym.calls) if use_patterns and "definition" not in sym.flags else None
        confidence: Confidence = sym.confidence
        if set(sym.defines) & risky_aliases:
            confidence = "low"
        nodes.append(
            CodeNode(
                id=block.id,
                file=block.file,
                cell_index=block.cell_index,
                lines=[block.start_line, block.end_line],
                source=block.source,
                source_hash=block.source_hash,
                label=_label(block, sym, pattern.label if pattern else None, number),
                defines=list(sym.defines),
                uses=list(sym.uses),
                mutates=list(sym.mutates),
                imports=list(sym.imports),
                calls=list(sym.calls),
                side_effects=list(sym.side_effects),
                conditional_defines=list(sym.conditional_defines),
                loop_carried=list(sym.loop_carried),
                flags=list(sym.flags),
                matched_pattern=pattern.node_type if pattern else None,
                confidence=confidence,
                execution_count=block.execution_count,
            )
        )
        if sym.parse_error:
            line = (block.start_line if not notebook else 1) + (sym.parse_error_line or 1) - 1
            warnings.append(
                GraphWarning(
                    node_id=block.id,
                    code="PARSE_ERROR",
                    severity="error",
                    message=f"Syntax error at line {line}: {sym.parse_error}",
                )
            )
        if "star_import" in sym.flags:
            warnings.append(
                GraphWarning(
                    node_id=block.id,
                    code="STAR_IMPORT",
                    message="`import *` makes names appear from nowhere; edges may be missing",
                )
            )
        if "dynamic" in sym.flags:
            warnings.append(
                GraphWarning(
                    node_id=block.id,
                    code="DYNAMIC_CODE",
                    message="exec/eval/globals-style code cannot be analysed statically",
                )
            )

        consumed = [*sym.uses, *(n for n in sym.builtin_uses if n in last_writer), *sym.mutates]
        alias_sources = {old for new, old in sym.aliases}
        for name in dict.fromkeys(consumed):
            writer = last_writer.get(name)
            if writer is None:
                later = [d for d in definers.get(name, []) if order[d] > order[block.id]]
                if later:
                    warnings.append(
                        GraphWarning(
                            node_id=block.id,
                            code="USE_BEFORE_DEFINITION",
                            message=f"`{name}` is used here but only defined later, in {later[0]}",
                        )
                    )
                elif name not in sym.builtin_uses:
                    undefined[name].append(block.id)
                continue
            source_id, write_kind, conditional = writer
            if source_id == block.id:
                continue
            kind = {"import": "import", "mutate": "mutation"}.get(write_kind, "dataflow")
            if name in alias_sources and kind == "dataflow":
                kind = "alias"
            edge_confidence: Confidence = "medium" if conditional or kind == "mutation" else "high"
            if name in risky_aliases:
                edge_confidence = "low"
            key = (source_id, block.id, name)
            if key in edges:
                edge_confidence = _weaker(edges[key].confidence, edge_confidence)
            edges[key] = CodeEdge(
                from_=source_id, to=block.id, variable=name, kind=kind, confidence=edge_confidence
            )
            consumers[name].append(block.id)
            if conditional and kind != "import":
                warnings.append(
                    GraphWarning(
                        node_id=block.id,
                        code="CONDITIONAL_DEFINITION",
                        severity="info",
                        message=(
                            f"`{name}` may not be defined at runtime (assigned conditionally in {source_id})"
                        ),
                    )
                )

        for name in sym.mutates:
            last_writer[name] = (block.id, "mutate", False)
            mutations.append((block.id, name))
        for name in sym.defines:
            last_writer[name] = (
                block.id,
                "import" if name in sym.imports else "define",
                name in sym.conditional_defines,
            )
        for name in sym.deletes:
            last_writer.pop(name, None)
        for new, old in sym.aliases:
            if {new, old} & mutated:
                warnings.append(
                    GraphWarning(
                        node_id=block.id,
                        code="ALIAS_MUTATION",
                        message=(
                            f"`{new}` and `{old}` are the same object and one of them is mutated; both change"
                        ),
                    )
                )

    for mutator, name in mutations:
        others = [c for c in dict.fromkeys(consumers[name]) if c != mutator]
        if others:
            warnings.append(
                GraphWarning(
                    node_id=mutator,
                    code="MUTATION_SHARED_OBJECT",
                    message=(
                        f"This block mutates `{name}`, which {', '.join(others)} "
                        f"also read{'s' if len(others) == 1 else ''}"
                    ),
                )
            )

    for name, users in undefined.items():
        undefined_id = f"undefined:{name}"
        nodes.append(
            CodeNode(
                id=undefined_id,
                kind="undefined",
                file=source_file.path,
                lines=[0, 0],
                label=f"`{name}` is used but never defined here",
                defines=[name],
                confidence="low",
            )
        )
        for user in dict.fromkeys(users):
            edges[(undefined_id, user, name)] = CodeEdge(
                from_=undefined_id, to=user, variable=name, confidence="low"
            )
        warnings.append(
            GraphWarning(
                node_id=undefined_id,
                code="UNDEFINED_NAME",
                severity="error",
                message=(
                    f"`{name}` is used but never defined here (used by {', '.join(dict.fromkeys(users))})"
                ),
            )
        )

    counts = [b.execution_count for b in blocks if b.execution_count is not None]
    if notebook and counts != sorted(counts):
        warnings.append(
            GraphWarning(
                code="OUT_OF_ORDER_EXECUTION",
                message="This notebook's saved outputs don't match its source order",
            )
        )

    return CodeGraph(
        project_id=project_id,
        source=GraphSource(
            kind="notebook" if notebook else "script",
            files=[FileRef(path=source_file.path, hash=source_file.hash)],
        ),
        nodes=nodes,
        edges=list(edges.values()),
        warnings=warnings,
        analysis_ms=round((time.perf_counter() - started) * 1000, 2),
    )


_GRAPH_CACHE: dict[tuple[str, str], CodeGraph] = {}


def analyse_text(path: str, text: str, *, use_patterns: bool = True) -> CodeGraph:
    """Analyse source text; cached by (path, content hash) and discarded when the hash changes."""
    source_file = segment_text(path, text)
    key = (path, source_file.hash)
    if use_patterns and key in _GRAPH_CACHE:
        return _GRAPH_CACHE[key]
    graph = build_graph(source_file, use_patterns=use_patterns)
    if use_patterns:
        _GRAPH_CACHE[key] = graph
    return graph


def analyse_path(file: Path, root: Path | None = None) -> CodeGraph:
    rel = file.relative_to(root).as_posix() if root else file.name
    return analyse_text(rel, file.read_text(encoding="utf-8"))
