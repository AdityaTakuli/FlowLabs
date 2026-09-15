"""Structure graphs for any language: functions, classes and the calls between them.

Parsed with tree-sitter (``tree-sitter-language-pack``), so one walker serves Python, TypeScript,
Go, Rust, Java, C#, C/C++, Ruby, PHP, Kotlin, Swift and the rest. Grammars other than the bundled
cache are downloaded once on first use. Like the Code Mode graph, this is a projection of the
source: always regenerable, never authoritative. Editing a node rewrites only that node's span and
is refused when it would introduce a syntax error.
"""

from __future__ import annotations

import hashlib
import re
import time
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .languages import language_for

NodeKind = Literal["function", "method", "class", "module", "external"]
EdgeKind = Literal["call", "member"]

MAX_NODES = 400
MAX_SITES = 5
MAX_FILE_BYTES = 1_000_000

FUNCTION_TYPES = frozenset(
    {
        "function_definition", "function_declaration", "method_definition", "method_declaration",
        "function_item", "method", "singleton_method", "constructor_declaration", "method_signature",
        "function_signature", "func_literal", "local_function", "function_definition_statement",
    }
)  # fmt: skip
ANONYMOUS_FUNCTIONS = frozenset({"arrow_function", "function_expression", "function", "lambda_expression"})
CLASS_TYPES = frozenset(
    {
        "class_definition", "class_declaration", "class_specifier", "struct_specifier", "struct_item",
        "impl_item", "trait_item", "interface_declaration", "enum_declaration", "object_declaration",
        "object_definition", "module", "class", "record_declaration", "protocol_declaration",
        "trait_definition", "struct_declaration", "namespace_definition", "mod_item", "enum_item",
    }
)  # fmt: skip
CALL_TYPES = frozenset(
    {
        "call", "call_expression", "method_invocation", "invocation_expression", "function_call_expression",
        "member_call_expression", "scoped_call_expression", "macro_invocation", "command",
        "new_expression", "object_creation_expression", "function_call",
    }
)  # fmt: skip
IDENTIFIER_TYPES = frozenset(
    {
        "identifier", "simple_identifier", "type_identifier", "field_identifier", "property_identifier",
        "word", "constant", "name", "command_name", "namespace_identifier",
    }
)  # fmt: skip
SELF_RECEIVERS = frozenset({"self", "this", "@", "cls", "super", "$this"})
ELIXIR_DEFS = {"def": "function", "defp": "function", "defmacro": "function", "defmodule": "class"}
IDENT = re.compile(r"[A-Za-z_$][\w$]*[!?]?")


