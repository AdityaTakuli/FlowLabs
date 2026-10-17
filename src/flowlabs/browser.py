"""The in-browser engine: Pyodide imports this module and calls ``call``.

Training runs in the page's Web Worker, synchronously; events reach the page through the
``emit`` function passed to ``setup`` while a job runs.
"""

from __future__ import annotations

import json
from typing import Any

from flowlabs.core.rpc import Engine

_engine: Engine | None = None


def setup(root: str, emit: Any) -> str:
    global _engine
    _engine = Engine(root, emit=lambda event: emit(json.dumps(event, default=str)), spawn=None)
    return json.dumps(_engine.safe_call("engine.info", {"probe_gpu": False}), default=str)


def call(method: str, params: str) -> str:
    if _engine is None:
        raise RuntimeError("call setup() first")
    return json.dumps(_engine.safe_call(method, json.loads(params or "{}")), default=str)
