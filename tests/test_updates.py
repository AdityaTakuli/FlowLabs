"""The desktop app's updater, without the network: GitHub's answer and the downloads are faked."""

from __future__ import annotations

import hashlib
import io

import pytest

from flowlabs.server import updates

DATA = b"new FlowLabs build " * 1000
RELEASE = {
    "tag_name": "v9.1.0",
    "body": "## What's new\n- faster",
    "html_url": "https://github.com/AdityaTakuli/FlowLabs/releases/tag/v9.1.0",
    "assets": [
        {
            "name": "FlowLabs-9.1.0-linux-x86_64.tar.gz",
            "size": 10,
            "browser_download_url": updates.DOWNLOADS + "v9.1.0/x.tar.gz",
        },
        {
            "name": "FlowLabs-9.1.0-linux-amd64.deb",
            "size": len(DATA),
            "browser_download_url": updates.DOWNLOADS + "v9.1.0/FlowLabs-9.1.0-linux-amd64.deb",
            "digest": "sha256:" + hashlib.sha256(DATA).hexdigest(),
        },
        {
            "name": "FlowLabs-9.1.0-macos-arm64.dmg",
            "size": 10,
            "browser_download_url": updates.DOWNLOADS + "v9.1.0/a.dmg",
        },
        {
            "name": "FlowLabs-9.1.0-windows-x64-setup.exe",
            "size": 10,
            "browser_download_url": updates.DOWNLOADS + "v9.1.0/s.exe",
        },
    ],
}


def test_versions_compare_as_numbers():
    assert updates.version_tuple("v0.10.2") == (0, 10, 2) and updates.version_tuple("0.4.0-rc1") == (0, 4, 0)
    assert (
        updates.newer("v0.10.0", "0.9.9")
        and not updates.newer("v0.4.0", "0.4.0")
        and not updates.newer("v0.3.2", "0.4.0")
    )


@pytest.mark.parametrize(
    ("method", "machine", "expected"),
    [("deb", "x86_64", "FlowLabs-9.1.0-linux-amd64.deb"), ("macos", "arm64", "FlowLabs-9.1.0-macos-arm64.dmg"),
     ("windows", "AMD64", "FlowLabs-9.1.0-windows-x64-setup.exe"), ("manual", "x86_64", None), ("pip", "x86_64", None)],
)  # fmt: skip
def test_each_system_gets_its_own_file(monkeypatch, method, machine, expected):
    monkeypatch.setattr(updates, "install_method", lambda: method)
    monkeypatch.setattr(updates.platform, "machine", lambda: machine)
    info = updates.Updater(lambda e: None, fetch=lambda url: RELEASE).check()
    assert info["available"] and info["latest"] == "9.1.0" and info["notes"].startswith("## What's new")
    assert (info["asset"] or {}).get("name") == expected
    assert info["can_install"] is (expected is not None)


def test_no_update_when_current_or_offline(monkeypatch):
    monkeypatch.setattr(updates, "install_method", lambda: "deb")
    same = updates.Updater(lambda e: None, fetch=lambda url: {**RELEASE, "tag_name": f"v{updates.__version__}"}).check()
    assert not same["available"] and not same["can_install"]

    def offline(url):
        raise OSError("no network")

    info = updates.Updater(lambda e: None, fetch=offline).check()
    assert info["checked"] is False and not info["available"] and "could not reach GitHub" in info["error"]


def test_check_is_cached_until_forced(monkeypatch):
    calls = []

    def fetch(url):
        calls.append(url)
        return {"tag": "v9.1.0", "assets": []}

    updater = updates.Updater(lambda e: None, fetch=fetch)
    updater.check()
    updater.check()
    assert calls == [updates.MANIFEST]
    updater.check(force=True)
    assert calls == [updates.MANIFEST, updates.MANIFEST]


def _serve(monkeypatch, payload: bytes):
    monkeypatch.setattr(updates.urllib.request, "urlopen", lambda request, timeout=0: io.BytesIO(payload))


