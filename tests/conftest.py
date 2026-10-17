from __future__ import annotations

from pathlib import Path

import pytest

from flowlabs.core import datasets
from flowlabs.core.workspace import Workspace


@pytest.fixture
def ws(tmp_path: Path) -> Workspace:
    return Workspace(tmp_path / "workspace")


@pytest.fixture
def churn(ws: Workspace) -> dict:
    return datasets.import_sample(ws, "churn")
