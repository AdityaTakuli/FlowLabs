"""Build mode: a no-code pipeline of snippet nodes, finalized into one runnable script.

The user draws the pipeline: each node is a reviewed snippet (what it is for, which technique,
its parameters) and edges say what feeds what. Finalizing is mostly deterministic:

1. order the nodes along the edges (ties broken by pipeline stage, then canvas position),
2. compose them with the snippet composer, which validates parameters against the dataset and
   inserts missing prerequisites (loading, splitting, model-ready features),
3. check that every cell only uses names defined by earlier cells.

Only when step 3 finds gaps (or a run failed) does the LLM take part: it writes short *glue* cells
that connect the snippets. Glue is validated (parses, small, allowlisted imports, no file, network
or process access) before it is inserted, and the whole script is checked again afterwards.
"""

from __future__ import annotations

import ast
import builtins
import json
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .composer import BASE_IMPORTS, ComposeResult, Plan, PlanStep, compose
from .digest import DatasetDigest
from .llm import LLMClient, Message
from .snippets import PLACEHOLDER, Snippet, SnippetLibrary, _sample_value

NODE_ID = r"^[A-Za-z0-9_-]{1,40}$"
MAX_NODES = 80
MAX_GLUE_CELLS = 8
MAX_GLUE_LINES = 20
GLUE_IMPORT_ROOTS = frozenset({"numpy", "pandas", "sklearn", "torch", "math", "scipy"})
GLUE_BANNED_NAMES = frozenset(
    {
        "open",
        "exec",
        "eval",
        "compile",
        "__import__",
        "input",
        "globals",
        "locals",
        "vars",
        "breakpoint",
        "exit",
        "quit",
    }
)
SCRIPT_NAMES = frozenset({"DATA_PATH", "OUTPUT_DIR", "SEED", "show_chart", "Path", "np", "pd", "flowlab_log"})
NODE_MARKER = re.compile(r"\{node:([A-Za-z0-9_-]{1,40})\}")


# --------------------------------------------------------------------------- purposes
@dataclass(frozen=True)
class Purpose:
    id: str
    title: str
    question: str
    categories: tuple[str, ...]


PURPOSES: tuple[Purpose, ...] = (
    Purpose("data", "Import data", "Load a dataset file (CSV, Excel, Parquet, JSON) into a table", ("load",)),
    Purpose(
        "explore",
        "Explore data",
        "Summaries, missing values, correlations and statistical tests",
        ("inspect", "stats"),
    ),
    Purpose(
        "clean",
        "Clean data",
        "Fix types, drop duplicates and bad rows, fill or remove missing values",
        ("clean",),
    ),
    Purpose(
        "features",
        "Engineer features",
        "Create new columns: ratios, dates, lags, logs, interactions",
        ("feature",),
    ),
    Purpose(
        "split",
        "Split train and test",
        "Hold out data for honest evaluation (random, time-based, grouped)",
        ("split",),
    ),
    Purpose(
        "preprocess", "Preprocess", "Scale, encode, impute, transform, reduce or balance features", ("prep",)
    ),
    Purpose(
        "model",
        "Train a model",
        "Classification, regression, clustering, deep learning or tuning",
        ("model",),
    ),
    Purpose(
        "evaluate", "Evaluate", "Metrics, confusion matrix, ROC and precision-recall curves", ("evaluate",)
    ),
    Purpose("explain", "Explain", "Which features drive the predictions", ("explain",)),
    Purpose("visualize", "Visualize", "Histograms, scatter plots, trends, heatmaps", ("viz",)),
    Purpose("export", "Save results", "Save the model, predictions or cleaned data", ("export",)),
)
PURPOSE_OF_CATEGORY = {category: p.id for p in PURPOSES for category in p.categories}

CLUSTERING = {"model.kmeans", "model.dbscan", "model.agglomerative", "model.gaussian_mixture"}
AUTOMATIC = {"model.grid_search", "model.random_forest_auto"}
PREP_GROUPS = (
    ("Imputation", ("impute",)),
    ("Encoding", ("encode", "tfidf")),
    ("Scaling and normalization", ("scale", "normalize", "maxabs")),
    ("Transforms", ("transform", "polynomial")),
    ("Outliers", ("outlier",)),
    ("Selection and reduction", ("select", "pca", "variance", "ready")),
    ("Class balancing", ("oversample", "balance")),
)


