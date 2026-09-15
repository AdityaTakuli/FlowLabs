"""Stage 1 — Parse: AST → Units (SEG-010 … SEG-012, SEG-024 … SEG-026).

Everything here is deterministic and read-only (``ast``, never regex over code). Besides the
manifest fields, each unit keeps internal evidence the later stages need: resolved-ready call
sites, ML events (split / transformer fit / model fit / metric …) with line numbers, literals
that look like inline configuration, and the external libraries it touches.
"""

from __future__ import annotations

import ast
import builtins
import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

from ..symbols import NETWORK_PREFIXES, PLOT_METHODS, PLOT_PREFIXES, RANDOM_PREFIXES, READ_PREFIXES
from .inventory import SourceFile
from .models import Confidence, Unit, UnitKind

BUILTINS = frozenset(dir(builtins))
CELL_MARKER = re.compile(r"^\s*#\s*%%(?P<rest>.*)$")
HTTP_ROUTE_ATTRS = frozenset(
    {"get", "post", "put", "delete", "patch", "options", "head", "route", "api_route", "websocket"}
)
ROUTE_REGISTRATION = frozenset({"add_url_rule", "add_api_route", "add_route"})
DJANGO_ROUTES = frozenset({"django.urls.path", "django.urls.re_path", "django.conf.urls.url"})
ORCHESTRATION_ROOTS = ("airflow", "prefect", "dagster", "celery", "luigi")
DYNAMIC_CALLS = frozenset(
    {"getattr", "setattr", "eval", "exec", "__import__", "importlib.import_module", "globals", "locals"}
)
TRANSFORMER_MODULES = (
    "sklearn.preprocessing",
    "sklearn.impute",
    "sklearn.feature_selection",
    "sklearn.decomposition",
    "sklearn.feature_extraction",
    "sklearn.compose",
    "category_encoders",
)
TRANSFORMER_SUFFIXES = (
    "Scaler",
    "Encoder",
    "Imputer",
    "PCA",
    "SVD",
    "Vectorizer",
    "Selector",
    "Transformer",
    "Binarizer",
    "Normalizer",
    "Discretizer",
    "SelectKBest",
    "PolynomialFeatures",
)
SPLITTER_CLASSES = frozenset(
    {
        "KFold",
        "StratifiedKFold",
        "GroupKFold",
        "ShuffleSplit",
        "StratifiedShuffleSplit",
        "GroupShuffleSplit",
        "TimeSeriesSplit",
        "RepeatedKFold",
        "RepeatedStratifiedKFold",
    }
)
METRIC_NAMES = frozenset(
    {
        "accuracy_score",
        "f1_score",
        "precision_score",
        "recall_score",
        "roc_auc_score",
        "classification_report",
        "confusion_matrix",
        "mean_squared_error",
        "mean_absolute_error",
        "r2_score",
        "log_loss",
        "cross_val_score",
    }
)
WRITE_METHODS = frozenset(
    {
        "to_csv",
        "to_parquet",
        "to_excel",
        "to_json",
        "to_sql",
        "to_pickle",
        "savefig",
        "write_text",
        "write_bytes",
    }
)
ARTIFACT_WRITES = ("joblib.dump", "pickle.dump", "torch.save", "numpy.save", "cloudpickle.dump")
READ_CALLS = ("json.load", "pickle.load", "joblib.load", "numpy.load", "torch.load", "yaml.safe_load")
HYPERPARAMETER_KEYS = frozenset(
    {
        "n_estimators",
        "max_depth",
        "learning_rate",
        "test_size",
        "train_size",
        "random_state",
        "C",
        "alpha",
        "gamma",
        "n_neighbors",
        "epochs",
        "batch_size",
        "lr",
        "threshold",
        "min_samples_leaf",
        "min_samples_split",
        "max_iter",
        "num_leaves",
        "dropout",
        "n_splits",
        "n_components",
        "max_features",
        "subsample",
    }
)
PATH_LITERAL = re.compile(
    r"^(?:\.{0,2}/|~/)?(?:[\w.-]+/)+[\w.-]+$|\.(?:csv|parquet|jsonl?|pkl|pickle|joblib|pt|pth|h5|hdf5|xlsx?|feather|onnx|ya?ml|txt)$",
    re.IGNORECASE,
)


