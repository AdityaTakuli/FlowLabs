"""``flowlab serve``: the local web canvas."""

from __future__ import annotations

import os
import secrets
import threading
import webbrowser
from pathlib import Path

import click

from .app import DEFAULT_STATIC, create_app


@click.command("serve")
@click.option(
    "--root",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    default=Path("."),
    show_default=True,
    help="Project folder with your notebooks and scripts.",
)
@click.option("--port", type=int, default=8765, show_default=True)
@click.option("--open/--no-open", "open_browser", default=True, help="Open the canvas in your browser.")
def serve(root: Path, port: int, open_browser: bool) -> None:
    """Open the FlowLab canvas for a local folder (listens on 127.0.0.1 only)."""
    import uvicorn

    token = os.environ.get("FLOWLAB_TOKEN") or secrets.token_urlsafe(24)
    app = create_app(root, token)
    url = f"http://127.0.0.1:{port}/?token={token}"
    click.secho(f"FlowLab canvas for {root.resolve()}", bold=True)
    if (DEFAULT_STATIC / "index.html").is_file():
        click.echo(f"  open: {url}")
    else:
        click.secho(
            "  web UI not built: run `npm run build` in apps/web, or `npm run dev` there", fg="yellow"
        )
    click.echo(f"  dev UI (npm run dev): http://localhost:5173/?token={token}")
    click.echo("  Code runs on this machine. Keep the token private; Ctrl+C stops the server.")
    if open_browser and (DEFAULT_STATIC / "index.html").is_file():
        threading.Timer(1.2, webbrowser.open, [url]).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


def register(group: click.Group) -> None:
    group.add_command(serve)
