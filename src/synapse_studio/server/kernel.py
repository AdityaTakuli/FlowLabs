"""Start, talk to and restart the kernel process (see ``synapse_studio.worker``)."""

from __future__ import annotations

import collections
import itertools
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future
from pathlib import Path
from typing import Any

from synapse_studio import __version__

Event = dict[str, Any]
SOURCE = Path(__file__).resolve().parents[1]  # .../synapse_studio
RUNTIME = SOURCE.parent / "synapse_runtime.py"
START_TIMEOUT_S = 120


class KernelError(RuntimeError):
    pass


def kernel_source() -> Path:
    """A folder holding only ``synapse_studio`` and ``synapse_runtime.py``, for another Python's path.

    Never point a foreign interpreter at this process's site-packages: it would import the wrong
    numpy. The copy lives under ``~/.synapse/kernel-src/<version>`` and is refreshed per version.
    """
    target = Path(os.environ.get("SYNAPSE_HOME", Path.home() / ".synapse")) / "kernel-src" / __version__
    stamp = target / ".stamp"
    marker = str(max((p.stat().st_mtime for p in SOURCE.rglob("*.py")), default=0))
    if stamp.is_file() and stamp.read_text() == marker:
        return target
    shutil.rmtree(target, ignore_errors=True)
    (target / "synapse_studio").mkdir(parents=True)
    ignore = shutil.ignore_patterns("__pycache__", "web", "*.pyc")
    shutil.copytree(SOURCE, target / "synapse_studio", ignore=ignore, dirs_exist_ok=True)
    shutil.copyfile(RUNTIME, target / "synapse_runtime.py")
    stamp.write_text(marker)
    return target


def command(python: str | None, root: Path) -> tuple[list[str], dict[str, str]]:
    environment = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
    environment.pop("PYTHONHOME", None)
    if python is None:
        if getattr(sys, "frozen", False):
            return [sys.executable, "--worker", "--root", str(root)], environment
        environment["PYTHONPATH"] = os.pathsep.join([str(SOURCE.parent), environment.get("PYTHONPATH", "")]).strip(
            os.pathsep
        )
        return [sys.executable, "-m", "synapse_studio.worker", "--root", str(root)], environment
    environment["PYTHONPATH"] = str(kernel_source())
    environment.pop("PYTHONSTARTUP", None)
    return [python, "-m", "synapse_studio.worker", "--root", str(root)], environment


