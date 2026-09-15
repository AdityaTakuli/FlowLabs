"""Per-block symbol analysis (PRD II 5.3).

Static and scope-aware, and deliberately conservative: when the analyser cannot be sure, it
records a flag that lowers confidence instead of guessing.
"""

from __future__ import annotations

import ast
import builtins
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

from .blocks import sanitize_ipython

Confidence = Literal["high", "medium", "low"]

BUILTIN_NAMES = frozenset(dir(builtins)) | {"display", "get_ipython", "In", "Out", "exit", "quit"}
MUTATING_METHODS = frozenset(
    {
        "append",
        "extend",
        "insert",
        "pop",
        "remove",
        "clear",
        "update",
        "sort",
        "reverse",
        "setdefault",
        "popitem",
        "add",
        "discard",
        "appendleft",
        "extendleft",
        "popleft",
        "difference_update",
        "intersection_update",
        "symmetric_difference_update",
        "fit",
        "partial_fit",
        "fit_transform",
        "set_params",
    }
)
TRIVIAL_DECORATORS = frozenset(
    {
        "property",
        "staticmethod",
        "classmethod",
        "dataclass",
        "dataclasses.dataclass",
        "functools.wraps",
        "functools.cache",
        "functools.lru_cache",
        "cache",
        "lru_cache",
    }
)
DYNAMIC_CALLS = frozenset(
    {
        "exec",
        "eval",
        "globals",
        "locals",
        "vars",
        "setattr",
        "delattr",
        "__import__",
        "importlib.import_module",
    }
)
WRITE_METHODS = frozenset(
    {
        "to_csv",
        "to_parquet",
        "to_excel",
        "to_json",
        "to_pickle",
        "to_feather",
        "to_sql",
        "to_hdf",
        "savefig",
        "write_text",
        "write_bytes",
        "write_csv",
        "write_parquet",
        "write",
    }
)
IO_CALLS = frozenset(
    {
        "open",
        "joblib.dump",
        "joblib.load",
        "pickle.dump",
        "pickle.load",
        "numpy.save",
        "numpy.load",
        "numpy.savetxt",
        "numpy.loadtxt",
        "os.remove",
        "os.makedirs",
        "shutil.copy",
        "shutil.rmtree",
    }
)
READ_PREFIXES = ("pandas.read_", "polars.read_", "polars.scan_")
NETWORK_PREFIXES = ("requests.", "urllib.", "httpx.", "socket.", "boto3.", "aiohttp.", "gdown.")
PLOT_PREFIXES = ("matplotlib.", "seaborn.", "plotly.", "altair.", "bokeh.")
PLOT_METHODS = frozenset({"plot", "hist", "boxplot", "show", "imshow", "scatter"})
RANDOM_PREFIXES = ("random.", "numpy.random.")
SEED_CALLS = frozenset(
    {
        "random.seed",
        "numpy.random.seed",
        "numpy.random.default_rng",
        "numpy.random.RandomState",
        "torch.manual_seed",
    }
)
ENVIRONMENT = frozenset({"os.getenv", "os.environ", "os.putenv", "dotenv.load_dotenv"})
DATAFRAME_METHODS = frozenset(
    {
        "copy",
        "dropna",
        "fillna",
        "drop",
        "merge",
        "join",
        "assign",
        "query",
        "rename",
        "sort_values",
        "reset_index",
        "set_index",
        "drop_duplicates",
        "astype",
        "head",
        "tail",
        "sample",
        "replace",
        "pivot_table",
        "melt",
        "explode",
        "filter",
        "select_dtypes",
    }
)
_COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)
_SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda, *_COMPREHENSIONS)


@dataclass(frozen=True)
class BlockSymbols:
    defines: tuple[str, ...] = ()
    uses: tuple[str, ...] = ()
    builtin_uses: tuple[str, ...] = ()
    mutates: tuple[str, ...] = ()
    deletes: tuple[str, ...] = ()
    imports: tuple[str, ...] = ()
    modules: tuple[str, ...] = ()
    calls: tuple[str, ...] = ()
    side_effects: tuple[str, ...] = ()
    conditional_defines: tuple[str, ...] = ()
    loop_carried: tuple[str, ...] = ()
    aliases: tuple[tuple[str, str], ...] = ()
    import_map: tuple[tuple[str, str], ...] = ()
    constructed: tuple[tuple[str, str], ...] = ()
    flags: tuple[str, ...] = ()
    parse_error: str | None = None
    parse_error_line: int | None = None

    @property
    def confidence(self) -> Confidence:
        if {"parse_error", "dynamic", "star_import", "opaque"} & set(self.flags):
            return "low"
        if (
            self.conditional_defines
            or self.mutates
            or self.aliases
            or {"decorator", "global_write"} & set(self.flags)
        ):
            return "medium"
        return "high"


