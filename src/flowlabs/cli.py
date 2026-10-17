"""``flowlabs``: the desktop app, a shareable engine for the browser app, and the kernel.

flowlabs app                       open FlowLabs in a window (or your browser)
flowlabs engine                    let the browser app use this computer's CPU/GPU
flowlabs engine --host 0.0.0.0     ... from another machine on your network (prints the token)
"""

from __future__ import annotations

import argparse
import os
import secrets
import sys
import time
import urllib.parse
from pathlib import Path


def _workspace(value: str | None) -> Path:
    from flowlabs.server.desktop import default_workspace

    root = Path(value).expanduser().resolve() if value else default_workspace()
    root.mkdir(parents=True, exist_ok=True)
    return root


def cmd_app(arguments: argparse.Namespace) -> int:
    from flowlabs.server.desktop import check, launch

    root = _workspace(arguments.workspace or arguments.folder)
    if arguments.check:
        return check(root, arguments.port)
    return launch(root, port=arguments.port, window=not arguments.browser)


def cmd_engine(arguments: argparse.Namespace) -> int:
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[union-attr]  # show the link even when piped
    from flowlabs.server.app import DEFAULT_ORIGINS, DEFAULT_WEB_URL
    from flowlabs.server.desktop import Server, free_port

    root = _workspace(arguments.workspace)
    token = arguments.token or os.environ.get("FLOWLABS_TOKEN") or secrets.token_urlsafe(18)
    origins = [*DEFAULT_ORIGINS, *(arguments.allow_origin or [])]
    options: dict[str, object] = {"allowed_origins": origins}
    if arguments.python:
        options["python"] = arguments.python
    server = Server(root, arguments.port or free_port(8899), token, host=arguments.host, **options)
    server.start()
    engine_url = (
        server.base if arguments.host in ("127.0.0.1", "localhost") else f"http://{_lan_address()}:{server.port}"
    )
    link = f"{DEFAULT_WEB_URL.rstrip('/')}/#" + urllib.parse.urlencode({"engine": engine_url, "token": token})
    print("FlowLabs engine is running.")
    print(f"  workspace   {root}")
    print(f"  engine URL  {engine_url}")
    print(f"  token       {token}")
    print()
    print("Open the web app connected to this engine:")
    print(f"  {link}")
    print("or use the app this engine serves itself:")
    print(f"  {server.url}")
    if arguments.host not in ("127.0.0.1", "localhost"):
        print("\nAnyone on your network with the token can use this engine. Stop it with Ctrl+C when done.")
    try:
        kernel = server.app.state.kernel
        kernel.wait_ready()
        info = kernel.info
        print(f"\nKernel ready: Python {info.get('python')} ({info.get('executable')})")
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        return 0
    except Exception as error:  # noqa: BLE001
        print(f"\nThe kernel did not start: {error}", file=sys.stderr)
        while True:
            time.sleep(1)
    finally:
        server.stop()


def _lan_address() -> str:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        try:
            probe.connect(("10.255.255.255", 1))
            return str(probe.getsockname()[0])
        except OSError:
            return "127.0.0.1"


def cmd_worker(arguments: argparse.Namespace) -> int:
    from flowlabs.worker import main

    return main(["--root", arguments.root])


def build_parser() -> argparse.ArgumentParser:
    from flowlabs import __version__

    parser = argparse.ArgumentParser(prog="flowlabs", description="Visual machine learning: data → model, no code.")
    parser.add_argument("--version", action="version", version=f"flowlabs {__version__}")
    commands = parser.add_subparsers(dest="command")

    app = commands.add_parser("app", help="open the desktop app")
    app.add_argument("folder", nargs="?", help=argparse.SUPPRESS)
    app.add_argument("--workspace", help="folder for datasets, projects and models (default ~/FlowLabs)")
    app.add_argument("--port", type=int)
    app.add_argument("--browser", action="store_true", help="open in the browser instead of a window")
    app.add_argument("--check", action="store_true", help=argparse.SUPPRESS)
    app.set_defaults(func=cmd_app)

    engine = commands.add_parser("engine", help="share this computer's CPU/GPU with the browser app")
    engine.add_argument("--workspace")
    engine.add_argument("--host", default="127.0.0.1", help="0.0.0.0 to accept other machines on your network")
    engine.add_argument("--port", type=int)
    engine.add_argument("--token", help="fixed token (default: a new random one)")
    engine.add_argument("--python", help="the Python interpreter the kernel runs in (default: this one)")
    engine.add_argument("--allow-origin", action="append", help="another web origin allowed to connect")
    engine.set_defaults(func=cmd_engine)

    worker = commands.add_parser("worker", help=argparse.SUPPRESS)
    worker.add_argument("--root", required=True)
    worker.set_defaults(func=cmd_worker)
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments[:1] == ["--worker"]:  # the packaged app re-runs itself as its built-in kernel
        return cmd_worker(build_parser().parse_args(["worker", *arguments[1:]]))
    if not arguments or arguments[0].startswith("--") and arguments[0] not in ("--version", "-h", "--help"):
        arguments = ["app", *arguments]
    parsed = build_parser().parse_args(arguments)
    if not hasattr(parsed, "func"):
        parsed = build_parser().parse_args(["app"])
    return int(parsed.func(parsed))


def app_main() -> int:
    """Entry point of the packaged app and ``flowlabs-app``."""
    return main(["app", *sys.argv[1:]] if sys.argv[1:2] != ["--worker"] else sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
