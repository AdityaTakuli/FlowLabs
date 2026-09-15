"""The segregation pipeline (§3). Stages 0–3 and 7 are deterministic; Stages 4–6 are optional LLM stages.

SEG-033: the deterministic result is a complete architecture on its own. The LLM stages only
rename, repair boundaries and write responsibilities, and any failure falls back to it.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import subprocess
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from .cluster import Clustering, cluster_units
from .graphs import ProjectGraph, build_graph
from .inventory import inventory
from .models import (
    ARCHETYPES,
    ArchEdge,
    Component,
    Confidence,
    DecidedBy,
    FileRecord,
    LlmReport,
    Manifest,
    Span,
    Stats,
    Unit,
    min_confidence,
)
from .parse import ModuleInfo, UnitInfo, parse_source
from .rules import classify, unit_votes
from .validate import compute_findings, structural_violations

if TYPE_CHECKING:
    from .llm import Completer


class SegregationError(RuntimeError):
    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems[:10]))
        self.problems = problems


@dataclass
class SegregationOptions:
    use_git: bool = True
    use_llm: bool = False
    max_tokens: int = 60_000  # SEG-007 / SEG-082 ceiling across all LLM stages
    allow_over_budget: bool = False  # the user saw the estimate and confirmed it
    cache_dir: Path | None = None  # SEG-086; default <root>/.flowlab/segregation_cache


@dataclass
class GroupOverride:
    """What an LLM stage decided about one group of units (SEG-071 traceability)."""

    name: str | None = None
    responsibility: str | None = None
    archetype: str | None = None
    decided_by: DecidedBy = "cluster"
    archetype_decided_by: DecidedBy | None = None
    reason: str | None = None
    confidence: Confidence | None = None


@dataclass
class Context:
    root: Path
    graph: ProjectGraph
    votes: dict[str, Counter[str]]
    clustering: Clustering
    files: list[FileRecord]
    parse_errors: dict[str, str]
    commit: str | None
    project_id: str
    analysed_at: str


@dataclass
class Analysis:
    context: Context
    manifest: Manifest
    notes: list[str] = field(default_factory=list)

    @property
    def graph(self) -> ProjectGraph:
        return self.context.graph

    @property
    def votes(self) -> dict[str, Counter[str]]:
        return self.context.votes


def _commit(root: Path) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() or None


def group_archetype(
    graph: ProjectGraph, votes: dict[str, Counter[str]], members: list[str] | set[str]
) -> tuple[str, DecidedBy, Confidence, bool]:
    """Rules first (SEG-038): (archetype, decided_by, confidence, ambiguous)."""
    member_set = set(members)
    dependents = sum(1 for e in graph.edges.values() if e.target in member_set and e.source not in member_set)
    return classify(sum((votes[m] for m in member_set), Counter()), dependents)


def order_key(graph: ProjectGraph, members: list[str] | set[str]) -> tuple[str, int, str]:
    first = min((graph.units[m].unit for m in members), key=lambda u: (u.file, u.line_start, u.id))
    return first.file, first.line_start, first.id


def assemble(
    context: Context,
    groups: list[list[str]],
    group_confidence: list[Confidence],
    unassigned: list[str],
    overrides: list[GroupOverride | None] | None,
    llm: LlmReport,
) -> Manifest:
    """Build the manifest for a given grouping. Groups must already be in display order."""
    graph, votes = context.graph, context.votes
    component_of = {uid: f"cmp_{index}" for index, members in enumerate(groups, 1) for uid in members}
    for uid, info in graph.units.items():
        info.unit.component_id = component_of.get(uid)
        info.unit.archetype_hint = context.clustering.labels.get(uid)

    components: list[Component] = []
    taken: set[str] = set()
    for index, members in enumerate(groups, 1):
        cid = f"cmp_{index}"
        override = (overrides[index - 1] if overrides else None) or GroupOverride()
        member_set = set(members)
        infos = [graph.units[m] for m in members]
        depends: set[str] = set()
        public: set[str] = set()
        for edge in graph.edges.values():
            source_in, target_in = edge.source in member_set, edge.target in member_set
            if source_in == target_in:
                continue
            other = component_of.get(edge.target if source_in else edge.source)
            if edge.kind == "call":
                if source_in and other:
                    depends.add(other)
                if target_in:
                    public.add(edge.target)  # SEG-039: called from outside
            else:
                if target_in and other:
                    depends.add(other)
                if source_in:
                    public.add(edge.source)
        public |= {i.unit.id for i in infos if i.unit.entry_point}  # SEG-069
        archetype, archetype_by, archetype_confidence, ambiguous = group_archetype(graph, votes, members)
        if override.archetype in ARCHETYPES:
            archetype = str(override.archetype)
            archetype_by = override.archetype_decided_by or "llm"
            archetype_confidence = override.confidence or "medium"
            ambiguous = False
        spans: dict[str, tuple[int, int]] = {}
        for info in infos:
            unit = info.unit
            start, end = spans.get(unit.file, (unit.line_start, unit.line_end))
            spans[unit.file] = (min(start, unit.line_start), max(end, unit.line_end))
        # SEG-072: the minimum of the units' confidences and the grouping's own confidence
        confidence = min_confidence(group_confidence[index - 1], *(i.unit.confidence for i in infos))
        if override.confidence:
            confidence = min_confidence(confidence, override.confidence)
        name = override.name or f"cluster_{index}"
        if name.lower() in taken:  # SEG-097: deterministic repair of a duplicate name
            suffix = 2
            while f"{name} {suffix}".lower() in taken:
                suffix += 1
            llm.notes.append(f"Renamed duplicate component name {name!r} to '{name} {suffix}'.")
            name = f"{name} {suffix}"
        taken.add(name.lower())
        single_class = len({i.atom for i in infos}) == 1 and len(infos) > 1
        signal = "one class" if single_class else "call, data and module structure"
        components.append(
            Component(
                id=cid,
                name=name,
                archetype=archetype,
                responsibility=override.responsibility or ARCHETYPES[archetype],
                units=sorted(
                    members, key=lambda m: (graph.units[m].unit.file, graph.units[m].unit.line_start)
                ),
                public_surface=sorted(public),
                depends_on=sorted(depends),
                files=sorted(spans),
                spans=[Span(file=f, line_start=a, line_end=b) for f, (a, b) in sorted(spans.items())],
                sloc=sum(i.unit.sloc for i in infos),
                confidence=confidence,
                decided_by=override.decided_by,
                archetype_decided_by=archetype_by,
                archetype_confidence=archetype_confidence,
                reason=override.reason
                or f"Grouped by {signal}; archetype {'is ambiguous' if ambiguous else 'from rules'}.",
            )
        )

    edges: dict[tuple[str, str, str], ArchEdge] = {}
    for edge in graph.edges.values():
        a, b = component_of.get(edge.source), component_of.get(edge.target)
        if not a or not b or a == b:
            continue
        key = (a, b, edge.kind)
        current = edges.get(key)
        via = f"{edge.source}→{edge.target}"
        if current is None:
            edges[key] = ArchEdge(
                **{"from": a},
                to=b,
                kind=edge.kind,
                via=[via],
                confidence=edge.confidence,
                observed=edge.observed,
            )
        else:
            current.via = sorted({*current.via, via})[:20]
            current.confidence = min_confidence(current.confidence, edge.confidence)
            current.observed = current.observed or edge.observed

    unassigned = sorted(set(unassigned))
    findings = compute_findings(graph, components, unassigned, context.parse_errors)
    units: list[Unit] = sorted(
        (i.unit for i in graph.units.values()), key=lambda u: (u.file, u.line_start, u.id)
    )
    return Manifest(
        project_id=context.project_id,
        analysed_at=context.analysed_at,
        commit=context.commit,
        stats=Stats(
            files=len(context.files),
            units=len(units),
            components=len(components),
            unassigned_units=len(unassigned),
            sloc=sum(f.sloc for f in context.files if f.role == "source"),
            tokens_used=llm.tokens_used,
            estimated_tokens=llm.estimated_tokens,
            clustering=context.clustering.algorithm,
        ),
        components=components,
        units=units,
        edges=[edges[k] for k in sorted(edges)],
        findings=findings,
        unassigned=unassigned,
        files=context.files,
        llm=llm,
    )


def analyse(
    root: Path,
    options: SegregationOptions | None = None,
    *,
    completer: Completer | None = None,
    now: dt.datetime | None = None,
) -> Analysis:
    options = options or SegregationOptions()
    root = root.resolve()
    sources = inventory(root)
    modules: list[ModuleInfo] = []
    infos: list[UnitInfo] = []
    parse_errors: dict[str, str] = {}
    for source in sources:
        if source.record.role == "migration":
            continue  # SEG-021: recorded, not analysed
        module, parsed = parse_source(source)
        if module.parse_error:
            source.record.parse_error = module.parse_error
            parse_errors[source.record.path] = module.parse_error
        modules.append(module)
        infos.extend(parsed)
    graph = build_graph(root, modules, infos)
    votes = {uid: unit_votes(info) for uid, info in graph.units.items()}
    clustering = cluster_units(root, graph, votes, use_git=options.use_git)
    context = Context(
        root=root,
        graph=graph,
        votes=votes,
        clustering=clustering,
        files=[s.record for s in sources],
        parse_errors=parse_errors,
        commit=_commit(root) if options.use_git else None,
        project_id="prj_" + hashlib.sha256(str(root).encode()).hexdigest()[:12],
        analysed_at=(now or dt.datetime.now(dt.UTC)).isoformat(timespec="seconds"),
    )
    report = LlmReport(status="skipped", notes=["Names are generated; no model was used (SEG-033)."])
    manifest = assemble(
        context, clustering.groups, clustering.confidence, clustering.unassigned, None, report
    )
    problems = structural_violations(manifest)
    if problems:
        raise SegregationError(problems)
    analysis = Analysis(context=context, manifest=manifest)
    if completer is not None and options.use_llm:
        from .llm import run_llm_stages

        return run_llm_stages(analysis, completer, options)
    return analysis


def analyse_architecture(root: Path, options: SegregationOptions | None = None) -> Manifest:
    return analyse(root, options).manifest
