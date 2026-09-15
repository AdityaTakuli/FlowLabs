"""Graph → code transformations (PRD II 6, 14): safety, formatting preservation, backups, undo."""

from __future__ import annotations

import ast
import json
from pathlib import Path
from typing import Any

import nbformat
import pytest
from flowlab_lab.project import LabProject
from flowlab_lab.transforms import (
    TransformConflict,
    TransformError,
    apply_transform,
    backups_for,
    rename_defined,
    revert_last,
    wrap_in_function,
)
from hypothesis import given, settings
from hypothesis import strategies as st

SCRIPT = """import math

# %% Load
data = [3, 1, 2]  # raw values, 'single' quotes kept

# %% Sort
ordered = sorted(data)

# %% Scale
factor = 10
scaled = [v * factor for v in ordered]

# %% Report
total = sum(scaled)
label = "total"
"""


def run(text: str) -> dict[str, Any]:
    namespace: dict[str, Any] = {}
    exec(compile(text, "<flowlab-test>", "exec"), namespace)  # noqa: S102 - test fixture code
    return {k: v for k, v in namespace.items() if not k.startswith("__") and type(v).__name__ != "module"}


def project_with(tmp_path: Path, name: str, text: str) -> LabProject:
    (tmp_path / name).write_text(text)
    project = LabProject(tmp_path)
    project.init()
    return project


def sources(cells: list[dict[str, Any]]) -> list[str]:
    return ["".join(c["source"]) if isinstance(c["source"], list) else c["source"] for c in cells]


def notebook_text(*cells: str) -> str:
    nb = nbformat.v4.new_notebook()
    nb.cells = [nbformat.v4.new_code_cell(c) for c in cells]
    return nbformat.writes(nb)


# ---------------------------------------------------------------------------- reorder


def test_reorder_moves_the_region_and_preserves_bytes(tmp_path: Path) -> None:
    project = project_with(tmp_path, "s.py", SCRIPT)
    result = apply_transform(project, "s.py", "reorder", node_ids=["b1"], params={"after": "b3"})
    text = (tmp_path / "s.py").read_text()
    # the marker-less first region gains a `# %%` marker so it stays its own block
    assert text == SCRIPT.replace("import math\n\n", "").replace(
        "ordered = sorted(data)\n\n", "ordered = sorted(data)\n\n# %%\nimport math\n\n"
    )
    assert "# raw values, 'single' quotes kept" in text and 'label = "total"' in text
    assert sorted(text.replace("# %%\nimport math", "import math").splitlines()) == sorted(
        SCRIPT.splitlines()
    )
    assert run(text) == run(SCRIPT)
    assert result.graph.code_nodes() and backups_for(project, "s.py")


def test_reorder_that_breaks_a_dependency_is_refused_naming_the_edge(tmp_path: Path) -> None:
    project = project_with(tmp_path, "s.py", SCRIPT)
    with pytest.raises(TransformError) as err:
        apply_transform(project, "s.py", "reorder", node_ids=["b3"], params={"after": "b4"})
    assert err.value.code == "DEPENDENCY_VIOLATION"
    assert err.value.message == "Refused: b4 uses `ordered` from b3; after this change it would be undefined"
    assert err.value.details["blocking_edge"] == {"from": "b3", "to": "b4", "variable": "ordered"}
    assert (tmp_path / "s.py").read_text() == SCRIPT and not backups_for(project, "s.py")


def test_reorder_that_changes_which_definition_is_read_is_refused(tmp_path: Path) -> None:
    text = "# %%\nx = 1\n\n# %%\ny = x + 1\n\n# %%\nx = 5\n"
    project = project_with(tmp_path, "r.py", text)
    with pytest.raises(TransformError, match="b2 uses `x` from b1; after this change it would come from b3"):
        apply_transform(project, "r.py", "reorder", node_ids=["b3"], params={"before": "b2"})


def test_notebook_reorder_keeps_other_cells_identical(tmp_path: Path) -> None:
    text = notebook_text("a = 1", "b = 2", "c = a + 1", "a = 1")
    project = project_with(tmp_path, "n.ipynb", text)
    apply_transform(project, "n.ipynb", "reorder", node_ids=["b2"], params={"after": "b3"})
    after = json.loads((tmp_path / "n.ipynb").read_text())
    before = json.loads(text)
    assert sources(after["cells"]) == ["a = 1", "c = a + 1", "b = 2", "a = 1"]
    assert after["cells"][1] == before["cells"][2]  # untouched cell, byte-for-byte JSON
    nbformat.validate(nbformat.reads((tmp_path / "n.ipynb").read_text(), as_version=4))


# ------------------------------------------------------------------------ split & merge


