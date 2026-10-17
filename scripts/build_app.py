"""Build the FlowLabs desktop app for this operating system.

    python scripts/build_app.py              # web app + PyInstaller bundle + an installable archive
    python scripts/build_app.py --no-web     # reuse the bundled web app
    python scripts/build_app.py --no-package # stop after the PyInstaller bundle

Output in ``dist/``:

* Linux   ``FlowLabs-<version>-linux-<arch>.tar.gz`` with ``install.sh`` (menu entry + ``flowlabs-app``)
* macOS   ``FlowLabs.app`` and ``FlowLabs-<version>-macos-<arch>.dmg``
* Windows ``FlowLabs-<version>-windows-<arch>.zip``, plus an installer when Inno Setup is installed
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
BUNDLE = DIST / "FlowLabs"
sys.path.insert(0, str(ROOT / "src"))
from flowlabs import __version__ as VERSION  # noqa: E402

DESKTOP_ENTRY = """[Desktop Entry]
Type=Application
Name=FlowLabs
Comment=Visual machine learning: data to model, no code
Exec={exec}
Icon={icon}
Terminal=false
Categories=Development;Science;Education;
StartupWMClass=FlowLabs
"""
INSTALL_SH = """#!/bin/sh
# Install FlowLabs for the current user: files in ~/.local/share/flowlabs, a menu entry, flowlabs-app.
set -e
here=$(cd "$(dirname "$0")" && pwd)
target="$HOME/.local/share/flowlabs"
rm -rf "$target"
mkdir -p "$target" "$HOME/.local/bin" "$HOME/.local/share/applications"
cp -R "$here"/* "$target"/
ln -sf "$target/flowlabs" "$HOME/.local/bin/flowlabs-app"
sed "s|{exec}|$target/flowlabs|; s|{icon}|$target/flowlabs.png|" "$here/FlowLabs.desktop.in" \\
    > "$HOME/.local/share/applications/FlowLabs.desktop"
echo "FlowLabs installed. Start it from your applications menu, or run flowlabs-app."
"""
INNO = r"""
[Setup]
AppName=FlowLabs
AppVersion={#MyAppVersion}
DefaultDirName={autopf}\FlowLabs
DefaultGroupName=FlowLabs
OutputDir={#MyOutputDir}
OutputBaseFilename=FlowLabs-{#MyAppVersion}-windows-x64-setup
SetupIconFile={#MySourceDir}\..\..\packaging\icons\flowlabs.ico
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "{#MySourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs

[Icons]
Name: "{group}\FlowLabs"; Filename: "{app}\FlowLabs.exe"
Name: "{userdesktop}\FlowLabs"; Filename: "{app}\FlowLabs.exe"

[Run]
Filename: "{app}\FlowLabs.exe"; Description: "Start FlowLabs"; Flags: nowait postinstall skipifsilent
"""


def run(command: list[str], **kwargs: object) -> None:
    print("$", " ".join(command), flush=True)
    subprocess.run(command, check=True, **kwargs)  # type: ignore[arg-type]


def archive_name(suffix: str) -> Path:
    machine = {"amd64": "x64", "x86_64": "x86_64", "arm64": "arm64", "aarch64": "arm64"}.get(
        platform.machine().lower(), platform.machine().lower()
    )
    system = {"darwin": "macos", "win32": "windows"}.get(sys.platform, "linux")
    return DIST / f"FlowLabs-{VERSION}-{system}-{machine}{suffix}"


def build_bundle(web: bool) -> None:
    if web:
        run([sys.executable, str(ROOT / "scripts" / "bundle_web.py")])
    shutil.rmtree(BUNDLE, ignore_errors=True)
    shutil.rmtree(DIST / "FlowLabs.app", ignore_errors=True)
    run(
        [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", str(ROOT / "packaging" / "flowlabs.spec")],
        cwd=ROOT,
    )


def package_linux() -> Path:
    shutil.copy(ROOT / "packaging" / "icons" / "flowlabs.png", BUNDLE / "flowlabs.png")
    (BUNDLE / "FlowLabs.desktop.in").write_text(DESKTOP_ENTRY, encoding="utf-8")
    installer = BUNDLE / "install.sh"
    installer.write_text(INSTALL_SH, encoding="utf-8")
    installer.chmod(0o755)
    target = archive_name(".tar.gz")
    target.unlink(missing_ok=True)
    with tarfile.open(target, "w:gz") as archive:
        archive.add(BUNDLE, arcname="FlowLabs")
    return target


def package_macos() -> Path:
    app = DIST / "FlowLabs.app"
    if not app.is_dir():
        raise SystemExit("PyInstaller did not produce FlowLabs.app")
    target = archive_name(".dmg")
    target.unlink(missing_ok=True)
    if shutil.which("hdiutil"):
        run(
            ["hdiutil", "create", "-volname", "FlowLabs", "-srcfolder", str(app), "-ov", "-format", "UDZO", str(target)]
        )
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
                archive.write(path, Path("FlowLabs") / path.relative_to(BUNDLE))
    inno = shutil.which("iscc")
    if inno:
        script = DIST / "flowlabs.iss"
        script.write_text(INNO, encoding="utf-8")
        run([inno, f"/DMyAppVersion={VERSION}", f"/DMySourceDir={BUNDLE}", f"/DMyOutputDir={DIST}", str(script)])
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--no-web", action="store_true", help="reuse the bundled web app")
    parser.add_argument("--no-package", action="store_true", help="stop after the PyInstaller bundle")
    arguments = parser.parse_args(argv)
    build_bundle(web=not arguments.no_web)
    if arguments.no_package:
        print(f"bundle: {BUNDLE}")
        return 0
    package = {"darwin": package_macos, "win32": package_windows}.get(sys.platform, package_linux)()
    size = sum(f.stat().st_size for f in BUNDLE.rglob("*") if f.is_file()) if BUNDLE.is_dir() else 0
    print(f"bundle: {BUNDLE} ({size / 1e6:.0f} MB)")
    print(f"package: {package} ({package.stat().st_size / 1e6:.0f} MB)")
    return 0


if __name__ == "__main__":
    os.environ.setdefault("PYTHONHASHSEED", "0")
    sys.exit(main())
