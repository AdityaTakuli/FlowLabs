"""Build the web canvas and copy it into the Python package, so a wheel carries the whole app.

``apps/web/dist`` is a build artefact (not in git). Wheels must contain it, so the installed
``flowlab`` serves the canvas without Node. The same goes for the example project, which the
desktop app copies into a new workspace on first run.

    python scripts/bundle_web.py            # build with npm, then copy
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
PACKAGE = ROOT / "apps" / "api" / "src" / "flowlab_api"
BUNDLED_WEB = PACKAGE / "web"
BUNDLED_EXAMPLES = PACKAGE / "examples"
EXAMPLES = ROOT / "examples" / "ml-lab"
EXAMPLE_FILES = ("README.md", "01_data_processing.py", "02_sklearn_training.py", "03_torch_training.ipynb")


def build() -> None:
    npm = shutil.which("npm")
    if npm is None:
        raise SystemExit("npm is required to build the canvas; install Node or pass --no-build")
    if not (WEB / "node_modules").is_dir():
        subprocess.run([npm, "install"], cwd=WEB, check=True)
    subprocess.run([npm, "run", "build"], cwd=WEB, check=True)


def copy() -> None:
    if not (DIST / "index.html").is_file():
        raise SystemExit(f"{DIST} has no index.html: build the canvas first")
    shutil.rmtree(BUNDLED_WEB, ignore_errors=True)
    shutil.copytree(DIST, BUNDLED_WEB)
    shutil.rmtree(BUNDLED_EXAMPLES, ignore_errors=True)
    (BUNDLED_EXAMPLES / "ml-lab" / "datasets").mkdir(parents=True)
    for name in EXAMPLE_FILES:
        shutil.copy(EXAMPLES / name, BUNDLED_EXAMPLES / "ml-lab" / name)
    shutil.copy(EXAMPLES / "datasets" / "churn.csv", BUNDLED_EXAMPLES / "ml-lab" / "datasets" / "churn.csv")
    files = sum(1 for p in BUNDLED_WEB.rglob("*") if p.is_file())
    size = sum(p.stat().st_size for p in BUNDLED_WEB.rglob("*") if p.is_file())
    print(f"bundled {files} web files ({size / 1_000_000:.1f} MB) and the ml-lab example into {PACKAGE.name}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-build", action="store_true", help="copy an existing build")
    arguments = parser.parse_args(argv)
    if not arguments.no_build:
        build()
    copy()
    return 0


if __name__ == "__main__":
    sys.exit(main())
