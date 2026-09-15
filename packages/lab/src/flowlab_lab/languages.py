"""Which languages a project uses, and which workspace each file opens in.

FlowLab has two ways to show a file as a graph:

* **cells** – the Code Mode lab: blocks run in a kernel, edges carry live values. That model fits
  exploratory data analysis and ML (notebooks, ``# %%`` scripts, pandas/sklearn/torch scripts).
* **structure** – functions, classes and the calls between them, editable node by node. This fits
  application code (web backends, libraries, services) in any language, where running a block on
  its own is meaningless.

The choice is deterministic and explained (``reason``), and a Python file can be opened either way.
"""

from __future__ import annotations

import ast
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Literal

Workspace = Literal["cells", "structure"]


@dataclass(frozen=True)
class Language:
    id: str  # tree-sitter grammar name
    name: str
    monaco: str  # Monaco editor language id


_L = Language
LANGUAGES: dict[str, Language] = {
    ".py": _L("python", "Python", "python"),
    ".ipynb": _L("python", "Python", "python"),
    ".js": _L("javascript", "JavaScript", "javascript"),
    ".mjs": _L("javascript", "JavaScript", "javascript"),
    ".cjs": _L("javascript", "JavaScript", "javascript"),
    ".jsx": _L("javascript", "JavaScript", "javascript"),
    ".ts": _L("typescript", "TypeScript", "typescript"),
    ".mts": _L("typescript", "TypeScript", "typescript"),
    ".tsx": _L("tsx", "TypeScript", "typescript"),
    ".go": _L("go", "Go", "go"),
    ".rs": _L("rust", "Rust", "rust"),
    ".java": _L("java", "Java", "java"),
    ".kt": _L("kotlin", "Kotlin", "kotlin"),
    ".kts": _L("kotlin", "Kotlin", "kotlin"),
    ".scala": _L("scala", "Scala", "scala"),
    ".cs": _L("csharp", "C#", "csharp"),
    ".c": _L("c", "C", "c"),
    ".h": _L("c", "C", "c"),
    ".cc": _L("cpp", "C++", "cpp"),
    ".cpp": _L("cpp", "C++", "cpp"),
    ".cxx": _L("cpp", "C++", "cpp"),
    ".hpp": _L("cpp", "C++", "cpp"),
    ".rb": _L("ruby", "Ruby", "ruby"),
    ".php": _L("php", "PHP", "php"),
    ".swift": _L("swift", "Swift", "swift"),
    ".dart": _L("dart", "Dart", "dart"),
    ".lua": _L("lua", "Lua", "lua"),
    ".r": _L("r", "R", "r"),
    ".R": _L("r", "R", "r"),
    ".jl": _L("julia", "Julia", "julia"),
    ".ex": _L("elixir", "Elixir", "elixir"),
    ".exs": _L("elixir", "Elixir", "elixir"),
    ".sh": _L("bash", "Shell", "shell"),
    ".bash": _L("bash", "Shell", "shell"),
    ".sql": _L("sql", "SQL", "sql"),
    ".vue": _L("vue", "Vue", "html"),
    ".svelte": _L("svelte", "Svelte", "html"),
}
CODE_SUFFIXES = tuple(LANGUAGES)
LAB_SUFFIXES = (".py", ".ipynb")
MAX_CLASSIFY_BYTES = 400_000

DATA_LIBRARIES = frozenset(
    {
        "pandas", "numpy", "polars", "sklearn", "scipy", "statsmodels", "torch", "tensorflow", "keras",
        "xgboost", "lightgbm", "catboost", "matplotlib", "seaborn", "plotly", "pyspark", "dask",
        "transformers", "datasets", "optuna", "mlflow", "shap", "jax", "cv2", "PIL",
    }
)  # fmt: skip
APP_LIBRARIES = frozenset(
    {
        "fastapi", "flask", "django", "starlette", "sqlalchemy", "celery", "aiohttp", "tornado", "grpc",
        "pydantic_settings", "uvicorn", "gunicorn", "click", "typer", "alembic", "sanic", "falcon",
        "litestar", "websockets", "redis", "kombu", "boto3", "requests", "httpx",
    }
)  # fmt: skip
CELL_MARKER = re.compile(r"^\s*#\s*(%%|In\s*\[)", re.MULTILINE)


def language_for(path: str) -> Language | None:
    suffix = PurePosixPath(path).suffix
    return LANGUAGES.get(suffix) or LANGUAGES.get(suffix.lower())


def is_code_file(path: str) -> bool:
    return language_for(path) is not None


@dataclass(frozen=True)
class FileKind:
    language: str
    language_name: str
    monaco: str
    workspace: Workspace
    reason: str
    can_run_cells: bool


def _imported_roots(tree: ast.Module) -> set[str]:
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            roots.add(node.module.split(".")[0])
    return roots


def classify(path: str, text: str | None) -> FileKind | None:
    """Pick the workspace for one file. ``text`` may be None when the file was not read."""
    language = language_for(path)
    if language is None:
        return None

    def kind(workspace: Workspace, reason: str) -> FileKind:
        return FileKind(
            language.id, language.name, language.monaco, workspace, reason, path.endswith(LAB_SUFFIXES)
        )

    if path.endswith(".ipynb"):
        return kind("cells", "notebook")
    if not path.endswith(".py"):
        return kind("structure", f"{language.name} code is shown as functions and calls")
    if text is None or len(text) > MAX_CLASSIFY_BYTES:
        return kind("structure", "large Python module")
    if CELL_MARKER.search(text):
        return kind("cells", "script with # %% cells")
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return kind("cells", "does not parse yet; cells show where")
    roots = _imported_roots(tree)
    data, app = sorted(roots & DATA_LIBRARIES), sorted(roots & APP_LIBRARIES)
    statements = [n for n in tree.body if not isinstance(n, ast.Import | ast.ImportFrom | ast.Expr)]
    definitions = [
        n for n in statements if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef)
    ]
    script_like = len(statements) > 0 and len(definitions) / len(statements) < 0.5
    if app:
        return kind("structure", f"application code (imports {', '.join(app[:3])})")
    if data and (script_like or not definitions):
        return kind("cells", f"data/ML script (imports {', '.join(data[:3])})")
    if data:
        return kind(
            "structure", f"data/ML library module (imports {', '.join(data[:3])}); open as cells to run it"
        )
    if script_like:
        return kind("cells", "top-level script")
    return kind("structure", "Python module of functions and classes")


@dataclass(frozen=True)
class LanguageSummary:
    id: str
    name: str
    files: int
    share: float


def summarise(paths: list[str]) -> list[LanguageSummary]:
    """Languages by file count, most used first (the first one is the project's primary language)."""
    counts = Counter(language.name for path in paths if (language := language_for(path)) is not None)
    total = sum(counts.values()) or 1
    ids: dict[str, str] = {}
    for language in LANGUAGES.values():
        ids.setdefault(language.name, language.id)
    return [
        LanguageSummary(ids[name], name, count, round(count / total, 3))
        for name, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    ]
