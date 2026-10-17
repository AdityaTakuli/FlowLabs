"""What this engine can do: Python, packages, CPU, memory and GPUs."""

from __future__ import annotations

import importlib.util
import os
import platform
import sys
from importlib import metadata
from typing import Any

PACKAGES = {
    "numpy": "numpy", "pandas": "pandas", "sklearn": "scikit-learn", "scipy": "scipy", "joblib": "joblib",
    "torch": "torch", "torchvision": "torchvision", "xgboost": "xgboost", "lightgbm": "lightgbm",
    "onnx": "onnx", "onnxruntime": "onnxruntime", "PIL": "pillow", "openpyxl": "openpyxl", "pyarrow": "pyarrow",
}  # fmt: skip


def in_browser() -> bool:
    return sys.platform == "emscripten"


def packages() -> dict[str, str | None]:
    """Installed version of each package FlowLabs can use (None when missing). Imports nothing heavy."""
    found: dict[str, str | None] = {}
    for module, dist in PACKAGES.items():
        if importlib.util.find_spec(module) is None:
            found[module] = None
            continue
        try:
            found[module] = metadata.version(dist)
        except metadata.PackageNotFoundError:
            found[module] = "installed"
    return found


def _memory() -> dict[str, float] | None:
    try:
        import psutil

        memory = psutil.virtual_memory()
        return {"total_gb": round(memory.total / 1e9, 1), "available_gb": round(memory.available / 1e9, 1)}
    except Exception:  # noqa: BLE001 - psutil is optional
        pass
    if hasattr(os, "sysconf"):
        try:
            total = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
            available = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_AVPHYS_PAGES")
            return {"total_gb": round(total / 1e9, 1), "available_gb": round(available / 1e9, 1)}
        except (ValueError, OSError):
            return None
    return None


def gpus() -> list[dict[str, Any]]:
    """GPUs PyTorch can use. Imports torch, so call it on demand, not at start-up."""
    if importlib.util.find_spec("torch") is None:
        return []
    try:
        import torch
    except Exception:  # noqa: BLE001 - a broken torch install should not break the engine
        return []
    found: list[dict[str, Any]] = []
    if torch.cuda.is_available():
        for index in range(torch.cuda.device_count()):
            props = torch.cuda.get_device_properties(index)
            found.append({"kind": "cuda", "name": props.name, "memory_gb": round(props.total_memory / 1e9, 1)})
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        found.append({"kind": "mps", "name": "Apple GPU (Metal)", "memory_gb": None})
    return found


def info(probe_gpu: bool = True) -> dict[str, Any]:
    from flowlabs import __version__

    return {
        "flowlabs": __version__,
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "platform": "browser (Pyodide)" if in_browser() else platform.platform(terse=True),
        "browser": in_browser(),
        "cpus": os.cpu_count() or 1,
        "memory": _memory(),
        "packages": packages(),
        "gpus": gpus() if probe_gpu else [],
    }
