from __future__ import annotations

import importlib.util

import pytest

HAS_TORCH = importlib.util.find_spec("torch") is not None
needs_torch = pytest.mark.skipif(not HAS_TORCH, reason="PyTorch is not installed")


def fast(project: dict, *algos: str) -> dict:
    """Keep only quick models so tests stay fast."""
    from synapse_studio.core import project as projects

    project["models"] = [projects.model_entry(a) for a in algos]
    return project
