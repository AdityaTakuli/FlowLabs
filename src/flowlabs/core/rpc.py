"""One entry point for every engine: ``Engine.call(method, params)``.

The desktop app and ``flowlabs engine`` run this in a worker process (a "kernel" started from the
Python environment you choose); the browser runs the same code in Pyodide. Long jobs (training)
report progress as events and finish with a ``done``, ``error`` or ``cancelled`` event.
"""

from __future__ import annotations

import traceback
from collections.abc import Callable
from pathlib import Path
from typing import Any

import flowlabs_runtime as rt

from . import (
    ai,
    backup,
    codegen,
    databases,
    datasets,
    design,
    env,
    evaluation,
    export,
    localdb,
    plugins,
    predict,
    sources,
    sql,
    training,
    tunnel,
)
from . import catalogue as cat
from . import project as projects
from .training import Job
from .util import Cancelled, UserError, jsonable
from .workspace import Workspace

Emit = Callable[[dict[str, Any]], None]
Spawn = Callable[[Callable[[], None]], None]


class Engine:
    def __init__(self, root: str | Path, emit: Emit | None = None, spawn: Spawn | None = None) -> None:
        self.ws = Workspace(root)
        plugins.activate()  # drivers installed on first use (Snowflake, BigQuery...)
        self.emit: Emit = emit or (lambda event: None)
        self.spawn = spawn  # None: run jobs inline (Pyodide); else start them in the background
        self.jobs: dict[str, Job] = {}

    # ------------------------------------------------------------------------------ dispatch
    def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        handler = METHODS.get(method)
        if handler is None:
            raise UserError(f"unknown method {method}")
        return jsonable(handler(self, params or {}))

    def safe_call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """``{"result": ...}`` or ``{"error": {"message", "user", "traceback"}}``; never raises."""
        try:
            return {"result": self.call(method, params)}
        except (UserError, rt.CodeError) as error:  # a code step's own mistake is the user's to fix
            line = getattr(error, "line", None)  # where a SQL query failed, when the database says
            code = getattr(error, "code", None)  # e.g. session_gone: the app reconnects by itself
            return {"error": {"message": str(error), "user": True, **({"line": line} if line else {}),
                              **({"code": code} if code else {})}}  # fmt: skip
        except Exception as error:  # noqa: BLE001 - every failure goes back to the UI
            return {"error": {"message": f"{type(error).__name__}: {error}", "user": False,
                              "traceback": traceback.format_exc(limit=8)}}  # fmt: skip

    # ---------------------------------------------------------------------------------- jobs
    def start_training(self, project: dict[str, Any], job_id: str) -> dict[str, Any]:
        job = Job(job_id, self.emit)
        self.jobs[job_id] = job
        stored = projects.save(self.ws, project)

        def work() -> None:
            try:
                training.run(self.ws, stored, job)
            except Cancelled:
                job.emit("cancelled")
            except UserError as error:
                job.emit("error", message=str(error))
            except Exception as error:  # noqa: BLE001
                job.emit("error", message=f"{type(error).__name__}: {error}", traceback=traceback.format_exc(limit=8))
            finally:
                self.jobs.pop(job_id, None)

        if self.spawn is None:
            work()
        else:
            self.spawn(work)
        return {"job_id": job_id}


def _p(params: dict[str, Any], name: str) -> Any:
    if name not in params or params[name] in (None, ""):
        raise UserError(f"missing parameter {name}")
    return params[name]


def _info(engine: Engine, p: dict[str, Any]) -> Any:
    info = env.info(probe_gpu=bool(p.get("probe_gpu", True)))
    info["workspace"] = str(engine.ws.root)
    info["jobs"] = list(engine.jobs)
    return info


def _catalogue(engine: Engine, p: dict[str, Any]) -> Any:
    return {**cat.catalogue(env.packages()), "samples": datasets.SAMPLES,
            "metrics": {"classification": projects.CLASSIFICATION_METRICS, "regression": projects.REGRESSION_METRICS},
            "metric_labels": evaluation.METRIC_LABELS}  # fmt: skip


def _new_step(engine: Engine, p: dict[str, Any]) -> Any:
    op = cat.OPS.get(_p(p, "op"))
    if op is None:
        raise UserError("unknown step")
    return projects._step(op.stage, op.id, p.get("params"))


