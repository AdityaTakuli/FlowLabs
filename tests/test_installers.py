"""The one-line installers read latest.json, which the release workflow writes with
scripts/release_manifest.py: keep the two in step."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import release_manifest  # noqa: E402

pytestmark = pytest.mark.skipif(shutil.which("sh") is None, reason="needs a POSIX shell")


def test_install_sh_reads_the_release_manifest(tmp_path):
    files = tmp_path / "assets"
    files.mkdir()
    for name in (
        "FlowLabs-9.9.9-linux-amd64.deb",
        "FlowLabs-9.9.9-linux-x86_64.tar.gz",
        "FlowLabs-9.9.9-macos-arm64.dmg",
    ):
        (files / name).write_bytes(name.encode())
    manifest = release_manifest.manifest("v9.9.9", files)
    manifest["notes"] = 'Notes that mention "name": "FlowLabs-9.9.9-linux-amd64.deb" do not confuse it.'
    written = tmp_path / "latest.json"
    written.write_text(json.dumps(manifest, indent=1))  # exactly as the workflow writes it

    script = (ROOT / "install.sh").read_text()
    helper = re.search(r"^asset_field\(\).*?^}", script, re.S | re.M)
    assert helper, "install.sh lost its asset_field function"
    (tmp_path / "helper.sh").write_text(helper.group(0))

    def field(name: str, key: str) -> str:
        command = f'. "{tmp_path / "helper.sh"}"; asset_field "{written}" "{name}" {key}'
        return subprocess.run(["sh", "-c", command], capture_output=True, text=True, check=True).stdout.strip()

    deb = next(a for a in manifest["assets"] if a["name"].endswith(".deb"))
    assert field(deb["name"], "sha256") == deb["sha256"]
    assert field(deb["name"], "url") == deb["url"]
    assert field(deb["name"], "size") == str(deb["size"])
    assert (
        field("FlowLabs-9.9.9-macos-arm64.dmg", "sha256")
        == next(a for a in manifest["assets"] if a["name"].endswith(".dmg"))["sha256"]
    )
    assert field("FlowLabs-9.9.9-windows-x64-setup.exe", "sha256") == ""

    version = subprocess.run(["sh", "-c", f"""awk -F'"' '/"version":/ {{ print $4; exit }}' "{written}" """],
                             capture_output=True, text=True, check=True).stdout.strip()  # fmt: skip
    assert version == "9.9.9"


def test_install_scripts_name_the_files_the_build_makes():
    build = (ROOT / "scripts" / "build_app.py").read_text()
    script = (ROOT / "install.sh").read_text()
    windows = (ROOT / "install.ps1").read_text()
    for suffix in ("-linux-amd64.deb", "-linux-x86_64.tar.gz", "-macos-arm64.dmg", "-macos-x86_64.dmg"):
        assert suffix in script
    assert "*-windows-x64-setup.exe" in windows and "windows-x64-setup" in build
    assert "linux-{arch}.deb" in build and "def archive_name" in build
