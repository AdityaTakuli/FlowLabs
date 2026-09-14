"""Stage 1: structural validation (ids, node types, ports, required inputs, acyclicity)."""

from __future__ import annotations

import difflib
import heapq
from dataclasses import dataclass, field
from typing import Any

from flowlab_nodes import Node, get_node, node_types
from flowspec import CompileIssue, EdgeSpec, FlowSpec, NodeSpec

MAX_NODES = 200
SOFT_MAX_NODES = 100


@dataclass
class FlowGraph:
    spec: FlowSpec
    nodes: dict[str, NodeSpec]
    impls: dict[str, Node[Any]]
    inbound: dict[str, dict[str, EdgeSpec]]
    outbound: dict[str, list[EdgeSpec]]
    order: list[str]
    _desc: dict[str, frozenset[str]] = field(default_factory=dict)
    _anc: dict[str, frozenset[str]] = field(default_factory=dict)

    def label(self, node_id: str) -> str:
        node = self.nodes[node_id]
        return f"{node.type} '{node.label or node.id}'"

    def descendants(self, node_id: str) -> frozenset[str]:
        if node_id not in self._desc:
            out: set[str] = set()
            for edge in self.outbound[node_id]:
                out.add(edge.target)
                out |= self.descendants(edge.target)
            self._desc[node_id] = frozenset(out)
        return self._desc[node_id]

    def ancestors(self, node_id: str) -> frozenset[str]:
        if node_id not in self._anc:
            out: set[str] = set()
            for edge in self.inbound[node_id].values():
                out.add(edge.source)
                out |= self.ancestors(edge.source)
            self._anc[node_id] = frozenset(out)
        return self._anc[node_id]

    def upstream_of_port(self, node_id: str, port: str) -> frozenset[str]:
        edge = self.inbound[node_id].get(port)
        if edge is None:
            return frozenset()
        return self.ancestors(edge.source) | {edge.source}


def _error(node_id: str | None, code: str, message: str, suggestion: str | None = None) -> CompileIssue:
    return CompileIssue(node_id=node_id, code=code, severity="error", message=message, suggestion=suggestion)


