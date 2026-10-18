"""Where passwords, keys and tokens for connections are kept.

In the operating system's keychain when there is one (macOS Keychain, Windows Credential Manager,
the Secret Service on Linux desktops), under the service name "FlowLabs". Where there is none (a
server without a desktop session, the browser version), in ``<workspace>/.secrets.json``, readable
only by you. ``FLOWLABS_SECRETS=file`` forces the file (tests, headless engines).
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from .workspace import Workspace

SERVICE = "FlowLabs"


def _keyring() -> Any | None:
    if os.environ.get("FLOWLABS_SECRETS") == "file":
        return None
    try:
        import keyring
        from keyring.backends import fail

        backend = keyring.get_keyring()
        if isinstance(backend, fail.Keyring) or getattr(backend, "priority", 1) <= 0:
            return None
        return keyring
    except Exception:  # noqa: BLE001 - no keyring, or no session bus: use the file
        return None


def _scope(ws: Workspace) -> str:
    """Secrets are per workspace: two engines on one computer never see each other's."""
    return hashlib.sha1(str(ws.root.resolve()).encode()).hexdigest()[:10]


def _file(ws: Workspace) -> Path:
    return ws.root / ".secrets.json"


def _read_file(ws: Workspace) -> dict[str, str]:
    try:
        return dict(json.loads(_file(ws).read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return {}


def _write_file(ws: Workspace, values: dict[str, str]) -> None:
    path = _file(ws)
    ws.write_json(path, values)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def backend() -> str:
    return "keychain" if _keyring() is not None else "file"


def put(ws: Workspace, key: str, value: str) -> str:
    """Keep a secret; returns where it went ("keychain" or "file")."""
    name = f"{_scope(ws)}:{key}"
    keyring = _keyring()
    if keyring is not None:
        try:
            keyring.set_password(SERVICE, name, value)
            values = _read_file(ws)
            if name in values:  # moved to the keychain
                values.pop(name)
                _write_file(ws, values)
            return "keychain"
        except Exception:  # noqa: BLE001 - locked or unavailable keychain: fall back to the file
            pass
    values = _read_file(ws)
    values[name] = value
    _write_file(ws, values)
    return "file"


def get(ws: Workspace, key: str) -> str | None:
    name = f"{_scope(ws)}:{key}"
    keyring = _keyring()
    if keyring is not None:
        try:
            found = keyring.get_password(SERVICE, name)
            if found is not None:
                return str(found)
        except Exception:  # noqa: BLE001
            pass
    return _read_file(ws).get(name)


def delete(ws: Workspace, key: str) -> None:
    name = f"{_scope(ws)}:{key}"
    keyring = _keyring()
    if keyring is not None:
        try:
            keyring.delete_password(SERVICE, name)
        except Exception:  # noqa: BLE001 - not there
            pass
    values = _read_file(ws)
    if name in values:
        values.pop(name)
        _write_file(ws, values)
