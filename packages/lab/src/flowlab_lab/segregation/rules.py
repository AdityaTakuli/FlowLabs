"""Stage 5 (rules part) — archetype evidence and layer ordering (SEG-038, §6).

Rules vote; they never guess silently. A Component is rule-decided only when one archetype
clearly dominates the votes of its Units; otherwise it is marked ambiguous for the LLM (or ships
with low confidence when no model is configured).
"""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

from .models import BACKEND_LAYERS, CROSS_CUTTING, ML_PIPELINE, SEPARATE_ARCHETYPES, Confidence, DecidedBy
from .parse import UnitInfo

NAME_HINTS: dict[str, str] = {
    **dict.fromkeys(["load", "read", "fetch", "ingest", "download", "loader", "loaders"], "ingestion"),
    **dict.fromkeys(["validate", "validation", "validators", "expect", "expectations"], "validation"),
    **dict.fromkeys(
        ["clean", "cleaning", "cleaner", "dedupe", "dedup", "impute", "fill", "sanitise", "sanitize"],
        "cleaning",
    ),
    **dict.fromkeys(
        ["feature", "features", "encode", "encoder", "encoders", "scale", "scaler", "engineer"],
        "feature_engineering",
    ),
    **dict.fromkeys(["split", "splitting", "splits", "fold", "folds"], "splitting"),
    **dict.fromkeys(["train", "training", "trainer"], "training"),
    **dict.fromkeys(["tune", "tuning", "tuner", "hyperparameter", "hyperparameters"], "tuning"),
    **dict.fromkeys(["evaluate", "evaluation", "metric", "metrics", "score", "scoring"], "evaluation"),
    **dict.fromkeys(["explain", "explainability", "shap", "importance", "attribution"], "explainability"),
    **dict.fromkeys(
        ["predict", "prediction", "predictions", "infer", "inference", "serve", "serving"], "inference"
    ),
    **dict.fromkeys(
        [
            "plot",
            "plots",
            "plotting",
            "chart",
            "charts",
            "draw",
            "viz",
            "visualize",
            "visualise",
            "figure",
            "figures",
        ],
        "visualization",
    ),
    **dict.fromkeys(["route", "routes", "router", "routers", "endpoint", "endpoints", "urls"], "routing"),
    **dict.fromkeys(["controller", "controllers", "view", "views", "handler", "handlers"], "controller"),
    **dict.fromkeys(["service", "services", "usecase", "usecases"], "service"),
    **dict.fromkeys(["repository", "repositories", "repo", "repos", "dao", "crud", "store"], "repository"),
    **dict.fromkeys(["entity", "entities", "domain"], "domain_model"),
    **dict.fromkeys(["schema", "schemas", "dto", "dtos", "serializer", "serializers"], "schema"),
    **dict.fromkeys(["middleware", "middlewares"], "middleware"),
    **dict.fromkeys(["auth", "login", "jwt", "permission", "permissions", "authenticate", "oauth"], "auth"),
    **dict.fromkeys(["client", "clients", "adapter", "adapters", "gateway"], "client_adapter"),
    **dict.fromkeys(["job", "jobs", "worker", "workers", "celery", "scheduler", "tasks"], "background_job"),
    **dict.fromkeys(
        ["pipeline", "pipelines", "dag", "dags", "orchestrate", "orchestration"], "orchestration"
    ),
    **dict.fromkeys(["save", "persist", "dump", "export", "storage", "artifacts"], "persistence"),
    **dict.fromkeys(["config", "configs", "settings", "constants", "conf"], "configuration"),
    **dict.fromkeys(["logging", "logger", "telemetry", "tracing", "monitoring"], "observability"),
    **dict.fromkeys(["cli", "__main__", "manage"], "entrypoint"),
}