@dataclass
class CallSite:
    line: int
    name: str  # canonical dotted name with imports expanded, e.g. "pandas.read_csv", "self.save"
    receiver: str | None  # canonical constructor of the receiver object, when known
    args: tuple[str, ...]
    targets: tuple[str, ...]


@dataclass
class Event:
    line: int
    kind: str  # split, transformer_fit, model_fit, predict, metric, plot, read, write, network, print, random
    detail: str


@dataclass
class UnitInfo:
    unit: Unit
    module: str
    atom: str  # classes and their methods share an atom (SEG-050); cells are their own atom (SEG-051)
    class_name: str | None
    call_sites: list[CallSite]
    events: list[Event]
    libraries: set[str]
    literals: list[tuple[int, str, str]]
    dynamic: bool
    bases: list[str]
    is_test: bool
    referenced: set[str]
    stores: set[str]
    has_main_guard: bool = False


@dataclass
class ModuleInfo:
    file: str
    module: str
    is_package: bool
    role: str
    imports: dict[str, str] = field(default_factory=dict)
    imported: set[str] = field(default_factory=set)
    registered_routes: list[str] = field(default_factory=list)
    all_names: set[str] = field(default_factory=set)
    parse_error: str | None = None


def module_name(path: str) -> tuple[str, bool]:
    parts = list(Path(path).with_suffix("").parts)
    is_package = bool(parts) and parts[-1] == "__init__"
    if is_package:
        parts = parts[:-1]
    return ".".join(re.sub(r"\W", "_", part) for part in parts), is_package