def _install_driver(engine: Engine, p: dict[str, Any]) -> Any:
    """Install a source's driver in the background; pip's output arrives as "install" events."""
    from .util import new_id

    source = sources.get(_p(p, "kind"))
    ssh = p.get("extra") == "ssh"  # paramiko, for connecting through SSH
    packages, modules = (list(tunnel.PACKAGES), list(tunnel.MODULES)) if ssh else (list(source.packages), list(source.modules))
    if not packages:
        raise UserError(f"{source.label} needs nothing installed")
    job_id = new_id("i")

    def work() -> None:
        code = plugins.install(packages, lambda line: engine.emit({"type": "install", "line": line, "job_id": job_id}))
        engine.emit({"type": "install", "done": True, "code": code, "job_id": job_id, "kind": source.id,
                     "extra": "ssh" if ssh else None, "needs": plugins.missing(modules)})  # fmt: skip

    if engine.spawn is None:
        work()
    else:
        engine.spawn(work)
    return {"job_id": job_id, "packages": packages}


def _cancel(engine: Engine, p: dict[str, Any]) -> Any:
    job = engine.jobs.get(_p(p, "job_id"))
    if job is not None:
        job.cancelled = True
    return {"cancelled": job is not None}


def _restore(engine: Engine, p: dict[str, Any]) -> Any:
    path = str(backup.stored_upload(engine.ws, _p(p, "path")))  # checked before the task starts
    return backup.start(lambda task: backup.restore(engine.ws, task, _p(p, "connection_id"), _p(p, "database"), path,
                                                    p.get("options") or {}), engine.emit, engine.spawn)


def _cursor(p: dict[str, Any]) -> int | None:
    value = p.get("cursor")
    return None if value is None else int(value)


def _save_connection(engine: Engine, p: dict[str, Any]) -> Any:
    saved = sql.save_connection(engine.ws, _p(p, "connection"))
    databases.forget(saved["id"])  # open sessions used the old settings
    return saved


def _delete_connection(engine: Engine, p: dict[str, Any]) -> Any:
    databases.forget(_p(p, "connection_id"))
    return sql.delete_connection(engine.ws, _p(p, "connection_id"))


