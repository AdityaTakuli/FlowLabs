from __future__ import annotations

import copy
import json
import math

from flowspec import FlowSpec, canonical_json, flow_spec_json_schema
from helpers import compile_spec, load_example
from hypothesis import given, settings
from hypothesis import strategies as st

EXAMPLES = ["churn_flow.json", "churn_full_flow.json", "leaky_flow.json"]

json_scalars = st.one_of(
    st.none(),
    st.booleans(),
    st.integers(-(10**6), 10**6),
    st.floats(allow_nan=False, allow_infinity=False, width=32),
    st.text(max_size=12),
)
ids = st.text("abcdefghijklmnopqrstuvwxyz0123456789_", min_size=1, max_size=8)


def test_examples_round_trip() -> None:
    for name in EXAMPLES:
        spec = FlowSpec.model_validate(load_example(name))
        again = FlowSpec.model_validate_json(spec.model_dump_json())
        assert again == spec


def test_json_schema_export_describes_nodes_and_edges() -> None:
    schema = flow_spec_json_schema()
    assert {"nodes", "edges", "dataset_bindings", "flow_id"} <= set(schema["properties"])


def test_canonical_json_is_order_independent_and_nan_safe() -> None:
    assert canonical_json({"b": 1, "a": [1.5, math.nan]}) == canonical_json({"a": [1.5, None], "b": 1})


@settings(max_examples=60, deadline=None)
@given(
    nodes=st.lists(
        st.fixed_dictionaries(
            {
                "id": ids,
                "type": st.sampled_from(["source.dataset", "prep.split", "x.y"]),
                "label": st.one_of(st.none(), st.text(max_size=10)),
                "params": st.dictionaries(st.text(min_size=1, max_size=6), json_scalars, max_size=4),
                "position": st.fixed_dictionaries({"x": st.floats(-1e4, 1e4), "y": st.floats(-1e4, 1e4)}),
            }
        ),
        min_size=1,
        max_size=6,
    ),
    seed=st.integers(0, 2**31),
)
def test_spec_serialisation_round_trips(nodes: list[dict[str, object]], seed: int) -> None:
    spec = FlowSpec.model_validate(
        {"flow_id": "f", "name": "n", "nodes": nodes, "edges": [], "meta": {"seed": seed}}
    )
    assert FlowSpec.model_validate(json.loads(spec.model_dump_json())) == spec


@settings(max_examples=25, deadline=None)
@given(
    positions=st.lists(st.tuples(st.floats(-5000, 5000), st.floats(-5000, 5000)), min_size=7, max_size=7),
    labels=st.lists(st.one_of(st.none(), st.text(max_size=20)), min_size=7, max_size=7),
)
def test_cache_keys_ignore_position_and_label(
    positions: list[tuple[float, float]], labels: list[str | None]
) -> None:
    base = load_example("churn_flow.json")
    changed = copy.deepcopy(base)
    for node, (x, y), label in zip(changed["nodes"], positions, labels, strict=True):
        node["position"] = {"x": x, "y": y}
        node["label"] = label
    a, b = compile_spec(base), compile_spec(changed)
    assert a.plan and b.plan
    assert [s.cache_key for s in a.plan.steps] == [s.cache_key for s in b.plan.steps]
    assert a.plan.spec_hash == b.plan.spec_hash


def test_cache_keys_ignore_node_ids() -> None:
    base = load_example("churn_flow.json")
    renamed = copy.deepcopy(base)
    for node in renamed["nodes"]:
        node["id"] = f"renamed_{node['id']}"
    for edge in renamed["edges"]:
        edge["source"], edge["target"] = f"renamed_{edge['source']}", f"renamed_{edge['target']}"
    a, b = compile_spec(base), compile_spec(renamed)
    assert a.plan and b.plan
    assert [s.cache_key for s in a.plan.steps] == [s.cache_key for s in b.plan.steps]


def test_param_change_invalidates_node_and_downstream_only() -> None:
    base = load_example("churn_flow.json")
    changed = copy.deepcopy(base)
    changed["nodes"][3]["params"]["method"] = "frequency"  # n4 prep.encode
    a, b = compile_spec(base), compile_spec(changed)
    assert a.plan and b.plan
    ka = {s.node_id: s.cache_key for s in a.plan.steps}
    kb = {s.node_id: s.cache_key for s in b.plan.steps}
    assert [n for n in ka if ka[n] == kb[n]] == ["n1", "n2", "n3"]


def test_defaulted_params_share_a_key_with_explicit_defaults() -> None:
    base = load_example("churn_flow.json")
    explicit = copy.deepcopy(base)
    explicit["nodes"][5]["params"] = {"partition": "test", "positive_class": None}
    a, b = compile_spec(base), compile_spec(explicit)
    assert a.plan and b.plan
    assert a.plan.steps[5].cache_key == b.plan.steps[5].cache_key


def test_seed_change_invalidates_every_key() -> None:
    base = load_example("churn_flow.json")
    reseeded = copy.deepcopy(base)
    reseeded["meta"]["seed"] = 43
    a, b = compile_spec(base), compile_spec(reseeded)
    assert a.plan and b.plan
    assert all(x.cache_key != y.cache_key for x, y in zip(a.plan.steps, b.plan.steps, strict=True))
