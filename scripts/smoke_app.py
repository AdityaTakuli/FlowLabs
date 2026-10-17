"""Prove a built Synapse app works: it starts, serves the app, and its built-in kernel answers.

python scripts/smoke_app.py              # checks dist/Synapse (or dist/Synapse.app on macOS)
python scripts/smoke_app.py path/to/Synapse
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def executable(argument: str | None) -> Path:
    if argument:
        return Path(argument)
    for candidate in (
        ROOT / "dist" / "Synapse.app" / "Contents" / "MacOS" / "Synapse",
        ROOT / "dist" / "Synapse" / "Synapse.exe",
        ROOT / "dist" / "Synapse" / "synapse",
    ):
        if candidate.is_file():
            return candidate
    raise SystemExit("no built app in dist/: run python scripts/build_app.py first")


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    app = executable(arguments[0] if arguments else None)
    with tempfile.TemporaryDirectory() as workspace:
        print(f"$ {app} --check --workspace {workspace}", flush=True)
        finished = subprocess.run(
            [str(app), "--check", "--workspace", workspace], capture_output=True, text=True, timeout=300
        )
        print(finished.stdout.strip() or "(no output)")
        if finished.returncode != 0:
            print(finished.stderr[-4000:], file=sys.stderr)
            return finished.returncode
    print("OK: the packaged app starts, serves the app, and its kernel answers")
    return 0


if __name__ == "__main__":
    sys.exit(main())