class Kernel:
    def __init__(self, root: Path, python: str | None, on_event: Callable[[Event], None]) -> None:
        self.root, self.python, self.on_event = root, python, on_event
        self.process: subprocess.Popen[str] | None = None
        self.pending: dict[int, Future[dict[str, Any]]] = {}
        self.ids = itertools.count(1)
        self.lock = threading.Lock()
        self.status = "stopped"
        self.info: dict[str, Any] = {}
        self.error: str | None = None
        self.stderr: collections.deque[str] = collections.deque(maxlen=300)
        self.started_at = 0.0
        self._ready = threading.Event()

    # -------------------------------------------------------------------------------- lifecycle
    def start(self) -> None:
        argv, environment = command(self.python, self.root)
        self.status, self.error, self.info = "starting", None, {}
        self._ready.clear()
        self.stderr.clear()
        self.on_event({"type": "kernel", "status": "starting"})
        creation = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        try:
            self.process = subprocess.Popen(  # noqa: S603 - the interpreter the user chose
                argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                encoding="utf-8", errors="replace", bufsize=1, env=environment, cwd=str(self.root),
                creationflags=creation,
            )  # fmt: skip
        except OSError as error:
            self._fail(f"could not start {argv[0]}: {error}")
            return
        self.started_at = time.time()
        threading.Thread(target=self._read_stdout, args=(self.process,), daemon=True, name="kernel-out").start()
        threading.Thread(target=self._read_stderr, args=(self.process,), daemon=True, name="kernel-err").start()

    def wait_ready(self, timeout: float = START_TIMEOUT_S) -> None:
        if not self._ready.wait(timeout):
            self._fail("the kernel did not start in time")
        if self.status != "ready":
            raise KernelError(self.error or "the kernel is not running")

    def stop(self) -> None:
        process, self.process = self.process, None
        if process is not None and process.poll() is None:
            try:
                assert process.stdin is not None
                process.stdin.write(json.dumps({"method": "shutdown"}) + "\n")
                process.stdin.flush()
                process.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired, AssertionError):
                process.kill()
        self.status = "stopped"
        self._fail_pending("the kernel was stopped")

    def restart(self, python: str | None | object = ...) -> None:
        if python is not ...:
            self.python = python  # type: ignore[assignment]
        self.stop()
        self.start()

    # ----------------------------------------------------------------------------------- calls
    def call(self, method: str, params: dict[str, Any] | None = None, timeout: float | None = None) -> dict[str, Any]:
        """``{"result": ...}`` or ``{"error": {...}}`` from the kernel."""
        if self.status == "starting":
            self.wait_ready()
        process = self.process
        if process is None or process.poll() is not None or self.status != "ready":
            return {"error": {"message": self.error or "The engine is not running. Restart it from the Engine menu.",
                              "user": True, "kernel": True}}  # fmt: skip
        request_id = next(self.ids)
        future: Future[dict[str, Any]] = Future()
        with self.lock:
            self.pending[request_id] = future
            try:
                assert process.stdin is not None
                process.stdin.write(json.dumps({"id": request_id, "method": method, "params": params or {}}) + "\n")
                process.stdin.flush()
            except (OSError, AssertionError) as error:
                self.pending.pop(request_id, None)
                return {"error": {"message": f"the engine stopped: {error}", "user": True, "kernel": True}}
        try:
            return future.result(timeout=timeout)
        except TimeoutError:
            with self.lock:
                self.pending.pop(request_id, None)
            return {"error": {"message": f"{method} took too long", "user": True}}

    def describe(self) -> dict[str, Any]:
        return {"status": self.status, "python": self.python, "info": self.info, "error": self.error,
                "stderr": list(self.stderr)[-40:], "pid": self.process.pid if self.process else None,
                "uptime_s": round(time.time() - self.started_at) if self.status == "ready" else 0}  # fmt: skip

    # --------------------------------------------------------------------------------- readers
    def _read_stdout(self, process: subprocess.Popen[str]) -> None:
        assert process.stdout is not None
        for line in process.stdout:
            try:
                message = json.loads(line)
            except ValueError:
                self.stderr.append(line.rstrip())
                continue
            if "event" in message:
                event = message["event"]
                if event.get("type") == "ready":
                    self.info = event.get("info") or {}
                    self.status = "ready"
                    self._ready.set()
                    self.on_event({"type": "kernel", "status": "ready", "info": self.info})
                else:
                    self.on_event(event)
                continue
            with self.lock:
                future = self.pending.pop(message.get("id"), None)
            if future is not None and not future.done():
                future.set_result({k: v for k, v in message.items() if k != "id"})
        if process is self.process or self.process is None:
            code = process.wait()
            if self.status != "stopped":
                tail = "\n".join(list(self.stderr)[-6:])
                self._fail(f"the engine exited (code {code}). {tail}".strip())

    def _read_stderr(self, process: subprocess.Popen[str]) -> None:
        assert process.stderr is not None
        for line in process.stderr:
            self.stderr.append(line.rstrip()[:500])

    def _fail(self, message: str) -> None:
        self.status, self.error = "dead", message
        self._ready.set()
        self._fail_pending(message)
        self.on_event({"type": "kernel", "status": "dead", "message": message})

    def _fail_pending(self, message: str) -> None:
        with self.lock:
            pending, self.pending = self.pending, {}
        for future in pending.values():
            if not future.done():
                future.set_result({"error": {"message": message, "user": True, "kernel": True}})
