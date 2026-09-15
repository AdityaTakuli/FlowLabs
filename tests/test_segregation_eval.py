"""SEG-098 labelled-architecture scores on the fixture repos used by the analyser tests."""

from __future__ import annotations

from pathlib import Path

from flowlab_lab.segregation import SegregationOptions, analyse_architecture
from flowlab_lab.segregation.eval import Labels, aggregate, meets_targets, pairwise_f1, score
from test_segregation import BACKEND_REPO, ML_REPO, NOTEBOOK, write

NO_GIT = SegregationOptions(use_git=False)

ML_LABELS = Labels(
    groups={
        "load_customers": "ingestion",
        "drop_bad_rows": "cleaning",
        "fill_missing": "cleaning",
        "normalise_types": "cleaning",
        "encode_categoricals": "features",
        "scale_all": "features",
        "add_ratios": "features",
        "build_features": "features",
        "split_data": "splitting",
        "train_model": "training",
        "train_quick": "training",
        "evaluate": "evaluation",
        "report": "evaluation",
        "legacy_export": "__unassigned__",
    },
    archetypes={
        "load_customers": "ingestion",
        "drop_bad_rows": "cleaning",
        "encode_categoricals": "feature_engineering",
        "split_data": "splitting",
        "train_model": "training",
        "evaluate": "evaluation",
    },
    leaks={"scale_all", "cell 4"},
)

BACKEND_LABELS = Labels(
    groups={
        "app.routes.users.get_user": "routing",
        "app.routes.users.list_users": "routing",
        "app.routes.users.create_user": "routing",
        "app.controllers.user_controller.show": "controller",
        "app.controllers.user_controller.index": "controller",
        "app.controllers.user_controller.create": "controller",
        "app.services.user_service.fetch_user": "service",
        "app.services.user_service.list_users": "service",
        "app.services.user_service.register_user": "service",
        "app.repositories.user_repository.find": "repository",
        "app.repositories.user_repository.find_all": "repository",
        "app.repositories.user_repository.save": "repository",
        "UserIn": "schema",
        "settings": "configuration",
    },
    archetypes={
        "app.routes.users.get_user": "routing",
        "app.controllers.user_controller.show": "controller",
        "app.services.user_service.fetch_user": "service",
        "app.repositories.user_repository.find": "repository",
        "UserIn": "schema",
        "settings": "configuration",
    },
)


def test_pairwise_f1_is_symmetric() -> None:
    assert pairwise_f1({"a": "1", "b": "1", "c": "2"}, {"a": "x", "b": "x", "c": "y"}) == 1.0
    assert pairwise_f1({"a": "1", "b": "1", "c": "2"}, {"a": "x", "b": "y", "c": "y"}) == 0.0


def test_ml_fixture_meets_segregation_targets(tmp_path: Path) -> None:
    root = write(tmp_path / "ml", ML_REPO)
    (root / "analysis.ipynb").write_text(__import__("json").dumps(NOTEBOOK))
    result = analyse_architecture(root, NO_GIT)
    scored = score(result, ML_LABELS)
    assert scored.units_scored >= 12
    assert meets_targets(scored) == [], scored.as_dict()
    assert scored.leakage_recall == 1.0  # SEG-099


def test_backend_fixture_meets_segregation_targets(tmp_path: Path) -> None:
    result = analyse_architecture(write(tmp_path / "svc", BACKEND_REPO), NO_GIT)
    scored = score(result, BACKEND_LABELS)
    assert scored.units_scored >= 12
    assert meets_targets(scored) == [], scored.as_dict()


def test_aggregate_averages_cases(tmp_path: Path) -> None:
    ml = write(tmp_path / "ml", {k: v for k, v in ML_REPO.items() if not k.endswith(".ipynb")})
    (ml / "analysis.ipynb").write_text(__import__("json").dumps(NOTEBOOK))
    scores = [
        score(analyse_architecture(ml, NO_GIT), ML_LABELS),
        score(analyse_architecture(write(tmp_path / "svc", BACKEND_REPO), NO_GIT), BACKEND_LABELS),
    ]
    summary = aggregate(scores)
    assert summary["cases"] == 2 and summary["banned_name_rate"] == 0
    assert summary["leakage_recall"] >= 0.95
