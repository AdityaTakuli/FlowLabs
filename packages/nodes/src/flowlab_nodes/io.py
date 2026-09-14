"""Reading datasets and canonical Parquet serialisation."""

from __future__ import annotations

import io
from pathlib import Path

import polars as pl
from flowspec import sha256_bytes

SUPPORTED_SUFFIXES = (".parquet", ".csv", ".tsv", ".jsonl", ".ndjson", ".json", ".feather", ".arrow", ".ipc")
NULL_TOKENS = ["", "NA", "N/A", "n/a", "null", "NULL", "None", "NaN", "nan"]


def read_table(path: Path) -> pl.DataFrame:
    suffix = path.suffix.lower()
    if suffix == ".parquet":
        return pl.read_parquet(path)
    if suffix in (".csv", ".tsv"):
        options = {
            "separator": "\t" if suffix == ".tsv" else ",",
            "infer_schema_length": 10000,
            "null_values": NULL_TOKENS,
        }
        try:
            return pl.read_csv(path, try_parse_dates=True, **options)  # type: ignore[arg-type]
        except pl.exceptions.ComputeError:
            # Mixed date formats in one column: keep it as text for clean.datetime_parse.
            return pl.read_csv(path, try_parse_dates=False, **options)  # type: ignore[arg-type]
    if suffix in (".jsonl", ".ndjson"):
        return pl.read_ndjson(path)
    if suffix == ".json":
        return pl.read_json(path)
    if suffix in (".feather", ".arrow", ".ipc"):
        return pl.read_ipc(path)
    raise ValueError(f"unsupported dataset format '{suffix}' ({path})")


def table_to_parquet_bytes(df: pl.DataFrame) -> bytes:
    buf = io.BytesIO()
    df.write_parquet(buf, compression="zstd", compression_level=3, statistics=True)
    return buf.getvalue()


def table_hash(df: pl.DataFrame) -> str:
    return sha256_bytes(table_to_parquet_bytes(df))