def test_download_checks_size_and_checksum(monkeypatch, tmp_path):
    monkeypatch.setattr(updates.tempfile, "gettempdir", lambda: str(tmp_path))
    events = []
    updater = updates.Updater(events.append)
    asset = RELEASE["assets"][1]
    _serve(monkeypatch, DATA)
    path = updater.download(
        {"name": asset["name"], "size": asset["size"], "url": asset["browser_download_url"], "digest": asset["digest"]}
    )
    assert path.read_bytes() == DATA and events[-1]["progress"] == 1.0

    _serve(monkeypatch, DATA[:-1] + b"X")
    with pytest.raises(RuntimeError, match="does not match"):
        updater.download(
            {
                "name": asset["name"],
                "size": asset["size"],
                "url": asset["browser_download_url"],
                "digest": asset["digest"],
            }
        )
    _serve(monkeypatch, DATA[:100])
    with pytest.raises(RuntimeError, match="stopped early"):
        updater.download(
            {"name": asset["name"], "size": asset["size"], "url": asset["browser_download_url"], "digest": None}
        )


def test_downloads_only_from_the_projects_releases(monkeypatch, tmp_path):
    monkeypatch.setattr(updates.tempfile, "gettempdir", lambda: str(tmp_path))
    with pytest.raises(RuntimeError, match="outside FlowLabs"):
        updates.Updater(lambda e: None).download({"name": "x.deb", "size": 1, "url": "https://example.com/x.deb"})
    monkeypatch.setattr(updates, "install_method", lambda: "deb")
    monkeypatch.setattr(updates.platform, "machine", lambda: "x86_64")
    tampered = {
        **RELEASE,
        "assets": [{**RELEASE["assets"][1], "browser_download_url": "https://evil.example/FlowLabs.deb"}],
    }
    assert updates.Updater(lambda e: None, fetch=lambda url: tampered).check()["can_install"] is False


def test_server_reports_updates_and_only_the_desktop_app_installs(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from flowlabs.server.app import create_app

    app = create_app(tmp_path / "ws", "t", start_kernel=False)
    app.state.updater.fetch = lambda url: RELEASE
    headers = {"Authorization": "Bearer t"}
    with TestClient(app, base_url="http://127.0.0.1:8899") as client:
        info = client.get("/api/update", headers=headers).json()
        assert info["available"] and info["method"] == "pip" and info["enabled"]
        assert client.post("/api/update/install", headers=headers).status_code == 400
        assert client.post("/api/update/settings", json={"check": False}, headers=headers).json() == {"enabled": False}
        assert client.get("/api/update", headers=headers).json() == {"current": updates.__version__, "available": False, "checked": False,
                                                                      "enabled": False, "method": "pip"}  # fmt: skip
        assert client.get("/api/update?force=true", headers=headers).json()["available"]


def test_the_release_manifest_is_preferred_over_the_api(monkeypatch):
    monkeypatch.setattr(updates, "install_method", lambda: "deb")
    monkeypatch.setattr(updates.platform, "machine", lambda: "x86_64")
    manifest = {"tag": "v9.2.0", "notes": "notes", "assets": [{"name": "FlowLabs-9.2.0-linux-amd64.deb", "size": 3, "sha256": "ab" * 32,
                                                               "url": updates.DOWNLOADS + "v9.2.0/FlowLabs-9.2.0-linux-amd64.deb"}]}  # fmt: skip
    asked = []

    def fetch(url):
        asked.append(url)
        if url == updates.MANIFEST:
            return manifest
        raise AssertionError("the API is not needed")

    info = updates.Updater(lambda e: None, fetch=fetch).check()
    assert asked == [updates.MANIFEST] and info["latest"] == "9.2.0" and info["can_install"]
    assert info["asset"]["digest"] == "sha256:" + "ab" * 32

    def old_release(url):
        if url == updates.MANIFEST:
            raise OSError("404")
        return RELEASE

    assert updates.Updater(lambda e: None, fetch=old_release).check()["latest"] == "9.1.0"
