"""Stage 0 — Inventory (SEG-020 … SEG-023)."""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import pathspec

from .models import FileRecord

EXCLUDED_DIRS = frozenset(
    {
        "site-packages",
        "node_modules",
        ".venv",
        "venv",
        "env",
        "__pycache__",
        ".git",
        ".hg",
        ".svn",
        "build",
        "dist",
        "vendor",
        "vendored",
        "_vendor",
        "third_party",
        ".flowlab",
        ".tox",
        ".nox",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".ipynb_checkpoints",
    }
)
MIGRATION_DIRS = frozenset({"migrations", "alembic"})
TEST_DIRS = frozenset({"tests", "test"})
GENERATED = re.compile(r"(_pb2|_pb2_grpc)\.py$")
MAGIC_LINE = re.compile(r"^\s*[%!]")
MAX_FILES = 20_000


@dataclass
class SourceFile:
    record: FileRecord
    text: str
    # notebooks: (cell index, first line, last line) in `text` coordinates (code cells joined)
    cells: list[tuple[int, int, int]] = field(default_factory=list)


def _ignore_spec(root: Path) -> pathspec.GitIgnoreSpec:
    lines: list[str] = []
    for name in (".gitignore", ".flowlabignore"):
        path = root / name
        if path.is_file():
            lines.extend(path.read_text(encoding="utf-8", errors="replace").splitlines())
    return pathspec.GitIgnoreSpec.from_lines(lines)


def _sloc(text: str) -> int:
    return sum(1 for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#"))


def _role(relative: str) -> str:
    parts = relative.split("/")
    name = parts[-1]
    if any(part in MIGRATION_DIRS for part in parts[:-1]):
        return "migration"
    if name.startswith("test_") or name.endswith("_test.py") or name == "conftest.py":
        return "test"
    if any(part in TEST_DIRS for part in parts[:-1]):
        return "test"
    return "source"


def _notebook_text(raw: str) -> tuple[str, list[tuple[int, int, int]]]:
    notebook = json.loads(raw)
    lines: list[str] = []
    cells: list[tuple[int, int, int]] = []
    for index, cell in enumerate(notebook.get("cells", [])):
        if cell.get("cell_type") != "code":
            continue
        source = cell.get("source", "")
        text = "".join(source) if isinstance(source, list) else str(source)
        cell_lines = ["" if MAGIC_LINE.match(line) else line for line in text.splitlines()]
        if not any(line.strip() for line in cell_lines):
            continue
        start = len(lines) + 1
        lines.extend(cell_lines)
        cells.append((index, start, len(lines)))
    return "\n".join(lines) + ("\n" if lines else ""), cells


def inventory(root: Path) -> list[SourceFile]:
    root = root.resolve()
    spec = _ignore_spec(root)
    found: list[SourceFile] = []
    for directory, subdirs, files in os.walk(root, followlinks=False):
        rel_dir = Path(directory).relative_to(root).as_posix()
        rel_dir = "" if rel_dir == "." else rel_dir + "/"
        subdirs[:] = sorted(
            d
            for d in subdirs
            if d not in EXCLUDED_DIRS
            and not d.startswith(".")
            and not d.endswith(".egg-info")
            and not spec.match_file(f"{rel_dir}{d}/")
        )
        for name in sorted(files):
            if not name.endswith((".py", ".ipynb")) or GENERATED.search(name):
                continue
            relative = f"{rel_dir}{name}"
            if spec.match_file(relative):
                continue
            if len(found) >= MAX_FILES:
                return found
            path = Path(directory) / name
            try:
                data = path.read_bytes()
                mtime = int(path.stat().st_mtime)
            except OSError:
                continue
            raw = data.decode("utf-8", errors="replace")
            language = "notebook" if name.endswith(".ipynb") else "python"
            parse_error: str | None = None
            cells: list[tuple[int, int, int]] = []
            text = raw
            if language == "notebook":
                try:
                    text, cells = _notebook_text(raw)
                except (ValueError, AttributeError) as exc:
                    text, parse_error = "", f"invalid notebook JSON: {exc}"
            record = FileRecord(
                path=relative,
                language=language,
                role=_role(relative),
                loc=len(text.splitlines()),
                sloc=_sloc(text),
                content_hash="sha256:" + hashlib.sha256(data).hexdigest(),
                mtime=mtime,
                parse_error=parse_error,
            )
            found.append(SourceFile(record=record, text=text, cells=cells))
    return found