class StructureError(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


class CallSite(BaseModel):
    line: int
    text: str


class StructureNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    kind: NodeKind
    name: str
    qualified_name: str
    parent: str | None = None
    file: str
    line_start: int
    line_end: int
    signature: str = ""
    doc: str | None = None
    source: str = ""
    source_hash: str = ""
    editable: bool = True
    calls: list[str] = Field(default_factory=list)
    loc: int = 0


class StructureEdge(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_: str = Field(alias="from")
    to: str
    kind: EdgeKind
    names: list[str] = Field(default_factory=list)
    sites: list[CallSite] = Field(default_factory=list)


class SyntaxProblem(BaseModel):
    line: int
    message: str


class StructureGraph(BaseModel):
    file: str
    language: str
    language_name: str
    monaco: str
    hash: str
    nodes: list[StructureNode]
    edges: list[StructureEdge]
    problems: list[SyntaxProblem] = Field(default_factory=list)
    truncated: bool = False
    analysis_ms: float | None = None


# ------------------------------------------------------------------------------ parsing
def _parser(language: str) -> Any:
    try:
        from tree_sitter_language_pack import get_parser
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise StructureError("PARSER_MISSING", "install tree-sitter-language-pack to view this file") from exc
    try:
        return get_parser(language)
    except Exception as exc:  # noqa: BLE001 - unknown language, or its grammar could not be downloaded
        raise StructureError(
            "GRAMMAR_UNAVAILABLE",
            f"no {language} grammar available ({type(exc).__name__}); it is downloaded once on first use",
        ) from exc


def _text(node: Any) -> str:
    raw: bytes | None = node.text
    return raw.decode("utf-8", errors="replace") if raw else ""


def _last_identifier(text: str) -> str | None:
    found = IDENT.findall(text.split("(")[0].split("<")[0])
    return found[-1] if found else None


def _name(node: Any) -> str | None:
    named = node.child_by_field_name("name")
    if named is not None:
        text = _text(named)
        if text and len(text) < 80 and not re.search(r"[\s(]", text):
            return text
        return _last_identifier(text)
    current = node
    while current.child_by_field_name("declarator") is not None:  # C/C++ declarator chains
        current = current.child_by_field_name("declarator")
    if current is not node:
        return _last_identifier(_text(current))
    for child in node.named_children:
        if child.type in IDENTIFIER_TYPES:
            return _text(child)
    return None


@dataclass
class _Definition:
    node: Any  # the tree-sitter node naming the definition
    span: Any  # the node whose byte span is the definition's source
    kind: NodeKind
    name: str
    parent: _Definition | None
    children: list[_Definition] = field(default_factory=list)

    @property
    def qualified(self) -> str:
        return f"{self.parent.qualified}.{self.name}" if self.parent else self.name


def _definition(node: Any) -> tuple[Any, str, Literal["function", "class"]] | None:
    """(span node, name, kind) when ``node`` starts a named definition."""
    kind: Literal["function", "class"] | None = None
    span = node
    name: str | None = None
    if node.type in FUNCTION_TYPES:
        kind = "function"
        if node.type in ("method_signature", "function_signature"):  # Dart: body is the next sibling
            sibling = node.next_named_sibling
            if sibling is not None and sibling.type == "function_body":
                span = _Span(node.start_byte, sibling.end_byte, node.start_point[0], sibling.end_point[0])
            else:
                return None
        name = _name(node)
        if node.type == "function_definition" and name == "function":  # R: name <- function(...)
            name = None
    elif node.type in CLASS_TYPES:
        kind = "class"
        name = _name(node)
    elif node.type == "call" and node.child_by_field_name("target") is not None:  # Elixir def/defmodule
        target = _text(node.child_by_field_name("target"))
        if target in ELIXIR_DEFS:
            kind = "function" if ELIXIR_DEFS[target] == "function" else "class"
            arguments = next((c for c in node.named_children if c.type == "arguments"), None)
            name = _last_identifier(_text(arguments)) if arguments is not None else None
    if kind is None:
        if node.type in ANONYMOUS_FUNCTIONS or node.type == "function_definition":
            parent = node.parent
            if parent is not None and parent.type in ("variable_declarator", "pair", "assignment_expression"):
                target = parent.child_by_field_name("name") or parent.child_by_field_name("left")
                target = target or parent.child_by_field_name("key")
                name = _last_identifier(_text(target)) if target is not None else None
                statement = parent.parent
                span = (
                    statement if statement is not None and statement.type.endswith("declaration") else parent
                )
                kind = "function"
            elif parent is not None and parent.type == "binary_operator":  # R
                lhs = parent.child_by_field_name("lhs")
                name = _text(lhs) if lhs is not None else None
                span, kind = parent, "function"
        if kind is None:
            return None
    if not name:
        return None
    if node.parent is not None and node.parent.type == "decorated_definition":
        span = node.parent
    return span, name, kind


@dataclass(frozen=True)
class _Span:
    start_byte: int
    end_byte: int
    start_row: int
    end_row: int

    @property
    def start_point(self) -> tuple[int, int]:
        return (self.start_row, 0)

    @property
    def end_point(self) -> tuple[int, int]:
        return (self.end_row, 0)


def _collect(root: Any) -> list[_Definition]:
    top: list[_Definition] = []

    def visit(node: Any, parent: _Definition | None) -> None:
        for child in node.children:
            found = _definition(child)
            if found is None:
                visit(child, parent)
                continue
            span, name, kind = found
            if kind == "function" and parent is not None and parent.kind != "class":
                continue  # functions inside functions stay part of their enclosing unit
            node_kind: NodeKind = "method" if kind == "function" and parent is not None else kind
            definition = _Definition(child, span, node_kind, name, parent)
            (parent.children if parent else top).append(definition)
            if kind == "class":
                visit(child, definition)

    visit(root, None)
    return top


def _walk(items: Iterable[_Definition]) -> Iterator[_Definition]:
    for item in items:
        yield item
        yield from _walk(item.children)


def _problems(root: Any) -> list[SyntaxProblem]:
    problems: list[SyntaxProblem] = []
    stack = [root]
    while stack and len(problems) < 20:
        node = stack.pop()
        if node.is_error or node.is_missing:
            what = f"missing {node.type}" if node.is_missing else "syntax error"
            problems.append(SyntaxProblem(line=node.start_point[0] + 1, message=what))
            continue
        if node.has_error:
            stack.extend(reversed(node.children))
    return sorted(problems, key=lambda p: p.line)


def _docstring(node: Any) -> str | None:
    body = node.child_by_field_name("body")
    first = body.named_children[0] if body is not None and body.named_children else None
    while first is not None and first.type == "expression_statement" and first.named_children:
        first = first.named_children[0]
    if first is None or "string" not in first.type:
        return None
    lines = _text(first).strip("\"'` \n").splitlines()
    return (lines[0].strip()[:160] or None) if lines else None


def _line_start(data: bytes, start: int) -> int:
    begin = data.rfind(b"\n", 0, start) + 1
    return begin if not data[begin:start].strip() else start


RECEIVER_FIELDS = ("object", "operand", "value", "receiver", "expression", "scope", "argument")
MEMBER_FIELDS = ("property", "field", "attribute", "name", "method")


def _target_name(target: Any) -> tuple[str | None, str | None]:
    """(member name, receiver text) of a callee expression such as ``a.b().c`` or ``pkg::f``."""
    if target.type in IDENTIFIER_TYPES:
        return _text(target), None
    for member in MEMBER_FIELDS:
        child = target.child_by_field_name(member)
        if child is not None:
            receiver = next(
                (
                    target.child_by_field_name(f)
                    for f in RECEIVER_FIELDS
                    if target.child_by_field_name(f) is not None
                ),
                None,
            )
            return _last_identifier(_text(child)), _text(receiver) if receiver is not None else ""
    text = re.sub(r"\([^()]*\)", "", _text(target))
    return _last_identifier(text), None


def _callee(node: Any) -> tuple[str | None, str | None]:
    """(called name, receiver text) for a call node; receiver is None for a bare call."""
    if node.type == "command":  # shell
        target = node.child_by_field_name("name")
        return (_text(target) or None, None) if target is not None else (None, None)
    receiver_node = node.child_by_field_name("object") or node.child_by_field_name("receiver")
    for name in ("method", "name"):  # Java/Ruby/PHP put the member on the call itself
        member = node.child_by_field_name(name)
        if member is not None and receiver_node is not None:
            return _last_identifier(_text(member)), _text(receiver_node)
    target = None
    for name in ("function", "method", "name", "macro", "constructor", "type", "target"):
        target = node.child_by_field_name(name)
        if target is not None:
            break
    if target is None:
        target = node.named_children[0] if node.named_children else None
    if target is None:
        return None, None
    return _target_name(target)


def _calls(unit: Any, skip: list[tuple[int, int]]) -> list[tuple[str, str | None, int, str]]:
    found: list[tuple[str, str | None, int, str]] = []
    stack = [unit]
    while stack:
        node = stack.pop()
        if any(start <= node.start_byte and node.end_byte <= end for start, end in skip):
            continue
        if node.type in CALL_TYPES:
            name, receiver = _callee(node)
            if name and name not in ELIXIR_DEFS:
                snippet = _text(node).splitlines()[0][:120] if node.text else ""
                found.append((name, receiver, node.start_point[0] + 1, snippet))
        stack.extend(reversed(node.children))
    return sorted(found, key=lambda call: call[2])


# ---------------------------------------------------------------------------- symbols
@dataclass(frozen=True)
class Symbol:
    file: str
    qualified: str
    name: str
    kind: NodeKind
    line: int


_SYMBOL_CACHE: dict[tuple[str, str], list[Symbol]] = {}


def symbols_of(path: str, text: str) -> list[Symbol]:
    """Named definitions in one file (cached by content)."""
    key = (path, hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest())
    if key in _SYMBOL_CACHE:
        return _SYMBOL_CACHE[key]
    language = language_for(path)
    if language is None or len(text) > MAX_FILE_BYTES:
        return []
    tree = _parser(language.id).parse(text.encode("utf-8", errors="replace"))
    found = [
        Symbol(path, d.qualified, d.name, d.kind, d.span.start_point[0] + 1)
        for d in _walk(_collect(tree.root_node))
    ]
    if len(_SYMBOL_CACHE) > 5000:
        _SYMBOL_CACHE.clear()
    _SYMBOL_CACHE[key] = found
    return found


def language_family(language: str) -> str:
    return {"typescript": "js", "tsx": "js", "javascript": "js", "c": "c", "cpp": "c"}.get(language, language)


# ------------------------------------------------------------------------------ graph
def build_structure(path: str, text: str, project_symbols: Iterable[Symbol] = ()) -> StructureGraph:
    started = time.perf_counter()
    language = language_for(path)
    if language is None:
        raise StructureError("UNSUPPORTED_LANGUAGE", f"FlowLab does not know the language of {path}")
    data = text.encode("utf-8", errors="replace")
    if len(data) > MAX_FILE_BYTES:
        raise StructureError("FILE_TOO_LARGE", f"{path} is over 1 MB; structure graphs are for source files")
    tree = _parser(language.id).parse(data)
    definitions = list(_walk(_collect(tree.root_node)))
    truncated = len(definitions) > MAX_NODES
    definitions = definitions[:MAX_NODES]

    nodes: list[StructureNode] = []
    ids: dict[int, str] = {}
    used: set[str] = set()
    for d in definitions:
        base = f"{d.qualified} ({d.node.type.replace('_', ' ')})" if d.kind == "class" else d.qualified
        node_id, counter = base, 2
        while node_id in used:
            node_id, counter = f"{base}#{counter}", counter + 1
        used.add(node_id)
        ids[id(d)] = node_id
        start = _line_start(data, d.span.start_byte)
        source = data[start : d.span.end_byte].decode("utf-8", errors="replace")
        first = source.strip().splitlines()[0] if source.strip() else ""
        doc = _docstring(d.node)
        nodes.append(
            StructureNode(
                id=node_id,
                kind=d.kind,
                name=d.name,
                qualified_name=d.qualified,
                parent=ids.get(id(d.parent)) if d.parent else None,
                file=path,
                line_start=d.span.start_point[0] + 1,
                line_end=d.span.end_point[0] + 1,
                signature=first[:160],
                doc=doc,
                source=source,
                source_hash=hashlib.sha256(source.encode("utf-8")).hexdigest()[:16],
                loc=source.count("\n") + 1,
            )
        )
    by_def = {ids[id(d)]: d for d in definitions}
    by_def_type = {node_id: d.node.type for node_id, d in by_def.items()}
    node_by_id = {n.id: n for n in nodes}

    # who can a bare name mean?
    top_level: dict[str, list[str]] = {}
    members: dict[str, dict[str, str]] = {}
    any_method: dict[str, list[str]] = {}
    for n in nodes:
        if n.parent is None and by_def_type.get(n.id) == "method_declaration":  # Go: func (s *S) Run()
            any_method.setdefault(n.name, []).append(n.id)
        if n.parent is None:
            top_level.setdefault(n.name, []).append(n.id)
        else:
            members.setdefault(n.parent, {})[n.name] = n.id
            any_method.setdefault(n.name, []).append(n.id)
    external: dict[str, list[Symbol]] = {}
    for symbol in project_symbols:
        if symbol.file != path:
            external.setdefault(symbol.name, []).append(symbol)

    edges: dict[tuple[str, str, EdgeKind], StructureEdge] = {}

    def link(
        source: str, target: str, kind: EdgeKind, name: str | None = None, site: CallSite | None = None
    ) -> None:
        edge = edges.setdefault((source, target, kind), StructureEdge(from_=source, to=target, kind=kind))
        if name and name not in edge.names:
            edge.names.append(name)
        if site and len(edge.sites) < MAX_SITES:
            edge.sites.append(site)

    for n in nodes:
        if n.parent:
            link(n.parent, n.id, "member")

    top_spans: list[tuple[int, int]] = []
    for node_id, d in by_def.items():
        owner = node_by_id[node_id]
        skip = [(c.span.start_byte, c.span.end_byte) for c in d.children]
        if d.parent is None:
            top_spans.append((d.span.start_byte, d.span.end_byte))
        calls = _calls(d.node if d.span is d.node or isinstance(d.span, _Span) else d.span, skip)
        seen: list[str] = []
        for name, receiver, line, snippet in calls:
            if name not in seen:
                seen.append(name)
            target = _resolve(owner, name, receiver, top_level, members, any_method, node_by_id)
            if target is None and receiver in (None, *SELF_RECEIVERS) and name in external:
                target = _external(external[name], nodes, node_by_id)
            if target is not None and target != owner.id:
                link(owner.id, target, "call", name, CallSite(line=line, text=snippet))
        owner.calls = seen[:40]

    # top-level statements (scripts, route registration, main) as one read-only node
    loose = _calls(tree.root_node, top_spans)
    if loose:
        module = StructureNode(
            id="‹top level›",
            kind="module",
            name="top level",
            qualified_name="‹top level›",
            file=path,
            line_start=loose[0][2],
            line_end=loose[-1][2],
            signature="statements outside any function or class",
            editable=False,
            calls=list(dict.fromkeys(call[0] for call in loose))[:40],
        )
        nodes.insert(0, module)
        node_by_id[module.id] = module
        for name, receiver, line, snippet in loose:
            target = _resolve(module, name, receiver, top_level, members, any_method, node_by_id)
            if target is None and receiver is None and name in external:
                target = _external(external[name], nodes, node_by_id)
            if target is not None:
                link(module.id, target, "call", name, CallSite(line=line, text=snippet))

    return StructureGraph(
        file=path,
        language=language.id,
        language_name=language.name,
        monaco=language.monaco,
        hash=hashlib.sha256(data).hexdigest(),
        nodes=nodes,
        edges=list(edges.values()),
        problems=_problems(tree.root_node),
        truncated=truncated,
        analysis_ms=round((time.perf_counter() - started) * 1000, 2),
    )


def _resolve(
    owner: StructureNode,
    name: str,
    receiver: str | None,
    top_level: dict[str, list[str]],
    members: dict[str, dict[str, str]],
    any_method: dict[str, list[str]],
    nodes: dict[str, StructureNode],
) -> str | None:
    if receiver is not None and receiver.lstrip("@") in SELF_RECEIVERS | {""} or receiver == "@":
        parent = owner.parent if owner.kind == "method" else owner.id if owner.kind == "class" else None
        if parent and name in members.get(parent, {}):
            return members[parent][name]
    if receiver is None:
        if owner.parent and name in members.get(owner.parent, {}) and nodes[owner.parent].kind == "class":
            candidate = members[owner.parent][name]
            if name not in top_level:
                return candidate
        if len(top_level.get(name, [])) == 1:
            return top_level[name][0]
    elif name in any_method and len(any_method[name]) == 1:
        return any_method[name][0]  # obj.method() with one method of that name in the file
    return None


def _external(
    candidates: list[Symbol], nodes: list[StructureNode], by_id: dict[str, StructureNode]
) -> str | None:
    tops = [s for s in candidates if "." not in s.qualified] or candidates
    if len(tops) != 1:
        return None  # ambiguous across files: do not guess
    symbol = tops[0]
    node_id = f"{symbol.file}::{symbol.qualified}"
    if node_id not in by_id:
        node = StructureNode(
            id=node_id,
            kind="external",
            name=symbol.name,
            qualified_name=symbol.qualified,
            file=symbol.file,
            line_start=symbol.line,
            line_end=symbol.line,
            signature=f"defined in {symbol.file}:{symbol.line}",
            editable=False,
        )
        nodes.append(node)
        by_id[node_id] = node
    return node_id


# ------------------------------------------------------------------------------ edits
@dataclass(frozen=True)
class EditResult:
    text: str
    graph: StructureGraph


def edit_node(path: str, text: str, node_id: str, source: str) -> str:
    """The file text with ``node_id`` replaced by ``source``; refuses edits that break the syntax."""
    language = language_for(path)
    if language is None:
        raise StructureError("UNSUPPORTED_LANGUAGE", f"FlowLab does not know the language of {path}")
    if not source.strip():
        raise StructureError(
            "EMPTY_SOURCE", "a node cannot be emptied; delete the code in the editor instead"
        )
    data = text.encode("utf-8", errors="replace")
    parser = _parser(language.id)
    tree = parser.parse(data)
    definition = next(
        (d for d in _walk(_collect(tree.root_node)) if _node_id(d) == node_id or d.qualified == node_id), None
    )
    if definition is None:
        raise StructureError("UNKNOWN_NODE", f"{node_id} is not in {path} any more")
    start = _line_start(data, definition.span.start_byte)
    replacement = source.rstrip("\n").encode("utf-8")
    new_data = data[:start] + replacement + data[definition.span.end_byte :]
    before = len(_problems(tree.root_node))
    after = _problems(parser.parse(new_data).root_node)
    if len(after) > before:
        first_line = definition.span.start_point[0] + 1
        problem = after[0]
        relative = problem.line - first_line + 1
        line = relative if 1 <= relative <= source.count("\n") + 1 else None
        raise StructureError(
            "SYNTAX_ERROR",
            f"Not saved: {problem.message} on line {line if line else problem.line}",
            {"line": line},
        )
    return new_data.decode("utf-8", errors="replace")


def _node_id(d: _Definition) -> str:
    return f"{d.qualified} ({d.node.type.replace('_', ' ')})" if d.kind == "class" else d.qualified
