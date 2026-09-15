"""A local Code Mode project: config, indexing, safe paths, atomic writes, file watching.

PRD II 4.2 and 12: files are served only from under the project root (symlinks resolved and
checked), ``.flowlab/`` is added to ``.gitignore`` on init, and the agent suppresses the file
watch event caused by its own writes.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from flowspec import sha256_bytes
from pydantic import BaseModel, Field

from .codegraph import CodeGraph, analyse_text
from .languages import CODE_SUFFIXES

STATE_DIR = ".flowlab"
STATE_SUBDIRS = ("snapshots", "backups", "traces", "executions")
SOURCE_SUFFIXES = (".py", ".ipynb")
IGNORED_DIRS = frozenset(
    {
        "__pycache__", "node_modules", "site-packages", "venv", "env", "build", "dist",
        ".git", ".flowlab", ".venv", ".ipynb_checkpoints", ".mypy_cache", ".pytest_cache",
    }
)  # fmt: skip
GITIGNORE_ENTRY = ".flowlab/"
MAX_INDEX_ENTRIES = 50_000  # stop walking huge folders (e.g. a home directory)


class PathError(ValueError):
    """Raised when a path would leave the project root."""


class LabConfig(BaseModel):
    local_only: bool = Field(True, description="Never send preview rows off this machine.")
    max_preview_rows: int = Field(100, ge=0, le=100)
    snapshot_sample_rows: int = Field(20, ge=0, le=100)
    snapshot_max_bytes: int = Field(200 * 1024 * 1024, ge=1024)
    secrets_warning_acknowledged: bool = False


@dataclass(frozen=True)
class FileChange:
    path: str
    kind: Literal["added", "modified", "deleted"]


class LabProject:
    def __init__(self, root: Path) -> None:
        resolved = root.expanduser().resolve()
        if not resolved.is_dir():
            raise PathError(f"project root {root} is not a directory")
        self.root = resolved
        self.watcher = FileWatcher(self)

    # ----------------------------------------------------------------------- state
    @property
    def state_dir(self) -> Path:
        return self.root / STATE_DIR

    @property
    def config_path(self) -> Path:
        return self.state_dir / "lab.json"

    def init(self) -> LabConfig:
        for sub in STATE_SUBDIRS:
            (self.state_dir / sub).mkdir(parents=True, exist_ok=True)
        if not self.config_path.exists():
            self.save_config(LabConfig())
        self.ensure_gitignore()
        return self.config

    def ensure_gitignore(self) -> bool:
        """Add ``.flowlab/`` to the project's .gitignore. Returns True when it was added."""
        path = self.root / ".gitignore"
        existing = path.read_text(encoding="utf-8") if path.exists() else ""
        if any(line.strip().strip("/") == STATE_DIR for line in existing.splitlines()):
            return False
        prefix = "" if not existing or existing.endswith("\n") else "\n"
        path.write_text(
            f"{existing}{prefix}# FlowLab Code Mode local state\n{GITIGNORE_ENTRY}\n", encoding="utf-8"
        )
        return True

    @property
    def config(self) -> LabConfig:
        if self.config_path.exists():
            return LabConfig.model_validate_json(self.config_path.read_text(encoding="utf-8"))
        return LabConfig()

    def save_config(self, config: LabConfig) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.config_path.write_text(config.model_dump_json(indent=2) + "\n", encoding="utf-8")

    # ----------------------------------------------------------------------- paths
    def resolve(self, relative: str) -> Path:
        candidate = (self.root / relative).resolve()
        if candidate != self.root and not candidate.is_relative_to(self.root):
            raise PathError(f"'{relative}' is outside the project root")
        return candidate

    def relative(self, path: Path) -> str:
        return path.resolve().relative_to(self.root).as_posix()

    def index(self) -> list[str]:
        """Python scripts and notebooks: the files Code Mode cells can run."""
        return self._walk(SOURCE_SUFFIXES)

    def index_code(self) -> list[str]:
        """Source files in every language FlowLab can draw as a graph."""
        return self._walk(CODE_SUFFIXES)

    def _walk(self, suffixes: tuple[str, ...]) -> list[str]:
        found: list[str] = []
        visited = 0
        for directory, subdirs, files in os.walk(self.root, followlinks=False):
            subdirs[:] = sorted(d for d in subdirs if d not in IGNORED_DIRS and not d.startswith("."))
            visited += len(files) + len(subdirs)
            if visited > MAX_INDEX_ENTRIES:
                break
            for name in files:
                if not name.endswith(suffixes):
                    continue
                path = Path(directory) / name
                try:
                    found.append(self.relative(self.resolve(self.relative(path))))
                except (PathError, ValueError):
                    continue  # a symlink pointing outside the project
        return sorted(found)

    # ----------------------------------------------------------------------- files
    def read(self, relative: str) -> str:
        return self.resolve(relative).read_text(encoding="utf-8")

    def file_hash(self, relative: str) -> str:
        return sha256_bytes(self.resolve(relative).read_bytes())

    def analyse(self, relative: str) -> CodeGraph:
        return analyse_text(relative, self.read(relative))

    def write_atomic(self, relative: str, text: str) -> str:
        """Write via a temp file + rename; the watcher ignores the resulting change."""
        target = self.resolve(relative)
        data = text.encode("utf-8")
        handle, temp_name = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.", suffix=".tmp")
        try:
            with os.fdopen(handle, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            if target.exists():
                os.chmod(temp_name, target.stat().st_mode & 0o777)
            os.replace(temp_name, target)
        except BaseException:
            Path(temp_name).unlink(missing_ok=True)
            raise
        content_hash = sha256_bytes(data)
        self.watcher.suppress(relative, content_hash)
        return content_hash


class FileWatcher:
    """Polling watcher (no platform dependencies). Self-writes are suppressed once."""

    def __init__(self, project: LabProject) -> None:
        self.project = project
        self._known: dict[str, tuple[float, int, str]] = {}
        self._suppressed: dict[str, str] = {}

    def prime(self) -> None:
        self._known = {path: self._stat(path) for path in self.project.index_code()}

    def suppress(self, relative: str, content_hash: str) -> None:
        self._suppressed[relative] = content_hash

    def _stat(self, relative: str) -> tuple[float, int, str]:
        path = self.project.resolve(relative)
        stat = path.stat()
        return stat.st_mtime, stat.st_size, sha256_bytes(path.read_bytes())

    def poll(self) -> list[FileChange]:
        changes: list[FileChange] = []
        current = set(self.project.index_code())
        for path in sorted(current):
            stat = self.project.resolve(path).stat()
            previous = self._known.get(path)
            if previous and previous[0] == stat.st_mtime and previous[1] == stat.st_size:
                continue
            state = self._stat(path)
            self._known[path] = state
            if self._suppressed.get(path) == state[2]:
                self._suppressed.pop(path, None)
                continue
            if previous is None:
                changes.append(FileChange(path, "added"))
            elif previous[2] != state[2]:
                changes.append(FileChange(path, "modified"))
        for path in sorted(set(self._known) - current):
            self._known.pop(path)
            changes.append(FileChange(path, "deleted"))
        return changes
