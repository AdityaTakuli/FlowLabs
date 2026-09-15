"""Structure graphs on the local server: any language, editable node by node, with saved layouts.

Data analysis and ML files open as runnable cells (``LabService``); application code opens here as
functions, classes and calls. Nothing in this service runs code.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import threading
from pathlib import Path
from typing import Any

from flowlab_lab.languages import FileKind, classify, language_for, summarise
from flowlab_lab.project import LabProject, PathError
from flowlab_lab.structure import (
    MAX_FILE_BYTES,
    StructureError,
    Symbol,
    build_structure,
    edit_node,
    language_family,
    symbols_of,
)
from flowlab_lab.transforms import TransformError, revert_last, write_backup

from .service import EventHub, ServiceError

MAX_SYMBOL_FILES = 1500
MAX_LAYOUT_NODES = 5000
LAYOUT_VIEW = re.compile(r"^[a-z]{1,20}$")


class StructureService:
    def __init__(self, project: LabProject, hub: EventHub) -> None:
        self.project = project
        self.hub = hub
        self._kinds: dict[str, tuple[float, int, FileKind | None]] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ languages
    def check_file(self, file: str) -> str:
        if language_for(file) is None:
            raise ServiceError(400, "UNSUPPORTED_FILE", f"FlowLab cannot draw {file} as a graph")
        try:
            path = self.project.resolve(file)
        except PathError as exc:
            raise ServiceError(403, "PATH_OUTSIDE_ROOT", str(exc)) from exc
        if not path.is_file():
            raise ServiceError(404, "FILE_NOT_FOUND", f"{file} does not exist")
        return self.project.relative(path)

    def kind(self, file: str) -> FileKind | None:
        path = self.project.resolve(file)
        try:
            stat = path.stat()
        except OSError:
            return None
        with self._lock:
            cached = self._kinds.get(file)
        if cached and cached[0] == stat.st_mtime and cached[1] == stat.st_size:
            return cached[2]
        text = None
        if file.endswith(".py") and stat.st_size <= MAX_FILE_BYTES:
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                text = None
        found = classify(file, text)
        with self._lock:
            self._kinds[file] = (stat.st_mtime, stat.st_size, found)
        return found

    def languages(self) -> dict[str, Any]:
        files = self.project.index_code()
        info: dict[str, dict[str, Any]] = {}
        for file in files:
            found = self.kind(file)
            if found is not None:
                info[file] = {
                    "language": found.language,
                    "language_name": found.language_name,
                    "monaco": found.monaco,
                    "workspace": found.workspace,
                    "reason": found.reason,
                    "can_run_cells": found.can_run_cells,
                }
        return {
            "code_files": files,
            "file_info": info,
            "languages": [summary.__dict__ for summary in summarise(files)],
        }

    # ---------------------------------------------------------------------- graph
    def _symbols(self, file: str) -> list[Symbol]:
        language = language_for(file)
        if language is None:
            return []
        family = language_family(language.id)
        found: list[Symbol] = []
        candidates = [
            other
            for other in self.project.index_code()
            if other != file
            and (lang := language_for(other)) is not None
            and language_family(lang.id) == family
        ]
        for other in candidates[:MAX_SYMBOL_FILES]:
            path = self.project.resolve(other)
            try:
                if path.stat().st_size > MAX_FILE_BYTES:
                    continue
                if other.endswith(".ipynb"):
                    continue
                found.extend(symbols_of(other, path.read_text(encoding="utf-8", errors="replace")))
            except (OSError, StructureError):
                continue
        return found

    def graph(self, file: str) -> dict[str, Any]:
        file = self.check_file(file)
        if file.endswith(".ipynb"):
            raise ServiceError(400, "USE_CELLS", "notebooks open as cells; there is no structure to draw")
        text = self.project.read(file)
        try:
            graph = build_structure(file, text, self._symbols(file))
        except StructureError as exc:
            raise ServiceError(422, exc.code, exc.message, exc.details) from exc
        kind = self.kind(file)
        payload = graph.model_dump(mode="json", by_alias=True)
        payload["workspace"] = kind.workspace if kind else "structure"
        payload["reason"] = kind.reason if kind else ""
        payload["can_run_cells"] = bool(kind and kind.can_run_cells)
        return payload

    def preview(self, file: str, node_id: str, source: str) -> dict[str, Any]:
        """Would this edit parse? Nothing is written."""
        file = self.check_file(file)
        try:
            edit_node(file, self.project.read(file), node_id, source)
        except StructureError as exc:
            if exc.code == "SYNTAX_ERROR":
                return {"ok": False, "message": exc.message, "line": exc.details.get("line")}
            raise ServiceError(422 if exc.code != "UNKNOWN_NODE" else 404, exc.code, exc.message) from exc
        return {"ok": True, "message": None, "line": None}

    def edit(self, file: str, node_id: str, source: str, expected_hash: str | None) -> dict[str, Any]:
        file = self.check_file(file)
        text = self.project.read(file)
        current = hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()
        if expected_hash and expected_hash != current:
            raise ServiceError(409, "FILE_CHANGED", f"{file} changed on disk; reload before editing")
        try:
            new_text = edit_node(file, text, node_id, source)
        except StructureError as exc:
            status = 404 if exc.code == "UNKNOWN_NODE" else 422
            raise ServiceError(status, exc.code, exc.message, exc.details) from exc
        if new_text != text:
            write_backup(self.project, file, text)
            self.project.write_atomic(file, new_text)
            self.hub.publish(
                {"type": "file_changed", "file": file, "data": {"origin": "flowlab", "op": "edit"}}
            )
        return self.graph(file)

    def revert(self, file: str) -> dict[str, Any]:
        file = self.check_file(file)
        try:
            backup = revert_last(self.project, file)
        except TransformError as exc:
            raise ServiceError(422, exc.code, exc.message) from exc
        self.hub.publish(
            {"type": "file_changed", "file": file, "data": {"origin": "flowlab", "op": "revert"}}
        )
        return {"restored_from": backup.name, **self.graph(file)}

    # --------------------------------------------------------------------- layout
    def _layout_path(self, file: str, view: str) -> Path:
        if not LAYOUT_VIEW.match(view):
            raise ServiceError(400, "BAD_VIEW", "layout view must be a short lowercase word")
        return self.project.state_dir / "layouts" / f"{file.replace('/', '__')}.{view}.json"

    def layout(self, file: str, view: str) -> dict[str, Any]:
        try:
            self.project.resolve(file)
        except PathError as exc:
            raise ServiceError(403, "PATH_OUTSIDE_ROOT", str(exc)) from exc
        path = self._layout_path(file, view)
        positions: dict[str, Any] = {}
        if path.is_file():
            try:
                positions = json.loads(path.read_text(encoding="utf-8")).get("positions", {})
            except (OSError, ValueError, AttributeError):
                positions = {}
        return {"file": file, "view": view, "positions": positions}

    def save_layout(self, file: str, view: str, positions: dict[str, dict[str, float]]) -> dict[str, Any]:
        try:
            self.project.resolve(file)
        except PathError as exc:
            raise ServiceError(403, "PATH_OUTSIDE_ROOT", str(exc)) from exc
        if len(positions) > MAX_LAYOUT_NODES:
            raise ServiceError(413, "LAYOUT_TOO_LARGE", f"at most {MAX_LAYOUT_NODES} node positions")
        clean: dict[str, dict[str, float]] = {}
        for node_id, point in positions.items():
            x, y = point.get("x"), point.get("y")
            if not isinstance(x, int | float) or not isinstance(y, int | float) or not math.isfinite(x + y):
                raise ServiceError(422, "BAD_POSITION", f"position of {node_id!r} needs finite x and y")
            clean[node_id[:500]] = {"x": round(float(x), 1), "y": round(float(y), 1)}
        path = self._layout_path(file, view)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"positions": clean}, ensure_ascii=False), encoding="utf-8")
        return {"file": file, "view": view, "saved": len(clean)}
