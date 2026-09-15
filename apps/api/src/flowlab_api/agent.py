"""Agent panel on the local server: goal -> reviewed-snippet plan -> script in the project.

The LLM never writes code (decision 0004): it picks snippets and fills validated params, and
FlowLab composes the script. What leaves the machine is the goal plus a dataset *digest* (row
count and, per column, name, kind, % missing, distinct count) — never rows or code. Because that
is an external call even in Local-only mode, every ask must carry ``confirm_external``.

Scripts are rendered with ``# %%`` cells so they open in Code Mode as a runnable graph.
"""

from __future__ import annotations

import json
import os
import re
import threading
import uuid
from collections import OrderedDict
from collections.abc import Callable
from pathlib import Path
from typing import Any

from flowlab_agent import (
    CachedClient,
    ComposeResult,
    DatasetDigest,
    GroqClient,
    LLMClient,
    Plan,
    SnippetIndex,
    SnippetLibrary,
    UsageLog,
    compose,
    load_api_key,
    plan_goal,
)
from flowlab_agent.llm import DEFAULT_GROQ_MODEL, estimate_tokens
from flowlab_agent.planner import Attempt, build_messages
from flowlab_lab.project import LabProject, PathError
from flowlab_nodes.io import SUPPORTED_SUFFIXES
from pydantic import ValidationError

from .service import EventHub, ServiceError

ClientFactory = Callable[[str | None], LLMClient]
MAX_GOAL_CHARS = 1000
MAX_PROPOSALS = 20
DATASET_SUFFIXES = (*SUPPORTED_SUFFIXES, ".xlsx", ".xls")
SENT_TO_LLM = (
    "your question, the dataset's row count, and for each column its name, kind, % missing and "
    "number of distinct values"
)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:48] or "analysis"


