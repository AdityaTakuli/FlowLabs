"""SSH tunnels: reach a database that only listens inside a private network.

A connection with "Connect through SSH" signs in to an SSH server (a bastion or the database's own
machine) and forwards a local port to the database through it, the way ``ssh -L`` does. The
database driver then connects to ``127.0.0.1:<local port>``.

The SSH server's key is checked: against ``~/.ssh/known_hosts``, or against the fingerprint saved
with the connection when you chose to trust it. An unknown key is refused with its fingerprint,
so you can compare it with the one your administrator gives you.

Uses paramiko, installed the first time a connection needs it (see plugins.py).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import select
import socket
import socketserver
import threading
import time
from pathlib import Path
from typing import Any

from . import plugins
from .util import UserError

PACKAGES = ("paramiko",)
MODULES = ("paramiko",)
IDLE_CLOSE_S = 15 * 60


class UnknownHostKey(UserError):
    """The SSH server's key is not trusted yet; ``fingerprint`` is what to compare."""

    def __init__(self, host: str, fingerprint: str) -> None:
        super().__init__(
            f"FlowLabs has not seen the SSH server {host} before. Its key fingerprint is {fingerprint}. "
            "If it matches the one your administrator gives you, choose Trust this server."
        )
        self.host, self.fingerprint = host, fingerprint


class HostKeyChanged(UserError):
    pass


def fingerprint(key: Any) -> str:
    """OpenSSH's form: ``SHA256:`` and the base64 of the key's SHA-256, without padding."""
    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")


def wanted(values: dict[str, Any]) -> bool:
    return bool(values.get("ssh")) and bool(values.get("ssh_host"))


class _Forwarder(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


class Tunnel:
    """A local port forwarded to ``remote`` through an SSH connection; reconnects when it drops."""

    def __init__(self, values: dict[str, Any], secrets: dict[str, str], remote: tuple[str, int]) -> None:
        missing = plugins.missing(list(MODULES))
        if missing:
            raise UserError("Connecting through SSH needs paramiko. Install it in the connection's settings.")
        self.values, self.secrets, self.remote = values, secrets, remote
        self.lock = threading.Lock()
        self.client: Any = None
        self.last_used = time.time()
        self._connect()
        tunnel = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self) -> None:
                tunnel._pipe(self.request)

        self.server = _Forwarder(("127.0.0.1", 0), Handler)
        self.port = int(self.server.server_address[1])
        threading.Thread(target=self.server.serve_forever, daemon=True, name="ssh-tunnel").start()

    # ------------------------------------------------------------------------------ connecting
    def _connect(self) -> None:
        import paramiko

        v = self.values
        host, port = str(v["ssh_host"]), int(v.get("ssh_port") or 22)
        client = paramiko.SSHClient()
        try:
            client.load_system_host_keys()
        except OSError:
            pass
        trusted = str(v.get("ssh_fingerprint") or "")

        class Policy(paramiko.MissingHostKeyPolicy):
            def missing_host_key(self, _client: Any, hostname: str, key: Any) -> None:
                found = fingerprint(key)
                if trusted and hmac.compare_digest(trusted, found):
                    return
                if trusted:
                    raise HostKeyChanged(
                        f"The SSH server {hostname} now has a different key ({found}) from the one you trusted "
                        f"({trusted}). It may have been reinstalled, or someone may be in between. Check with "
                        "your administrator before trusting the new key."
                    )
                raise UnknownHostKey(hostname, found)

        client.set_missing_host_key_policy(Policy())
        auth = v.get("ssh_auth") or "password"
        options: dict[str, Any] = {"hostname": host, "port": port, "username": v.get("ssh_user") or None,
                                   "timeout": 10, "banner_timeout": 10, "auth_timeout": 15,
                                   "allow_agent": auth == "agent", "look_for_keys": auth == "agent"}  # fmt: skip
        if auth == "password":
            options["password"] = self.secrets.get("ssh_password") or None
        elif auth == "key":
            key_file = Path(str(v.get("ssh_key") or "")).expanduser()
            if not key_file.is_file():
                raise UserError(f"there is no SSH key file at {key_file}")
            options["key_filename"] = str(key_file)
            options["passphrase"] = self.secrets.get("ssh_passphrase") or None
        try:
            client.connect(**options)
        except UserError:
            client.close()
            raise
        except paramiko.AuthenticationException as error:
            client.close()
            raise UserError(f"The SSH server {host} did not accept the sign-in: {error}") from error
        except (OSError, paramiko.SSHException) as error:
            client.close()
            raise UserError(f"Could not reach the SSH server {host}:{port}: {error}") from error
        transport = client.get_transport()
        if transport is not None:
            transport.set_keepalive(30)
        self.client = client

    def _channel(self, source: tuple[str, int]) -> Any:
        with self.lock:
            transport = self.client.get_transport() if self.client else None
            if transport is None or not transport.is_active():
                self._connect()
                transport = self.client.get_transport()
            return transport.open_channel("direct-tcpip", self.remote, source, timeout=10)

    def _pipe(self, local: socket.socket) -> None:
        self.last_used = time.time()
        try:
            channel = self._channel(local.getpeername())
        except Exception:  # noqa: BLE001 - the driver sees a closed socket and reports it
            local.close()
            return
        try:
            while True:
                ready, _, _ = select.select([local, channel], [], [], 60)
                if local in ready:
                    data = local.recv(65536)
                    if not data:
                        break
                    channel.sendall(data)
                if channel in ready:
                    data = channel.recv(65536)
                    if not data:
                        break
                    local.sendall(data)
                self.last_used = time.time()
        except OSError:
            pass
        finally:
            channel.close()
            local.close()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        if self.client is not None:
            self.client.close()


_tunnels: dict[str, Tunnel] = {}
_lock = threading.Lock()


def _key(values: dict[str, Any], secrets: dict[str, str], remote: tuple[str, int]) -> str:
    parts = [str(values.get(k) or "") for k in ("ssh_host", "ssh_port", "ssh_user", "ssh_auth", "ssh_key",
                                                 "ssh_fingerprint")]  # fmt: skip
    secret = hashlib.sha256("|".join(secrets.get(k, "") for k in ("ssh_password", "ssh_passphrase")).encode())
    return "|".join([*parts, secret.hexdigest(), remote[0], str(remote[1])])


def through(values: dict[str, Any], secrets: dict[str, str], default_port: int) -> dict[str, Any]:
    """``values`` with host and port pointing at a tunnel to the database, opened if needed."""
    if not wanted(values):
        return values
    remote = (str(values.get("host") or "127.0.0.1"), int(values.get("port") or default_port))
    key = _key(values, secrets, remote)
    with _lock:
        _close_idle()
        tunnel = _tunnels.get(key)
        if tunnel is None:
            tunnel = _tunnels[key] = Tunnel(values, secrets, remote)
        tunnel.last_used = time.time()
    return {**values, "host": "127.0.0.1", "port": tunnel.port}


def _close_idle() -> None:
    now = time.time()
    for key, tunnel in list(_tunnels.items()):
        if now - tunnel.last_used > IDLE_CLOSE_S:
            _tunnels.pop(key, None)
            tunnel.close()


def close_all() -> None:
    with _lock:
        for tunnel in _tunnels.values():
            tunnel.close()
        _tunnels.clear()
