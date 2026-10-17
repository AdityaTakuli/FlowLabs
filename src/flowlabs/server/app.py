"""The FlowLabs server: the app's pages, the kernel, uploads, downloads and live events.

Security:

* every ``/api`` call needs the per-launch token (``Authorization: Bearer <token>``, or ``?token=``
  for download links);
* bound to 127.0.0.1 by default; the ``Host`` header must then be a loopback name, which blocks DNS
  rebinding;
* browsers may call it only from the origins in ``allowed_origins`` (the hosted FlowLabs web app,
  local dev servers); Chrome's Private Network Access preflight is answered for those origins only.
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import hmac
import json
import os
import secrets
import shutil
import subprocess
import threading
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from flowlabs import __version__
from flowlabs.core.workspace import Workspace

from . import interpreters
from .kernel import Kernel

WEB = Path(__file__).resolve().parents[1] / "web"
DEFAULT_WEB_URL = os.environ.get("FLOWLABS_WEB_URL", "https://adityatakuli.github.io/FlowLabs/")
DEFAULT_ORIGINS = (
    "https://adityatakuli.github.io",
    "https://appassets.androidplatform.net",  # the FlowLabs Android app
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)
INSTALLABLE = {"numpy", "pandas", "scikit-learn", "scipy", "joblib", "torch", "torchvision", "xgboost", "lightgbm",
               "pillow", "openpyxl", "pyarrow", "onnx", "psutil"}  # fmt: skip
LOOPBACK = {"127.0.0.1", "localhost", "[::1]"}


class Events:
    """Recent events with sequence numbers, read by long polling."""

    def __init__(self, size: int = 5000) -> None:
        self.items: collections.deque[tuple[int, dict[str, Any]]] = collections.deque(maxlen=size)
        self.seq = 0
        self.lock = threading.Lock()

    def push(self, event: dict[str, Any]) -> None:
        with self.lock:
            self.seq += 1
            self.items.append((self.seq, {**event, "seq": self.seq, "ts": time.time()}))

    def since(self, seq: int) -> list[dict[str, Any]]:
        with self.lock:
            return [e for s, e in self.items if s > seq]


class Settings:
    def __init__(self, root: Path) -> None:
        self.path = root / ".flowlabs" / "settings.json"

    def read(self) -> dict[str, Any]:
        try:
            return dict(json.loads(self.path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            return {}

    def write(self, **values: Any) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({**self.read(), **values}, indent=1), encoding="utf-8")


def create_app(
    root: Path,
    token: str,
    *,
    allowed_origins: tuple[str, ...] | list[str] = DEFAULT_ORIGINS,
    loopback_only: bool = True,
    python: str | None | object = ...,
    start_kernel: bool = True,
) -> FastAPI:
    root = Path(root).expanduser().resolve()
    ws = Workspace(root)
    settings = Settings(root)
    events = Events()
    chosen = settings.read().get("python") if python is ... else python
    notice = None
    if python is ... and isinstance(chosen, str):
        chosen, notice = _usable(chosen)
    kernel = Kernel(root, chosen if isinstance(chosen, str) or chosen is None else None, events.push)
    kernel.notice = notice
    origins = {o.rstrip("/") for o in allowed_origins}

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        kernel.stop()

    app = FastAPI(title="FlowLabs", version=__version__, docs_url=None, redoc_url=None, openapi_url=None,
                  lifespan=lifespan)  # fmt: skip
    app.state.kernel = kernel
    app.state.events = events
    app.state.token = token
    installs: dict[str, Any] = {"running": False}

    if start_kernel:
        kernel.start()

    def cors_headers(origin: str | None) -> dict[str, str]:
        if not origin or origin.rstrip("/") not in origins:
            return {}
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Private-Network": "true",
            "Access-Control-Max-Age": "600",
            "Vary": "Origin",
        }

    @app.middleware("http")
    async def guard(request: Request, call_next: Any) -> Response:
        origin = request.headers.get("origin")
        if loopback_only:
            host = (request.headers.get("host") or "").rsplit(":", 1)[0]
            if host not in LOOPBACK:
                return JSONResponse({"error": "unexpected Host header"}, status_code=403)
        if request.method == "OPTIONS":
            headers = cors_headers(origin)
            return Response(status_code=204 if headers else 403, headers=headers)
        path = request.url.path
        if path.startswith("/api/") and path != "/api/health":
            if (
                origin
                and origin.rstrip("/") not in origins
                and origin != f"{request.url.scheme}://{request.headers.get('host')}"
            ):
                return JSONResponse({"error": "origin not allowed"}, status_code=403)
            given = request.headers.get("authorization", "").removeprefix(
                "Bearer "
            ).strip() or request.query_params.get("token", "")
            if not hmac.compare_digest(given.encode(), token.encode()):
                return JSONResponse({"error": "missing or wrong token"}, status_code=401, headers=cors_headers(origin))
        response: Response = await call_next(request)
        for key, value in cors_headers(origin).items():
            response.headers[key] = value
        return response

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "app": "flowlabs", "version": __version__}

    @app.get("/api/hello")
    def hello() -> dict[str, Any]:
        return {"app": "flowlabs", "version": __version__, "workspace": str(root), "kernel": kernel.describe(),
                "web_url": DEFAULT_WEB_URL}  # fmt: skip

    @app.post("/api/rpc")
    async def rpc(request: Request) -> Any:
        body = await request.json()
        method = str(body.get("method", ""))
        return await asyncio.to_thread(kernel.call, method, body.get("params") or {})

    @app.get("/api/events")
    async def poll(since: int = 0, timeout: float = 20.0) -> dict[str, Any]:
        deadline = time.monotonic() + min(max(timeout, 0.0), 30.0)
        while True:
            found = events.since(since)
            if found or time.monotonic() >= deadline:
                return {"events": found, "seq": events.seq}
            await asyncio.sleep(0.1)

    @app.post("/api/upload")
    async def upload(request: Request, filename: str) -> Any:
        safe = Path(filename).name or "upload"
        folder = ws.tmp / secrets.token_hex(6)
        folder.mkdir(parents=True)
        target = folder / safe
        try:
            with target.open("wb") as handle:
                async for chunk in request.stream():
                    handle.write(chunk)
            return await asyncio.to_thread(kernel.call, "datasets.import_path", {"path": str(target), "filename": safe})
        finally:
            shutil.rmtree(folder, ignore_errors=True)

    @app.get("/api/files/{path:path}")
    def download(path: str) -> FileResponse:
        try:
            full = ws.inside(path)
        except Exception as error:  # noqa: BLE001
            raise HTTPException(403, "outside the workspace") from error
        if not path.startswith(("exports/", "runs/")) or not full.is_file():
            raise HTTPException(404, "not found")
        return FileResponse(full, filename=full.name)

    @app.get("/api/kernel")
    def kernel_state() -> dict[str, Any]:
        return {**kernel.describe(), "install": {k: v for k, v in installs.items() if k != "process"}}

    @app.get("/api/interpreters")
    def list_interpreters() -> list[dict[str, Any]]:
        return [i.as_dict() for i in interpreters.discover(root, settings.read().get("python"))]

    @app.post("/api/kernel/select")
    async def select(request: Request) -> dict[str, Any]:
        body = await request.json()
        path = body.get("python") or None
        if path is not None:
            found = await asyncio.to_thread(interpreters.describe, path, "configured", "chosen")
            if not found.version:
                raise HTTPException(400, f"{path} is not a Python interpreter")
        settings.write(python=path)
        kernel.notice = None
        await asyncio.to_thread(kernel.restart, path)
        return kernel.describe()

    @app.post("/api/kernel/restart")
    async def restart() -> dict[str, Any]:
        await asyncio.to_thread(kernel.restart)
        return kernel.describe()

    @app.post("/api/kernel/install")
    async def install(request: Request) -> dict[str, Any]:
        body = await request.json()
        wanted = [str(p) for p in body.get("packages") or []]
        if not wanted or any(p not in INSTALLABLE for p in wanted):
            raise HTTPException(400, f"FlowLabs can install: {', '.join(sorted(INSTALLABLE))}")
        if kernel.python is None and _frozen():
            raise HTTPException(400, "The built-in runtime cannot install packages. Choose your own Python first.")
        if installs.get("running"):
            raise HTTPException(409, "an install is already running")
        python = kernel.python or _current_python()
        installs.update(running=True, packages=wanted, code=None, started=time.time())

        def work() -> None:
            argv = [python, "-m", "pip", "install", "--upgrade", *wanted]
            events.push({"type": "install", "line": "$ " + " ".join(argv)})
            try:
                process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)  # noqa: S603
                assert process.stdout is not None
                for line in process.stdout:
                    events.push({"type": "install", "line": line.rstrip()[:400]})
                code = process.wait()
            except OSError as error:
                events.push({"type": "install", "line": str(error)})
                code = -1
            installs.update(running=False, code=code)
            interpreters._CACHE.clear()
            events.push({"type": "install", "done": True, "code": code})
            if code == 0:
                kernel.restart()

        threading.Thread(target=work, daemon=True, name="pip-install").start()
        return {"started": True}

    _mount_web(app)
    return app


def _usable(python: str) -> tuple[str | None, str | None]:
    """The Python chosen in the Engine menu, or None (the built-in engine) when it cannot run
    FlowLabs any more, with a note saying why. A saved choice must never stop the app starting."""
    found = interpreters.describe(python, "configured", "chosen earlier")
    if not found.version:
        return None, f"{python} could not be run, so FlowLabs is using its built-in engine."
    missing = found.as_dict()["missing"]
    if missing:
        return None, (
            f"{python} does not have {', '.join(missing)}, so FlowLabs is using its built-in engine. "
            "Open the Engine menu to install them there or choose another Python."
        )
    return python, None


def _frozen() -> bool:
    import sys

    return bool(getattr(sys, "frozen", False))


def _current_python() -> str:
    import sys

    return sys.executable


def _mount_web(app: FastAPI) -> None:
    """Serve the built app (``flowlabs/web``) with an SPA fallback to index.html."""

    @app.get("/{path:path}", include_in_schema=False)
    def page(path: str) -> Response:
        if not (WEB / "index.html").is_file():
            return Response(
                "<!doctype html><title>FlowLabs</title><p>The FlowLabs app is not built. Run "
                "<code>python scripts/bundle_web.py</code>, or use <code>npm run dev</code> in apps/web.</p>",
                media_type="text/html",
            )
        candidate = (WEB / path).resolve()
        if path and WEB.resolve() in candidate.parents and candidate.is_file():
            cache = "public, max-age=31536000, immutable" if path.startswith("assets/") else "no-cache"
            return FileResponse(candidate, headers={"Cache-Control": cache})
        return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-cache"})
