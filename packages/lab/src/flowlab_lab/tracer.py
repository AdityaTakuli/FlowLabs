"""Instrumented run for repo tracing (PRD II 7). Executed in a subprocess:

    python -m flowlab_lab.tracer --root ROOT --out trace.json --timeout 300 -- python train.py

Records every point where project code hands a tracked object (DataFrame, Series, ndarray,
fitted estimator) to library code or receives one back. Nodes are the project source
locations; edges follow object identity. Only calls made *from* project files are recorded
(site-packages is skipped). After ``--max-per-site`` records a site is sampled: object identity
is still followed but no further edges are recorded, so hot loops stay cheap. On timeout the
partial trace is kept.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import runpy
import signal
import sys
import threading
import time
import weakref
from collections import Counter
from types import FrameType
from typing import Any

Site = tuple[str, int]
TRACKED_MODULES = ("pandas", "numpy", "polars", "sklearn", "xgboost", "lightgbm", "scipy.sparse")
TABLE_TYPES = ("DataFrame", "Series", "ndarray", "LazyFrame", "csr_matrix", "csr_array")
FIT_METHODS = (".fit", ".partial_fit")
MAX_STRONG_REFS = 20_000


def tracked_type(obj: Any) -> str | None:
    kind = type(obj)
    module = kind.__module__ or ""
    if not module.startswith(TRACKED_MODULES):
        return None
    if kind.__name__ in TABLE_TYPES:
        return kind.__name__
    if hasattr(obj, "fit") and module.startswith(("sklearn", "xgboost", "lightgbm")):
        return kind.__name__
    return None


class Tracer:
    def __init__(self, root: str, max_per_site: int = 50) -> None:
        self.root = os.path.realpath(root) + os.sep
        self.max_per_site = max_per_site
        self.sites: dict[Site, dict[str, Any]] = {}
        self.edges: Counter[tuple[Site, Site, str]] = Counter()
        self._producers: dict[int, tuple[Any, Site]] = {}
        self._strong = 0
        self._in_project: dict[str, bool] = {}

    def in_project(self, filename: str) -> bool:
        cached = self._in_project.get(filename)
        if cached is None:
            path = "" if filename.startswith("<") else os.path.realpath(filename)
            cached = path.startswith(self.root) and "site-packages" not in path and "/.venv/" not in path
            self._in_project[filename] = cached
        return cached

    def relative(self, filename: str) -> str:
        return os.path.realpath(filename)[len(self.root) :]

    def producer_of(self, obj: Any) -> Site | None:
        entry = self._producers.get(id(obj))
        if entry is None:
            return None
        reference, site = entry
        current = reference() if isinstance(reference, weakref.ref) else reference
        return site if current is obj else None

    def set_producer(self, obj: Any, site: Site) -> None:
        try:
            reference: Any = weakref.ref(obj)
        except TypeError:
            if self._strong >= MAX_STRONG_REFS:
                return
            reference = obj
            self._strong += 1
        self._producers[id(obj)] = (reference, site)

    def trace(self, frame: FrameType, event: str, arg: Any) -> Any:
        if event != "call":
            return None
        caller = frame.f_back
        if caller is None or not self.in_project(caller.f_code.co_filename):
            return None
        if self.in_project(frame.f_code.co_filename):
            return None  # project → project: its library calls are recorded where they happen
        site: Site = (self.relative(caller.f_code.co_filename), caller.f_lineno)
        function = caller.f_code.co_qualname
        callee = f"{frame.f_globals.get('__name__', '?')}.{frame.f_code.co_qualname}"
        inputs = [value for value in list(frame.f_locals.values()) if tracked_type(value)]
        receiver = frame.f_locals.get("self") if frame.f_code.co_varnames[:1] == ("self",) else None
        frame.f_trace_lines = False

        def on_event(inner: FrameType, inner_event: str, value: Any) -> Any:
            if inner_event == "return":
                self.record(site, function, callee, inputs, receiver, value)
            return on_event

        return on_event

    def record(
        self, site: Site, function: str, callee: str, inputs: list[Any], receiver: Any, value: Any
    ) -> None:
        output = value if tracked_type(value) else None
        if output is None and tracked_type(receiver) and callee.endswith((*FIT_METHODS, ".__init__")):
            output = receiver  # constructors create it; estimator.fit() mutates and returns it
        if output is None and not inputs:
            return  # no tracked object flowed in or out (imports, logging, helpers)
        entry = self.sites.setdefault(
            site, {"function": function, "callees": Counter(), "count": 0, "sampled": False}
        )
        entry["count"] += 1
        if entry["count"] > self.max_per_site:
            entry["sampled"] = True  # hot loop: keep following identity, stop recording detail
            if output is not None:
                self.set_producer(output, site)
            return
        entry["callees"][".".join(callee.rsplit(".", 2)[-2:])] += 1
        for obj in inputs:
            producer = self.producer_of(obj)
            if producer is not None and producer != site:
                self.edges[(producer, site, tracked_type(obj) or "object")] += 1
        if output is not None:
            self.set_producer(output, site)

    def payload(self) -> dict[str, Any]:
        sites = [
            {
                "file": file, "line": line, "function": entry["function"],
                "callees": dict(entry["callees"]), "count": entry["count"], "sampled": entry["sampled"],
            }
            for (file, line), entry in sorted(self.sites.items())
            if entry["callees"]
        ]  # fmt: skip
        edges = [
            {"from": list(a), "to": list(b), "type": kind, "count": count}
            for (a, b, kind), count in sorted(self.edges.items())
        ]
        return {"sites": sites, "edges": edges}


def _command(argv: list[str]) -> tuple[str, list[str], bool]:
    if argv and os.path.basename(argv[0]).startswith("python"):
        argv = argv[1:]
    if not argv:
        raise SystemExit("no command to trace")
    if argv[0] == "-m":
        return argv[1], argv[2:], True
    return argv[0], argv[1:], False


def main(args: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="flowlab_lab.tracer")
    parser.add_argument("--root", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--timeout", type=float, default=300.0)
    parser.add_argument("--max-per-site", type=int, default=50)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    options = parser.parse_args(args)
    command = options.command[1:] if options.command[:1] == ["--"] else options.command
    target, target_args, is_module = _command(command)

    tracer = Tracer(options.root, options.max_per_site)
    timed_out = threading.Event()

    def watchdog() -> None:
        timed_out.set()
        os.kill(os.getpid(), signal.SIGINT)  # a real signal also wakes blocking calls such as sleep()

    timer = threading.Timer(options.timeout, watchdog)
    timer.daemon = True
    started = dt.datetime.now(dt.UTC).isoformat(timespec="seconds")
    exit_code: int | None = 0
    error: str | None = None
    began = time.perf_counter()
    os.chdir(options.root)
    sys.argv = [target, *target_args]
    if not is_module:
        sys.path.insert(0, os.path.dirname(os.path.abspath(target)))
    timer.start()
    threading.settrace(tracer.trace)
    sys.settrace(tracer.trace)
    try:
        if is_module:
            runpy.run_module(target, run_name="__main__", alter_sys=True)
        else:
            runpy.run_path(target, run_name="__main__")
    except SystemExit as exc:
        exit_code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    except KeyboardInterrupt:
        exit_code = None if timed_out.is_set() else 130
        error = None if timed_out.is_set() else "interrupted"
    except BaseException as exc:  # noqa: BLE001 - the traced program's failure is data
        exit_code, error = 1, f"{type(exc).__name__}: {exc}"
    finally:
        sys.settrace(None)
        threading.settrace(None)
        timer.cancel()
    result = {
        "command": command,
        "started_at": started,
        "duration_s": round(time.perf_counter() - began, 3),
        "partial": timed_out.is_set(),
        "exit_code": exit_code,
        "error": error,
        **tracer.payload(),
    }
    with open(options.out, "w", encoding="utf-8") as handle:
        json.dump(result, handle)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