def dotted(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted(node.value)
        return f"{base}.{node.attr}" if base else None
    return None


def canonical(name: str, imports: dict[str, str]) -> str:
    head, _, rest = name.partition(".")
    target = imports.get(head)
    if target is None:
        return name
    return f"{target}.{rest}" if rest else target


def _resolve_from(module: str, is_package: bool, level: int, target: str | None) -> str:
    if level == 0:
        return target or ""
    parts = module.split(".") if module else []
    if not is_package:
        parts = parts[:-1]
    if level > 1:
        parts = parts[: max(0, len(parts) - (level - 1))]
    return ".".join(p for p in (".".join(parts), target or "") if p)


def collect_imports(
    statements: list[ast.stmt], module: str, is_package: bool
) -> tuple[dict[str, str], set[str]]:
    imports: dict[str, str] = {}
    imported: set[str] = set()
    queue: list[ast.AST] = list(statements)
    while queue:
        node = queue.pop(0)
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    imports[alias.asname] = alias.name
                else:
                    head = alias.name.split(".")[0]
                    imports[head] = head
                imported.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            base = _resolve_from(module, is_package, node.level, node.module)
            for alias in node.names:
                if alias.name == "*":
                    continue
                full = f"{base}.{alias.name}" if base else alias.name
                imports[alias.asname or alias.name] = full
                imported.update({base, full} - {""})
        elif not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            queue.extend(
                child
                for child in ast.iter_child_nodes(node)
                if isinstance(child, (ast.stmt, ast.excepthandler))
            )
    return imports, imported


def _is_transformer(origin: str) -> bool:
    return origin.startswith(TRANSFORMER_MODULES) or origin.rsplit(".", 1)[-1].endswith(TRANSFORMER_SUFFIXES)


def classify_call(call: CallSite) -> Event | None:
    name, receiver = call.name, call.receiver or ""
    last = name.rsplit(".", 1)[-1]
    short_receiver = receiver.rsplit(".", 1)[-1]
    if (
        name.endswith("train_test_split")
        or last in ("random_split", "randomSplit")
        or (last == "split" and short_receiver in SPLITTER_CLASSES)
    ):
        return Event(call.line, "split", last)
    if last in ("fit", "fit_transform", "partial_fit"):
        if _is_transformer(receiver) or (not receiver and last == "fit_transform"):
            return Event(call.line, "transformer_fit", short_receiver or "transformer")
        return Event(call.line, "model_fit", short_receiver or "model")
    if last in ("predict", "predict_proba", "decision_function"):
        return Event(call.line, "predict", short_receiver or "model")
    if name.startswith("sklearn.metrics.") or last in METRIC_NAMES:
        return Event(call.line, "metric", last)
    if name.startswith(PLOT_PREFIXES) or ("." in name and last in PLOT_METHODS):
        return Event(call.line, "plot", last)
    if name.startswith(ARTIFACT_WRITES) or last in WRITE_METHODS:
        return Event(call.line, "write", last)
    if name.startswith(READ_PREFIXES) or name.startswith(READ_CALLS):
        return Event(call.line, "read", last)
    if name.startswith(NETWORK_PREFIXES):
        return Event(call.line, "network", name.split(".")[0])
    if name == "print":
        return Event(call.line, "print", "print")
    if name.startswith(RANDOM_PREFIXES):
        return Event(call.line, "random", last)
    return None


SIDE_EFFECT_OF = {
    "read": "io",
    "write": "filesystem",
    "network": "network",
    "print": "print",
    "random": "random",
}


class _Scanner(ast.NodeVisitor):
    def __init__(self, imports: dict[str, str]) -> None:
        self.imports = dict(imports)
        self.calls: list[CallSite] = []
        self.origins: dict[str, str] = {}
        self.targets: dict[int, tuple[str, ...]] = {}
        self.loads: set[str] = set()
        self.stores: set[str] = set()
        self.referenced: set[str] = set()
        self.raises: set[str] = set()
        self.literals: list[tuple[int, str, str]] = []
        self.complexity = 1
        self.is_generator = False
        self.global_mutation = False
        self.dynamic = False

    # imports inside units extend the map for that unit
    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            head = alias.name.split(".")[0]
            self.imports[alias.asname or head] = alias.name if alias.asname else head

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        for alias in node.names:
            if alias.name != "*" and node.level == 0 and node.module:
                self.imports[alias.asname or alias.name] = f"{node.module}.{alias.name}"

    def visit_Expr(self, node: ast.Expr) -> None:
        if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            return  # docstrings and bare strings
        self.generic_visit(node)

    def visit_Assign(self, node: ast.Assign) -> None:
        names = tuple(t.id for t in node.targets if isinstance(t, ast.Name))
        if isinstance(node.value, ast.Call):
            self.targets[id(node.value)] = names
            raw = dotted(node.value.func)
            if raw:
                for target in names:
                    self.origins[target] = canonical(raw, self.imports)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        raw = dotted(node.func)
        if raw is None and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Call):
            inner = dotted(node.func.value.func)
            if inner:
                raw = f"{inner}().{node.func.attr}"
        if raw is not None:
            if raw in DYNAMIC_CALLS or canonical(raw, self.imports) in DYNAMIC_CALLS:
                self.dynamic = True
            receiver: str | None = None
            if isinstance(node.func, ast.Attribute):
                value = node.func.value
                if isinstance(value, ast.Name):
                    receiver = self.origins.get(value.id)
                elif isinstance(value, ast.Call):
                    inner = dotted(value.func)
                    receiver = canonical(inner, self.imports) if inner else None
            name = canonical(raw.replace("().", "."), self.imports) if "()." not in raw else raw
            if "()." in raw:
                head, _, attr = raw.partition("().")
                name = f"{canonical(head, self.imports)}().{attr}"
            args = tuple(a.id for a in node.args if isinstance(a, ast.Name))
            args += tuple(k.value.id for k in node.keywords if isinstance(k.value, ast.Name))
            self.calls.append(CallSite(node.lineno, name, receiver, args, self.targets.get(id(node), ())))
        for keyword in node.keywords:
            value = keyword.value
            if (
                keyword.arg in HYPERPARAMETER_KEYS
                and isinstance(value, ast.Constant)
                and isinstance(value.value, (int, float))
                and not isinstance(value.value, bool)
            ):
                self.literals.append((node.lineno, keyword.arg, repr(value.value)))
        self.generic_visit(node)

    def visit_JoinedStr(self, node: ast.JoinedStr) -> None:
        for value in node.values:
            if isinstance(value, ast.FormattedValue):
                self.visit(value.value)

    def visit_Constant(self, node: ast.Constant) -> None:
        value = node.value
        if isinstance(value, str) and "://" not in value and len(value) < 200 and PATH_LITERAL.search(value):
            self.literals.append((node.lineno, "path", repr(value)))

    def visit_Compare(self, node: ast.Compare) -> None:
        for comparator in node.comparators:
            if (
                isinstance(comparator, ast.Constant)
                and isinstance(comparator.value, float)
                and comparator.value not in (0.0, 1.0)
            ):
                self.literals.append((node.lineno, "threshold", repr(comparator.value)))
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        self.referenced.add(node.id)
        (self.loads if isinstance(node.ctx, ast.Load) else self.stores).add(node.id)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        self.referenced.add(node.attr)
        self.generic_visit(node)

    def visit_Global(self, node: ast.Global) -> None:
        self.global_mutation = True

    def visit_Raise(self, node: ast.Raise) -> None:
        exc = node.exc
        raw = dotted(exc.func) if isinstance(exc, ast.Call) else dotted(exc) if exc is not None else None
        if raw:
            self.raises.add(canonical(raw, self.imports))
        self.generic_visit(node)

    def _nested(self, node: ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda) -> None:
        if not isinstance(node, ast.Lambda):
            self.stores.add(node.name)
        for arg in [
            *node.args.posonlyargs,
            *node.args.args,
            *node.args.kwonlyargs,
            node.args.vararg,
            node.args.kwarg,
        ]:
            if arg is not None:
                self.stores.add(arg.arg)
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._nested(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._nested(node)

    def visit_Lambda(self, node: ast.Lambda) -> None:
        self._nested(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.stores.add(node.name)
        self.generic_visit(node)

    def _branch(self, node: ast.AST, amount: int = 1) -> None:
        self.complexity += amount
        self.generic_visit(node)

    def visit_If(self, node: ast.If) -> None:
        self._branch(node)

    def visit_IfExp(self, node: ast.IfExp) -> None:
        self._branch(node)

    def visit_For(self, node: ast.For) -> None:
        self._branch(node)

    def visit_AsyncFor(self, node: ast.AsyncFor) -> None:
        self._branch(node)

    def visit_While(self, node: ast.While) -> None:
        self._branch(node)

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        self._branch(node)

    def visit_BoolOp(self, node: ast.BoolOp) -> None:
        self._branch(node, len(node.values) - 1)

    def visit_comprehension(self, node: ast.comprehension) -> None:
        self._branch(node, 1 + len(node.ifs))

    def visit_match_case(self, node: ast.match_case) -> None:
        self._branch(node)

    def visit_Yield(self, node: ast.Yield) -> None:
        self.is_generator = True
        self.generic_visit(node)

    def visit_YieldFrom(self, node: ast.YieldFrom) -> None:
        self.is_generator = True
        self.generic_visit(node)


def _line_sloc(lines: list[str], start: int, end: int, skip: tuple[tuple[int, int], ...] = ()) -> int:
    count = 0
    for number in range(start, min(end, len(lines)) + 1):
        if any(a <= number <= b for a, b in skip):
            continue
        text = lines[number - 1].strip()
        if text and not text.startswith("#"):
            count += 1
    return count


def _top_level_defines(statements: list[ast.stmt]) -> set[str]:
    names: set[str] = set()
    for node in statements:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        targets: list[ast.AST] = []
        if isinstance(node, ast.Assign):
            targets = list(node.targets)
        elif isinstance(node, (ast.AnnAssign, ast.AugAssign, ast.For, ast.AsyncFor)):
            targets = [node.target]
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            targets = [item.optional_vars for item in node.items if item.optional_vars is not None]
        for target in targets:
            names.update(n.id for n in ast.walk(target) if isinstance(n, ast.Name))
    return names


def _is_main_guard(node: ast.stmt) -> bool:
    if not isinstance(node, ast.If) or not isinstance(node.test, ast.Compare):
        return False
    test = node.test
    parts = [test.left, *test.comparators]
    return any(isinstance(p, ast.Name) and p.id == "__name__" for p in parts) and any(
        isinstance(p, ast.Constant) and p.value == "__main__" for p in parts
    )


def _decorators(
    node: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef, imports: dict[str, str]
) -> tuple[list[str], list[str], bool]:
    """Returns (source text, canonical names, is route decorator)."""
    texts: list[str] = []
    names: list[str] = []
    route = False
    for decorator in node.decorator_list:
        texts.append(ast.unparse(decorator)[:80])
        target = decorator.func if isinstance(decorator, ast.Call) else decorator
        raw = dotted(target)
        if raw:
            names.append(canonical(raw, imports))
        if (
            isinstance(target, ast.Attribute)
            and target.attr in HTTP_ROUTE_ATTRS
            and isinstance(decorator, ast.Call)
        ):
            route = True
        if raw and raw.rsplit(".", 1)[-1] == "api_view":
            route = True
    return texts, names, route


def _is_entry_decorator(names: list[str]) -> bool:
    for name in names:
        head = name.split(".")[0]
        last = name.rsplit(".", 1)[-1]
        if head in ("click", "typer") or head in ORCHESTRATION_ROOTS or last in ("command", "shared_task"):
            return True
    return False


class _Builder:
    def __init__(self, source: SourceFile, module: ModuleInfo) -> None:
        self.source = source
        self.module = module
        self.lines = source.text.splitlines()
        self.units: list[UnitInfo] = []
        self.seen: dict[str, int] = {}
        self.is_test = source.record.role == "test"

    def unit_id(self, qualified: str, kind: str) -> str:
        key = f"{self.source.record.path}::{qualified}::{kind}"
        count = self.seen.get(key, 0)
        self.seen[key] = count + 1
        suffix = f"::{count}" if count else ""
        return "u_" + hashlib.sha256((key + suffix).encode()).hexdigest()[:10]

    def add(
        self,
        *,
        kind: UnitKind,
        name: str,
        qualified: str,
        start: int,
        end: int,
        sloc: int,
        scanner: _Scanner,
        atom: str | None = None,
        class_name: str | None = None,
        signature: str | None = None,
        decorators: list[str] | None = None,
        docstring: str | None = None,
        returns: str | None = None,
        is_async: bool = False,
        params: set[str] | None = None,
        defines: set[str] | None = None,
        bases: list[str] | None = None,
        entry: bool = False,
        confidence: Confidence = "high",
        main_guard: bool = False,
    ) -> UnitInfo:
        uid = self.unit_id(qualified, kind)
        bound = scanner.stores | (params or set())
        uses = sorted((scanner.loads - bound) - BUILTINS)[:80]
        events = [e for e in (classify_call(c) for c in scanner.calls) if e is not None]
        side_effects = {SIDE_EFFECT_OF[e.kind] for e in events if e.kind in SIDE_EFFECT_OF}
        if scanner.global_mutation:
            side_effects.add("global_mutation")
        import_heads = {target.split(".")[0] for target in scanner.imports.values()}
        libraries = {c.name.split(".")[0] for c in scanner.calls if c.name.split(".")[0] in import_heads}
        libraries |= {scanner.imports[n].split(".")[0] for n in scanner.loads if n in scanner.imports}
        unit = Unit(
            id=uid,
            kind=kind,
            name=name,
            qualified_name=qualified,
            file=self.source.record.path,
            line_start=start,
            line_end=max(start, end),
            signature=signature[:200] if signature else None,
            decorators=decorators or [],
            docstring_first_line=docstring,
            loc=max(start, end) - start + 1,
            sloc=sloc,
            defines=sorted(defines or set())[:80],
            uses=uses,
            calls=sorted({c.name for c in scanner.calls})[:80],
            raises=sorted(scanner.raises),
            returns_type=returns,
            is_async=is_async,
            is_generator=scanner.is_generator,
            complexity=scanner.complexity,
            side_effects=sorted(side_effects),
            entry_point=entry,
            confidence="low" if scanner.dynamic else confidence,
        )
        info = UnitInfo(
            unit=unit,
            module=self.module.module,
            atom=atom or uid,
            class_name=class_name,
            call_sites=sorted(scanner.calls, key=lambda c: c.line),
            events=sorted(events, key=lambda e: e.line),
            libraries=libraries,
            literals=scanner.literals,
            dynamic=scanner.dynamic,
            bases=bases or [],
            is_test=self.is_test,
            referenced=scanner.referenced,
            stores=bound,
            has_main_guard=main_guard,
        )
        self.units.append(info)
        return info


def _docstring(node: ast.AST) -> str | None:
    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Module)):
        return None
    doc = ast.get_docstring(node)
    if not doc:
        return None
    return doc.strip().splitlines()[0][:120]  # SEG-026