def _root_name(node: ast.AST) -> str | None:
    while isinstance(node, ast.Attribute | ast.Subscript | ast.Starred):
        node = node.value
    return node.id if isinstance(node, ast.Name) else None


def _target_names(node: ast.AST) -> set[str]:
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}


def _scope_bindings(body: Iterable[ast.AST]) -> tuple[set[str], set[str]]:
    """Names bound directly in a scope (not in nested scopes), and names declared global."""
    stores: set[str] = set()
    declared: set[str] = set()
    stack = list(body)
    while stack:
        node = stack.pop()
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
            stores.add(node.name)
            stack.extend(node.decorator_list)
            continue
        if isinstance(node, (ast.Lambda, *_COMPREHENSIONS)):
            continue
        if isinstance(node, ast.Global | ast.Nonlocal):
            declared.update(node.names)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store | ast.Del):
            stores.add(node.id)
        elif isinstance(node, ast.Import | ast.ImportFrom):
            stores.update((a.asname or a.name.split(".")[0]) for a in node.names if a.name != "*")
        elif (
            isinstance(node, ast.ExceptHandler)
            and node.name
            or isinstance(node, ast.MatchAs | ast.MatchStar)
            and node.name
        ):
            stores.add(node.name)
        stack.extend(ast.iter_child_nodes(node))
    return stores - declared, declared


class _Scope:
    def __init__(self, kind: str, local_names: Iterable[str], declared: Iterable[str] = ()) -> None:
        self.kind = kind
        self.locals = set(local_names)
        self.declared = set(declared)


