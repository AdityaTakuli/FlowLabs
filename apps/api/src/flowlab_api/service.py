"""Local Code Mode service behind the web canvas.

One ``LabProject`` per server, at most one kernel session per file, and an event hub that fans
kernel and file-watch events out to WebSocket clients. Executions run on a worker thread so the
HTTP server stays responsive (interrupting a running block must always work).
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from flowlab_lab.codegraph import analyse_text
from flowlab_lab.kernel import ExecutionRecord, KernelDied, LabEvent, LabSession, RunMode, diff_executions
from flowlab_lab.outputs import OutputStore
from flowlab_lab.privacy import OutboundPolicy, first_open_warning, transmission_badge
from flowlab_lab.project import SOURCE_SUFFIXES, LabProject, PathError
from flowlab_lab.resources import host_environment, process_memory_mb, system_resources
from flowlab_lab.snapshots import SnapshotStore
from flowlab_lab.symbols import analyse_block
from flowlab_lab.transforms import (
    TransformConflict,
    TransformError,
    apply_transform,
    edited_text,
    revert_last,
)
from flowspec import sha256_text

MAX_STREAM_CHARS = 20_000
STARTING = "__starting__"
EXECUTION_ID = re.compile(r"^ex_[0-9a-f]{12}$")
QUEUED = "__queued__"


class ServiceError(Exception):
    def __init__(self, status: int, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}


class EventHub:
    """Thread-safe publish; each WebSocket client consumes its own queue."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=2000)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(queue)

    def publish(self, event: dict[str, Any]) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return

        def deliver() -> None:
            for queue in list(self._subscribers):
                if queue.full():
                    continue  # a stalled client must not block everyone else
                queue.put_nowait(event)

        with contextlib.suppress(RuntimeError):  # the loop closed during shutdown
            loop.call_soon_threadsafe(deliver)


def _record_summary(record: ExecutionRecord | None) -> dict[str, Any] | None:
    if record is None:
        return None
    data = record.model_dump(mode="json", exclude={"metrics"})  # sent separately, capped
    for key in ("stdout", "stderr"):
        if len(data[key]) > MAX_STREAM_CHARS:
            data[key] = data[key][-MAX_STREAM_CHARS:]
            data[f"{key}_truncated"] = True
    return data


def _cap_samples(summaries: dict[str, Any], limit: int) -> dict[str, Any]:
    capped: dict[str, Any] = {}
    for name, summary in summaries.items():
        summary = dict(summary)
        sample = summary.get("sample")
        if isinstance(sample, dict) and isinstance(sample.get("data"), list):
            sample = {**sample, "data": sample["data"][:limit]}
            if isinstance(sample.get("index"), list):
                sample["index"] = sample["index"][:limit]
            summary["sample"] = sample
        elif isinstance(sample, list):
            summary["sample"] = sample[:limit]
        capped[name] = summary
    return capped


def _compact(value: Any) -> str:
    if not isinstance(value, int | float):
        return "?"
    for limit, suffix in ((1e9, "B"), (1e6, "M"), (1e3, "k")):
        if abs(value) >= limit:
            return f"{value / limit:.1f}".rstrip("0").rstrip(".") + suffix
    return f"{int(value):,}"


