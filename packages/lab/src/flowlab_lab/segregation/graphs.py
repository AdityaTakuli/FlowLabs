"""Stage 2 — Import, call and dataflow graphs (SEG-027 … SEG-029, SEG-068 dead code)."""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from .models import Confidence, min_confidence
from .parse import BUILTINS, CallSite, ModuleInfo, UnitInfo

EXECUTABLE = frozenset({"cell_block", "module_script", "config_block"})


@dataclass
class UnitEdge:
    source: str
    target: str
    kind: Literal["call", "dataflow"]
    via: set[str] = field(default_factory=set)
    lines: set[int] = field(default_factory=set)
    observed: bool = False
    confidence: Confidence = "high"


@dataclass
class ProjectGraph:
    units: dict[str, UnitInfo]
    tests: dict[str, UnitInfo]
    modules: dict[str, ModuleInfo]
    edges: dict[tuple[str, str, str], UnitEdge] = field(default_factory=dict)
    import_edges: set[tuple[str, str]] = field(default_factory=set)
    resolved: dict[str, list[tuple[CallSite, str]]] = field(default_factory=dict)
    unresolved: dict[str, set[str]] = field(default_factory=dict)
    test_map: dict[str, list[str]] = field(default_factory=dict)
    dead: set[str] = field(default_factory=set)
    traced: bool = False

    def add_edge(
        self, source: str, target: str, kind: Literal["call", "dataflow"], via: str, line: int | None = None
    ) -> None:
        if source == target:
            return
        edge = self.edges.setdefault((source, target, kind), UnitEdge(source, target, kind))
        edge.via.add(via)
        if line is not None:
            edge.lines.add(line)

    def incoming(self, uid: str) -> set[str]:
        return {e.source for e in self.edges.values() if e.target == uid}


def build_graph(root: Path, modules: list[ModuleInfo], infos: list[UnitInfo]) -> ProjectGraph:
    graph = ProjectGraph(
        units={i.unit.id: i for i in infos if not i.is_test},
        tests={i.unit.id: i for i in infos if i.is_test},
        modules={m.module: m for m in modules},
    )
    table: dict[str, str] = {}
    local: dict[str, dict[str, str]] = defaultdict(dict)
    methods: dict[str, dict[str, str]] = defaultdict(dict)
    for info in infos:
        unit = info.unit
        table.setdefault(unit.qualified_name, unit.id)
        if unit.kind in ("function", "route_handler", "class"):
            local[info.module].setdefault(unit.name, unit.id)
        if unit.kind == "method" and info.class_name:
            methods[info.class_name].setdefault(unit.name, unit.id)
    project_roots = {m.module.split(".")[0] for m in modules if m.module}

    def resolve(info: UnitInfo, call: CallSite) -> str | None:
        name = call.name.replace("().", ".")
        if name in table:  # 1. exact qualified name
            return table[name]
        head, _, rest = name.partition(".")
        if not rest and head in local.get(info.module, {}):  # 2. module-local name
            return local[info.module][head]
        if head in ("self", "cls") and info.class_name and rest in methods.get(info.class_name, {}):
            return methods[info.class_name][rest]
        prefix, _, last = name.rpartition(".")
        for owner in (prefix, f"{info.module}.{prefix}"):
            if owner in methods and last in methods[owner]:  # 3. imported alias → Class.method
                return methods[owner][last]
        return None

    for info in infos:
        uid = info.unit.id
        resolutions: list[tuple[CallSite, str]] = []
        for call in info.call_sites:
            target = resolve(info, call)
            if target is None:
                head, _, rest = call.name.partition(".")
                project_looking = head in project_roots and head not in info.stores
                bare_unknown = not rest and head not in BUILTINS and head not in info.stores
                if project_looking or bare_unknown:
                    graph.unresolved.setdefault(uid, set()).add(call.name)  # SEG-028: no edge
                continue
            resolutions.append((call, target))
            if info.is_test:
                graph.test_map.setdefault(target, []).append(info.unit.qualified_name)
            elif target in graph.units:
                graph.add_edge(uid, target, "call", f"{uid}→{target}", call.line)
        graph.resolved[uid] = resolutions
        if info.is_test:
            continue
        produced: dict[str, str] = {}  # variable → unit that produced it (returns feeding params)
        for call, target in resolutions:
            for arg in call.args:
                source = produced.get(arg)
                if source and source != target and source in graph.units and target in graph.units:
                    graph.add_edge(source, target, "dataflow", arg, call.line)
            for variable in call.targets:
                produced[variable] = target
    _type_references(graph, table, local)
    _module_dataflow(graph)
    _imports(graph)
    _routes(graph, table)
    _trace(graph, root)
    for uid in graph.unresolved:
        uncertain = graph.units.get(uid)
        if uncertain is not None:
            uncertain.unit.confidence = min_confidence(uncertain.unit.confidence, "medium")
    for target, names in graph.test_map.items():
        if target in graph.units:
            graph.units[target].unit.tests = sorted(set(names))
    graph.dead = _dead(graph)
    return graph


