"""Rich block outputs (PRD II 9.3): images, HTML, SVG, Vega-Lite, JSON and Markdown from kernels.

Jupyter sends every ``display_data`` / ``execute_result`` as a mimebundle. We keep the richest
representation the canvas can render, write its payload under ``.flowlab/outputs/`` (one file per
output, evicted oldest-first past a size cap) and put only small metadata in the execution record.
Payloads never leave this machine; the local API serves them to the canvas behind the token.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

OutputKind = Literal["vega", "image", "svg", "html", "markdown", "latex", "json", "text"]

# Richest first. Vega-Lite beats its PNG fallback; HTML beats the text repr of a DataFrame.
MIME_PRIORITY: list[tuple[str, OutputKind, str]] = [
    ("application/vnd.vegalite.v5+json", "vega", "json"),
    ("application/vnd.vegalite.v4+json", "vega", "json"),
    ("application/vnd.vega.v5+json", "vega", "json"),
    ("image/png", "image", "png"),
    ("image/jpeg", "image", "jpg"),
    ("image/gif", "image", "gif"),
    ("image/svg+xml", "svg", "svg"),
    ("text/html", "html", "html"),
    ("text/markdown", "markdown", "md"),
    ("text/latex", "latex", "tex"),
    ("application/json", "json", "json"),
]
EXTENSION_MIME = {ext: mime for mime, _, ext in MIME_PRIORITY}
MAX_PLAIN_CHARS = 4000
_EXECUTION_ID = re.compile(r"^ex_[0-9a-f]{12}$")


class RichOutput(BaseModel):
    index: int
    kind: OutputKind
    mime: str
    plain: str = ""
    size_bytes: int = 0
    stored: bool = False
    truncated: bool = False
    width: int | None = None
    height: int | None = None


def _payload_bytes(mime: str, value: Any) -> bytes:
    if mime.startswith("image/") and mime != "image/svg+xml":
        text = "".join(value) if isinstance(value, list) else str(value)
        try:
            return base64.b64decode(text, validate=False)
        except (binascii.Error, ValueError):
            return b""
    if isinstance(value, (dict, list)) and mime.endswith("json"):
        return json.dumps(value, ensure_ascii=False).encode("utf-8")
    text = "".join(value) if isinstance(value, list) else str(value)
    return text.encode("utf-8")


def _dimension(metadata: dict[str, Any], mime: str, key: str) -> int | None:
    value = metadata.get(mime, {}).get(key) if isinstance(metadata.get(mime), dict) else metadata.get(key)
    return int(value) if isinstance(value, (int, float)) else None


class OutputStore:
    def __init__(
        self, directory: Path, max_bytes: int = 200 * 1024 * 1024, max_item_bytes: int = 10 * 1024 * 1024
    ) -> None:
        self.directory = directory
        self.max_bytes = max_bytes
        self.max_item_bytes = max_item_bytes

    def capture(
        self, execution_id: str, index: int, data: dict[str, Any], metadata: dict[str, Any] | None = None
    ) -> RichOutput:
        plain_value = data.get("text/plain", "")
        plain = "".join(plain_value) if isinstance(plain_value, list) else str(plain_value)
        plain = plain[:MAX_PLAIN_CHARS]
        for mime, kind, extension in MIME_PRIORITY:
            if mime not in data:
                continue
            payload = _payload_bytes(mime, data[mime])
            output = RichOutput(
                index=index,
                kind=kind,
                mime=mime,
                plain=plain,
                size_bytes=len(payload),
                width=_dimension(metadata or {}, mime, "width"),
                height=_dimension(metadata or {}, mime, "height"),
            )
            if not payload:
                continue  # undecodable; fall through to the next representation
            if len(payload) > self.max_item_bytes:
                output.truncated = True
                return output
            self.directory.mkdir(parents=True, exist_ok=True)
            path = self.directory / f"{execution_id}_{index}.{extension}"
            temp = path.with_name(path.name + ".tmp")
            temp.write_bytes(payload)
            os.replace(temp, path)
            output.stored = True
            self.evict(keep=path)
            return output
        return RichOutput(index=index, kind="text", mime="text/plain", plain=plain, size_bytes=len(plain))

    def read(self, execution_id: str, index: int) -> tuple[str, bytes] | None:
        if not _EXECUTION_ID.match(execution_id) or index < 0 or not self.directory.is_dir():
            return None
        for path in self.directory.glob(f"{execution_id}_{index}.*"):
            mime = EXTENSION_MIME.get(path.suffix.lstrip("."))
            if mime is not None and path.is_file():
                if path.suffix == ".json":  # vega and plain JSON share the extension
                    mime = "application/json"
                return mime, path.read_bytes()
        return None

    def _files(self) -> list[Path]:
        if not self.directory.is_dir():
            return []
        files = [p for p in self.directory.glob("ex_*_*.*") if not p.name.endswith(".tmp")]
        return sorted(files, key=lambda p: (p.stat().st_mtime_ns, p.name))

    def evict(self, keep: Path | None = None) -> list[str]:
        removed: list[str] = []
        files = self._files()
        total = sum(p.stat().st_size for p in files)
        for path in files:
            if total <= self.max_bytes:
                break
            if keep is not None and path == keep:
                continue
            total -= path.stat().st_size
            path.unlink(missing_ok=True)
            removed.append(path.name)
        return removed