def _signature(node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    text = f"({ast.unparse(node.args)})"
    if node.returns is not None:
        text += f" -> {ast.unparse(node.returns)}"
    return text


def _params(node: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str]:
    args = node.args
    return {
        a.arg
        for a in [*args.posonlyargs, *args.args, *args.kwonlyargs, args.vararg, args.kwarg]
        if a is not None
    }


def _scan(statements: list[ast.stmt], imports: dict[str, str]) -> _Scanner:
    scanner = _Scanner(imports)
    for statement in statements:
        scanner.visit(statement)
    return scanner


def _settings_class(node: ast.ClassDef) -> bool:
    """Only settings-style classes count as configuration; a pydantic model with fields is a schema."""
    bases = {(dotted(b) or "").rsplit(".", 1)[-1] for b in node.bases}
    return node.name.endswith(("Settings", "Config", "Constants")) or "BaseSettings" in bases


def _is_config_module(tree: ast.Module) -> bool:
    assignments = 0
    for node in tree.body:
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            if (
                isinstance(node.value, ast.Call)
                and dotted(node.value.func) not in (None,)
                and not str(dotted(node.value.func)).startswith(("os.", "Path", "pathlib."))
            ):
                return False
            assignments += 1
        elif isinstance(node, (ast.Import, ast.ImportFrom, ast.Pass)) or (
            isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
        ):
            continue
        elif (
            isinstance(node, ast.ClassDef)
            and _settings_class(node)
            and all(
                isinstance(s, (ast.Assign, ast.AnnAssign, ast.Pass))
                or (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant))
                for s in node.body
            )
        ):
            assignments += 1
        else:
            return False
    return assignments > 0


