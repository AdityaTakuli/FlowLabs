"""Graph → code manipulation (PRD II 6).

Every canvas operation is a source transformation applied to the file, after which the graph
is regenerated. Rules enforced here:

* region moves are byte-preserving outside the touched region; code rewrites use libcst;
* any operation that could change which block defines a variable another block reads is
  re-analysed first and refused with the blocking edge named;
* a backup is written to ``.flowlab/backups/`` before the atomic write, and ``revert_last``
  restores it (one undo step per operation);
* if the file changed on disk since the graph was rendered, the operation is refused unless
  the target blocks are unchanged.
"""

from __future__ import annotations

import ast
import datetime as dt
import json
import keyword
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import libcst as cst
from libcst.metadata import (
    CodePosition,
    ExpressionContext,
    ExpressionContextProvider,
    MetadataWrapper,
    ParentNodeProvider,
    PositionProvider,
)

from .blocks import CELL_MARKER, SourceFile, sanitize_ipython, segment_text
from .codegraph import CodeGraph, build_graph
from .project import LabProject

Operation = Literal[
    "edit", "reorder", "split", "merge", "delete", "duplicate", "extract", "insert", "add_markers"
]
# For each code block of the rewritten file, in order: the old block ids it came from ([] = new).
Composition = list[list[str]]
Outcome = tuple[str, str, list[str]]


