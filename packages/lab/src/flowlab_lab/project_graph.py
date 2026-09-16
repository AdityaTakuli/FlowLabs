"""The whole codebase as one graph: files grouped by folder, arrows for calls between files.

Built from the same per-file structure graphs (``flowlab_lab.structure``), so a file-to-file arrow
exists exactly when some function in one file calls a uniquely named function or class defined in
the other. Drill into a file to see its functions. Results are cached by file size and mtime, so
re-opening the view after editing one file only re-parses the files that changed.
"""

from __future__ import annotations

import threading
import time
from collections import Counter, defaultdict
from collections.abc import Iterable
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .languages import language_for
from .structure import MAX_FILE_BYTES, StructureError, Symbol, build_structure, language_family, symbols_of

MAX_PROJECT_FILES = 2000
MAX_EDGE_NAMES = 6


class ProjectFile(BaseModel):
    id: str  # project-relative path
    name: str
    folder: str  # "" for the project root
    language: str
    language_name: str
    units: int = 0
    classes: int = 0
    loc: int = 0
    problems: int = 0
    error: str | None = None


class ProjectFolder(BaseModel):
    id: str  # "" is the root
    name: str
    parent: str | None
    files: int = 0


class ProjectEdge(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_: str = Field(alias="from")
    to: str
    kind: Literal["calls"] = "calls"
    calls: int = 0
    names: list[str] = Field(default_factory=list)
    units: list[tuple[str, str]] = Field(default_factory=list)  # (caller unit, callee unit) samples


class ProjectGraph(BaseModel):
    folders: list[ProjectFolder]
    files: list[ProjectFile]
    edges: list[ProjectEdge]
    languages: list[str]
    truncated: bool = False
    skipped: int = 0
    analysis_ms: float | None = None


def _folders(paths: Iterable[str]) -> list[ProjectFolder]:
    counts: Counter[str] = Counter()
    seen: set[str] = {""}
    for path in paths:
        parent = path.rsplit("/", 1)[0] if "/" in path else ""
        counts[parent] += 1
        parts = parent.split("/") if parent else []
        for i in range(len(parts)):
            seen.add("/".join(parts[: i + 1]))
    folders = []
    for folder in sorted(seen):
        parent_id = None if folder == "" else "/".join(folder.split("/")[:-1])
        folders.append(
            ProjectFolder(
                id=folder,
                name=folder.split("/")[-1] if folder else "",
                parent=parent_id,
                files=counts[folder],
            )
        )
    return folders


class ProjectGraphBuilder:
    """Per-project cache of file symbols and file graphs, keyed by (mtime, size)."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._stamps: dict[str, tuple[float, int]] = {}
        self._symbols: dict[str, list[Symbol]] = {}
        self._outgoing: dict[str, tuple[ProjectFile, list[tuple[str, str, str]]]] = {}
        self._lock = threading.Lock()

    def _read(self, path: str) -> tuple[str | None, tuple[float, int] | None]:
        full = self.root / path
        try:
            stat = full.stat()
            if stat.st_size > MAX_FILE_BYTES:
                return None, (stat.st_mtime, stat.st_size)
            return full.read_text(encoding="utf-8", errors="replace"), (stat.st_mtime, stat.st_size)
        except OSError:
            return None, None

    def build(self, paths: list[str], *, language: str | None = None) -> ProjectGraph:
        started = time.perf_counter()
        candidates = [p for p in paths if not p.endswith(".ipynb") and language_for(p) is not None]
        if language and language != "all":
            candidates = [
                p for p in candidates if (lang := language_for(p)) is not None and lang.name == language
            ]
        truncated = len(candidates) > MAX_PROJECT_FILES
        candidates = candidates[:MAX_PROJECT_FILES]
        with self._lock:
            texts: dict[str, str | None] = {}
            changed: set[str] = set()
            for path in candidates:
                text, stamp = self._read(path)
                texts[path] = text
                if stamp is None or self._stamps.get(path) != stamp:
                    changed.add(path)
                    self._stamps.pop(path, None)
                    if stamp is not None:
                        self._stamps[path] = stamp
                    self._symbols.pop(path, None)
            for path in candidates:
                text = texts[path]
                if path not in self._symbols and text is not None:
                    try:
                        self._symbols[path] = symbols_of(path, text)
                    except StructureError:
                        self._symbols[path] = []
            by_family: dict[str, list[Symbol]] = defaultdict(list)
            for path in candidates:
                lang = language_for(path)
                if lang is not None:
                    by_family[language_family(lang.id)].extend(self._symbols.get(path, []))
            # a new or renamed symbol anywhere can change another file's arrows: rebuild that family
            dirty_families = {
                language_family(lang.id) for p in changed if (lang := language_for(p)) is not None
            }
            files: list[ProjectFile] = []
            edges: dict[tuple[str, str], ProjectEdge] = {}
            skipped = 0
            for path in candidates:
                lang = language_for(path)
                assert lang is not None
                family = language_family(lang.id)
                cached = self._outgoing.get(path)
                if cached is None or path in changed or family in dirty_families:
                    cached = self._analyse(path, texts[path], by_family[family])
                    self._outgoing[path] = cached
                record, outgoing = cached
                if record.error:
                    skipped += 1
                files.append(record)
                for caller, target_file, callee in outgoing:
                    if target_file not in texts:
                        continue  # filtered out (another language, or truncated)
                    edge = edges.setdefault((path, target_file), ProjectEdge(from_=path, to=target_file))
                    edge.calls += 1
                    name = callee.split(".")[-1]
                    if name not in edge.names and len(edge.names) < MAX_EDGE_NAMES:
                        edge.names.append(name)
                    if len(edge.units) < 8:
                        edge.units.append((caller, callee))
            for path in list(self._outgoing):
                if path not in texts and not (self.root / path).exists():
                    self._outgoing.pop(path, None)
        return ProjectGraph(
            folders=_folders(f.id for f in files),
            files=files,
            edges=sorted(edges.values(), key=lambda e: (e.from_, e.to)),
            languages=sorted({f.language_name for f in files}),
            truncated=truncated,
            skipped=skipped,
            analysis_ms=round((time.perf_counter() - started) * 1000, 1),
        )

    def _analyse(
        self, path: str, text: str | None, symbols: list[Symbol]
    ) -> tuple[ProjectFile, list[tuple[str, str, str]]]:
        lang = language_for(path)
        assert lang is not None
        folder = path.rsplit("/", 1)[0] if "/" in path else ""
        record = ProjectFile(
            id=path, name=path.rsplit("/", 1)[-1], folder=folder, language=lang.id, language_name=lang.name
        )
        if text is None:
            record.error = "too large or unreadable"
            return record, []
        try:
            graph = build_structure(path, text, symbols)
        except StructureError as exc:
            record.error = exc.message
            return record, []
        record.units = sum(1 for n in graph.nodes if n.kind in ("function", "method"))
        record.classes = sum(1 for n in graph.nodes if n.kind == "class")
        record.loc = text.count("\n") + 1
        record.problems = len(graph.problems)
        externals = {n.id: n for n in graph.nodes if n.kind == "external"}
        outgoing = [
            (edge.from_, externals[edge.to].file, externals[edge.to].qualified_name)
            for edge in graph.edges
            if edge.kind == "call" and edge.to in externals
            for _ in range(max(1, len(edge.sites)))
        ]
        return record, outgoing