def _function_unit(
    builder: _Builder,
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    imports: dict[str, str],
    *,
    class_name: str | None,
    atom: str | None,
) -> None:
    texts, names, route = _decorators(node, imports)
    module = builder.module.module
    qualified = f"{class_name}.{node.name}" if class_name else f"{module}.{node.name}"
    kind: UnitKind = "method" if class_name else ("route_handler" if route else "function")
    scanner = _scan(node.body, imports)
    annotations = [
        a.annotation for a in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs] if a.annotation
    ]
    for annotation in [*annotations, *([node.returns] if node.returns is not None else [])]:
        scanner.visit(annotation)  # types used in a signature are uses (dead-code and dataflow evidence)
    builder.add(
        kind=kind,
        name=node.name,
        qualified=qualified,
        start=node.lineno,
        end=node.end_lineno or node.lineno,
        sloc=_line_sloc(builder.lines, node.lineno, node.end_lineno or node.lineno),
        scanner=scanner,
        atom=atom,
        class_name=class_name,
        signature=_signature(node),
        decorators=texts,
        docstring=_docstring(node),
        returns=ast.unparse(node.returns) if node.returns is not None else None,
        is_async=isinstance(node, ast.AsyncFunctionDef),
        params=_params(node),
        defines={node.name},
        entry=route or _is_entry_decorator(names),
    )


