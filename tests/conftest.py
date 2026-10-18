from __future__ import annotations

import os
from pathlib import Path

# connection passwords go to a file in the test's workspace, never into the real keychain
os.environ["FLOWLABS_SECRETS"] = "file"

import pytest

from flowlabs.core import datasets
from flowlabs.core.workspace import Workspace


@pytest.fixture
def ws(tmp_path: Path) -> Workspace:
    return Workspace(tmp_path / "workspace")


@pytest.fixture
def churn(ws: Workspace) -> dict:
    return datasets.import_sample(ws, "churn")
