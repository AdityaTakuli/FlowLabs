"""Local snapshots (PRD II 8.4): variable metadata plus a small sample, never pickled objects.

Stored as one JSON file per execution under ``.flowlab/snapshots/`` and evicted oldest-first
(least recently written) once the directory exceeds its size cap.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


class SnapshotStore:
    def __init__(self, directory: Path, max_bytes: int = 200 * 1024 * 1024) -> None:
        self.directory = directory
        self.max_bytes = max_bytes
        self.directory.mkdir(parents=True, exist_ok=True)

    def _files(self) -> list[Path]:
        return sorted(self.directory.glob("ex_*.json"), key=lambda p: (p.stat().st_mtime_ns, p.name))

    def save(self, record: dict[str, Any]) -> Path:
        path = self.directory / f"{record['execution_id']}.json"
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(record, default=str), encoding="utf-8")
        os.replace(temp, path)
        self.evict(keep=path)
        return path

    def load(self, execution_id: str) -> dict[str, Any] | None:
        path = self.directory / f"{execution_id}.json"
        if not path.is_file():
            return None
        data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
        return data

    def history(self, node_id: str, file: str | None = None) -> list[dict[str, Any]]:
        """Snapshots for a node, newest first."""
        found = []
        for path in reversed(self._files()):
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("node_id") == node_id and (file is None or data.get("file") == file):
                found.append(data)
        return found

    def latest(self, node_id: str, file: str | None = None) -> dict[str, Any] | None:
        history = self.history(node_id, file)
        return history[0] if history else None

    def total_bytes(self) -> int:
        return sum(p.stat().st_size for p in self._files())

    def evict(self, keep: Path | None = None) -> list[str]:
        removed: list[str] = []
        files = self._files()
        total = sum(p.stat().st_size for p in files)
        for path in files:
            if total <= self.max_bytes:
                break
            if keep is not None and path == keep:
                continue
            total -= path.stat().st_size
            path.unlink(missing_ok=True)
            removed.append(path.stem)
        return removed
