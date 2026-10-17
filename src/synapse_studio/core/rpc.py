"""One entry point for every engine: ``Engine.call(method, params)``.

The desktop app and ``synapse engine`` run this in a worker process (a "kernel" started from the
Python environment you choose); the browser runs the same code in Pyodide. Long jobs (training)
report progress as events and finish with a ``done``, ``error`` or ``cancelled`` event.
"""

from __future__ import annotations

import traceback
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import catalogue as cat
from . import datasets, env, evaluation, export, predict, training
from . import project as projects
from .training import Job
from .util import Cancelled, UserError, jsonable
from .workspace import Workspace

Emit = Callable[[dict[str, Any]], None]
Spawn = Callable[[Callable[[], None]], None]


class Engine:
    def __init__(self, root: str | Path, emit: Emit | None = None, spawn: Spawn | None = None) -> None:
        self.ws = Workspace(root)
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
        except UserError as error:
            return {"error": {"message": str(error), "user": True}}
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


def _cancel(engine: Engine, p: dict[str, Any]) -> Any:
    job = engine.jobs.get(_p(p, "job_id"))
    if job is not None:
        job.cancelled = True
    return {"cancelled": job is not None}


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
    "projects.new_model": lambda e, p: projects.model_entry(_p(p, "algo"), p.get("params"), bool(p.get("image"))),
    "train.start": lambda e, p: e.start_training(_p(p, "project"), _p(p, "job_id")),
    "train.cancel": _cancel,
    "runs.list": lambda e, p: training.list_runs(e.ws, _p(p, "project_id")),
    "runs.get": lambda e, p: training.get_run(e.ws, _p(p, "project_id"), _p(p, "run_id")),
    "runs.delete": lambda e, p: training.delete_run(e.ws, _p(p, "project_id"), _p(p, "run_id")),
    "export.build": lambda e, p: export.build(e.ws, _p(p, "project_id"), _p(p, "run_id"), _p(p, "model_id"),
                                              bool(p.get("include_data"))),
    "export.list": lambda e, p: export.list_exports(e.ws, _p(p, "project_id")),
    "predict.rows": lambda e, p: predict.predict_rows(e.ws, _p(p, "project_id"), _p(p, "run_id"), _p(p, "model_id"),
                                                      _p(p, "rows")),
    "predict.dataset": lambda e, p: predict.predict_dataset(e.ws, _p(p, "project_id"), _p(p, "run_id"),
                                                            _p(p, "model_id"), _p(p, "dataset_id")),
    "predict.image": lambda e, p: predict.predict_image(e.ws, _p(p, "project_id"), _p(p, "run_id"), _p(p, "model_id"),
                                                        _p(p, "image")),
}  # fmt: skip
