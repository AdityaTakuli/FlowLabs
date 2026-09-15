"""Kernel mode (PRD II 4, 8): execute blocks in a live Jupyter kernel with debugging support.

The kernel runs in the project directory with the active environment. Every execution
records timing, peak memory, rows in/out, stdout/stderr and before/after variable summaries,
and staleness is recomputed from source hashes so editing a node invalidates its descendants.
"""

from __future__ import annotations

import ast
import datetime as dt
import json
import queue
import re
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal

from jupyter_client.manager import KernelManager
from pydantic import BaseModel, Field

from .codegraph import CodeGraph, GraphWarning
from .diff import DataDiff, diff_summaries, pick_variables
from .kernel_helpers import HELPER_CODE, HELPER_NAME
from .project import LabProject
from .resources import MemorySampler, host_environment, process_memory_mb, system_resources
from .snapshots import SnapshotStore

RunMode = Literal["node", "to", "from", "stale", "all"]
NodeState = Literal["idle", "running", "success", "error", "stale", "interrupted"]
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_CELL_FRAME = re.compile(r"Cell In\[(\d+)\], line (\d+)")
_FILE_FRAME = re.compile(r"File (\S+?):(\d+)")


class KernelDied(RuntimeError):
    pass


class LabEvent(BaseModel):
    type: str
    node_id: str | None = None
    ts: str = Field(default_factory=lambda: dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds"))
    data: dict[str, Any] = Field(default_factory=dict)


class TraceFrame(BaseModel):
    node_id: str | None
    line: int
    file_line: int | None = None
    text: str


class ExecutionError(BaseModel):
    ename: str
    evalue: str
    traceback: list[str]
    frames: list[TraceFrame] = Field(default_factory=list)


class ExecutionRecord(BaseModel):
    """Mirrors the ``code_executions`` table (PRD II 10.2)."""

    execution_id: str
    file: str
    node_id: str
    source_hash: str
    status: Literal["success", "error", "interrupted"]
    seq: int
    started_at: str
    duration_ms: int
    peak_memory_mb: float | None = None
    memory_delta_mb: float | None = None
    rows_in: int | None = None
    rows_out: int | None = None
    execution_count: int | None = None
    stdout: str = ""
    stderr: str = ""
    outputs: list[str] = Field(default_factory=list)
    error: ExecutionError | None = None
    warnings: list[GraphWarning] = Field(default_factory=list)


def _max_rows(summaries: dict[str, dict[str, Any]]) -> int | None:
    rows = [s["rows"] for s in summaries.values() if isinstance(s.get("rows"), int)]
    return max(rows) if rows else None


class LabSession:
    def __init__(
        self,
        project: LabProject,
        file: str,
        *,
        on_event: Callable[[LabEvent], None] | None = None,
        timeout_s: float = 600.0,
        kernel_name: str = "python3",
    ) -> None:
        self.project = project
        self.file = file
        self.on_event = on_event
        self.timeout_s = timeout_s
        self.kernel_name = kernel_name
        config = project.init()
        self.sample_rows = config.snapshot_sample_rows
        self.snapshots = SnapshotStore(project.state_dir / "snapshots", config.snapshot_max_bytes)
        self.graph: CodeGraph = project.analyse(file)
        self.last_run: dict[str, ExecutionRecord] = {}
        self.peak_history: dict[str, float] = {}
        self.runtime_warnings: list[GraphWarning] = []
        self.environment: dict[str, Any] = {}
        self._count_to_node: dict[int, str] = {}
        self._module_mtimes: dict[str, float] = {}
        self._seq = 0
        self._running: str | None = None
        self._lock = threading.Lock()
        self.km: KernelManager | None = None
        self.kc: Any = None

    # ---------------------------------------------------------------- lifecycle
    def _emit(self, type_: str, node_id: str | None = None, **data: Any) -> None:
        if self.on_event is not None:
            self.on_event(LabEvent(type=type_, node_id=node_id, data=data))

    def start(self) -> LabSession:
        self.km = KernelManager(kernel_name=self.kernel_name)
        self.km.start_kernel(cwd=str(self.project.root))
        self.kc = self.km.blocking_client()
        self.kc.start_channels()
        self.kc.wait_for_ready(timeout=60)
        self._bootstrap()
        self._emit("kernel_started", pid=self.pid, resources=self.resources())
        return self

    def _bootstrap(self) -> None:
        reply = self.kc.execute_interactive(HELPER_CODE, silent=True, store_history=False, timeout=60)
        if reply["content"]["status"] != "ok":
            raise RuntimeError("could not install FlowLab helpers in the kernel")
        self.environment = {**host_environment(), **self._helper("environment")}

    def shutdown(self) -> None:
        if self.kc is not None:
            self.kc.stop_channels()
        if self.km is not None and self.km.has_kernel:
            self.km.shutdown_kernel(now=True)
        self._emit("kernel_stopped")

    def restart(self) -> None:
        assert self.km is not None
        self.km.restart_kernel(now=True)
        self.kc.wait_for_ready(timeout=60)
        self.last_run.clear()
        self._count_to_node.clear()
        self._bootstrap()
        self._emit("kernel_restarted")

    def interrupt(self) -> None:
        if self.km is not None:
            self.km.interrupt_kernel()
            self._emit("kernel_interrupted", node_id=self._running)

    def is_alive(self) -> bool:
        return bool(self.km is not None and self.km.is_alive())

    @property
    def pid(self) -> int | None:
        provisioner = getattr(self.km, "provisioner", None)
        pid = getattr(provisioner, "pid", None)
        if pid is None:
            process = getattr(provisioner, "process", None)
            pid = getattr(process, "pid", None)
        return int(pid) if pid else None

    def resources(self) -> dict[str, Any]:
        return {**system_resources(self.project.root), "kernel_memory_mb": process_memory_mb(self.pid)}

    def __enter__(self) -> LabSession:
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.shutdown()

    # ------------------------------------------------------------------ helpers
    def _helper(self, function: str, *args: Any) -> Any:
        """Call a kernel-side helper; arguments are passed as Python literals."""
        call = f"{HELPER_NAME}[{function!r}]({', '.join(repr(arg) for arg in args)})"
        reply = self.kc.execute_interactive(
            "", silent=True, store_history=False, user_expressions={"r": call}, timeout=120
        )
        result = reply["content"]["user_expressions"]["r"]
        if result.get("status") != "ok":
            raise RuntimeError(f"helper failed: {result.get('ename')}: {result.get('evalue')}")
        return json.loads(ast.literal_eval(result["data"]["text/plain"]))

    def summarize(self, names: list[str], sample_rows: int = 0) -> dict[str, dict[str, Any]]:
        if not names:
            return {}
        summaries: dict[str, dict[str, Any]] = self._helper(
            "summarize", list(dict.fromkeys(names)), sample_rows
        )
        return summaries

    def variables(self) -> dict[str, str]:
        found: dict[str, str] = self._helper("variables")
        return found

    def evaluate(self, expression: str) -> str:
        """Debug-here REPL: evaluate an expression against the live kernel namespace."""
        reply = self.kc.execute_interactive(
            "", silent=True, store_history=False, user_expressions={"r": expression}, timeout=120
        )
        result = reply["content"]["user_expressions"]["r"]
        if result.get("status") != "ok":
            return f"{result.get('ename')}: {result.get('evalue')}"
        return str(result["data"].get("text/plain", ""))

    # ---------------------------------------------------------------- staleness
    def refresh(self) -> CodeGraph:
        self.graph = self.project.analyse(self.file)
        return self.graph

    def stale_nodes(self) -> list[str]:
        stale: list[str] = []
        for node in self.graph.code_nodes():
            record = self.last_run.get(node.id)
            if record is None:
                continue
            if record.source_hash != node.source_hash:
                stale.append(node.id)
                continue
            for parent in self.graph.parents(node.id):
                parent_record = self.last_run.get(parent)
                if parent in stale or (parent_record is not None and parent_record.seq > record.seq):
                    stale.append(node.id)
                    break
        return stale

    def node_state(self, node_id: str) -> NodeState:
        if self._running == node_id:
            return "running"
        if node_id in self.stale_nodes():
            return "stale"
        record = self.last_run.get(node_id)
        return record.status if record else "idle"

    def plan(self, node_id: str | None, mode: RunMode) -> list[str]:
        graph = self.graph
        code_ids = {n.id for n in graph.code_nodes()}
        if mode == "all":
            return graph.in_source_order(code_ids)
        if mode == "stale":
            return self.stale_nodes()
        if node_id is None or node_id not in code_ids:
            raise KeyError(f"unknown node '{node_id}'")
        if mode == "node":
            return [node_id]
        if mode == "to":
            return graph.in_source_order((graph.ancestors(node_id) & code_ids) | {node_id})
        return graph.in_source_order((graph.descendants(node_id) & code_ids) | {node_id})

    # ---------------------------------------------------------------- execution
    def execute(self, node_id: str | None = None, mode: RunMode = "node") -> list[ExecutionRecord]:
        self.refresh()
        records: list[ExecutionRecord] = []
        for target in self.plan(node_id, mode):
            record = self.run_node(target)
            records.append(record)
            if record.status != "success":
                break
        return records

    def _preflight(self, node_id: str) -> list[GraphWarning]:
        warnings = []
        peak = self.peak_history.get(node_id)
        available = system_resources(self.project.root)["ram_available_mb"]
        if peak is not None and peak > available:
            warnings.append(
                GraphWarning(
                    node_id=node_id,
                    code="LOW_MEMORY",
                    message=f"last run peaked at {peak:.0f} MB but only {available:.0f} MB is available",
                )
            )
        stale = set(self.stale_nodes())
        for parent in self.graph.parents(node_id):
            node = self.graph.node(parent)
            if node is None or node.kind == "undefined":
                continue
            if parent not in self.last_run or parent in stale:
                warnings.append(
                    GraphWarning(
                        node_id=node_id,
                        code="EXECUTED_BEFORE_ANCESTOR",
                        message=f"running before its ancestor {parent} has run on its current code",
                    )
                )
        return warnings

    def _execute(self, code: str, hook: Callable[[dict[str, Any]], None]) -> dict[str, Any] | None:
        """Run code, streaming output to ``hook``. Returns the shell reply, or None if the kernel died.

        Unlike ``execute_interactive`` this polls kernel liveness while waiting, so a kernel killed
        by the OOM killer is reported within a fraction of a second instead of at the timeout.
        """
        msg_id = self.kc.execute(code, store_history=True, allow_stdin=False, stop_on_error=False)
        deadline = time.monotonic() + self.timeout_s
        idle = False
        while not idle:
            if time.monotonic() > deadline:
                raise TimeoutError(f"no reply within {self.timeout_s:.0f}s")
            try:
                message = self.kc.get_iopub_msg(timeout=0.2)
            except queue.Empty:
                if not self.is_alive():
                    return None
                continue
            if message.get("parent_header", {}).get("msg_id") != msg_id:
                continue
            if message["header"]["msg_type"] == "status":
                idle = message["content"].get("execution_state") == "idle"
            else:
                hook(message)
        while True:
            try:
                reply: dict[str, Any] = self.kc.get_shell_msg(timeout=0.5)
            except queue.Empty:
                if not self.is_alive():
                    return None
                if time.monotonic() > deadline:
                    raise TimeoutError(f"no reply within {self.timeout_s:.0f}s") from None
                continue
            if reply.get("parent_header", {}).get("msg_id") == msg_id:
                return reply

    def run_node(self, node_id: str) -> ExecutionRecord:
        node = self.graph.node(node_id)
        if node is None or node.kind == "undefined":
            raise KeyError(f"unknown node '{node_id}'")
        with self._lock:
            warnings = self._preflight(node_id)
            inputs = [n for n in [*node.uses, *node.mutates] if n not in node.imports]
            before = self.summarize(inputs)
            execution_id = f"ex_{uuid.uuid4().hex[:12]}"
            started_at = dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds")
            stdout: list[str] = []
            stderr: list[str] = []
            outputs: list[str] = []

            def hook(message: dict[str, Any]) -> None:
                kind, content = message["header"]["msg_type"], message["content"]
                if kind == "stream":
                    (stdout if content.get("name") == "stdout" else stderr).append(content.get("text", ""))
                    self._emit("stream", node_id, name=content.get("name"), text=content.get("text", ""))
                elif kind in ("execute_result", "display_data"):
                    data = content.get("data", {})
                    text = data.get("text/plain", "")
                    outputs.append(text if text else f"<{', '.join(sorted(data))}>")
                    self._emit("display", node_id, text=text, mimetypes=sorted(data))

            self._running = node_id
            self._emit("node_started", node_id, warnings=[w.model_dump() for w in warnings])
            status: Literal["success", "error", "interrupted"] = "success"
            error: ExecutionError | None = None
            count: int | None = None
            began = time.perf_counter()
            with MemorySampler(self.pid) as sampler:
                try:
                    reply = self._execute(node.source, hook)
                    if reply is not None:  # None: the kernel died; reported below
                        content = reply["content"]
                        count = content.get("execution_count")
                        if content["status"] == "error":
                            status = "error"
                            error = self._error(content, node_id)
                        elif content["status"] == "aborted":
                            status = "interrupted"
                except TimeoutError:
                    self.interrupt()
                    status = "interrupted"
                    error = ExecutionError(
                        ename="Timeout", evalue=f"exceeded {self.timeout_s:.0f}s", traceback=[]
                    )
            duration_ms = round((time.perf_counter() - began) * 1000)
            self._running = None

            if not self.is_alive():
                self._emit("kernel_died", node_id, last_memory_mb=sampler.last_mb)
                raise KernelDied(
                    f"the kernel died while running {node_id} (last memory reading "
                    f"{sampler.last_mb} MB); restart the kernel — this node may exceed available RAM"
                )
            if count is not None:
                self._count_to_node[int(count)] = node_id
            if status == "error" and error is not None and error.ename == "KeyboardInterrupt":
                status = "interrupted"

            produced = [n for n in [*node.defines, *node.mutates] if n not in node.imports]
            after = self.summarize(produced, self.sample_rows)
            if status == "success":
                warnings.extend(self._runtime_mutations(node_id, before, set(produced)))

            self._seq += 1
            record = ExecutionRecord(
                execution_id=execution_id, file=self.file, node_id=node_id, source_hash=node.source_hash,
                status=status, seq=self._seq, started_at=started_at, duration_ms=duration_ms,
                peak_memory_mb=sampler.peak_mb, memory_delta_mb=sampler.peak_delta_mb,
                rows_in=_max_rows(before), rows_out=_max_rows(after), execution_count=count,
                stdout="".join(stdout), stderr="".join(stderr), outputs=outputs,
                error=error, warnings=warnings,
            )  # fmt: skip
            self.last_run[node_id] = record
            if sampler.peak_mb is not None:
                self.peak_history[node_id] = max(self.peak_history.get(node_id, 0.0), sampler.peak_mb)
            self.runtime_warnings.extend(
                w for w in warnings if w.code in ("EXECUTED_BEFORE_ANCESTOR", "RUNTIME_MUTATION")
            )
            self._record_modules()
            self.snapshots.save({**record.model_dump(mode="json"), "before": before, "after": after})
            self._append_log(record)
            self._emit(
                "node_failed" if status != "success" else "node_completed",
                node_id,
                execution_id=execution_id,
                status=status,
                duration_ms=duration_ms,
                peak_memory_mb=sampler.peak_mb,
                rows_in=record.rows_in,
                rows_out=record.rows_out,
            )
            return record

    def _runtime_mutations(
        self, node_id: str, before: dict[str, dict[str, Any]], produced: set[str]
    ) -> list[GraphWarning]:
        read_only = [name for name in before if name not in produced and before[name].get("hash")]
        now = self.summarize(read_only)
        return [
            GraphWarning(
                node_id=node_id,
                code="RUNTIME_MUTATION",
                message=f"`{name}` changed while running this block although the analyser saw only a read",
            )
            for name in read_only
            if name in now and now[name].get("hash") and now[name]["hash"] != before[name]["hash"]
        ]

    def _error(self, content: dict[str, Any], node_id: str) -> ExecutionError:
        lines = [_ANSI.sub("", line) for line in content.get("traceback", [])]
        frames: list[TraceFrame] = []
        for text in "\n".join(lines).splitlines():
            cell = _CELL_FRAME.search(text)
            if cell:
                owner = self._count_to_node.get(int(cell.group(1)), node_id if frames == [] else None)
                line = int(cell.group(2))
                frames.append(
                    TraceFrame(
                        node_id=owner, line=line, file_line=self._file_line(owner, line), text=text.strip()
                    )
                )
                continue
            file_frame = _FILE_FRAME.search(text)
            if file_frame and str(self.project.root) in file_frame.group(1):
                frames.append(TraceFrame(node_id=None, line=int(file_frame.group(2)), text=text.strip()))
        if not frames:
            frames.append(
                TraceFrame(
                    node_id=node_id,
                    line=1,
                    file_line=self._file_line(node_id, 1),
                    text=f"{content.get('ename')}: {content.get('evalue')}",
                )
            )
        return ExecutionError(
            ename=content.get("ename", "Error"),
            evalue=content.get("evalue", ""),
            traceback=lines,
            frames=frames,
        )

    def _file_line(self, node_id: str | None, line: int) -> int | None:
        node = self.graph.node(node_id) if node_id else None
        if node is None:
            return None
        return line if node.cell_index is not None else node.lines[0] + line - 1

    def _append_log(self, record: ExecutionRecord) -> None:
        log = self.project.state_dir / "executions" / (self.file.replace("/", "__") + ".jsonl")
        with log.open("a", encoding="utf-8") as handle:
            handle.write(record.model_dump_json() + "\n")

    # -------------------------------------------------------------- hidden state
    def _record_modules(self) -> None:
        try:
            modules: dict[str, str] = self._helper("local_modules", str(self.project.root))
        except RuntimeError:
            return
        for path in modules.values():
            if path not in self._module_mtimes and Path(path).exists():
                self._module_mtimes[path] = Path(path).stat().st_mtime

    def orphan_variables(self) -> list[str]:
        defined = {name for node in self.graph.code_nodes() for name in node.defines}
        return sorted(name for name in self.variables() if name not in defined)

    def clean_kernel(self) -> list[str]:
        removed: list[str] = self._helper("delete", self.orphan_variables())
        self._emit("kernel_cleaned", removed=removed)
        return removed

    def stale_imports(self) -> list[GraphWarning]:
        warnings = []
        for path, mtime in self._module_mtimes.items():
            current = Path(path)
            if current.exists() and current.stat().st_mtime > mtime:
                rel = self.project.relative(current) if current.is_relative_to(self.project.root) else path
                warnings.append(
                    GraphWarning(
                        code="STALE_IMPORT",
                        message=(
                            f"{rel} changed on disk after it was imported; "
                            "use importlib.reload or restart the kernel"
                        ),
                    )
                )
        return warnings

    def hidden_state(self) -> list[GraphWarning]:
        warnings = list(self.runtime_warnings)
        orphans = self.orphan_variables()
        if orphans:
            warnings.append(
                GraphWarning(
                    code="ORPHAN_VARIABLES",
                    message=(
                        f"kernel holds names no current block defines: {', '.join(orphans)} "
                        "(clean kernel removes them)"
                    ),
                )
            )
        warnings.extend(self.stale_imports())
        stale = self.stale_nodes()
        if stale:
            warnings.append(
                GraphWarning(
                    code="STALE_NODES",
                    severity="info",
                    message=f"stale since their code or upstream changed: {', '.join(stale)}",
                )
            )
        return warnings

    # --------------------------------------------------------------- inspection
    def inspect(self, node_id: str, variable: str | None = None) -> dict[str, Any] | None:
        """Data that flowed out of ``node_id`` at its last run (edge inspection)."""
        snapshot = self.snapshots.latest(node_id, self.file)
        if snapshot is None:
            return None
        after: dict[str, dict[str, Any]] = snapshot.get("after", {})
        if variable is not None:
            return after.get(variable)
        return {"execution_id": snapshot["execution_id"], "variables": after}

    def diff(self, node_a: str, node_b: str, variable: str | None = None) -> DataDiff | None:
        snap_a = self.snapshots.latest(node_a, self.file)
        snap_b = self.snapshots.latest(node_b, self.file)
        if snap_a is None or snap_b is None:
            return None
        return diff_executions(snap_a, snap_b, variable)


def diff_executions(
    snap_a: dict[str, Any], snap_b: dict[str, Any], variable: str | None = None
) -> DataDiff | None:
    """Diff two snapshots: two nodes, or the same node across two runs."""
    choice = pick_variables(snap_a.get("after", {}), snap_b.get("after", {}), variable)
    if choice is None:
        return None
    left, right = choice
    return diff_summaries(
        snap_a["after"][left],
        snap_b["after"][right],
        label_a=f"{snap_a['node_id']}:{left}",
        label_b=f"{snap_b['node_id']}:{right}",
    )
