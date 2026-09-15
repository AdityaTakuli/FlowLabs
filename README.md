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

## Web canvas (local)

```bash
cd apps/web && npm install && npm run build && cd ../..   # once (frontend packages live in apps/web/node_modules)
flowlab serve --root path/to/your/project                # opens http://127.0.0.1:8765/?token=…
```

- Graph / Linear / Split views of any `.ipynb` or `.py` in the folder; click a block for
  Code (Monaco, save on blur or Ctrl/⌘+S, live edge preview), Data, Diff and Profile tabs.
- Start a kernel in the sidebar, then Run / Run to here / Run from here / Run stale; output
  streams to the console, stale blocks are highlighted, RAM gauge is live.
- Drag cells in Linear view to reorder (unsafe moves are refused and the blocking edge is
  shown); duplicate, split, extract, insert and delete from the Code tab; Undo change reverts.
- Focus mode, variable search, import-edge toggle and time/memory heat map on the canvas.
- Security: listens on 127.0.0.1 only, every API call needs the per-launch token, loopback
  `Host`/`Origin` checks block DNS rebinding and cross-site requests.
- Frontend dev with hot reload: run `flowlab serve` and `npm run dev` in `apps/web`, then open
  the `localhost:5173` link it prints.

## Code Mode (PRD Part II)

Your own notebooks and scripts as a dependency graph, run on this machine. The code stays the
source of truth; the graph is a projection regenerated from it. See
`docs/decisions/0005-code-mode-scope.md` for what is built and what waits for the API and canvas.

```bash
flowlab lab init ~/projects/churn                     # .flowlab/ state, gitignored; Local-only on
flowlab lab graph analysis.ipynb --root ~/projects/churn            # blocks, edges, confidence, warnings
flowlab lab run analysis.ipynb --node b7 --root ~/projects/churn    # run-to-here in a local kernel
flowlab lab diff analysis.ipynb b3 b4 --root ~/projects/churn       # which step dropped rows?
flowlab lab transform pipeline.py reorder --node b5 --before b3 --root .   # refused if it breaks a dependency
flowlab lab revert pipeline.py --root .               # undo the last transformation
flowlab lab trace --root ~/projects/repo -- python train.py --config dev   # graph from one instrumented run
flowlab lab to-flow analysis.ipynb --node b2 --node b3 --out draft.json    # draft Flow Spec for a section
flowlab eject examples/churn_flow.json --data fixtures --format ipynb --out churn.ipynb
```

- **Analyse:** cells / `# %%` regions / statement groups become blocks; defines, uses, mutations,
  aliases, conditional and loop-carried names, undefined names and out-of-order notebooks are
  detected, with high/medium/low confidence. A 100-cell notebook analyses in well under 500 ms.
- **Run and debug:** staleness propagates to descendants; every run records time, peak memory,
  rows in/out and before/after summaries in `.flowlab/snapshots/`; tracebacks map to blocks;
  orphan variables, runtime mutations and stale imports are reported.
- **Privacy:** data rows never leave the machine in Local-only mode; credentials in code are
  masked before code text is sent.

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
