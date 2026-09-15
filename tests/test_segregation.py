"""Code Segregation Bylaws: deterministic stages 0–3 and 7 on generated fixture repositories."""

from __future__ import annotations

import json
import textwrap
from pathlib import Path

import pytest
from flowlab_lab.segregation import BANNED_NAMES, Manifest, SegregationOptions, analyse, analyse_architecture
from flowlab_lab.segregation.inventory import inventory
from flowlab_lab.segregation.models import ARCHETYPES
from flowlab_lab.segregation.validate import structural_violations

NO_GIT = SegregationOptions(use_git=False)


def write(root: Path, files: dict[str, str]) -> Path:
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(content).lstrip())
    return root


ML_REPO = {
    "data/loader.py": """
        import pandas as pd

        def load_customers(path):
            \"\"\"Read the raw customer table.
            More detail that must never be carried forward.\"\"\"
            return pd.read_csv(path)

        def load_orders(path):
            return pd.read_parquet(path)

        def load_regions(path):
            return pd.read_json(path)
    """,
    "cleaning/clean.py": """
        def drop_bad_rows(df):
            return df.dropna(subset=["customer_id"]).drop_duplicates()

        def fill_missing(df):
            return df.fillna({"tenure": 0})

        def normalise_types(df):
            return df.astype({"tenure": "int64"})
    """,
    "features/encoders.py": """
        import pandas as pd
        from sklearn.preprocessing import StandardScaler

        def encode_categoricals(df):
            return pd.get_dummies(df, columns=["plan"])

        def scale_all(df):
            scaler = StandardScaler()
            return scaler.fit_transform(df)

        def add_ratios(df):
            return df.assign(ratio=df["spend"] / df["tenure"])
    """,
    "features/build.py": """
        from features.encoders import add_ratios, encode_categoricals, scale_all

        def build_features(df):
            encoded = encode_categoricals(df)
            with_ratios = add_ratios(encoded)
            return scale_all(with_ratios)
    """,
    "training/split.py": """
        from sklearn.model_selection import train_test_split

        def split_data(features, target):
            return train_test_split(features, target, test_size=0.2, random_state=42)

        def stratify_labels(target):
            return target.astype("category")

        def holdout_size(features):
            return len(features) // 5
    """,
    "training/train.py": """
        from sklearn.ensemble import RandomForestClassifier

        def make_model():
            return RandomForestClassifier(n_estimators=200, max_depth=6)

        def train_model(features, target):
            model = make_model()
            model.fit(features, target)
            return model

        def train_quick(features, target):
            return train_model(features, target)
    """,
    "evaluation/metrics.py": """
        from sklearn.metrics import accuracy_score, f1_score

        def evaluate(model, features, target):
            predictions = model.predict(features)
            return {"accuracy": accuracy_score(target, predictions), "f1": f1_score(target, predictions)}

        def report(model, features, target):
            scores = evaluate(model, features, target)
            print(scores)
            return scores

        def fit_and_score(model, features, target):
            model.fit(features, target)
            return accuracy_score(target, model.predict(features))
    """,
    "pipeline.py": """
        from cleaning.clean import drop_bad_rows, fill_missing, normalise_types
        from data.loader import load_customers
        from evaluation.metrics import report
        from features.build import build_features
        from training.split import split_data
        from training.train import train_model

        def main():
            raw = load_customers("data/customers.csv")
            cleaned = normalise_types(fill_missing(drop_bad_rows(raw)))
            features = build_features(cleaned)
            x_train, x_test, y_train, y_test = split_data(features, cleaned["churned"])
            model = train_model(x_train, y_train)
            report(model, x_test, y_test)

        if __name__ == "__main__":
            main()
    """,
    "legacy.py": """
        def legacy_export(frame):
            return frame.to_dict()
    """,
    "tests/test_clean.py": """
        from cleaning.clean import drop_bad_rows

        def test_drop_bad_rows():
            assert drop_bad_rows is not None
            drop_bad_rows(None)
    """,
    ".venv/lib/site.py": "def ignored(): pass\n",
    "node_modules/pkg/x.py": "def ignored(): pass\n",
    "migrations/0001_initial.py": "def upgrade(): pass\n",
    "api_pb2.py": "X = 1\n",
    "secret_stuff/private.py": "def hidden(): pass\n",
    ".gitignore": "secret_stuff/\n",
    "broken.py": "def oops(:\n",
}

