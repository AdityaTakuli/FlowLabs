"""Which Python runs the kernel.

FlowLabs's own process (a packaged app, a pipx install or a checkout) is rarely the environment with
your GPU build of PyTorch. The kernel can therefore start from any interpreter: the one running
FlowLabs ("built-in"), a project virtualenv, a conda environment, the system Python, or a path you
type. Each candidate is probed once (cached by path and modification time) for its version and the
packages FlowLabs can use.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

PROBE = """
import importlib.util, json, sys
from importlib import metadata
names = {"numpy": "numpy", "pandas": "pandas", "sklearn": "scikit-learn", "scipy": "scipy", "joblib": "joblib",
         "torch": "torch", "torchvision": "torchvision", "xgboost": "xgboost", "lightgbm": "lightgbm", "PIL": "pillow"}
found = {}
for module, dist in names.items():
    if importlib.util.find_spec(module) is None:
        found[module] = None
        continue
    try:
        found[module] = metadata.version(dist)
    except Exception:
        found[module] = "installed"
print(json.dumps({"version": sys.version.split()[0], "executable": sys.executable, "prefix": sys.prefix,
                  "packages": found}))
"""
PROBE_TIMEOUT_S = 20
REQUIRED = ("numpy", "pandas", "sklearn", "scipy", "joblib")
VENV_NAMES = (".venv", "venv", "env")
HOME = Path.home()


def _exe(folder: Path) -> Path:
    return folder / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


@dataclass
class Interpreter:
    path: str | None  # None = the built-in runtime
    source: str
    label: str
    version: str | None = None
    packages: dict[str, Any] = field(default_factory=dict)

    @property
    def ready(self) -> bool:
        return all(self.packages.get(name) for name in REQUIRED)

    def as_dict(self) -> dict[str, Any]:
        missing = [n for n in REQUIRED if not self.packages.get(n)]
        return {**asdict(self), "ready": self.ready, "missing": missing}


_CACHE: dict[tuple[str, float], dict[str, Any]] = {}


def probe(path: str) -> dict[str, Any] | None:
    try:
        stamp = Path(path).stat().st_mtime
    except OSError:
        return None
    key = (path, stamp)
    if key not in _CACHE:
        try:
            finished = subprocess.run(  # noqa: S603 - a Python interpreter the user picked
                [path, "-I", "-c", PROBE], capture_output=True, text=True, timeout=PROBE_TIMEOUT_S
            )
            _CACHE[key] = json.loads(finished.stdout.strip().splitlines()[-1]) if finished.returncode == 0 else {}
        except (OSError, ValueError, IndexError, subprocess.SubprocessError):
            _CACHE[key] = {}
    return _CACHE[key] or None


def builtin() -> Interpreter:
    from flowlabs.core import env

    label = "Built-in (bundled with FlowLabs)" if getattr(sys, "frozen", False) else "This Python (running FlowLabs)"
    return Interpreter(None, "builtin", label, sys.version.split()[0], dict(env.packages()))


def describe(path: str, source: str, label: str) -> Interpreter:
    found = probe(path) or {}
    return Interpreter(path, source, label, found.get("version"), found.get("packages") or {})


def _candidates(workspace: Path | None) -> list[tuple[str, str, str]]:
    found: list[tuple[str, str, str]] = []
    for base in [p for p in (workspace, Path.cwd()) if p is not None]:
        for name in VENV_NAMES:
            candidate = _exe(base / name).absolute()
            if candidate.is_file():
                found.append((str(candidate), "venv", f"{name} in {base.name or base}"))
    for variable in ("CONDA_PREFIX", "VIRTUAL_ENV"):
        prefix = os.environ.get(variable)
        if prefix and _exe(Path(prefix)).is_file():
            found.append((str(_exe(Path(prefix))), "conda" if "CONDA" in variable else "venv", f"${variable}"))
    for folder in (HOME / "miniconda3" / "envs", HOME / "anaconda3" / "envs", HOME / ".conda" / "envs",
                   HOME / "miniforge3" / "envs", HOME / "mambaforge" / "envs"):  # fmt: skip
        if folder.is_dir():
            for env in sorted(folder.iterdir())[:20]:
                if _exe(env).is_file():
                    found.append((str(_exe(env)), "conda", f"conda: {env.name}"))
    for base in (HOME / "miniconda3", HOME / "anaconda3", HOME / "miniforge3"):
        if _exe(base).is_file():
            found.append((str(_exe(base)), "conda", f"conda: base ({base.name})"))
    for name in ("python3", "python"):
        on_path = shutil.which(name)
        if on_path:
            found.append((str(Path(on_path).absolute()), "path", f"{name} on PATH"))
    if os.name == "nt":
        launcher = shutil.which("py")
        if launcher:
            found.append((launcher, "path", "py launcher"))
    return found


def discover(workspace: Path | None = None, configured: str | None = None) -> list[Interpreter]:
    """The built-in runtime first, then every other interpreter found; duplicates dropped."""
    found = [builtin()]
    entries: list[tuple[str, str, str]] = []
    if configured:
        entries.append((configured, "configured", "chosen earlier"))
    entries.extend(_candidates(workspace))
    seen = {os.path.normpath(sys.executable)} if not getattr(sys, "frozen", False) else set()
    for path, source, label in entries:
        # a venv's python is a symlink to its base interpreter but has its own packages: do not resolve
        full = os.path.normpath(os.path.abspath(os.path.expanduser(path)))
        if full in seen or not Path(full).is_file():
            continue
        seen.add(full)
        found.append(describe(full, source, label))
    return found