def parse_source(source: SourceFile) -> tuple[ModuleInfo, list[UnitInfo]]:
    record = source.record
    name, is_package = module_name(record.path)
    module = ModuleInfo(file=record.path, module=name, is_package=is_package, role=record.role)
    if record.parse_error:
        module.parse_error = record.parse_error
        return module, []
    builder = _Builder(source, module)
    if record.language == "notebook":
        cells = [(index, start, end, f"cell {index + 1}") for index, start, end in source.cells]
        return _parse_cells(builder, cells)
    markers = [i + 1 for i, line in enumerate(builder.lines) if CELL_MARKER.match(line)]
    if markers:
        regions: list[tuple[int, int, int, str]] = []
        bounds = markers + [len(builder.lines) + 1]
        if any(
            line.strip() and not line.lstrip().startswith("#") for line in builder.lines[: markers[0] - 1]
        ):
            regions.append((0, 1, markers[0] - 1, "preamble"))
        for number, (start, following) in enumerate(zip(bounds, bounds[1:], strict=False), 1):
            match = CELL_MARKER.match(builder.lines[start - 1])
            title = (match.group("rest") if match else "").strip()
            if title.startswith("[markdown]"):
                continue
            regions.append((number, start, following - 1, title or f"cell {number}"))
        return _parse_cells(builder, regions)
    try:
        tree = ast.parse(source.text)
    except SyntaxError as exc:
        module.parse_error = f"line {exc.lineno}: {exc.msg}"
        return module, []
    return _parse_module(builder, tree)


