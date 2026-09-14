"""CLI commands: ``flowlab snippets ...``, ``flowlab ask`` and ``flowlab compose``."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import click
from pydantic import ValidationError

from .composer import ComposeResult, Plan, compose
from .digest import DatasetDigest
from .llm import CachedClient, GroqClient, LLMClient, UsageLog, estimate_tokens, load_api_key
from .planner import build_messages, plan_goal
from .retrieval import SnippetIndex
from .snippets import SnippetLibrary

STATE_DIR = Path(".flowlab")
DEFAULT_OUT = Path("generated/flowlab_script.py")


def _library() -> SnippetLibrary:
    library = SnippetLibrary.load()
    if library.issues:
        for issue in library.issues:
            click.secho(f"  {issue.path}: {issue.message}", fg="red", err=True)
        raise click.ClickException("the snippet library has problems; run `flowlab snippets check`")
    return library


def _print_compose(composed: ComposeResult) -> None:
    for number, step in enumerate(composed.steps, 1):
        flag = click.style(" auto", fg="cyan") if step.auto else ""
        shown = {k: v for k, v in step.values.items() if v != step.snippet.params[k].default}
        args = f"  {json.dumps(shown)}" if shown else ""
        click.echo(f"  {number:>2}. {step.snippet.id}{flag}{args}")
    for note in composed.adjustments:
        click.secho(f"      ~ {note}", fg="yellow")


def _write_and_maybe_run(script: str, out: Path, run_script: bool) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(script, encoding="utf-8")
    click.secho(f"Script written to {out}", fg="green", bold=True)
    if run_script:
        click.secho(f"Running {out} ...", bold=True)
        completed = subprocess.run([sys.executable, out.name], cwd=out.parent, check=False)
        if completed.returncode != 0:
            sys.exit(completed.returncode)


@click.group("snippets")
def snippets_group() -> None:
    """Browse and validate the snippet library."""


@snippets_group.command("list")
@click.option("--category", help="Only this category.")
def list_cmd(category: str | None) -> None:
    library = _library()
    for snippet in library:
        if category and snippet.category != category:
            continue
        flag = click.style(" [auto]", fg="cyan") if snippet.auto else ""
        click.echo(f"{snippet.id:<34} {snippet.title}{flag}")
    click.echo(f"\n{len(library)} snippets in {len(library.categories())} categories")


@snippets_group.command("search")
@click.argument("query")
@click.option("--data", "data_file", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option("-k", "top_k", default=12, show_default=True)
def search_cmd(query: str, data_file: Path | None, top_k: int) -> None:
    library = _library()
    digest = DatasetDigest.from_file(data_file) if data_file else None
    for snippet, score in SnippetIndex(library).search(query, digest=digest, k=top_k):
        click.echo(f"{score:6.2f}  {snippet.signature()}")


@snippets_group.command("show")
@click.argument("snippet_id")
def show_cmd(snippet_id: str) -> None:
    library = _library()
    snippet = library.get(snippet_id)
    if snippet is None:
        raise click.ClickException(f"unknown snippet '{snippet_id}'")
    click.secho(snippet.signature(), bold=True)
    click.echo(snippet.description)
    click.echo(f"requires: {snippet.requires or '-'}   provides: {snippet.provides or '-'}")
    click.echo("\n".join(snippet.imports))
    click.echo(snippet.code)


@snippets_group.command("check")
def check_cmd() -> None:
    library = SnippetLibrary.load()
    for issue in library.issues:
        click.secho(f"  {issue.path}: {issue.message}", fg="red")
    if library.issues:
        sys.exit(1)
    click.secho(f"OK: {len(library)} snippets, {len(library.categories())} categories", fg="green")


@click.command()
@click.argument("goal")
@click.option(
    "--data", "data_file", required=True, type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option(
    "--out", type=click.Path(dir_okay=False, path_type=Path), default=DEFAULT_OUT, show_default=True
)
@click.option(
    "--model", "model_name", help="Groq model (default: $FLOWLAB_LLM_MODEL or llama-3.3-70b-versatile)."
)
@click.option("-k", "top_k", default=12, show_default=True, help="Snippets offered to the LLM.")
@click.option("--dry-run", is_flag=True, help="Print the exact prompt and a token estimate; no API call.")
@click.option("--no-cache", is_flag=True, help="Ignore cached LLM replies.")
@click.option("--run", "run_script", is_flag=True, help="Execute the generated script.")
def ask(
    goal: str,
    data_file: Path,
    out: Path,
    model_name: str | None,
    top_k: int,
    dry_run: bool,
    no_cache: bool,
    run_script: bool,
) -> None:
    """Describe a goal; the LLM picks snippets and FlowLab assembles the script."""
    library = _library()
    digest = DatasetDigest.from_file(data_file)
    if dry_run:
        candidates = SnippetIndex(library).search(goal, digest=digest, k=top_k)
        messages = build_messages(goal, digest, [s.signature() for s, _ in candidates])
        for message in messages:
            click.secho(f"--- {message.role} ---", bold=True)
            click.echo(message.content)
        click.secho(f"\n~{estimate_tokens(messages)} prompt tokens (estimate)", fg="cyan")
        return

    api_key = load_api_key()
    if not api_key:
        raise click.ClickException(
            "GROQ_API_KEY is not set. Export it or put it in a .env file (see .env.example)."
        )
    client: LLMClient = GroqClient(api_key, model_name)
    if not no_cache:
        client = CachedClient(client, STATE_DIR / "llm_cache")
    result = plan_goal(
        goal, digest, client, library, k=top_k, usage_log=UsageLog(STATE_DIR / "llm_usage.jsonl")
    )

    for number, attempt in enumerate(result.attempts, 1):
        source = "cache" if attempt.cached else f"{attempt.prompt_tokens}+{attempt.completion_tokens} tokens"
        status = (
            click.style("ok", fg="green")
            if not attempt.errors
            else click.style(f"{len(attempt.errors)} problem(s)", fg="yellow")
        )
        click.echo(f"  attempt {number}: {source}, {status}")
        for error in attempt.errors:
            click.secho(f"      - {error}", fg="yellow")
    if not result.ok or result.composed is None or result.composed.script is None:
        raise click.ClickException(result.error or "planning failed")
    click.secho(f"\nPlan ({result.tokens_spent} tokens spent):", bold=True)
    if result.plan and result.plan.note:
        click.echo(f"  {result.plan.note}")
    _print_compose(result.composed)
    _write_and_maybe_run(result.composed.script, out, run_script)


@click.command("compose")
@click.argument("plan_file", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option(
    "--data", "data_file", required=True, type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option(
    "--out", type=click.Path(dir_okay=False, path_type=Path), default=DEFAULT_OUT, show_default=True
)
@click.option("--run", "run_script", is_flag=True, help="Execute the generated script.")
def compose_cmd(plan_file: Path, data_file: Path, out: Path, run_script: bool) -> None:
    """Assemble a script from a hand-written plan JSON (zero tokens)."""
    try:
        plan = Plan.model_validate(json.loads(plan_file.read_text(encoding="utf-8")))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise click.ClickException(f"invalid plan: {exc}") from exc
    composed = compose(plan, _library(), DatasetDigest.from_file(data_file))
    _print_compose(composed)
    if not composed.ok or composed.script is None:
        for error in composed.errors:
            click.secho(f"  - {error}", fg="red", err=True)
        sys.exit(1)
    _write_and_maybe_run(composed.script, out, run_script)


def register(group: click.Group) -> None:
    group.add_command(snippets_group)
    group.add_command(ask)
    group.add_command(compose_cmd)