def short_value(summary: dict[str, Any]) -> str:
    """One-line description of a variable summary, e.g. ``DataFrame 2,000×9`` or ``200 OK · json``."""
    kind = summary.get("kind")
    if summary.get("error"):
        return "could not summarise"
    if kind == "dataframe":
        return f"DataFrame {int(summary.get('rows') or 0):,}×{len(summary.get('columns') or [])}"
    if kind == "series":
        return f"Series · {int(summary.get('rows') or 0):,}"
    if kind == "ndarray":
        return "ndarray " + "×".join(str(d) for d in summary.get("shape") or [])
    if kind == "response":
        content_type = str(summary.get("content_type") or "").split(";")[0]
        fmt = "json" if "json" in content_type else content_type.split("/")[-1]
        head = f"{summary.get('status', '?')} {summary.get('reason') or ''}".strip()
        return f"{head} · {fmt}" if fmt else head
    if kind == "collection":
        container = str(summary.get("container") or "collection")
        unit = "keys" if container == "dict" else "items"
        return f"{container} · {int(summary.get('length') or 0):,} {unit}"
    if kind == "estimator":
        name = str(summary.get("type", "")).rsplit(".", 1)[-1]
        return f"{name} (fitted)" if summary.get("fitted") else name
    if kind == "tensor":
        shape = "×".join(str(d) for d in summary.get("shape") or []) or "scalar"
        device = str(summary.get("device") or "cpu")
        return f"Tensor {shape} · {summary.get('dtype', '')}" + ("" if device == "cpu" else f" · {device}")
    if kind == "model":
        name = str(summary.get("type", "")).rsplit(".", 1)[-1]
        return f"{name} · {_compact(summary.get('params_total'))} params"
    if kind == "dataloader":
        return f"DataLoader · {summary.get('batches', '?')} batches × {summary.get('batch_size', '?')}"
    if kind == "dataset":
        name = str(summary.get("type", "")).rsplit(".", 1)[-1]
        return f"{name} · {_compact(summary.get('length'))} items"
    if kind == "optimizer":
        name = str(summary.get("type", "")).rsplit(".", 1)[-1]
        lr = summary.get("lr")
        return f"{name} · lr {lr:g}" if isinstance(lr, int | float) else name
    if kind == "callable":
        return "function"
    text = " ".join(str(summary.get("repr") or summary.get("type", "")).split())
    return text if len(text) <= 48 else text[:47] + "…"