def _parse_cells(
    builder: _Builder, regions: list[tuple[int, int, int, str]]
) -> tuple[ModuleInfo, list[UnitInfo]]:
    module = builder.module
    trees: list[tuple[int, int, int, str, ast.Module | None]] = []
    statements: list[ast.stmt] = []
    for index, start, end, title in regions:
        code = "\n".join(builder.lines[start - 1 : end])
        if not code.strip():
            continue
        try:
            tree = ast.parse(code)
            ast.increment_lineno(tree, start - 1)
            statements.extend(tree.body)
        except SyntaxError:
            tree = None
        trees.append((index, start, end, title, tree))
    module.imports, module.imported = collect_imports(statements, module.module, module.is_package)
    for position, (_index, start, end, title, tree) in enumerate(trees, 1):
        slug = re.sub(r"\W+", "_", title.lower()).strip("_") or f"cell_{position}"
        body = tree.body if tree else []
        scanner = _scan(body, module.imports)
        builder.add(
            kind="cell_block",
            name=title,
            qualified=f"{module.module}.cell_{position}_{slug}"[:160],
            start=start,
            end=end,
            sloc=_line_sloc(builder.lines, start, end),
            scanner=scanner,
            defines=_top_level_defines(body),
            entry=True,
            confidence="high" if tree else "low",
            main_guard=any(_is_main_guard(s) for s in body),
        )
    if trees and all(t[4] is None for t in trees):
        module.parse_error = "no cell parses"
    return module, builder.units