def group_of(snippet: Snippet) -> str:
    """Sub-heading inside a purpose, e.g. Classification / Deep learning / Scaling."""
    category = snippet.category
    if category == "model":
        if "torch" in snippet.id:
            return "Deep learning (PyTorch)"
        if snippet.id in CLUSTERING:
            return "Clustering"
        if snippet.id in AUTOMATIC:
            return "Tuning and automatic"
        if snippet.task == "classification":
            return "Classification"
        if snippet.task == "regression":
            return "Regression"
        return "Classification and regression"
    if category == "prep":
        text = f"{snippet.id} {' '.join(snippet.tags)}"
        return next((name for name, words in PREP_GROUPS if any(w in text for w in words)), "Other")
    if category == "inspect":
        return "Summaries"
    if category == "stats":
        return "Statistical tests"
    return ""


def example_code(snippet: Snippet) -> str:
    """The snippet as it would be written with its default (or placeholder) parameters."""
    values: dict[str, Any] = {}
    for name, spec in snippet.params.items():
        if spec.default is not None:
            values[name] = spec.default
        elif spec.type == "column":
            values[name] = f"<{name}>"
        elif spec.type == "columns":
            values[name] = [] if spec.optional else [f"<{name}>"]
        else:
            values[name] = _sample_value(spec)
    imports = "\n".join(snippet.imports)
    body = PLACEHOLDER.sub(lambda m: repr(values[m.group(1)]), snippet.code).strip("\n")
    return f"{imports}\n\n{body}" if imports else body


def catalogue(library: SnippetLibrary) -> list[dict[str, Any]]:
    by_purpose: dict[str, list[dict[str, Any]]] = {p.id: [] for p in PURPOSES}
    for snippet in library:
        purpose = PURPOSE_OF_CATEGORY.get(snippet.category)
        if purpose is None:
            continue
        by_purpose[purpose].append(
            {
                "id": snippet.id,
                "title": snippet.title,
                "description": snippet.description,
                "tags": snippet.tags,
                "group": group_of(snippet),
                "task": snippet.task,
                "requires": snippet.requires,
                "provides": snippet.provides,
                "params": {name: spec.model_dump() for name, spec in snippet.params.items()},
                "example": example_code(snippet),
            }
        )
    return [
        {
            "id": p.id,
            "title": p.title,
            "question": p.question,
            "snippets": sorted(by_purpose[p.id], key=lambda s: (s["group"], s["title"])),
        }
        for p in PURPOSES
    ]


# --------------------------------------------------------------------------- pipeline
class PipelineNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=NODE_ID)
    snippet: str
    params: dict[str, Any] = Field(default_factory=dict)
    x: float = 0.0
    y: float = 0.0
    label: str | None = Field(default=None, max_length=80)


