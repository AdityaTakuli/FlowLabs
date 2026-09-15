"""Local FastAPI app for the web canvas.

Security model (the server can run your code, so a random website must not reach it):
* binds to 127.0.0.1 only (see ``cli.py``);
* every ``/api`` request needs the per-launch token in ``X-FlowLab-Token``. Browsers cannot add
  that header cross-origin without a CORS preflight, which this server never approves;
* the ``Host`` header must be a loopback name, which defeats DNS-rebinding attacks;
* the WebSocket additionally checks ``Origin`` and takes the token as a query parameter.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import secrets
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .service import LabService, ServiceError

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
DEFAULT_STATIC = Path(__file__).resolve().parents[3] / "web" / "dist"
WATCH_INTERVAL_S = 1.0


def _hostname(host_header: str | None) -> str:
    if not host_header:
        return ""
    return urlparse(f"//{host_header}").hostname or ""


class TransformRequest(BaseModel):
    file: str
    op: str
    node_ids: list[str] = Field(default_factory=list)
    params: dict[str, Any] = Field(default_factory=dict)
    confirm: bool = False
    expected_hash: str | None = None


class FileRequest(BaseModel):
    file: str


class ExecuteRequest(BaseModel):
    file: str
    node_id: str | None = None
    mode: Literal["node", "to", "from", "stale", "all"] = "node"


class PreviewRequest(BaseModel):
    file: str
    node_id: str
    source: str


async def _background(service: LabService) -> None:
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, service.project.watcher.prime)
    tick = 0
    while True:
        await asyncio.sleep(WATCH_INTERVAL_S)
        tick += 1
        try:
            changes = await loop.run_in_executor(None, service.project.watcher.poll)
        except OSError:
            changes = []
        for change in changes:
            await loop.run_in_executor(None, service.file_changed, change.path)
            service.hub.publish(
                {"type": "file_changed", "file": change.path, "data": {"kind": change.kind, "origin": "disk"}}
            )
        if tick % 2 == 0:
            resources = await loop.run_in_executor(None, service.resources)
            service.hub.publish({"type": "resources", "file": None, "data": resources})


def create_app(
    root: Path, token: str | None = None, *, watch: bool = True, static_dir: Path | None = DEFAULT_STATIC
) -> FastAPI:
    service = LabService(root)
    token = token or secrets.token_urlsafe(24)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        service.hub.bind(asyncio.get_running_loop())
        task = asyncio.create_task(_background(service)) if watch else None
        try:
            yield
        finally:
            if task is not None:
                task.cancel()
            await asyncio.get_running_loop().run_in_executor(None, service.shutdown)

    app = FastAPI(title="FlowLab local", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.service = service
    app.state.token = token

    def token_ok(candidate: str | None) -> bool:
        return hmac.compare_digest((candidate or "").encode(), token.encode())

    @app.middleware("http")
    async def guard(request: Request, call_next: Any) -> Response:
        if _hostname(request.headers.get("host")) not in LOOPBACK_HOSTS:
            return JSONResponse(
                {"code": "FORBIDDEN_HOST", "message": "FlowLab only answers on localhost"}, 403
            )
        path = request.url.path
        if (
            path.startswith("/api/")
            and path != "/api/health"
            and not token_ok(request.headers.get("x-flowlab-token"))
        ):
            return JSONResponse({"code": "UNAUTHORIZED", "message": "missing or wrong FlowLab token"}, 401)
        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.exception_handler(ServiceError)
    async def service_error(request: Request, exc: ServiceError) -> JSONResponse:
        return JSONResponse({"code": exc.code, "message": exc.message, "details": exc.details}, exc.status)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/project")
    def project() -> dict[str, Any]:
        return service.project_info()

    @app.get("/api/graph")
    def graph(file: str) -> dict[str, Any]:
        return service.graph(file)

    @app.post("/api/graph/preview")
    def preview(body: PreviewRequest) -> dict[str, Any]:
        return service.preview_edit(body.file, body.node_id, body.source)

    @app.post("/api/transform")
    def transform(body: TransformRequest) -> dict[str, Any]:
        return service.transform(
            body.file,
            body.op,
            body.node_ids,
            body.params,
            confirm=body.confirm,
            expected_hash=body.expected_hash,
        )

    @app.post("/api/revert")
    def revert(body: FileRequest) -> dict[str, Any]:
        return service.revert(body.file)

    @app.post("/api/kernel/start")
    def kernel_start(body: FileRequest) -> dict[str, Any]:
        return service.start_session(body.file)

    @app.post("/api/kernel/stop")
    def kernel_stop(body: FileRequest) -> dict[str, Any]:
        return service.stop_session(body.file)

    @app.post("/api/kernel/restart")
    def kernel_restart(body: FileRequest) -> dict[str, Any]:
        return service.restart_session(body.file)

    @app.post("/api/kernel/interrupt")
    def kernel_interrupt(body: FileRequest) -> dict[str, Any]:
        return service.interrupt(body.file)

    @app.post("/api/kernel/clean")
    def kernel_clean(body: FileRequest) -> dict[str, Any]:
        return service.clean_kernel(body.file)

    @app.post("/api/execute")
    def execute(body: ExecuteRequest) -> dict[str, Any]:
        return service.execute(body.file, body.node_id, body.mode)

    @app.get("/api/state")
    def state(file: str) -> dict[str, Any]:
        return service.state(file)

    @app.get("/api/resources")
    def resources() -> dict[str, Any]:
        return service.resources()

    @app.get("/api/inspect")
    def inspect(file: str, node_id: str) -> dict[str, Any]:
        return service.inspect(file, node_id)

    @app.get("/api/history")
    def history(file: str, node_id: str) -> list[dict[str, Any]]:
        return service.history(file, node_id)

    @app.get("/api/diff")
    def diff(
        file: str,
        node_a: str | None = None,
        node_b: str | None = None,
        execution_a: str | None = None,
        execution_b: str | None = None,
        variable: str | None = None,
    ) -> dict[str, Any]:
        return service.diff(
            file,
            node_a=node_a,
            node_b=node_b,
            execution_a=execution_a,
            execution_b=execution_b,
            variable=variable,
        )

    @app.websocket("/api/ws")
    async def events(websocket: WebSocket) -> None:
        origin = websocket.headers.get("origin")
        allowed = (
            _hostname(websocket.headers.get("host")) in LOOPBACK_HOSTS
            and (origin is None or (urlparse(origin).hostname or "") in LOOPBACK_HOSTS)
            and token_ok(websocket.query_params.get("token"))
        )
        if not allowed:
            await websocket.close(code=4403)
            return
        await websocket.accept()
        queue = service.hub.subscribe()
        try:
            await websocket.send_json(
                {"type": "hello", "file": None, "data": {"root": str(service.project.root)}}
            )
            while True:
                await websocket.send_json(await queue.get())
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            service.hub.unsubscribe(queue)

    if static_dir is not None and (static_dir / "index.html").is_file():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="web")
    return app
