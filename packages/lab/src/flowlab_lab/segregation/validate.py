"""Stage 7 — Validation (SEG-096) and findings (Section 4)."""

from __future__ import annotations

from collections import Counter, defaultdict
from itertools import pairwise
from pathlib import Path

import networkx as nx  # type: ignore[import-untyped]

from .graphs import ProjectGraph
from .models import ARCHETYPES, BANNED_NAMES, UNASSIGNED, Component, Finding, Manifest
from .rules import layer_problem

MAX_LITERALS = 40


def structural_violations(manifest: Manifest) -> list[str]:
    """Hard assertions. Any violation means the output must not be shipped as-is."""
    problems: list[str] = []
    placements: Counter[str] = Counter()
    for component in manifest.components:
        if not component.units:
            problems.append(f"SEG-016: {component.id} has no members")
        placements.update(component.units)
        if component.name.strip().lower() in BANNED_NAMES:
            problems.append(f"SEG-062: {component.id} uses banned name {component.name!r}")
        if component.archetype not in ARCHETYPES:
            problems.append(f"SEG-091: {component.id} has unknown archetype {component.archetype!r}")
    placements.update(manifest.unassigned)
    unit_ids = {u.id for u in manifest.units}
    for uid in unit_ids:
        if placements[uid] != 1:
            problems.append(f"SEG-066: {uid} is placed {placements[uid]} times")
    for uid in placements:
        if uid not in unit_ids:
            problems.append(f"SEG-036: {uid} is not a known unit")
    names = Counter(c.name.strip().lower() for c in manifest.components)
    problems.extend(
        f"SEG-065: component name {name!r} is used {count} times"
        for name, count in names.items()
        if count > 1
    )
    loc = {f.path: f.loc for f in manifest.files}
    for unit in manifest.units:
        if unit.file not in loc or not (1 <= unit.line_start <= unit.line_end <= max(loc[unit.file], 1)):
            problems.append(
                f"SEG-004: {unit.id} has an invalid span {unit.file}:{unit.line_start}-{unit.line_end}"
            )
    return problems


def _where(graph: ProjectGraph, uid: str, line: int | None = None) -> str:
    unit = graph.units[uid].unit
    return f"{unit.file}:{line or unit.line_start}"


def leakage_findings(graph: ProjectGraph, component_of: dict[str, str]) -> list[Finding]:
    """SEG-053: a transformer fitted before the train/test split, in execution order."""
    findings: dict[tuple[str, int], Finding] = {}

    def report(fit_uid: str, fit_line: int, detail: str, split_uid: str, split_line: int) -> None:
        key = (fit_uid, fit_line)
        if key in findings:
            return
        findings[key] = Finding(
            code="LEAKAGE_FIT_BEFORE_SPLIT",
            severity="error",
            law="SEG-053",
            component_id=component_of.get(fit_uid),
            unit_id=fit_uid,
            file=graph.units[fit_uid].unit.file,
            line=fit_line,
            message=f"{detail} is fitted at {_where(graph, fit_uid, fit_line)}, "
            "upstream of the train/test split at "
            f"{_where(graph, split_uid, split_line)}.",
        )

    # 1. within one unit, and across the cells / scripts of one file, in line order
    sequences: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for uid, info in graph.units.items():
        if info.unit.kind in ("cell_block", "module_script"):
            sequences[info.unit.file].append((info.unit.line_start, uid))
        else:
            sequences[uid].append((info.unit.line_start, uid))
    for members in sequences.values():
        events = [
            (e.line, e.kind, e.detail, uid) for _, uid in sorted(members) for e in graph.units[uid].events
        ]
        splits = [e for e in events if e[1] == "split"]
        if not splits:
            continue
        first_split = min(splits)
        for line, kind, detail, uid in events:
            if (
                kind == "transformer_fit"
                and (line, uid) < (first_split[0], first_split[3])
                and line < first_split[0]
            ):
                report(uid, line, detail, first_split[3], first_split[0])

    # 2. across functions: an orchestrating unit calls a fitting unit before a splitting unit
    memo: dict[tuple[str, str], tuple[str, int, str] | None] = {}

    def first(uid: str, kind: str, stack: frozenset[str] = frozenset()) -> tuple[str, int, str] | None:
        key = (uid, kind)
        if key in memo:
            return memo[key]
        if uid in stack:
            return None
        info = graph.units.get(uid)
        result: tuple[str, int, str] | None = None
        if info is not None:
            steps: list[tuple[int, int, str, int, str]] = [
                (e.line, 0, uid, e.line, e.detail) for e in info.events if e.kind == kind
            ]
            steps += [
                (call.line, 1, target, 0, "")
                for call, target in graph.resolved.get(uid, [])
                if target in graph.units
            ]
            for _, order, item, line, detail in sorted(steps, key=lambda s: (s[0], s[1])):
                if order == 0:
                    result = (item, line, detail)
                    break
                found = first(item, kind, stack | {uid})
                if found:
                    result = found
                    break
        memo[key] = result
        return result

    for uid in graph.units:
        calls = [(call.line, target) for call, target in graph.resolved.get(uid, []) if target in graph.units]
        if len(calls) < 2:
            continue
        split_at: tuple[int, tuple[str, int, str]] | None = None
        for line, target in calls:
            found = first(target, "split")
            if found:
                split_at = (line, found)
                break
        if not split_at:
            continue
        for line, target in calls:
            if line >= split_at[0]:
                break
            fit = first(target, "transformer_fit")
            if fit:
                report(fit[0], fit[1], fit[2], split_at[1][0], split_at[1][1])
    return list(findings.values())


