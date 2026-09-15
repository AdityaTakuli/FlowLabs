"""Stage 3 — Deterministic clustering (SEG-030 … SEG-033, SEG-041, SEG-048 … SEG-052).

Leiden community detection (networkx, fixed seed) over a weighted atom graph. Atoms keep a class
and its methods together (SEG-050) and each notebook cell whole (SEG-051). Path and framework
priors are applied as affinity seeds, not constraints (networkx's Leiden has no initial
partition, so a seed is a weight bonus between atoms that share the prior).
"""

from __future__ import annotations

import subprocess
from collections import Counter, defaultdict
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path

import networkx as nx  # type: ignore[import-untyped]

from .graphs import ProjectGraph
from .models import Confidence
from .rules import dominant, is_separate, tokens

SIGNALS = {
    "call": 1.0,
    "module": 0.6,
    "directory": 0.4,
    "library": 0.3,
    "data": 0.5,
    "prefix": 0.2,
    "cochange": 0.4,
    "prior": 0.5,
}
PRIOR_DIRS = frozenset(
    {
        "models",
        "features",
        "api",
        "services",
        "data",
        "routes",
        "routers",
        "controllers",
        "repositories",
        "schemas",
        "training",
        "evaluation",
        "preprocessing",
        "pipelines",
        "jobs",
        "tasks",
        "middleware",
        "auth",
        "clients",
    }
)
COMMON_LIBRARIES = frozenset(
    {
        "os",
        "sys",
        "re",
        "json",
        "typing",
        "pathlib",
        "collections",
        "dataclasses",
        "functools",
        "itertools",
        "datetime",
        "math",
        "logging",
        "time",
        "abc",
        "enum",
        "copy",
        "random",
        "warnings",
        "uuid",
        "__future__",
    }
)
GENERIC_PREFIXES = frozenset(
    {
        "get",
        "set",
        "is",
        "has",
        "to",
        "from",
        "make",
        "do",
        "run",
        "handle",
        "on",
        "test",
        "new",
        "create",
        "update",
        "delete",
        "main",
        "init",
    }
)
MAX_GROUP = 300
MIN_UNITS, MAX_UNITS, SPLIT_UNITS, SPLIT_SLOC = 3, 20, 30, 1500
RESOLUTIONS = (1.0, 0.5, 2.0, 0.25, 4.0)
SEED = 42


@dataclass
class Clustering:
    groups: list[list[str]]
    unassigned: list[str]
    algorithm: str
    confidence: list[Confidence]
    labels: dict[str, str | None]  # unit id → atom label, for unit archetype hints


def _cochange(root: Path, files: set[str]) -> Counter[tuple[str, str]]:
    pairs: Counter[tuple[str, str]] = Counter()
    try:
        prefix = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--show-prefix"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        ).stdout.strip()
        log = subprocess.run(
            ["git", "-C", str(root), "log", "-n", "300", "--name-only", "--pretty=format:@@commit"],
            capture_output=True, text=True, timeout=20, check=True,
        ).stdout  # fmt: skip
    except (OSError, subprocess.SubprocessError):
        return pairs
    for chunk in log.split("@@commit"):
        changed = sorted(
            {
                line[len(prefix) :]
                for line in chunk.splitlines()
                if line.startswith(prefix) and line[len(prefix) :] in files
            }
        )
        if 1 < len(changed) <= 20:
            pairs.update(combinations(changed, 2))
    return pairs


def _communities(graph: nx.Graph, resolution: float) -> tuple[list[set[str]], str]:
    """Leiden via leidenalg when installed; otherwise seeded Louvain plus Leiden's connectivity guarantee.

    networkx only dispatches ``leiden_communities`` to external backends, so the default install
    cannot run it. Splitting every community into its connected components restores the property
    that matters here: no Component is made of parts that never touch.
    """
    nodes = sorted(graph.nodes)
    try:
        import igraph  # type: ignore[import-not-found]
        import leidenalg  # type: ignore[import-not-found]

        index = {node: i for i, node in enumerate(nodes)}
        ig = igraph.Graph(n=len(nodes), edges=[(index[a], index[b]) for a, b in graph.edges])
        ig.es["weight"] = [graph.edges[a, b]["weight"] for a, b in graph.edges]
        partition = leidenalg.find_partition(
            ig,
            leidenalg.RBConfigurationVertexPartition,
            weights="weight",
            resolution_parameter=resolution,
            seed=SEED,
        )
        found = [{nodes[i] for i in community} for community in partition]
        algorithm = "leiden"
    except ImportError:
        found = nx.community.louvain_communities(graph, weight="weight", resolution=resolution, seed=SEED)
        algorithm = "louvain+connectivity"
    refined = [
        set(part) for community in found for part in nx.connected_components(graph.subgraph(community))
    ]
    return sorted(refined, key=lambda c: min(c)), algorithm


