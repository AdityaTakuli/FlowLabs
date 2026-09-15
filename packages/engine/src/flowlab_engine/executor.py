"""Local executor: runs an ExecutionPlan against local files (PRD Phase 0).

Node outputs are content-addressed in ``cache_dir`` by the compiler's cache key, and every
run gets a self-contained directory with artifacts, an event log and a manifest.
"""

from __future__ import annotations

import datetime as dt
import json
import shutil
import time
import traceback
import uuid
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

from flowlab_nodes import ExecContext, NodeRuntimeError, get_node
from flowspec import ExecutionPlan, PlanStep, RunEvent, RunEventType, to_jsonable

from .artifacts import check_value, read_value, write_value


@dataclass
class NodeRecord:
    node_id: str
    node_type: str
    status: Literal["success", "cached", "failed", "skipped"]
    cache_key: str
    cache_hit: bool = False
    duration_ms: int = 0
    output_hashes: dict[str, str] = field(default_factory=dict)
    warnings: list[dict[str, str]] = field(default_factory=list)
    error: dict[str, str] | None = None


@dataclass
class RunResult:
    run_id: str
    status: Literal["completed", "failed", "cancelled"]
    run_dir: Path
    nodes: list[NodeRecord]
    exports: list[dict[str, str]]
    error: dict[str, str] | None = None

    def output_hashes(self) -> dict[str, dict[str, str]]:
        return {n.node_id: n.output_hashes for n in self.nodes}


def _now() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds")


def new_run_id() -> str:
    return f"run_{dt.datetime.now(dt.UTC):%Y%m%dT%H%M%S}_{uuid.uuid4().hex[:6]}"


class _EventLog:
    def __init__(self, run_id: str, path: Path, sink: Callable[[RunEvent], None] | None) -> None:
        self.run_id = run_id
        self.seq = 0
        self.file = path.open("w", encoding="utf-8")
        self.sink = sink

    def emit(self, type_: RunEventType, node_id: str | None = None, **payload: Any) -> None:
        self.seq += 1
        event = RunEvent(
            run_id=self.run_id,
            seq=self.seq,
            type=type_,
            ts=_now(),
            node_id=node_id,
            payload=to_jsonable(payload),
        )
        self.file.write(event.model_dump_json() + "\n")
        self.file.flush()
        if self.sink:
            self.sink(event)

    def close(self) -> None:
        self.file.close()


