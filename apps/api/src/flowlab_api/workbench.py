"""The open project on the local server, switchable at runtime ("Open…" in the canvas).

Like an editor's "Open Folder", the canvas can browse this computer and open any folder or code
file. The server already runs the user's code for whoever holds the per-launch token, so listing
folder and file *names* adds no new capability; file contents are only read inside the opened
project. Opening a folder swaps the Code Mode, Flow Mode and agent services behind one shared
event hub, so connected WebSockets keep working and receive ``project_changed``.
"""

from __future__ import annotations

import contextlib
import json
import os
import threading
from pathlib import Path
from typing import Any

from flowlab_lab.languages import CODE_SUFFIXES
from flowlab_lab.project import IGNORED_DIRS

from .agent import AgentService, ClientFactory
from .architecture import ArchitectureService
from .flows import FlowService
from .service import EventHub, LabService, ServiceError
from .structure_service import StructureService

MAX_ENTRIES = 2000
MAX_RECENTS = 12
MAX_IMPORT_BYTES = 5 * 1024 * 1024
PROJECT_MARKERS = (
    ".git", ".flowlab", "pyproject.toml", "requirements.txt", "setup.py", "package.json", "go.mod",
    "Cargo.toml", "pom.xml", "build.gradle", "Gemfile", "composer.json",
)  # fmt: skip


def default_recents_path() -> Path:
    base = os.environ.get("FLOWLAB_HOME")
    return (Path(base) if base else Path.home() / ".flowlab") / "recent.json"


class Workbench:
    def __init__(
        self,
        root: Path,
        *,
        llm_client_factory: ClientFactory | None = None,
        recents_path: Path | None = None,
    ) -> None:
        self.hub = EventHub()
        self._factory = llm_client_factory
        self.recents_path = recents_path or default_recents_path()
        self._lock = threading.RLock()
        self.service, self.flows, self.agent, self.architecture, self.structure = self._build(root)
        self._remember(self.root)

    def _build(
        self, root: Path
    ) -> tuple[LabService, FlowService, AgentService, ArchitectureService, StructureService]:
        try:
            service = LabService(root, hub=self.hub)
        except OSError as exc:  # e.g. a read-only folder: state lives in <folder>/.flowlab
            raise ServiceError(
                403, "FOLDER_NOT_WRITABLE", f"FlowLab needs to create .flowlab/ in {root}: {exc}"
            ) from exc
        return (
            service,
            FlowService(service.project, self.hub),
            AgentService(service.project, self.hub, self._factory),
            ArchitectureService(service.project, self.hub, self._factory),
            StructureService(service.project, self.hub),
        )

    @property
    def root(self) -> Path:
        return self.service.project.root

    # ------------------------------------------------------------------ recents
    def recents(self) -> list[str]:
        try:
            data = json.loads(self.recents_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        if not isinstance(data, list):
            return []
        return [p for p in data if isinstance(p, str) and Path(p).is_dir()][:MAX_RECENTS]

    def _remember(self, root: Path) -> None:
        items = [str(root), *(p for p in self.recents() if p != str(root))][:MAX_RECENTS]
        with contextlib.suppress(OSError):  # remembering folders is only a convenience
            self.recents_path.parent.mkdir(parents=True, exist_ok=True)
            self.recents_path.write_text(json.dumps(items, indent=1), encoding="utf-8")

    # ------------------------------------------------------------------- browse
    def browse(self, path: str | None, show_hidden: bool = False) -> dict[str, Any]:
        target = Path(path).expanduser() if path else self.root
        try:
            target = target.resolve()
        except (OSError, RuntimeError) as exc:
            raise ServiceError(400, "BAD_PATH", str(exc)) from exc
        if not target.exists():
            raise ServiceError(404, "PATH_NOT_FOUND", f"{target} does not exist")
        if not target.is_dir():
            raise ServiceError(400, "NOT_A_FOLDER", f"{target} is a file; open it or its folder instead")
        try:
            children = sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except PermissionError as exc:
            raise ServiceError(403, "PERMISSION_DENIED", f"no permission to read {target}") from exc
        entries: list[dict[str, Any]] = []
        truncated = False
        for child in children:
            name = child.name
            if not show_hidden and name.startswith("."):
                continue
            try:
                is_dir = child.is_dir()
            except OSError:
                continue
            if is_dir and name in IGNORED_DIRS:
                continue
            if not is_dir and not name.endswith(CODE_SUFFIXES):
                continue
            if len(entries) >= MAX_ENTRIES:
                truncated = True
                break
            entry: dict[str, Any] = {"name": name, "path": str(child), "kind": "dir" if is_dir else "file"}
            if is_dir:
                try:
                    entry["is_project"] = any((child / marker).exists() for marker in PROJECT_MARKERS)
                except OSError:
                    entry["is_project"] = False
            entries.append(entry)
        return {
            "path": str(target),
            "parent": str(target.parent) if target.parent != target else None,
            "home": str(Path.home()),
            "root": str(self.root),
            "entries": entries,
            "truncated": truncated,
        }

    # --------------------------------------------------------------------- open
    def open(self, path: str) -> dict[str, Any]:
        try:
            target = Path(path).expanduser().resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise ServiceError(404, "PATH_NOT_FOUND", f"{path} does not exist") from exc
        file: str | None = None
        if target.is_file():
            if not target.name.endswith(CODE_SUFFIXES):
                raise ServiceError(400, "UNSUPPORTED_FILE", "open a source code file or a folder")
            file, target = target.name, target.parent
        if target == Path(target.anchor):
            raise ServiceError(400, "FOLDER_TOO_BROAD", "pick a project folder, not the filesystem root")
        with self._lock:
            if target != self.root:
                built = self._build(target)  # fails before the current project is torn down
                old_service, old_flows = self.service, self.flows
                self.service, self.flows, self.agent, self.architecture, self.structure = built
                old_flows.shutdown()
                old_service.shutdown()
            self._remember(target)
        self.hub.publish(
            {"type": "project_changed", "file": None, "data": {"root": str(target), "file": file}}
        )
        return {"root": str(target), "file": file}

    # ------------------------------------------------------------------- import
    def import_file(self, name: str, content: str) -> dict[str, Any]:
        base = Path(name.replace("\\", "/")).name
        stem, suffix = Path(base).stem, Path(base).suffix
        if not stem or suffix not in CODE_SUFFIXES:
            raise ServiceError(400, "UNSUPPORTED_FILE", "import a source code file")
        if len(content.encode("utf-8")) > MAX_IMPORT_BYTES:
            raise ServiceError(
                413, "FILE_TOO_LARGE", "files over 5 MB cannot be imported; open their folder instead"
            )
        if suffix == ".ipynb":
            try:
                notebook = json.loads(content)
            except ValueError as exc:
                raise ServiceError(422, "NOT_A_NOTEBOOK", f"{base} is not valid notebook JSON") from exc
            if not isinstance(notebook, dict) or not isinstance(notebook.get("cells"), list):
                raise ServiceError(422, "NOT_A_NOTEBOOK", f"{base} has no cells")
        project = self.service.project
        relative = f"imported/{base}"
        counter = 2
        while project.resolve(relative).exists():
            relative = f"imported/{stem}_{counter}{suffix}"
            counter += 1
        project.resolve(relative).parent.mkdir(parents=True, exist_ok=True)
        project.write_atomic(relative, content)
        self.hub.publish(
            {"type": "file_changed", "file": relative, "data": {"kind": "added", "origin": "flowlab"}}
        )
        return {"file": relative}

    def shutdown(self) -> None:
        self.flows.shutdown()
        self.service.shutdown()