class AgentService:
    def __init__(
        self, project: LabProject, hub: EventHub, client_factory: ClientFactory | None = None
    ) -> None:
        self.project = project
        self.hub = hub
        self._factory = client_factory
        self._library: SnippetLibrary | None = None
        self._digests: dict[tuple[str, int, int], DatasetDigest] = {}
        self._proposals: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._lock = threading.Lock()

    # ------------------------------------------------------------------- resources
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

    @property
    def output_dir(self) -> Path:
        return self.project.root / "generated" / "outputs"

    def _api_key(self) -> str | None:
        return load_api_key(search=[self.project.root, Path.cwd()])

    def _client(self, model: str | None, use_cache: bool) -> LLMClient:
        client: LLMClient
        if self._factory is not None:
            client = self._factory(model)
        else:
            key = self._api_key()
            if not key:
                raise ServiceError(
                    412,
                    "NO_API_KEY",
                    "GROQ_API_KEY is not set: add it to a .env file in the project folder "
                    "(see .env.example) or export it before starting `flowlab serve`",
                )
            client = GroqClient(key, model)
        if use_cache:
            client = CachedClient(client, self.project.state_dir / "llm_cache")
        return client

    def _dataset(self, file: str) -> tuple[str, DatasetDigest]:
        if not file.lower().endswith(DATASET_SUFFIXES):
            raise ServiceError(400, "UNSUPPORTED_DATASET", "pick a .csv, .parquet, .json or Excel file")
        try:
            path = self.project.resolve(file)
        except PathError as exc:
            raise ServiceError(403, "PATH_OUTSIDE_ROOT", str(exc)) from exc
        if not path.is_file():
            raise ServiceError(404, "DATASET_NOT_FOUND", f"{file} does not exist")
        stat = path.stat()
        key = (str(path), stat.st_mtime_ns, stat.st_size)
        digest = self._digests.get(key)
        if digest is None:
            try:
                digest = DatasetDigest.from_file(path)
            except Exception as exc:  # noqa: BLE001 - unreadable data is a user-facing problem
                raise ServiceError(422, "DATASET_UNREADABLE", f"{type(exc).__name__}: {exc}") from exc
            self._digests = {k: v for k, v in self._digests.items() if k[0] != str(path)}
            self._digests[key] = digest
        return self.project.relative(path), digest

    @staticmethod
    def _goal(goal: str) -> str:
        cleaned = " ".join(goal.split())
        if not cleaned:
            raise ServiceError(422, "EMPTY_GOAL", "describe what you want to find out")
        if len(cleaned) > MAX_GOAL_CHARS:
            raise ServiceError(422, "GOAL_TOO_LONG", f"keep the question under {MAX_GOAL_CHARS} characters")
        return cleaned

    def _usage(self) -> dict[str, int]:
        totals = {"requests": 0, "cached": 0, "tokens": 0}
        path = self.project.state_dir / "llm_usage.jsonl"
        if not path.is_file():
            return totals
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            totals["requests"] += 1
            if entry.get("cached"):
                totals["cached"] += 1
            else:
                totals["tokens"] += int(entry.get("prompt_tokens", 0)) + int(
                    entry.get("completion_tokens", 0)
                )
        return totals

    # ------------------------------------------------------------------------ routes
    def status(self) -> dict[str, Any]:
        library = self.library
        return {
            "configured": self._factory is not None or bool(self._api_key()),
            "model": os.environ.get("FLOWLAB_LLM_MODEL") or DEFAULT_GROQ_MODEL,
            "snippets": len(library),
            "categories": library.categories(),
            "sends": SENT_TO_LLM,
            "local_only": self.project.config.local_only,
            "usage": self._usage(),
        }

    def preview(self, goal: str, dataset: str, k: int) -> dict[str, Any]:
        """The exact messages an ask would send, without calling the LLM."""
        goal = self._goal(goal)
        _, digest = self._dataset(dataset)
        candidates = SnippetIndex(self.library).search(goal, digest=digest, k=k)
        messages = build_messages(goal, digest, [s.signature() for s, _ in candidates])
        return {
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "estimated_tokens": estimate_tokens(messages),
            "candidates": [s.id for s, _ in candidates],
        }

    def ask(
        self, goal: str, dataset: str, *, k: int, model: str | None, use_cache: bool, confirm_external: bool
    ) -> dict[str, Any]:
        if not confirm_external:
            raise ServiceError(
                428,
                "CONSENT_REQUIRED",
                f"asking sends {SENT_TO_LLM} to the LLM provider; confirm to continue",
            )
        goal = self._goal(goal)
        relative, digest = self._dataset(dataset)
        client = self._client(model, use_cache)
        result = plan_goal(
            goal, digest, client, self.library, k=k,
            usage_log=UsageLog(self.project.state_dir / "llm_usage.jsonl"),
            cells=True, output_dir=self.output_dir,
        )  # fmt: skip
        return self._proposal(
            goal, relative, result.plan, result.composed,
            attempts=result.attempts, error=result.error, candidates=result.candidates,
            tokens=result.tokens_spent, model=client.model,
        )  # fmt: skip

    def compose_plan(self, goal: str, dataset: str, plan: dict[str, Any]) -> dict[str, Any]:
        """Re-assemble an edited plan locally. Costs zero tokens."""
        goal = self._goal(goal)
        relative, digest = self._dataset(dataset)
        try:
            parsed = Plan.model_validate(plan)
        except ValidationError as exc:
            problems = [f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()[:5]]
            raise ServiceError(422, "PLAN_INVALID", "; ".join(problems)) from exc
        composed = compose(parsed, self.library, digest, goal=goal, cells=True, output_dir=self.output_dir)
        return self._proposal(goal, relative, parsed, composed)

    def _proposal(
        self,
        goal: str,
        dataset: str,
        plan: Plan | None,
        composed: ComposeResult | None,
        *,
        attempts: list[Attempt] | None = None,
        error: str | None = None,
        candidates: list[str] | None = None,
        tokens: int = 0,
        model: str | None = None,
    ) -> dict[str, Any]:
        ok = composed is not None and composed.ok and composed.script is not None
        proposal_id = uuid.uuid4().hex[:16] if ok else None
        if ok and composed is not None and proposal_id is not None:
            with self._lock:
                self._proposals[proposal_id] = {"script": composed.script, "goal": goal, "dataset": dataset}
                while len(self._proposals) > MAX_PROPOSALS:
                    self._proposals.popitem(last=False)
        steps = [
            {
                "id": step.snippet.id,
                "title": step.snippet.title,
                "category": step.snippet.category,
                "auto": step.auto,
                "params": {k: v for k, v in step.values.items() if v != step.snippet.params[k].default},
            }
            for step in (composed.steps if composed else [])
        ]
        errors = composed.errors if composed else []
        return {
            "proposal_id": proposal_id,
            "ok": ok,
            "error": None if ok else (error or (errors[0] if errors else "planning failed")),
            "errors": errors,
            "attempts": [
                {
                    "errors": a.errors,
                    "prompt_tokens": a.prompt_tokens,
                    "completion_tokens": a.completion_tokens,
                    "cached": a.cached,
                }
                for a in attempts or []
            ],  # fmt: skip
            "tokens_spent": tokens,
            "model": model,
            "goal": goal,
            "dataset": dataset,
            "plan": plan.model_dump(by_alias=True) if plan else None,
            "steps": steps,
            "adjustments": composed.adjustments if composed else [],
            "script": composed.script if composed else None,
            "candidates": candidates or [],
            "suggested_file": f"generated/{_slug(goal)}.py",
        }

    def save(self, proposal_id: str, file: str, overwrite: bool) -> dict[str, Any]:
        with self._lock:
            proposal = self._proposals.get(proposal_id)
        if proposal is None:
            raise ServiceError(
                404, "PROPOSAL_EXPIRED", "this plan is no longer available; ask or recompose again"
            )
        if not file.endswith(".py"):
            raise ServiceError(400, "UNSUPPORTED_FILE", "save the script as a .py file")
        try:
            path = self.project.resolve(file)
        except PathError as exc:
            raise ServiceError(403, "PATH_OUTSIDE_ROOT", str(exc)) from exc
        existed = path.exists()
        if existed and not overwrite:
            raise ServiceError(409, "FILE_EXISTS", f"{file} already exists")
        path.parent.mkdir(parents=True, exist_ok=True)
        relative = self.project.relative(path)
        self.project.write_atomic(relative, str(proposal["script"]))
        self.hub.publish(
            {"type": "file_changed", "file": relative,
             "data": {"kind": "modified" if existed else "added", "origin": "flowlab"}}
        )  # fmt: skip
        return {"file": relative}

    def snippets(self, query: str | None, dataset: str | None, k: int = 12) -> list[dict[str, Any]]:
        library = self.library
        digest = self._dataset(dataset)[1] if dataset else None
        if query and query.strip():
            found = SnippetIndex(library).search(query, digest=digest, k=k)
            chosen = [snippet for snippet, _ in found]
        else:
            chosen = [snippet for snippet in library if not snippet.auto]
        return [
            {"id": s.id, "title": s.title, "category": s.category, "description": s.description,
             "signature": s.signature()}
            for s in chosen
        ]  # fmt: skip
