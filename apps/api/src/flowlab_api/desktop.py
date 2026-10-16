"""``flowlab app``: FlowLab as a desktop application on Linux, macOS and Windows.

The window is the same canvas the browser serves; it runs against a local server started in this
process on a free port, reachable only from this machine and only with a per-launch token. A
native window is used when a webview is available (WebKitGTK, WKWebView, WebView2); otherwise the
default browser opens, which keeps the app usable everywhere.

Code you run still executes in a Python environment *you* choose (see ``flowlab_lab.interpreters``),
never inside the packaged runtime, so your own packages are the ones that matter.
"""

from __future__ import annotations

import contextlib
import os
import secrets
import shutil
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any

WINDOW_TITLE = "FlowLab"
WINDOW_SIZE = (1440, 920)
EXAMPLES = Path(__file__).resolve().parent / "examples"


def free_port(preferred: int = 8765) -> int:
    for port in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
                return int(probe.getsockname()[1])
            except OSError:
                continue
    raise RuntimeError("no free port on 127.0.0.1")


def default_workspace() -> Path:
    """Where the app opens when no folder is given: the last one used, else a new ~/FlowLab."""
    from .workbench import default_recents_path

    recents = default_recents_path()
    if recents.is_file():
        import json

        with contextlib.suppress(OSError, ValueError):
            for entry in json.loads(recents.read_text(encoding="utf-8")):
                if isinstance(entry, str) and Path(entry).is_dir():
                    return Path(entry)
    workspace = Path.home() / "FlowLab"
    if not workspace.exists():
        workspace.mkdir(parents=True, exist_ok=True)
        if EXAMPLES.is_dir():
            shutil.copytree(EXAMPLES / "ml-lab", workspace / "ml-lab", dirs_exist_ok=True)
    return workspace


class Server:
    """The local FlowLab server on a background thread."""

    def __init__(self, root: Path, port: int, token: str) -> None:
        import uvicorn

        from .app import create_app

        self.url = f"http://127.0.0.1:{port}/?token={token}"
        self.root = root
        config = uvicorn.Config(create_app(root, token), host="127.0.0.1", port=port, log_level="warning")
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(target=self._server.run, name="flowlab-server", daemon=True)

    def start(self, timeout_s: float = 30.0) -> None:
        self._thread.start()
        deadline = time.monotonic() + timeout_s
        while not self._server.started and self._thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.05)
        if not self._server.started:
            raise RuntimeError("the FlowLab server did not start")

    def stop(self) -> None:
        self._server.should_exit = True
        self._thread.join(timeout=10)


def _webview() -> Any | None:
    try:
        import webview  # type: ignore[import-not-found]  # optional; packaged builds ship it
    except ImportError:
        return None
    return webview


def launch(root: Path, *, port: int | None = None, window: bool = True, quiet: bool = False) -> int:
    """Start the server and show the app. Returns a process exit code."""
    token = os.environ.get("FLOWLAB_TOKEN") or secrets.token_urlsafe(24)
    server = Server(root, port or free_port(), token)
    server.start()
    if not quiet:
        print(f"FlowLab workspace: {root}")
        print(f"  {server.url}")
    webview = _webview() if window else None
    try:
        if webview is not None:
            webview.create_window(WINDOW_TITLE, server.url, width=WINDOW_SIZE[0], height=WINDOW_SIZE[1])
            webview.start()  # returns when the user closes the window
            return 0
        if window and not quiet:
            print("  no native webview available: opening your browser instead")
        webbrowser.open(server.url)
        if not quiet:
            print("  Ctrl+C closes FlowLab.")
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        return 0
    finally:
        server.stop()


def check(root: Path, port: int | None = None) -> int:
    """Start the server, prove it serves the canvas, stop it. Used to smoke-test builds."""
    import urllib.request

    server = Server(root, port or free_port(), "check-token")
    server.start()
    try:
        base = server.url.split("/?")[0]
        with urllib.request.urlopen(f"{base}/api/health", timeout=20) as health:
            assert health.status == 200, health.status
        with urllib.request.urlopen(base, timeout=20) as page:
            body = page.read().decode("utf-8", errors="replace")
        if "<title>FlowLab</title>" not in body:
            print("the canvas is missing from this build", file=sys.stderr)
            return 1
        print(f"FlowLab serves the canvas from {base} (workspace {root})")
        return 0
    finally:
        server.stop()


def main(argv: list[str] | None = None) -> int:
    """Entry point for the packaged app (``flowlab-app``)."""
    arguments = list(sys.argv[1:] if argv is None else argv)
    port: int | None = None
    for index, argument in enumerate(arguments):
        if argument.startswith("--port="):
            port = int(argument.split("=", 1)[1])
        elif argument == "--port" and index + 1 < len(arguments):
            port = int(arguments[index + 1])
    positional = [a for a in arguments if not a.startswith("-")]
    if port is not None and str(port) in positional:
        positional.remove(str(port))
    folder = positional[0] if positional else None
    root = Path(folder).expanduser().resolve() if folder else default_workspace()
    if not root.is_dir():
        print(f"{root} is not a folder", file=sys.stderr)
        return 2
    if "--check" in arguments:
        return check(root, port)
    return launch(root, port=port, window="--browser" not in arguments)


if __name__ == "__main__":
    raise SystemExit(main())