def _parse_module(builder: _Builder, tree: ast.Module) -> tuple[ModuleInfo, list[UnitInfo]]:
    module = builder.module
    module.imports, module.imported = collect_imports(tree.body, module.module, module.is_package)
    imports = module.imports
    for node in tree.body:
        is_all = isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "__all__" for t in node.targets
        )
        if is_all and isinstance(node, ast.Assign) and isinstance(node.value, (ast.List, ast.Tuple)):
            module.all_names = {
                e.value for e in node.value.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)
            }
    _collect_routes(module, tree)
    if _is_config_module(tree):
        scanner = _scan(tree.body, imports)
        end = len(builder.lines) or 1
        builder.add(
            kind="config_block",
            name=module.module.rsplit(".", 1)[-1] or "config",
            qualified=f"{module.module}.__config__",
            start=1,
            end=end,
            sloc=_line_sloc(builder.lines, 1, end),
            scanner=scanner,
            defines=_top_level_defines(tree.body),
            docstring=_docstring(tree),
        )
        return module, builder.units

    script: list[ast.stmt] = []
    has_defs = False
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            has_defs = True
            _function_unit(builder, node, imports, class_name=None, atom=None)
        elif isinstance(node, ast.ClassDef):
            has_defs = True
            _class_units(builder, node, imports)
        elif isinstance(node, (ast.Import, ast.ImportFrom, ast.Pass)) or (
            isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ):
            continue
        else:
            script.append(node)
    if script:
        spans = [(s.lineno, s.end_lineno or s.lineno) for s in script]
        start, end = spans[0][0], spans[-1][1]
        main_guard = any(_is_main_guard(s) for s in script)
        runs_code = any(isinstance(s, ast.Expr) and isinstance(s.value, ast.Call) for s in script)
        scanner = _scan(script, imports)
        builder.add(
            kind="module_script",
            name=f"{module.module.rsplit('.', 1)[-1] or 'module'} script",
            qualified=f"{module.module}.__script__",
            start=start,
            end=end,
            sloc=sum(_line_sloc(builder.lines, a, b) for a, b in spans),
            scanner=scanner,
            defines=_top_level_defines(script),
            entry=main_guard or runs_code or not has_defs,
            main_guard=main_guard,
        )
    return module, builder.units


def _class_units(builder: _Builder, node: ast.ClassDef, imports: dict[str, str]) -> None:
    module = builder.module.module
    qualified = f"{module}.{node.name}"
    texts, names, _ = _decorators(node, imports)
    methods = [s for s in node.body if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef))]
    others = [s for s in node.body if s not in methods]
    scanner = _scan(others, imports)
    for base in node.bases:
        raw = dotted(base)
        if raw:
            scanner.loads.add(raw.split(".")[0])
    bases = [canonical(raw, imports) for raw in (dotted(b) for b in node.bases) if raw]
    end = node.end_lineno or node.lineno
    method_spans = [(m.lineno, m.end_lineno or m.lineno) for m in methods]
    info = builder.add(
        kind="class",
        name=node.name,
        qualified=qualified,
        start=node.lineno,
        end=end,
        sloc=_line_sloc(builder.lines, node.lineno, end, tuple(method_spans)),
        scanner=scanner,
        class_name=qualified,
        signature=f"({', '.join(ast.unparse(b) for b in node.bases)})" if node.bases else None,
        decorators=texts,
        docstring=_docstring(node),
        defines={node.name},
        bases=bases,
        entry=_is_entry_decorator(names),
    )
    info.atom = info.unit.id
    for method in methods:
        _function_unit(builder, method, imports, class_name=qualified, atom=info.unit.id)


def _collect_routes(module: ModuleInfo, tree: ast.Module) -> None:
    """Handlers registered by call rather than decorator (Flask add_url_rule, Django urlpatterns)."""
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        raw = dotted(node.func)
        if not raw:
            continue
        name = canonical(raw, module.imports)
        if raw.rsplit(".", 1)[-1] not in ROUTE_REGISTRATION and name not in DJANGO_ROUTES:
            continue
        candidates = [
            *node.args,
            *(k.value for k in node.keywords if k.arg in ("view_func", "endpoint", "view")),
        ]
        for candidate in candidates:
            target = dotted(candidate)
            if target:
                module.registered_routes.append(canonical(target, module.imports))