def _module_dataflow(graph: ProjectGraph) -> None:
    """Shared data objects: names defined by executable units and read by later units (notebooks, scripts)."""
    by_module: dict[str, list[UnitInfo]] = defaultdict(list)
    for info in graph.units.values():
        by_module[info.module].append(info)
    definers: dict[str, dict[str, list[tuple[int, str]]]] = defaultdict(lambda: defaultdict(list))
    for module, infos in by_module.items():
        for info in sorted(infos, key=lambda i: i.unit.line_start):
            if info.unit.kind in EXECUTABLE:
                for name in info.unit.defines:
                    definers[module][name].append((info.unit.line_start, info.unit.id))
    for module, infos in by_module.items():
        imports = graph.modules[module].imports if module in graph.modules else {}
        for info in infos:
            for name in info.unit.uses:
                candidates = definers[module].get(name, [])
                if info.unit.kind in EXECUTABLE:
                    candidates = [c for c in candidates if c[0] < info.unit.line_start]
                if not candidates and name in imports:
                    owner, _, attr = imports[name].rpartition(".")
                    candidates = definers.get(owner, {}).get(attr, [])
                if candidates:
                    graph.add_edge(candidates[-1][1], info.unit.id, "dataflow", name)


def _imports(graph: ProjectGraph) -> None:
    names = sorted(graph.modules, key=len, reverse=True)
    for module in graph.modules.values():
        for target in module.imported:
            match = next((m for m in names if m and (target == m or target.startswith(m + "."))), None)
            if match and match != module.module:
                graph.import_edges.add((module.module, match))


def _routes(graph: ProjectGraph, table: dict[str, str]) -> None:
    for module in graph.modules.values():
        for name in module.registered_routes:
            uid = table.get(name) or table.get(f"{module.module}.{name}")
            info = graph.units.get(uid) if uid else None
            if info is not None and info.unit.kind == "function":
                info.unit.kind = "route_handler"
                info.unit.entry_point = True


def _trace(graph: ProjectGraph, root: Path) -> None:
    """SEG-029: observed edges from the latest Code Mode repo trace beat inferred ones."""
    traces = sorted(
        p for p in (root / ".flowlab" / "traces").glob("trace_*.json") if not p.name.endswith(".graph.json")
    )
    if not traces:
        return
    try:
        data = json.loads(traces[-1].read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    spans: dict[str, list[tuple[int, int, str]]] = defaultdict(list)
    for info in graph.units.values():
        spans[info.unit.file].append((info.unit.line_start, info.unit.line_end, info.unit.id))

    def locate(site: object) -> str | None:
        if not (isinstance(site, list) and len(site) >= 2 and isinstance(site[1], int)):
            return None
        hits = [
            (end - start, uid) for start, end, uid in spans.get(str(site[0]), []) if start <= site[1] <= end
        ]
        return min(hits)[1] if hits else None

    observed_sources: set[str] = set()
    for entry in data.get("edges", []):
        source, target = locate(entry.get("from")), locate(entry.get("to"))
        if not source or not target or source == target:
            continue
        kind: Literal["call", "dataflow"] = "call" if entry.get("type") == "call" else "dataflow"
        graph.add_edge(source, target, kind, f"{source}→{target}")
        graph.edges[(source, target, kind)].observed = True
        observed_sources.add(source)
    if observed_sources:
        graph.traced = True
        for edge in graph.edges.values():
            if edge.source in observed_sources and not edge.observed:
                edge.confidence = "medium"


def _dead(graph: ProjectGraph) -> set[str]:
    """SEG-068: no callers, not an entry point, never referenced by name."""
    referenced: dict[str, set[str]] = defaultdict(set)
    for info in graph.units.values():
        for name in info.referenced | set(info.unit.uses) | {b.rsplit(".", 1)[-1] for b in info.bases}:
            referenced[name].add(info.atom)
    exported = {n for m in graph.modules.values() for n in m.all_names}
    imported = {target for m in graph.modules.values() for target in m.imports.values()}
    incoming: dict[str, set[str]] = defaultdict(set)
    for edge in graph.edges.values():
        incoming[edge.target].add(
            graph.units[edge.source].atom if edge.source in graph.units else edge.source
        )
    dead: set[str] = set()
    for uid, info in graph.units.items():
        unit = info.unit
        if unit.kind not in ("function", "class") or unit.entry_point or unit.decorators:
            continue
        if unit.name.startswith("__") or unit.name in exported or f"{info.module}.{unit.name}" in imported:
            continue
        if incoming[uid] - {info.atom}:
            continue
        if referenced.get(unit.name, set()) - {info.atom}:
            continue
        if unit.kind == "class":
            member_calls = any(
                incoming[m] - {info.atom}
                for m, other in graph.units.items()
                if other.atom == info.atom and m != uid
            )
            if member_calls:
                continue
        dead.add(uid)
    for uid, info in graph.units.items():  # methods of dead classes are dead with them
        if info.unit.kind == "method" and info.atom in dead:
            dead.add(uid)
    return dead


def _type_references(graph: ProjectGraph, table: dict[str, str], local: dict[str, dict[str, str]]) -> None:
    """A class named in another unit's signature or body is a dependency (e.g. a schema a handler accepts)."""
    for uid, info in graph.units.items():
        imports = graph.modules[info.module].imports if info.module in graph.modules else {}
        for name in info.unit.uses:
            target = local.get(info.module, {}).get(name) or (
                table.get(imports[name]) if name in imports else None
            )
            owner = graph.units.get(target) if target else None
            if owner is not None and owner.unit.kind == "class" and owner.atom != info.atom:
                graph.add_edge(owner.unit.id, uid, "dataflow", name)
