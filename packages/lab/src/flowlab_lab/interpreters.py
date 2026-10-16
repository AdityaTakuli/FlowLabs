"""Which Python runs your code.

FlowLab's own process (a packaged app, a pipx install, or a dev checkout) is rarely the
environment your notebooks need. Kernels therefore start from an interpreter *you* pick: the
project's virtualenv, a conda environment, the system Python, or any path you type. For the
chosen interpreter FlowLab writes a small kernelspec under ``~/.flowlab/kernels`` and starts the
kernel from that, so a frozen application never tries to run itself as a kernel.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

PROBE = (
    "import importlib.util, json, sys;"
    "print(json.dumps({'version': sys.version.split()[0], 'executable': sys.executable,"
    " 'ipykernel': importlib.util.find_spec('ipykernel') is not None, 'prefix': sys.prefix}))"
)
PROBE_TIMEOUT_S = 15
VENV_NAMES = (".venv", "venv", ".env", "env")
HOME = Path.home()


def _exe(folder: Path) -> Path:
    return folder / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


@dataclass(frozen=True)
class Interpreter:
    path: str
    source: str  # project, current, conda, path, configured, registered
    label: str
    version: str | None = None
    ipykernel: bool | None = None
    prefix: str | None = None

    def as_dict(self) -> dict[str, object]:
        return {
            "path": self.path,
            "source": self.source,
            "label": self.label,
            "version": self.version,
            "ipykernel": self.ipykernel,
            "prefix": self.prefix,
        }


@dataclass
class _Cache:
    entries: dict[tuple[str, float], dict[str, object]] = field(default_factory=dict)

    def probe(self, path: str) -> dict[str, object] | None:
        try:
            stamp = Path(path).stat().st_mtime
        except OSError:
            return None
        key = (path, stamp)
        if key not in self.entries:
            try:
                finished = subprocess.run(  # noqa: S603 - a Python interpreter the user picked
                    [path, "-I", "-c", PROBE], capture_output=True, text=True, timeout=PROBE_TIMEOUT_S
                )
                self.entries[key] = json.loads(finished.stdout) if finished.returncode == 0 else {}
            except (OSError, ValueError, subprocess.SubprocessError):
                self.entries[key] = {}
            if len(self.entries) > 100:
                self.entries = dict(list(self.entries.items())[-50:])
        return self.entries[key] or None


_CACHE = _Cache()


def describe(path: str, source: str, label: str) -> Interpreter:
    found = _CACHE.probe(path) or {}
    version = str(found.get("version")) if found.get("version") else None
    return Interpreter(
        path=path,
        source=source,
        label=label,
        version=version,
        ipykernel=bool(found["ipykernel"]) if "ipykernel" in found else None,
        prefix=str(found.get("prefix")) if found.get("prefix") else None,
    )


def _candidates(project_root: Path | None) -> list[tuple[str, str, str]]:
    """(path, source, label) for every interpreter worth offering, best first."""
    found: list[tuple[str, str, str]] = []
    if project_root is not None:
        for name in VENV_NAMES:
            candidate = _exe(project_root / name).absolute()
            if candidate.is_file():
                found.append((str(candidate), "project", f"{name} in this project"))
    if not getattr(sys, "frozen", False):
        found.append((sys.executable, "current", "the environment running FlowLab"))
    for variable in ("CONDA_PREFIX", "VIRTUAL_ENV"):
        prefix = os.environ.get(variable)
        if prefix and _exe(Path(prefix)).is_file():
            found.append(
                (str(_exe(Path(prefix))), "conda" if "CONDA" in variable else "project", f"${variable}")
            )
    for folder in (HOME / "miniconda3" / "envs", HOME / "anaconda3" / "envs", HOME / ".conda" / "envs"):
        if folder.is_dir():
            for env in sorted(folder.iterdir())[:20]:
                if _exe(env).is_file():
                    found.append((str(_exe(env)), "conda", f"conda: {env.name}"))
    for base in (HOME / "miniconda3", HOME / "anaconda3"):
        if _exe(base).is_file():
            found.append((str(_exe(base)), "conda", "conda: base"))
    for name in ("python3", "python"):
        on_path = shutil.which(name)
        if on_path:
            found.append((str(Path(on_path).resolve()), "path", f"{name} on PATH"))
    if os.name == "nt":  # the Windows launcher knows about every installed Python
        launcher = shutil.which("py")
        if launcher:
            found.append((launcher, "path", "py launcher"))
    return found


def discover(project_root: Path | None = None, configured: str | None = None) -> list[Interpreter]:
    """Interpreters to offer, the configured one first; duplicates by real path are dropped."""
    entries: list[tuple[str, str, str]] = []
    if configured:
        entries.append((configured, "configured", "chosen for this project"))
    entries.extend(_candidates(project_root))
    seen: set[str] = set()
    interpreters: list[Interpreter] = []
    for path, source, label in entries:
        # normalise without following symlinks: a venv's python is a link to the base interpreter,
        # but it is a different environment with its own packages
        full = os.path.normpath(os.path.abspath(os.path.expanduser(path)))
        if full in seen or not Path(full).is_file():
            continue
        seen.add(full)
        interpreters.append(describe(full, source, label))
    return interpreters


def default_interpreter(
    project_root: Path | None = None, configured: str | None = None
) -> Interpreter | None:
    """The interpreter to use when the user has not chosen one: first with ipykernel installed."""
    interpreters = discover(project_root, configured)
    if configured:
        chosen = next((i for i in interpreters if i.source == "configured"), None)
        if chosen is not None:
            return chosen
    return next((i for i in interpreters if i.ipykernel), None) or (interpreters[0] if interpreters else None)


class InterpreterError(RuntimeError):
    """The chosen interpreter cannot run a kernel."""


def kernelspec_for(python_path: str, *, directory: Path | None = None) -> tuple[str, Path]:
    """Write a kernelspec that starts ipykernel from ``python_path``; returns (name, specs dir)."""
    resolved = Path(python_path).expanduser()
    if not resolved.is_file():
        raise InterpreterError(f"{python_path} does not exist")
    found = _CACHE.probe(str(resolved))
    if found is None:
        raise InterpreterError(f"{python_path} did not answer; is it a Python interpreter?")
    if not found.get("ipykernel"):
        raise InterpreterError(
            f"ipykernel is not installed in {python_path}. Install it there with "
            f"'{python_path} -m pip install ipykernel', or pick another environment."
        )
    specs = directory or (HOME / ".flowlab" / "kernels")
    name = "flowlab-" + hashlib.sha256(str(resolved).encode("utf-8")).hexdigest()[:12]
    folder = specs / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "kernel.json").write_text(
        json.dumps(
            {
                "argv": [str(resolved), "-m", "ipykernel_launcher", "-f", "{connection_file}"],
                "display_name": f"FlowLab ({found.get('version', 'python')})",
                "language": "python",
                "metadata": {"flowlab": {"python": str(resolved), "platform": platform.platform()}},
            },
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )
    return name, specs