def compute_findings(
    graph: ProjectGraph, components: list[Component], unassigned: list[str], parse_errors: dict[str, str]
) -> list[Finding]:
    component_of = {uid: c.id for c in components for uid in c.units}
    by_id = {c.id: c for c in components}
    findings = leakage_findings(graph, component_of)

    for uid, info in sorted(graph.units.items()):
        kinds = {e.kind for e in info.events}
        unit = info.unit
        if {"model_fit", "metric"} <= kinds:
            findings.append(
                Finding(
                    code="TRAINING_EVALUATION_MIXED",
                    severity="warning",
                    law="SEG-054",
                    unit_id=uid,
                    component_id=component_of.get(uid),
                    file=unit.file,
                    line=unit.line_start,
                    message=f"{unit.name} fits a model and computes metrics in the same unit "
                    f"({unit.file}:{unit.line_start}).",
                )
            )
        if "plot" in kinds and kinds & {"transformer_fit", "model_fit"}:
            findings.append(
                Finding(
                    code="PLOTTING_IN_TRANSFORMATION",
                    severity="warning",
                    law="SEG-058",
                    unit_id=uid,
                    component_id=component_of.get(uid),
                    file=unit.file,
                    line=unit.line_start,
                    message=f"{unit.name} mixes plotting with fitting or transformation, "
                    "which makes it hard to test.",
                )
            )
        if unit.kind == "route_handler":
            outgoing = {e.target for e in graph.edges.values() if e.source == uid and e.kind == "call"}
            if unit.sloc > 20 or len(outgoing) > 3:
                findings.append(
                    Finding(
                        code="ROUTE_HANDLER_LOGIC",
                        severity="warning",
                        law="SEG-060",
                        unit_id=uid,
                        component_id=component_of.get(uid),
                        file=unit.file,
                        line=unit.line_start,
                        message=f"Route handler {unit.name} has {unit.sloc} SLOC "
                        f"and calls {len(outgoing)} units; "
                        "move business logic into a service.",
                    )
                )

    literals = [
        f"{key}={value} at {info.unit.file}:{line}"
        for uid, info in sorted(graph.units.items())
        if info.unit.kind != "config_block" and by_id.get(component_of.get(uid, "")) is not None
        and by_id[component_of[uid]].archetype != "configuration"
        for line, key, value in info.literals
    ]  # fmt: skip
    if literals:
        shown = literals[:MAX_LITERALS]
        more = f" (+{len(literals) - len(shown)} more)" if len(literals) > len(shown) else ""
        findings.append(
            Finding(
                code="INLINE_CONFIGURATION",
                severity="warning",
                law="SEG-056",
                message=f"{len(literals)} hyperparameters, paths or thresholds are hard-coded: "
                + "; ".join(shown)
                + more,
            )
        )

    cells: dict[str, list[str]] = defaultdict(list)
    for uid, info in graph.units.items():
        if info.unit.kind == "cell_block" and info.unit.file.endswith(".ipynb"):
            cells[info.unit.file].append(uid)
    for file, members in sorted(cells.items()):
        homes = {component_of.get(m) for m in members} - {None}
        if len(members) >= 10 and len(homes) == 1:
            findings.append(
                Finding(
                    code="NOTEBOOK_SINGLE_COMPONENT",
                    severity="warning",
                    law="SEG-057",
                    file=file,
                    component_id=next(iter(homes)),
                    message=f"All {len(members)} cells of {file} landed in one component; "
                    "the notebook has no separable sections.",
                )
            )

    # component dependency graph: cycles (SEG-045) and layers (SEG-046 / SEG-061)
    via: dict[tuple[str, str], list[str]] = defaultdict(list)
    for edge in graph.edges.values():
        a, b = component_of.get(edge.source), component_of.get(edge.target)
        if not a or not b or a == b:
            continue
        dependent, dependency = (a, b) if edge.kind == "call" else (b, a)
        via[(dependent, dependency)].append(f"{edge.source}→{edge.target}")
    digraph = nx.DiGraph()
    digraph.add_nodes_from(sorted(by_id))
    digraph.add_edges_from(sorted(via))
    for cycle in sorted(sorted(c) for c in nx.strongly_connected_components(digraph) if len(c) > 1):
        edges = sorted(e for (a, b), items in via.items() if a in cycle and b in cycle for e in items)[:12]
        names = ", ".join(by_id[c].name for c in cycle)
        findings.append(
            Finding(
                code="COMPONENT_CYCLE",
                severity="error",
                law="SEG-045",
                component_id=cycle[0],
                unit_ids=sorted({e.split("→")[0] for e in edges}),
                message=f"Components depend on each other in a cycle ({names}) through {', '.join(edges)}.",
            )
        )
    for (dependent, dependency), items in sorted(via.items()):
        confident = "low" not in (
            by_id[dependent].archetype_confidence,
            by_id[dependency].archetype_confidence,
        )
        problem = (
            layer_problem(by_id[dependent].archetype, by_id[dependency].archetype) if confident else None
        )
        if problem:
            law = (
                "SEG-061"
                if (by_id[dependent].archetype, by_id[dependency].archetype) == ("repository", "service")
                else "SEG-046"
            )
            findings.append(
                Finding(
                    code="LAYER_VIOLATION",
                    severity="error",
                    law=law,
                    component_id=dependent,
                    unit_ids=sorted({i.split("→")[0] for i in items}),
                    message=f"{by_id[dependent].name} ({by_id[dependent].archetype}) depends on "
                    f"{by_id[dependency].name} ({by_id[dependency].archetype}): {problem}. "
                    f"Via {', '.join(sorted(items)[:6])}.",
                )
            )

    total_units = len(graph.units)
    for component in components:
        size = len(component.units)
        if size > 30 or component.sloc > 1500:
            findings.append(
                Finding(
                    code="GOD_COMPONENT",
                    severity="warning",
                    law="SEG-041",
                    component_id=component.id,
                    message=f"{size} units, {component.sloc:,} SLOC. Exceeds size bounds.",
                )
            )
        member_ids = set(component.units)
        if size >= 3 and total_units > size:
            internal = sum(
                1 for e in graph.edges.values() if e.source in member_ids and e.target in member_ids
            )
            external = sum(
                1 for e in graph.edges.values() if (e.source in member_ids) != (e.target in member_ids)
            )
            internal_density = internal / (size * (size - 1) / 2)
            external_density = external / (size * (total_units - size))
            if internal_density <= external_density:
                findings.append(
                    Finding(
                        code="LOW_COHESION",
                        severity="warning",
                        law="SEG-042",
                        component_id=component.id,
                        message=f"{component.name} members call outsiders ({external}) "
                        f"at least as densely as each other ({internal}).",
                    )
                )
        if len(component.depends_on) > 5:
            findings.append(
                Finding(
                    code="HIGH_COUPLING",
                    severity="warning" if len(component.depends_on) > 7 else "info",
                    law="SEG-043",
                    component_id=component.id,
                    message=f"{component.name} depends on {len(component.depends_on)} components.",
                )
            )
        if component.archetype == "utility":
            dependents = sum(1 for c in components if component.id in c.depends_on)
            if dependents < 3:
                findings.append(
                    Finding(
                        code="UTILITY_UNJUSTIFIED",
                        severity="warning",
                        law="SEG-092",
                        component_id=component.id,
                        message=f"{component.name} is a utility used by {dependents} components; "
                        "merge it into its caller.",
                    )
                )

    by_directory: dict[str, Counter[str]] = defaultdict(Counter)
    for uid, info in graph.units.items():
        if uid in component_of:
            by_directory[str(Path(info.unit.file).parent)][component_of[uid]] += 1
    for directory, counts in sorted(by_directory.items()):
        total = sum(counts.values())
        if total >= 4 and len(counts) >= 2:
            ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
            if ranked[1][1] / total >= 0.3:
                spread = ", ".join(f"{by_id[c].name} ({n})" for c, n in ranked[:3])
                findings.append(
                    Finding(
                        code="DIRECTORY_DRIFT",
                        severity="info",
                        law="SEG-047",
                        file=directory,
                        message=f"Units in {directory}/ are split across {spread}: "
                        "the call graph disagrees with the folder layout.",
                    )
                )

    dead = sorted(uid for uid in unassigned if uid in graph.dead)
    if dead:
        tested = [uid for uid in dead if graph.units[uid].unit.tests]
        note = f" {len(tested)} of them are called only from tests." if tested else ""
        findings.append(
            Finding(
                code="DEAD_CODE",
                severity="info",
                law="SEG-068",
                unit_ids=dead,
                message=f"{len(dead)} unit(s) have no callers and are not entry points: "
                + ", ".join(graph.units[u].unit.qualified_name for u in dead[:10])
                + ("…" if len(dead) > 10 else "")
                + "."
                + note,
            )
        )
    for file, error in sorted(parse_errors.items()):
        findings.append(
            Finding(
                code="PARSE_ERROR",
                severity="info",
                law="SEG-024",
                file=file,
                message=f"{file} was skipped: {error}",
            )
        )

    severity_rank = {"error": 0, "warning": 1, "info": 2}
    return sorted(
        findings,
        key=lambda f: (
            severity_rank[f.severity],
            f.law,
            f.component_id or "",
            f.file or "",
            f.line or 0,
            f.message,
        ),
    )


def pipeline_order_pairs() -> list[tuple[str, str]]:
    from .models import ML_PIPELINE

    return list(pairwise(ML_PIPELINE))


__all__ = ["UNASSIGNED", "compute_findings", "leakage_findings", "structural_violations"]
