"""Prove a built FlowLab app works: it starts, serves the canvas, and finds a Python for kernels.

    python scripts/smoke_app.py            # checks dist/FlowLab (or dist/FlowLab.app on macOS)
    python scripts/smoke_app.py path/to/FlowLab

Run by CI after every platform build, so a broken bundle never ships.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TIMEOUT_S = 180


def executable(argument: str | None) -> Path:
    if argument:
        given = Path(argument)
        return given if given.is_file() else next(given.rglob("FlowLab*"))
    candidates = [
        ROOT / "dist" / "FlowLab.app" / "Contents" / "MacOS" / "FlowLab",
        ROOT / "dist" / "FlowLab" / "FlowLab.exe",
        ROOT / "dist" / "FlowLab" / "FlowLab",
        ROOT / "dist" / "FlowLab" / "flowlab",
    ]
    found = next((c for c in candidates if c.is_file()), None)
    if found is None:
        raise SystemExit("no built app in dist/: run python scripts/build_app.py first")
    return found


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    app = executable(arguments[0] if arguments else None)
    with tempfile.TemporaryDirectory() as temporary:
        workspace = Path(temporary) / "workspace"
        workspace.mkdir()
        (workspace / "hello.py").write_text("# %% one\nprint('hello from a FlowLab cell')\n")
        print(f"$ {app} --check {workspace}", flush=True)
        finished = subprocess.run(
            [str(app), "--check", str(workspace)], capture_output=True, text=True, timeout=TIMEOUT_S
        )
        print(finished.stdout.strip() or "(no output)")
        if finished.returncode != 0:
            print(finished.stderr[-4000:], file=sys.stderr)
            return finished.returncode
        settings = workspace / ".flowlab" / "lab.json"
        if settings.is_file():
            print("workspace settings:", json.loads(settings.read_text()).get("python_path", "automatic"))
    print("OK: the packaged app starts and serves the canvas")
    return 0


if __name__ == "__main__":
    sys.exit(main())
