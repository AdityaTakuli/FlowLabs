"""Turn a plan (snippet ids + params) into one runnable, reviewed Python script.

Everything here is deterministic and free: validation, ordering, inserting missing
prerequisites (loading, splitting, numeric preparation, a default model) and rendering.
Only real ambiguity goes back to the LLM as a short error list.
"""

from __future__ import annotations

import ast
import difflib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .digest import DatasetDigest
from .snippets import Snippet, SnippetLibrary

AUTO_PROVIDERS = {
    "split": "split.train_test",
    "features_ready": "prep.ensure_numeric",
    "model": "model.random_forest_auto",
    "preds": "evaluate.predict",
}
LOADERS: dict[str, tuple[str, dict[str, Any]]] = {
    ".csv": ("load.csv", {}),
    ".tsv": ("load.csv", {"sep": "tab"}),
    ".parquet": ("load.parquet", {}),
    ".xlsx": ("load.excel", {}),
    ".xls": ("load.excel", {}),
    ".json": ("load.json", {"lines": False}),
    ".jsonl": ("load.json", {"lines": True}),
    ".ndjson": ("load.json", {"lines": True}),
}
BASE_IMPORTS = ["from pathlib import Path", "import numpy as np", "import pandas as pd"]


class PlanStep(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    use: str
    with_: dict[str, Any] = Field(default_factory=dict, alias="with")
    node: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,40}$")  # a Build-mode node id


class Plan(BaseModel):
    model_config = ConfigDict(extra="ignore")

    target: str | None = None
    steps: list[PlanStep] = Field(default_factory=list)
    note: str = ""


@dataclass
class ComposedStep:
    snippet: Snippet
    values: dict[str, Any]
    auto: bool = False
    node: str | None = None


@dataclass
class ComposeResult:
    steps: list[ComposedStep] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    adjustments: list[str] = field(default_factory=list)
    script: str | None = None

    @property
    def ok(self) -> bool:
        return not self.errors and self.script is not None


def _stage_sort(steps: list[ComposedStep]) -> list[ComposedStep]:
    """Stable sort by stage; read-only steps inherit the stage of the step before them."""
    keyed = []
    current = 0.5
    for index, step in enumerate(steps):
        stage = step.snippet.effective_stage
        if stage is not None:
            current = stage
        keyed.append((current if stage is None else stage, index, step))
    return [step for _, _, step in sorted(keyed, key=lambda item: (item[0], item[1]))]


def compose(
    plan: Plan,
    library: SnippetLibrary,
    digest: DatasetDigest,
    *,
    goal: str = "",
    seed: int = 42,
    cells: bool = False,
    output_dir: Path | None = None,
) -> ComposeResult:
    result = ComposeResult()
    errors, adjustments = result.errors, result.adjustments
    known = set(digest.names)
    target = plan.target

    if target is not None and target not in known:
        close = difflib.get_close_matches(target, sorted(known), n=1)
        errors.append(
            f"target: unknown column '{target}'" + (f" (did you mean '{close[0]}'?)" if close else "")
        )

    chosen: list[ComposedStep] = []
    loader: ComposedStep | None = None
    for index, step in enumerate(plan.steps, 1):
        snippet = library.get(step.use)
        if snippet is None:
            close = difflib.get_close_matches(step.use, library.ids(), n=1)
            errors.append(
                f"step {index}: unknown snippet '{step.use}'"
                + (f" (did you mean '{close[0]}'?)" if close else "")
            )
            continue
        raw = dict(step.with_)
        if "target" in snippet.params and "target" not in raw and target:
            raw["target"] = target
        values, problems = snippet.bind(raw, known)
        errors.extend(f"step {index} {snippet.id}: {problem}" for problem in problems)
        known.update(snippet.new_columns(values))
        if snippet.category == "split" and isinstance(values.get("target"), str):
            target = target or values["target"]
        if snippet.task and target and not problems:
            task = digest.task_for(target)
            if task and task != snippet.task:
                errors.append(
                    f"step {index} {snippet.id}: needs a {snippet.task} target but '{target}' is {task}"
                )
        composed = ComposedStep(snippet, values, node=step.node)
        if snippet.category == "load":
            loader = loader or composed
            continue
        if step.node is None and any(c.snippet.id == snippet.id and c.values == values for c in chosen):
            adjustments.append(f"dropped duplicate step {snippet.id}")
            continue
        chosen.append(composed)

    if sum(1 for c in chosen if c.snippet.category == "split") > 1:
        errors.append("use at most one split step")

    ordered = _stage_sort(chosen)
    if [id(c) for c in ordered] != [id(c) for c in chosen]:
        adjustments.append("reordered steps: clean -> split -> prepare -> model -> evaluate -> export")

    final: list[ComposedStep] = []
    state: set[str] = set()

    def add(step: ComposedStep) -> None:
        final.append(step)
        state.update(step.snippet.provides)

    def ensure(token: str, needed_by: str) -> None:
        if token in state:
            return
        overrides: dict[str, Any] = {}
        if token == "df":
            if loader is not None:
                add(loader)
                return
            suffix = digest.path.suffix.lower()
            if suffix not in LOADERS:
                errors.append(f"no loader for '{suffix}' files")
                state.add(token)
                return
            loader_id, overrides = LOADERS[suffix]
            provider = library.get(loader_id)
            values: dict[str, Any] = {}
        else:
            provider = library.get(AUTO_PROVIDERS[token])
            values = {}
        if provider is None:
            errors.append(f"library is missing the provider for '{token}'")
            state.add(token)
            return
        if token == "split" and not target:
            errors.append(f'{needed_by} needs a train/test split: set "target" to the column to predict')
            state.add(token)
            return
        for requirement in provider.requires:
            ensure(requirement, provider.id)
        values = provider.defaults()
        if token == "df":
            values.update(overrides)
        if "target" in provider.params:
            values["target"] = target
        add(ComposedStep(provider, values, auto=True))
        if token != "df":
            adjustments.append(f"added {provider.id} (needed by {needed_by})")

    ensure("df", "the script")
    for composed_step in ordered:
        for requirement in composed_step.snippet.requires:
            ensure(requirement, composed_step.snippet.id)
        add(composed_step)

    result.steps = final
    if errors:
        return result
    result.script = render_script(
        final, digest, goal=goal, note=plan.note, seed=seed, cells=cells, output_dir=output_dir
    )
    return result


