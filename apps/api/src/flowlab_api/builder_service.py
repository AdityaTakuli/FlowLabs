"""Build mode on the local server: draw a pipeline of snippet nodes, finalize it, run it in a kernel.

Pipelines are saved as ``pipelines/<name>.pipeline.json`` and finalize into ``pipelines/<name>.py``
with ``# %%`` cells, so the result is an ordinary script that also opens in Code Mode. Finalizing is
local and free unless the user asks the model to connect cells (or to fix a failed run); that sends
the generated snippet code and the dataset digest (column names, kinds, % missing, distinct
counts, never rows) and therefore needs ``confirm_external``.
"""

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Any

from flowlab_agent import CachedClient, DatasetDigest, GroqClient, LLMClient, SnippetLibrary, load_api_key
from flowlab_agent.builder import (
    NODE_MARKER,
    Pipeline,
    catalogue,
    check,
    finalize,
    load_pipeline,
    order_nodes,
)
from flowlab_lab.blocks import segment_text
from flowlab_lab.project import IGNORED_DIRS, LabProject, PathError

from .agent import DATASET_SUFFIXES, ClientFactory
from .service import EventHub, LabService, ServiceError

PIPELINE_DIR = "pipelines"
PIPELINE_SUFFIX = ".pipeline.json"
MAX_DATASETS = 500
SENT_TO_LLM = (
    "the generated pipeline code (FlowLab's reviewed snippets with your parameters), the target column, "
    "and the dataset digest: row count and each column's name, kind, % missing and distinct count; "
    "never data rows"
)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:48] or "pipeline"