class _Analyzer(ast.NodeVisitor):
    def __init__(self, aliases: Mapping[str, str], types: Mapping[str, str], block_names: set[str]) -> None:
        self.aliases = dict(aliases)
        self.types = dict(types)
        self.block_names = block_names
        self.out: dict[str, dict[str, None]] = {
            k: {}
            for k in (
                "defines",
                "uses",
                "builtin_uses",
                "mutates",
                "deletes",
                "imports",
                "modules",
                "calls",
                "effects",
                "conditional",
                "loop_carried",
                "flags",
            )
        }
        self.alias_pairs: list[tuple[str, str]] = []
        self.alias_of: dict[str, str] = {}
        self.import_map: dict[str, str] = {}
        self.constructed: dict[str, str] = {}
        self.bound: set[str] = set()
        self.maybe: set[str] = set()
        self.cond_depth = 0
        self.loops: list[tuple[set[str], set[str]]] = []
        self.scopes: list[_Scope] = []
        self.seeded = False
        self.random_used = False

    def _add(self, key: str, value: str) -> None:
        self.out[key].setdefault(value, None)

    # -------------------------------------------------------------------------- names
    def _load(self, name: str) -> None:
        if not self.scopes and self.loops:
            self.loops[-1][1].add(name)
        for scope in reversed(self.scopes):
            if name in scope.locals:
                return
        if self.scopes:
            declared_global = any(name in scope.declared for scope in self.scopes)
            if name in self.block_names and not (declared_global and name not in self.bound):
                return
        elif name in self.bound or name in self.maybe:
            return
        self._add("builtin_uses" if name in BUILTIN_NAMES else "uses", name)

    def _block_store(self, name: str, conditional: bool) -> None:
        self._add("defines", name)
        if self.loops:
            self.loops[-1][0].add(name)
        if conditional and name not in self.bound:
            self._add("conditional", name)
            self.maybe.add(name)
        elif not conditional:
            self.bound.add(name)
            self.out["conditional"].pop(name, None)

    def _store(self, name: str) -> None:
        if self.scopes:
            scope = self.scopes[-1]
            if scope.kind == "function" and name in scope.declared:
                self._add("flags", "global_write")
                self._block_store(name, conditional=True)
            return
        self._block_store(name, conditional=self.cond_depth > 0)

    def _mutate(self, name: str) -> None:
        if name in self.aliases:
            return
        for scope in reversed(self.scopes):
            if name in scope.locals:
                return
        if not self.scopes and name in self.bound:
            source = self.alias_of.get(name)  # `b = a; b[...] = x` mutates the outer `a`
            if source is None or source in self.bound:
                return
            name = source
        self._add("mutates", name)

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Load):
            self._load(node.id)
        elif isinstance(node.ctx, ast.Store):
            self._store(node.id)
        elif not self.scopes:
            if node.id not in self.bound and node.id not in self.maybe:
                self._add("uses", node.id)  # deleting an outer name depends on its definer
            self._add("deletes", node.id)
            self.bound.discard(node.id)

    def _target(self, node: ast.AST) -> None:
        if isinstance(node, ast.Name):
            self._store(node.id)
        elif isinstance(node, ast.Tuple | ast.List):
            for element in node.elts:
                self._target(element)
        elif isinstance(node, ast.Starred):
            self._target(node.value)
        elif isinstance(node, ast.Attribute | ast.Subscript):
            self.visit(node.value)
            if isinstance(node, ast.Subscript):
                self.visit(node.slice)
            root = _root_name(node)
            if root:
                self._mutate(root)

    # -------------------------------------------------------------------- statements
    def visit_Assign(self, node: ast.Assign) -> None:
        self.visit(node.value)
        if not self.scopes and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            target = node.targets[0].id
            self.alias_of.pop(target, None)
            if isinstance(node.value, ast.Name):
                self.alias_pairs.append((target, node.value.id))
                self.alias_of[target] = node.value.id
            elif isinstance(node.value, ast.Call):
                produced = self._returns(self._qualify(node.value.func))
                if produced:
                    self.constructed[target] = produced
                    self.types[target] = produced
        for assigned in node.targets:
            self._target(assigned)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        self.visit(node.value)
        if isinstance(node.target, ast.Name):
            self._load(node.target.id)
            self._store(node.target.id)
        else:
            self._target(node.target)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if node.value is not None:
            self.visit(node.value)
            self._target(node.target)

    def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
        self.visit(node.value)
        name = node.target.id
        for scope in reversed(self.scopes):
            if scope.kind != "comprehension":
                scope.locals.add(name)
                return
        self._block_store(name, conditional=self.cond_depth > 0)

    def _conditional_body(self, *bodies: Iterable[ast.AST]) -> None:
        self.cond_depth += 1
        for body in bodies:
            for stmt in body:
                self.visit(stmt)
        self.cond_depth -= 1

    def _loop(self, target: ast.AST | None, bodies: tuple[Iterable[ast.AST], ...]) -> None:
        self.cond_depth += 1
        if not self.scopes:
            self.loops.append((set(), set()))
        if target is not None:
            self._target(target)
        for body in bodies:
            for stmt in body:
                self.visit(stmt)
        if not self.scopes:
            stores, loads = self.loops.pop()
            loop_variables = _target_names(target) if target is not None else set()
            for name in sorted((stores & loads) - loop_variables):
                self._add("loop_carried", name)
            if self.loops:
                self.loops[-1][0].update(stores)
                self.loops[-1][1].update(loads)
        self.cond_depth -= 1

    def visit_For(self, node: ast.For | ast.AsyncFor) -> None:
        self.visit(node.iter)
        self._loop(node.target, (node.body, node.orelse))

    visit_AsyncFor = visit_For

    def visit_While(self, node: ast.While) -> None:
        self.visit(node.test)
        self._loop(None, (node.body, node.orelse))

    def visit_If(self, node: ast.If) -> None:
        self.visit(node.test)
        self._conditional_body(node.body, node.orelse)

    def visit_Try(self, node: ast.Try) -> None:
        self._conditional_body(node.body, node.orelse)
        for handler in node.handlers:
            self.cond_depth += 1
            if handler.type is not None:
                self.visit(handler.type)
            if handler.name:
                self._store(handler.name)
            for stmt in handler.body:
                self.visit(stmt)
            self.cond_depth -= 1
        for stmt in node.finalbody:
            self.visit(stmt)

    visit_TryStar = visit_Try  # type: ignore[assignment]

    def visit_With(self, node: ast.With | ast.AsyncWith) -> None:
        for item in node.items:
            self.visit(item.context_expr)
            if item.optional_vars is not None:
                self._target(item.optional_vars)
        for stmt in node.body:
            self.visit(stmt)

    visit_AsyncWith = visit_With

    def visit_Match(self, node: ast.Match) -> None:
        self.visit(node.subject)
        for case in node.cases:
            self.cond_depth += 1
            for sub in ast.walk(case.pattern):
                if isinstance(sub, ast.MatchAs | ast.MatchStar) and sub.name:
                    self._store(sub.name)
                elif isinstance(sub, ast.MatchValue):
                    self.visit(sub.value)
            if case.guard is not None:
                self.visit(case.guard)
            for stmt in case.body:
                self.visit(stmt)
            self.cond_depth -= 1

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            local = alias.asname or alias.name.split(".")[0]
            target = alias.name if alias.asname else alias.name.split(".")[0]
            self._record_import(local, target, alias.name)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = "." * node.level + (node.module or "")
        for alias in node.names:
            if alias.name == "*":
                self._add("flags", "star_import")
                self._add("modules", module)
                continue
            self._record_import(alias.asname or alias.name, f"{module}.{alias.name}", module)

    def _record_import(self, local: str, qualified: str, module: str) -> None:
        self.aliases[local] = qualified
        self.import_map[local] = qualified
        self._add("imports", local)
        self._add("modules", module)
        self._store(local)

    def visit_Delete(self, node: ast.Delete) -> None:
        for target in node.targets:
            if isinstance(target, ast.Name):
                self.visit(target)
            else:
                self._target(target)

    # ------------------------------------------------------------------------ scopes
    def _function(self, node: ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda) -> None:
        args = node.args
        for default in [*args.defaults, *args.kw_defaults]:
            if default is not None:
                self.visit(default)
        params = {a.arg for a in [*args.posonlyargs, *args.args, *args.kwonlyargs]}
        params |= {a.arg for a in (args.vararg, args.kwarg) if a is not None}
        if isinstance(node, ast.Lambda):
            self.scopes.append(_Scope("function", params))
            self.visit(node.body)
            self.scopes.pop()
            return
        for decorator in node.decorator_list:
            self.visit(decorator)
            name = self._qualify(decorator.func if isinstance(decorator, ast.Call) else decorator)
            if name not in TRIVIAL_DECORATORS:
                self._add("flags", "decorator")
        self._store(node.name)
        stores, declared = _scope_bindings(node.body)
        self.scopes.append(_Scope("function", params | stores, declared))
        for stmt in node.body:
            self.visit(stmt)
        self.scopes.pop()

    visit_FunctionDef = _function
    visit_AsyncFunctionDef = _function
    visit_Lambda = _function

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        for expr in [*node.decorator_list, *node.bases, *(k.value for k in node.keywords)]:
            self.visit(expr)
        if node.decorator_list:
            self._add("flags", "decorator")
        self._store(node.name)
        stores, _ = _scope_bindings(node.body)
        self.scopes.append(_Scope("class", stores))
        for stmt in node.body:
            self.visit(stmt)
        self.scopes.pop()

    def _comprehension(self, node: ast.ListComp | ast.SetComp | ast.DictComp | ast.GeneratorExp) -> None:
        generators = node.generators
        self.visit(generators[0].iter)
        targets: set[str] = set()
        for generator in generators:
            targets |= _target_names(generator.target)
        self.scopes.append(_Scope("comprehension", targets))
        for index, generator in enumerate(generators):
            if index:
                self.visit(generator.iter)
            for condition in generator.ifs:
                self.visit(condition)
        elements = [node.key, node.value] if isinstance(node, ast.DictComp) else [node.elt]
        for element in elements:
            self.visit(element)
        self.scopes.pop()

    visit_ListComp = _comprehension
    visit_SetComp = _comprehension
    visit_DictComp = _comprehension
    visit_GeneratorExp = _comprehension

    # ------------------------------------------------------------------------- calls
    def _qualify(self, node: ast.AST) -> str | None:
        parts: list[str] = []
        while isinstance(node, ast.Attribute):
            parts.append(node.attr)
            node = node.value
        parts.reverse()
        if isinstance(node, ast.Name):
            base = self.aliases.get(node.id) or self.types.get(node.id)
            if base:
                return ".".join([base, *parts])
            return ".".join(["?", *parts]) if parts else node.id
        if isinstance(node, ast.Call):
            inner = self._qualify(node.func) or "?"
            return ".".join([f"{inner}()", *parts]) if parts else None
        return ".".join(["?", *parts]) if parts else None

    @staticmethod
    def _returns(qualified: str | None) -> str | None:
        if not qualified or qualified.startswith("?"):
            return None
        if qualified.startswith(READ_PREFIXES) or qualified in (
            "pandas.DataFrame",
            "pandas.concat",
            "pandas.merge",
        ):
            return "pandas.DataFrame"
        if qualified.startswith("pandas.DataFrame.") and qualified.rsplit(".", 1)[-1] in DATAFRAME_METHODS:
            return "pandas.DataFrame"
        last = qualified.rsplit(".", 1)[-1]
        if "." in qualified and last[:1].isupper() and "()" not in qualified:
            return qualified
        return None

    def visit_Call(self, node: ast.Call) -> None:
        qualified = self._qualify(node.func)
        if qualified:
            self._add("calls", qualified)
            self._classify(qualified, node)
        self.generic_visit(node)
        if isinstance(node.func, ast.Attribute):
            inplace = any(
                k.arg == "inplace" and isinstance(k.value, ast.Constant) and k.value.value is True
                for k in node.keywords
            )
            root = _root_name(node.func.value)
            if root and (node.func.attr in MUTATING_METHODS or inplace):
                self._mutate(root)

    def _classify(self, qualified: str, node: ast.Call) -> None:
        last = qualified.rsplit(".", 1)[-1]
        if qualified in ("print", "display", "pprint.pprint", "IPython.display.display"):
            self._add("effects", "print")
        if qualified in IO_CALLS or last in WRITE_METHODS or qualified.startswith(READ_PREFIXES):
            self._add("effects", "file_io")
        if qualified.startswith(NETWORK_PREFIXES):
            self._add("effects", "network")
        if qualified.startswith(PLOT_PREFIXES) or last in PLOT_METHODS:
            self._add("effects", "plotting")
        if qualified in SEED_CALLS or any(k.arg in ("random_state", "seed") for k in node.keywords):
            self.seeded = True
        elif qualified.startswith(RANDOM_PREFIXES):
            self.random_used = True
        if qualified in ENVIRONMENT:
            self._add("effects", "environment")
        if qualified in DYNAMIC_CALLS or (qualified == "getattr" and not self._constant_attr(node)):
            self._add("flags", "dynamic")

    @staticmethod
    def _constant_attr(node: ast.Call) -> bool:
        return len(node.args) >= 2 and isinstance(node.args[1], ast.Constant)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if isinstance(node.ctx, ast.Load) and self._qualify(node) in ENVIRONMENT:
            self._add("effects", "environment")
        self.generic_visit(node)

    def result(self) -> BlockSymbols:
        if self.random_used and not self.seeded:
            self._add("effects", "random_unseeded")
        o = self.out
        return BlockSymbols(
            defines=tuple(o["defines"]),
            uses=tuple(o["uses"]),
            builtin_uses=tuple(o["builtin_uses"]),
            mutates=tuple(o["mutates"]),
            deletes=tuple(o["deletes"]),
            imports=tuple(o["imports"]),
            modules=tuple(o["modules"]),
            calls=tuple(o["calls"]),
            side_effects=tuple(o["effects"]),
            conditional_defines=tuple(o["conditional"]),
            loop_carried=tuple(o["loop_carried"]),
            aliases=tuple(self.alias_pairs),
            import_map=tuple(self.import_map.items()),
            constructed=tuple(self.constructed.items()),
            flags=tuple(o["flags"]),
        )


