"""Write latest.json for a release: the version, notes, and each file with its size and SHA-256.

The desktop app reads it from https://github.com/AdityaTakuli/FlowLabs/releases/latest/download/latest.json
to find and check updates (a plain download: no API rate limit).

    python scripts/release_manifest.py v0.4.0 assets/ > latest.json
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

REPO = "AdityaTakuli/FlowLabs"
ROOT = Path(__file__).resolve().parents[1]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def manifest(tag: str, folder: Path) -> dict[str, object]:
    notes_file = ROOT / "docs" / "releases" / f"{tag}.md"
    files = sorted(p for p in folder.iterdir() if p.is_file() and p.name != "latest.json")
    return {
        "tag": tag,
        "version": tag.lstrip("v"),
        "published": datetime.now(UTC).isoformat(timespec="seconds"),
        "page": f"https://github.com/{REPO}/releases/tag/{tag}",
        "notes": notes_file.read_text(encoding="utf-8") if notes_file.is_file() else "",
        "assets": [
            {
                "name": p.name,
                "size": p.stat().st_size,
                "sha256": sha256(p),
                "url": f"https://github.com/{REPO}/releases/download/{tag}/{p.name}",
            }
            for p in files
        ],  # fmt: skip
    }


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    print(json.dumps(manifest(sys.argv[1], Path(sys.argv[2])), indent=1))