NOTEBOOK = {
    "cells": [
        {"cell_type": "code", "source": ["import pandas as pd\n", "df = pd.read_csv('data/x.csv')"], "metadata": {}, "outputs": [], "execution_count": None},
        {"cell_type": "markdown", "source": ["# Clean"], "metadata": {}},
        {"cell_type": "code", "source": ["%matplotlib inline\n", "df = df.dropna()"], "metadata": {}, "outputs": [], "execution_count": None},
        {"cell_type": "code", "source": ["from sklearn.preprocessing import StandardScaler\n", "X = StandardScaler().fit_transform(df)"], "metadata": {}, "outputs": [], "execution_count": None},
        {"cell_type": "code", "source": ["from sklearn.model_selection import train_test_split\n", "X_train, X_test = train_test_split(X, test_size=0.25)"], "metadata": {}, "outputs": [], "execution_count": None},
    ],
    "metadata": {}, "nbformat": 4, "nbformat_minor": 5,
}  # fmt: skip

BACKEND_REPO = {
    "app/main.py": """
        from fastapi import FastAPI
        from app.routes.users import router

        app = FastAPI()
        app.include_router(router)
    """,
    "app/routes/users.py": """
        from fastapi import APIRouter
        from app.controllers import user_controller
        from app.schemas.user import UserIn

        router = APIRouter()

        @router.get("/users/{user_id}")
        def get_user(user_id: int):
            return user_controller.show(user_id)

        @router.get("/users")
        def list_users():
            return user_controller.index()

        @router.post("/users")
        def create_user(payload: UserIn):
            name = payload.name.strip()
            if not name:
                raise ValueError("name required")
            email = payload.email.lower()
            if "@" not in email:
                raise ValueError("bad email")
            parts = email.split("@")
            domain = parts[1]
            if domain.endswith(".invalid"):
                raise ValueError("bad domain")
            nickname = name.split(" ")[0]
            if len(nickname) > 20:
                nickname = nickname[:20]
            record = {"name": name, "email": email, "nickname": nickname}
            if payload.admin:
                record["role"] = "admin"
            else:
                record["role"] = "member"
            record["domain"] = domain
            record["active"] = True
            record["source"] = "api"
            return user_controller.create(record)
    """,
    "app/controllers/user_controller.py": """
        from app.services import user_service

        def show(user_id):
            return user_service.fetch_user(user_id)

        def index():
            return user_service.list_users()

        def create(record):
            return user_service.register_user(record)
    """,
    "app/services/user_service.py": """
        from app.repositories import user_repository

        def fetch_user(user_id):
            return user_repository.find(user_id)

        def list_users():
            return user_repository.find_all()

        def register_user(record):
            return user_repository.save(record)

        def notify(user):
            return {"notified": user}
    """,
    "app/repositories/user_repository.py": """
        from app.db import session
        from app.services.user_service import notify

        def find(user_id):
            return session.query(user_id)

        def find_all():
            return session.query(None)

        def save(record):
            session.add(record)
            session.commit()
            return notify(record)
    """,
    "app/db.py": """
        session = None
    """,
    "app/schemas/user.py": """
        from pydantic import BaseModel

        class UserIn(BaseModel):
            name: str
            email: str
            admin: bool = False
    """,
    "app/settings.py": """
        DATABASE_URL = "sqlite:///local.db"
        PAGE_SIZE = 50
    """,
}


@pytest.fixture
def ml_repo(tmp_path: Path) -> Path:
    root = write(tmp_path / "ml", ML_REPO)
    (root / "analysis.ipynb").write_text(json.dumps(NOTEBOOK))
    return root


@pytest.fixture
def ml(ml_repo: Path) -> Manifest:
    return analyse_architecture(ml_repo, NO_GIT)


def units_named(manifest: Manifest, *names: str) -> list[str]:
    by_name = {u.name: u.id for u in manifest.units}
    return [by_name[n] for n in names]


def component_of(manifest: Manifest, name: str) -> str:
    return next(u.component_id or "__unassigned__" for u in manifest.units if u.name == name)


def test_inventory_filters_and_roles(ml_repo: Path) -> None:
    records = {s.record.path: s.record for s in inventory(ml_repo)}
    assert ".venv/lib/site.py" not in records and "node_modules/pkg/x.py" not in records
    assert "api_pb2.py" not in records and "secret_stuff/private.py" not in records  # generated, .gitignore
    assert records["migrations/0001_initial.py"].role == "migration"
    assert records["tests/test_clean.py"].role == "test"
    assert records["analysis.ipynb"].language == "notebook"
    loader = records["data/loader.py"]
    assert loader.loc > loader.sloc > 0 and loader.content_hash.startswith("sha256:")


