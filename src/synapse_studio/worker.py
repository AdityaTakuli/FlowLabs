"""The Synapse kernel: a process that runs engine calls, started from the Python you choose.

Like a Jupyter kernel, it runs in *your* environment, so training uses your packages, your CPU
cores and your GPU. The server talks to it with newline-delimited JSON:

* stdin  ``{"id": 1, "method": "datasets.list", "params": {}}``
* stdout ``{"id": 1, "result": ...}`` / ``{"id": 1, "error": {...}}`` / ``{"event": {...}}``

Anything a library prints goes to stderr (or becomes a log event), never into the protocol.

    python -m synapse_studio.worker --root ~/Synapse
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import threading
import warnings
from concurrent.futures import ThreadPoolExecutor
from typing import Any


class _LogStream(io.TextIOBase):
    """``print`` inside the kernel becomes ``log`` events, one per line."""

    def __init__(self, send: Any) -> None:
        self.send = send
        self.buffer_text = ""

    def write(self, text: str) -> int:
        self.buffer_text += text.replace("\r", "\n")
        while "\n" in self.buffer_text:
            line, self.buffer_text = self.buffer_text.split("\n", 1)
            if line.strip():
                self.send({"event": {"type": "log", "text": line[:2000]}})
        return len(text)

    def flush(self) -> None:
        pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="synapse-worker")
    parser.add_argument("--root", required=True)
    arguments = parser.parse_args(argv)

    protocol_fd = os.dup(1)
    os.dup2(2, 1)  # C extensions printing to fd 1 now write to stderr
    out = os.fdopen(protocol_fd, "w", encoding="utf-8", buffering=1, newline="\n")
    lock = threading.Lock()

    def send(message: dict[str, Any]) -> None:
        line = json.dumps(message, default=str, ensure_ascii=False)
        with lock:
            out.write(line + "\n")
            out.flush()

    sys.stdout = _LogStream(send)
    warnings.filterwarnings("ignore")
    try:
        sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except (AttributeError, ValueError):
        pass

    from synapse_studio.core import env
    from synapse_studio.core.rpc import Engine

    engine = Engine(
        arguments.root,
        emit=lambda event: send({"event": event}),
        spawn=lambda work: threading.Thread(target=work, name="synapse-job", daemon=True).start(),
    )
    send({"event": {"type": "ready", "info": env.info(probe_gpu=False), "pid": os.getpid()}})
    pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="synapse-call")

    def handle(request: dict[str, Any]) -> None:
        reply = engine.safe_call(request.get("method", ""), request.get("params") or {})
        send({"id": request.get("id"), **reply})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        if request.get("method") == "shutdown":
            break
        pool.submit(handle, request)
    pool.shutdown(wait=False, cancel_futures=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