class PipelineEdge(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    from_: str = Field(alias="from", pattern=NODE_ID)
    to: str = Field(pattern=NODE_ID)


class Pipeline(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = 1
    name: str = Field(min_length=1, max_length=80)
    dataset: str | None = None
    target: str | None = None
    nodes: list[PipelineNode] = Field(default_factory=list, max_length=MAX_NODES)
    edges: list[PipelineEdge] = Field(default_factory=list)


class Issue(BaseModel):
    node: str | None
    severity: Literal["error", "warning", "info"]
    message: str


def order_nodes(pipeline: Pipeline, library: SnippetLibrary) -> tuple[list[PipelineNode], list[Issue]]:
    """Topological order along edges; ties by snippet stage, then canvas position (top to bottom)."""
    issues: list[Issue] = []
    nodes = {n.id: n for n in pipeline.nodes}
    incoming: dict[str, set[str]] = {n: set() for n in nodes}
    outgoing: dict[str, set[str]] = {n: set() for n in nodes}
    for edge in pipeline.edges:
        if edge.from_ not in nodes or edge.to not in nodes:
            issues.append(
                Issue(
                    node=None,
                    severity="warning",
                    message=f"edge {edge.from_} → {edge.to} points at a missing node",
                )
            )
            continue
        if edge.from_ == edge.to:
            continue
        incoming[edge.to].add(edge.from_)
        outgoing[edge.from_].add(edge.to)

    def key(node_id: str) -> tuple[float, float, float, str]:
        snippet = library.get(nodes[node_id].snippet)
        stage = snippet.effective_stage if snippet is not None else None
        return (stage if stage is not None else 2.5, nodes[node_id].y, nodes[node_id].x, node_id)

    ready = sorted((n for n, parents in incoming.items() if not parents), key=key)
    order: list[str] = []
    remaining = {n: set(p) for n, p in incoming.items()}
    while ready:
        current = ready.pop(0)
        order.append(current)
        for child in sorted(outgoing[current]):
            remaining[child].discard(current)
            if not remaining[child] and child not in order and child not in ready:
                ready.append(child)
        ready.sort(key=key)
    stuck = [n for n in nodes if n not in order]
    if stuck:
        issues.append(
            Issue(node=stuck[0], severity="error", message=f"these nodes form a loop: {', '.join(stuck)}")
        )
        order.extend(sorted(stuck, key=key))
    return [nodes[n] for n in order], issues


def check(pipeline: Pipeline, library: SnippetLibrary, digest: DatasetDigest | None) -> list[Issue]:
    issues: list[Issue] = []
    if not pipeline.nodes:
        issues.append(
            Issue(node=None, severity="info", message="add nodes with “Create node” to start the pipeline")
        )
    if pipeline.dataset is None:
        issues.append(Issue(node=None, severity="error", message="choose the dataset this pipeline reads"))
    known = set(digest.names) if digest is not None else None
    ids = [n.id for n in pipeline.nodes]
    for duplicate in sorted({i for i in ids if ids.count(i) > 1}):
        issues.append(Issue(node=duplicate, severity="error", message=f"node id {duplicate} is used twice"))
    ordered, order_issues = order_nodes(pipeline, library)
    issues.extend(order_issues)
    provided: set[str] = {"df"} if pipeline.dataset else set()
    target = pipeline.target
    for node in ordered:
        snippet = library.get(node.snippet)
        if snippet is None:
            issues.append(
                Issue(node=node.id, severity="error", message=f"unknown technique '{node.snippet}'")
            )
            continue
        raw = dict(node.params)
        if "target" in snippet.params and not raw.get("target") and target:
            raw["target"] = target
        _, problems = snippet.bind(raw, known)
        issues.extend(Issue(node=node.id, severity="error", message=p) for p in problems)
        if snippet.task and target and digest is not None:
            task = digest.task_for(target)
            if task and task != snippet.task:
                issues.append(
                    Issue(
                        node=node.id,
                        severity="error",
                        message=(
                            f"{snippet.title} needs a {snippet.task} target; '{target}' looks like {task}"
                        ),
                    )
                )
        auto = {"split": "a train/test split", "features_ready": "model-ready features", "model": "a model"}
        for token in snippet.requires:
            if token not in provided and token in auto:
                if token == "split" and not target:
                    issues.append(
                        Issue(
                            node=node.id,
                            severity="error",
                            message="set the target column (or add a Split node) first",
                        )
                    )
                else:
                    issues.append(
                        Issue(
                            node=node.id,
                            severity="info",
                            message=(
                                f"no earlier node provides {auto[token]}; one will be added automatically"
                            ),
                        )
                    )
        provided.update(snippet.requires)
        provided.update(snippet.provides)
    return issues


# --------------------------------------------------------------------------- names
def _local_names(function: ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda) -> set[str]:
    args = function.args
    names = {a.arg for a in [*args.posonlyargs, *args.args, *args.kwonlyargs]}
    names |= {a.arg for a in (args.vararg, args.kwarg) if a is not None}
    body = function.body if isinstance(function.body, list) else [function.body]
    for statement in body:
        for node in ast.walk(statement):
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                names.add(node.id)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names.add(node.name)
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                names |= {(alias.asname or alias.name).split(".")[0] for alias in node.names}
    return names


def _defined_and_used(tree: ast.Module) -> tuple[set[str], set[str]]:
    """Module-level names a cell defines, and names it reads before defining them (source order)."""
    defined: set[str] = set()
    used: set[str] = set()

    def visit(node: ast.AST, hidden: frozenset[str]) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for decorator in node.decorator_list:
                visit(decorator, hidden)
            for default in [*node.args.defaults, *(d for d in node.args.kw_defaults if d is not None)]:
                visit(default, hidden)
            if not hidden:
                defined.add(node.name)
            inner = hidden | _local_names(node) | {node.name}
            for statement in node.body:
                visit(statement, inner)
        elif isinstance(node, ast.Lambda):
            visit(node.body, hidden | _local_names(node))
        elif isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            targets = frozenset(
                n.id for g in node.generators for n in ast.walk(g.target) if isinstance(n, ast.Name)
            )
            for generator in node.generators:
                visit(generator.iter, hidden)
                for condition in generator.ifs:
                    visit(condition, hidden | targets)
            for part in (node.key, node.value) if isinstance(node, ast.DictComp) else (node.elt,):
                visit(part, hidden | targets)
        elif isinstance(node, ast.ClassDef):
            if not hidden:
                defined.add(node.name)
            class_names = {
                n.id for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)
            }
            for statement in node.body:
                visit(statement, hidden | class_names | {node.name})
        elif isinstance(node, (ast.Assign, ast.AugAssign, ast.AnnAssign, ast.NamedExpr)):
            if node.value is not None:
                visit(node.value, hidden)
            assigned = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in assigned:
                if isinstance(node, ast.AugAssign) and isinstance(target, ast.Name):
                    visit(ast.Name(id=target.id, ctx=ast.Load()), hidden)
                visit(target, hidden)
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            visit(node.iter, hidden)
            visit(node.target, hidden)
            for statement in [*node.body, *node.orelse]:
                visit(statement, hidden)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            if not hidden:
                defined.update((alias.asname or alias.name).split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ExceptHandler):
            if node.type is not None:
                visit(node.type, hidden)
            if node.name and not hidden:
                defined.add(node.name)
            for statement in node.body:
                visit(statement, hidden | ({node.name} if node.name else set()))
        elif isinstance(node, ast.Name):
            if isinstance(node.ctx, ast.Store):
                if not hidden:
                    defined.add(node.id)
            elif node.id not in hidden and node.id not in defined:
                used.add(node.id)
        else:
            for child in ast.iter_child_nodes(node):
                visit(child, hidden)

    for statement in tree.body:
        visit(statement, frozenset())
    return defined, used


def unresolved_names(cells: Sequence[str]) -> list[set[str]]:
    """For each cell, the names it reads that no earlier cell (or Python) defines."""
    available = set(dir(builtins)) | SCRIPT_NAMES
    result: list[set[str]] = []
    for code in cells:
        try:
            defined, used = _defined_and_used(ast.parse(code))
        except SyntaxError:
            result.append(set())
            continue
        result.append({name for name in used if name not in available})
        available |= defined
    return result


# ------------------------------------------------------------------------------ script
@dataclass
class Cell:
    title: str
    code: str
    node: str | None = None
    snippet: str | None = None
    glue: bool = False
    auto: bool = False
    why: str = ""


@dataclass
class Finalized:
    ok: bool
    script: str | None
    cells: list[Cell] = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)
    adjustments: list[str] = field(default_factory=list)
    unresolved: dict[str, list[str]] = field(default_factory=dict)
    llm_used: bool = False
    tokens: int = 0
    notes: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "script": self.script,
            "cells": [c.__dict__ for c in self.cells],
            "issues": [i.model_dump() for i in self.issues],
            "adjustments": self.adjustments,
            "unresolved": self.unresolved,
            "llm_used": self.llm_used,
            "tokens": self.tokens,
            "notes": self.notes,
        }


