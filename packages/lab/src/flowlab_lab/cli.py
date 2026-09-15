"""``flowlab lab ...`` (Code Mode) and ``flowlab eject`` commands."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import click
from flowspec import FlowSpec
from pydantic import ValidationError

from .codegraph import CodeGraph
from .diff import DataDiff
from .eject import EjectError, eject_flow
from .kernel import ExecutionRecord, LabEvent, LabSession, RunMode
from .privacy import OutboundPolicy, first_open_warning, transmission_badge
from .project import LabProject, PathError
from .resources import host_environment, system_resources
from .to_flow import ConversionError, convert_section
from .trace import TraceError, trace_project
from .transforms import TransformError, apply_transform, revert_last

ROOT_OPTION = click.option(
    "--root",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    default=Path("."),
    show_default=True,
)
STYLE = {
    "high": "green",
    "medium": "yellow",
    "low": "red",
    "error": "red",
    "warning": "yellow",
    "info": "cyan",
}


def _project(root: Path) -> LabProject:
    try:
        return LabProject(root)
    except PathError as exc:
        raise click.ClickException(str(exc)) from exc


def _relative(project: LabProject, file: str) -> str:
    candidate = Path(file)
    if candidate.is_absolute():
        return project.relative(candidate)
    try:
        return project.relative(project.resolve(file))
    except PathError as exc:
        raise click.ClickException(str(exc)) from exc


def _print_graph(graph: CodeGraph) -> None:
    for node in graph.nodes:
        colour = STYLE[node.confidence]
        badges = " ".join(
            f"[{f}]"
            for f in (*node.flags, *(["loop:" + ",".join(node.loop_carried)] if node.loop_carried else []))
        )
        pattern = f" <{node.matched_pattern}>" if node.matched_pattern else ""
        click.echo(
            f"  {click.style(node.id, bold=True):<18} {click.style(node.confidence, fg=colour):<16} "
            f"{node.label[:40]}{pattern} {badges}".rstrip()
        )
        if node.defines or node.uses:
            click.echo(f"      defines {', '.join(node.defines) or '-'} · uses {', '.join(node.uses) or '-'}")
    if graph.edges:
        click.secho("edges", bold=True)
        for edge in graph.edges:
            arrow = "~>" if edge.kind == "mutation" else "->"
            click.echo(
                f"  {edge.from_} {arrow} {edge.to}  `{edge.variable}` ({edge.kind}, {edge.confidence})"
            )
    for warning in graph.warnings:
        where = f"[{warning.node_id}] " if warning.node_id else ""
        click.secho(
            f"  {warning.severity.upper():7} {warning.code}: {where}{warning.message}",
            fg=STYLE[warning.severity],
        )


def _print_record(record: ExecutionRecord) -> None:
    colour = "green" if record.status == "success" else "red"
    rows_in = "-" if record.rows_in is None else record.rows_in
    rows_out = "-" if record.rows_out is None else record.rows_out
    rows = f"{rows_in} → {rows_out}"
    memory = f"{record.peak_memory_mb:.0f} MB" if record.peak_memory_mb else "-"
    click.echo(
        f"  {record.node_id:<6} {click.style(record.status, fg=colour):<18} {record.duration_ms:>6} ms  "
        f"peak {memory:>8}  rows {rows}"
    )
    for warning in record.warnings:
        click.secho(f"      ! {warning.code}: {warning.message}", fg="yellow")
    if record.error:
        click.secho(f"      {record.error.ename}: {record.error.evalue}", fg="red")
        for frame in record.error.frames[:3]:
            click.secho(
                f"        at {frame.node_id or '?'} line {frame.file_line or frame.line}: {frame.text}",
                fg="red",
            )


@click.group("lab")
def lab_group() -> None:
    """Code Mode: your notebooks and scripts as a live dependency graph, run on this machine."""


@lab_group.command("init")
@click.argument("path", type=click.Path(exists=True, file_okay=False, path_type=Path), default=Path("."))
def init_cmd(path: Path) -> None:
    """Create .flowlab/, add it to .gitignore and print what would be transmitted."""
    project = _project(path)
    config = project.init()
    click.secho(f"Initialised {project.root}", fg="green", bold=True)
    click.echo(f"  state: {project.state_dir} (gitignored)")
    policy = OutboundPolicy(local_only=config.local_only, max_preview_rows=config.max_preview_rows)
    click.echo(f"  {transmission_badge(policy)}")
    click.echo(f"  {len(project.index())} Python/notebook files indexed")


@lab_group.command("files")
@ROOT_OPTION
def files_cmd(root: Path) -> None:
    for path in _project(root).index():
        click.echo(path)


@lab_group.command("graph")
@click.argument("file")
@ROOT_OPTION
@click.option("--json", "as_json", is_flag=True, help="Print the CodeGraph JSON.")
@click.option("--mermaid", is_flag=True, help="Print a Mermaid flowchart.")
def graph_cmd(file: str, root: Path, as_json: bool, mermaid: bool) -> None:
    """Analyse a notebook or script into a dependency graph (no code is executed)."""
    project = _project(root)
    graph = project.analyse(_relative(project, file))
    if as_json:
        click.echo(graph.to_json())
        return
    if mermaid:
        click.echo(graph.to_mermaid())
        return
    click.secho(
        f"{graph.source.files[0].path}: {len(graph.code_nodes())} blocks, {len(graph.edges)} edges "
        f"({graph.analysis_ms} ms)",
        bold=True,
    )
    _print_graph(graph)
    warning = first_open_warning(graph)
    if warning:
        click.secho(f"\n{warning}", fg="yellow")


@lab_group.command("run")
@click.argument("file")
@ROOT_OPTION
@click.option("--node", "node_id", help="Target block, e.g. b4.")
@click.option(
    "--mode", type=click.Choice(["node", "to", "from", "all"]), help="Default: 'to' with --node, else 'all'."
)
@click.option("--timeout", "timeout_s", type=float, default=600.0, show_default=True)
@click.option("--quiet", is_flag=True, help="Hide stdout from the blocks.")
def run_cmd(
    file: str, root: Path, node_id: str | None, mode: str | None, timeout_s: float, quiet: bool
) -> None:
    """Execute blocks in a local kernel with profiling, snapshots and hidden-state checks."""
    project = _project(root)
    relative = _relative(project, file)

    def on_event(event: LabEvent) -> None:
        if event.type == "stream" and not quiet:
            click.echo(f"      │ {event.data.get('text', '').rstrip()}")

    chosen: RunMode = mode or ("to" if node_id else "all")  # type: ignore[assignment]
    with LabSession(project, relative, on_event=on_event, timeout_s=timeout_s) as session:
        env = session.environment
        packages = len(env.get("packages", {}))
        click.secho(
            f"kernel: Python {env.get('python')} · pid {session.pid} · {packages} packages", bold=True
        )
        try:
            records = session.execute(node_id, chosen)
        except KeyError as exc:
            raise click.ClickException(str(exc)) from exc
        for record in records:
            _print_record(record)
        for warning in session.hidden_state():
            click.secho(f"  {warning.code}: {warning.message}", fg=STYLE[warning.severity])
        resources = session.resources()
        click.echo(
            f"  RAM available {resources['ram_available_mb']:.0f} MB · "
            f"kernel {resources['kernel_memory_mb']} MB"
        )
    if any(r.status != "success" for r in records):
        sys.exit(1)


@lab_group.command("diff")
@click.argument("file")
@click.argument("node_a")
@click.argument("node_b")
@ROOT_OPTION
@click.option("--variable", help="Variable to compare (default: shared or largest table).")
def diff_cmd(file: str, node_a: str, node_b: str, root: Path, variable: str | None) -> None:
    """Run up to two blocks and show how the data changed between them."""
    project = _project(root)
    with LabSession(project, _relative(project, file)) as session:
        for target in (node_a, node_b):
            records = session.execute(target, "to")
            if records and records[-1].status != "success":
                _print_record(records[-1])
                raise click.ClickException(f"{target} failed; cannot diff")
        result: DataDiff | None = session.diff(node_a, node_b, variable)
    if result is None:
        raise click.ClickException("no comparable table-like variables at those blocks")
    click.echo(result.format())


@lab_group.command("transform")
@click.argument("file")
@click.argument(
    "op",
    type=click.Choice(
        ["reorder", "split", "merge", "delete", "duplicate", "extract", "insert", "add_markers"]
    ),
)
@ROOT_OPTION
@click.option("--node", "nodes", multiple=True, help="Block id(s) the operation applies to.")
@click.option("--before", help="reorder: place before this block.")
@click.option("--after", help="reorder/insert: place after this block.")
@click.option("--line", type=int, help="split: first line of the new block (within the block).")
@click.option("--name", help="extract: function name.")
@click.option("--suffix", help="duplicate: suffix for renamed variables.")
@click.option("--source", "code", help="insert: code for the new block.")
@click.option("--yes", is_flag=True, help="delete: confirm breaking downstream blocks.")
def transform_cmd(
    file: str, op: str, root: Path, nodes: tuple[str, ...], before: str | None, after: str | None,
    line: int | None, name: str | None, suffix: str | None, code: str | None, yes: bool,
) -> None:  # fmt: skip
    """Edit the source through the graph: every change is validated, backed up and undoable."""
    project = _project(root)
    relative = _relative(project, file)
    options = {"before": before, "after": after, "line": line, "name": name, "suffix": suffix, "source": code}
    params = {key: value for key, value in options.items() if value is not None}
    node_ids = list(nodes)
    if op == "insert" and after:
        node_ids, params = [after], {k: v for k, v in params.items() if k != "after"}
    try:
        result = apply_transform(project, relative, op, node_ids=node_ids, params=params, confirm=yes)  # type: ignore[arg-type]
    except TransformError as exc:
        extra = f" ({', '.join(exc.details['downstream'])})" if "downstream" in exc.details else ""
        raise click.ClickException(f"{exc.code}: {exc.message}{extra}") from exc
    click.secho(f"{result.message}", fg="green", bold=True)
    click.echo(f"  backup: {Path(result.backup).name} · undo with `flowlab lab revert {relative}`")
    click.echo(f"  now {len(result.graph.code_nodes())} blocks, {len(result.graph.edges)} edges")


@lab_group.command("revert")
@click.argument("file")
@ROOT_OPTION
def revert_cmd(file: str, root: Path) -> None:
    """Undo the most recent transformation of FILE."""
    project = _project(root)
    try:
        backup = revert_last(project, _relative(project, file))
    except TransformError as exc:
        raise click.ClickException(exc.message) from exc
    click.secho(f"Restored from {backup.name}", fg="green")


@lab_group.command("trace", context_settings={"ignore_unknown_options": True})
@ROOT_OPTION
@click.option("--timeout", "timeout_s", type=float, default=300.0, show_default=True)
@click.option("--json", "as_json", is_flag=True)
@click.argument("command", nargs=-1, type=click.UNPROCESSED, required=True)
def trace_cmd(root: Path, timeout_s: float, as_json: bool, command: tuple[str, ...]) -> None:
    """Build a graph by running an entry point under instrumentation, e.g. `-- python train.py`."""
    project = _project(root)
    try:
        graph = trace_project(project, list(command), timeout_s=timeout_s)
    except TraceError as exc:
        raise click.ClickException(str(exc)) from exc
    if as_json:
        click.echo(graph.to_json())
        return
    click.secho(
        f"{len(graph.nodes)} sites, {len(graph.edges)} edges across {len(graph.groups)} functions", bold=True
    )
    _print_graph(graph)


@lab_group.command("to-flow")
@click.argument("file")
@ROOT_OPTION
@click.option("--node", "nodes", multiple=True, required=True, help="Contiguous block ids to convert.")
@click.option(
    "--out", type=click.Path(dir_okay=False, path_type=Path), help="Write the draft Flow Spec here."
)
def to_flow_cmd(file: str, root: Path, nodes: tuple[str, ...], out: Path | None) -> None:
    """Draft a Flow Mode spec from a recognised section of code (you review it before use)."""
    project = _project(root)
    try:
        conversion = convert_section(project.analyse(_relative(project, file)), list(nodes))
    except ConversionError as exc:
        raise click.ClickException(str(exc)) from exc
    text = json.dumps(conversion.spec, indent=2)
    if out:
        out.write_text(text + "\n")
        click.secho(f"Draft written to {out}", fg="green")
    else:
        click.echo(text)
    for block, reason in conversion.skipped:
        click.secho(f"  skipped {block}: {reason}", fg="yellow", err=True)
    for note in conversion.notes:
        click.echo(f"  note {note}", err=True)


@lab_group.command("env")
@ROOT_OPTION
def env_cmd(root: Path) -> None:
    """Show this machine's environment and live resources."""
    click.echo(json.dumps({**host_environment(), **system_resources(_project(root).root)}, indent=2))


