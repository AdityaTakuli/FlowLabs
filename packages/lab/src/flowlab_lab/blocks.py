"""Block segmentation (PRD II 5.2).

* ``.ipynb``: one code cell = one block.
* ``.py`` with ``# %%`` markers: marker-delimited regions.
* plain ``.py``: top-level statements grouped by blank-line runs; each def/class is its own block.

A block never splits a syntactic construct and never merges regions the user separated.
"""

from __future__ import annotations

import ast
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from flowspec import sha256_text

CELL_MARKER = re.compile(r"^\s*#\s*%%(.*)$")
_MAGIC_LINE = re.compile(r"^(\s*)(%{1,2}|!)")
_HEADING = re.compile(r"^\s*#{1,6}\s+(.+?)\s*$")
TRANSPARENT_CELL_MAGICS = ("%%time", "%%timeit", "%%capture")


@dataclass(frozen=True)
class Block:
    id: str
    kind: Literal["code", "markdown"]
    file: str
    start_line: int  # 1-based, inclusive; for notebooks, lines within the cell
    end_line: int
    source: str
    cell_index: int | None = None
    title: str | None = None
    execution_count: int | None = None

    @property
    def source_hash(self) -> str:
        return sha256_text(self.source)


@dataclass(frozen=True)
class SourceFile:
    path: str
    kind: Literal["notebook", "script"]
    text: str
    blocks: tuple[Block, ...]
    has_markers: bool = False

    @property
    def hash(self) -> str:
        return sha256_text(self.text)

    @property
    def code_blocks(self) -> tuple[Block, ...]:
        return tuple(b for b in self.blocks if b.kind == "code")

    def block(self, block_id: str) -> Block | None:
        return next((b for b in self.blocks if b.id == block_id), None)


def sanitize_ipython(source: str) -> tuple[str, bool]:
    """Replace IPython magics / shell escapes with ``pass`` so ``ast`` can parse the cell.

    Line numbers are preserved. Returns (python_source, had_magic). A non-transparent cell
    magic (``%%bash``) makes the whole cell opaque.
    """
    lines = source.splitlines()
    first = lines[0].lstrip() if lines else ""
    if first.startswith("%%") and not first.startswith(TRANSPARENT_CELL_MAGICS):
        return "\n".join("pass" if i == 0 else "# " + line for i, line in enumerate(lines)), True
    out, had = [], False
    for line in lines:
        match = _MAGIC_LINE.match(line)
        if match:
            out.append(f"{match.group(1)}pass")
            had = True
        else:
            out.append(line)
    return "\n".join(out), had


def _cell_source(cell: dict[str, Any]) -> str:
    source = cell.get("source", "")
    return "".join(source) if isinstance(source, list) else str(source)


def segment_notebook(path: str, text: str) -> SourceFile:
    notebook = json.loads(text)
    blocks: list[Block] = []
    code_n = md_n = 0
    pending_title: str | None = None
    for index, cell in enumerate(notebook.get("cells", [])):
        source = _cell_source(cell)
        line_count = max(1, len(source.splitlines()))
        if cell.get("cell_type") == "code":
            code_n += 1
            blocks.append(
                Block(
                    id=f"b{code_n}",
                    kind="code",
                    file=path,
                    start_line=1,
                    end_line=line_count,
                    source=source,
                    cell_index=index,
                    title=pending_title,
                    execution_count=cell.get("execution_count"),
                )
            )
            pending_title = None
        else:
            md_n += 1
            heading = next((m.group(1) for line in source.splitlines() if (m := _HEADING.match(line))), None)
            pending_title = heading or pending_title
            blocks.append(
                Block(
                    id=f"m{md_n}",
                    kind="markdown",
                    file=path,
                    start_line=1,
                    end_line=line_count,
                    source=source,
                    cell_index=index,
                )
            )
    return SourceFile(path=path, kind="notebook", text=text, blocks=tuple(blocks))


def segment_marked_script(path: str, text: str) -> SourceFile:
    lines = text.splitlines(keepends=True)
    starts = [i for i, line in enumerate(lines) if CELL_MARKER.match(line)]
    regions: list[tuple[int, int]] = []
    if starts and any(line.strip() for line in lines[: starts[0]]):
        regions.append((0, starts[0]))
    for n, start in enumerate(starts):
        regions.append((start, starts[n + 1] if n + 1 < len(starts) else len(lines)))
    blocks: list[Block] = []
    code_n = md_n = 0
    for start, end in regions:
        chunk = lines[start:end]
        while len(chunk) > 1 and not chunk[-1].strip():  # trailing blank lines are separators
            chunk = chunk[:-1]
        marker = CELL_MARKER.match(lines[start])
        header = marker.group(1).strip() if marker else ""
        is_markdown = "[markdown]" in header
        title = header.replace("[markdown]", "").strip() or None
        kind: Literal["code", "markdown"]
        if is_markdown:
            md_n += 1
            block_id, kind = f"m{md_n}", "markdown"
        else:
            code_n += 1
            block_id, kind = f"b{code_n}", "code"
        blocks.append(
            Block(
                id=block_id,
                kind=kind,
                file=path,
                start_line=start + 1,
                end_line=start + len(chunk),
                source="".join(chunk),
                title=title,
            )
        )
    return SourceFile(path=path, kind="script", text=text, blocks=tuple(blocks), has_markers=True)


def _statement_start(node: ast.stmt) -> int:
    decorators: list[ast.expr] = getattr(node, "decorator_list", [])
    return min([node.lineno, *(d.lineno for d in decorators)])


def segment_plain_script(path: str, text: str) -> SourceFile:
    lines = text.splitlines(keepends=True)
    try:
        tree = ast.parse(text)
    except SyntaxError:
        whole = Block(id="b1", kind="code", file=path, start_line=1, end_line=max(1, len(lines)), source=text)
        return SourceFile(path=path, kind="script", text=text, blocks=(whole,))

    spans: list[tuple[int, int, bool]] = []  # (start, end, is_definition), 1-based inclusive
    for node in tree.body:
        start, end = _statement_start(node), node.end_lineno or node.lineno
        while start > 1 and lines[start - 2].lstrip().startswith("#"):  # attach leading comments
            start -= 1
        spans.append((start, end, isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef)))

    groups: list[list[tuple[int, int, bool]]] = []
    for span in spans:
        if groups:
            previous = groups[-1][-1]
            gap = lines[previous[1] : span[0] - 1]
            blank_gap = any(not line.strip() for line in gap)
            if not (span[2] or previous[2] or blank_gap):
                groups[-1].append(span)
                continue
        groups.append([span])

    blocks = []
    for n, group in enumerate(groups, 1):
        start, end = group[0][0], group[-1][1]
        blocks.append(
            Block(
                id=f"b{n}",
                kind="code",
                file=path,
                start_line=start,
                end_line=end,
                source="".join(lines[start - 1 : end]),
            )
        )
    return SourceFile(path=path, kind="script", text=text, blocks=tuple(blocks))


def segment_text(path: str, text: str) -> SourceFile:
    if path.endswith(".ipynb"):
        return segment_notebook(path, text)
    if any(CELL_MARKER.match(line) for line in text.splitlines()):
        return segment_marked_script(path, text)
    return segment_plain_script(path, text)


def segment_file(file: Path, relative_to: Path | None = None) -> SourceFile:
    rel = file.relative_to(relative_to).as_posix() if relative_to else file.name
    return segment_text(rel, file.read_text(encoding="utf-8"))