def test_units_are_extracted_with_spans_and_evidence(ml: Manifest) -> None:
    by_name = {u.name: u for u in ml.units}
    load = by_name["load_customers"]
    assert load.kind == "function" and load.signature == "(path)"
    assert load.docstring_first_line == "Read the raw customer table."  # SEG-026: first line only
    assert load.side_effects == ["io"] and load.file == "data/loader.py" and load.line_start == 3
    assert by_name["pipeline script"].kind == "module_script" and by_name["pipeline script"].entry_point
    assert {u.kind for u in ml.units if u.file == "analysis.ipynb"} == {"cell_block"}
    assert len([u for u in ml.units if u.file == "analysis.ipynb"]) == 4  # markdown cell skipped
    assert not any(u.file.startswith(("tests/", "migrations/")) for u in ml.units)  # SEG-022, SEG-021
    assert by_name["drop_bad_rows"].tests == ["tests.test_clean.test_drop_bad_rows"]  # shadow map
    parse_errors = [f for f in ml.findings if f.code == "PARSE_ERROR"]
    assert [f.file for f in parse_errors] == ["broken.py"]  # recorded, run not aborted


def test_every_unit_placed_once_and_output_valid(ml: Manifest) -> None:
    assert structural_violations(ml) == []
    placed = [u for c in ml.components for u in c.units] + ml.unassigned
    assert sorted(placed) == sorted(u.id for u in ml.units)
    assert all(c.archetype in ARCHETYPES for c in ml.components)
    assert not {c.name for c in ml.components} & BANNED_NAMES
    assert all(c.spans and c.files for c in ml.components)
    assert ml.llm.status == "skipped" and all(c.name.startswith("cluster_") for c in ml.components)


def test_pipeline_stages_are_separate_components(ml: Manifest) -> None:
    split = component_of(ml, "split_data")
    train = component_of(ml, "train_model")
    evaluate = component_of(ml, "evaluate")
    clean = component_of(ml, "drop_bad_rows")
    load = component_of(ml, "load_customers")
    assert len({split, train, evaluate, clean, load}) == 5  # SEG-052
    by_id = {c.id: c for c in ml.components}
    assert by_id[split].archetype == "splitting"
    assert by_id[train].archetype == "training"
    assert by_id[evaluate].archetype == "evaluation"
    assert by_id[clean].archetype == "cleaning"
    assert by_id[load].archetype == "ingestion"
    assert component_of(ml, "fill_missing") == clean and component_of(ml, "normalise_types") == clean


def test_leakage_is_found_in_functions_and_notebooks(ml: Manifest) -> None:
    leaks = [f for f in ml.findings if f.code == "LEAKAGE_FIT_BEFORE_SPLIT"]
    assert all(f.severity == "error" and f.law == "SEG-053" for f in leaks)
    files = {(f.file, f.line) for f in leaks}
    assert ("features/encoders.py", 9) in files
    assert any(f.file == "analysis.ipynb" for f in leaks)
    function_leak = next(f for f in leaks if f.file == "features/encoders.py")
    assert "StandardScaler is fitted at features/encoders.py:9" in function_leak.message
    assert "training/split.py:4" in function_leak.message
    assert len(leaks) == 2


def test_other_ml_findings(ml: Manifest) -> None:
    codes = {f.code: f for f in ml.findings}
    assert codes["TRAINING_EVALUATION_MIXED"].unit_id == units_named(ml, "fit_and_score")[0]
    config = codes["INLINE_CONFIGURATION"].message
    assert "n_estimators=200 at training/train.py:4" in config and "'data/customers.csv'" in config
    dead = codes["DEAD_CODE"]
    assert units_named(ml, "legacy_export")[0] in dead.unit_ids
    assert units_named(ml, "legacy_export")[0] in ml.unassigned


@pytest.fixture
def backend(tmp_path: Path) -> Manifest:
    return analyse_architecture(write(tmp_path / "svc", BACKEND_REPO), NO_GIT)


