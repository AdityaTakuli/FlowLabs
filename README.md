# FlowLab (Synapse)

Visual, node-graph workspace for tabular data. See [`PRD-flowlab.md`](PRD-flowlab.md).

**Status: Phase 0 — contracts and core engine (no UI, no API).**

## What exists

| Package | Path | Contents |
|---|---|---|
| `flowspec` | `packages/flowspec` | Pydantic Flow Spec, dataset schema contract, port schemas, compile/plan/event contracts, canonical hashing |
| `flowlab_nodes` | `packages/nodes` | Node base class, registry, schema inference, narration grounding, 12 nodes, generated `nodes.schema.json` |
| `flowlab_engine` | `packages/engine` | Compiler (structure → params → type propagation → semantic checks → cache keys → plan), local executor with content-addressed cache, `flowlab` CLI |

Nodes: `source.dataset`, `profile.overview`, `profile.missingness`, `clean.impute`,
`clean.drop_columns`, `prep.split`, `prep.encode`, `prep.scale`, `model.fit`,
`model.evaluate`, `viz.distribution`, `sink.export`.

Compiler rules (PRD 8.5): fit-before-split leakage, target-in-features, resampling leakage,
target definition, temporal leakage risk, class imbalance, small-n, multiple comparisons,
plus evaluation-on-train, split-lineage mismatch and no-holdout warnings.

## Setup

Uses the existing virtualenv at `../AIEnv`.

```bash
source ../AIEnv/bin/activate
pip install -e ".[dev]"
```

## Usage

```bash
flowlab run examples/churn_flow.json --data fixtures          # 7-node DoD flow
flowlab compile examples/leaky_flow.json --data fixtures      # fails: LEAKAGE_FIT_BEFORE_SPLIT on 'scale'
flowlab run examples/churn_full_flow.json --data fixtures     # 13 nodes incl. profiling + charts
flowlab profile fixtures/churn.csv                            # inferred schema contract
flowlab catalogue                                             # node catalogue + JSON Schemas
```

Each run writes `runs/<run_id>/` containing `plan.json`, `events.jsonl`, `run.json`
(manifest with per-node output hashes), `nodes/<node_id>/<port>.{parquet,json,joblib}`
and `exports/`. Node outputs are cached in `.flowlab/cache/` by content-addressed key.

`dataset_bindings` values are resolved against `--data`: `"churn"` → `churn.csv`,
`churn.parquet`, etc.

## Agent: snippet-based scripts (Groq)

The LLM never writes code. It picks snippets from a reviewed library
(`packages/agent/src/flowlab_agent/snippets/`, 74 snippets in 12 categories) and fills their
parameters; FlowLab validates, orders, adds missing prerequisites and assembles the script.
A request is roughly 1k tokens. See `docs/decisions/0004-snippet-composition-agent.md`.

```bash
cp .env.example .env        # put your GROQ_API_KEY in it
flowlab ask "what drives churn? build a model I can explain" --data fixtures/churn.csv --run
flowlab ask "predict churn" --data fixtures/churn.csv --dry-run   # show prompt, no API call
flowlab snippets list | search "compare groups" | show stats.ttest | check
flowlab compose plan.json --data fixtures/churn.csv --run         # hand-written plan, 0 tokens
```

Output goes to `generated/flowlab_script.py` and charts/files to `generated/outputs/`.
The default Groq model is `openai/gpt-oss-20b` (override with `FLOWLAB_LLM_MODEL` or `--model`);
list what your key can use with `curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"`.
Add a capability by adding a TOML snippet with an `[example]`; `make test` executes it.

## Development

```bash
make test        # pytest
make lint        # ruff
make typecheck   # mypy --strict on packages/
make catalogue   # regenerate packages/nodes/nodes.schema.json (CI test fails on drift)
make fixtures    # regenerate fixtures/*.csv deterministically
```

Decisions that refine or deviate from the PRD are recorded in `docs/decisions/`.
# FlowLabs