@lab_group.command("watch")
@ROOT_OPTION
@click.option("--interval", type=float, default=1.0, show_default=True)
@click.option("--once", is_flag=True, help="Poll a single time (for scripting).")
def watch_cmd(root: Path, interval: float, once: bool) -> None:
    """Re-analyse files as they change on disk."""
    project = _project(root)
    project.init()
    project.watcher.prime()
    click.secho(f"Watching {project.root} (Ctrl+C to stop)", bold=True)
    try:
        while True:
            for change in project.watcher.poll():
                if change.kind == "deleted":
                    click.echo(f"  deleted {change.path}")
                    continue
                graph = project.analyse(change.path)
                click.echo(
                    f"  {change.kind} {change.path}: {len(graph.code_nodes())} blocks, "
                    f"{len(graph.edges)} edges, {len(graph.warnings)} warnings"
                )
            if once:
                break
            time.sleep(interval)
    except KeyboardInterrupt:
        click.echo("stopped")


@lab_group.command("architecture")
@ROOT_OPTION
@click.option("--json", "as_json", is_flag=True, help="Print the architecture manifest JSON.")
@click.option(
    "--out",
    type=click.Path(dir_okay=False, path_type=Path),
    help="Write the manifest JSON here (default: .flowlab/architecture/manifest.json).",
)
@click.option(
    "--git/--no-git", default=True, show_default=True, help="Use git history as a clustering signal."
)
def architecture_cmd(root: Path, as_json: bool, out: Path | None, git: bool) -> None:
    """Decompose the project into components and units (Code Segregation Bylaws). No model, no tokens."""
    from .segregation import SegregationError, SegregationOptions, analyse_architecture

    project = _project(root)
    project.init()
    try:
        manifest = analyse_architecture(project.root, SegregationOptions(use_git=git))
    except SegregationError as exc:
        raise click.ClickException(str(exc)) from exc
    target = out or project.state_dir / "architecture" / "manifest.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(manifest.to_json(), encoding="utf-8")
    if as_json:
        click.echo(manifest.to_json())
        return
    stats = manifest.stats
    click.secho(
        f"{stats.components} components, {stats.units} units, {stats.unassigned_units} unassigned · "
        f"{stats.sloc} SLOC · {stats.clustering} ({stats.files} files)",
        bold=True,
    )
    for component in manifest.components:
        colour = STYLE[component.confidence]
        click.echo(
            f"  {click.style(component.name, bold=True):<32} "
            f"{click.style(component.archetype, fg=colour):<22} "
            f"{len(component.units):>3} units  {component.sloc:>5} SLOC  {component.confidence}"
        )
    if manifest.unassigned:
        click.secho("unassigned", bold=True)
        by_id = {u.id: u for u in manifest.units}
        for uid in manifest.unassigned:
            unit = by_id.get(uid)
            if unit:
                click.echo(f"  {unit.qualified_name}  {unit.file}:{unit.line_start}")
    if manifest.findings:
        click.secho("findings", bold=True)
        for finding in manifest.findings:
            click.secho(
                f"  {finding.severity.upper():7} {finding.code}: {finding.message}",
                fg=STYLE[finding.severity],
            )
    try:
        shown = project.relative(target)
    except ValueError:
        shown = str(target)
    click.echo(f"  wrote {shown}")


@click.command("eject")
@click.argument("flow", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option(
    "--data", "data_dir", required=True, type=click.Path(exists=True, file_okay=False, path_type=Path)
)
@click.option("--format", "fmt", type=click.Choice(["ipynb", "py"]), default="ipynb", show_default=True)
@click.option("--out", type=click.Path(dir_okay=False, path_type=Path), required=True)
def eject_cmd(flow: Path, data_dir: Path, fmt: str, out: Path) -> None:
    """Export a Flow Mode graph as a readable notebook or script you own."""
    try:
        spec = FlowSpec.model_validate_json(flow.read_text())
        text = eject_flow(spec, data_dir, fmt=fmt)  # type: ignore[arg-type]
    except (ValidationError, EjectError) as exc:
        raise click.ClickException(str(exc)) from exc
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    click.secho(f"Ejected {spec.name} to {out}", fg="green")


def register(group: click.Group) -> None:
    group.add_command(lab_group)
    group.add_command(eject_cmd)