def split_cells(script: str) -> list[tuple[str, str]]:
    """(title, code) per ``# %%`` cell; the header line is not part of the code."""
    cells: list[tuple[str, str]] = []
    title, body = "", list[str]()
    for line in script.splitlines():
        if line.startswith("# %%"):
            if body or title:
                cells.append((title, "\n".join(body).strip("\n")))
            title, body = line[4:].strip(), []
        else:
            body.append(line)
    cells.append((title, "\n".join(body).strip("\n")))
    return cells


def join_cells(cells: Sequence[Cell]) -> str:
    parts = []
    for cell in cells:
        parts.append(f"# %% {cell.title}\n{cell.code.rstrip()}\n")
    script = "\n".join(parts)
    ast.parse(script)
    return script


def compose_pipeline(
    pipeline: Pipeline, library: SnippetLibrary, digest: DatasetDigest, *, output_dir: Path
) -> tuple[ComposeResult, list[Cell], list[Issue]]:
    ordered, issues = order_nodes(pipeline, library)
    steps = [
        PlanStep(use=n.snippet, with_=n.params, node=n.id)
        for n in ordered
        if library.get(n.snippet) is not None
    ]
    plan = Plan(target=pipeline.target or None, steps=steps, note=f"Build mode pipeline '{pipeline.name}'")
    result = compose(plan, library, digest, goal=pipeline.name, cells=True, output_dir=output_dir)
    cells: list[Cell] = []
    if result.script is not None:
        by_node = {s.node: s for s in result.steps if s.node}
        for title, code in split_cells(result.script):
            marker = NODE_MARKER.search(title)
            node = marker.group(1) if marker else None
            step = by_node.get(node) if node else None
            auto_step = next((s for s in result.steps if s.auto and f"[{s.snippet.id}]" in title), None)
            cells.append(
                Cell(
                    title=title,
                    code=code,
                    node=node,
                    snippet=step.snippet.id if step else (auto_step.snippet.id if auto_step else None),
                    auto=auto_step is not None and step is None,
                )
            )
    return result, cells, issues


