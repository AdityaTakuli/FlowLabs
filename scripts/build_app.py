"""Build the Synapse desktop app for this operating system.

    python scripts/build_app.py              # web app + PyInstaller bundle + an installable archive
    python scripts/build_app.py --no-web     # reuse the bundled web app
    python scripts/build_app.py --no-package # stop after the PyInstaller bundle

Output in ``dist/``:

* Linux   ``Synapse-<version>-linux-<arch>.tar.gz`` with ``install.sh`` (menu entry + ``synapse-app``)
* macOS   ``Synapse.app`` and ``Synapse-<version>-macos-<arch>.dmg``
* Windows ``Synapse-<version>-windows-<arch>.zip``, plus an installer when Inno Setup is installed
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
BUNDLE = DIST / "Synapse"
sys.path.insert(0, str(ROOT / "src"))
from synapse_studio import __version__ as VERSION  # noqa: E402

DESKTOP_ENTRY = """[Desktop Entry]
Type=Application
Name=Synapse
Comment=Visual machine learning: data to model, no code
Exec={exec}
Icon={icon}
Terminal=false
Categories=Development;Science;Education;
StartupWMClass=Synapse
"""
INSTALL_SH = """#!/bin/sh
# Install Synapse for the current user: files in ~/.local/share/synapse, a menu entry, synapse-app.
set -e
here=$(cd "$(dirname "$0")" && pwd)
target="$HOME/.local/share/synapse"
rm -rf "$target"
mkdir -p "$target" "$HOME/.local/bin" "$HOME/.local/share/applications"
cp -R "$here"/* "$target"/
ln -sf "$target/synapse" "$HOME/.local/bin/synapse-app"
sed "s|{exec}|$target/synapse|; s|{icon}|$target/synapse.png|" "$here/Synapse.desktop.in" \\
    > "$HOME/.local/share/applications/Synapse.desktop"
echo "Synapse installed. Start it from your applications menu, or run synapse-app."
"""
INNO = r"""
[Setup]
AppName=Synapse
AppVersion={#MyAppVersion}
DefaultDirName={autopf}\Synapse
DefaultGroupName=Synapse
OutputDir={#MyOutputDir}
OutputBaseFilename=Synapse-{#MyAppVersion}-windows-x64-setup
SetupIconFile={#MySourceDir}\..\..\packaging\icons\synapse.ico
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "{#MySourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs

[Icons]
Name: "{group}\Synapse"; Filename: "{app}\Synapse.exe"
Name: "{userdesktop}\Synapse"; Filename: "{app}\Synapse.exe"

[Run]
Filename: "{app}\Synapse.exe"; Description: "Start Synapse"; Flags: nowait postinstall skipifsilent
"""


def run(command: list[str], **kwargs: object) -> None:
    print("$", " ".join(command), flush=True)
    subprocess.run(command, check=True, **kwargs)  # type: ignore[arg-type]


def archive_name(suffix: str) -> Path:
    machine = {"amd64": "x64", "x86_64": "x86_64", "arm64": "arm64", "aarch64": "arm64"}.get(
        platform.machine().lower(), platform.machine().lower()
    )
    system = {"darwin": "macos", "win32": "windows"}.get(sys.platform, "linux")
    return DIST / f"Synapse-{VERSION}-{system}-{machine}{suffix}"


def build_bundle(web: bool) -> None:
    if web:
        run([sys.executable, str(ROOT / "scripts" / "bundle_web.py")])
    shutil.rmtree(BUNDLE, ignore_errors=True)
    shutil.rmtree(DIST / "Synapse.app", ignore_errors=True)
    run(
        [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", str(ROOT / "packaging" / "synapse.spec")],
        cwd=ROOT,
    )


def package_linux() -> Path:
    shutil.copy(ROOT / "packaging" / "icons" / "synapse.png", BUNDLE / "synapse.png")
    (BUNDLE / "Synapse.desktop.in").write_text(DESKTOP_ENTRY, encoding="utf-8")
    installer = BUNDLE / "install.sh"
    installer.write_text(INSTALL_SH, encoding="utf-8")
    installer.chmod(0o755)
    target = archive_name(".tar.gz")
    target.unlink(missing_ok=True)
    with tarfile.open(target, "w:gz") as archive:
        archive.add(BUNDLE, arcname="Synapse")
    return target


def package_macos() -> Path:
    app = DIST / "Synapse.app"
    if not app.is_dir():
        raise SystemExit("PyInstaller did not produce Synapse.app")
    target = archive_name(".dmg")
    target.unlink(missing_ok=True)
    if shutil.which("hdiutil"):
        run(["hdiutil", "create", "-volname", "Synapse", "-srcfolder", str(app), "-ov", "-format", "UDZO", str(target)])
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
                archive.write(path, Path("Synapse") / path.relative_to(BUNDLE))
    inno = shutil.which("iscc")
    if inno:
        script = DIST / "synapse.iss"
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
