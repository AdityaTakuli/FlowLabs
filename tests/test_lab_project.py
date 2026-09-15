"""Code Mode project plumbing without a kernel: config, paths, watcher, snapshots, diff, resources."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from flowlab_lab.diff import diff_summaries, pick_variables
from flowlab_lab.project import LabProject, PathError
from flowlab_lab.resources import MemorySampler, system_resources
from flowlab_lab.snapshots import SnapshotStore


def make_project(tmp_path: Path) -> LabProject:
    (tmp_path / "analysis.ipynb").write_text(
        '{"cells": [], "metadata": {}, "nbformat": 4, "nbformat_minor": 5}'
    )
    (tmp_path / "pipeline.py").write_text("x = 1\n")
    return LabProject(tmp_path)


def test_init_creates_state_config_and_gitignore(tmp_path: Path) -> None:
    (tmp_path / ".gitignore").write_text("*.pyc")  # no trailing newline
    project = make_project(tmp_path)
    config = project.init()
    assert config.local_only is True and config.max_preview_rows == 100
    assert {p.name for p in project.state_dir.iterdir()} >= {
        "snapshots",
        "backups",
        "traces",
        "executions",
        "lab.json",
    }
    assert (tmp_path / ".gitignore").read_text() == "*.pyc\n# FlowLab Code Mode local state\n.flowlab/\n"
    assert project.ensure_gitignore() is False  # idempotent
    assert (tmp_path / ".gitignore").read_text().count(".flowlab/") == 1


def test_paths_are_confined_to_the_root(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    outside = tmp_path / "secret.py"
    outside.write_text("token = 'x'\n")
    project = make_project(root)
    (root / "link.py").symlink_to(outside)
    for bad in ("../secret.py", "link.py", "/etc/passwd"):
        with pytest.raises(PathError):
            project.resolve(bad)
    assert project.resolve("pipeline.py") == root / "pipeline.py"


def test_index_skips_environments_hidden_dirs_and_escaping_links(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    for directory in (".venv/lib", "venv", "__pycache__", ".hidden", "node_modules/pkg", "src/pkg"):
        (tmp_path / directory).mkdir(parents=True, exist_ok=True)
        (tmp_path / directory / "mod.py").write_text("y = 2\n")
    (tmp_path / "notes.txt").write_text("not code")
    assert project.index() == ["analysis.ipynb", "pipeline.py", "src/pkg/mod.py"]


def test_atomic_writes_are_suppressed_but_external_edits_are_seen(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    os.chmod(tmp_path / "pipeline.py", 0o640)
    project.watcher.prime()
    project.write_atomic("pipeline.py", "x = 2\n")
    assert project.watcher.poll() == []
    assert (tmp_path / "pipeline.py").read_text() == "x = 2\n"
    assert (tmp_path / "pipeline.py").stat().st_mode & 0o777 == 0o640
    assert not list(tmp_path.glob(".pipeline.py.*.tmp"))

    (tmp_path / "pipeline.py").write_text("x = 3  # edited in VS Code\n")
    (tmp_path / "new.py").write_text("z = 1\n")
    (tmp_path / "analysis.ipynb").unlink()
    changes = {(c.path, c.kind) for c in project.watcher.poll()}
    assert changes == {("pipeline.py", "modified"), ("new.py", "added"), ("analysis.ipynb", "deleted")}


def test_snapshot_store_history_and_lru_eviction(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "snaps", max_bytes=2_000)
    for n in range(12):
        store.save(
            {
                "execution_id": f"ex_{n:04d}",
                "node_id": "b2" if n % 2 else "b1",
                "file": "a.ipynb",
                "after": {"df": {"rows": n, "padding": "x" * 150}},
            }
        )
    assert store.total_bytes() <= 2_000
    assert store.load("ex_0000") is None  # oldest evicted
    latest = store.latest("b2", "a.ipynb")
    assert latest is not None and latest["execution_id"] == "ex_0011"
    assert [h["execution_id"] for h in store.history("b2")][:2] == ["ex_0011", "ex_0009"]


def test_structural_diff_matches_the_prd_report() -> None:
    before = {
        "kind": "dataframe", "rows": 74112, "columns": ["customer_id", "signup_date", "churned", "tenure"],
        "dtypes": {"customer_id": "int64", "signup_date": "object", "churned": "object", "tenure": "float64"},
        "null_counts": {"tenure": 1203}, "memory_bytes": 42_100_000, "hash": "aaa",
    }  # fmt: skip
    after = {
        "kind": "dataframe", "rows": 71205, "columns": ["churned", "tenure", "plan_type_basic"],
        "dtypes": {"churned": "bool", "tenure": "float64", "plan_type_basic": "uint8"},
        "null_counts": {"tenure": 0}, "memory_bytes": 38_700_000, "hash": "bbb",
    }  # fmt: skip
    diff = diff_summaries(before, after, label_a="b4:df", label_b="b5:df")
    assert diff.row_delta == -2907
    assert diff.added == ["plan_type_basic"] and diff.removed == ["customer_id", "signup_date"]
    assert diff.retyped == [("churned", "object", "bool")]
    text = diff.format()
    assert "Rows:     74,112 → 71,205   (-2,907, -3.9%)" in text
    assert "Nulls:    1,203 → 0" in text and "Memory:   40.1 MB → 36.9 MB" in text
    assert "Content:  changed" in text


def test_pick_variables_prefers_shared_then_largest_tables() -> None:
    table = {"kind": "dataframe", "rows": 5}
    big = {"kind": "dataframe", "rows": 50}
    scalar = {"kind": "scalar"}
    assert pick_variables({"df": table, "n": scalar}, {"df": table}, None) == ("df", "df")
    assert pick_variables({"raw": table, "big": big}, {"clean": table}, None) == ("big", "clean")
    assert pick_variables({"n": scalar}, {"m": scalar}, None) is None
    assert pick_variables({"df": table}, {"df": table}, "missing") is None


def test_resources_and_memory_sampler() -> None:
    resources = system_resources(Path.cwd())
    assert resources["ram_total_mb"] > 0 and resources["disk_free_mb"] > 0
    with MemorySampler(os.getpid(), interval_s=0.01) as sampler:
        payload = bytearray(30 * 1024 * 1024)
    assert sampler.peak_mb is not None and sampler.start_mb is not None
    assert sampler.peak_mb >= sampler.start_mb
    del payload
