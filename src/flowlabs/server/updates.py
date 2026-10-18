"""Updates for the desktop app: find a newer release on GitHub, download it, install it, restart.

* Linux (installed from the .deb, in /opt/flowlabs): the new .deb is installed with ``pkexec apt-get``,
  which asks for your password in a system dialog, then FlowLabs starts again.
* macOS: the new FlowLabs.app is copied over the running one from the .dmg, then FlowLabs reopens.
* Windows: the new installer runs silently and starts FlowLabs again when it is done.
* Elsewhere (the Linux .tar.gz, a pip install): FlowLabs says there is an update and how to get it.

Downloads come only from this project's GitHub releases over HTTPS, and are checked against the
SHA-256 digest GitHub publishes for each file when there is one.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

from flowlabs import __version__

REPO = "AdityaTakuli/FlowLabs"
# latest.json is a release file (no API rate limit) that CI writes: version, notes, files and checksums
MANIFEST = f"https://github.com/{REPO}/releases/latest/download/latest.json"
LATEST = f"https://api.github.com/repos/{REPO}/releases/latest"
DOWNLOADS = f"https://github.com/{REPO}/releases/download/"
CHECK_EVERY_S = 6 * 3600
TIMEOUT_S = 10

Emit = Callable[[dict[str, Any]], None]


def version_tuple(text: str) -> tuple[int, ...]:
    """'v0.4.1' -> (0, 4, 1); anything after the numbers (rc, dev) is ignored."""
    numbers = re.findall(r"\d+", text.lstrip("vV").split("-")[0].split("+")[0])
    return tuple(int(n) for n in numbers[:3]) or (0,)


def newer(latest: str, current: str | None = None) -> bool:
    return version_tuple(latest) > version_tuple(current or __version__)


def frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def install_method() -> str:
    """How this copy of FlowLabs can update itself: deb, macos, windows, manual or pip."""
    if not frozen():
        return "pip"
    if sys.platform == "darwin":
        return "macos" if app_bundle() is not None else "manual"
    if os.name == "nt":
        return "windows"
    if (
        Path(sys.executable).resolve().is_relative_to("/opt/flowlabs")
        and shutil.which("pkexec")
        and shutil.which("apt-get")
    ):
        return "deb"
    return "manual"


def app_bundle() -> Path | None:
    """macOS: the FlowLabs.app this process runs from."""
    for parent in Path(sys.executable).resolve().parents:
        if parent.suffix == ".app":
            return parent
    return None


def asset_pattern(method: str) -> re.Pattern[str] | None:
    machine = platform.machine().lower()
    if method == "deb":
        arch = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(machine, machine)
        return re.compile(rf"^FlowLabs-[\d.]+-linux-{arch}\.deb$")
    if method == "macos":
        arch = "arm64" if machine in ("arm64", "aarch64") else "x86_64"
        return re.compile(rf"^FlowLabs-[\d.]+-macos-{arch}\.dmg$")
    if method == "windows":
        return re.compile(r"^FlowLabs-[\d.]+-windows-x64-setup\.exe$")
    return None


def latest_release(fetch: Callable[[str], Any]) -> dict[str, Any]:
    """The newest release, in the shape of GitHub's API: from latest.json, else from the API."""
    try:
        manifest = fetch(MANIFEST)
        return {
            "tag_name": manifest["tag"],
            "body": manifest.get("notes", ""),
            "html_url": manifest.get("page", f"https://github.com/{REPO}/releases/tag/{manifest['tag']}"),
            "published_at": manifest.get("published"),
            "assets": [{"name": a["name"], "size": a.get("size", 0), "browser_download_url": a["url"],
                        "digest": f"sha256:{a['sha256']}" if a.get("sha256") else None} for a in manifest.get("assets", [])],
        }  # fmt: skip
    except Exception:  # noqa: BLE001 - releases from before latest.json existed: ask the API
        return dict(fetch(LATEST))


def _get_json(url: str) -> Any:
    request = urllib.request.Request(
        url, headers={"Accept": "application/vnd.github+json", "User-Agent": f"FlowLabs/{__version__}"}
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_S) as reply:  # noqa: S310 - a fixed https URL
        return json.loads(reply.read())


