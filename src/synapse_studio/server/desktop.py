"""``synapse app``: Synapse as a desktop application on Linux, macOS and Windows.

The window shows the same app the browser version serves, backed by a local server on a free port
that only this machine can reach, with a per-launch token. A native window is used when a webview
is available (WebKitGTK, WKWebView, WebView2); otherwise the default browser opens.
"""

from __future__ import annotations

import os
import secrets
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any

WINDOW_TITLE = "Synapse"
WINDOW_SIZE = (1440, 920)


def free_port(preferred: int = 8899) -> int:
    for port in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
                return int(probe.getsockname()[1])
            except OSError:
                continue
    raise RuntimeError("no free port on 127.0.0.1")


def default_workspace() -> Path:
    workspace = Path(os.environ.get("SYNAPSE_WORKSPACE", Path.home() / "Synapse")).expanduser()
    workspace.mkdir(parents=True, exist_ok=True)
    return workspace


class Server:
    """The local server on a background thread."""

    def __init__(self, root: Path, port: int, token: str, host: str = "127.0.0.1", **options: Any) -> None:
        import uvicorn

        from .app import create_app

        self.host, self.port, self.token = host, port, token
        shown = "127.0.0.1" if host in ("0.0.0.0", "::") else host
        self.base = f"http://{shown}:{port}"
        self.url = f"{self.base}/?token={token}"
        self.app = create_app(root, token, loopback_only=host in ("127.0.0.1", "localhost"), **options)
        config = uvicorn.Config(self.app, host=host, port=port, log_level="warning")
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(target=self._server.run, name="synapse-server", daemon=True)

    def start(self, timeout_s: float = 30.0) -> None:
        self._thread.start()
        deadline = time.monotonic() + timeout_s
        while not self._server.started and self._thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.05)
        if not self._server.started:
            raise RuntimeError("the Synapse server did not start")

    def stop(self) -> None:
        self._server.should_exit = True
        self._thread.join(timeout=10)
        self.app.state.kernel.stop()


def _webview() -> Any | None:
    try:
        import webview  # type: ignore[import-not-found]  # optional; packaged builds ship it
    except ImportError:
        return None
    return webview


def launch(root: Path, *, port: int | None = None, window: bool = True, quiet: bool = False) -> int:
    token = os.environ.get("SYNAPSE_TOKEN") or secrets.token_urlsafe(24)
    server = Server(root, port or free_port(), token)
    server.start()
    if not quiet:
        print(f"Synapse workspace: {root}")
        print(f"  {server.url}")
    webview = _webview() if window else None
    try:
        if webview is not None:
            settings = getattr(webview, "settings", None)
            if isinstance(settings, dict):
                settings["ALLOW_DOWNLOADS"] = True  # exports and scored files
            webview.create_window(WINDOW_TITLE, server.url, width=WINDOW_SIZE[0], height=WINDOW_SIZE[1])
            webview.start()  # returns when the window closes
            return 0
        if window and not quiet:
            print("  no native webview available: opening your browser instead")
        webbrowser.open(server.url)
        if not quiet:
            print("  Ctrl+C closes Synapse.")
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        return 0
    finally:
        server.stop()


def check(root: Path, port: int | None = None) -> int:
    """Start the server and kernel, prove both work, stop. Used to smoke-test builds."""
    import json
    import urllib.request

    server = Server(root, port or free_port(), "check-token")
    server.start()
    try:
        with urllib.request.urlopen(f"{server.base}/api/health", timeout=20) as health:
            assert health.status == 200, health.status
        with urllib.request.urlopen(server.base, timeout=20) as page:
            body = page.read().decode("utf-8", errors="replace")
        if "<title>Synapse</title>" not in body:
            print("the app is missing from this build", file=sys.stderr)
            return 1
        request = urllib.request.Request(
            f"{server.base}/api/rpc", data=json.dumps({"method": "engine.info", "params": {"probe_gpu": False}}).encode(),
            headers={"Authorization": "Bearer check-token", "Content-Type": "application/json"},
        )  # fmt: skip
        with urllib.request.urlopen(request, timeout=180) as reply:
            answer = json.loads(reply.read())
        if "result" not in answer:
            print(f"the engine did not answer: {answer}", file=sys.stderr)
            return 1
        print(f"Synapse serves the app and its engine (Python {answer['result']['python']}) from {server.base}")
        return 0
    finally:
        server.stop()