class TransformError(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


class TransformConflict(TransformError):
    pass


@dataclass
class TransformResult:
    op: str
    file: str
    message: str
    backup: str
    new_hash: str
    graph: CodeGraph
    affected: list[str] = field(default_factory=list)


# ------------------------------------------------------------------------ analysis


def _graph_for(path: str, text: str) -> CodeGraph:
    return build_graph(segment_text(path, text), use_patterns=False)


def _check_resolutions(before: CodeGraph, new_text: str, path: str, composition: Composition) -> None:
    """Refuse when an existing read would resolve to a different definer (or to nothing)."""
    after = _graph_for(path, new_text)
    after_ids = [n.id for n in after.code_nodes()]
    if len(after_ids) != len(composition):
        raise TransformError("BOUNDARY_CHANGE", "this edit would change block boundaries; refusing to guess")
    old_to_new = {old: after_ids[i] for i, olds in enumerate(composition) for old in olds}
    new_to_old = {after_ids[i]: olds[0] if olds else "the new block" for i, olds in enumerate(composition)}
    resolved = {(e.to, e.variable): e.from_ for e in after.edges}
    for edge in before.edges:
        consumer = old_to_new.get(edge.to)
        if consumer is None or edge.from_.startswith("undefined:"):
            continue
        expected = old_to_new.get(edge.from_)
        if expected == consumer:
            continue  # both ends were merged into one block
        actual = resolved.get((consumer, edge.variable))
        if actual == expected:
            continue
        if actual is None or actual.startswith("undefined:"):
            outcome = "be undefined"
        else:
            outcome = f"come from {new_to_old.get(actual, actual)}"
        raise TransformError(
            "DEPENDENCY_VIOLATION",
            f"Refused: {edge.to} uses `{edge.variable}` from {edge.from_}; "
            f"after this change it would {outcome}",
            {"blocking_edge": {"from": edge.from_, "to": edge.to, "variable": edge.variable}},
        )


def _identity(graph: CodeGraph) -> Composition:
    return [[n.id] for n in graph.code_nodes()]


def _parses(code: str, notebook: bool) -> bool:
    try:
        ast.parse(sanitize_ipython(code)[0] if notebook else code)
    except SyntaxError:
        return False
    return True


# ----------------------------------------------------------------------- documents


class _ScriptDoc:
    """A script as a preamble plus one line region per block (block + trailing separator lines)."""

    def __init__(self, source_file: SourceFile) -> None:
        self.source_file = source_file
        lines = source_file.text.splitlines(keepends=True)
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += "\n"
        ordered = sorted(source_file.blocks, key=lambda b: b.start_line)
        self.order = [b.id for b in ordered]
        self.preamble = lines[: ordered[0].start_line - 1] if ordered else lines
        self.regions: dict[str, list[str]] = {}
        for index, block in enumerate(ordered):
            end = ordered[index + 1].start_line - 1 if index + 1 < len(ordered) else len(lines)
            self.regions[block.id] = lines[block.start_line - 1 : end]

    def code_order(self, order: list[str]) -> list[str]:
        return [bid for bid in order if bid.startswith("b")]

    def text(self, order: list[str] | None = None, regions: dict[str, list[str]] | None = None) -> str:
        order = order or self.order
        regions = dict(regions or self.regions)
        markers = self.source_file.has_markers
        for position, bid in enumerate(order):
            region = list(regions[bid])
            if markers and position > 0 and region and not CELL_MARKER.match(region[0]):
                region.insert(0, "# %%\n")  # a marker-less region would otherwise join its neighbour
            if position < len(order) - 1 and region and region[-1].strip():
                region.append("\n")  # keep a separator so plain-script grouping is unchanged
            regions[bid] = region
        return "".join([*self.preamble, *(line for bid in order for line in regions[bid])])


def _notebook_dump(notebook: dict[str, Any], original: str) -> str:
    second_line = original.split("\n", 2)[1] if original.count("\n") > 1 else ""
    indent = len(second_line) - len(second_line.lstrip(" ")) or 1
    return json.dumps(notebook, indent=indent, ensure_ascii=False) + ("\n" if original.endswith("\n") else "")


def _set_cell_text(cell: dict[str, Any], text: str) -> None:
    cell["source"] = text.splitlines(keepends=True) if isinstance(cell.get("source"), list) else text


def _new_code_cell(text: str, like: dict[str, Any] | None = None) -> dict[str, Any]:
    cell: dict[str, Any] = {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": "",
    }
    if like is not None:
        if "id" in like:
            cell["id"] = uuid.uuid4().hex[:8]
        if isinstance(like.get("source"), list):
            cell["source"] = []
    _set_cell_text(cell, text)
    return cell


def _cell_block_ids(sf: SourceFile, cells: list[dict[str, Any]]) -> dict[int, str]:
    by_index = {b.cell_index: b.id for b in sf.code_blocks}
    return {id(cell): by_index[i] for i, cell in enumerate(cells) if i in by_index}


# ---------------------------------------------------------------------- libcst rewrites


def _strip_marker(code: str) -> tuple[str, str]:
    lines = code.splitlines(keepends=True)
    if lines and CELL_MARKER.match(lines[0]):
        return lines[0], "".join(lines[1:])
    return "", code


def rename_defined(code: str, mapping: dict[str, str]) -> str:
    """Rename names a block defines. Reads that happen before the first assignment completes
    (``df = df.dropna()``) keep the original name. In-place updates (``x += 1``) are refused."""
    marker, body = _strip_marker(code)
    wrapper = MetadataWrapper(cst.parse_module(body))
    contexts = wrapper.resolve(ExpressionContextProvider)
    positions = wrapper.resolve(PositionProvider)
    parents = wrapper.resolve(ParentNodeProvider)

    def start(node: cst.CSTNode) -> tuple[int, int]:
        position: CodePosition = positions[node].start
        return position.line, position.column

    def binding_complete(node: cst.CSTNode) -> tuple[int, int]:
        current: cst.CSTNode = node
        while current in parents and not isinstance(
            current, cst.SimpleStatementLine | cst.BaseCompoundStatement
        ):
            if isinstance(current, cst.AugAssign):
                raise TransformError(
                    "DUPLICATE_UNSAFE", "the block updates a variable in place before assigning it"
                )
            current = parents[current]
        if isinstance(current, cst.SimpleStatementLine):
            end = positions[current].end
            return end.line, end.column
        return start(node)  # loop / with / except targets are bound where they appear

    threshold: dict[str, tuple[int, int]] = {}
    for node, context in contexts.items():
        if isinstance(node, cst.Name) and node.value in mapping and context == ExpressionContext.STORE:
            candidate = binding_complete(node)
            if node.value not in threshold or start(node) < threshold[node.value]:
                threshold[node.value] = candidate
    targets = {
        id(node)
        for node, context in contexts.items()
        if isinstance(node, cst.Name)
        and node.value in threshold
        and (context == ExpressionContext.STORE or start(node) >= threshold[node.value])
    }

    class Renamer(cst.CSTTransformer):
        def leave_Name(self, original: cst.Name, updated: cst.Name) -> cst.Name:
            return updated.with_changes(value=mapping[original.value]) if id(original) in targets else updated

        def leave_FunctionDef(self, original: cst.FunctionDef, updated: cst.FunctionDef) -> cst.FunctionDef:
            name = original.name.value
            return updated.with_changes(name=cst.Name(mapping[name])) if name in mapping else updated

        def leave_ClassDef(self, original: cst.ClassDef, updated: cst.ClassDef) -> cst.ClassDef:
            name = original.name.value
            return updated.with_changes(name=cst.Name(mapping[name])) if name in mapping else updated

    return marker + wrapper.visit(Renamer()).code


def _names(values: list[str]) -> cst.Name | cst.Tuple:
    if len(values) == 1:
        return cst.Name(values[0])
    return cst.Tuple([cst.Element(cst.Name(v)) for v in values], lpar=[], rpar=[])


def wrap_in_function(code: str, name: str, params: list[str], returns: list[str]) -> str:
    marker, body = _strip_marker(code)
    module = cst.parse_module(body)
    statements: list[cst.BaseStatement] = list(module.body)
    if returns:
        statements.append(cst.SimpleStatementLine([cst.Return(value=_names(returns))]))
    function = cst.FunctionDef(
        name=cst.Name(name),
        params=cst.Parameters(params=[cst.Param(cst.Name(p)) for p in params]),
        body=cst.IndentedBlock(body=statements),
    )
    call = cst.Call(func=cst.Name(name), args=[cst.Arg(cst.Name(p)) for p in params])
    invocation: cst.BaseSmallStatement = (
        cst.Assign(targets=[cst.AssignTarget(_names(returns))], value=call) if returns else cst.Expr(call)
    )
    spaced = cst.SimpleStatementLine([invocation], leading_lines=[cst.EmptyLine(), cst.EmptyLine()])
    return marker + module.with_changes(body=[function, spaced]).code


# ---------------------------------------------------------------------------- engine


def _backup(project: LabProject, file: str, text: str) -> Path:
    stamp = dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%S%f")
    path = project.state_dir / "backups" / f"{file.replace('/', '__')}.{stamp}.bak"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def backups_for(project: LabProject, file: str) -> list[Path]:
    return sorted((project.state_dir / "backups").glob(f"{file.replace('/', '__')}.*.bak"))


def revert_last(project: LabProject, file: str) -> Path:
    """Undo the most recent transformation of ``file``."""
    backups = backups_for(project, file)
    if not backups:
        raise TransformError("NO_BACKUP", f"no backups for {file}")
    latest = backups[-1]
    project.write_atomic(file, latest.read_text(encoding="utf-8"))
    latest.rename(latest.with_suffix(".reverted"))
    return latest


def apply_transform(
    project: LabProject,
    file: str,
    op: Operation,
    *,
    node_ids: list[str] | None = None,
    params: dict[str, Any] | None = None,
    expected_hash: str | None = None,
    expected_sources: dict[str, str] | None = None,
    confirm: bool = False,
) -> TransformResult:
    node_ids = node_ids or []
    params = params or {}
    original = project.read(file)
    source_file = segment_text(file, original)
    graph = build_graph(source_file, use_patterns=False)

    if expected_hash is not None and expected_hash != source_file.hash:
        unchanged = expected_sources is not None and all(
            (node := graph.node(nid)) is not None and node.source_hash == digest
            for nid, digest in expected_sources.items()
        )
        if not unchanged:
            raise TransformConflict(
                "FILE_CHANGED", f"{file} changed on disk since the graph was rendered; re-analyse before {op}"
            )
    for node_id in node_ids:
        node = graph.node(node_id)
        if node is None or node.kind == "undefined":
            raise TransformError("UNKNOWN_NODE", f"unknown node '{node_id}' in {file}")
    if op not in _HANDLERS:
        raise TransformError("UNKNOWN_OPERATION", f"unsupported operation '{op}'")

    new_text, message, affected = _HANDLERS[op](source_file, graph, node_ids, params, confirm)
    if new_text == original:
        raise TransformError("NO_CHANGE", f"{op} would not change {file}")
    backup = _backup(project, file, original)
    new_hash = project.write_atomic(file, new_text)
    return TransformResult(op, file, message, str(backup), new_hash, project.analyse(file), affected)


# ------------------------------------------------------------------------ operations


def _reorder(sf: SourceFile, graph: CodeGraph, ids: list[str], params: dict[str, Any], _: bool) -> Outcome:
    if len(ids) != 1 or not ({"before", "after"} & set(params)):
        raise TransformError("BAD_PARAMS", "reorder needs one node and a 'before' or 'after' target")
    moving = ids[0]
    anchor = str(params.get("before") or params.get("after"))
    if graph.node(anchor) is None or anchor == moving:
        raise TransformError("BAD_PARAMS", f"invalid reorder target '{anchor}'")
    place_after = "after" in params
    if sf.kind == "notebook":
        notebook = json.loads(sf.text)
        cells: list[dict[str, Any]] = notebook["cells"]
        owners = _cell_block_ids(sf, cells)
        moving_block, anchor_block = sf.block(moving), sf.block(anchor)
        assert moving_block is not None and anchor_block is not None
        assert moving_block.cell_index is not None and anchor_block.cell_index is not None
        anchor_cell = cells[anchor_block.cell_index]  # by identity: identical cells are common
        moving_cell = cells.pop(moving_block.cell_index)
        anchor_index = next(i for i, cell in enumerate(cells) if cell is anchor_cell)
        cells.insert(anchor_index + (1 if place_after else 0), moving_cell)
        new_text = _notebook_dump(notebook, sf.text)
        composition = [[owners[id(cell)]] for cell in cells if id(cell) in owners]
    else:
        doc = _ScriptDoc(sf)
        order = [b for b in doc.order if b != moving]
        order.insert(order.index(anchor) + (1 if place_after else 0), moving)
        new_text = doc.text(order)
        composition = [[bid] for bid in doc.code_order(order)]
    _check_resolutions(graph, new_text, sf.path, composition)
    return new_text, f"moved {moving} {'after' if place_after else 'before'} {anchor}", [moving]


def _split(sf: SourceFile, graph: CodeGraph, ids: list[str], params: dict[str, Any], _: bool) -> Outcome:
    block = sf.block(ids[0]) if len(ids) == 1 else None
    lines = block.source.splitlines(keepends=True) if block else []
    line = int(params.get("line", 0))
    if block is None or not 1 < line <= len(lines):
        raise TransformError("BAD_PARAMS", "split needs one node and a line inside it (2..last)")
    head, tail = "".join(lines[: line - 1]), "".join(lines[line - 1 :])
    notebook = sf.kind == "notebook"
    if not (_parses(head, notebook) and _parses(tail, notebook)):
        raise TransformError(
            "SPLIT_INSIDE_STATEMENT", f"line {line} is inside a statement; both halves must be valid code"
        )
    if notebook:
        nb = json.loads(sf.text)
        assert block.cell_index is not None
        cell = nb["cells"][block.cell_index]
        _set_cell_text(cell, head)
        nb["cells"].insert(block.cell_index + 1, _new_code_cell(tail, cell))
        new_text = _notebook_dump(nb, sf.text)
    elif not sf.has_markers:
        raise TransformError("NO_MARKERS", "this script has no `# %%` cell markers; run add_markers first")
    else:
        file_lines = sf.text.splitlines(keepends=True)
        insert_at = block.start_line - 1 + line - 1
        new_text = "".join([*file_lines[:insert_at], "# %%\n", *file_lines[insert_at:]])
    return new_text, f"split {block.id} at line {line}", [block.id]


def _merge(sf: SourceFile, graph: CodeGraph, ids: list[str], params: dict[str, Any], _: bool) -> Outcome:
    if len(ids) != 2:
        raise TransformError("BAD_PARAMS", "merge needs two adjacent nodes")
    ordered = sf.blocks if sf.kind == "notebook" else tuple(sorted(sf.blocks, key=lambda b: b.start_line))
    order = [b.id for b in ordered]
    first, second = sorted(ids, key=order.index)
    if order.index(second) != order.index(first) + 1:
        raise TransformError("NOT_ADJACENT", f"{first} and {second} are not adjacent")
    a, b = sf.block(first), sf.block(second)
    assert a is not None and b is not None
    if sf.kind == "notebook":
        nb = json.loads(sf.text)
        assert a.cell_index is not None and b.cell_index is not None
        cell = nb["cells"][a.cell_index]
        _set_cell_text(cell, (a.source if a.source.endswith("\n") else a.source + "\n") + b.source)
        cell["outputs"], cell["execution_count"] = [], None
        del nb["cells"][b.cell_index]
        new_text = _notebook_dump(nb, sf.text)
    elif sf.has_markers:
        file_lines = sf.text.splitlines(keepends=True)
        if not CELL_MARKER.match(file_lines[b.start_line - 1]):
            raise TransformError("NOT_ADJACENT", f"{second} does not start with a cell marker")
        new_text = "".join([*file_lines[: b.start_line - 1], *file_lines[b.start_line :]])
    else:
        flags = set(graph.node(first).flags) | set(graph.node(second).flags)  # type: ignore[union-attr]
        if "definition" in flags:
            raise TransformError(
                "DEFINITION_BLOCK", "function and class definitions stay in their own blocks"
            )
        file_lines = sf.text.splitlines(keepends=True)
        new_text = "".join([*file_lines[: a.end_line], *file_lines[b.start_line - 1 :]])
    composition: Composition = []
    for node in graph.code_nodes():
        if node.id == second:
            composition[-1].append(second)
        else:
            composition.append([node.id])
    _check_resolutions(graph, new_text, sf.path, composition)
    return new_text, f"merged {first} and {second}", [first, second]


def _delete(
    sf: SourceFile, graph: CodeGraph, ids: list[str], params: dict[str, Any], confirm: bool
) -> Outcome:
    if len(ids) != 1:
        raise TransformError("BAD_PARAMS", "delete needs one node")
    target = ids[0]
    downstream = sorted({e.to for e in graph.edges if e.from_ == target}, key=graph.position)
    if downstream and not confirm:
        raise TransformError(
            "CONFIRM_REQUIRED",
            f"deleting {target} would break {', '.join(downstream)}; pass confirm to delete anyway",
            {"downstream": downstream},
        )
    block = sf.block(target)
    assert block is not None
    if sf.kind == "notebook":
        nb = json.loads(sf.text)
        del nb["cells"][block.cell_index]
        new_text = _notebook_dump(nb, sf.text)
    else:
        doc = _ScriptDoc(sf)
        new_text = doc.text([b for b in doc.order if b != target])
    broke = f" (broke {', '.join(downstream)})" if downstream else ""
    return new_text, f"deleted {target}{broke}", downstream


def _with_inserted(graph: CodeGraph, after: str | None) -> Composition:
    composition: Composition = [] if after else [[]]
    for node in graph.code_nodes():
        composition.append([node.id])
        if node.id == after:
            composition.append([])
    return composition


def _insert_region(sf: SourceFile, after: str | None, code: str) -> str:
    body = code if code.endswith("\n") else code + "\n"
    if sf.kind == "notebook":
        nb = json.loads(sf.text)
        index = sf.block(after).cell_index + 1 if after else 0  # type: ignore[operator, union-attr]
        nb["cells"].insert(index, _new_code_cell(body.rstrip("\n"), nb["cells"][0] if nb["cells"] else None))
        return _notebook_dump(nb, sf.text)
    doc = _ScriptDoc(sf)
    regions = dict(doc.regions)
    lines = body.splitlines(keepends=True)
    if sf.has_markers and not CELL_MARKER.match(lines[0]):
        lines.insert(0, "# %%\n")
    regions["__new__"] = lines
    order = list(doc.order)
    order.insert(order.index(after) + 1 if after else 0, "__new__")
    return doc.text(order, regions)


def _duplicate(sf: SourceFile, graph: CodeGraph, ids: list[str], params: dict[str, Any], _: bool) -> Outcome:
    if len(ids) != 1:
        raise TransformError("BAD_PARAMS", "duplicate needs one node")
    node, block = graph.node(ids[0]), sf.block(ids[0])
    assert node is not None and block is not None
    carried = sorted(set(node.loop_carried) & set(node.uses))
    if carried:
        raise TransformError(
            "DUPLICATE_UNSAFE",
            f"{node.id} updates {', '.join(carried)} across loop iterations; rename by hand",
        )
    taken = {name for n in graph.nodes for name in (*n.defines, *n.uses)}
    suffix = str(params.get("suffix", "_copy"))
    mapping: dict[str, str] = {}
    for name in node.defines:
        candidate, counter = f"{name}{suffix}", 2
        while candidate in taken or keyword.iskeyword(candidate) or not candidate.isidentifier():
            candidate, counter = f"{name}{suffix}{counter}", counter + 1
        mapping[name] = candidate
    try:
        copy = rename_defined(block.source, mapping) if mapping else block.source
    except cst.ParserSyntaxError as exc:
        raise TransformError("UNPARSEABLE", f"{node.id} cannot be rewritten: {exc.message}") from exc
    new_text = _insert_region(sf, node.id, copy)
    _check_resolutions(graph, new_text, sf.path, _with_inserted(graph, node.id))
    renamed = ", ".join(f"{k}→{v}" for k, v in mapping.items()) or "nothing"
    return new_text, f"duplicated {node.id} (renamed {renamed})", [node.id]


def _extract(sf: SourceFile, graph: CodeGraph, ids: list[str], params: dict[str, Any], _: bool) -> Outcome:
    if len(ids) != 1:
        raise TransformError("BAD_PARAMS", "extract needs one node")
    node, block = graph.node(ids[0]), sf.block(ids[0])
    assert node is not None and block is not None
    name = str(params.get("name", ""))
    if not name.isidentifier() or keyword.iskeyword(name):
        raise TransformError("BAD_PARAMS", f"'{name}' is not a valid function name")
    if any(name in n.defines or name in n.uses for n in graph.nodes):
        raise TransformError("NAME_TAKEN", f"`{name}` is already used in {sf.path}")
    reasons = []
    if node.mutates:
        reasons.append(f"it mutates outer-scope names ({', '.join(node.mutates)})")
    if node.conditional_defines:
        reasons.append(f"it defines names conditionally ({', '.join(node.conditional_defines)})")
    if {"global_write", "definition", "dynamic", "star_import", "opaque", "parse_error"} & set(node.flags):
        reasons.append("it contains definitions, globals or dynamic code")
    if node.imports:
        reasons.append("it contains imports")
    if sf.kind == "notebook" and sanitize_ipython(block.source)[1]:
        reasons.append("it contains IPython magics")
    if reasons:
        raise TransformError("EXTRACT_REFUSED", f"Refused to extract {node.id}: " + "; ".join(reasons))
    imported = {e.variable for e in graph.edges if e.to == node.id and e.kind == "import"}
    arguments = [u for u in node.uses if u not in imported]
    try:
        rewritten = wrap_in_function(block.source, name, arguments, list(node.defines))
    except cst.ParserSyntaxError as exc:
        raise TransformError("UNPARSEABLE", f"{node.id} cannot be rewritten: {exc.message}") from exc
    if sf.kind == "notebook":
        nb = json.loads(sf.text)
        _set_cell_text(nb["cells"][block.cell_index], rewritten)
        new_text = _notebook_dump(nb, sf.text)
    else:
        doc = _ScriptDoc(sf)
        trailing = doc.regions[block.id][len(block.source.splitlines()) :]
        body = rewritten if rewritten.endswith("\n") else rewritten + "\n"
        regions = {**doc.regions, block.id: [*body.splitlines(keepends=True), *trailing]}
        new_text = doc.text(regions=regions)
    _check_resolutions(graph, new_text, sf.path, _identity(graph))
    return new_text, f"extracted {node.id} into {name}({', '.join(arguments)})", [node.id]


def _insert(sf: SourceFile, graph: CodeGraph, ids: list[str], params: dict[str, Any], _: bool) -> Outcome:
    code = str(params.get("source", ""))
    if not code.strip() or not _parses(code, sf.kind == "notebook"):
        raise TransformError("BAD_PARAMS", "insert needs valid, non-empty source")
    after = ids[0] if ids else None
    new_text = _insert_region(sf, after, code)
    _check_resolutions(graph, new_text, sf.path, _with_inserted(graph, after))
    return new_text, "inserted a new block" + (f" after {after}" if after else " at the top"), []


def _add_markers(
    sf: SourceFile, graph: CodeGraph, ids: list[str], params: dict[str, Any], _: bool
) -> Outcome:
    if sf.kind == "notebook" or sf.has_markers:
        raise TransformError("NO_CHANGE", "file already has cells")
    lines = sf.text.splitlines(keepends=True)
    starts = {b.start_line - 1 for b in sf.code_blocks}
    new_text = "".join(("# %%\n" if index in starts else "") + line for index, line in enumerate(lines))
    return new_text, f"added {len(starts)} cell markers", [b.id for b in sf.code_blocks]


def edited_text(sf: SourceFile, node_id: str, source: str) -> str:
    """The file text with one block's source replaced (outputs and other bytes untouched)."""
    block = sf.block(node_id)
    if block is None or block.kind != "code":
        raise TransformError("UNKNOWN_NODE", f"unknown node '{node_id}' in {sf.path}")
    if sf.kind == "notebook":
        nb = json.loads(sf.text)
        _set_cell_text(nb["cells"][block.cell_index], source)
        return _notebook_dump(nb, sf.text)
    lines = sf.text.splitlines(keepends=True)
    body = source if source.endswith("\n") else source + "\n"
    first = block.source.splitlines(keepends=True)[:1]
    if (
        first
        and CELL_MARKER.match(first[0])
        and not CELL_MARKER.match(body.splitlines()[0] if body.strip() else "")
    ):
        body = first[0] + body  # keep the cell marker so the block keeps its boundary
    return "".join([*lines[: block.start_line - 1], body, *lines[block.end_line :]])


def _edit(sf: SourceFile, graph: CodeGraph, ids: list[str], params: dict[str, Any], _: bool) -> Outcome:
    if len(ids) != 1 or not isinstance(params.get("source"), str):
        raise TransformError("BAD_PARAMS", "edit needs one node and its new source")
    return edited_text(sf, ids[0], params["source"]), f"edited {ids[0]}", [ids[0]]


_HANDLERS: dict[str, Callable[[SourceFile, CodeGraph, list[str], dict[str, Any], bool], Outcome]] = {
    "edit": _edit,
    "reorder": _reorder,
    "split": _split,
    "merge": _merge,
    "delete": _delete,
    "duplicate": _duplicate,
    "extract": _extract,
    "insert": _insert,
    "add_markers": _add_markers,
}