CALL_HINTS: tuple[tuple[str, str, int], ...] = (
    ("sklearn.model_selection.GridSearchCV", "tuning", 3),
    ("sklearn.model_selection.RandomizedSearchCV", "tuning", 3),
    ("optuna.", "tuning", 3),
    ("hyperopt.", "tuning", 3),
    ("shap.", "explainability", 3),
    ("lime.", "explainability", 3),
    ("sklearn.inspection.", "explainability", 3),
    ("mlflow.", "experiment_tracking", 3),
    ("wandb.", "experiment_tracking", 3),
    ("neptune.", "experiment_tracking", 3),
    ("great_expectations.", "validation", 3),
    ("pandera.", "validation", 3),
    ("sqlalchemy.", "repository", 2),
    ("pymongo.", "repository", 2),
    ("psycopg2.", "repository", 2),
    ("jwt.", "auth", 3),
    ("passlib.", "auth", 3),
    ("authlib.", "auth", 3),
    ("fastapi.security.", "auth", 3),
    ("celery.", "background_job", 3),
    ("rq.", "background_job", 3),
    ("apscheduler.", "background_job", 3),
    ("airflow.", "orchestration", 3),
    ("prefect.", "orchestration", 3),
    ("dagster.", "orchestration", 3),
    ("luigi.", "orchestration", 3),
    ("click.", "entrypoint", 2),
    ("typer.", "entrypoint", 2),
    ("argparse.", "entrypoint", 2),
    ("fastapi.FastAPI", "entrypoint", 3),
    ("flask.Flask", "entrypoint", 3),
    ("uvicorn.run", "entrypoint", 3),
    ("prometheus_client.", "observability", 3),
    ("opentelemetry.", "observability", 3),
    ("sentry_sdk.", "observability", 3),
    ("logging.basicConfig", "observability", 2),
    ("structlog.", "observability", 2),
    ("dotenv.", "configuration", 2),
    ("os.getenv", "configuration", 1),
    ("os.environ", "configuration", 1),
    ("requests.", "client_adapter", 2),
    ("httpx.", "client_adapter", 2),
    ("aiohttp.", "client_adapter", 2),
    ("boto3.", "client_adapter", 2),
    ("grpc.", "client_adapter", 2),
    ("pandas.get_dummies", "feature_engineering", 2),
    ("pandas.cut", "feature_engineering", 1),
    ("pandas.qcut", "feature_engineering", 1),
    ("sklearn.feature_selection.", "feature_engineering", 2),
    ("fastapi.APIRouter", "routing", 2),
    ("flask.Blueprint", "routing", 2),
    ("starlette.middleware.", "middleware", 3),
    ("seaborn.", "visualization", 2),
    ("plotly.", "visualization", 2),
    ("altair.", "visualization", 2),
)
CLEANING_METHODS = frozenset(
    {
        "dropna",
        "fillna",
        "drop_duplicates",
        "astype",
        "interpolate",
        "to_datetime",
        "isna",
        "notna",
    }
)
DB_RECEIVERS = frozenset({"session", "db", "cursor", "conn", "connection", "engine"})
DB_METHODS = frozenset(
    {"query", "commit", "add", "execute", "fetchall", "fetchone", "delete", "merge", "scalars"}
)
EVENT_VOTES = {
    "split": ("splitting", 3),
    "transformer_fit": ("feature_engineering", 2),
    "model_fit": ("training", 3),
    "metric": ("evaluation", 2),
    "plot": ("visualization", 2),
    "read": ("ingestion", 2),
    "network": ("client_adapter", 1),
}


def tokens(text: str) -> list[str]:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    return [t for t in re.split(r"[^A-Za-z0-9]+", spaced.lower()) if t]


