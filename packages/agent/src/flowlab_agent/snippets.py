"""Snippet library: reviewed, parameterised code templates that the planner composes.

A snippet is one TOML file under ``snippets/<category>/<name>.toml``. The LLM never sees or
writes code: it picks snippet ids and supplies parameter values, which are validated here and
rendered into the template as Python literals.
"""

from __future__ import annotations

import ast
import difflib
import math
import re
import tomllib
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

LIBRARY_DIR = Path(__file__).parent / "snippets"

# Program state a snippet can need or create. Composition checks these, in order.
STATE_TOKENS = frozenset({"df", "split", "features_ready", "model", "preds"})

# Default execution stage per category. ``None`` means read-only: the step keeps its place
# relative to the steps around it.
CATEGORY_STAGES: dict[str, float | None] = {
    "load": 0,
    "clean": 1,
    "feature": 1,
    "split": 2,
    "prep": 3,
    "model": 4,
    "evaluate": 5,
    "explain": 5,
    "export": 6,
    "inspect": None,
    "stats": None,
    "viz": None,
}

PLACEHOLDER = re.compile(r"\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}")
_NEW_COLUMN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_SAFE_PATH = re.compile(r"^(?!/)(?!.*\.\.)[A-Za-z0-9_\-./]{1,120}$")
MAX_TEXT = 200

ParamType = Literal[
    "column", "columns", "new_column", "int", "float", "bool", "choice", "text", "scalar", "path"
]


class ParamError(ValueError):
    pass


class ParamSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: ParamType
    description: str = ""
    default: Any = None
    optional: bool = False
    choices: list[str] | None = None
    min: float | None = None
    max: float | None = None

    @model_validator(mode="after")
    def _consistent(self) -> ParamSpec:
        if self.type == "choice" and not self.choices:
            raise ValueError("choice params need choices")
        if self.default is not None:
            coerce_value(self, self.default, "default", None)
        return self

    @property
    def required(self) -> bool:
        return not self.optional and self.default is None

    def signature(self, name: str) -> str:
        short = {"column": "col", "columns": "cols", "new_column": "name", "scalar": "value"}
        kind = "|".join(self.choices or []) if self.type == "choice" else short.get(self.type, self.type)
        text = f"{name}{'' if self.required else '?'}:{kind}"
        if self.default is not None and self.default != []:
            text += f"={self.default}"
        return text


def _check_column(value: str, name: str, known: set[str] | None) -> None:
    if known is not None and value not in known:
        close = difflib.get_close_matches(value, sorted(known), n=1)
        hint = f" (did you mean '{close[0]}'?)" if close else ""
        raise ParamError(f"'{name}': unknown column '{value}'{hint}")


def _bounded(spec: ParamSpec, number: float, name: str) -> Any:
    if spec.min is not None and number < spec.min:
        raise ParamError(f"'{name}' must be >= {spec.min:g}")
    if spec.max is not None and number > spec.max:
        raise ParamError(f"'{name}' must be <= {spec.max:g}")
    return number


def _number(value: Any, name: str, kind: str) -> float:
    if isinstance(value, bool):
        raise ParamError(f"'{name}' must be {kind}")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ParamError(f"'{name}' must be {kind}") from None
    if not math.isfinite(number):
        raise ParamError(f"'{name}' must be finite")
    return number


def coerce_value(spec: ParamSpec, value: Any, name: str, known_columns: Iterable[str] | None) -> Any:
    """Validate and normalise one parameter value. Raises ParamError with a short message."""
    known = set(known_columns) if known_columns is not None else None
    if value is None or value == [] or value == "":
        if spec.default is not None:
            return spec.default
        if spec.optional:
            return None
        raise ParamError(f"'{name}' is required")

    kind = spec.type
    if kind == "column":
        if not isinstance(value, str):
            raise ParamError(f"'{name}' must be a column name")
        _check_column(value, name, known)
        return value
    if kind == "columns":
        items = [value] if isinstance(value, str) else value
        if not isinstance(items, list) or not all(isinstance(v, str) for v in items):
            raise ParamError(f"'{name}' must be a list of column names")
        for item in items:
            _check_column(item, name, known)
        return list(dict.fromkeys(items))
    if kind == "new_column":
        if not isinstance(value, str) or not _NEW_COLUMN.match(value):
            raise ParamError(f"'{name}' must be a simple identifier-like column name")
        return value
    if kind == "int":
        number = _number(value, name, "an integer")
        if not number.is_integer():
            raise ParamError(f"'{name}' must be an integer")
        return int(_bounded(spec, number, name))
    if kind == "float":
        return float(_bounded(spec, _number(value, name, "a number"), name))
    if kind == "bool":
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.lower() in ("true", "false"):
            return value.lower() == "true"
        raise ParamError(f"'{name}' must be true or false")
    if kind == "choice":
        if value not in (spec.choices or []):
            raise ParamError(f"'{name}' must be one of {spec.choices}")
        return value
    if kind == "text":
        if not isinstance(value, str) or len(value) > MAX_TEXT:
            raise ParamError(f"'{name}' must be text up to {MAX_TEXT} characters")
        return value
    if kind == "scalar":
        if isinstance(value, bool | int | float) or (isinstance(value, str) and len(value) <= MAX_TEXT):
            return value
        raise ParamError(f"'{name}' must be a number, text or boolean")
    if kind == "path":
        if not isinstance(value, str) or not _SAFE_PATH.match(value):
            raise ParamError(f"'{name}' must be a relative path without '..'")
        return value
    raise ParamError(f"unsupported param type {kind}")


