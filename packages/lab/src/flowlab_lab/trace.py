"""Repo import by tracing (PRD II 7): run → trace → CodeGraph, plus trace comparison.

The graph reflects one execution with one configuration and is labelled as such. It is
read-only: no graph → code editing for traced repos.
"""

from __future__ import annotations

import datetime as dt
import json
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any

from flowspec import sha256_bytes

from .codegraph import CodeEdge, CodeGraph, CodeNode, FileRef, GraphSource, GraphWarning, NodeGroup
from .project import LabProject


class TraceError(RuntimeError):
    pass


def trace_project(
    project: LabProject,
    command: str | list[str],
    *,
    timeout_s: float = 300.0,
    max_per_site: int = 50,
) -> CodeGraph:
    argv = shlex.split(command) if isinstance(command, str) else list(command)
    project.init()
    stamp = dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%S%f")
    out = project.state_dir / "traces" / f"trace_{stamp}.json"
    tracer = [
        sys.executable, "-m", "flowlab_lab.tracer", "--root", str(project.root), "--out", str(out),
        "--timeout", str(timeout_s), "--max-per-site", str(max_per_site), "--", *argv,
    ]  # fmt: skip
    process = subprocess.run(
        tracer, cwd=project.root, capture_output=True, text=True, timeout=timeout_s + 60, check=False
    )
    if not out.exists():
        raise TraceError(f"tracer produced no output (exit {process.returncode}): {process.stderr[-2000:]}")
    data = json.loads(out.read_text(encoding="utf-8"))
    graph = trace_to_graph(project, data)
    out.with_suffix(".graph.json").write_text(graph.to_json(), encoding="utf-8")
    return graph


def _line_text(project: LabProject, file: str, line: int, cache: dict[str, list[str]]) -> str:
    if file not in cache:
        try:
            cache[file] = project.read(file).splitlines()
        except (OSError, ValueError):
            cache[file] = []
    lines = cache[file]
    return lines[line - 1].strip() if 0 < line <= len(lines) else ""


def _warnings(data: dict[str, Any], command: str) -> list[GraphWarning]:
    started = data.get("started_at")
    when = dt.datetime.fromisoformat(started).strftime("%H:%M") if started else "unknown time"
    warnings = [
        GraphWarning(
            code="TRACE_SCOPE",
            severity="info",
            message=(
                f"Traced from: `{command}` at {when}. This reflects one execution with one configuration."
            ),
        )
    ]
    if data.get("partial"):
        warnings.append(
            GraphWarning(
                code="TRACE_PARTIAL",
                message="The trace hit its time limit; this graph is partial. "
                "Retry with a longer timeout or a sampled dataset.",
            )
        )
    if data.get("error") or data.get("exit_code") not in (0, None):
        detail = data.get("error") or f"exit code {data.get('exit_code')}"
        warnings.append(
            GraphWarning(code="TRACE_FAILED", severity="error", message=f"The traced run failed: {detail}")
        )
    return warnings


def trace_to_graph(project: LabProject, data: dict[str, Any]) -> CodeGraph:
    cache: dict[str, list[str]] = {}
    ids: dict[tuple[str, int], str] = {}
    nodes: list[CodeNode] = []
    groups: dict[str, list[str]] = {}
    for index, site in enumerate(data.get("sites", []), 1):
        key = (site["file"], int(site["line"]))
        node_id = f"t{index}"
        ids[key] = node_id
        callees = sorted(site["callees"].items(), key=lambda kv: (-kv[1], kv[0]))
        label = callees[0][0].rsplit(".", 1)[-1] if callees else "call"
        if len(callees) > 1:
            label += f" +{len(callees) - 1}"
        group = f"{site['file']}::{site['function']}"
        groups.setdefault(group, []).append(node_id)
        nodes.append(
            CodeNode(
                id=node_id, kind="trace", file=site["file"], lines=[key[1], key[1]],
                source=_line_text(project, site["file"], key[1], cache), label=label,
                calls=[name for name, _ in callees], confidence="medium", group=group,
                flags=["sampled"] if site.get("sampled") else [],
            )
        )  # fmt: skip
    edges = []
    for edge in data.get("edges", []):
        source, target = (edge["from"][0], int(edge["from"][1])), (edge["to"][0], int(edge["to"][1]))
        if source in ids and target in ids:
            edges.append(
                CodeEdge(from_=ids[source], to=ids[target], variable=edge["type"], confidence="medium")
            )
    command = " ".join(shlex.quote(part) for part in data.get("command", []))
    files = sorted({n.file for n in nodes})
    return CodeGraph(
        source=GraphSource(
            kind="repo_trace",
            files=[FileRef(path=f, hash=sha256_bytes(project.resolve(f).read_bytes())) for f in files],
            trace_command=command,
            traced_at=data.get("started_at"),
        ),
        nodes=nodes,
        edges=edges,
        warnings=_warnings(data, command),
        groups=[
            NodeGroup(id=f"g{i}", label=f"{name.split('::')[1]} ({name.split('::')[0]})", node_ids=members)
            for i, (name, members) in enumerate(sorted(groups.items()), 1)
        ],
        partial=bool(data.get("partial")),
    )


def compare_traces(a: CodeGraph, b: CodeGraph) -> dict[str, list[str]]:
    """What differs between two traces of the same repo (e.g. dev vs prod config)."""

    def site(graph: CodeGraph, node_id: str) -> str:
        node = graph.node(node_id)
        return f"{node.file}:{node.lines[0]}" if node else node_id

    nodes_a = {site(a, n.id) for n in a.nodes}
    nodes_b = {site(b, n.id) for n in b.nodes}
    edges_a = {f"{site(a, e.from_)} -> {site(a, e.to)} [{e.variable}]" for e in a.edges}
    edges_b = {f"{site(b, e.from_)} -> {site(b, e.to)} [{e.variable}]" for e in b.edges}
    return {
        "nodes_only_in_a": sorted(nodes_a - nodes_b),
        "nodes_only_in_b": sorted(nodes_b - nodes_a),
        "edges_only_in_a": sorted(edges_a - edges_b),
        "edges_only_in_b": sorted(edges_b - edges_a),
    }


def load_trace_graph(path: Path) -> CodeGraph:
    return CodeGraph.model_validate_json(path.read_text(encoding="utf-8"))