def test_split_and_merge_marker_scripts(tmp_path: Path) -> None:
    project = project_with(tmp_path, "s.py", SCRIPT)
    split = apply_transform(project, "s.py", "split", node_ids=["b4"], params={"line": 3})
    assert "factor = 10\n# %%\nscaled" in (tmp_path / "s.py").read_text()
    assert len(split.graph.code_nodes()) == 6
    merged = apply_transform(project, "s.py", "merge", node_ids=["b4", "b5"])
    assert (tmp_path / "s.py").read_text() == SCRIPT
    assert len(merged.graph.code_nodes()) == 5
    with pytest.raises(TransformError) as err:
        apply_transform(project, "s.py", "merge", node_ids=["b2", "b4"])
    assert err.value.code == "NOT_ADJACENT"


def test_split_refuses_to_cut_a_statement(tmp_path: Path) -> None:
    project = project_with(tmp_path, "loop.py", "# %%\nfor i in range(3):\n    x = i\n    y = x\n")
    with pytest.raises(TransformError) as err:
        apply_transform(project, "loop.py", "split", node_ids=["b1"], params={"line": 3})
    assert err.value.code == "SPLIT_INSIDE_STATEMENT"


def test_plain_scripts_need_markers_before_splitting(tmp_path: Path) -> None:
    project = project_with(tmp_path, "p.py", "a = 1\nb = 2\n\nc = a + b\n")
    with pytest.raises(TransformError) as err:
        apply_transform(project, "p.py", "split", node_ids=["b1"], params={"line": 2})
    assert err.value.code == "NO_MARKERS"
    apply_transform(project, "p.py", "add_markers")
    assert (tmp_path / "p.py").read_text() == "# %%\na = 1\nb = 2\n\n# %%\nc = a + b\n"
    apply_transform(project, "p.py", "split", node_ids=["b1"], params={"line": 3})
    assert run((tmp_path / "p.py").read_text())["c"] == 3


def test_notebook_split_and_merge(tmp_path: Path) -> None:
    project = project_with(tmp_path, "n.ipynb", notebook_text("a = 1\nb = a + 1", "c = b"))
    apply_transform(project, "n.ipynb", "split", node_ids=["b1"], params={"line": 2})
    cells = json.loads((tmp_path / "n.ipynb").read_text())["cells"]
    assert sources(cells) == ["a = 1\n", "b = a + 1", "c = b"]
    assert len({c["id"] for c in cells}) == 3
    apply_transform(project, "n.ipynb", "merge", node_ids=["b1", "b2"])
    cells = json.loads((tmp_path / "n.ipynb").read_text())["cells"]
    assert sources(cells) == ["a = 1\nb = a + 1", "c = b"]
    nbformat.validate(nbformat.reads((tmp_path / "n.ipynb").read_text(), as_version=4))


# ------------------------------------------------------------------------ delete & insert


def test_delete_requires_confirmation_when_it_breaks_downstream(tmp_path: Path) -> None:
    project = project_with(tmp_path, "s.py", SCRIPT)
    with pytest.raises(TransformError) as err:
        apply_transform(project, "s.py", "delete", node_ids=["b3"])
    assert err.value.code == "CONFIRM_REQUIRED" and err.value.details["downstream"] == ["b4"]
    result = apply_transform(project, "s.py", "delete", node_ids=["b3"], confirm=True)
    assert "ordered = sorted" not in (tmp_path / "s.py").read_text()
    assert result.affected == ["b4"] and result.graph.node("undefined:ordered") is not None
    apply_transform(project, "s.py", "delete", node_ids=["b1"])  # `math` is unused: no confirm needed


def test_insert_is_refused_when_it_would_shadow_a_definition(tmp_path: Path) -> None:
    project = project_with(tmp_path, "s.py", SCRIPT)
    with pytest.raises(
        TransformError, match="b4 uses `ordered` from b3; after this change it would come from"
    ):
        apply_transform(project, "s.py", "insert", node_ids=["b3"], params={"source": "ordered = []"})
    result = apply_transform(project, "s.py", "insert", node_ids=["b2"], params={"source": "unit = 'kg'"})
    assert "# %%\nunit = 'kg'\n" in (tmp_path / "s.py").read_text()
    assert run((tmp_path / "s.py").read_text())["total"] == 60
    assert len(result.graph.code_nodes()) == 6


# ---------------------------------------------------------------- duplicate & extract


def test_rename_defined_respects_reads_before_the_first_store() -> None:
    code = "# %% Clean\ndf = df.dropna()\ndf['x'] = 1  # keep comment\nprint(df)\n"
    assert rename_defined(code, {"df": "df_copy"}) == (
        "# %% Clean\ndf_copy = df.dropna()\ndf_copy['x'] = 1  # keep comment\nprint(df_copy)\n"
    )


def test_duplicate_renames_defines_and_runs(tmp_path: Path) -> None:
    project = project_with(tmp_path, "s.py", SCRIPT)
    result = apply_transform(project, "s.py", "duplicate", node_ids=["b4"])
    text = (tmp_path / "s.py").read_text()
    assert "factor_copy = 10\nscaled_copy = [v * factor_copy for v in ordered]" in text
    values = run(text)
    assert values["scaled_copy"] == values["scaled"] and values["total"] == 60
    assert "factor→factor_copy" in result.message


