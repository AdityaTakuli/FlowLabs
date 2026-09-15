"""SEG-098 — labelled-architecture metrics (boundary F1, archetype accuracy, leakage, names).

The 20-repository public benchmark is assembled elsewhere; this module is the scorer CI uses on
hand-labelled fixture repos. Leakage recall is the metric that matters most (SEG-099).
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from itertools import combinations
from typing import Any

from .models import BANNED_NAMES, Manifest, Unit


@dataclass(frozen=True)
class Labels:
    """Hand labels for one repository. Keys are unit names unique within that repo."""

    groups: dict[str, str]  # unit name → expected component key
    archetypes: dict[str, str]  # unit name → expected archetype of its component
    leaks: set[str] = field(default_factory=set)  # unit names that must produce LEAKAGE_FIT_BEFORE_SPLIT


@dataclass
class Scores:
    boundary_f1: float
    archetype_accuracy: float
    banned_name_rate: float
    leakage_recall: float
    leakage_false_positive_rate: float
    tokens_per_10k_loc: float
    units_scored: int
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "boundary_f1": round(self.boundary_f1, 4),
            "archetype_accuracy": round(self.archetype_accuracy, 4),
            "banned_name_rate": round(self.banned_name_rate, 4),
            "leakage_recall": round(self.leakage_recall, 4),
            "leakage_false_positive_rate": round(self.leakage_false_positive_rate, 4),
            "tokens_per_10k_loc": round(self.tokens_per_10k_loc, 2),
            "units_scored": self.units_scored,
            "notes": list(self.notes),
        }


def _f1(true_positive: int, false_positive: int, false_negative: int) -> float:
    if true_positive + false_positive + false_negative == 0:
        return 1.0
    precision = true_positive / (true_positive + false_positive) if true_positive + false_positive else 0.0
    recall = true_positive / (true_positive + false_negative) if true_positive + false_negative else 0.0
    if precision + recall == 0:
        return 0.0
    return 2 * precision * recall / (precision + recall)


def pairwise_f1(expected: dict[str, str], predicted: dict[str, str]) -> float:
    """Component-boundary F1: a pair of labelled units is a true positive iff both groupings agree."""
    names = sorted(set(expected) & set(predicted))
    true_positive = false_positive = false_negative = 0
    for left, right in combinations(names, 2):
        same_expected = expected[left] == expected[right]
        same_predicted = predicted[left] == predicted[right]
        if same_expected and same_predicted:
            true_positive += 1
        elif same_predicted:
            false_positive += 1
        elif same_expected:
            false_negative += 1
    return _f1(true_positive, false_positive, false_negative)


def _resolve(manifest: Manifest) -> Callable[[str], Unit | None]:
    """A label key is a qualified name, or a unit name when that name is unique in the repo."""
    by_qualified = {u.qualified_name: u for u in manifest.units}
    counts = Counter(u.name for u in manifest.units)
    by_name = {u.name: u for u in manifest.units if counts[u.name] == 1}

    def lookup(key: str) -> Unit | None:
        return by_qualified.get(key) or by_name.get(key)

    return lookup


def score(manifest: Manifest, labels: Labels) -> Scores:
    lookup = _resolve(manifest)
    predicted: dict[str, str] = {}
    expected: dict[str, str] = {}
    for key, group in labels.groups.items():
        unit = lookup(key)
        if unit is None:
            continue
        expected[key] = group
        predicted[key] = unit.component_id or "__unassigned__"
    components = {c.id: c for c in manifest.components}
    typed = 0
    correct = 0
    for key, archetype in labels.archetypes.items():
        unit = lookup(key)
        if unit is None or not unit.component_id:
            continue
        typed += 1
        if components[unit.component_id].archetype == archetype:
            correct += 1
    leak_findings = [f for f in manifest.findings if f.code == "LEAKAGE_FIT_BEFORE_SPLIT"]
    leaked_units = {f.unit_id for f in leak_findings} | {uid for f in leak_findings for uid in f.unit_ids}
    expected_leak_ids = set()
    for key in labels.leaks:
        unit = lookup(key)
        if unit is not None:
            expected_leak_ids.add(unit.id)
    found = expected_leak_ids & leaked_units
    other_ids = {u.id for u in manifest.units if u.id not in expected_leak_ids}
    false_positives = leaked_units - expected_leak_ids
    sloc = max(manifest.stats.sloc, 1)
    banned = sum(1 for c in manifest.components if any(w.lower() in BANNED_NAMES for w in c.name.split()))
    notes: list[str] = []
    missing = sorted(key for key in labels.groups if lookup(key) is None)
    if missing:
        notes.append(f"labelled units not in the manifest: {', '.join(missing[:8])}")
    return Scores(
        boundary_f1=pairwise_f1(expected, predicted),
        archetype_accuracy=(correct / typed) if typed else 1.0,
        banned_name_rate=(banned / len(manifest.components)) if manifest.components else 0.0,
        leakage_recall=(len(found) / len(expected_leak_ids)) if expected_leak_ids else 1.0,
        leakage_false_positive_rate=(len(false_positives) / len(other_ids)) if other_ids else 0.0,
        tokens_per_10k_loc=manifest.stats.tokens_used * 10_000 / sloc,
        units_scored=len(expected),
        notes=notes,
    )


def meets_targets(scores: Scores) -> list[str]:
    """SEG-098 thresholds. Returns the names of targets that failed."""
    failed: list[str] = []
    if scores.boundary_f1 < 0.75:
        failed.append(f"boundary F1 {scores.boundary_f1:.3f} < 0.75")
    if scores.archetype_accuracy < 0.85:
        failed.append(f"archetype accuracy {scores.archetype_accuracy:.3f} < 0.85")
    if scores.banned_name_rate != 0:
        failed.append(f"banned-name rate {scores.banned_name_rate:.3f} ≠ 0")
    if scores.leakage_recall < 0.95:
        failed.append(f"leakage recall {scores.leakage_recall:.3f} < 0.95")
    if scores.leakage_false_positive_rate > 0.05:
        failed.append(f"leakage FPR {scores.leakage_false_positive_rate:.3f} > 0.05")
    return failed


def aggregate(results: list[Scores]) -> dict[str, float]:
    if not results:
        return {}
    n = len(results)
    return {
        "boundary_f1": round(sum(s.boundary_f1 for s in results) / n, 4),
        "archetype_accuracy": round(sum(s.archetype_accuracy for s in results) / n, 4),
        "banned_name_rate": round(sum(s.banned_name_rate for s in results) / n, 4),
        "leakage_recall": round(sum(s.leakage_recall for s in results) / n, 4),
        "leakage_false_positive_rate": round(sum(s.leakage_false_positive_rate for s in results) / n, 4),
        "cases": n,
        "units_scored": sum(s.units_scored for s in results),
    }


def name_histogram(manifest: Manifest) -> Counter[str]:
    return Counter(c.name.lower() for c in manifest.components)