def test_backend_layers_and_findings(backend: Manifest) -> None:
    assert structural_violations(backend) == []
    by_id = {c.id: c for c in backend.components}
    routes = by_id[component_of(backend, "get_user")]
    repository = by_id[component_of(backend, "find")]
    service = by_id[component_of(backend, "fetch_user")]
    assert routes.archetype == "routing" and repository.archetype == "repository"
    assert len({routes.id, repository.id, service.id, component_of(backend, "show")}) == 4  # SEG-059
    assert by_id[component_of(backend, "UserIn")].archetype == "schema"
    assert by_id[component_of(backend, "settings")].archetype == "configuration"
    kinds = {u.name: u.kind for u in backend.units}
    assert kinds["get_user"] == "route_handler" and kinds["settings"] == "config_block"
    codes = {f.code for f in backend.findings}
    route = next(f for f in backend.findings if f.code == "ROUTE_HANDLER_LOGIC")
    assert route.unit_id == units_named(backend, "create_user")[0]
    cycle = next(f for f in backend.findings if f.code == "COMPONENT_CYCLE")
    assert cycle.severity == "error" and "→" in cycle.message
    layer = [f for f in backend.findings if f.code == "LAYER_VIOLATION"]
    assert any(f.law == "SEG-061" and f.component_id == repository.id for f in layer)
    assert "LEAKAGE_FIT_BEFORE_SPLIT" not in codes


def test_same_code_same_architecture(ml_repo: Path) -> None:
    first = analyse_architecture(ml_repo, NO_GIT)
    second = analyse_architecture(ml_repo, NO_GIT)
    assert first.architecture_key() == second.architecture_key()  # SEG-006


def test_classes_and_cells_are_never_split(tmp_path: Path) -> None:
    root = write(tmp_path / "cls", {
        "store.py": """
            import pandas as pd

            class FeatureStore:
                def load(self, path):
                    return pd.read_csv(path)

                def train(self, frame):
                    from sklearn.linear_model import LogisticRegression
                    return LogisticRegression().fit(frame, frame)

                def plot(self, frame):
                    import matplotlib.pyplot as plt
                    plt.plot(frame)
        """,
        "run.py": """
            from store import FeatureStore

            store = FeatureStore()
            frame = store.load("x.csv")
            store.train(frame)
            store.plot(frame)
        """,
    })  # fmt: skip
    manifest = analyse_architecture(root, NO_GIT)
    homes = {u.component_id for u in manifest.units if u.file == "store.py"}
    assert len(homes) == 1  # SEG-050


def test_structural_validator_catches_bad_output(ml: Manifest) -> None:
    broken = ml.model_copy(deep=True)
    broken.components[0].name = "utils"
    broken.components[1].archetype = "wizardry"
    broken.unassigned.append(broken.components[2].units[0])
    broken.units[0].line_end = 99_999
    problems = " ".join(structural_violations(broken))
    for law in ("SEG-062", "SEG-091", "SEG-066", "SEG-004"):
        assert law in problems


def test_analysis_exposes_graph_for_later_stages(ml_repo: Path) -> None:
    analysis = analyse(ml_repo, NO_GIT)
    assert analysis.graph.edges and set(analysis.votes) == {u.id for u in analysis.manifest.units}


def test_traced_edges_beat_inferred_ones(tmp_path: Path) -> None:
    """SEG-029: an observed Code Mode trace edge is kept and lowers confidence of unobserved static edges."""
    root = write(tmp_path / "traced", {
        "load.py": """
            def load():
                return [1, 2, 3]

            def helper():
                return 0
        """,
        "train.py": """
            from load import helper, load

            def train():
                helper()
                rows = load()
                return sum(rows)
        """,
    })  # fmt: skip
    traces = root / ".flowlab" / "traces"
    traces.mkdir(parents=True)
    (traces / "trace_1.json").write_text(
        json.dumps(
            {
                "edges": [
                    {"from": ["train.py", 5], "to": ["load.py", 2], "type": "call", "count": 1},
                ]
            }
        )
    )
    analysis = analyse(root, NO_GIT)
    assert analysis.graph.traced
    by_name = {u.name: u.id for u in analysis.manifest.units}
    observed = [e for e in analysis.graph.edges.values() if e.observed]
    assert any(e.source == by_name["train"] and e.target == by_name["load"] for e in observed)
    ghost = [
        e
        for e in analysis.graph.edges.values()
        if e.source == by_name["train"] and e.target == by_name["helper"] and not e.observed
    ]
    assert ghost and all(e.confidence == "medium" for e in ghost)
