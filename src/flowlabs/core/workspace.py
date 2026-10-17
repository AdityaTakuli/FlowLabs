"""Where an engine keeps datasets, projects, runs and exports.

<root>/datasets/<id>/meta.json + the data file (or images/<class>/...)
<root>/projects/<id>.json
<root>/runs/<project>/<run>/results.json + models/<model>.joblib
<root>/exports/<project>/<export>/... + <name>.zip
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

from .util import UserError


class Workspace:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).expanduser()
        for name in ("datasets", "projects", "runs", "exports", "tmp"):
            (self.root / name).mkdir(parents=True, exist_ok=True)

    @property
    def datasets(self) -> Path:
        return self.root / "datasets"

    @property
    def projects(self) -> Path:
        return self.root / "projects"

    @property
    def runs(self) -> Path:
        return self.root / "runs"

    @property
    def exports(self) -> Path:
        return self.root / "exports"

    @property
    def tmp(self) -> Path:
        return self.root / "tmp"

    def inside(self, relative: str) -> Path:
        """A path under the workspace; refuses anything that escapes it."""
        path = (self.root / relative).resolve()
        root = self.root.resolve()
        if path != root and root not in path.parents:
            raise UserError("that path is outside the workspace")
        return path

    def relative(self, path: Path) -> str:
        return path.resolve().relative_to(self.root.resolve()).as_posix()

    @staticmethod
    def read_json(path: Path) -> Any:
        return json.loads(path.read_text(encoding="utf-8"))

    @staticmethod
    def write_json(path: Path, value: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(value, indent=1, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, path)

    @staticmethod
    def remove(path: Path) -> None:
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        elif path.exists():
            path.unlink()
