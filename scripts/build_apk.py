"""Build the FlowLabs Android app (APK) with the Android SDK tools only: no Gradle, no Android Studio.

    python scripts/build_apk.py                # debug-signed APK in dist/
    python scripts/build_apk.py --skip-web     # reuse apps/web/dist built for Android

The APK holds the web app and Python (Pyodide with pandas, scikit-learn and their dependencies), so
it trains models on the phone with no internet. It can also connect to `flowlabs engine` on a
computer to use that machine's GPU.

Needs: Node (for the web build), a JDK (javac, keytool) and the Android SDK with build-tools and a
platform (``$ANDROID_HOME``, default ``~/Android/Sdk``).

Release signing: set FLOWLABS_KEYSTORE, FLOWLABS_KEYSTORE_PASSWORD and FLOWLABS_KEY_ALIAS.
Without them the APK is signed with a local debug key (fine for installing on your own phone).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ANDROID = ROOT / "apps" / "android"
WEB = ROOT / "apps" / "web"
BUILD = ROOT / "build" / "android"
DIST = ROOT / "dist"
PYODIDE_VERSION = "314.0.7"
PYODIDE_CDN = f"https://cdn.jsdelivr.net/pyodide/v{PYODIDE_VERSION}/full/"
PYODIDE_CACHE = ANDROID / ".cache" / f"pyodide-{PYODIDE_VERSION}"
PYODIDE_CORE = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"]
PACKAGES = ["numpy", "pandas", "scikit-learn", "scipy", "joblib", "pillow"]
MIN_SDK = 26
ICON_SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
sys.path.insert(0, str(ROOT / "src"))
from flowlabs import __version__ as VERSION  # noqa: E402


def run(command: list[str], **kwargs: object) -> None:
    print("$", " ".join(str(c) for c in command), flush=True)
    subprocess.run(command, check=True, **kwargs)  # type: ignore[arg-type]


def sdk() -> tuple[Path, Path]:
    """(build-tools folder, android.jar) from the newest installed versions."""
    home = Path(os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT") or Path.home() / "Android" / "Sdk")
    tools = sorted((home / "build-tools").glob("*/"), key=lambda p: [int(x) for x in p.name.split(".") if x.isdigit()])
    tools = [t for t in tools if (t / "d8").exists() or (t / "d8.bat").exists()]
    jars = sorted((home / "platforms").glob("android-*/android.jar"), key=lambda p: int(p.parent.name.split("-")[1]))
    if not tools or not jars:
        raise SystemExit(f"Android SDK build-tools and a platform are needed in {home} (set ANDROID_HOME)")
    return tools[-1], jars[-1]


def tool(folder: Path, name: str) -> str:
    for candidate in (folder / name, folder / f"{name}.bat", folder / f"{name}.exe"):
        if candidate.exists():
            return str(candidate)
    raise SystemExit(f"{name} is missing from {folder}")


def download(url: str, target: Path, sha256: str | None = None) -> None:
    if target.is_file() and (sha256 is None or hashlib.sha256(target.read_bytes()).hexdigest() == sha256):
        return
    print(f"  downloading {url}", flush=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    with urllib.request.urlopen(url, timeout=120) as response, partial.open("wb") as handle:  # noqa: S310 - pinned CDN
        shutil.copyfileobj(response, handle)
    if sha256 and hashlib.sha256(partial.read_bytes()).hexdigest() != sha256:
        partial.unlink()
        raise SystemExit(f"checksum mismatch for {url}")
    partial.replace(target)


def pyodide_files() -> list[Path]:
    """Pyodide's runtime plus the wheels FlowLabs needs (with dependencies), cached between builds."""
    for name in PYODIDE_CORE:
        download(PYODIDE_CDN + name, PYODIDE_CACHE / name)
    lock = json.loads((PYODIDE_CACHE / "pyodide-lock.json").read_text(encoding="utf-8"))["packages"]
    wanted: list[str] = []
    queue = list(PACKAGES)
    while queue:
        name = queue.pop()
        if name in wanted:
            continue
        wanted.append(name)
        queue.extend(lock[name].get("depends", []))
    files = [PYODIDE_CACHE / name for name in PYODIDE_CORE]
    for name in sorted(wanted):
        entry = lock[name]
        target = PYODIDE_CACHE / entry["file_name"]
        download(PYODIDE_CDN + entry["file_name"], target, entry.get("sha256"))
        files.append(target)
    return files