def _one_line(text: str, limit: int = 200) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 3] + "..."


SHOW_CHART_HELPER = '''def show_chart(path):
    """Show a saved chart inline in a notebook kernel; does nothing when run as a plain script."""
    try:
        from IPython import get_ipython
        from IPython.display import Image, display
    except ImportError:
        return
    if path is not None and get_ipython() is not None and Path(path).is_file():
        display(Image(filename=str(path)))
'''


def render_script(
    steps: list[ComposedStep],
    digest: DatasetDigest,
    *,
    goal: str = "",
    note: str = "",
    seed: int = 42,
    cells: bool = False,
    output_dir: Path | None = None,
) -> str:
    """Render the composed steps as one script.

    ``cells=True`` writes ``# %%`` markers (one block per step, for Code Mode and editors) and shows
    each saved chart inline when the block runs in a kernel. ``output_dir`` pins where files are
    written; by default they go next to the script, which needs ``__file__`` and so a plain run.
    """
    imports = list(dict.fromkeys([*BASE_IMPORTS, *(line for s in steps for line in s.snippet.imports)]))
    uses_matplotlib = any("matplotlib" in line for line in imports)
    imports.sort(key=lambda line: (line.startswith("from "), line))

    lines = ["# %% Setup"] if cells else []
    lines.append("# Generated by FlowLab from reviewed snippets. Safe to read and edit.")
    if goal:
        lines.append(f"# Goal: {_one_line(goal)}")
    if note:
        lines.append(f"# Plan: {_one_line(note)}")
    lines.append("# Steps:")
    for number, step in enumerate(steps, 1):
        flag = " (auto)" if step.auto else ""
        lines.append(f"#   {number:>2}. {step.snippet.id}{flag} - {step.snippet.title}")
    lines.append("")
    if uses_matplotlib:
        lines += ["import matplotlib", "", 'matplotlib.use("Agg")']
    lines += imports
    lines += [
        "",
        f"DATA_PATH = Path({str(digest.path.resolve())!r})",
        f"OUTPUT_DIR = Path({str(output_dir.resolve())!r})"
        if output_dir is not None
        else 'OUTPUT_DIR = Path(__file__).resolve().parent / "outputs"',
        "OUTPUT_DIR.mkdir(parents=True, exist_ok=True)",
        f"SEED = {seed}",
        "",
    ]
    if cells and uses_matplotlib:
        lines += [SHOW_CHART_HELPER]
    for number, step in enumerate(steps, 1):
        charts = cells and any("matplotlib" in line for line in step.snippet.imports)
        if cells:
            node = f" {{node:{step.node}}}" if step.node else ""
            lines.append(f"# %% {number}. {step.snippet.title} [{step.snippet.id}]{node}")
        else:
            lines.append(f"# --- {number}. {step.snippet.title} [{step.snippet.id}] ---")
        if charts:
            lines.append("chart_path = None")
        lines.append(step.snippet.render(step.values))
        if charts:
            lines.append("show_chart(chart_path)")
        lines.append("")
    script = "\n".join(lines).rstrip() + "\n"
    ast.parse(script)
    return script
