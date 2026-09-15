"""Privacy (PRD II 4.3, 12, 14): secrets are masked and data rows never leave in Local-only mode."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from flowlab_lab import analyse_text
from flowlab_lab.kernel import LabSession
from flowlab_lab.models import graph_row, snapshot_rows
from flowlab_lab.privacy import (
    LocalOnlyError,
    OutboundPolicy,
    execution_payload,
    first_open_warning,
    graph_payload,
    mask_secrets,
    preview_payload,
    summary_payload,
    transmission_badge,
)
from flowlab_lab.project import LabProject

SECRETS = {
    "groq": "gsk_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4",
    "aws": "AKIA" + "IOSFODNN7EXAMPLE",
    "github": "ghp_" + "a" * 36,
    "google": "GOCSPX-" + "xqr1A7U_abcdefghijklmn",
    "password": "hunter2-very-secret",
}
CODE = f"""import os
client = Groq(api_key="{SECRETS["groq"]}")
aws_key = "{SECRETS["aws"]}"
token = '{SECRETS["github"]}'
oauth = "{SECRETS["google"]}"
db_password = "{SECRETS["password"]}"
engine = create_engine("postgresql://admin:{SECRETS["password"]}@db.internal/sales")
label = "customer churn"
"""


def test_mask_secrets_hides_values_and_reports_locations() -> None:
    masked, findings = mask_secrets(CODE)
    for value in SECRETS.values():
        assert value not in masked
    assert 'label = "customer churn"' in masked and "import os" in masked
    kinds = {(f.kind, f.line) for f in findings}
    assert {("groq_key", 2), ("aws_access_key", 3), ("github_token", 4), ("google_oauth_secret", 5)} <= kinds
    assert ("assigned_secret", 6) in kinds and ("url_credentials", 7) in kinds
    assert mask_secrets("x = 1\nname = 'token counts'\n") == ("x = 1\nname = 'token counts'\n", [])


def test_private_key_blocks_are_masked() -> None:
    key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----"
    masked, findings = mask_secrets(f"KEY = '''{key}'''")
    assert "MIIEow" not in masked and findings[0].kind == "private_key"


def test_graph_payload_masks_code_and_first_open_warns() -> None:
    graph = analyse_text("creds.py", CODE)
    payload = graph_payload(graph)
    text = json.dumps(payload)
    assert all(value not in text for value in SECRETS.values())
    assert payload["secrets_masked"] >= 6 and payload["nodes"][0]["source"].count("«masked:") >= 6
    warning = first_open_warning(graph)
    assert warning is not None and "b1 line 2 (groq_key)" in warning
    assert first_open_warning(analyse_text("clean.py", "x = 1\n")) is None


def test_summaries_never_carry_rows_and_previews_respect_local_only() -> None:
    sample = {
        "columns": ["email"],
        "index": list(range(150)),
        "data": [[f"user{i}@corp.com"] for i in range(150)],
    }
    summary = {
        "kind": "dataframe",
        "rows": 150,
        "columns": ["email"],
        "null_counts": {"email": 0},
        "sample": sample,
    }
    assert "sample" not in summary_payload(summary)
    with pytest.raises(LocalOnlyError):
        preview_payload(summary, OutboundPolicy(local_only=True))
    preview = preview_payload(summary, OutboundPolicy(local_only=False))
    assert len(preview["preview"]["data"]) == 100 and len(preview["preview"]["index"]) == 100
    assert "never data rows" in transmission_badge(OutboundPolicy(local_only=True))
    assert "max 100" in transmission_badge(OutboundPolicy(local_only=False))


def test_no_dataframe_content_in_outbound_payloads_from_a_real_run(tmp_path: Path) -> None:
    # Private values live only in the data file, never in the code (code text is sent, masked).
    (tmp_path / "people.csv").write_text(
        "email,ssn,salary\n"
        "alice@private.example,123-45-6789,123456.78\n"
        "bob@private.example,987-65-4321,98765.43\n"
    )
    cells = [
        "import pandas as pd",
        "people = pd.read_csv('people.csv')",
        "print('loaded with', 'gsk_" + "Z" * 24 + "')\nrich = people[people['salary'] > 100000]",
    ]
    (tmp_path / "hr.ipynb").write_text(json.dumps({
        "cells": [{"cell_type": "code", "source": c, "metadata": {}, "outputs": [], "execution_count": None} for c in cells],
        "metadata": {}, "nbformat": 4, "nbformat_minor": 5,
    }))  # fmt: skip
    project = LabProject(tmp_path)
    with LabSession(project, "hr.ipynb", timeout_s=60) as session:
        records = session.execute(None, mode="all")
        policy = OutboundPolicy.model_validate(
            project.config.model_dump(include={"local_only", "max_preview_rows"})
        )
        assert policy.local_only is True
        outbound = [graph_payload(session.graph)]
        for record in records:
            snapshot = session.snapshots.load(record.execution_id)
            assert snapshot is not None
            if record.node_id != "b1":  # b1 only imports; the others produce data
                assert snapshot["after"]  # samples exist locally...
            outbound.append(execution_payload(record, snapshot["after"]))
        wire = json.dumps(outbound)
        # Row values must never be sent (numeric min/max/mean summaries are sent by design, PRD II 4.3).
        for private in (
            "alice@private.example",
            "bob@private.example",
            "123-45-6789",
            "987-65-4321",
            "Z" * 24,
        ):
            assert private not in wire  # ...but never in anything that would be sent
        with pytest.raises(LocalOnlyError):
            preview_payload(session.inspect("b3", "rich") or {}, policy)
        rows = snapshot_rows(project, session.snapshots.load(records[1].execution_id) or {})
        assert rows[0].variable_name == "people" and rows[0].shape == [2, 3]
        assert rows[0].sample_ref is not None and rows[0].sample_ref.startswith("local:.flowlab/snapshots/")
        assert graph_row(session.graph, row_id="g1", project_id="p1").graph["nodes"]
