"""Runner version: package version plus a hash of the pinned dependency set (PRD 14.2)."""

from __future__ import annotations

from functools import cache
from importlib import metadata

from flowspec import canonical_json, sha256_text

__version__ = "0.1.0"

PINNED_PACKAGES = (
    "flowlab",
    "polars",
    "pyarrow",
    "numpy",
    "scikit-learn",
    "scipy",
    "joblib",
    "pydantic",
)


def dependency_versions() -> dict[str, str]:
    versions = {}
    for name in PINNED_PACKAGES:
        try:
            versions[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            versions[name] = "missing"
    return versions


@cache
def runner_version() -> str:
    digest = sha256_text(canonical_json(dependency_versions())).removeprefix("sha256:")
    return f"{__version__}+{digest[:12]}"
