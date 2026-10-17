"""Build the web app and copy it into the Python package, so a wheel (and the desktop app) carry it.

python scripts/bundle_web.py            # npm build, then copy
python scripts/bundle_web.py --no-build # copy an existing apps/web/dist
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "apps" / "web"
DIST = WEB / "dist"
TARGET = ROOT / "src" / "flowlabs" / "web"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-build", action="store_true")
    arguments = parser.parse_args(argv)
    if not arguments.no_build:
        npm = shutil.which("npm")
        if npm is None:
            raise SystemExit("npm is required to build the app; install Node or pass --no-build")
        if not (WEB / "node_modules").is_dir():
            subprocess.run([npm, "install"], cwd=WEB, check=True)
        subprocess.run([npm, "run", "build"], cwd=WEB, check=True)
    if not (DIST / "index.html").is_file():
        raise SystemExit(f"{DIST} has no index.html: build the app first")
    shutil.rmtree(TARGET, ignore_errors=True)
    shutil.copytree(DIST, TARGET)
    size = sum(p.stat().st_size for p in TARGET.rglob("*") if p.is_file())
    print(f"bundled the app into {TARGET.relative_to(ROOT)} ({size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
