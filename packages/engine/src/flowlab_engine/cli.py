"""``flowlab`` command-line interface."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import click
from flowlab_nodes import catalogue_json
from flowspec import CompileIssue, CompileResult, FlowSpec, RunEvent, flow_spec_json_schema
from pydantic import ValidationError

from .compiler import compile_flow
from .datasets import load_schemas, profile_file, resolve_dataset_paths
from .executor import execute_plan
from .version import runner_version

EXIT_COMPILE_ERROR = 1
EXIT_RUN_FAILED = 2


def _load_spec(path: Path) -> FlowSpec:
    try:
        return FlowSpec.model_validate(json.loads(path.read_text()))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise click.ClickException(f"{path} is not a valid Flow Spec:\n{exc}") from exc


def _print_issue(issue: CompileIssue) -> None:
    color = "red" if issue.severity == "error" else "yellow"
    where = f"[{issue.node_id}] " if issue.node_id else ""
    click.secho(f"  {issue.severity.upper():7} {issue.code}: {where}{issue.message}", fg=color)
    if issue.suggestion:
        click.echo(f"          -> {issue.suggestion}")


def _compile(flow: Path, data: Path) -> tuple[FlowSpec, CompileResult, dict[str, Path]]:
    spec = _load_spec(flow)
    paths, errors = resolve_dataset_paths(spec, data)
    if errors:
        return spec, CompileResult(ok=False, errors=errors), paths
    return spec, compile_flow(spec, load_schemas(paths)), paths


@click.group()
@click.version_option(runner_version(), prog_name="flowlab")
def main() -> None:
    """FlowLab: visual pipelines for tabular data (Phase 0 engine)."""


@main.command()
@click.argument("flow", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option(
    "--data",
    "data_dir",
    required=True,
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    help="Directory containing the datasets named in dataset_bindings.",
)
@click.option(
    "--plan-out", type=click.Path(dir_okay=False, path_type=Path), help="Write the execution plan JSON."
)
@click.option("--json", "as_json", is_flag=True, help="Print the compile result as JSON.")
def compile(flow: Path, data_dir: Path, plan_out: Path | None, as_json: bool) -> None:
    """Validate and type-check a flow without running it."""
    _, result, _ = _compile(flow, data_dir)
    if as_json:
        click.echo(result.model_dump_json(indent=2, exclude={"plan"}))
    else:
        for issue in [*result.errors, *result.warnings]:
            _print_issue(issue)
        if result.ok and result.plan:
            click.secho(f"OK: {len(result.plan.steps)} steps, {len(result.warnings)} warning(s)", fg="green")
    if result.plan and plan_out:
        plan_out.write_text(result.plan.model_dump_json(indent=2))
    sys.exit(0 if result.ok else EXIT_COMPILE_ERROR)


@main.command()
@click.argument("flow", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option(
    "--data", "data_dir", required=True, type=click.Path(exists=True, file_okay=False, path_type=Path)
)
@click.option(
    "--runs-dir", type=click.Path(file_okay=False, path_type=Path), default=Path("runs"), show_default=True
)
@click.option(
    "--cache-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=Path(".flowlab/cache"),
    show_default=True,
)
@click.option("--no-cache", is_flag=True, help="Recompute every node.")
@click.option(
    "--export-dir",
    type=click.Path(file_okay=False, path_type=Path),
    help="Where sink.export writes (default: <run>/exports).",
)
@click.option("--events", "events_json", is_flag=True, help="Stream raw RunEvents as JSON lines.")
def run(
    flow: Path,
    data_dir: Path,
    runs_dir: Path,
    cache_dir: Path,
    no_cache: bool,
    export_dir: Path | None,
    events_json: bool,
) -> None:
    """Compile and execute a flow locally."""
    spec, result, paths = _compile(flow, data_dir)
    for issue in [*result.errors, *result.warnings]:
        _print_issue(issue)
    if not result.ok or result.plan is None:
        click.secho("Compilation failed; nothing was run.", fg="red", err=True)
        sys.exit(EXIT_COMPILE_ERROR)
    plan = result.plan
    total = len(plan.steps)
    types = {s.node_id: (s.index, s.node_type, s.label or "") for s in plan.steps}
    width = max(len(s.node_id) for s in plan.steps)

    def show(event: RunEvent) -> None:
        if events_json:
            click.echo(event.model_dump_json())
            return
        if event.type == "run_started":
            click.secho(
                f'\nFlowLab {event.run_id} · "{plan.flow_name}" · {total} nodes'
                f" · runner {plan.runner_version}",
                bold=True,
            )
        elif event.type in ("node_completed", "node_failed") and event.node_id:
            index, ntype, label = types[event.node_id]
            head = f"  [{index + 1}/{total}] {event.node_id:<{width}}  {ntype:<20} {label[:28]:<28}"
            if event.type == "node_failed":
                click.echo(head + click.style(" failed", fg="red"))
                click.secho(f"      {event.payload.get('code')}: {event.payload.get('message')}", fg="red")
            else:
                cached = event.payload.get("cache_hit")
                status = click.style("cached", fg="cyan") if cached else click.style("ok    ", fg="green")
                click.echo(f"{head} {status} {event.payload.get('duration_ms', 0):>6} ms")
        elif event.type == "node_warning":
            click.secho(f"      ! {event.payload.get('code')}: {event.payload.get('message')}", fg="yellow")

    outcome = execute_plan(
        plan,
        paths,
        runs_dir=runs_dir,
        cache_dir=None if no_cache else cache_dir,
        export_dir=export_dir,
        on_event=show,
    )
    if not events_json:
        click.echo("")
        for export in outcome.exports:
            click.echo(f"  exported  {export['path']}")
        colour = "green" if outcome.status == "completed" else "red"
        click.secho(f"Run {outcome.status}. Artifacts: {outcome.run_dir}", fg=colour, bold=True)
    sys.exit(0 if outcome.status == "completed" else EXIT_RUN_FAILED)


@main.command()
@click.argument("dataset", type=click.Path(exists=True, dir_okay=False, path_type=Path))
def profile(dataset: Path) -> None:
    """Infer and print a dataset's schema contract."""
    click.echo(profile_file(dataset).model_dump_json(indent=2, exclude_none=True))


@main.command("catalogue")
@click.option(
    "--out", type=click.Path(dir_okay=False, path_type=Path), help="Write to a file instead of stdout."
)
def catalogue_cmd(out: Path | None) -> None:
    """Print the node catalogue with JSON Schemas (the shared-truth artifact)."""
    text = catalogue_json()
    if out:
        out.write_text(text)
    else:
        click.echo(text, nl=False)


@main.command("spec-schema")
def spec_schema() -> None:
    """Print the Flow Spec JSON Schema."""
    click.echo(json.dumps(flow_spec_json_schema(), indent=2))


from flowlab_agent.cli import register as _register_agent_commands  # noqa: E402
from flowlab_api.cli import register as _register_api_commands  # noqa: E402
from flowlab_lab.cli import register as _register_lab_commands  # noqa: E402

_register_agent_commands(main)
_register_lab_commands(main)
_register_api_commands(main)


if __name__ == "__main__":
    main()
