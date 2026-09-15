"""Code segregation: decompose a codebase into Components and Units (Code Segregation Bylaws).

Stages 0–3 and 7 are deterministic and always produce a complete architecture. Stages 4–6 use
an LLM only on compressed cluster fingerprints, under hard token budgets.
"""

from .models import ARCHETYPES, BANNED_NAMES, UNASSIGNED, ArchEdge, Component, Finding, Manifest, Unit
from .pipeline import Analysis, SegregationError, SegregationOptions, analyse, analyse_architecture

__all__ = [
    "ARCHETYPES",
    "BANNED_NAMES",
    "UNASSIGNED",
    "Analysis",
    "ArchEdge",
    "Component",
    "Finding",
    "Manifest",
    "SegregationError",
    "SegregationOptions",
    "Unit",
    "analyse",
    "analyse_architecture",
]
