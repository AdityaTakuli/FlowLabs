"""Drivers installed when first needed: Snowflake, BigQuery, Databricks, SQL Server, Oracle...

Bundling every database driver would make the app hundreds of MB bigger, so each source names the
packages it needs and FlowLabs installs them the first time you connect.

* In the desktop app (a frozen bundle with no separate Python), packages go into
  ``~/.flowlabs/plugins/py<version>-<platform>``, installed by the pip inside the app
  (``FlowLabs --pip``), as prebuilt wheels for this system. That folder is on the import path, after
  the app's own packages, so a plugin never replaces what the app ships.
* Anywhere else (pip install, an engine in your own Python), they go into that Python environment.
"""

from __future__ import annotations

import importlib
import importlib.util
import os
import platform
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path


def frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def plugin_dir() -> Path:
    home = Path(os.environ.get("FLOWLABS_HOME", Path.home() / ".flowlabs"))
    tag = f"py{sys.version_info.major}{sys.version_info.minor}-{sys.platform}-{platform.machine().lower()}"
    return home / "plugins" / tag


def activate() -> None:
    """Put installed plugins on the import path (after the app's own packages)."""
    folder = plugin_dir()
    if folder.is_dir() and str(folder) not in sys.path:
        sys.path.append(str(folder))
        importlib.invalidate_caches()


def missing(modules: list[str]) -> list[str]:
    activate()
    absent = []
    for module in modules:
        try:
            if importlib.util.find_spec(module) is None:
                absent.append(module)
        except (ImportError, ValueError):
            absent.append(module)
    return absent


def _platforms() -> list[str]:
    """Wheel platform tags this computer can run, newest first."""
    machine = platform.machine().lower()
    if sys.platform.startswith("linux"):
        arch = {"amd64": "x86_64", "arm64": "aarch64"}.get(machine, machine)
        return [*(f"manylinux_2_{v}_{arch}" for v in (39, 34, 31, 28, 27, 24, 17)), f"manylinux2014_{arch}"]
    if sys.platform == "darwin":
        arch = "arm64" if machine in ("arm64", "aarch64") else "x86_64"
        versions = (
            range(15, 10, -1) if arch == "arm64" else [*range(15, 10, -1), *(f"10_{v}" for v in range(15, 8, -1))]
        )
        tags = [f"macosx_{v}_0_{arch}" if isinstance(v, int) else f"macosx_{v}_{arch}" for v in versions]
        return [*tags, "macosx_11_0_universal2", "macosx_10_9_universal2"]
    return ["win_amd64"] if machine in ("amd64", "x86_64") else [f"win_{machine}"]


def install_command(packages: list[str]) -> list[str]:
    if not frozen():
        return [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", *packages]
    folder = plugin_dir()
    folder.mkdir(parents=True, exist_ok=True)
    platforms = [part for tag in _platforms() for part in ("--platform", tag)]
    return [sys.executable, "--pip", "install", "--disable-pip-version-check", "--target", str(folder), "--upgrade",
            "--only-binary=:all:", "--implementation", "cp",
            "--python-version", f"{sys.version_info.major}.{sys.version_info.minor}", *platforms, *packages]  # fmt: skip


def install(packages: list[str], on_line: Callable[[str], None]) -> int:
    """Install ``packages``, reporting pip's output line by line; returns pip's exit code."""
    command = install_command(packages)
    on_line("$ pip install " + " ".join(packages) + (f"  (into {plugin_dir()})" if frozen() else ""))
    creation = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,  # noqa: S603
                                   encoding="utf-8", errors="replace", creationflags=creation)  # fmt: skip
    except OSError as error:
        on_line(str(error))
        return -1
    assert process.stdout is not None
    for line in process.stdout:
        on_line(line.rstrip()[:400])
    code = process.wait()
    activate()
    importlib.invalidate_caches()
    return code
