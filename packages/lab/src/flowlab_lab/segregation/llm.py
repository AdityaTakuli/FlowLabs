"""Stages 4–6 — LLM naming, boundary repair, classification and contracts (§3, §5, §8).

The model only ever sees rung-3 cluster fingerprints (or rung-4 summaries): names, kinds,
truncated signatures, first docstring lines, counts and edges. Never bodies, tests, data or
secrets (SEG-089, SEG-090). Every call is budgeted before it is made (SEG-007, SEG-081), cached by
content hash (SEG-086), validated against the laws, retried once with the violations, and on a
second failure the deterministic result stands (SEG-094, SEG-033).
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
from collections import Counter
from dataclasses import dataclass, field
from os.path import commonpath
from pathlib import Path
from typing import Any, Protocol

import networkx as nx  # type: ignore[import-untyped]

from ..privacy import mask_secrets
from .cluster import COMMON_LIBRARIES
from .models import ARCHETYPES, BANNED_NAMES, SEPARATE_ARCHETYPES, Confidence, LlmReport
from .pipeline import (
    Analysis,
    GroupOverride,
    SegregationOptions,
    assemble,
    group_archetype,
    order_key,
)
from .rules import layer_problem
from .validate import structural_violations

PROMPT_TEMPLATE_VERSION = "seg-1.0"
STAGE4_INPUT_CEILING, STAGE4_OUTPUT_CEILING, STAGE4_BATCH = 15_000, 4_000, 12
STAGE5_INPUT_CEILING, STAGE5_OUTPUT_CEILING = 3_000, 1_000
STAGE6_INPUT_PER_COMPONENT, STAGE6_OUTPUT_PER_COMPONENT, STAGE6_GROUP = 2_000, 200, 10
MAX_FINGERPRINT_UNITS = 12
MAX_COMPONENT_UNITS = 30
LIBRARY_WORDS = frozenset(
    {"pandas", "numpy", "sklearn", "scikit", "torch", "pytorch", "tensorflow", "keras", "fastapi",
     "flask", "django", "sqlalchemy", "pydantic", "polars", "matplotlib", "seaborn", "plotly", "requests",
     "httpx", "celery", "airflow", "spark", "pyspark", "xgboost", "lightgbm", "numba", "scipy", "boto3",
     "redis"}
)  # fmt: skip
NAME_SHAPE = re.compile(r"^[A-Za-z][A-Za-z0-9'-]*(?: [A-Za-z0-9][A-Za-z0-9'-]*){1,3}$")
AND_TWO_VERBS = re.compile(
    r"\band\s+(?:then\s+)?[a-z]+(?:es|s)\s+(?:the|a|an|it|them|its|their|each|all|data|features?|models?|rows|records|requests?|results?|files?)\b",
    re.IGNORECASE,
)

PREAMBLE = """You group software units into architectural components.

You receive CLUSTER FINGERPRINTS produced by static analysis. You never
receive source code. Do not ask for it; work from the fingerprints.

Rules you must follow:
- Each cluster gets a 2-4 word noun-phrase name from its domain vocabulary.
- Never use: utils, helpers, common, misc, core, shared, lib, base, main.
- Never name a component after a library (not "Pandas layer").
- The responsibility is ONE sentence, present tense, starting with a verb,
  with no "and" joining two different verbs.
- Choose exactly one archetype from the provided list. Never invent one.
- You may merge, split or move units between clusters, but every change
  needs a one-sentence reason.
- You may not create or delete units, or change any id or line number.
- Target 3-20 units per component.

