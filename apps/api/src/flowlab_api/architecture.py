"""Architecture view on the local server: run the code segregation pipeline for the open project.

The deterministic analysis is free and local. Naming with a model sends only cluster
fingerprints (unit names, kinds, truncated signatures, first docstring lines, import names and
edge counts — never bodies, tests or data), so like the Ask panel it requires explicit consent.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import threading
from collections import Counter
from pathlib import Path
from typing import Any

from flowlab_agent import GroqClient, LLMClient, Message, load_api_key
from flowlab_lab.project import LabProject
from flowlab_lab.segregation import SegregationError, SegregationOptions, analyse
from flowlab_lab.segregation.llm import Completion

from .agent import ClientFactory
from .service import EventHub, ServiceError

SENT_TO_LLM = (
    "unit names and kinds, signatures cut to 100 characters, first docstring lines, imported library names "
    "and edge counts; never function bodies, tests, data or notebook outputs, and credentials are masked"
)


class AgentCompleter:
    """Adapts a flowlab_agent chat client (temperature 0, JSON mode) to the segregation Completer."""

    def __init__(self, client: LLMClient) -> None:
        self.client = client
        self.model = client.model

    def complete(self, messages: list[dict[str, str]], *, max_tokens: int) -> Completion:
        response = self.client.complete(
            [Message(m["role"], m["content"]) for m in messages],  # type: ignore[arg-type]
            max_tokens=max_tokens,
            json_mode=True,
        )
        return Completion(response.text, response.prompt_tokens, response.completion_tokens)


def _anonymise(value: str) -> str:
    return "h_" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:10]


class ArchitectureService:
    def __init__(
        self, project: LabProject, hub: EventHub, client_factory: ClientFactory | None = None
    ) -> None:
        self.project = project
        self.hub = hub
        self._factory = client_factory
        self._lock = threading.Lock()
        self._running = False

    @property
    def directory(self) -> Path:
        return self.project.state_dir / "architecture"

    def latest(self) -> dict[str, Any]:
        path = self.directory / "manifest.json"
        if not path.is_file():
            raise ServiceError(404, "NO_ARCHITECTURE", "this project has not been analysed yet")
        data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
        return data

    def analyse(
        self, *, use_llm: bool, confirm_external: bool, max_tokens: int, allow_over_budget: bool
    ) -> dict[str, Any]:
        if use_llm and not confirm_external:
            raise ServiceError(
                428, "CONSENT_REQUIRED", f"naming with a model sends {SENT_TO_LLM}; confirm to continue"
            )
        with self._lock:
            if self._running:
                raise ServiceError(409, "ANALYSIS_RUNNING", "an analysis of this project is already running")
            self._running = True
        try:
            completer = None
            if use_llm:
                if self._factory is not None:
                    client: LLMClient = self._factory(None)
                else:
                    key = load_api_key(search=[self.project.root, Path.cwd()])
                    if not key:
                        raise ServiceError(
                            412,
                            "NO_API_KEY",
                            "GROQ_API_KEY is not set: add it to .env in the project folder or export it",
                        )
                    client = GroqClient(key)
                completer = AgentCompleter(client)
            options = SegregationOptions(
                use_git=True, use_llm=use_llm, max_tokens=max_tokens, allow_over_budget=allow_over_budget
            )
            try:
                manifest = analyse(self.project.root, options, completer=completer).manifest
            except SegregationError as exc:
                raise ServiceError(
                    422, "SEGREGATION_INVALID", str(exc), {"problems": exc.problems[:20]}
                ) from exc
        finally:
            with self._lock:
                self._running = False
        text = manifest.to_json()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.project.write_atomic(self.project.relative(self.directory / "manifest.json"), text)
        self.hub.publish(
            {
                "type": "architecture_ready",
                "file": None,
                "data": {
                    "components": len(manifest.components),
                    "findings": len(manifest.findings),
                    "llm": manifest.llm.status,
                },
            }
        )
        result: dict[str, Any] = json.loads(text)
        return result

    def feedback(self, component_id: str | None, unit_id: str | None, correction: str) -> dict[str, Any]:
        """SEG-100: keep the user's correction with an anonymised fingerprint, on this machine only."""
        manifest = self.latest()
        units = {u["id"]: u for u in manifest["units"]}
        components = {c["id"]: c for c in manifest["components"]}
        if component_id is None and unit_id is None:
            raise ServiceError(422, "NOTHING_TO_REPORT", "name the component or unit that is wrong")
        if component_id is not None and component_id not in components:
            raise ServiceError(404, "UNKNOWN_COMPONENT", f"{component_id} is not in the latest analysis")
        if unit_id is not None and unit_id not in units:
            raise ServiceError(404, "UNKNOWN_UNIT", f"{unit_id} is not in the latest analysis")
        component = components.get(component_id or units.get(unit_id or "", {}).get("component_id") or "")
        members = [units[u] for u in (component["units"] if component else [unit_id])]
        fingerprint = {
            "archetype": component["archetype"] if component else None,
            "decided_by": component["decided_by"] if component else None,
            "unit_count": len(members),
            "sloc": sum(u["sloc"] for u in members),
            "kinds": dict(Counter(u["kind"] for u in members)),
            "units": [
                {
                    "name": _anonymise(u["name"]),
                    "kind": u["kind"],
                    "signature_shape": re.sub(r"[A-Za-z_][A-Za-z0-9_]*", "x", u.get("signature") or "")[:100],
                    "side_effects": u["side_effects"],
                }
                for u in members[:12]
            ],
            "files": sorted({_anonymise(u["file"]) for u in members}),
            "target_unit": _anonymise(units[unit_id]["name"]) if unit_id else None,
        }
        entry = {
            "ts": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
            "manifest_version": manifest["manifest_version"],
            "commit": manifest.get("commit"),
            "correction": correction.strip()[:1000],
            "fingerprint": fingerprint,
        }
        self.directory.mkdir(parents=True, exist_ok=True)
        path = self.directory / "feedback.jsonl"
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return {"stored": True, "path": self.project.relative(path)}