class Updater:
    def __init__(self, emit: Emit, fetch: Callable[[str], Any] = _get_json) -> None:
        self.emit = emit
        self.fetch = fetch
        self.cached: dict[str, Any] | None = None
        self.checked_at = 0.0
        self.busy = False
        self.lock = threading.Lock()

    # --------------------------------------------------------------------------------- check
    def check(self, force: bool = False) -> dict[str, Any]:
        if self.cached is not None and not force and time.time() - self.checked_at < CHECK_EVERY_S:
            return self.cached
        method = install_method()
        info: dict[str, Any] = {"current": __version__, "method": method, "available": False, "checked": True}
        try:
            release = latest_release(self.fetch)
        except Exception as error:  # noqa: BLE001 - offline is normal: report it, try again later
            return {**info, "checked": False, "error": f"could not reach GitHub ({type(error).__name__})"}
        latest = str(release.get("tag_name") or "")
        pattern = asset_pattern(method)
        asset = None
        for item in release.get("assets") or []:
            if pattern is not None and pattern.match(str(item.get("name", ""))):
                asset = {"name": item["name"], "size": int(item.get("size") or 0), "url": item.get("browser_download_url", ""),
                         "digest": item.get("digest")}  # fmt: skip
                break
        info.update(latest=latest.lstrip("vV"), available=bool(latest) and newer(latest), notes=str(release.get("body") or ""),
                    page=str(release.get("html_url") or f"https://github.com/{REPO}/releases/latest"),
                    published=release.get("published_at"), asset=asset)  # fmt: skip
        info["can_install"] = bool(info["available"] and asset and str(asset["url"]).startswith(DOWNLOADS))
        self.cached, self.checked_at = info, time.time()
        return info

    # ------------------------------------------------------------------------------- install
    def start_install(self, on_restart: Callable[[], None]) -> dict[str, Any]:
        info = self.check()
        if not info.get("can_install"):
            raise RuntimeError("there is no update this copy of FlowLabs can install itself")
        with self.lock:
            if self.busy:
                raise RuntimeError("an update is already being installed")
            self.busy = True
        threading.Thread(target=self._install, args=(info, on_restart), name="flowlabs-update", daemon=True).start()
        return {"started": True}

    def _install(self, info: dict[str, Any], on_restart: Callable[[], None]) -> None:
        try:
            path = self.download(info["asset"])
            self.emit({"type": "update", "stage": "installing", "message": "Installing the update…"})
            apply(info["method"], path)
            self.emit({"type": "update", "stage": "restarting", "message": "Restarting FlowLabs…"})
            time.sleep(0.8)  # let the page hear it
            on_restart()
        except Exception as error:  # noqa: BLE001 - shown in the update dialog
            self.emit({"type": "update", "stage": "error", "message": str(error)})
        finally:
            with self.lock:
                self.busy = False

    def download(self, asset: dict[str, Any]) -> Path:
        url = str(asset["url"])
        if not url.startswith(DOWNLOADS):
            raise RuntimeError("refusing to download an update from outside FlowLabs's GitHub releases")
        folder = Path(tempfile.gettempdir()) / "flowlabs-update"
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / Path(str(asset["name"])).name
        partial = target.with_suffix(target.suffix + ".part")
        digest = hashlib.sha256()
        size = int(asset.get("size") or 0)
        done = 0
        last = 0.0
        request = urllib.request.Request(url, headers={"User-Agent": f"FlowLabs/{__version__}"})
        with urllib.request.urlopen(request, timeout=60) as reply, partial.open("wb") as out:  # noqa: S310
            while chunk := reply.read(1 << 16):
                out.write(chunk)
                digest.update(chunk)
                done += len(chunk)
                if time.time() - last > 0.25:
                    last = time.time()
                    self.emit({"type": "update", "stage": "download", "progress": done / size if size else None,
                               "message": f"Downloading {done / 1e6:.0f} of {size / 1e6:.0f} MB"})  # fmt: skip
        if size and done != size:
            raise RuntimeError(f"the download stopped early ({done} of {size} bytes)")
        expected = str(asset.get("digest") or "")
        if expected.startswith("sha256:") and expected.split(":", 1)[1].lower() != digest.hexdigest():
            partial.unlink(missing_ok=True)
            raise RuntimeError("the downloaded file does not match the release's checksum; nothing was installed")
        os.replace(partial, target)
        self.emit({"type": "update", "stage": "download", "progress": 1.0, "message": "Downloaded"})
        return target


def apply(method: str, path: Path) -> None:
    """Install the downloaded file. The restart happens after this returns."""
    if method == "deb":
        result = subprocess.run(["pkexec", "apt-get", "install", "-y", "--allow-downgrades", str(path)],  # noqa: S603, S607
                                capture_output=True, text=True)  # fmt: skip
        if result.returncode != 0:
            reason = (
                "you cancelled the password prompt"
                if result.returncode in (126, 127)
                else (result.stderr.strip().splitlines() or ["apt-get failed"])[-1]
            )
            raise RuntimeError(f"the update was not installed: {reason}")
    elif method == "macos":
        bundle = app_bundle()
        if bundle is None or not os.access(bundle.parent, os.W_OK):
            subprocess.Popen(["open", str(path)])  # noqa: S603, S607 - let the person drag it to Applications
            raise RuntimeError(
                "FlowLabs cannot replace itself here; the new version is open in Finder to drag to Applications"
            )
        _macos_swap_after_exit(bundle, path)
    elif method == "windows":
        flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        subprocess.Popen([str(path), "/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS"],  # noqa: S603
                         creationflags=flags, close_fds=True)  # fmt: skip
    else:
        raise RuntimeError("this copy of FlowLabs cannot install updates itself")


def _macos_swap_after_exit(bundle: Path, dmg: Path) -> None:
    """A small script waits for FlowLabs to quit, copies the new app over it and opens it again."""
    script = Path(tempfile.gettempdir()) / "flowlabs-update" / "swap.sh"
    script.write_text(
        "#!/bin/sh\n"
        f"while kill -0 {os.getpid()} 2>/dev/null; do sleep 0.5; done\n"
        "MOUNT=$(mktemp -d)\n"
        f'hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT" "{dmg}" >/dev/null || exit 1\n'
        f'if [ -d "$MOUNT/FlowLabs.app" ]; then rm -rf "{bundle}" && ditto "$MOUNT/FlowLabs.app" "{bundle}"; fi\n'
        'hdiutil detach "$MOUNT" -quiet\n'
        f'open "{bundle}"\n',
        encoding="utf-8",
    )
    script.chmod(0o755)
    subprocess.Popen(["/bin/sh", str(script)], start_new_session=True, close_fds=True)  # noqa: S603


def restart_command(method: str) -> list[str] | None:
    """What to run to start FlowLabs again once this process has gone (None: the installer does it)."""
    if method == "deb":
        return [
            "/bin/sh",
            "-c",
            f"while kill -0 {os.getpid()} 2>/dev/null; do sleep 0.3; done; exec /opt/flowlabs/flowlabs",
        ]
    return None
