"""Local Flow Mode service: flow files, compile-on-edit, runs and node outputs.

Flows are Flow Spec JSON files inside the project root. Datasets are tabular files under the
root; a binding value is a path relative to the root (``data/churn.csv``), a name next to the
flow, or a file stem that is unique in the project (``churn``). Runs go to
``.flowlab/runs/<run_id>`` with the engine's content-addressed cache in ``.flowlab/cache``.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import json
import os
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import polars as pl
from flowlab_engine import compile_flow, execute_plan
from flowlab_engine.compiler import infer_port_schemas
from flowlab_engine.datasets import find_dataset_file
from flowlab_engine.executor import new_run_id
from flowlab_lab.project import IGNORED_DIRS, LabProject, PathError
from flowlab_nodes import catalogue, infer_table_schema, read_table, table_hash
from flowlab_nodes.io import SUPPORTED_SUFFIXES
from flowspec import (
    CompileIssue,
    CompileResult,
    ExecutionPlan,
    FlowSpec,
    PortType,
    RunEvent,
    TableSchema,
    sha256_bytes,
    to_jsonable,
)
from pydantic import ValidationError

from .service import EventHub, ServiceError

MAX_FLOW_BYTES = 5 * 1024 * 1024
MAX_INDEXED_FILES = 20_000
MAX_EVENTS = 5000
RUN_ID = re.compile(r"^run_[A-Za-z0-9_]{1,64}$")
DATASET_SUFFIXES = tuple(s for s in SUPPORTED_SUFFIXES if s != ".json")  # .json files are flows


def _now() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds")


def _issue(
    code: str, message: str, node_id: str | None = None, suggestion: str | None = None
) -> CompileIssue:
    return CompileIssue(node_id=node_id, code=code, severity="error", message=message, suggestion=suggestion)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:40] or "flow"


class FlowService:
    def __init__(self, project: LabProject, hub: EventHub) -> None:
        self.project = project
        self.hub = hub
        self.runs_dir = project.state_dir / "runs"
        self.cache_dir = project.state_dir / "cache"
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="flowlab-flow")
        self._lock = threading.Lock()
        self._schemas: dict[tuple[str, int, int], TableSchema] = {}
        self.active: dict[str, Any] | None = None  # {"run_id", "file", "flow_id", "cancel": Event}

    # ------------------------------------------------------------------------ files
    def _walk(self) -> tuple[list[str], list[str]]:
        flows: list[str] = []
        datasets: list[str] = []
        seen = 0
        root = self.project.root
        for directory, subdirs, files in os.walk(root, followlinks=False):
            subdirs[:] = sorted(d for d in subdirs if d not in IGNORED_DIRS and not d.startswith("."))
            for name in sorted(files):
                seen += 1
                if seen > MAX_INDEXED_FILES:
                    return flows, datasets
                path = Path(directory) / name
                if not path.resolve().is_relative_to(root):
                    continue  # symlink leaving the project
                relative = path.relative_to(root).as_posix()
                if name.endswith(".json"):
                    if self._looks_like_flow(path):
                        flows.append(relative)
                elif name.endswith(DATASET_SUFFIXES):
                    datasets.append(relative)
        return flows, datasets

    @staticmethod
    def _looks_like_flow(path: Path) -> bool:
        try:
            if path.stat().st_size > MAX_FLOW_BYTES:
                return False
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        return isinstance(data, dict) and "spec_version" in data and isinstance(data.get("nodes"), list)

    def index(self) -> dict[str, Any]:
        flows, datasets = self._walk()
        return {"flows": flows, "datasets": datasets}

    def _resolve(self, file: str, suffixes: tuple[str, ...], what: str) -> Path:
        if not file.endswith(suffixes):
            raise ServiceError(400, "UNSUPPORTED_FILE", f"{what} must end with {' or '.join(suffixes)}")
        try:
            return self.project.resolve(file)
        except PathError as exc:
            raise ServiceError(403, "PATH_OUTSIDE_ROOT", str(exc)) from exc

    def catalogue(self) -> dict[str, Any]:
        return catalogue()

    def load(self, file: str) -> dict[str, Any]:
        path = self._resolve(file, (".json",), "a flow file")
        if not path.is_file():
            raise ServiceError(404, "FILE_NOT_FOUND", f"{file} does not exist")
        data = path.read_bytes()
        try:
            spec = json.loads(data)
        except ValueError as exc:
            raise ServiceError(422, "NOT_JSON", f"{file} is not valid JSON: {exc}") from exc
        if not isinstance(spec, dict):
            raise ServiceError(422, "SPEC_INVALID", f"{file} does not contain a Flow Spec object")
        return {"file": self.project.relative(path), "hash": sha256_bytes(data), "spec": spec}

    def save(self, file: str, spec: dict[str, Any], expected_hash: str | None) -> dict[str, Any]:
        path = self._resolve(file, (".json",), "a flow file")
        try:
            model = FlowSpec.model_validate(spec)
        except ValidationError as exc:
            issues = [i.model_dump() for i in compile_flow(spec, {}).errors]
            raise ServiceError(
                422,
                "SPEC_INVALID",
                f"not a valid Flow Spec: {exc.error_count()} problem(s)",
                {"issues": issues},
            ) from exc
        relative = self.project.relative(path)
        with self._lock:
            if path.exists() and expected_hash and sha256_bytes(path.read_bytes()) != expected_hash:
                raise ServiceError(409, "FILE_CHANGED", f"{relative} changed on disk since you opened it")
            path.parent.mkdir(parents=True, exist_ok=True)
            text = json.dumps(model.model_dump(mode="json"), indent=2, ensure_ascii=False) + "\n"
            content_hash = self.project.write_atomic(relative, text)
        return {"file": relative, "hash": content_hash}

    def create(self, file: str, name: str, dataset: str | None) -> dict[str, Any]:
        path = self._resolve(file, (".json",), "a flow file")
        if path.exists():
            raise ServiceError(409, "FILE_EXISTS", f"{file} already exists")
        nodes: list[dict[str, Any]] = []
        bindings: dict[str, str] = {}
        if dataset:
            self._dataset_path(dataset)
            bindings["primary"] = dataset
            nodes.append(
                {
                    "id": "source",
                    "type": "source.dataset",
                    "label": Path(dataset).stem,
                    "params": {"dataset_ref": "primary"},
                    "position": {"x": 40, "y": 160},
                }
            )
        spec = {
            "spec_version": "1.0",
            "flow_id": f"flw_{_slug(name)}_{uuid.uuid4().hex[:6]}",
            "name": name.strip() or "Untitled flow",
            "created_by": "user",
            "dataset_bindings": bindings,
            "nodes": nodes,
            "edges": [],
        }
        return {**self.save(file, spec, None), "spec": FlowSpec.model_validate(spec).model_dump(mode="json")}

    # ---------------------------------------------------------------------- datasets
    def _dataset_path(self, value: str) -> Path:
        try:
            path = self.project.resolve(value)
        except PathError as exc:
            raise ServiceError(403, "PATH_OUTSIDE_ROOT", str(exc)) from exc
        if not path.is_file() or not path.name.endswith(SUPPORTED_SUFFIXES):
            raise ServiceError(404, "DATASET_NOT_FOUND", f"{value} is not a dataset file in this project")
        return path

    def _find_dataset(self, value: str, flow_file: str | None) -> tuple[Path | None, CompileIssue | None]:
        search = [self.project.root]
        if flow_file:
            with contextlib.suppress(PathError):
                search.insert(0, self.project.resolve(flow_file).parent)
        for directory in search:
            try:
                found = find_dataset_file(directory, value)
            except OSError:
                found = None
            if found is not None:
                if not found.resolve().is_relative_to(self.project.root):
                    return None, _issue("PATH_OUTSIDE_ROOT", f"dataset '{value}' is outside the project root")
                return found.resolve(), None
        stem = Path(value).name
        matches = [d for d in self._walk()[1] if Path(d).stem == stem or Path(d).name == stem]
        if len(matches) == 1:
            return self.project.resolve(matches[0]), None
        if len(matches) > 1:
            return None, _issue(
                "DATASET_AMBIGUOUS",
                f"'{value}' matches {len(matches)} files: {', '.join(matches[:5])}",
                suggestion="Bind the dataset by its path relative to the project root",
            )
        return None, _issue(
            "DATASET_NOT_FOUND",
            f"no dataset file for '{value}' in this project",
            suggestion="Pick a dataset in the flow settings, or add the file to the project folder",
        )

    def _schema(self, path: Path) -> TableSchema:
        stat = path.stat()
        key = (str(path), stat.st_mtime_ns, stat.st_size)
        schema = self._schemas.get(key)
        if schema is None:
            df = read_table(path)
            schema = infer_table_schema(df, content_hash=table_hash(df))
            self._schemas = {k: v for k, v in self._schemas.items() if k[0] != str(path)}
            self._schemas[key] = schema
        return schema

    def dataset_profile(self, file: str) -> dict[str, Any]:
        path = self._dataset_path(file)
        try:
            schema = self._schema(path)
            head = read_table(path).head(self.project.config.max_preview_rows)
        except Exception as exc:  # noqa: BLE001 - unreadable file is a user-facing problem
            raise ServiceError(422, "DATASET_UNREADABLE", f"{type(exc).__name__}: {exc}") from exc
        return {
            "file": self.project.relative(path),
            "schema": schema.model_dump(mode="json"),
            "preview": _frame_preview(head, len(head)),
        }

    # ----------------------------------------------------------------------- compile
    def _compile(
        self, file: str | None, raw: dict[str, Any]
    ) -> tuple[CompileResult, dict[str, Path], dict[str, Any]]:
        try:
            spec = FlowSpec.model_validate(raw)
        except ValidationError:
            return compile_flow(raw, {}), {}, {}
        paths: dict[str, Path] = {}
        schemas: dict[str, TableSchema] = {}
        errors: list[CompileIssue] = []
        for ref, value in sorted(spec.dataset_bindings.items()):
            path, issue = self._find_dataset(value, file)
            if issue is not None:
                errors.append(issue.model_copy(update={"message": f"binding '{ref}': {issue.message}"}))
                continue
            assert path is not None
            try:
                schemas[ref] = self._schema(path)
                paths[ref] = path
            except Exception as exc:  # noqa: BLE001
                errors.append(_issue("DATASET_UNREADABLE", f"binding '{ref}': {type(exc).__name__}: {exc}"))
        node_schemas = infer_port_schemas(spec, schemas)
        result = CompileResult(ok=False, errors=errors) if errors else compile_flow(spec, schemas)
        return result, paths, node_schemas

    def compile(self, file: str | None, raw: dict[str, Any]) -> dict[str, Any]:
        result, paths, node_schemas = self._compile(file, raw)
        plan = result.plan
        return {
            "ok": result.ok,
            "errors": [i.model_dump() for i in result.errors],
            "warnings": [i.model_dump() for i in result.warnings],
            "schemas": {
                nid: {
                    side: {port: ps.model_dump(mode="json", exclude_none=True) for port, ps in ports.items()}
                    for side, ports in sides.items()
                }
                for nid, sides in node_schemas.items()
            },
            "order": [s.node_id for s in plan.steps] if plan else [],
            "cache_keys": {s.node_id: s.cache_key for s in plan.steps} if plan else {},
            "datasets": {ref: self.project.relative(p) for ref, p in paths.items()},
        }

    # -------------------------------------------------------------------------- runs
    def run(self, file: str | None, raw: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            if self.active is not None:
                raise ServiceError(409, "RUN_IN_PROGRESS", f"{self.active['run_id']} is still running")
            result, paths, _ = self._compile(file, raw)
            if not result.ok or result.plan is None:
                raise ServiceError(
                    422,
                    "COMPILE_FAILED",
                    "fix the compile errors before running",
                    {"errors": [i.model_dump() for i in result.errors]},
                )
            plan = result.plan
            run_id = new_run_id()
            cancel = threading.Event()
            self.active = {
                "run_id": run_id,
                "file": file,
                "flow_id": plan.flow_id,
                "cancel": cancel,
                "started_at": _now(),
                "flow_name": plan.flow_name,
            }
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        self.pool.submit(self._execute, file, raw, plan, paths, run_id, cancel)
        return {
            "run_id": run_id,
            "order": [s.node_id for s in plan.steps],
            "warnings": [i.model_dump() for i in result.warnings],
        }

    def _execute(
        self,
        file: str | None,
        raw: dict[str, Any],
        plan: ExecutionPlan,
        paths: dict[str, Path],
        run_id: str,
        cancel: threading.Event,
    ) -> None:
        def forward(event: RunEvent) -> None:
            self.hub.publish(
                {
                    "type": "flow_event",
                    "file": file,
                    "node_id": event.node_id,
                    "data": event.model_dump(mode="json"),
                }
            )

        status = "failed"
        error: dict[str, str] | None = None
        try:
            outcome = execute_plan(
                plan,
                paths,
                runs_dir=self.runs_dir,
                cache_dir=self.cache_dir,
                run_id=run_id,
                on_event=forward,
                should_cancel=cancel.is_set,
            )
            status, error = outcome.status, outcome.error
            (outcome.run_dir / "flow.json").write_text(
                json.dumps({"file": file, "spec": raw}, indent=2, ensure_ascii=False) + "\n"
            )
        except Exception as exc:  # noqa: BLE001 - reported to the client instead of lost in a thread
            error = {"code": "RUN_CRASHED", "message": f"{type(exc).__name__}: {exc}"}
        finally:
            with self._lock:
                self.active = None
            self.hub.publish(
                {
                    "type": "flow_run_finished",
                    "file": file,
                    "data": {"run_id": run_id, "status": status, "error": error},
                }
            )

    def cancel(self, run_id: str) -> dict[str, Any]:
        active = self.active
        if active is None or active["run_id"] != run_id:
            raise ServiceError(404, "NO_SUCH_RUN", f"{run_id} is not running")
        active["cancel"].set()
        return {"run_id": run_id, "cancelling": True}

    def _run_dir(self, run_id: str) -> Path:
        if not RUN_ID.match(run_id):
            raise ServiceError(400, "BAD_RUN_ID", "not a run id")
        run_dir = self.runs_dir / run_id
        if not run_dir.is_dir():
            raise ServiceError(404, "NO_SUCH_RUN", f"{run_id} does not exist")
        return run_dir

    def runs(self, flow_id: str | None, limit: int = 50) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        active = self.active
        if active is not None and (flow_id is None or active["flow_id"] == flow_id):
            found.append(
                {
                    "run_id": active["run_id"],
                    "status": "running",
                    "flow_id": active["flow_id"],
                    "flow_name": active["flow_name"],
                    "started_at": active["started_at"],
                    "finished_at": None,
                    "error": None,
                    "nodes": None,
                }
            )
        if not self.runs_dir.is_dir():
            return found
        for run_dir in sorted(self.runs_dir.iterdir(), reverse=True):
            if len(found) >= limit:
                break
            manifest_path = run_dir / "run.json"
            if not manifest_path.is_file() or (active and run_dir.name == active["run_id"]):
                continue
            try:
                manifest = json.loads(manifest_path.read_text())
            except (OSError, ValueError):
                continue
            if flow_id is not None and manifest.get("flow_id") != flow_id:
                continue
            nodes = manifest.get("nodes", [])
            found.append(
                {
                    **{
                        k: manifest.get(k)
                        for k in (
                            "run_id",
                            "status",
                            "flow_id",
                            "flow_name",
                            "started_at",
                            "finished_at",
                            "error",
                        )
                    },
                    "nodes": {
                        s: sum(n.get("status") == s for n in nodes)
                        for s in ("success", "cached", "failed", "skipped")
                    },
                }
            )
        return found

    def run_detail(self, run_id: str) -> dict[str, Any]:
        run_dir = self._run_dir(run_id)
        manifest_path = run_dir / "run.json"
        manifest = json.loads(manifest_path.read_text()) if manifest_path.is_file() else None
        events: list[dict[str, Any]] = []
        events_path = run_dir / "events.jsonl"
        if events_path.is_file():
            with events_path.open() as stream:
                for line in stream:
                    if len(events) >= MAX_EVENTS:
                        break
                    if line.strip():
                        events.append(json.loads(line))
        return {
            "run_id": run_id,
            "running": self.active is not None and self.active["run_id"] == run_id,
            "manifest": manifest,
            "events": events,
        }

    def node_output(self, run_id: str, node_id: str) -> dict[str, Any]:
        run_dir = self._run_dir(run_id)
        plan_path = run_dir / "plan.json"
        if not plan_path.is_file():
            raise ServiceError(404, "NO_SUCH_RUN", f"{run_id} has no plan")
        plan = ExecutionPlan.model_validate_json(plan_path.read_text())
        step = next((s for s in plan.steps if s.node_id == node_id), None)
        if step is None:
            raise ServiceError(404, "UNKNOWN_NODE", f"{node_id} is not part of {run_id}")
        record = None
        manifest_path = run_dir / "run.json"
        if manifest_path.is_file():
            manifest = json.loads(manifest_path.read_text())
            record = next((n for n in manifest.get("nodes", []) if n.get("node_id") == node_id), None)
        limit = self.project.config.max_preview_rows
        node_dir = run_dir / "nodes" / node_id
        ports: dict[str, Any] = {}
        for port, schema in step.output_schemas.items():
            entry: dict[str, Any] = {"kind": schema.kind.value}
            try:
                entry.update(_read_port(schema.kind, node_dir, port, limit))
            except FileNotFoundError:
                entry["missing"] = True
            if schema.model is not None:
                entry["model"] = schema.model.model_dump(mode="json")
            if schema.table is not None:
                entry["schema"] = schema.table.model_dump(mode="json", exclude_none=True)
            ports[port] = entry
        return {
            "run_id": run_id,
            "node_id": node_id,
            "node_type": step.node_type,
            "label": step.label,
            "params": step.params,
            "record": record,
            "outputs": ports,
        }

    def shutdown(self) -> None:
        if self.active is not None:
            self.active["cancel"].set()
        self.pool.shutdown(wait=False, cancel_futures=True)


def _frame_preview(df: pl.DataFrame, rows: int) -> dict[str, Any]:
    head = df.head(rows)
    return {
        "columns": head.columns,
        "dtypes": [str(t) for t in head.dtypes],
        "data": [[to_jsonable(v) for v in row] for row in head.rows()],
    }


def _read_port(kind: PortType, node_dir: Path, port: str, limit: int) -> dict[str, Any]:
    if kind == PortType.TABLE:
        df = pl.read_parquet(node_dir / f"{port}.parquet")
        return {"rows": df.height, "preview": _frame_preview(df, limit)}
    if kind == PortType.TABLE_SPLIT:
        part_dir = node_dir / port
        names = json.loads((part_dir / "_partitions.json").read_text())
        partitions = {}
        for name in names:
            df = pl.read_parquet(part_dir / f"{name}.parquet")
            partitions[name] = {"rows": df.height, "preview": _frame_preview(df, limit)}
        return {"partitions": partitions}
    if kind in (PortType.METRICS, PortType.CHART, PortType.REPORT):
        return {"value": json.loads((node_dir / f"{port}.json").read_text())}
    if not (node_dir / f"{port}.joblib").is_file():
        raise FileNotFoundError(port)
    return {}  # models are described by their compiled schema; the pickle is never loaded here
