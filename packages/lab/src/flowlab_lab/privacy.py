"""What crosses the network (PRD II 4.3, 12).

* Code text is sent so the editor can render it, with obvious credentials masked first.
* Summaries (shape, dtypes, nulls, memory, min/max) are sent; data rows never are.
* Preview rows are sent only on explicit request, capped at 100, and never in Local-only mode.

These builders are the only place outbound payloads are assembled, so privacy is testable.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, Field

from .codegraph import CodeGraph

MASK = "«masked:{kind}»"

SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "private_key",
        re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S),
    ),
    ("anthropic_key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}")),
    ("openai_key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}")),
    ("groq_key", re.compile(r"\bgsk_[A-Za-z0-9]{20,}")),
    ("aws_access_key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}")),
    ("google_oauth_secret", re.compile(r"\bGOCSPX-[A-Za-z0-9_-]{20,}")),
    ("slack_token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("stripe_key", re.compile(r"\b[sr]k_live_[A-Za-z0-9]{20,}")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")),
    ("url_credentials", re.compile(r"(?<=://)[^/\s:@]+:[^/\s@]+(?=@)")),
)
_ASSIGNED_SECRET = re.compile(
    r"""(?ix)
    \b[a-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)[a-z0-9_]*
    \s*[:=]\s*(?P<quote>['"])(?P<value>[^'"\n]{6,})(?P=quote)
    """
)


@dataclass(frozen=True)
class SecretFinding:
    kind: str
    line: int


def mask_secrets(text: str) -> tuple[str, list[SecretFinding]]:
    """Mask credential-looking values. Returns the masked text and what was found (never the values)."""
    spans: list[tuple[int, int, str]] = []
    for kind, pattern in SECRET_PATTERNS:
        for match in pattern.finditer(text):
            if not any(start <= match.start() < end for start, end, _ in spans):
                spans.append((match.start(), match.end(), kind))
    for match in _ASSIGNED_SECRET.finditer(text):
        start, end = match.span("value")
        if not any(s <= start < e for s, e, _ in spans) and "«masked:" not in match.group("value"):
            spans.append((start, end, "assigned_secret"))
    findings = [SecretFinding(kind, text.count("\n", 0, start) + 1) for start, _, kind in sorted(spans)]
    masked = text
    for start, end, kind in sorted(spans, reverse=True):
        masked = masked[:start] + MASK.format(kind=kind) + masked[end:]
    return masked, findings


class OutboundPolicy(BaseModel):
    local_only: bool = True
    max_preview_rows: int = Field(100, ge=0, le=100)


class LocalOnlyError(PermissionError):
    """Raised when something would send data rows off the machine in Local-only mode."""


def transmission_badge(policy: OutboundPolicy) -> str:
    sent = (
        "code (credentials masked), graph structure, summaries (shape, dtypes, nulls, memory, min/max), logs"
    )
    if policy.local_only:
        return f"Local-only · sending {sent} · never data rows"
    return f"Sending {sent} · preview rows only when you open one (max {policy.max_preview_rows})"


def graph_payload(graph: CodeGraph) -> dict[str, Any]:
    payload = graph.model_dump(mode="json", by_alias=True)
    findings = 0
    for node in payload["nodes"]:
        node["source"], found = mask_secrets(node.get("source", ""))
        findings += len(found)
    payload["secrets_masked"] = findings
    return payload


def summary_payload(summary: dict[str, Any]) -> dict[str, Any]:
    """Structural summary only: every sample/row field is dropped."""
    return {k: v for k, v in summary.items() if k not in ("sample", "repr", "params")}


def execution_payload(record: Any, summaries: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    data: dict[str, Any] = record.model_dump(mode="json")
    for key in ("stdout", "stderr"):
        data[key] = mask_secrets(data.get(key, ""))[0]
    data["outputs"] = [mask_secrets(text)[0] for text in data.get("outputs", [])]
    if data.get("error"):
        data["error"]["evalue"] = mask_secrets(data["error"].get("evalue", ""))[0]
        data["error"]["traceback"] = [mask_secrets(line)[0] for line in data["error"].get("traceback", [])]
    data["summaries"] = {name: summary_payload(s) for name, s in (summaries or {}).items()}
    return data


def preview_payload(summary: dict[str, Any], policy: OutboundPolicy) -> dict[str, Any]:
    """Rows for a node the user clicked. Refused outright in Local-only mode."""
    if policy.local_only:
        raise LocalOnlyError("Local-only mode is on: preview rows never leave this machine")
    payload = summary_payload(summary)
    sample = summary.get("sample")
    limit = policy.max_preview_rows
    if isinstance(sample, dict) and isinstance(sample.get("data"), list):
        capped = dict(sample)
        capped["data"] = sample["data"][:limit]
        if isinstance(sample.get("index"), list):
            capped["index"] = sample["index"][:limit]
        payload["preview"] = capped
    elif isinstance(sample, list):
        payload["preview"] = sample[:limit]
    return payload


def first_open_warning(graph: CodeGraph) -> str | None:
    """PRD II 12: warn on first project open when the code contains credential-looking values."""
    locations = [
        f"{node.id} line {finding.line} ({finding.kind})"
        for node in graph.code_nodes()
        for finding in mask_secrets(node.source)[1]
    ]
    if not locations:
        return None
    return (
        "This code contains values that look like credentials: "
        + ", ".join(locations[:10])
        + ". They are masked before code is sent, but consider moving them to environment variables."
    )