# --------------------------------------------------------------------------------- glue
CONNECT_SYSTEM = """You connect reviewed Python cells into one working data/ML pipeline.
The cells run top to bottom in one Jupyter kernel. Some cells read names that no earlier cell defines.
Write the smallest GLUE cells that make the pipeline run: rename or derive variables, select the
target, convert types or shapes. Never rewrite or repeat existing cells.
Rules for glue code:
- at most {max_lines} lines per glue cell, at most {max_cells} glue cells;
- imports only from numpy, pandas, sklearn, torch, scipy or math;
- no file, network, process or environment access; no open/exec/eval/__import__;
- use only columns listed in the dataset summary.
Return JSON only:
{{"glue": [{{"before_cell": <cell number>, "code": "...", "why": "one short sentence"}}], "notes": "..."}}
Return {{"glue": [], "notes": "..."}} if the cells cannot be connected with small glue."""


def validate_glue(code: str) -> str | None:
    """Why a glue cell is rejected, or None when it is acceptable."""
    if len(code.strip().splitlines()) > MAX_GLUE_LINES:
        return f"more than {MAX_GLUE_LINES} lines"
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        return f"not valid Python ({exc.msg})"
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            modules = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]
            if isinstance(node, ast.ImportFrom) and node.level:
                return "relative imports are not allowed"
            for module in modules:
                if module.split(".")[0] not in GLUE_IMPORT_ROOTS:
                    return f"import of '{module}' is not allowed"
        elif isinstance(node, ast.Name) and node.id in GLUE_BANNED_NAMES:
            return f"'{node.id}' is not allowed"
        elif isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            return "dunder attribute access is not allowed"
        elif isinstance(node, ast.Attribute) and node.attr in (
            "to_csv",
            "to_parquet",
            "to_excel",
            "to_pickle",
            "save",
            "load",
            "system",
            "popen",
        ):
            return f"'.{node.attr}' is not allowed in glue"
    return None


def _prompt(
    cells: list[Cell],
    unresolved: list[set[str]],
    digest: DatasetDigest,
    target: str | None,
    error: str | None,
) -> str:
    lines = [f"DATASET: {digest.path.name}; {digest.text()}", f"TARGET: {target or '(none)'}", "", "CELLS:"]
    for number, (cell, missing) in enumerate(zip(cells, unresolved, strict=True)):
        if number == 0:
            lines.append(
                f"[cell 0] setup: imports {', '.join(BASE_IMPORTS)}; defines DATA_PATH, OUTPUT_DIR, SEED"
            )
            continue
        lines.append(
            f"[cell {number}] {cell.title}"
            + (f"  (reads undefined: {', '.join(sorted(missing))})" if missing else "")
        )
        lines.append(cell.code)
    if error:
        lines += ["", "THE LAST RUN FAILED:", error[-1500:]]
    return "\n".join(lines)