def cluster_units(
    root: Path, graph: ProjectGraph, votes: dict[str, Counter[str]], *, use_git: bool = True
) -> Clustering:
    units = graph.units
    atoms: dict[str, list[str]] = defaultdict(list)
    for uid in sorted(units):
        atoms[units[uid].atom].append(uid)
    live = {a for a, members in atoms.items() if not all(m in graph.dead for m in members)}
    atom_votes = {a: sum((votes[m] for m in atoms[a]), Counter()) for a in atoms}
    atom_label = {a: dominant(atom_votes[a]) for a in atoms}
    atom_units = {a: len(atoms[a]) for a in atoms}
    atom_sloc = {a: sum(units[m].unit.sloc for m in atoms[a]) for a in atoms}
    atom_entry = {a: any(units[m].unit.entry_point for m in atoms[a]) for a in atoms}
    lead = {a: units[atoms[a][0]] for a in atoms}

    weights: dict[tuple[str, str], float] = defaultdict(float)

    def bump(a: str, b: str, amount: float) -> None:
        if a != b and a in live and b in live:
            weights[(a, b) if a < b else (b, a)] += amount

    def group_bump(groups: dict[str, set[str]], amount: float, limit: int = MAX_GROUP) -> None:
        for members in groups.values():
            ordered = sorted(members & live)
            if 1 < len(ordered) <= limit:
                for a, b in combinations(ordered, 2):
                    bump(a, b, amount)

    call_pairs: set[tuple[str, str]] = set()
    data_pairs: set[tuple[str, str]] = set()
    for edge in graph.edges.values():
        a, b = units[edge.source].atom, units[edge.target].atom
        key = (a, b) if a < b else (b, a)
        (call_pairs if edge.kind == "call" else data_pairs).add(key)
    for a, b in sorted(call_pairs):
        bump(a, b, SIGNALS["call"])
    for a, b in sorted(data_pairs):
        bump(a, b, SIGNALS["data"])

    by_module: dict[str, set[str]] = defaultdict(set)
    by_dir: dict[str, set[str]] = defaultdict(set)
    by_library: dict[str, set[str]] = defaultdict(set)
    by_prefix: dict[str, set[str]] = defaultdict(set)
    by_prior: dict[str, set[str]] = defaultdict(set)
    framework: dict[str, set[str]] = defaultdict(set)
    roots = {m.split(".")[0] for m in graph.modules}
    for atom, info in lead.items():
        by_module[info.module].add(atom)
        by_dir[str(Path(info.unit.file).parent)].add(atom)
        for library in sum((sorted(units[m].libraries) for m in atoms[atom]), []):
            if library not in COMMON_LIBRARIES and library not in roots:
                by_library[library].add(atom)
        first = tokens(info.unit.name)[:1]
        if first and first[0] not in GENERIC_PREFIXES and len(first[0]) > 2:
            by_prefix[first[0]].add(atom)
        for part in Path(info.unit.file).parts[:-1]:
            if part.lower() in PRIOR_DIRS:
                by_prior[part.lower()].add(atom)
                break
        members = [units[m] for m in atoms[atom]]
        if any(m.unit.kind == "route_handler" for m in members):
            framework["routes"].add(atom)
        if any(
            c.name.startswith(("sklearn.pipeline", "sklearn.compose")) for m in members for c in m.call_sites
        ):
            framework["sklearn_pipeline"].add(atom)
        if any(
            d.split("(")[0].split(".")[-1] in ("task", "flow", "dag", "op", "asset")
            for m in members
            for d in m.unit.decorators
        ):
            framework["orchestration"].add(atom)
    group_bump(by_module, SIGNALS["module"])
    group_bump(by_dir, SIGNALS["directory"])
    group_bump(by_library, SIGNALS["library"], 150)
    group_bump(by_prefix, SIGNALS["prefix"], 150)
    group_bump(by_prior, SIGNALS["prior"])
    group_bump(framework, SIGNALS["prior"])
    if use_git:
        files = {info.unit.file for info in lead.values()}
        cochanged = _cochange(root, files)
        for (a, b), weight in list(weights.items()):
            fa, fb = lead[a].unit.file, lead[b].unit.file
            key = (fa, fb) if fa < fb else (fb, fa)
            if fa != fb and cochanged.get(key, 0) >= 2:
                weights[(a, b)] = weight + SIGNALS["cochange"]

    nx_graph = nx.Graph()
    nx_graph.add_nodes_from(sorted(live))
    for (a, b), weight in sorted(weights.items()):
        nx_graph.add_edge(a, b, weight=round(weight, 6))

    def unit_count(group: set[str]) -> int:
        return sum(atom_units[a] for a in group)

    best: list[set[str]] = []
    best_score = -1.0
    algorithm = "leiden"
    if live:
        for resolution in RESOLUTIONS:
            found, algorithm = _communities(nx_graph, resolution)
            total = sum(unit_count(c) for c in found) or 1
            within = sum(unit_count(c) for c in found if MIN_UNITS <= unit_count(c) <= MAX_UNITS)
            over = sum(unit_count(c) for c in found if unit_count(c) > SPLIT_UNITS)
            score = (within - over) / total
            if score > best_score + 1e-9:
                best, best_score = found, score

    def weight_between(atom: str, group: set[str]) -> float:
        return sum(weights.get((atom, b) if atom < b else (b, atom), 0.0) for b in group)

    # SEG-052 / SEG-059: pipeline stages and backend layers never share a Component
    separated: list[set[str]] = []
    for community in best:
        labelled: dict[str, set[str]] = defaultdict(set)
        for atom in community:
            label = atom_label[atom]
            if is_separate(label):
                labelled[str(label)].add(atom)
        if len(labelled) < 2:
            separated.append(community)
            continue
        parts = {label: set(members) for label, members in sorted(labelled.items())}
        remainder: set[str] = set()
        for atom in sorted(community - set().union(*labelled.values())):
            scores = {label: weight_between(atom, members) for label, members in parts.items()}
            score_total = sum(scores.values())
            label, score = sorted(scores.items(), key=lambda item: (-item[1], item[0]))[0]
            if score_total and score / score_total >= 0.6:
                parts[label].add(atom)
            else:
                remainder.add(atom)
        separated.extend(parts.values())
        if remainder:
            separated.append(remainder)

    # SEG-041 / SEG-048: split oversized communities
    sized: list[set[str]] = []
    for community in separated:
        pieces = [community]
        sloc = sum(atom_sloc[a] for a in community)
        if (unit_count(community) > SPLIT_UNITS or sloc > SPLIT_SLOC) and len(community) > 1:
            sub = nx_graph.subgraph(sorted(community))
            for factor in (2.0, 4.0, 8.0):
                found, _ = _communities(sub, factor)
                if len(found) > 1:
                    pieces = found
                    break
        sized.extend(pieces)

    def group_label(group: set[str]) -> str | None:
        counts: Counter[str] = Counter()
        for atom in group:
            label = atom_label[atom]
            if label:
                counts[label] += atom_units[atom]
        if not counts:
            return None
        label, count = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[0]
        return label if count / unit_count(group) >= 0.5 else None

    def compatible(small: str | None, target: str | None) -> bool:
        return (
            small is None
            and not is_separate(target)
            or small == target
            or (target is None and not is_separate(small))
        )

    # SEG-041 / SEG-049: merge small communities into their strongest compatible neighbour
    groups = [g for g in sized if g]
    changed = True
    while changed:
        changed = False
        groups.sort(key=lambda g: (unit_count(g), min(g)))
        for index, group in enumerate(groups):
            protected = any(atom_entry[a] or atom_sloc[a] > 200 for a in group)
            if unit_count(group) >= MIN_UNITS or protected:
                continue
            label = group_label(group)
            candidates = []
            for other_index, other in enumerate(groups):
                if other_index == index or not compatible(label, group_label(other)):
                    continue
                strength = sum(weight_between(a, other) for a in group)
                if strength > 0:
                    candidates.append((-strength, min(other), other_index))
            if candidates:
                target = groups[sorted(candidates)[0][2]]
                target |= group
                groups.pop(index)
                changed = True
                break

    unassigned = sorted(uid for uid in units if uid in graph.dead)
    final: list[set[str]] = []
    for group in groups:
        isolated = all(nx_graph.degree(a) == 0 for a in group)
        protected = any(atom_entry[a] or atom_sloc[a] > 200 for a in group)
        if isolated and not protected and unit_count(group) < MIN_UNITS:
            unassigned.extend(m for a in group for m in atoms[a])  # uncategorisable (SEG-005)
        else:
            final.append(group)

    def order_key(group: set[str]) -> tuple[str, int]:
        infos = [units[m].unit for a in group for m in atoms[a]]
        first = min(infos, key=lambda u: (u.file, u.line_start))
        return first.file, first.line_start

    final.sort(key=order_key)
    confidences: list[Confidence] = []
    for group in final:
        internal = sum(w for (a, b), w in weights.items() if a in group and b in group)
        external = sum(w for (a, b), w in weights.items() if (a in group) != (b in group))
        if internal >= 2 * external and internal > 0:
            confidences.append("high")
        elif internal >= external or len(group) == 1:
            confidences.append("medium")
        else:
            confidences.append("low")
    labels = {m: atom_label[a] for a in atoms for m in atoms[a]}
    return Clustering(
        groups=[sorted(m for a in group for m in atoms[a]) for group in final],
        unassigned=sorted(set(unassigned)),
        algorithm=algorithm,
        confidence=confidences,
        labels=labels,
    )