Output valid JSON matching the given schema. No prose, no markdown fences."""

ARCHETYPE_LINE = "ARCHETYPES: [" + ", ".join(ARCHETYPES) + "]"

STAGE4_SCHEMA = """Return:
{
  "components": [
    { "cluster_id": "c3", "name": "...", "archetype": "...",
      "responsibility": "...", "confidence": "high|medium|low" }
  ],
  "changes": [
    { "op": "merge", "clusters": ["c4","c9"], "reason": "..." },
    { "op": "split", "cluster": "c2", "partition": [["u_1","u_2"],["u_3"]], "reason": "..." },
    { "op": "move", "unit": "u_77", "to": "c3", "reason": "..." }
  ]
}"""

STAGE5_SYSTEM = f"""TASK: CLASSIFY. Assign exactly one archetype from the list to each component.
{ARCHETYPE_LINE}
Return: {{"archetypes": [{{"cluster_id": "c3", "archetype": "...", "confidence": "high|medium|low",
"reason": "..."}}]}}
Output valid JSON only."""

STAGE6_SYSTEM = """TASK: CONTRACTS. For each component fingerprint write its responsibility: ONE
sentence, present tense, starting with a verb, no "and" joining two different verbs, at most 25 words.
Return: {"contracts": [{"cluster_id": "c3", "responsibility": "..."}]}
Output valid JSON only."""

REPAIR = "Your JSON had these problems:\n{errors}\nReturn the corrected full JSON only."


@dataclass(frozen=True)
class Completion:
    text: str
    prompt_tokens: int = 0
    completion_tokens: int = 0


class Completer(Protocol):
    """A chat model called at temperature 0 (SEG-095). Implementations must not add prose."""

    model: str

    def complete(self, messages: list[dict[str, str]], *, max_tokens: int) -> Completion: ...


class BudgetExceeded(RuntimeError):
    pass


def estimate_tokens(text: str) -> int:
    return len(text) // 4 + 1


def _messages_tokens(messages: list[dict[str, str]]) -> int:
    return sum(estimate_tokens(m["content"]) for m in messages)


def _json_object(text: str) -> Any:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("the reply was not a JSON object")
    return json.loads(text[start : end + 1])


def name_problem(name: object, taken: set[str]) -> str | None:
    if not isinstance(name, str):
        return f"name {name!r} must be a string (SEG-063)"
    words = {w.lower() for w in name.split()}
    if words & BANNED_NAMES:
        return f"name {name!r} uses a banned word {sorted(words & BANNED_NAMES)} (SEG-062)"
    if words & LIBRARY_WORDS:
        return f"name {name!r} is named after a library (SEG-064)"
    if not NAME_SHAPE.match(name.strip()):
        return f"name {name!r} must be a 2-4 word noun phrase (SEG-063)"
    if name.strip().lower() in taken:
        return f"name {name!r} is already used (SEG-065)"
    return None


def responsibility_problem(text: object) -> str | None:
    if not isinstance(text, str) or not text.strip():
        return "responsibility must be a sentence (SEG-040)"
    sentence = text.strip()
    if len(sentence) > 240 or not sentence.endswith("."):
        return f"responsibility {sentence!r} must be one short sentence ending with a period (SEG-040)"
    if re.search(r"[.!?]\s+\S", sentence[:-1]):
        return f"responsibility {sentence!r} must be exactly one sentence (SEG-040)"
    first = sentence.split()[0]
    if not (first[:1].isupper() and first.lower().endswith("s")):
        return f"responsibility {sentence!r} must start with a present-tense verb (SEG-040)"
    if AND_TWO_VERBS.search(sentence):
        return f"responsibility {sentence!r} joins two verbs with 'and' (SEG-044)"
    return None


@dataclass
class State:
    groups: dict[str, set[str]]
    original: dict[str, int]  # cluster id → index in the deterministic grouping
    overrides: dict[str, GroupOverride] = field(default_factory=dict)
    reasons: dict[str, list[str]] = field(default_factory=dict)
    changed: set[str] = field(default_factory=set)


class Runner:
    def __init__(self, completer: Completer, cache_dir: Path, report: LlmReport, ceiling: int) -> None:
        self.completer = completer
        self.cache_dir = cache_dir
        self.report = report
        self.ceiling = ceiling

    def key(self, stage: str, messages: list[dict[str, str]], max_tokens: int) -> str:
        blob = json.dumps(
            {"stage": stage, "version": PROMPT_TEMPLATE_VERSION, "model": self.completer.model,
             "messages": messages, "max_tokens": max_tokens},
            sort_keys=True, ensure_ascii=False,
        )  # fmt: skip
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def cached(self, stage: str, messages: list[dict[str, str]], max_tokens: int) -> bool:
        return (self.cache_dir / f"{self.key(stage, messages, max_tokens)}.json").is_file()

    def call(self, stage: str, messages: list[dict[str, str]], max_tokens: int) -> str:
        path = self.cache_dir / f"{self.key(stage, messages, max_tokens)}.json"
        if path.is_file():
            try:
                self.report.cached_calls += 1
                return str(json.loads(path.read_text(encoding="utf-8"))["text"])
            except (OSError, ValueError, KeyError):
                path.unlink(missing_ok=True)
        prompt = _messages_tokens(messages)
        if self.report.tokens_used + prompt + max_tokens > self.ceiling:
            raise BudgetExceeded(f"{stage} would exceed the {self.ceiling:,}-token budget")
        result = self.completer.complete(messages, max_tokens=max_tokens)
        self.report.calls += 1
        self.report.tokens_used += (result.prompt_tokens or prompt) + (
            result.completion_tokens or estimate_tokens(result.text)
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"text": result.text}), encoding="utf-8")
        return result.text


def fingerprint(analysis: Analysis, state: State, cid: str) -> dict[str, Any]:
    """Rung 3 (SEG-084, SEG-085): the most connected units, truncated signatures, edges, stats."""
    graph = analysis.graph
    members = state.groups[cid]
    owner = {uid: c for c, group in state.groups.items() for uid in group}
    degree: Counter[str] = Counter()
    calls_out: Counter[str] = Counter()
    inbound: set[str] = set()
    outbound: set[str] = set()
    for edge in graph.edges.values():
        if edge.source in members or edge.target in members:
            degree[edge.source] += 1
            degree[edge.target] += 1
        if edge.source in members and edge.kind == "call":
            calls_out[edge.source] += 1
        a, b = owner.get(edge.source), owner.get(edge.target)
        if a and b and a != b:
            if b == cid:
                inbound.add(a)
            if a == cid:
                outbound.add(b)
    infos = [graph.units[u] for u in members]
    top = sorted(infos, key=lambda i: (-degree[i.unit.id], i.unit.file, i.unit.line_start))[
        :MAX_FINGERPRINT_UNITS
    ]
    units: list[dict[str, Any]] = []
    for info in top:
        entry: dict[str, Any] = {"id": info.unit.id, "name": info.unit.name, "kind": info.unit.kind}
        if info.unit.signature:
            entry["sig"] = info.unit.signature[:100]
        if info.unit.docstring_first_line:
            entry["doc"] = info.unit.docstring_first_line[:120]
        entry["calls_out"] = calls_out[info.unit.id]
        units.append(entry)
    roots = {m.split(".")[0] for m in graph.modules}
    imports: Counter[str] = Counter()
    for info in infos:
        for call in info.call_sites:
            parts = call.name.split(".")
            if parts[0] in info.libraries and parts[0] not in COMMON_LIBRARIES and parts[0] not in roots:
                imports[".".join(parts[:2]) if len(parts) > 2 else parts[0]] += 1
    files = sorted({i.unit.file for i in infos})
    prior = commonpath(files) if len(files) > 1 else str(Path(files[0]).parent)
    return {
        "cluster_id": cid,
        "unit_count": len(members),
        "sloc": sum(i.unit.sloc for i in infos),
        "files": files[:6],
        "units": units,
        "dominant_imports": [n for n, _ in sorted(imports.items(), key=lambda item: (-item[1], item[0]))[:6]],
        "inbound_from": sorted(inbound),
        "outbound_to": sorted(outbound),
        "entry_points": sorted(i.unit.name for i in infos if i.unit.entry_point)[:5],
        "side_effects": sorted({s for i in infos for s in i.unit.side_effects}),
        "path_prior": f"{prior}/" if prior not in ("", ".") else None,
    }


def _redact(payload: Any, counter: Counter[str]) -> Any:
    """SEG-090: scan the outbound payload for credentials and mask them before it leaves the machine."""
    text = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    masked, found = mask_secrets(text)
    if not found:
        return payload
    counter["redacted"] += len(found)
    try:
        return json.loads(masked)
    except ValueError:
        for unit in payload.get("units", []):
            unit.pop("doc", None)
            unit.pop("sig", None)
        return payload


def _system(extra: str) -> dict[str, str]:
    return {"role": "system", "content": extra}


def _stage4_messages(fingerprints: list[dict[str, Any]], names: list[str]) -> list[dict[str, str]]:
    user = "CLUSTERS:\n" + json.dumps(fingerprints, separators=(",", ":"), sort_keys=True, ensure_ascii=False)
    if names:
        user += "\n\nNAMES ALREADY USED (do not reuse): " + json.dumps(sorted(names))
    # SEG-088: the static preamble, catalogue and schema form the cacheable prefix
    return [_system(f"{PREAMBLE}\n\n{ARCHETYPE_LINE}\n\n{STAGE4_SCHEMA}"), {"role": "user", "content": user}]


def _expand_atoms(analysis: Analysis, units: list[str]) -> list[str]:
    """SEG-050: moving or splitting one method moves its whole class."""
    graph = analysis.graph
    atoms = {graph.units[u].atom for u in units if u in graph.units}
    return sorted(uid for uid, info in graph.units.items() if info.atom in atoms)


def _dependency_problems(analysis: Analysis, groups: dict[str, set[str]]) -> tuple[int, int]:
    graph, votes = analysis.graph, analysis.votes
    owner = {uid: c for c, group in groups.items() for uid in group}
    archetype: dict[str, str] = {}
    for cid, members in groups.items():
        label, _, confidence, ambiguous = group_archetype(graph, votes, members)
        archetype[cid] = "" if ambiguous or confidence == "low" else label
    pairs: set[tuple[str, str]] = set()
    for edge in graph.edges.values():
        a, b = owner.get(edge.source), owner.get(edge.target)
        if a and b and a != b:
            pairs.add((a, b) if edge.kind == "call" else (b, a))
    digraph = nx.DiGraph()
    digraph.add_nodes_from(sorted(groups))
    digraph.add_edges_from(sorted(pairs))
    cycles = sum(1 for c in nx.strongly_connected_components(digraph) if len(c) > 1)
    layers = sum(
        1 for a, b in pairs if archetype[a] and archetype[b] and layer_problem(archetype[a], archetype[b])
    )
    return cycles, layers


def _apply_stage4(
    analysis: Analysis, state: State, batch: list[str], data: Any, taken: set[str]
) -> list[str]:
    """Validate a Stage-4 reply against Section 4 and apply it atomically. Returns violations."""
    if not isinstance(data, dict):
        return ["the reply must be a JSON object"]
    graph, votes = analysis.graph, analysis.votes
    errors: list[str] = []
    groups = {cid: set(members) for cid, members in state.groups.items()}
    before = _dependency_problems(analysis, groups)
    in_batch = set(batch)
    proposals: dict[str, dict[str, Any]] = {}
    names = set(taken)
    for entry in data.get("components") or []:
        if not isinstance(entry, dict) or entry.get("cluster_id") not in in_batch:
            errors.append(f"components entry {entry!r} does not name a cluster from this batch (SEG-036)")
            continue
        cid = str(entry["cluster_id"])
        problem = name_problem(entry.get("name"), names)
        if problem:
            errors.append(f"{cid}: {problem}")
        else:
            names.add(str(entry["name"]).strip().lower())
        if "archetype" in entry and entry["archetype"] not in ARCHETYPES:
            errors.append(f"{cid}: archetype {entry['archetype']!r} is not in the catalogue (SEG-091)")
        problem = responsibility_problem(entry.get("responsibility"))
        if problem:
            errors.append(f"{cid}: {problem}")
        proposals[cid] = entry
    reasons: dict[str, list[str]] = {}
    changed: set[str] = set()
    for change in data.get("changes") or []:
        if not isinstance(change, dict):
            errors.append(f"change {change!r} is not an object")
            continue
        reason = str(change.get("reason") or "").strip()
        if not reason:
            errors.append(f"change {change!r} has no reason (SEG-037)")
            continue
        op = change.get("op")
        if op == "merge":
            clusters = change.get("clusters")
            if (
                not isinstance(clusters, list)
                or len(clusters) < 2
                or not all(c in in_batch and c in groups for c in clusters)
            ):
                errors.append(f"merge {clusters!r} must list two or more clusters from this batch (SEG-036)")
                continue
            labels = set()
            for cid in clusters:
                label, _, confidence, ambiguous = group_archetype(graph, votes, groups[cid])
                if not ambiguous and label in SEPARATE_ARCHETYPES:
                    labels.add(label)
            if len(labels) > 1:
                errors.append(
                    f"merge {clusters} joins {sorted(labels)}, which must stay separate components "
                    "(SEG-052/SEG-059)"
                )
                continue
            merged = set().union(*(groups[c] for c in clusters))
            if len(merged) > MAX_COMPONENT_UNITS:
                errors.append(
                    f"merge {clusters} would create {len(merged)} units, "
                    f"above {MAX_COMPONENT_UNITS} (SEG-041)"
                )
                continue
            groups[clusters[0]] = merged
            for cid in clusters[1:]:
                del groups[cid]
            changed.add(clusters[0])
            reasons.setdefault(clusters[0], []).append(reason)
        elif op == "split":
            cid = str(change.get("cluster", ""))
            partition = change.get("partition")
            if (
                cid not in in_batch
                or cid not in groups
                or not isinstance(partition, list)
                or len(partition) < 2
            ):
                errors.append(f"split of {cid!r} needs a cluster from this batch and two or more parts")
                continue
            listed = [u for part in partition if isinstance(part, list) for u in part]
            if any(not isinstance(u, str) or u not in groups[cid] for u in listed) or len(listed) != len(
                set(listed)
            ):
                errors.append(
                    f"split of {cid} may only partition that cluster's own units, each once (SEG-036)"
                )
                continue
            parts = [
                set(_expand_atoms(analysis, [u for u in part if isinstance(u, str)])) & groups[cid]
                for part in partition
            ]
            claimed: set[str] = set()
            for part in parts:
                part -= claimed
                claimed |= part
            for uid in sorted(groups[cid] - claimed):  # unlisted members follow their strongest part
                strengths = [
                    sum(
                        1
                        for e in graph.edges.values()
                        if (e.source == uid and e.target in part) or (e.target == uid and e.source in part)
                    )
                    for part in parts
                ]
                parts[max(range(len(parts)), key=lambda i: (strengths[i], -i))].add(uid)
            if any(not part for part in parts):
                errors.append(f"split of {cid} leaves an empty part")
                continue
            groups[cid] = parts[0]
            changed.add(cid)
            reasons.setdefault(cid, []).append(reason)
            for number, part in enumerate(parts[1:], 2):
                new = f"{cid}.{number}"
                groups[new] = part
                changed.add(new)
                reasons.setdefault(new, []).append(reason)
        elif op == "move":
            unit, target = change.get("unit"), change.get("to")
            members = set().union(*(groups[c] for c in in_batch if c in groups))
            if unit not in members or target not in in_batch or target not in groups:
                errors.append(
                    f"move of {unit!r} to {target!r} must use a unit and cluster from this batch (SEG-036)"
                )
                continue
            moving = set(_expand_atoms(analysis, [str(unit)]))
            for cid in list(groups):
                if groups[cid] & moving and cid != target:
                    groups[cid] -= moving
                    changed.add(cid)
                    if not groups[cid]:
                        del groups[cid]
            groups[str(target)] |= moving
            if len(groups[str(target)]) > MAX_COMPONENT_UNITS:
                errors.append(f"move into {target} exceeds {MAX_COMPONENT_UNITS} units (SEG-041)")
                continue
            changed.add(str(target))
            reasons.setdefault(str(target), []).append(reason)
        else:
            errors.append(f"unknown change op {op!r}")
    if not errors and changed:
        after = _dependency_problems(analysis, groups)
        if after[0] > before[0]:
            errors.append("the changes introduce a new component dependency cycle (SEG-045)")
        if after[1] > before[1]:
            errors.append("the changes introduce a new layer violation (SEG-046)")
    if errors:
        return errors
    state.groups = groups
    state.changed |= changed
    for cid, items in reasons.items():
        state.reasons.setdefault(cid, []).extend(items)
    for cid, entry in proposals.items():
        if cid not in state.groups:
            continue
        override = state.overrides.setdefault(cid, GroupOverride())
        override.name = str(entry["name"]).strip()
        override.responsibility = str(entry["responsibility"]).strip()
        override.decided_by = "llm"
        stated = entry.get("confidence")
        override.confidence = stated if stated in ("high", "medium", "low") else "medium"
        if entry.get("archetype") in ARCHETYPES:
            _, _, _, ambiguous = group_archetype(graph, votes, state.groups[cid])
            if ambiguous:  # SEG-038: rules first; the model only settles ambiguous components
                override.archetype = str(entry["archetype"])
                override.archetype_decided_by = "llm"
    taken |= {o.name.lower() for o in state.overrides.values() if o.name}
    return []


def _ask(
    runner: Runner, stage: str, messages: list[dict[str, str]], max_tokens: int, apply: Any
) -> list[str]:
    """One call, validated; one retry with the violations appended (SEG-094)."""
    text = runner.call(stage, messages, max_tokens)
    try:
        errors = apply(_json_object(text))
    except ValueError as exc:
        errors = [f"invalid JSON: {exc}"]
    if not errors:
        return []
    retry = [
        *messages,
        {"role": "assistant", "content": text},
        {"role": "user", "content": REPAIR.format(errors="\n".join(f"- {e}" for e in errors[:8]))},
    ]
    text = runner.call(stage, retry, max_tokens)
    try:
        return list(apply(_json_object(text)))
    except ValueError as exc:
        return [f"invalid JSON: {exc}"]


def _batches(fingerprints: dict[str, dict[str, Any]]) -> list[list[str]]:
    """SEG-083: batches by directory locality, at most 12 clusters and the Stage-4 input ceiling."""
    ordered = sorted(
        fingerprints,
        key=lambda c: (
            fingerprints[c]["path_prior"] or "",
            fingerprints[c]["files"][0] if fingerprints[c]["files"] else "",
            c,
        ),
    )
    base = estimate_tokens(PREAMBLE + ARCHETYPE_LINE + STAGE4_SCHEMA) + 400
    batches: list[list[str]] = []
    current: list[str] = []
    size = base
    for cid in ordered:
        cost = estimate_tokens(json.dumps(fingerprints[cid], separators=(",", ":")))
        if current and (len(current) >= STAGE4_BATCH or size + cost > STAGE4_INPUT_CEILING):
            batches.append(current)
            current, size = [], base
        current.append(cid)
        size += cost
    if current:
        batches.append(current)
    return batches


def run_llm_stages(analysis: Analysis, completer: Completer, options: SegregationOptions) -> Analysis:
    context = analysis.context
    graph, votes = context.graph, context.votes
    deterministic = context.clustering
    report = LlmReport(status="used")
    counter: Counter[str] = Counter()
    state = State(
        groups={f"c{index}": set(members) for index, members in enumerate(deterministic.groups, 1)},
        original={f"c{index}": index - 1 for index in range(1, len(deterministic.groups) + 1)},
    )
    fingerprints = {
        cid: _redact(fingerprint(analysis, state, cid), counter)
        for cid in sorted(state.groups, key=lambda c: int(c[1:]))
    }
    batches = _batches(fingerprints)
    runner = Runner(
        completer,
        options.cache_dir or context.root / ".flowlab" / "segregation_cache",
        report,
        options.max_tokens,
    )

    # SEG-007: estimate before any call; cached batches cost nothing
    stage4 = sum(
        _messages_tokens(_stage4_messages([fingerprints[c] for c in batch], [])) + 60 * len(batch)
        for batch in batches
        if not runner.cached(
            "stage4", _stage4_messages([fingerprints[c] for c in batch], []), STAGE4_OUTPUT_CEILING
        )
    )
    ambiguous = sum(1 for members in state.groups.values() if group_archetype(graph, votes, members)[3])
    stage5 = 0 if not ambiguous else estimate_tokens(STAGE5_SYSTEM) + 80 * ambiguous + 40 * ambiguous
    report.estimated_tokens = stage4 + stage5
    if report.estimated_tokens > options.max_tokens and not options.allow_over_budget:
        unchanged = analysis.manifest.model_copy(deep=True)
        unchanged.llm = LlmReport(
            status="over_budget",
            estimated_tokens=report.estimated_tokens,
            notes=[
                f"Estimated {report.estimated_tokens:,} tokens exceeds the {options.max_tokens:,}-token "
                "budget; no model call was made. Confirm to continue (SEG-007)."
            ],
        )
        unchanged.stats.estimated_tokens = report.estimated_tokens
        return Analysis(context=context, manifest=unchanged)
    if options.allow_over_budget:
        runner.ceiling = max(options.max_tokens, int(report.estimated_tokens * 1.5) + STAGE4_OUTPUT_CEILING)

    failures = 0
    taken: set[str] = set()
    try:
        for number, batch in enumerate(batches, 1):
            live = [cid for cid in batch if cid in state.groups]
            if not live:
                continue
            messages = _stage4_messages([fingerprints[c] for c in live], sorted(taken))
            errors = _ask(
                runner,
                "stage4",
                messages,
                STAGE4_OUTPUT_CEILING,
                lambda data, live=live: _apply_stage4(analysis, state, live, data, taken),
            )
            if errors:
                failures += 1
                report.notes.append(
                    f"Stage 4 batch {number}: rejected twice ({errors[0]}); generated names kept (SEG-094)."
                )

        # Stage 5: ambiguous archetypes only, rung 4 plus dominant imports (SEG-038, SEG-080)
        pending = [
            cid
            for cid, members in sorted(state.groups.items())
            if group_archetype(graph, votes, members)[3]
            and not (cid in state.overrides and state.overrides[cid].archetype)
        ]
        if pending:
            summaries = []
            for cid in pending:
                override = state.overrides.get(cid) or GroupOverride()
                members = state.groups[cid]
                public = sorted(
                    {
                        graph.units[e.target].unit.name
                        for e in graph.edges.values()
                        if e.target in members and e.source not in members
                    }
                )[:6]
                summary = {
                    "cluster_id": cid,
                    "name": override.name or cid,
                    "responsibility": override.responsibility or "",
                    "public_surface": public,
                    "dominant_imports": fingerprint(analysis, state, cid)["dominant_imports"],
                }
                summaries.append(_redact(summary, counter))
            chunks: list[list[dict[str, Any]]] = [[]]
            for summary in summaries:
                if (
                    chunks[-1]
                    and estimate_tokens(STAGE5_SYSTEM + json.dumps(chunks[-1] + [summary]))
                    > STAGE5_INPUT_CEILING
                ):
                    chunks.append([])
                chunks[-1].append(summary)
            for chunk in chunks:
                ids = {s["cluster_id"] for s in chunk}

                def apply5(data: Any, ids: set[str] = ids) -> list[str]:
                    entries = data.get("archetypes") if isinstance(data, dict) else None
                    if not isinstance(entries, list):
                        return ['the reply must be {"archetypes": [...]}']
                    errors = [
                        f"{e!r} is not a valid archetype entry (SEG-091)"
                        for e in entries
                        if not isinstance(e, dict)
                        or e.get("cluster_id") not in ids
                        or e.get("archetype") not in ARCHETYPES
                    ]
                    if errors:
                        return errors
                    for entry in entries:
                        override = state.overrides.setdefault(entry["cluster_id"], GroupOverride())
                        override.archetype = entry["archetype"]
                        override.archetype_decided_by = "llm"
                        if entry.get("reason"):
                            state.reasons.setdefault(entry["cluster_id"], []).append(str(entry["reason"]))
                    return []

                messages = [
                    _system(STAGE5_SYSTEM),
                    {
                        "role": "user",
                        "content": "COMPONENTS:\n" + json.dumps(chunk, separators=(",", ":"), sort_keys=True),
                    },
                ]
                if _ask(runner, "stage5", messages, STAGE5_OUTPUT_CEILING, apply5):
                    failures += 1
                    report.notes.append(
                        "Stage 5: archetype replies rejected twice; rule archetypes kept (SEG-094)."
                    )

        # Stage 6: responsibility for components the model has not described yet (SEG-040)
        missing = [
            cid
            for cid in sorted(state.groups)
            if not (state.overrides.get(cid) and state.overrides[cid].responsibility)
        ]
        for start in range(0, len(missing), STAGE6_GROUP):
            chunk_ids = missing[start : start + STAGE6_GROUP]
            prints = [_redact(fingerprint(analysis, state, cid), counter) for cid in chunk_ids]
            prints = [p for p in prints if estimate_tokens(json.dumps(p)) <= STAGE6_INPUT_PER_COMPONENT]
            if not prints:
                continue
            ids = {p["cluster_id"] for p in prints}

            def apply6(data: Any, ids: set[str] = ids) -> list[str]:
                entries = data.get("contracts") if isinstance(data, dict) else None
                if not isinstance(entries, list):
                    return ['the reply must be {"contracts": [...]}']
                errors = []
                for entry in entries:
                    if not isinstance(entry, dict) or entry.get("cluster_id") not in ids:
                        errors.append(f"{entry!r} does not name a component from this request (SEG-036)")
                        continue
                    problem = responsibility_problem(entry.get("responsibility"))
                    if problem:
                        errors.append(f"{entry['cluster_id']}: {problem}")
                if errors:
                    return errors
                for entry in entries:
                    override = state.overrides.setdefault(entry["cluster_id"], GroupOverride())
                    override.responsibility = str(entry["responsibility"]).strip()
                    if override.decided_by != "llm" and not override.name:
                        override.decided_by = "llm"
                return []

            messages = [
                _system(STAGE6_SYSTEM),
                {
                    "role": "user",
                    "content": "COMPONENTS:\n" + json.dumps(prints, separators=(",", ":"), sort_keys=True),
                },
            ]
            if _ask(runner, "stage6", messages, STAGE6_OUTPUT_PER_COMPONENT * len(prints), apply6):
                failures += 1
                report.notes.append(
                    "Stage 6: contract replies rejected twice; catalogue responsibilities kept (SEG-094)."
                )
    except BudgetExceeded as exc:
        failures += 1
        report.notes.append(f"Stopped early: {exc} (SEG-081).")
    except Exception as exc:  # noqa: BLE001 - a failing provider must never lose the deterministic result
        failures += 1
        report.notes.append(
            f"Model call failed ({type(exc).__name__}: {str(exc)[:160]}); "
            "deterministic result kept (SEG-033)."
        )

    if counter["redacted"]:
        report.notes.append(
            f"Redacted {counter['redacted']} credential-like value(s) before sending (SEG-090)."
        )
    applied = bool(state.overrides or state.changed)
    report.status = (
        "used" if applied and not failures else "partial" if applied else "failed" if failures else "used"
    )

    ordered = sorted(state.groups.items(), key=lambda item: order_key(graph, item[1]))
    groups = [sorted(members) for _, members in ordered]
    confidences: list[Confidence] = []
    overrides: list[GroupOverride | None] = []
    for cid, _ in ordered:
        if cid in state.original and cid not in state.changed:
            base: Confidence = deterministic.confidence[state.original[cid]]
        else:
            base = "medium"  # a boundary the model moved is at best medium confidence
        confidences.append(base)
        final = copy.copy(state.overrides[cid]) if cid in state.overrides else None
        if cid in state.changed:
            final = final or GroupOverride()
            final.decided_by = "llm"
        if final is not None and state.reasons.get(cid):
            final.reason = " ".join(state.reasons[cid][:2])
        elif final is not None and final.decided_by == "llm" and not final.reason:
            final.reason = "Named by the model from its structural fingerprint."
        overrides.append(final)
    unassigned = sorted(set(deterministic.unassigned) - {u for g in groups for u in g})
    manifest = assemble(context, groups, confidences, unassigned, overrides, report)
    problems = structural_violations(manifest)
    if problems:  # SEG-097: unrepairable → the deterministic Stage-3 output stands
        report.status = "failed"
        report.notes.append(
            f"Validation failed after the model's changes ({problems[0]}); deterministic result kept."
        )
        manifest = assemble(
            context, deterministic.groups, deterministic.confidence, deterministic.unassigned, None, report
        )
    return Analysis(context=context, manifest=manifest, notes=report.notes)
