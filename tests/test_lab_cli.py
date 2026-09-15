"""``flowlab lab`` and ``flowlab eject`` command-line interface."""

from __future__ import annotations

import json
from pathlib import Path

from click.testing import CliRunner
from flowlab_engine.cli import main
from helpers import EXAMPLES, FIXTURES

SCRIPT = "# %% Load\ndata = [3, 1, None, 2]\n\n# %% Clean\nclean = [v for v in data if v is not None]\n\n# %% Total\ntotal = sum(clean)\nprint('total', total)\n"


def invoke(*args: str) -> tuple[int, str]:
    result = CliRunner().invoke(main, list(args))
    return result.exit_code, result.output


def make_project(tmp_path: Path) -> Path:
    (tmp_path / "pipeline.py").write_text(SCRIPT)
    return tmp_path


def test_init_files_and_graph(tmp_path: Path) -> None:
    root = make_project(tmp_path)
    code, output = invoke("lab", "init", str(root))
    assert code == 0 and "never data rows" in output and ".flowlab/" in (root / ".gitignore").read_text()
    code, output = invoke("lab", "files", "--root", str(root))
    assert code == 0 and output.strip() == "pipeline.py"
    code, output = invoke("lab", "graph", "pipeline.py", "--root", str(root))
    assert code == 0 and "3 blocks, 2 edges" in output and "b2 -> b3  `clean`" in output
    code, output = invoke("lab", "graph", "pipeline.py", "--root", str(root), "--json")
    assert json.loads(output)["edges"][0]["from"] == "b1"
    code, output = invoke("lab", "graph", "pipeline.py", "--root", str(root), "--mermaid")
    assert output.startswith("flowchart TD")
    code, output = invoke("lab", "graph", "../outside.py", "--root", str(root))
    assert code != 0 and "outside the project root" in output


def test_transform_refusal_apply_and_revert(tmp_path: Path) -> None:
    root = make_project(tmp_path)
    code, output = invoke(
        "lab", "transform", "pipeline.py", "reorder", "--root", str(root), "--node", "b2", "--after", "b3"
    )
    assert code != 0 and "DEPENDENCY_VIOLATION: Refused: b3 uses `clean` from b2" in output
    code, output = invoke("lab", "transform", "pipeline.py", "delete", "--root", str(root), "--node", "b2")
    assert code != 0 and "CONFIRM_REQUIRED" in output and "(b3)" in output
    code, output = invoke("lab", "transform", "pipeline.py", "duplicate", "--root", str(root), "--node", "b3")
    assert code == 0 and "duplicated b3" in output
    assert "total_copy = sum(clean)" in (root / "pipeline.py").read_text()
    code, output = invoke("lab", "revert", "pipeline.py", "--root", str(root))
    assert code == 0 and (root / "pipeline.py").read_text() == SCRIPT


def test_run_and_diff_in_a_local_kernel(tmp_path: Path) -> None:
    root = make_project(tmp_path)
    code, output = invoke("lab", "run", "pipeline.py", "--root", str(root))
    assert code == 0, output
    assert "│ total 6" in output and output.count("success") == 3
    notebook = {
        "cells": [
            {"cell_type": "code", "source": s, "metadata": {}, "outputs": [], "execution_count": None}
            for s in ("import pandas as pd", "raw = pd.DataFrame({'a': [1, None, 3]})", "kept = raw.dropna()")
        ],
        "metadata": {}, "nbformat": 4, "nbformat_minor": 5,
    }  # fmt: skip
    (root / "drops.ipynb").write_text(json.dumps(notebook))
    code, output = invoke("lab", "diff", "drops.ipynb", "b2", "b3", "--root", str(root))
    assert code == 0, output
    assert "Rows:     3 → 2   (-1, -33.3%)" in output


def test_trace_to_flow_env_watch_and_eject(tmp_path: Path) -> None:
    root = make_project(tmp_path)
    (root / "job.py").write_text(
        "import pandas as pd\nframe = pd.DataFrame({'a': [1, 2]})\nsmall = frame.head(1)\n"
    )
    code, output = invoke("lab", "trace", "--root", str(root), "--", "python", "job.py")
    assert code == 0, output
    assert "2 sites, 1 edges" in output and "TRACE_SCOPE" in output

    cells = ["import pandas as pd", "df = pd.read_csv('clean_numeric.csv')"]
    (root / "load.ipynb").write_text(json.dumps({
        "cells": [{"cell_type": "code", "source": c, "metadata": {}, "outputs": [], "execution_count": None} for c in cells],
        "metadata": {}, "nbformat": 4, "nbformat_minor": 5,
    }))  # fmt: skip
    draft = root / "draft.json"
    code, output = invoke(
        "lab", "to-flow", "load.ipynb", "--root", str(root), "--node", "b2", "--out", str(draft)
    )
    assert code == 0 and json.loads(draft.read_text())["nodes"][0]["type"] == "source.dataset"

    code, output = invoke("lab", "env", "--root", str(root))
    assert code == 0 and json.loads(output)["ram_total_mb"] > 0
    code, output = invoke("lab", "watch", "--root", str(root), "--once")
    assert code == 0 and "Watching" in output

    out = tmp_path / "ejected" / "churn.ipynb"
    code, output = invoke(
        "eject", str(EXAMPLES / "churn_flow.json"), "--data", str(FIXTURES), "--out", str(out)
    )
    assert code == 0 and out.is_file() and json.loads(out.read_text())["nbformat"] == 4


def test_architecture_command_writes_a_manifest(tmp_path: Path) -> None:
    root = make_project(tmp_path)
    (root / "load.py").write_text(
        "def load(path):\n    return path\n\ndef load_all(path):\n    return [load(path)]\n"
    )
    code, output = invoke("lab", "architecture", "--root", str(root), "--no-git")
    assert code == 0, output
    assert "components" in output and "unassigned" in output
    stored = root / ".flowlab" / "architecture" / "manifest.json"
    assert stored.is_file()
    manifest = json.loads(stored.read_text())
    assert manifest["stats"]["units"] >= 2 and manifest["llm"]["status"] == "skipped"
    dump = tmp_path / "arch.json"
    code, output = invoke(
        "lab", "architecture", "--root", str(root), "--no-git", "--json", "--out", str(dump)
    )
    assert code == 0 and json.loads(output)["project_id"] == manifest["project_id"]
    assert dump.is_file()