def python_literal(value: Any) -> str:
    """Render a validated value as Python source. Only literals ever reach the script."""
    if value is None or isinstance(value, bool | int | str):
        return repr(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ParamError("non-finite numbers cannot be rendered")
        return repr(value)
    if isinstance(value, list):
        return "[" + ", ".join(python_literal(v) for v in value) + "]"
    raise ParamError(f"cannot render {type(value).__name__} as a literal")


class SnippetExample(BaseModel):
    """How the library test suite exercises a snippet against a fixture dataset."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    dataset: str = "churn"
    file: Literal["csv", "tsv", "parquet", "xlsx", "json", "jsonl"] = "csv"
    target: str | None = None
    with_: dict[str, Any] = Field(default_factory=dict, alias="with")
    skip: str | None = None


class Snippet(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z]+\.[a-z0-9_]+$")
    title: str = Field(min_length=3, max_length=60)
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    task: Literal["classification", "regression"] | None = None
    requires: list[str] = Field(default_factory=list)
    provides: list[str] = Field(default_factory=list)
    imports: list[str] = Field(default_factory=list)
    params: dict[str, ParamSpec] = Field(default_factory=dict)
    code: str
    stage: float | None = None
    auto: bool = False
    example: SnippetExample = Field(default_factory=SnippetExample)

    @property
    def category(self) -> str:
        return self.id.split(".", 1)[0]

    @property
    def effective_stage(self) -> float | None:
        return self.stage if self.stage is not None else CATEGORY_STAGES.get(self.category)

    @property
    def placeholders(self) -> set[str]:
        return set(PLACEHOLDER.findall(self.code))

    def signature(self) -> str:
        params = [spec.signature(name) for name, spec in self.params.items()]
        return f"{self.id}: {self.title}" + (f" ({', '.join(params)})" if params else "")

    def bind(
        self, raw: Mapping[str, Any], known_columns: Iterable[str] | None
    ) -> tuple[dict[str, Any], list[str]]:
        errors = [
            f"unknown param '{key}' (valid: {', '.join(self.params) or 'none'})"
            for key in sorted(set(raw) - set(self.params))
        ]
        values: dict[str, Any] = {}
        known = list(known_columns) if known_columns is not None else None
        for name, spec in self.params.items():
            try:
                values[name] = coerce_value(spec, raw.get(name), name, known)
            except ParamError as exc:
                errors.append(str(exc))
        return values, errors

    def defaults(self) -> dict[str, Any]:
        return {name: spec.default for name, spec in self.params.items()}

    def new_columns(self, values: Mapping[str, Any]) -> list[str]:
        return [
            values[name]
            for name, spec in self.params.items()
            if spec.type == "new_column" and isinstance(values.get(name), str)
        ]

    def render(self, values: Mapping[str, Any]) -> str:
        return PLACEHOLDER.sub(lambda m: python_literal(values[m.group(1)]), self.code).strip("\n")


@dataclass(frozen=True)
class LibraryIssue:
    path: str
    message: str


def _sample_value(spec: ParamSpec) -> Any:
    if spec.default is not None:
        return spec.default
    return {
        "column": "col",
        "columns": ["col"],
        "new_column": "new_col",
        "int": int(spec.min or 1),
        "float": float(spec.min or 0.5),
        "bool": True,
        "choice": (spec.choices or ["x"])[0],
        "text": "x",
        "scalar": 0,
        "path": "out.csv",
    }[spec.type]


def _lint(snippet: Snippet, directory: str, stem: str) -> list[str]:
    problems = []
    if snippet.category != directory:
        problems.append(f"id category '{snippet.category}' does not match directory '{directory}'")
    if snippet.id.split(".", 1)[1] != stem:
        problems.append(f"id '{snippet.id}' does not match file name '{stem}.toml'")
    if snippet.category not in CATEGORY_STAGES:
        problems.append(f"unknown category '{snippet.category}'")
    missing = snippet.placeholders - set(snippet.params)
    unused = set(snippet.params) - snippet.placeholders
    if missing:
        problems.append(f"placeholders without params: {sorted(missing)}")
    if unused:
        problems.append(f"params never used in code: {sorted(unused)}")
    bad_state = set(snippet.requires + snippet.provides) - STATE_TOKENS
    if bad_state:
        problems.append(f"unknown state tokens: {sorted(bad_state)}")
    for line in snippet.imports:
        if not line.startswith(("import ", "from ")):
            problems.append(f"not an import statement: {line!r}")
    extra = set(snippet.example.with_) - set(snippet.params)
    if extra:
        problems.append(f"example sets unknown params: {sorted(extra)}")
    if not missing:
        try:
            ast.parse("\n".join(snippet.imports))
            ast.parse(snippet.render({n: _sample_value(s) for n, s in snippet.params.items()}))
        except SyntaxError as exc:
            problems.append(f"code is not valid Python: {exc.msg} (line {exc.lineno})")
        else:
            problems.extend(_literal_isolation(snippet))
    return problems


_TEXT_TYPES = frozenset({"column", "columns", "new_column", "text", "scalar", "path", "choice"})


def _literal_isolation(snippet: Snippet) -> list[str]:
    """Every placeholder must render as a standalone literal, never inside another string.

    Otherwise a crafted value could close the surrounding quote and inject code.
    """
    sentinels = {
        name: f"__flowlab_param_{name}__" for name, s in snippet.params.items() if s.type in _TEXT_TYPES
    }
    values = {
        name: ([sentinels[name]] if spec.type == "columns" else sentinels[name])
        if name in sentinels
        else _sample_value(spec)
        for name, spec in snippet.params.items()
    }
    tree = ast.parse(PLACEHOLDER.sub(lambda m: repr(values[m.group(1)]), snippet.code))
    problems = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            for name, sentinel in sentinels.items():
                if sentinel in node.value and node.value != sentinel:
                    problems.append(
                        f"placeholder '{name}' is used inside a string literal; assign it to a variable first"
                    )
    return sorted(set(problems))


class SnippetLibrary:
    def __init__(self, snippets: Mapping[str, Snippet], issues: list[LibraryIssue], root: Path) -> None:
        self._snippets = dict(sorted(snippets.items()))
        self.issues = issues
        self.root = root

    @classmethod
    def load(cls, root: Path = LIBRARY_DIR) -> SnippetLibrary:
        snippets: dict[str, Snippet] = {}
        issues: list[LibraryIssue] = []
        for path in sorted(root.rglob("*.toml")):
            rel = path.relative_to(root).as_posix()
            try:
                snippet = Snippet.model_validate(tomllib.loads(path.read_text(encoding="utf-8")))
            except tomllib.TOMLDecodeError as exc:
                issues.append(LibraryIssue(rel, f"invalid TOML: {exc}"))
                continue
            except ValidationError as exc:
                for err in exc.errors()[:5]:
                    loc = ".".join(str(p) for p in err["loc"])
                    issues.append(LibraryIssue(rel, f"{loc}: {err['msg']}"))
                continue
            issues.extend(LibraryIssue(rel, p) for p in _lint(snippet, path.parent.name, path.stem))
            if snippet.id in snippets:
                issues.append(LibraryIssue(rel, f"duplicate snippet id '{snippet.id}'"))
            snippets[snippet.id] = snippet
        return cls(snippets, issues, root)

    def __len__(self) -> int:
        return len(self._snippets)

    def __iter__(self) -> Iterator[Snippet]:
        return iter(self._snippets.values())

    def get(self, snippet_id: str) -> Snippet | None:
        return self._snippets.get(snippet_id)

    def ids(self) -> list[str]:
        return list(self._snippets)

    def categories(self) -> list[str]:
        return sorted({s.category for s in self})