class BuilderService:
    def __init__(
        self, service: LabService, hub: EventHub, client_factory: ClientFactory | None = None
    ) -> None:
        self.service = service
        self.project: LabProject = service.project
        self.hub = hub
        self._factory = client_factory
        self._library: SnippetLibrary | None = None
        self._digests: dict[tuple[str, int, int], DatasetDigest] = {}
        self._lock = threading.Lock()

    # ----------------------------------------------------------------- resources
    @property
    def library(self) -> SnippetLibrary:
        if self._library is None:
            library = SnippetLibrary.load()
            if library.issues:
                raise ServiceError(
                    500, "LIBRARY_INVALID", f"the snippet library has {len(library.issues)} problem(s)"
                )
            self._library = library
        return self._library

    def catalogue(self) -> dict[str, Any]:
        return {"purposes": catalogue(self.library), "llm_configured": self._configured()}

    def _configured(self) -> bool:
        return self._factory is not None or bool(load_api_key(search=[self.project.root, Path.cwd()]))

    def _client(self) -> LLMClient:
        if self._factory is not None:
            return self._factory(None)
        key = load_api_key(search=[self.project.root, Path.cwd()])
        if not key:
            raise ServiceError(
                412,
                "NO_API_KEY",
                "GROQ_API_KEY is not set: add it to .env in the project folder or export it",
            )
        return CachedClient(GroqClient(key), self.project.state_dir / "llm_cache")

    def _resolve(self, file: str) -> Path:
        try:
            return self.project.resolve(file)
        except PathError as exc:
            raise ServiceError(403, "PATH_OUTSIDE_ROOT", str(exc)) from exc

    # ------------------------------------------------------------------- datasets
    def datasets(self) -> list[str]:
        found: list[str] = []
        root = self.project.root
        for directory, subdirs, files in os.walk(root, followlinks=False):
            subdirs[:] = sorted(d for d in subdirs if d not in IGNORED_DIRS and not d.startswith("."))
            for name in sorted(files):
                if name.endswith(DATASET_SUFFIXES) and not name.endswith(".json"):
                    path = Path(directory) / name
                    if path.resolve().is_relative_to(root):
                        found.append(path.relative_to(root).as_posix())
                if len(found) >= MAX_DATASETS:
                    return found
        return found

    def digest(self, file: str) -> DatasetDigest:
        path = self._resolve(file)
        if not path.is_file():
            raise ServiceError(404, "DATASET_NOT_FOUND", f"{file} does not exist")
        if not file.lower().endswith(DATASET_SUFFIXES):
            raise ServiceError(
                400, "UNSUPPORTED_DATASET", "pick a .csv, .tsv, .parquet, .jsonl or Excel file"
            )
        stat = path.stat()
        key = (str(path), stat.st_mtime_ns, stat.st_size)
        with self._lock:
            cached = self._digests.get(key)
        if cached is not None:
            return cached
        try:
            digest = DatasetDigest.from_file(path)
        except Exception as exc:  # noqa: BLE001 - unreadable data is a user-facing problem
            raise ServiceError(422, "DATASET_UNREADABLE", f"{type(exc).__name__}: {exc}") from exc
        with self._lock:
            self._digests = {k: v for k, v in self._digests.items() if k[0] != str(path)}
            self._digests[key] = digest
        return digest

    def dataset(self, file: str) -> dict[str, Any]:
        digest = self.digest(file)
        return {
            "file": file,
            "rows": digest.row_count,
            "columns": [
                {
                    "name": c.name,
                    "kind": c.kind,
                    "null_pct": c.null_pct,
                    "cardinality": c.cardinality,
                    "task": digest.task_for(c.name),
                }
                for c in digest.columns
            ],
        }

    # ------------------------------------------------------------------ pipelines
    def pipelines(self) -> list[dict[str, Any]]:
        directory = self.project.root / PIPELINE_DIR
        if not directory.is_dir():
            return []
        items = []
        for path in sorted(directory.glob(f"*{PIPELINE_SUFFIX}")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                items.append(
                    {
                        "file": self.project.relative(path),
                        "name": data.get("name"),
                        "nodes": len(data.get("nodes", [])),
                    }
                )
            except (OSError, ValueError):
                continue
        return items

    def _parse(self, data: dict[str, Any]) -> Pipeline:
        try:
            return load_pipeline(data)
        except ValueError as exc:
            raise ServiceError(422, "PIPELINE_INVALID", str(exc)) from exc

    def load(self, file: str) -> dict[str, Any]:
        if not file.endswith(PIPELINE_SUFFIX):
            raise ServiceError(400, "NOT_A_PIPELINE", f"pipelines end with {PIPELINE_SUFFIX}")
        path = self._resolve(file)
        if not path.is_file():
            raise ServiceError(404, "PIPELINE_NOT_FOUND", f"{file} does not exist")
        pipeline = self._parse(json.loads(path.read_text(encoding="utf-8")))
        return {"file": file, "pipeline": pipeline.model_dump(mode="json", by_alias=True)}

    def save(self, file: str, data: dict[str, Any]) -> dict[str, Any]:
        if not file.endswith(PIPELINE_SUFFIX):
            raise ServiceError(400, "NOT_A_PIPELINE", f"pipelines end with {PIPELINE_SUFFIX}")
        pipeline = self._parse(data)
        path = self._resolve(file)
        path.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(pipeline.model_dump(mode="json", by_alias=True), indent=2) + "\n"
        self.project.write_atomic(self.project.relative(path), text)
        return {"file": self.project.relative(path)}

    def create(self, name: str, dataset: str | None) -> dict[str, Any]:
        stem = _slug(name)
        file = f"{PIPELINE_DIR}/{stem}{PIPELINE_SUFFIX}"
        counter = 2
        while self._resolve(file).exists():
            file = f"{PIPELINE_DIR}/{stem}_{counter}{PIPELINE_SUFFIX}"
            counter += 1
        nodes = []
        if dataset:
            suffix = Path(dataset).suffix.lower()
            loader = {
                ".parquet": "load.parquet",
                ".xlsx": "load.excel",
                ".xls": "load.excel",
                ".jsonl": "load.json",
            }
            params = (
                {"sep": "tab"}
                if suffix == ".tsv"
                else ({"lines": True} if suffix in (".jsonl", ".ndjson") else {})
            )
            nodes.append(
                {"id": "n1", "snippet": loader.get(suffix, "load.csv"), "params": params, "x": 0, "y": 0}
            )
        pipeline = {
            "name": name.strip() or "Pipeline",
            "dataset": dataset,
            "target": None,
            "nodes": nodes,
            "edges": [],
        }
        self.save(file, pipeline)
        return self.load(file)

    def script_file(self, file: str) -> str:
        return file[: -len(PIPELINE_SUFFIX)] + ".py"

    # ------------------------------------------------------------ check / finalize
    def check(self, data: dict[str, Any]) -> dict[str, Any]:
        pipeline = self._parse(data)
        digest = self.digest(pipeline.dataset) if pipeline.dataset else None
        ordered, _ = order_nodes(pipeline, self.library)
        issues = check(pipeline, self.library, digest)
        return {"issues": [i.model_dump() for i in issues], "order": [n.id for n in ordered]}

    def finalize(
        self,
        file: str,
        data: dict[str, Any],
        *,
        use_llm: bool,
        confirm_external: bool,
        error: str | None = None,
    ) -> dict[str, Any]:
        if use_llm and not confirm_external:
            raise ServiceError(
                428, "CONSENT_REQUIRED", f"connecting with the model sends {SENT_TO_LLM}; confirm first"
            )
        pipeline = self._parse(data)
        self.save(file, data)
        if not pipeline.dataset:
            raise ServiceError(422, "NO_DATASET", "choose the dataset this pipeline reads")
        digest = self.digest(pipeline.dataset)
        client = self._client() if use_llm else None
        output_dir = self.project.root / PIPELINE_DIR / "outputs"
        result = finalize(pipeline, self.library, digest, output_dir=output_dir, client=client, error=error)
        payload = result.as_dict()
        payload["script_file"] = None
        payload["blocks"] = {}
        if result.ok and result.script is not None:
            script_file = self.script_file(file)
            self._resolve(script_file).parent.mkdir(parents=True, exist_ok=True)
            existed = self._resolve(script_file).exists()
            self.project.write_atomic(script_file, result.script)
            session = self.service.sessions.get(script_file)
            if session is not None:
                session.refresh()
            self.hub.publish(
                {"type": "file_changed", "file": script_file,
                 "data": {"kind": "modified" if existed else "added", "origin": "flowlab"}}
            )  # fmt: skip
            payload["script_file"] = script_file
            payload["blocks"] = self.blocks(script_file)
        return payload

    def blocks(self, script_file: str) -> dict[str, dict[str, Any]]:
        """Which pipeline node each ``# %%`` block of the generated script came from."""
        text = self.project.read(script_file)
        mapping: dict[str, dict[str, Any]] = {}
        for block in segment_text(script_file, text).code_blocks:
            title = block.title or ""
            marker = NODE_MARKER.search(title)
            kind = (
                "node"
                if marker
                else "glue"
                if title.startswith("Glue:")
                else "setup"
                if title == "Setup"
                else "auto"
            )
            mapping[block.id] = {"node": marker.group(1) if marker else None, "kind": kind, "title": title}
        return mapping

    # ------------------------------------------------------------------------ run
    def run(self, script_file: str) -> dict[str, Any]:
        path = self._resolve(script_file)
        if not path.is_file():
            raise ServiceError(404, "NOT_FINALIZED", "finalize the pipeline before running it")
        session = self.service.sessions.get(script_file)
        if session is None or not session.is_alive():
            if session is not None:
                self.service.stop_session(script_file)
            self.service.start_session(script_file)
        started = self.service.execute(script_file, None, "all")
        return {"file": script_file, "plan": started.get("plan", []), "blocks": self.blocks(script_file)}
