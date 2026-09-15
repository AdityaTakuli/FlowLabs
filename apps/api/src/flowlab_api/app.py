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
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .service import ServiceError
from .workbench import Workbench

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


class FlowSaveRequest(BaseModel):
    file: str
    spec: dict[str, Any]
    expected_hash: str | None = None


class FlowSpecRequest(BaseModel):
    file: str | None = None
    spec: dict[str, Any]


class FlowCreateRequest(BaseModel):
    file: str
    name: str = "Untitled flow"
    dataset: str | None = None


class RunIdRequest(BaseModel):
    run_id: str


class AgentGoalRequest(BaseModel):
    goal: str
    dataset: str
    k: int = Field(12, ge=4, le=30)


class AgentAskRequest(AgentGoalRequest):
    model: str | None = None
    use_cache: bool = True
    confirm_external: bool = False


class AgentComposeRequest(BaseModel):
    goal: str
    dataset: str
    plan: dict[str, Any]


class AgentSaveRequest(BaseModel):
    proposal_id: str
    file: str
    overwrite: bool = False


class ArchitectureRequest(BaseModel):
    use_llm: bool = False
    confirm_external: bool = False
    max_tokens: int = Field(60_000, ge=1_000, le=500_000)
    allow_over_budget: bool = False


class ArchitectureFeedback(BaseModel):
    component_id: str | None = None
    unit_id: str | None = None
    correction: str = Field(min_length=3, max_length=1000)


class StructureEditRequest(BaseModel):
    file: str
    node_id: str
    source: str = Field(max_length=500_000)
    expected_hash: str | None = None


class LayoutRequest(BaseModel):
    file: str
    view: str = "structure"
    positions: dict[str, dict[str, float]] = Field(default_factory=dict)


class OpenProjectRequest(BaseModel):
    path: str


class ImportFileRequest(BaseModel):
    name: str
    content: str


async def _background(bench: Workbench) -> None:
    loop = asyncio.get_running_loop()
    watched = None
    tick = 0
    while True:
        service = bench.service
        if service is not watched:  # a folder was opened: start watching the new project
            await loop.run_in_executor(None, service.project.watcher.prime)
            watched = service
        await asyncio.sleep(WATCH_INTERVAL_S)
        tick += 1
        if bench.service is not service:
            continue
        try:
            changes = await loop.run_in_executor(None, service.project.watcher.poll)
        except OSError:
            changes = []
        for change in changes:
            await loop.run_in_executor(None, service.file_changed, change.path)
            bench.hub.publish(
                {"type": "file_changed", "file": change.path, "data": {"kind": change.kind, "origin": "disk"}}
            )
        if tick % 2 == 0:
            resources = await loop.run_in_executor(None, service.resources)
            bench.hub.publish({"type": "resources", "file": None, "data": resources})


