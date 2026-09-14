"""Stage 4: semantic checks — the rigour layer (PRD Section 8.5).

These rules live in the compiler, not in node code, so a runner cannot bypass them.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from flowspec import CompileIssue, PortSchema, PortType, Role, Semantic
from pydantic import BaseModel

from .graph import FlowGraph

SMALL_N = 30
MINORITY_THRESHOLD = 0.10
MAX_UNCORRECTED_TESTS = 5
SPLIT_TYPE = "prep.split"


@dataclass
class TypedGraph:
    graph: FlowGraph
    params: Mapping[str, BaseModel]
    inputs: Mapping[str, Mapping[str, PortSchema]]
    outputs: Mapping[str, Mapping[str, PortSchema]]

    def typed(self) -> list[str]:
        return [nid for nid in self.graph.order if nid in self.outputs]

    def type_of(self, nid: str) -> str:
        return self.graph.nodes[nid].type


def _issue(
    node_id: str | None, code: str, severity: str, message: str, suggestion: str | None = None
) -> CompileIssue:
    return CompileIssue(node_id=node_id, code=code, severity=severity, message=message, suggestion=suggestion)


def leakage_fit_before_split(tg: TypedGraph) -> list[CompileIssue]:
    """Learning transformers must see a split (and fit on train) if a split or model follows."""
    issues = []
    g = tg.graph
    for nid in tg.typed():
        impl = g.impls[nid]
        if not impl.learns_from_data(tg.params[nid]):
            continue
        if any(ps.kind == PortType.TABLE_SPLIT for ps in tg.inputs[nid].values()):
            continue
        downstream = [
            d
            for d in g.order
            if d in g.descendants(nid) and (tg.type_of(d) == SPLIT_TYPE or tg.type_of(d).startswith("model."))
        ]
        if tg.type_of(nid).startswith("model.") or not downstream:
            continue
        first = downstream[0]
        issues.append(
            _issue(
                nid,
                "LEAKAGE_FIT_BEFORE_SPLIT",
                "error",
                f"{g.label(nid)} learns parameters from the full table before {g.label(first)}; "
                "test rows would leak into training",
                "Move this node after prep.split and connect it to the split output so it fits "
                "on the train partition only",
            )
        )
    return issues


def leakage_resampling(tg: TypedGraph) -> list[CompileIssue]:
    issues = []
    for nid in tg.typed():
        if not tg.graph.impls[nid].resamples_rows:
            continue
        if not any(ps.kind == PortType.TABLE_SPLIT for ps in tg.inputs[nid].values()):
            issues.append(
                _issue(
                    nid,
                    "LEAKAGE_RESAMPLING",
                    "error",
                    f"{tg.graph.label(nid)} resamples rows outside a split; synthetic or duplicated "
                    "rows would reach the test set",
                    "Connect it to a prep.split output; it resamples the train partition only",
                )
            )
    return issues


def model_rules(tg: TypedGraph) -> list[CompileIssue]:
    issues = []
    g = tg.graph
    for nid in tg.typed():
        ntype = tg.type_of(nid)
        if ntype == "model.fit":
            model = tg.outputs[nid]["model"].model
            train = tg.inputs[nid]["train"]
            assert model is not None
            schema = train.require_table()
            if model.target in model.features:
                issues.append(
                    _issue(
                        nid,
                        "LEAKAGE_TARGET_IN_FEATURES",
                        "error",
                        f"the target '{model.target}' is listed as a feature",
                        f"Remove '{model.target}' from features",
                    )
                )
            for f in model.features:
                col = schema.column(f)
                if col is not None and (col.role == Role.IDENTIFIER or col.semantic == Semantic.IDENTIFIER):
                    issues.append(
                        _issue(
                            nid,
                            "IDENTIFIER_AS_FEATURE",
                            "warning",
                            f"'{f}' looks like an identifier; models memorise ids instead of learning",
                            f"Remove '{f}' from features",
                        )
                    )
            if train.kind == PortType.TABLE:
                issues.append(
                    _issue(
                        nid,
                        "NO_HOLDOUT",
                        "warning",
                        "the model is fit on a full table; there is no held-out data to evaluate on",
                        "Insert prep.split before this node",
                    )
                )
            if model.task == "classification":
                target = schema.column(model.target)
                balance = target.class_balance if target else None
                weighted = getattr(tg.params[nid], "class_weight", "none") == "balanced"
                resampled = any(g.impls[a].resamples_rows for a in g.ancestors(nid))
                if balance and len(balance) >= 2 and not weighted and not resampled:
                    minority_class, minority = min(balance.items(), key=lambda kv: kv[1])
                    if minority < MINORITY_THRESHOLD:
                        issues.append(
                            _issue(
                                nid,
                                "CLASS_IMBALANCE",
                                "warning",
                                f"minority class '{minority_class}' is {minority:.1%} of rows and no "
                                "balancing or class weighting is configured",
                                "Set class_weight to 'balanced' and judge the model on balanced "
                                "accuracy or recall, not accuracy",
                            )
                        )
        elif ntype == "model.evaluate":
            data = tg.inputs[nid]["data"]
            partition = getattr(tg.params[nid], "partition", "test")
            if data.kind == PortType.TABLE_SPLIT and partition == "train":
                issues.append(
                    _issue(
                        nid,
                        "EVAL_ON_TRAIN",
                        "warning",
                        "evaluating on the train partition overstates performance",
                        "Set partition to 'test'",
                    )
                )
            if data.kind == PortType.TABLE:
                issues.append(
                    _issue(
                        nid,
                        "EVAL_WITHOUT_SPLIT",
                        "warning",
                        "evaluation data is not a held-out partition; rows may overlap training",
                        "Connect the data input to a split output",
                    )
                )
            model_splits = {a for a in g.upstream_of_port(nid, "model") if tg.type_of(a) == SPLIT_TYPE}
            data_splits = {a for a in g.upstream_of_port(nid, "data") if tg.type_of(a) == SPLIT_TYPE}
            if model_splits and data_splits and not model_splits & data_splits:
                issues.append(
                    _issue(
                        nid,
                        "SPLIT_MISMATCH",
                        "warning",
                        "the model was trained on a different split than the one being evaluated; "
                        "test rows may have been used for training",
                        "Evaluate on the same prep.split lineage the model was trained on",
                    )
                )
    return issues


def split_rules(tg: TypedGraph) -> list[CompileIssue]:
    issues = []
    for nid in tg.typed():
        ntype = tg.type_of(nid)
        if ntype == "source.dataset":
            rows = tg.outputs[nid]["out"].require_table().row_count
            if rows is not None and rows < SMALL_N:
                issues.append(
                    _issue(
                        nid, "SMALL_N", "warning", f"the dataset has {rows} rows; estimates will be unstable"
                    )
                )
        if ntype != SPLIT_TYPE:
            continue
        out = tg.outputs[nid]["out"]
        for part, rows in (out.partition_rows or {}).items():
            if rows < SMALL_N:
                issues.append(
                    _issue(
                        nid,
                        "SMALL_N",
                        "warning",
                        f"the {part} partition has {rows} rows; metric estimates will be unstable",
                        "Use more data, a larger fraction, or cross-validation",
                    )
                )
        params: Any = tg.params[nid]
        if not params.time_based:
            schema = tg.inputs[nid]["in"].require_table()
            dated = [
                c.name
                for c in schema.columns
                if (c.is_temporal or c.semantic == Semantic.DATETIME) and c.role == Role.FEATURE
            ]
            if dated:
                issues.append(
                    _issue(
                        nid,
                        "TEMPORAL_LEAKAGE_RISK",
                        "warning",
                        f"random split on data with datetime column(s) {dated}; if rows are ordered in "
                        "time, future rows leak into training",
                        "Set time_based with time_column, or set the column's role to 'ignore'",
                    )
                )
    return issues


def multiple_comparisons(tg: TypedGraph) -> list[CompileIssue]:
    g = tg.graph
    tests = [nid for nid in tg.typed() if g.impls[nid].is_hypothesis_test]
    corrected = any(g.impls[nid].is_correction for nid in tg.typed())
    if len(tests) > MAX_UNCORRECTED_TESTS and not corrected:
        return [
            _issue(
                None,
                "MULTIPLE_COMPARISONS",
                "warning",
                f"{len(tests)} hypothesis tests run with no multiple-comparison correction",
                "Add a correction node (e.g. Bonferroni or Holm)",
            )
        ]
    return []


RULES = (leakage_fit_before_split, leakage_resampling, model_rules, split_rules, multiple_comparisons)


def run_semantic_checks(tg: TypedGraph) -> list[CompileIssue]:
    issues: list[CompileIssue] = []
    for rule in RULES:
        issues.extend(rule(tg))
    return issues
