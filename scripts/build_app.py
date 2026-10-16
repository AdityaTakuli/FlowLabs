"""Build the FlowLab desktop app for this operating system.

    python scripts/build_app.py              # canvas + PyInstaller bundle + an installable archive
    python scripts/build_app.py --no-web     # reuse the bundled canvas
    python scripts/build_app.py --no-package # stop after the PyInstaller bundle

Output lands in ``dist/``:

* **Linux**   ``FlowLab-<version>-linux-x86_64.tar.gz`` with ``flowlab``, an ``install.sh`` that
  adds a desktop entry, and ``FlowLab.desktop``.
* **macOS**   ``FlowLab.app`` and, when ``hdiutil`` exists, ``FlowLab-<version>-macos.dmg``.
* **Windows** ``FlowLab-<version>-windows-x64.zip``, plus an installer when Inno Setup (``iscc``)
  is on PATH.
"""

from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
BUNDLE = DIST / "FlowLab"
VERSION = "0.1.0"
DESKTOP_ENTRY = """[Desktop Entry]
Type=Application
Name=FlowLab
Comment=Code as a graph: notebooks, pipelines and projects
Exec={exec}
Icon={icon}
Terminal=false
Categories=Development;Science;IDE;
StartupWMClass=FlowLab
"""
INSTALL_SH = """#!/bin/sh
# Install FlowLab for the current user: files in ~/.local/share/flowlab, menu entry, flowlab-app command.
set -e
here=$(cd "$(dirname "$0")" && pwd)
target="$HOME/.local/share/flowlab"
rm -rf "$target"
mkdir -p "$target" "$HOME/.local/bin" "$HOME/.local/share/applications"
cp -R "$here"/* "$target"/
ln -sf "$target/flowlab" "$HOME/.local/bin/flowlab-app"
sed "s|{exec}|$target/flowlab|; s|{icon}|$target/flowlab.png|" "$here/FlowLab.desktop.in" \\
    > "$HOME/.local/share/applications/FlowLab.desktop"
echo "FlowLab installed. Start it from your applications menu, or run flowlab-app."
"""


def run(command: list[str], **kwargs: object) -> None:
    print("$", " ".join(command), flush=True)
    subprocess.run(command, check=True, **kwargs)  # type: ignore[arg-type]


def archive_name(suffix: str) -> Path:
    machine = platform.machine().lower()
    system = {"darwin": "macos", "win32": "windows"}.get(sys.platform, "linux")
    return DIST / f"FlowLab-{VERSION}-{system}-{machine}{suffix}"


def build_bundle(web: bool) -> None:
    if web:
        run([sys.executable, str(ROOT / "scripts" / "bundle_web.py")])
    shutil.rmtree(BUNDLE, ignore_errors=True)
    shutil.rmtree(DIST / "FlowLab.app", ignore_errors=True)
    spec = str(ROOT / "packaging" / "flowlab.spec")
    run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", spec], cwd=ROOT)


def package_linux() -> Path:
    icon = ROOT / "packaging" / "icons" / "flowlab.png"
    if icon.is_file():
        shutil.copy(icon, BUNDLE / "flowlab.png")
    (BUNDLE / "FlowLab.desktop.in").write_text(DESKTOP_ENTRY, encoding="utf-8")
    installer = BUNDLE / "install.sh"
    installer.write_text(INSTALL_SH, encoding="utf-8")
    installer.chmod(0o755)
    target = archive_name(".tar.gz")
    target.unlink(missing_ok=True)
    with tarfile.open(target, "w:gz") as archive:
        archive.add(BUNDLE, arcname="FlowLab")
    return target


def package_macos() -> Path:
    app = DIST / "FlowLab.app"
    if not app.is_dir():
        raise SystemExit("PyInstaller did not produce FlowLab.app")
    target = archive_name(".dmg")
    target.unlink(missing_ok=True)
    if shutil.which("hdiutil"):
        run([
            "hdiutil", "create", "-volname", "FlowLab", "-srcfolder", str(app),
            "-ov", "-format", "UDZO", str(target),
        ])  # fmt: skip
        return target
    fallback = archive_name(".zip")
    run(["ditto", "-c", "-k", "--keepParent", str(app), str(fallback)])
    return fallback


def package_windows() -> Path:
    target = archive_name(".zip")
    target.unlink(missing_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in BUNDLE.rglob("*"):
            if path.is_file():
                archive.write(path, Path("FlowLab") / path.relative_to(BUNDLE))
    inno = shutil.which("iscc")
    script = ROOT / "packaging" / "flowlab.iss"
    if inno and script.is_file():
        run([
            inno, f"/DMyAppVersion={VERSION}", f"/DMySourceDir={BUNDLE}",
            f"/DMyOutputDir={DIST}", str(script),
        ])  # fmt: skip
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-web", action="store_true", help="reuse the bundled canvas")
    parser.add_argument("--no-package", action="store_true", help="stop after the PyInstaller bundle")
    arguments = parser.parse_args(argv)

    build_bundle(web=not arguments.no_web)
    if arguments.no_package:
        print(f"bundle: {BUNDLE}")
        return 0
    package = {"darwin": package_macos, "win32": package_windows}.get(sys.platform, package_linux)()
    size = sum(f.stat().st_size for f in BUNDLE.rglob("*") if f.is_file()) if BUNDLE.is_dir() else 0
    print(f"bundle: {BUNDLE} ({size / 1_000_000:.0f} MB)")
    print(f"package: {package} ({package.stat().st_size / 1_000_000:.0f} MB)")
    return 0


if __name__ == "__main__":
    os.environ.setdefault("PYTHONHASHSEED", "0")
    sys.exit(main())