def execute_plan(
    plan: ExecutionPlan,
    dataset_paths: Mapping[str, Path],
    *,
    runs_dir: Path,
    cache_dir: Path | None = None,
    export_dir: Path | None = None,
    run_id: str | None = None,
    on_event: Callable[[RunEvent], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> RunResult:
    """Run every step in order. ``should_cancel`` is checked between steps (a node is never killed
    mid-write, so its artifacts and the cache stay consistent)."""
    run_id = run_id or new_run_id()
    run_dir = runs_dir / run_id
    nodes_dir = run_dir / "nodes"
    nodes_dir.mkdir(parents=True, exist_ok=False)
    export_root = export_dir or run_dir / "exports"
    (run_dir / "plan.json").write_text(plan.model_dump_json(indent=2))

    log = _EventLog(run_id, run_dir / "events.jsonl", on_event)
    started = _now()
    log.emit("run_started", flow_id=plan.flow_id, steps=len(plan.steps), runner_version=plan.runner_version)

    values: dict[tuple[str, str], Any] = {}
    records: list[NodeRecord] = []
    exports: list[dict[str, str]] = []
    failure: dict[str, str] | None = None
    cancelled = False

    for step in plan.steps:
        record = NodeRecord(step.node_id, step.node_type, "skipped", step.cache_key)
        records.append(record)
        if failure is None and not cancelled and should_cancel is not None and should_cancel():
            cancelled = True
        if failure is not None or cancelled:
            continue
        log.emit("node_started", step.node_id, node_type=step.node_type, index=step.index)
        t0 = time.perf_counter()
        try:
            _run_step(
                step,
                plan,
                dataset_paths,
                values,
                record,
                nodes_dir / step.node_id,
                cache_dir,
                export_root,
                log,
                exports,
            )
        except NodeRuntimeError as exc:
            failure = {"node_id": step.node_id, "code": exc.code, "message": exc.message}
        except Exception as exc:  # node bugs must not take down the run log
            failure = {
                "node_id": step.node_id,
                "code": "NODE_EXCEPTION",
                "message": f"{type(exc).__name__}: {exc}",
                "traceback": traceback.format_exc(),
            }
        record.duration_ms = round((time.perf_counter() - t0) * 1000)
        if failure is not None:
            record.status = "failed"
            record.error = failure
            log.emit("node_failed", step.node_id, code=failure["code"], message=failure["message"])
        else:
            log.emit(
                "node_completed",
                step.node_id,
                cache_hit=record.cache_hit,
                duration_ms=record.duration_ms,
                output_hashes=record.output_hashes,
            )

    status: Literal["completed", "failed", "cancelled"] = (
        "failed" if failure else "cancelled" if cancelled else "completed"
    )
    if failure:
        log.emit("run_failed", failure["node_id"], code=failure["code"], message=failure["message"])
    elif cancelled:
        log.emit("run_cancelled", skipped=sum(r.status == "skipped" for r in records))
    else:
        log.emit("run_completed", nodes=len(records))
    log.close()

    manifest = {
        "run_id": run_id,
        "flow_id": plan.flow_id,
        "flow_name": plan.flow_name,
        "spec_hash": plan.spec_hash,
        "runner_version": plan.runner_version,
        "seed": plan.seed,
        "status": status,
        "started_at": started,
        "finished_at": _now(),
        "nodes": [asdict(r) for r in records],
        "exports": exports,
        "error": failure,
    }
    (run_dir / "run.json").write_text(json.dumps(to_jsonable(manifest), indent=2) + "\n")
    return RunResult(run_id, status, run_dir, records, exports, failure)


def _run_step(
    step: PlanStep,
    plan: ExecutionPlan,
    dataset_paths: Mapping[str, Path],
    values: dict[tuple[str, str], Any],
    record: NodeRecord,
    node_dir: Path,
    cache_dir: Path | None,
    export_root: Path,
    log: _EventLog,
    exports: list[dict[str, str]],
) -> None:
    impl = get_node(step.node_type)
    if impl is None:
        raise NodeRuntimeError("UNKNOWN_NODE_TYPE", f"runner does not know '{step.node_type}'")
    inputs = {port: values[(ref.node_id, ref.port)] for port, ref in step.inputs.items()}

    entry = cache_dir / step.cache_key.removeprefix("sha256:") if cache_dir else None
    manifest_path = entry / "manifest.json" if entry else None
    if step.cacheable and entry and manifest_path and manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text())
        shutil.copytree(entry, node_dir, dirs_exist_ok=True)
        (node_dir / "manifest.json").unlink(missing_ok=True)
        for port, schema in step.output_schemas.items():
            values[(step.node_id, port)] = read_value(schema.kind, node_dir, port)
            record.output_hashes[port] = manifest["outputs"][port]
            log.emit("artifact_written", step.node_id, port=port, hash=manifest["outputs"][port], cached=True)
        record.status = "cached"
        record.cache_hit = True
        return

    def on_warning(code: str, message: str) -> None:
        record.warnings.append({"code": code, "message": message})
        log.emit("node_warning", step.node_id, code=code, message=message)

    def on_file(path: Path, content_hash: str) -> None:
        exports.append({"node_id": step.node_id, "path": str(path), "hash": content_hash})
        record.output_hashes[f"file:{path.name}"] = content_hash
        log.emit("artifact_written", step.node_id, path=str(path), hash=content_hash)

    ctx = ExecContext(
        node_id=step.node_id,
        seed=plan.seed,
        input_schemas=step.input_schemas,
        output_schemas=step.output_schemas,
        dataset_paths=dataset_paths,
        dataset_hashes=plan.dataset_hashes,
        export_dir=export_root,
        on_warning=on_warning,
        on_log=lambda message: log.emit("node_log", step.node_id, message=message),
        on_file=on_file,
    )
    params = impl.parse_params(step.params)
    outputs = impl.execute(params, inputs, ctx)
    if set(outputs) != set(step.output_schemas):
        raise NodeRuntimeError("OUTPUT_PORTS_MISMATCH", f"produced ports {sorted(outputs)}")

    node_dir.mkdir(parents=True, exist_ok=True)
    for port, schema in step.output_schemas.items():
        value = outputs[port]
        check_value(port, schema, value)
        content_hash = write_value(schema.kind, value, node_dir, port)
        values[(step.node_id, port)] = value
        record.output_hashes[port] = content_hash
        log.emit("artifact_written", step.node_id, port=port, hash=content_hash, cached=False)
    record.status = "success"

    if step.cacheable and entry is not None and not entry.exists():
        tmp = entry.with_name(entry.name + f".tmp-{uuid.uuid4().hex[:8]}")
        shutil.copytree(node_dir, tmp)
        (tmp / "manifest.json").write_text(
            json.dumps({"node_type": step.node_type, "outputs": record.output_hashes}, indent=2)
        )
        try:
            tmp.rename(entry)
        except OSError:
            shutil.rmtree(tmp, ignore_errors=True)  # another run populated it first