def unit_votes(info: UnitInfo) -> Counter[str]:
    votes: Counter[str] = Counter()
    unit = info.unit
    kinds = {e.kind for e in info.events}
    for kind in sorted(kinds):
        if kind in EVENT_VOTES:
            archetype, weight = EVENT_VOTES[kind]
            votes[archetype] += weight
    if "predict" in kinds and not kinds & {"model_fit", "metric"}:
        votes["inference"] += 2
    if "write" in kinds:
        artifact = any(
            c.name.startswith(("joblib.dump", "pickle.dump", "torch.save")) for c in info.call_sites
        )
        votes["persistence"] += 2 if artifact else 1
    cleaning = 0
    for call in info.call_sites:
        for prefix, archetype, weight in CALL_HINTS:
            if call.name.startswith(prefix):
                votes[archetype] += weight
                break
        last = call.name.rsplit(".", 1)[-1]
        if last in CLEANING_METHODS and cleaning < 3:
            votes["cleaning"] += 1
            cleaning += 1
        parts = call.name.split(".")
        if len(parts) >= 2 and parts[-2] in DB_RECEIVERS and last in DB_METHODS:
            votes["repository"] += 2
        if last == "add_middleware":
            votes["middleware"] += 3
    if unit.kind == "route_handler":
        votes["routing"] += 3
    if unit.kind == "config_block":
        votes["configuration"] += 4
    if unit.kind == "module_script" and info.has_main_guard:
        votes["entrypoint"] += 2
    for base in info.bases:
        last = base.rsplit(".", 1)[-1]
        if last in ("BaseSettings",):
            votes["configuration"] += 3
        elif last in ("BaseModel", "Schema", "TypedDict", "SQLModel"):
            votes["schema"] += 3
        elif last in ("BaseHTTPMiddleware",):
            votes["middleware"] += 3
        elif last in ("Enum", "IntEnum", "StrEnum"):
            votes["domain_model"] += 1
    record_decorators = ("dataclass", "attrs.define", "attr.s", "define")
    if (
        unit.kind == "class"
        and not info.events
        and any(d.split("(")[0].endswith(record_decorators) for d in unit.decorators)
    ):
        votes["domain_model"] += 2
    for decorator in unit.decorators:
        head = decorator.split("(")[0]
        if head.endswith((".middleware", "middleware")):
            votes["middleware"] += 3
        if head.endswith(("shared_task", ".task")) and "celery" in head:
            votes["background_job"] += 3
    names = tokens(unit.name)
    hits = 0
    for token in names:
        if token in NAME_HINTS and hits < 2:
            votes[NAME_HINTS[token]] += 1
            hits += 1
    path_hits = 0
    for part in Path(unit.file).with_suffix("").parts:
        hint = NAME_HINTS.get(part.lower())
        if hint and path_hits < 2:
            votes[hint] += 1
            path_hits += 1
    return votes


def dominant(votes: Counter[str], *, minimum: int = 2, share: float = 0.6) -> str | None:
    total = sum(votes.values())
    if not total:
        return None
    archetype, count = sorted(votes.items(), key=lambda item: (-item[1], item[0]))[0]
    return archetype if count >= minimum and count / total >= share else None


def classify(votes: Counter[str], dependents: int) -> tuple[str, DecidedBy, Confidence, bool]:
    """Returns (archetype, decided_by, confidence, ambiguous)."""
    total = sum(votes.values())
    if total:
        archetype, count = sorted(votes.items(), key=lambda item: (-item[1], item[0]))[0]
        share = count / total
        if count >= 3 and share >= 0.5:
            return archetype, "rule", "high" if share >= 0.7 else "medium", False
        return archetype, "rule", "low", True
    return ("utility" if dependents >= 3 else "service"), "cluster", "low", True


def is_separate(archetype: str | None) -> bool:
    return archetype is not None and archetype in SEPARATE_ARCHETYPES


def layer_problem(dependent: str, dependency: str) -> str | None:
    """SEG-046 / §6.3. Returns why `dependent` may not depend on `dependency`, or None when allowed."""
    if dependent in CROSS_CUTTING and dependency not in CROSS_CUTTING:
        return f"cross-cutting {dependent} must not depend on {dependency}"
    if dependent == "inference" and dependency == "training":
        return (
            "inference must not depend on training; share preprocessing through feature engineering (SEG-055)"
        )
    if dependent in ML_PIPELINE and dependency in ML_PIPELINE:
        if ML_PIPELINE.index(dependency) > ML_PIPELINE.index(dependent):
            return f"{dependent} depends on later pipeline stage {dependency}"
        return None
    both_backend = dependent in BACKEND_LAYERS and dependency in BACKEND_LAYERS
    if both_backend and BACKEND_LAYERS.index(dependency) < BACKEND_LAYERS.index(dependent):
        return f"{dependent} depends on higher layer {dependency}"
    return None