class LabService:
    def __init__(self, root: Path, *, timeout_s: float = 3600.0, hub: EventHub | None = None) -> None:
        try:
            self.project = LabProject(root)
        except PathError as exc:
            raise ServiceError(400, "BAD_ROOT", str(exc)) from exc
        config = self.project.init()
        self.timeout_s = timeout_s
        self.hub = hub or EventHub()
        self._values_cache: dict[str, dict[str, dict[str, str]]] = {}
        self.sessions: dict[str, LabSession] = {}
        self.running: dict[str, str | None] = {}
        self._lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="flowlab-run")
        self.snapshots = SnapshotStore(self.project.state_dir / "snapshots", config.snapshot_max_bytes)
        self.output_store = OutputStore(self.project.state_dir / "outputs", config.snapshot_max_bytes)

    # ------------------------------------------------------------------ files & graph
    def check_file(self, file: str) -> str:
        if not file.endswith(SOURCE_SUFFIXES):
            raise ServiceError(400, "UNSUPPORTED_FILE", "only .py and .ipynb files can be opened")
        try:
            path = self.project.resolve(file)
        except PathError as exc:
            raise ServiceError(403, "PATH_OUTSIDE_ROOT", str(exc)) from exc
        if not path.is_file():
            raise ServiceError(404, "FILE_NOT_FOUND", f"{file} does not exist")
        return self.project.relative(path)

    def project_info(self) -> dict[str, Any]:
        config = self.project.config
        policy = OutboundPolicy(local_only=config.local_only, max_preview_rows=config.max_preview_rows)
        return {
            "root": str(self.project.root),
            "name": self.project.root.name,
            "files": self.project.index(),
            "config": config.model_dump(),
            "badge": transmission_badge(policy),
            "environment": host_environment(),
            "sessions": sorted(self.sessions),
        }

    def graph(self, file: str) -> dict[str, Any]:
        file = self.check_file(file)
        text = self.project.read(file)
        graph = analyse_text(file, text)
        return {
            "file": file,
            "hash": sha256_text(text),
            "graph": graph.model_dump(mode="json", by_alias=True),
            "secrets_warning": first_open_warning(graph),
        }

    def preview_edit(self, file: str, node_id: str, source: str) -> dict[str, Any]:
        """Graph as it would be if ``node_id`` had ``source`` (nothing is written)."""
        file = self.check_file(file)
        from flowlab_lab.blocks import segment_text

        try:
            text = edited_text(segment_text(file, self.project.read(file)), node_id, source)
        except TransformError as exc:
            raise ServiceError(404, exc.code, exc.message) from exc
        graph = analyse_text(file, text)
        symbols = analyse_block(source, notebook=file.endswith(".ipynb"))
        return {
            "graph": graph.model_dump(mode="json", by_alias=True),
            "parse_error": symbols.parse_error,
            "parse_error_line": symbols.parse_error_line,
        }

    def transform(
        self,
        file: str,
        op: str,
        node_ids: list[str],
        params: dict[str, Any],
        *,
        confirm: bool = False,
        expected_hash: str | None = None,
    ) -> dict[str, Any]:
        file = self.check_file(file)
        try:
            result = apply_transform(
                self.project, file, op, node_ids=node_ids, params=params,  # type: ignore[arg-type]
                confirm=confirm, expected_hash=expected_hash,
            )  # fmt: skip
        except TransformConflict as exc:
            raise ServiceError(409, exc.code, exc.message, exc.details) from exc
        except TransformError as exc:
            status = 404 if exc.code in ("UNKNOWN_NODE", "UNKNOWN_OPERATION") else 422
            raise ServiceError(status, exc.code, exc.message, exc.details) from exc
        session = self.sessions.get(file)
        if session is not None:
            session.refresh()
        self.hub.publish({"type": "file_changed", "file": file, "data": {"origin": "flowlab", "op": op}})
        return {
            "message": result.message,
            "affected": result.affected,
            "backup": Path(result.backup).name,
            "hash": result.new_hash,
            "graph": result.graph.model_dump(mode="json", by_alias=True),
        }

    def revert(self, file: str) -> dict[str, Any]:
        file = self.check_file(file)
        try:
            backup = revert_last(self.project, file)
        except TransformError as exc:
            raise ServiceError(422, exc.code, exc.message) from exc
        session = self.sessions.get(file)
        if session is not None:
            session.refresh()
        self.hub.publish(
            {"type": "file_changed", "file": file, "data": {"origin": "flowlab", "op": "revert"}}
        )
        return {"restored_from": backup.name, **self.graph(file)}

    def file_changed(self, file: str) -> None:
        session = self.sessions.get(file)
        if session is not None:
            with contextlib.suppress(OSError, ValueError):  # deleted or mid-write; next poll catches up
                session.refresh()

    # ---------------------------------------------------------------------- sessions
    def _session(self, file: str) -> LabSession:
        session = self.sessions.get(file)
        if session is None:
            raise ServiceError(409, "NO_KERNEL", f"start a kernel for {file} first")
        return session

    def _busy(self, file: str) -> bool:
        return self.running.get(file) is not None

    def kernel_info(self, file: str) -> dict[str, Any]:
        session = self.sessions.get(file)
        running = self.running.get(file)
        if session is None:
            return {"status": "starting" if running == STARTING else "none"}
        alive = session.is_alive()
        env = session.environment
        return {
            "status": "dead" if not alive else ("busy" if running else "idle"),
            "running": running if running not in (STARTING, QUEUED) else None,
            "pid": session.pid,
            "python": env.get("python"),
            "executable": env.get("executable"),
            "packages": len(env.get("packages", {})),
            "memory_mb": process_memory_mb(session.pid) if alive else None,
        }

    def start_session(self, file: str) -> dict[str, Any]:
        file = self.check_file(file)
        with self._lock:
            if file in self.sessions or self._busy(file):
                raise ServiceError(409, "KERNEL_EXISTS", f"a kernel for {file} is already running")
            self.running[file] = STARTING
        self.hub.publish({"type": "kernel_starting", "file": file, "data": {}})
        try:
            session = LabSession(
                self.project,
                file,
                on_event=lambda event: self._forward(file, event),
                timeout_s=self.timeout_s,
            )
            session.start()
            self.sessions[file] = session
        except Exception as exc:
            raise ServiceError(500, "KERNEL_START_FAILED", f"{type(exc).__name__}: {exc}") from exc
        finally:
            self.running[file] = None
        return self.kernel_info(file)

    def stop_session(self, file: str) -> dict[str, Any]:
        file = self.check_file(file)
        session = self._session(file)
        if self._busy(file):
            session.interrupt()
        self.sessions.pop(file, None)
        session.shutdown()
        self.running[file] = None
        return {"status": "none"}

    def restart_session(self, file: str) -> dict[str, Any]:
        file = self.check_file(file)
        session = self._session(file)
        if self._busy(file):
            raise ServiceError(409, "KERNEL_BUSY", "interrupt the running block before restarting")
        session.restart()
        return self.kernel_info(file)

    def interrupt(self, file: str) -> dict[str, Any]:
        file = self.check_file(file)
        self._session(file).interrupt()
        return self.kernel_info(file)

    def clean_kernel(self, file: str) -> dict[str, Any]:
        file = self.check_file(file)
        session = self._session(file)
        if self._busy(file):
            raise ServiceError(409, "KERNEL_BUSY", "wait for the run to finish")
        return {"removed": session.clean_kernel()}

    def _forward(self, file: str, event: LabEvent) -> None:
        payload = event.model_dump(mode="json")
        self.hub.publish({"file": file, **payload})

    # --------------------------------------------------------------------- execution
    def execute(self, file: str, node_id: str | None, mode: RunMode) -> dict[str, Any]:
        file = self.check_file(file)
        session = self._session(file)
        with self._lock:
            if self._busy(file):
                raise ServiceError(409, "KERNEL_BUSY", f"{self.running[file]} is still running")
            session.refresh()
            try:
                plan = session.plan(node_id, mode)
            except KeyError as exc:
                raise ServiceError(404, "UNKNOWN_NODE", str(exc).strip("'")) from exc
            if not plan:
                raise ServiceError(422, "NOTHING_TO_RUN", "no blocks match this run")
            self.running[file] = QUEUED
        self.pool.submit(self._run, file, session, node_id, mode)
        return {"plan": plan}

    def _run(self, file: str, session: LabSession, node_id: str | None, mode: RunMode) -> None:
        self.hub.publish({"type": "run_started", "file": file, "data": {"node_id": node_id, "mode": mode}})
        executed: list[dict[str, Any]] = []
        error: dict[str, str] | None = None
        try:
            for target in session.plan(node_id, mode):
                self.running[file] = target
                record = session.run_node(target)
                executed.append({"node_id": target, "status": record.status})
                if record.status != "success":
                    break
        except KernelDied as exc:
            error = {"code": "KERNEL_DIED", "message": str(exc)}
        except Exception as exc:  # noqa: BLE001 - reported to the client instead of lost in a thread
            error = {"code": "RUN_FAILED", "message": f"{type(exc).__name__}: {exc}"}
        finally:
            self.running[file] = None
            self.hub.publish(
                {"type": "run_finished", "file": file, "data": {"executed": executed, "error": error}}
            )

    def state(self, file: str) -> dict[str, Any]:
        file = self.check_file(file)
        session = self.sessions.get(file)
        running = self.running.get(file)
        if session is not None:
            session.refresh()
            stale = set(session.stale_nodes())
            graph = session.graph
        else:
            stale = set()
            graph = self.project.analyse(file)
        nodes: dict[str, Any] = {}
        for node in graph.code_nodes():
            record = session.last_run.get(node.id) if session else None
            if running == node.id:
                state = "running"
            elif node.id in stale:
                state = "stale"
            else:
                state = record.status if record else "idle"
            nodes[node.id] = {
                "state": state,
                "last_run": _record_summary(record),
                "values": self._values(record.execution_id) if record else {},
                "metrics": record.metrics[-1000:] if record else [],
            }
        hidden: list[dict[str, Any]] = []
        if session is not None and running is None and session.is_alive():
            hidden = [w.model_dump(mode="json") for w in session.hidden_state()]
        return {
            "file": file,
            "kernel": self.kernel_info(file),
            "nodes": nodes,
            "hidden_state": hidden,
            "resources": self.resources(),
        }

    def _values(self, execution_id: str) -> dict[str, dict[str, str]]:
        """Short labels for the variables a run produced; the canvas shows them on edges."""
        cached = self._values_cache.get(execution_id)
        if cached is None:
            snapshot = self.snapshots.load(execution_id)
            if snapshot is None:  # the run is recorded before its snapshot is written; retry next poll
                return {}
            after = snapshot.get("after") or {}
            cached = {
                name: {"kind": str(summary.get("kind", "")), "text": short_value(summary)}
                for name, summary in after.items()
                if isinstance(summary, dict)
            }
            if len(self._values_cache) > 1000:
                self._values_cache.clear()
            self._values_cache[execution_id] = cached
        return cached

    def resources(self) -> dict[str, Any]:
        data = system_resources(self.project.root)
        data["kernels"] = {
            file: process_memory_mb(session.pid)
            for file, session in self.sessions.items()
            if session.is_alive()
        }
        return data

    # --------------------------------------------------------------------- snapshots
    def inspect(self, file: str, node_id: str) -> dict[str, Any]:
        file = self.check_file(file)
        snapshot = self.snapshots.latest(node_id, file)
        if snapshot is None:
            raise ServiceError(404, "NO_SNAPSHOT", f"{node_id} has not run yet")
        limit = self.project.config.max_preview_rows
        keys = (
            "execution_id",
            "node_id",
            "status",
            "started_at",
            "duration_ms",
            "source_hash",
            "rows_in",
            "rows_out",
        )
        return {
            **{k: snapshot.get(k) for k in keys},
            "before": _cap_samples(snapshot.get("before") or {}, limit),
            "after": _cap_samples(snapshot.get("after") or {}, limit),
        }

    def output(self, file: str, execution_id: str, index: int) -> tuple[str, bytes]:
        """Payload of one rich output (image, HTML, Vega-Lite, ...) recorded for ``file``."""
        file = self.check_file(file)
        if not EXECUTION_ID.match(execution_id):
            raise ServiceError(400, "BAD_EXECUTION_ID", "not an execution id")
        snapshot = self.snapshots.load(execution_id)
        if snapshot is None or snapshot.get("file") != file:
            raise ServiceError(404, "NO_OUTPUT", f"{execution_id} is not a run of {file}")
        if not 0 <= index < len(snapshot.get("rich_outputs") or []):
            raise ServiceError(404, "NO_OUTPUT", f"{execution_id} has no output #{index}")
        found = self.output_store.read(execution_id, index)
        if found is None:
            raise ServiceError(
                410,
                "OUTPUT_GONE",
                "this output is no longer stored (too large or evicted); run the block again",
            )
        return found

    def history(self, file: str, node_id: str) -> list[dict[str, Any]]:
        file = self.check_file(file)
        keys = (
            "execution_id",
            "status",
            "started_at",
            "duration_ms",
            "peak_memory_mb",
            "rows_in",
            "rows_out",
            "source_hash",
        )
        return [{k: s.get(k) for k in keys} for s in self.snapshots.history(node_id, file)[:50]]

    def diff(
        self,
        file: str,
        *,
        node_a: str | None = None,
        node_b: str | None = None,
        execution_a: str | None = None,
        execution_b: str | None = None,
        variable: str | None = None,
    ) -> dict[str, Any]:
        file = self.check_file(file)
        snap_a = (
            self.snapshots.load(execution_a) if execution_a else self.snapshots.latest(node_a or "", file)
        )
        snap_b = (
            self.snapshots.load(execution_b) if execution_b else self.snapshots.latest(node_b or "", file)
        )
        if snap_a is None or snap_b is None:
            raise ServiceError(404, "NO_SNAPSHOT", "both sides need to have run at least once")
        result = diff_executions(snap_a, snap_b, variable)
        if result is None:
            raise ServiceError(
                422, "NOTHING_TO_COMPARE", "no table-like variables to compare at those points"
            )
        return {**dataclasses.asdict(result), "row_delta": result.row_delta, "text": result.format()}

    def shutdown(self) -> None:
        for session in list(self.sessions.values()):
            with contextlib.suppress(Exception):  # best effort on exit
                session.shutdown()
        self.sessions.clear()
        self.pool.shutdown(wait=False, cancel_futures=True)