def create_app(
    root: Path,
    token: str | None = None,
    *,
    watch: bool = True,
    static_dir: Path | None = DEFAULT_STATIC,
    llm_client_factory: Callable[[str | None], Any] | None = None,
    recents_path: Path | None = None,
) -> FastAPI:
    """``llm_client_factory`` replaces the Groq client (tests and offline demos); ``recents_path``
    is where recently opened folders are remembered (default ``~/.flowlab/recent.json``)."""
    bench = Workbench(root, llm_client_factory=llm_client_factory, recents_path=recents_path)
    token = token or secrets.token_urlsafe(24)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        bench.hub.bind(asyncio.get_running_loop())
        task = asyncio.create_task(_background(bench)) if watch else None
        try:
            yield
        finally:
            if task is not None:
                task.cancel()
            await asyncio.get_running_loop().run_in_executor(None, bench.shutdown)

    app = FastAPI(title="FlowLab local", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.bench = bench
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
        return {**bench.service.project_info(), **bench.structure.languages()}

    @app.get("/api/graph")
    def graph(file: str) -> dict[str, Any]:
        return bench.service.graph(file)

    @app.post("/api/graph/preview")
    def preview(body: PreviewRequest) -> dict[str, Any]:
        return bench.service.preview_edit(body.file, body.node_id, body.source)

    @app.post("/api/transform")
    def transform(body: TransformRequest) -> dict[str, Any]:
        return bench.service.transform(
            body.file,
            body.op,
            body.node_ids,
            body.params,
            confirm=body.confirm,
            expected_hash=body.expected_hash,
        )

    @app.get("/api/structure")
    def structure(file: str) -> dict[str, Any]:
        return bench.structure.graph(file)

    @app.post("/api/structure/preview")
    def structure_preview(body: StructureEditRequest) -> dict[str, Any]:
        return bench.structure.preview(body.file, body.node_id, body.source)

    @app.post("/api/structure/edit")
    def structure_edit(body: StructureEditRequest) -> dict[str, Any]:
        return bench.structure.edit(body.file, body.node_id, body.source, body.expected_hash)

    @app.post("/api/structure/revert")
    def structure_revert(body: FileRequest) -> dict[str, Any]:
        return bench.structure.revert(body.file)

    @app.get("/api/layout")
    def layout(file: str, view: str = "structure") -> dict[str, Any]:
        return bench.structure.layout(file, view)

    @app.put("/api/layout")
    def save_layout(body: LayoutRequest) -> dict[str, Any]:
        return bench.structure.save_layout(body.file, body.view, body.positions)

    @app.post("/api/revert")
    def revert(body: FileRequest) -> dict[str, Any]:
        return bench.service.revert(body.file)

    @app.post("/api/kernel/start")
    def kernel_start(body: FileRequest) -> dict[str, Any]:
        return bench.service.start_session(body.file)

    @app.post("/api/kernel/stop")
    def kernel_stop(body: FileRequest) -> dict[str, Any]:
        return bench.service.stop_session(body.file)

    @app.post("/api/kernel/restart")
    def kernel_restart(body: FileRequest) -> dict[str, Any]:
        return bench.service.restart_session(body.file)

    @app.post("/api/kernel/interrupt")
    def kernel_interrupt(body: FileRequest) -> dict[str, Any]:
        return bench.service.interrupt(body.file)

    @app.post("/api/kernel/clean")
    def kernel_clean(body: FileRequest) -> dict[str, Any]:
        return bench.service.clean_kernel(body.file)

    @app.post("/api/execute")
    def execute(body: ExecuteRequest) -> dict[str, Any]:
        return bench.service.execute(body.file, body.node_id, body.mode)

    @app.get("/api/state")
    def state(file: str) -> dict[str, Any]:
        return bench.service.state(file)

    @app.get("/api/resources")
    def resources() -> dict[str, Any]:
        return bench.service.resources()

    @app.get("/api/inspect")
    def inspect(file: str, node_id: str) -> dict[str, Any]:
        return bench.service.inspect(file, node_id)

    @app.get("/api/output")
    def output(file: str, execution_id: str, index: int) -> Response:
        mime, payload = bench.service.output(file, execution_id, index)
        # Output HTML is user code: if this URL is ever opened directly, the sandbox CSP stops scripts
        # from running with the canvas origin. The canvas itself renders HTML in a sandboxed iframe.
        headers = {"Content-Security-Policy": "sandbox", "Cache-Control": "no-store"}
        return Response(content=payload, media_type=mime, headers=headers)

    @app.get("/api/history")
    def history(file: str, node_id: str) -> list[dict[str, Any]]:
        return bench.service.history(file, node_id)

    @app.get("/api/diff")
    def diff(
        file: str,
        node_a: str | None = None,
        node_b: str | None = None,
        execution_a: str | None = None,
        execution_b: str | None = None,
        variable: str | None = None,
    ) -> dict[str, Any]:
        return bench.service.diff(
            file,
            node_a=node_a,
            node_b=node_b,
            execution_a=execution_a,
            execution_b=execution_b,
            variable=variable,
        )

    # ------------------------------------------------------------------ Flow Mode
    @app.get("/api/catalogue")
    def node_catalogue() -> dict[str, Any]:
        return bench.flows.catalogue()

    @app.get("/api/flows")
    def flow_index() -> dict[str, Any]:
        return bench.flows.index()

    @app.get("/api/flow")
    def flow_load(file: str) -> dict[str, Any]:
        return bench.flows.load(file)

    @app.put("/api/flow")
    def flow_save(body: FlowSaveRequest) -> dict[str, Any]:
        return bench.flows.save(body.file, body.spec, body.expected_hash)

    @app.post("/api/flow/new")
    def flow_create(body: FlowCreateRequest) -> dict[str, Any]:
        return bench.flows.create(body.file, body.name, body.dataset)

    @app.post("/api/flow/compile")
    def flow_compile(body: FlowSpecRequest) -> dict[str, Any]:
        return bench.flows.compile(body.file, body.spec)

    @app.post("/api/flow/run")
    def flow_run(body: FlowSpecRequest) -> dict[str, Any]:
        return bench.flows.run(body.file, body.spec)

    @app.post("/api/flow/cancel")
    def flow_cancel(body: RunIdRequest) -> dict[str, Any]:
        return bench.flows.cancel(body.run_id)

    @app.get("/api/flow/runs")
    def flow_runs(flow_id: str | None = None) -> list[dict[str, Any]]:
        return bench.flows.runs(flow_id)

    @app.get("/api/flow/run")
    def flow_run_detail(run_id: str) -> dict[str, Any]:
        return bench.flows.run_detail(run_id)

    @app.get("/api/flow/output")
    def flow_output(run_id: str, node_id: str) -> dict[str, Any]:
        return bench.flows.node_output(run_id, node_id)

    @app.get("/api/dataset/profile")
    def dataset_profile(file: str) -> dict[str, Any]:
        return bench.flows.dataset_profile(file)

    # ---------------------------------------------------------------------- agent
    @app.get("/api/agent/status")
    def agent_status() -> dict[str, Any]:
        return bench.agent.status()

    @app.post("/api/agent/preview")
    def agent_preview(body: AgentGoalRequest) -> dict[str, Any]:
        return bench.agent.preview(body.goal, body.dataset, body.k)

    @app.post("/api/agent/ask")
    def agent_ask(body: AgentAskRequest) -> dict[str, Any]:
        return bench.agent.ask(
            body.goal, body.dataset, k=body.k, model=body.model,
            use_cache=body.use_cache, confirm_external=body.confirm_external,
        )  # fmt: skip

    @app.post("/api/agent/compose")
    def agent_compose(body: AgentComposeRequest) -> dict[str, Any]:
        return bench.agent.compose_plan(body.goal, body.dataset, body.plan)

    @app.post("/api/agent/save")
    def agent_save(body: AgentSaveRequest) -> dict[str, Any]:
        return bench.agent.save(body.proposal_id, body.file, body.overwrite)

    @app.get("/api/agent/snippets")
    def agent_snippets(q: str | None = None, dataset: str | None = None) -> list[dict[str, Any]]:
        return bench.agent.snippets(q, dataset)

    # ------------------------------------------------------------- architecture
    @app.get("/api/architecture")
    def architecture_latest() -> dict[str, Any]:
        return bench.architecture.latest()

    @app.post("/api/architecture/analyse")
    def architecture_analyse(body: ArchitectureRequest) -> dict[str, Any]:
        return bench.architecture.analyse(
            use_llm=body.use_llm,
            confirm_external=body.confirm_external,
            max_tokens=body.max_tokens,
            allow_over_budget=body.allow_over_budget,
        )

    @app.post("/api/architecture/feedback")
    def architecture_feedback(body: ArchitectureFeedback) -> dict[str, Any]:
        return bench.architecture.feedback(body.component_id, body.unit_id, body.correction)

    # ----------------------------------------------------------- open anything
    @app.get("/api/fs/browse")
    def fs_browse(path: str | None = None, hidden: bool = False) -> dict[str, Any]:
        return bench.browse(path, hidden)

    @app.get("/api/fs/recent")
    def fs_recent() -> list[str]:
        return bench.recents()

    @app.post("/api/project/open")
    def project_open(body: OpenProjectRequest) -> dict[str, Any]:
        return bench.open(body.path)

    @app.post("/api/files/import")
    def files_import(body: ImportFileRequest) -> dict[str, Any]:
        return bench.import_file(body.name, body.content)

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
        queue = bench.service.hub.subscribe()
        try:
            await websocket.send_json(
                {"type": "hello", "file": None, "data": {"root": str(bench.service.project.root)}}
            )
            while True:
                await websocket.send_json(await queue.get())
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            bench.service.hub.unsubscribe(queue)

    if static_dir is not None and (static_dir / "index.html").is_file():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="web")
    return app