def connect(
    cells: list[Cell],
    digest: DatasetDigest,
    target: str | None,
    client: LLMClient,
    *,
    error: str | None = None,
    max_tokens: int = 1200,
) -> tuple[list[Cell], list[str], int]:
    """Ask the LLM for glue cells; returns (cells with accepted glue, notes, tokens used)."""
    unresolved = unresolved_names([c.code for c in cells])
    system = CONNECT_SYSTEM.format(max_lines=MAX_GLUE_LINES, max_cells=MAX_GLUE_CELLS)
    response = client.complete(
        [Message("system", system), Message("user", _prompt(cells, unresolved, digest, target, error))],
        max_tokens=max_tokens,
        json_mode=True,
    )
    tokens = response.prompt_tokens + response.completion_tokens
    notes: list[str] = []
    try:
        payload = json.loads(re.sub(r"^```(?:json)?|```$", "", response.text.strip()).strip())
        proposals = payload.get("glue", []) if isinstance(payload, dict) else []
        if isinstance(payload, dict) and isinstance(payload.get("notes"), str) and payload["notes"].strip():
            notes.append(payload["notes"].strip()[:300])
    except (ValueError, AttributeError):
        return cells, ["the model's answer was not valid JSON; no glue was added"], tokens
    inserts: dict[int, list[Cell]] = {}
    for proposal in proposals[:MAX_GLUE_CELLS] if isinstance(proposals, list) else []:
        if not isinstance(proposal, dict):
            continue
        code = str(proposal.get("code", "")).strip()
        why = " ".join(str(proposal.get("why", "connect the cells")).split())[:120]
        before = proposal.get("before_cell")
        if not isinstance(before, int) or not 1 <= before <= len(cells):
            notes.append(f"skipped glue with an invalid position ({before!r})")
            continue
        problem = validate_glue(code)
        if problem:
            notes.append(f"rejected glue before cell {before}: {problem}")
            continue
        inserts.setdefault(before, []).append(Cell(title=f"Glue: {why}", code=code, glue=True, why=why))
    merged: list[Cell] = []
    for index, cell in enumerate(cells):
        merged.extend(inserts.get(index, []))
        merged.append(cell)
    merged.extend(inserts.get(len(cells), []))
    return merged, notes, tokens


def finalize(
    pipeline: Pipeline,
    library: SnippetLibrary,
    digest: DatasetDigest,
    *,
    output_dir: Path,
    client: LLMClient | None = None,
    error: str | None = None,
) -> Finalized:
    issues = check(pipeline, library, digest)
    blocking = [i for i in issues if i.severity == "error"]
    if blocking:
        return Finalized(ok=False, script=None, issues=issues)
    result, cells, _ = compose_pipeline(pipeline, library, digest, output_dir=output_dir)
    if not result.ok or not cells:
        issues.extend(Issue(node=None, severity="error", message=e) for e in result.errors)
        return Finalized(ok=False, script=None, issues=issues, adjustments=result.adjustments)
    finalized = Finalized(ok=True, script=None, cells=cells, issues=issues, adjustments=result.adjustments)
    gaps = unresolved_names([c.code for c in cells])
    if (any(gaps) or error) and client is not None:
        try:
            cells, notes, tokens = connect(cells, digest, pipeline.target, client, error=error)
        except Exception as exc:  # noqa: BLE001 - the deterministic script still stands
            notes, tokens = (
                [f"the model could not be reached ({type(exc).__name__}); the script is unchanged"],
                0,
            )
        finalized.cells, finalized.llm_used, finalized.tokens = cells, True, tokens
        finalized.notes = "; ".join(notes)
    elif any(gaps):
        finalized.notes = "some cells read names no earlier cell defines; connect with AI to add glue"
    else:
        finalized.notes = "every cell's inputs come from earlier cells; no glue was needed (0 tokens)"
    remaining = unresolved_names([c.code for c in finalized.cells])
    finalized.unresolved = {
        (cell.node or cell.title): sorted(missing)
        for cell, missing in zip(finalized.cells, remaining, strict=True)
        if missing
    }
    for cell_key, missing in finalized.unresolved.items():
        node = next((c.node for c in finalized.cells if (c.node or c.title) == cell_key), None)
        finalized.issues.append(
            Issue(
                node=node,
                severity="warning",
                message=f"reads {', '.join(missing)} before anything defines it",
            )
        )
    finalized.script = join_cells(finalized.cells)
    return finalized


def load_pipeline(data: dict[str, Any]) -> Pipeline:
    try:
        return Pipeline.model_validate(data)
    except ValidationError as exc:
        problems = [f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()[:5]]
        raise ValueError("; ".join(problems)) from exc