def build_graph(spec: FlowSpec) -> tuple[FlowGraph | None, list[CompileIssue], list[CompileIssue]]:
    errors: list[CompileIssue] = []
    warnings: list[CompileIssue] = []

    if not spec.nodes:
        errors.append(_error(None, "EMPTY_FLOW", "the flow has no nodes"))
    if len(spec.nodes) > MAX_NODES:
        errors.append(
            _error(None, "TOO_MANY_NODES", f"{len(spec.nodes)} nodes exceeds the limit of {MAX_NODES}")
        )
    elif len(spec.nodes) > SOFT_MAX_NODES:
        warnings.append(
            CompileIssue(
                node_id=None,
                code="MANY_NODES",
                severity="warning",
                message=f"{len(spec.nodes)} nodes; consider splitting the flow",
            )
        )

    nodes: dict[str, NodeSpec] = {}
    impls: dict[str, Node[Any]] = {}
    for node in spec.nodes:
        if node.id in nodes:
            errors.append(_error(node.id, "DUPLICATE_NODE_ID", f"node id '{node.id}' is used more than once"))
            continue
        nodes[node.id] = node
        impl = get_node(node.type)
        if impl is None:
            close = difflib.get_close_matches(node.type, node_types(), n=1)
            errors.append(
                _error(
                    node.id,
                    "UNKNOWN_NODE_TYPE",
                    f"node type '{node.type}' is not in the catalogue",
                    f"Did you mean '{close[0]}'?" if close else None,
                )
            )
        else:
            impls[node.id] = impl

    inbound: dict[str, dict[str, EdgeSpec]] = {nid: {} for nid in nodes}
    outbound: dict[str, list[EdgeSpec]] = {nid: [] for nid in nodes}
    edge_ids: set[str] = set()
    for edge in spec.edges:
        if edge.id in edge_ids:
            errors.append(_error(None, "DUPLICATE_EDGE_ID", f"edge id '{edge.id}' is used more than once"))
            continue
        edge_ids.add(edge.id)
        missing = [n for n in (edge.source, edge.target) if n not in nodes]
        if missing:
            errors.append(
                _error(None, "EDGE_UNKNOWN_NODE", f"edge '{edge.id}' references unknown node(s) {missing}")
            )
            continue
        src, tgt = impls.get(edge.source), impls.get(edge.target)
        if src is None or tgt is None:
            continue
        src_port = src.outputs.get(edge.source_port)
        tgt_port = tgt.inputs.get(edge.target_port)
        if src_port is None:
            errors.append(
                _error(
                    edge.source,
                    "UNKNOWN_PORT",
                    f"{src.type} has no output port '{edge.source_port}'",
                    "Output ports: " + (", ".join(src.outputs) or "none"),
                )
            )
            continue
        if tgt_port is None:
            errors.append(
                _error(
                    edge.target,
                    "UNKNOWN_PORT",
                    f"{tgt.type} has no input port '{edge.target_port}'",
                    "Input ports: " + (", ".join(tgt.inputs) or "none"),
                )
            )
            continue
        if edge.target_port in inbound[edge.target]:
            errors.append(
                _error(
                    edge.target,
                    "MULTIPLE_INPUTS",
                    f"input port '{edge.target_port}' has more than one incoming edge",
                )
            )
            continue
        if not set(src_port.types) & set(tgt_port.types):
            errors.append(
                _error(
                    edge.target,
                    "PORT_TYPE_MISMATCH",
                    f"cannot connect {'/'.join(src_port.types)} output '{edge.source_port}' of "
                    f"'{edge.source}' to input '{edge.target_port}', which accepts "
                    f"{'/'.join(tgt_port.types)}",
                )
            )
            continue
        inbound[edge.target][edge.target_port] = edge
        outbound[edge.source].append(edge)

    for nid, impl in impls.items():
        for port, pdef in impl.inputs.items():
            if pdef.required and port not in inbound[nid]:
                errors.append(
                    _error(
                        nid,
                        "MISSING_INPUT",
                        f"required input port '{port}' ({'/'.join(pdef.types)}) is not connected",
                        "Connect an upstream node to this port",
                    )
                )

    index = {nid: i for i, nid in enumerate(nodes)}
    indegree = {nid: len(inbound[nid]) for nid in nodes}
    heap = [(index[n], n) for n, d in indegree.items() if d == 0]
    heapq.heapify(heap)
    order: list[str] = []
    while heap:
        _, nid = heapq.heappop(heap)
        order.append(nid)
        for edge in outbound[nid]:
            indegree[edge.target] -= 1
            if indegree[edge.target] == 0:
                heapq.heappush(heap, (index[edge.target], edge.target))
    if len(order) < len(nodes):
        cycle = _find_cycle({n for n in nodes if n not in order}, outbound)
        path = " -> ".join([*cycle, cycle[0]]) if cycle else "unknown"
        for nid in cycle or sorted(n for n in nodes if n not in order):
            errors.append(
                _error(
                    nid,
                    "CYCLE_DETECTED",
                    f"the graph contains a cycle: {path}",
                    "Remove one of the edges in the cycle",
                )
            )

    if errors:
        return None, errors, warnings
    return FlowGraph(spec, nodes, impls, inbound, outbound, order), errors, warnings


def _find_cycle(remaining: set[str], outbound: dict[str, list[EdgeSpec]]) -> list[str]:
    color: dict[str, int] = {}
    stack: list[str] = []

    def visit(nid: str) -> list[str] | None:
        color[nid] = 1
        stack.append(nid)
        for edge in outbound[nid]:
            nxt = edge.target
            if nxt not in remaining:
                continue
            if color.get(nxt) == 1:
                return stack[stack.index(nxt) :]
            if nxt not in color and (found := visit(nxt)):
                return found
        stack.pop()
        color[nid] = 2
        return None

    for nid in sorted(remaining):
        if nid not in color and (found := visit(nid)):
            return found
    return []
