"""DuckDB extensions shipped gzipped in the desktop app are unpacked once into the user's folder."""

from __future__ import annotations

import gzip
import os
from pathlib import Path

from flowlabs.core.sources import unpacked_extension


def test_gzipped_extensions_are_unpacked_once(tmp_path):
    bundle = tmp_path / "bundle" / "v2.0.1" / "osx_arm64"
    bundle.mkdir(parents=True)
    with gzip.open(bundle / "httpfs.duckdb_extension.gz", "wb") as out:
        out.write(b"extension bytes")
    cache = tmp_path / "cache"
    found = unpacked_extension(tmp_path / "bundle", "httpfs", cache)
    assert found == str(cache / "v2.0.1" / "osx_arm64" / "httpfs.duckdb_extension")
    assert Path(found).read_bytes() == b"extension bytes"
    stamp = os.stat(found).st_mtime_ns
    assert unpacked_extension(tmp_path / "bundle", "httpfs", cache) == found
    assert os.stat(found).st_mtime_ns == stamp  # not unpacked again
    assert unpacked_extension(tmp_path / "bundle", "azure", cache) is None
    assert unpacked_extension(tmp_path / "missing", "httpfs", cache) is None


def test_plain_files_from_older_builds_still_load_in_place(tmp_path):
    (tmp_path / "v1").mkdir()
    (tmp_path / "v1" / "aws.duckdb_extension").write_bytes(b"x")
    assert unpacked_extension(tmp_path, "aws") == str(tmp_path / "v1" / "aws.duckdb_extension")
