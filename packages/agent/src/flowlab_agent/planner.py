"""Goal -> snippet plan -> script, with a short structured repair loop (PRD 10.4)."""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from pydantic import ValidationError

from .composer import ComposeResult, Plan, compose
from .digest import DatasetDigest
from .llm import LLMClient, LLMError, Message, UsageLog
from .retrieval import SnippetIndex
from .snippets import SnippetLibrary

SYSTEM_PROMPT = """You assemble data-analysis scripts from a fixed snippet catalogue. You never write code.
Reply with JSON only, in this shape:
{"target": "<column to predict, or null>", "steps": [{"use": "<snippet id>", "with": {"<param>": <value>}}], "note": "<one short sentence>"}
Rules:
- Use only snippet ids listed under SNIPPETS and only column names listed under DATA.
- Params marked ? are optional; omit any param that should keep its default (=value).
- Loading the file, the train/test split, numeric preparation and predictions are added automatically when a step needs them. List only the steps that serve the goal.
- Set "target" whenever the goal involves predicting or explaining a column."""

REPAIR_PROMPT = "Your JSON had these problems:\n{errors}\nReturn the corrected full JSON only."
MAX_TOKENS = 700


@dataclass
class Attempt:
    reply: str
    errors: list[str]
    prompt_tokens: int
    completion_tokens: int
    cached: bool


@dataclass
class PlanResult:
    candidates: list[str]
    attempts: list[Attempt] = field(default_factory=list)
    plan: Plan | None = None
    composed: ComposeResult | None = None
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.composed is not None and self.composed.ok

    @property
    def tokens_spent(self) -> int:
        return sum(a.prompt_tokens + a.completion_tokens for a in self.attempts if not a.cached)


def build_messages(goal: str, digest: DatasetDigest, signatures: list[str]) -> list[Message]:
    user = f"GOAL: {' '.join(goal.split())}\nDATA: {digest.text()}\nSNIPPETS:\n" + "\n".join(signatures)
    return [Message("system", SYSTEM_PROMPT), Message("user", user)]


def parse_plan(text: str) -> tuple[Plan | None, list[str]]:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        return None, ["the reply was not a JSON object"]
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError as exc:
        return None, [f"invalid JSON: {exc.msg}"]
    try:
        plan = Plan.model_validate(data)
    except ValidationError as exc:
        return None, [f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()[:5]]
    if not plan.steps:
        return None, ["steps is empty"]
    return plan, []


def plan_goal(
    goal: str,
    digest: DatasetDigest,
    client: LLMClient,
    library: SnippetLibrary,
    *,
    k: int = 12,
    max_repairs: int = 2,
    seed: int = 42,
    usage_log: UsageLog | None = None,
) -> PlanResult:
    candidates = SnippetIndex(library).search(goal, digest=digest, k=k)
    result = PlanResult(candidates=[s.id for s, _ in candidates])
    messages = build_messages(goal, digest, [s.signature() for s, _ in candidates])

    for attempt_number in range(max_repairs + 1):
        try:
            response = client.complete(messages, max_tokens=MAX_TOKENS, json_mode=True)
        except LLMError as exc:
            result.error = str(exc)
            return result
        if usage_log is not None:
            usage_log.record(response, "plan" if attempt_number == 0 else "repair")
        plan, errors = parse_plan(response.text)
        composed = None
        if plan is not None:
            composed = compose(plan, library, digest, goal=goal, seed=seed)
            errors = composed.errors
        result.attempts.append(
            Attempt(
                response.text, errors, response.prompt_tokens, response.completion_tokens, response.cached
            )
        )
        result.plan, result.composed = plan, composed
        if not errors:
            return result
        messages = [
            *messages,
            Message("assistant", response.text),
            Message("user", REPAIR_PROMPT.format(errors="\n".join(f"- {e}" for e in errors[:8]))),
        ]
    result.error = "the plan still had problems after repair attempts"
    return result