METHODS: dict[str, Callable[[Engine, dict[str, Any]], Any]] = {
    "engine.info": _info,
    "engine.ping": lambda e, p: {"pong": True},
    "catalogue.get": _catalogue,
    "datasets.list": lambda e, p: datasets.list_datasets(e.ws),
    "datasets.import_path": lambda e, p: datasets.import_file(e.ws, Path(_p(p, "path")), p.get("filename")),
    "datasets.import_sample": lambda e, p: datasets.import_sample(e.ws, _p(p, "sample_id")),
    "datasets.profile": lambda e, p: datasets.profile(e.ws, _p(p, "dataset_id"), p.get("target")),
    "datasets.preview": lambda e, p: datasets.preview(e.ws, _p(p, "dataset_id"), int(p.get("offset", 0)),
                                                      int(p.get("limit", 100))),
    "datasets.delete": lambda e, p: datasets.delete_dataset(e.ws, _p(p, "dataset_id")),
    "datasets.rename": lambda e, p: datasets.rename_dataset(e.ws, _p(p, "dataset_id"), _p(p, "name")),
    "projects.list": lambda e, p: projects.list_projects(e.ws),
    "projects.create": lambda e, p: projects.new_project(e.ws, _p(p, "dataset_id"), p.get("name"), p.get("target"),
                                                         env.packages()),
    "projects.get": lambda e, p: projects.get(e.ws, _p(p, "project_id")),
    "projects.save": lambda e, p: projects.save(e.ws, _p(p, "project")),
    "projects.delete": lambda e, p: projects.delete(e.ws, _p(p, "project_id")),
    "projects.duplicate": lambda e, p: projects.duplicate(e.ws, _p(p, "project_id")),
    "projects.check": lambda e, p: projects.check(e.ws, _p(p, "project"), env.packages()),
    "projects.preview": lambda e, p: projects.preview(e.ws, _p(p, "project"), p.get("step_id")),
    "projects.new_step": _new_step,
    "projects.new_model": lambda e, p: projects.model_entry(_p(p, "algo"), p.get("params"), bool(p.get("image")),
                                                            p.get("task")),
    "projects.step_code": lambda e, p: codegen.step_code(e.ws, _p(p, "project"), _p(p, "stage"), _p(p, "item_id")),
    "train.start": lambda e, p: e.start_training(_p(p, "project"), _p(p, "job_id")),
    "train.cancel": _cancel,
    "runs.list": lambda e, p: training.list_runs(e.ws, _p(p, "project_id")),
    "runs.get": lambda e, p: training.get_run(e.ws, _p(p, "project_id"), _p(p, "run_id")),
    "runs.delete": lambda e, p: training.delete_run(e.ws, _p(p, "project_id"), _p(p, "run_id")),
    "export.build": lambda e, p: export.build(e.ws, _p(p, "project_id"), _p(p, "run_id"), _p(p, "model_id"),
                                              bool(p.get("include_data"))),
    "export.list": lambda e, p: export.list_exports(e.ws, _p(p, "project_id")),
    "sql.tables": lambda e, p: sql.tables(e.ws, p.get("dataset_id")),
    "sql.run": lambda e, p: sql.run(e.ws, str(p.get("sql") or ""), p.get("connection_id"),
                                    int(p.get("limit", sql.PREVIEW_ROWS)), int(p.get("offset", 0)), p.get("dataset_id")),
    "sql.save": lambda e, p: sql.save_result(e.ws, str(p.get("sql") or ""), str(p.get("name") or ""),
                                             p.get("connection_id"), p.get("dataset_id")),
    "ai.status": lambda e, p: ai.status(e.ws),
    "ai.configure": lambda e, p: ai.configure(e.ws, p.get("key"), p.get("model")),
    "ai.sql": lambda e, p: ai.write_sql(e.ws, str(p.get("question") or ""), p.get("connection_id"), p.get("dataset_id"),
                                        str(p.get("sql") or ""), p.get("error")),
    "sql.kinds": lambda e, p: sql.kinds(),
    "sources.install": _install_driver,
    "sql.connections": lambda e, p: sql.list_connections(e.ws),
    "sql.connection_save": _save_connection,
    "sql.connection_delete": _delete_connection,
    "sql.connection_test": lambda e, p: sql.test_connection(e.ws, _p(p, "connection")),
    "sql.connection_tables": lambda e, p: sql.connection_tables(e.ws, _p(p, "connection_id")),
    # Databases: browse, query, edit and administer PostgreSQL, MySQL and MariaDB (databases.py)
    "db.overview": lambda e, p: databases.overview(e.ws, _p(p, "connection_id")),
    "db.schemas": lambda e, p: databases.schemas(e.ws, _p(p, "connection_id"), _p(p, "database")),
    "db.objects": lambda e, p: databases.objects(e.ws, _p(p, "connection_id"), _p(p, "database"), p.get("schema")),
    "db.columns": lambda e, p: (localdb.columns(e.ws, p.get("database")) if p.get("connection_id") == localdb.LOCAL
                                else databases.columns(e.ws, _p(p, "connection_id"), _p(p, "database"), p.get("schema"))),
    "db.table": lambda e, p: databases.table(e.ws, _p(p, "connection_id"), _p(p, "database"), p.get("schema"),
                                             _p(p, "name")),
    "db.ddl": lambda e, p: databases.ddl(e.ws, _p(p, "connection_id"), _p(p, "database"), p.get("schema"),
                                         _p(p, "name"), _p(p, "kind"), p.get("signature"), p.get("table")),
    # a query tab on your datasets (connection "local") gets a DuckDB session (localdb.py)
    "db.session_open": lambda e, p: (localdb.open_session(e.ws, p.get("database")) if p.get("connection_id") == localdb.LOCAL
                                     else databases.open_session(e.ws, _p(p, "connection_id"), p.get("database"))),
    "db.session_close": lambda e, p: (localdb.close_session if localdb.owns(_p(p, "session_id"))
                                      else databases.close_session)(_p(p, "session_id")),
    "db.execute": lambda e, p: (localdb.execute if localdb.owns(_p(p, "session_id")) else databases.execute)(
        e.ws, _p(p, "session_id"), str(p.get("sql") or ""), int(p.get("limit", databases.PAGE_ROWS)), _cursor(p)),
    "db.cancel": lambda e, p: (localdb.cancel(_p(p, "session_id")) if localdb.owns(_p(p, "session_id"))
                               else databases.cancel(e.ws, _p(p, "session_id"))),
    "db.commit": lambda e, p: (localdb.finish_transaction(_p(p, "session_id"), True) if localdb.owns(_p(p, "session_id"))
                               else databases.finish_transaction(e.ws, _p(p, "session_id"), True)),
    "db.rollback": lambda e, p: (localdb.finish_transaction(_p(p, "session_id"), False) if localdb.owns(_p(p, "session_id"))
                                 else databases.finish_transaction(e.ws, _p(p, "session_id"), False)),
    "db.autocommit": lambda e, p: (localdb.describe(localdb.sessions[_p(p, "session_id")]) if localdb.owns(_p(p, "session_id"))
                                   else databases.set_autocommit(e.ws, _p(p, "session_id"), bool(p.get("on")))),
    "db.explain": lambda e, p: (localdb.explain if localdb.owns(_p(p, "session_id")) else databases.explain)(
        e.ws, _p(p, "session_id"), str(p.get("sql") or ""), bool(p.get("analyze")), _cursor(p)),
    "db.export": lambda e, p: (
        localdb.export(e.ws, p.get("database"), str(p.get("sql") or ""), _p(p, "format"), p.get("name"), _cursor(p))
        if p.get("connection_id") == localdb.LOCAL
        else databases.export_query(e.ws, _p(p, "connection_id"), p.get("database"), str(p.get("sql") or ""),
                                    _p(p, "format"), p.get("name"), _cursor(p))),
    "db.save_dataset": lambda e, p: (
        localdb.save_dataset(e.ws, p.get("database"), str(p.get("sql") or ""), str(p.get("name") or ""), _cursor(p))
        if p.get("connection_id") == localdb.LOCAL
        else databases.save_dataset(e.ws, _p(p, "connection_id"), p.get("database"), str(p.get("sql") or ""),
                                    str(p.get("name") or ""), _cursor(p))),
    "db.rows": lambda e, p: databases.rows(e.ws, _p(p, "connection_id"), _p(p, "database"), p.get("schema"),
                                           _p(p, "name"), int(p.get("offset", 0)), int(p.get("limit", 200)),
                                           p.get("order"), p.get("where")),
    "db.apply": lambda e, p: databases.apply_changes(e.ws, _p(p, "connection_id"), _p(p, "database"), p.get("schema"),
                                                     _p(p, "name"), _p(p, "changes"), bool(p.get("preview"))),
    "db.import": lambda e, p: databases.import_dataset(e.ws, _p(p, "connection_id"), _p(p, "database"),
                                                       p.get("schema"), _p(p, "name"), _p(p, "dataset_id"),
                                                       str(p.get("mode") or "create")),
    "db.activity": lambda e, p: databases.activity(e.ws, _p(p, "connection_id")),
    "db.stop": lambda e, p: databases.stop_session(e.ws, _p(p, "connection_id"), int(_p(p, "backend_id")),
                                                   bool(p.get("terminate"))),
    "db.users": lambda e, p: databases.users(e.ws, _p(p, "connection_id")),
    "db.grants": lambda e, p: databases.grants(e.ws, _p(p, "connection_id"), _p(p, "user"), p.get("host")),
    "db.privileges": lambda e, p: databases.privileges(e.ws, _p(p, "connection_id")),
    "db.user_change": lambda e, p: databases.user_change(e.ws, _p(p, "connection_id"), _p(p, "action"),
                                                         p.get("params") or {}, bool(p.get("preview"))),
    "db.diagram": lambda e, p: databases.diagram(e.ws, _p(p, "connection_id"), _p(p, "database"), p.get("schema")),
    "db.design": lambda e, p: design.design_of(e.ws, _p(p, "connection_id"), _p(p, "database"), p.get("schema"),
                                               _p(p, "name")),
    "db.design_sql": lambda e, p: design.design_sql(e.ws, _p(p, "connection_id"), _p(p, "database"), p.get("schema"),
                                                    p.get("original"), _p(p, "design")),
    "db.design_apply": lambda e, p: design.design_apply(e.ws, _p(p, "connection_id"), _p(p, "database"),
                                                        p.get("schema"), p.get("original"), _p(p, "design")),
    "db.backup_tools": lambda e, p: backup.tools(),
    "db.backup": lambda e, p: backup.start(
        lambda task: backup.backup(e.ws, task, _p(p, "connection_id"), _p(p, "database"), p.get("schema"),
                                   p.get("options") or {}), e.emit, e.spawn),
    "db.restore": _restore,
    "db.task_cancel": lambda e, p: backup.cancel(_p(p, "task_id")),
    "predict.rows": lambda e, p: predict.predict_rows(e.ws, _p(p, "project_id"), _p(p, "run_id"), _p(p, "model_id"),
                                                      _p(p, "rows")),
    "predict.dataset": lambda e, p: predict.predict_dataset(e.ws, _p(p, "project_id"), _p(p, "run_id"),
                                                            _p(p, "model_id"), _p(p, "dataset_id")),
    "predict.image": lambda e, p: predict.predict_image(e.ws, _p(p, "project_id"), _p(p, "run_id"), _p(p, "model_id"),
                                                        _p(p, "image")),
}  # fmt: skip