def build_web() -> None:
    npm = shutil.which("npm")
    if npm is None:
        raise SystemExit("npm is required to build the web app")
    if not (WEB / "node_modules").is_dir():
        run([npm, "install"], cwd=WEB)
    run([npm, "run", "build"], cwd=WEB, env={**os.environ, "VITE_PYODIDE_BASE": "pyodide/"})


def icons(res: Path) -> None:
    from PIL import Image

    source = Image.open(ROOT / "packaging" / "icons" / "flowlabs.png").convert("RGBA")
    for density, size in ICON_SIZES.items():
        folder = res / f"mipmap-{density}"
        folder.mkdir(parents=True, exist_ok=True)
        source.resize((size, size), Image.Resampling.LANCZOS).save(folder / "ic_launcher.png")


def keystore() -> tuple[str, str, str]:
    path = os.environ.get("FLOWLABS_KEYSTORE")
    if path:
        password = os.environ.get("FLOWLABS_KEYSTORE_PASSWORD", "")
        return path, password, os.environ.get("FLOWLABS_KEY_ALIAS", "flowlabs")
    debug = ANDROID / ".cache" / "debug.keystore"
    if not debug.is_file():
        debug.parent.mkdir(parents=True, exist_ok=True)
        run(["keytool", "-genkeypair", "-keystore", str(debug), "-storepass", "android", "-keypass", "android",
             "-alias", "androiddebugkey", "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
             "-dname", "CN=FlowLabs Debug,O=FlowLabs,C=US"])  # fmt: skip
    return str(debug), "android", "androiddebugkey"


def version_code() -> int:
    parts = [int(p) for p in VERSION.split(".")[:3]] + [0, 0, 0]
    return parts[0] * 10000 + parts[1] * 100 + parts[2]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--skip-web", action="store_true", help="reuse apps/web/dist (built with VITE_PYODIDE_BASE)")
    arguments = parser.parse_args(argv)

    tools, android_jar = sdk()
    print(f"build-tools {tools.name}, platform {android_jar.parent.name}")
    if not arguments.skip_web:
        build_web()
    shutil.rmtree(BUILD, ignore_errors=True)
    www = BUILD / "assets" / "www"
    shutil.copytree(WEB / "dist", www)
    (www / "pyodide").mkdir()
    for file in pyodide_files():
        shutil.copy(file, www / "pyodide" / file.name)
    res = BUILD / "res"
    icons(res)

    # resources and manifest
    compiled = BUILD / "res.zip"
    run([tool(tools, "aapt2"), "compile", "--dir", str(res), "-o", str(compiled)])
    unsigned = BUILD / "unsigned.apk"
    run([tool(tools, "aapt2"), "link", "-o", str(unsigned), "-I", str(android_jar),
         "--manifest", str(ANDROID / "AndroidManifest.xml"), "-A", str(BUILD / "assets"),
         "--min-sdk-version", str(MIN_SDK), "--target-sdk-version", android_jar.parent.name.split("-")[1],
         "--version-code", str(version_code()), "--version-name", VERSION,
         "-0", "wasm", "-0", "whl", "-0", "zip", "-0", "woff2", str(compiled)])  # fmt: skip

    # code
    classes = BUILD / "classes"
    sources = [str(p) for p in (ANDROID / "src").rglob("*.java")]
    run(["javac", "-source", "11", "-target", "11", "-Xlint:-options", "-encoding", "UTF-8",
         "-classpath", str(android_jar), "-d", str(classes), *sources])  # fmt: skip
    dex = BUILD / "dex"
    dex.mkdir()
    run([tool(tools, "d8"), "--min-api", str(MIN_SDK), "--lib", str(android_jar), "--output", str(dex),
         *[str(p) for p in classes.rglob("*.class")]])  # fmt: skip
    with zipfile.ZipFile(unsigned, "a", zipfile.ZIP_DEFLATED) as apk:
        apk.write(dex / "classes.dex", "classes.dex")

    # align and sign
    aligned = BUILD / "aligned.apk"
    run([tool(tools, "zipalign"), "-p", "-f", "4", str(unsigned), str(aligned)])
    DIST.mkdir(exist_ok=True)
    target = DIST / f"FlowLabs-{VERSION}-android.apk"
    store, password, alias = keystore()
    run([tool(tools, "apksigner"), "sign", "--ks", store, "--ks-pass", f"pass:{password}", "--ks-key-alias", alias,
         "--out", str(target), str(aligned)])  # fmt: skip
    run([tool(tools, "apksigner"), "verify", str(target)])
    print(f"APK: {target} ({target.stat().st_size / 1e6:.0f} MB)")
    print("Install on a phone with USB debugging:  adb install -r " + str(target.relative_to(ROOT)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