def test_duplicate_refuses_in_place_and_loop_carried_updates(tmp_path: Path) -> None:
    text = "# %%\ntotal = 0\n\n# %%\ntotal += 5\n\n# %%\nfor v in [1, 2]:\n    total = total + v\n"
    project = project_with(tmp_path, "d.py", text)
    for node_id in ("b2", "b3"):
        with pytest.raises(TransformError) as err:
            apply_transform(project, "d.py", "duplicate", node_ids=[node_id])
        assert err.value.code == "DUPLICATE_UNSAFE"
    assert (tmp_path / "d.py").read_text() == text


def test_extract_to_function_preserves_behaviour(tmp_path: Path) -> None:
    project = project_with(tmp_path, "s.py", SCRIPT)
    result = apply_transform(project, "s.py", "extract", node_ids=["b4"], params={"name": "scale"})
    text = (tmp_path / "s.py").read_text()
    assert "def scale(ordered):\n    factor = 10\n" in text
    assert "    return factor, scaled\n\n\nfactor, scaled = scale(ordered)\n" in text
    assert run(text)["total"] == run(SCRIPT)["total"]
    assert result.message == "extracted b4 into scale(ordered)"
    ast.parse(text)


def test_extract_refusals(tmp_path: Path) -> None:
    text = "# %%\nitems = [1]\n\n# %%\nitems.append(2)\n\n# %%\nif items:\n    flag = True\n"
    project = project_with(tmp_path, "e.py", text)
    with pytest.raises(TransformError, match="it mutates outer-scope names \\(items\\)"):
        apply_transform(project, "e.py", "extract", node_ids=["b2"], params={"name": "grow"})
    with pytest.raises(TransformError, match="defines names conditionally"):
        apply_transform(project, "e.py", "extract", node_ids=["b3"], params={"name": "check"})
    with pytest.raises(TransformError) as err:
        apply_transform(project, "e.py", "extract", node_ids=["b1"], params={"name": "items"})
    assert err.value.code == "NAME_TAKEN"


def test_wrap_in_function_without_returns() -> None:
    assert wrap_in_function("print(x)\n", "show", ["x"], []) == "def show(x):\n    print(x)\n\n\nshow(x)\n"


# ------------------------------------------------------------ backups, undo, conflicts


def test_revert_restores_the_exact_file(tmp_path: Path) -> None:
    project = project_with(tmp_path, "s.py", SCRIPT)
    project.watcher.prime()
    apply_transform(project, "s.py", "duplicate", node_ids=["b2"])
    assert project.watcher.poll() == []  # the agent's own write does not trigger re-analysis
    revert_last(project, "s.py")
    assert (tmp_path / "s.py").read_text() == SCRIPT
    with pytest.raises(TransformError) as err:
        revert_last(project, "s.py")
    assert err.value.code == "NO_BACKUP"


def test_external_edits_are_detected_before_applying(tmp_path: Path) -> None:
    project = project_with(tmp_path, "s.py", SCRIPT)
    rendered = project.analyse("s.py")
    rendered_hash = project.file_hash("s.py")
    (tmp_path / "s.py").write_text(SCRIPT.replace('label = "total"', 'label = "sum"'))
    with pytest.raises(TransformConflict):
        apply_transform(project, "s.py", "duplicate", node_ids=["b2"], expected_hash=rendered_hash)
    unchanged_target = {"b2": rendered.node("b2").source_hash}  # type: ignore[union-attr]
    apply_transform(
        project,
        "s.py",
        "duplicate",
        node_ids=["b2"],
        expected_hash=rendered_hash,
        expected_sources=unchanged_target,
    )
    assert "data_copy = [3, 1, 2]" in (tmp_path / "s.py").read_text()


# ---------------------------------------------------------------- reorder property test

PROPERTY_SCRIPT = "\n".join(
    [
        "# %%\na = 2",
        "# %%\nb = 3",
        "# %%\nc = a * b",
        "# %%\nd = b + 1",
        "# %%\na = 7",
        "# %%\ne = c + d + a",
        "",
    ]
)


@settings(max_examples=40, deadline=None)
@given(moving=st.integers(1, 6), anchor=st.integers(1, 6), after=st.booleans())
def test_random_reorders_are_refused_or_preserve_results(
    tmp_path_factory: pytest.TempPathFactory, moving: int, anchor: int, after: bool
) -> None:
    if moving == anchor:
        return
    root = tmp_path_factory.mktemp("prop")
    project = project_with(root, "p.py", PROPERTY_SCRIPT)
    try:
        apply_transform(
            project,
            "p.py",
            "reorder",
            node_ids=[f"b{moving}"],
            params={"after" if after else "before": f"b{anchor}"},
        )
    except TransformError as exc:
        assert exc.code in {"DEPENDENCY_VIOLATION", "NO_CHANGE"}
        assert (root / "p.py").read_text() == PROPERTY_SCRIPT
        return
    new_text = (root / "p.py").read_text()
    ast.parse(new_text)
    assert run(new_text) == run(PROPERTY_SCRIPT)
