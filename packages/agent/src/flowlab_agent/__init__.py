"""FlowLab agent: goal -> snippet plan (LLM) -> validated, composed script (local)."""

from .composer import ComposedStep, ComposeResult, Plan, PlanStep, compose, render_script
from .digest import DatasetDigest
from .llm import (
    CachedClient,
    GroqClient,
    LLMClient,
    LLMError,
    LLMResponse,
    Message,
    ScriptedClient,
    UsageLog,
    load_api_key,
)
from .planner import PlanResult, build_messages, parse_plan, plan_goal
from .retrieval import SnippetIndex
from .snippets import LIBRARY_DIR, ParamSpec, Snippet, SnippetLibrary

__all__ = [
    "LIBRARY_DIR",
    "CachedClient",
    "ComposeResult",
    "ComposedStep",
    "DatasetDigest",
    "GroqClient",
    "LLMClient",
    "LLMError",
    "LLMResponse",
    "Message",
    "ParamSpec",
    "Plan",
    "PlanResult",
    "PlanStep",
    "ScriptedClient",
    "Snippet",
    "SnippetIndex",
    "SnippetLibrary",
    "UsageLog",
    "build_messages",
    "compose",
    "load_api_key",
    "parse_plan",
    "plan_goal",
    "render_script",
]