def _block_level_names(tree: ast.Module) -> set[str]:
    stores, _ = _scope_bindings(tree.body)
    for node in ast.walk(tree):
        if isinstance(node, ast.Global):
            stores.update(node.names)
    return stores


@lru_cache(maxsize=4096)
def _analyse_cached(
    source: str, aliases: tuple[tuple[str, str], ...], types: tuple[tuple[str, str], ...], notebook: bool
) -> BlockSymbols:
    code, had_magic = sanitize_ipython(source) if notebook else (source, False)
    if notebook and had_magic and code.startswith("pass\n# "):
        return BlockSymbols(side_effects=("magic",), flags=("opaque",))
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        return BlockSymbols(flags=("parse_error",), parse_error=exc.msg, parse_error_line=exc.lineno)
    analyzer = _Analyzer(dict(aliases), dict(types), _block_level_names(tree))
    for stmt in tree.body:
        analyzer.visit(stmt)
    if had_magic:
        analyzer._add("effects", "magic")
    if tree.body and all(
        isinstance(s, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef) for s in tree.body
    ):
        analyzer._add("flags", "definition")
    return analyzer.result()


def analyse_block(
    source: str,
    *,
    aliases: Mapping[str, str] | None = None,
    types: Mapping[str, str] | None = None,
    notebook: bool = False,
) -> BlockSymbols:
    """Analyse one block. ``aliases``/``types`` carry imports and known object types from earlier blocks."""
    return _analyse_cached(
        source, tuple(sorted((aliases or {}).items())), tuple(sorted((types or {}).items())), notebook
    )
