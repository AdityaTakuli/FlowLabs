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

## Install the app (Linux, macOS, Windows)

**From a release build.** Download the build for your system from the project's releases, then:

| System | File | Install |
| --- | --- | --- |
| Linux | `FlowLab-<version>-linux-x86_64.tar.gz` | extract, then `./install.sh` (adds a menu entry and the `flowlab-app` command) |
| macOS | `FlowLab-<version>-macos-*.dmg` | open the image, drag FlowLab to Applications, right-click → Open the first time (the build is unsigned) |
| Windows | `FlowLab-<version>-windows-x64-setup.exe` | run the installer (SmartScreen: More info → Run anyway; the build is unsigned) |

**With pip**, if you already have Python 3.11+:

```bash
pipx install flowlab        # or: pip install flowlab
flowlab app                 # desktop window, or your browser if no webview is installed
pipx install "flowlab[desktop]"   # adds pywebview for the native window
```

The app opens the folder you used last, or creates `~/FlowLab` with the example project on first
run. It listens on 127.0.0.1 only, with a token generated per launch.

**Your code runs in your Python, not FlowLab's.** The Kernel panel lists the environments it found
(project `.venv`, conda environments, system Python) with their versions, and marks the ones
missing `ipykernel`. Pick one and FlowLab starts kernels from it; the choice is saved in the
project's `.flowlab/lab.json`.

### Build the app yourself

```bash
pip install -e ".[dev,build]"
python scripts/build_app.py      # builds the canvas, freezes the app, packages it into dist/
python scripts/smoke_app.py      # starts the built app and checks it serves the canvas
```

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

- Graph / Linear / Split views of any `.ipynb` or data-analysis `.py` in the folder; click a block for
  Code (Monaco, save on blur or Ctrl/⌘+S, live edge preview), Data, Diff and Profile tabs.
- Start a kernel in the sidebar, then Run / Run to here / Run from here / Run stale; output
  streams to the console, stale blocks are highlighted, RAM gauge is live.
- Drag cells in Linear view to reorder (unsafe moves are refused and the blocking edge is
  shown); duplicate, split, extract, insert and delete from the Code tab; Undo change reverts.
- Focus mode, variable search, import-edge toggle and time/memory heat map on the canvas.
- Rich outputs: matplotlib/PNG/SVG images, HTML (pandas tables, widgets), Vega-Lite charts, JSON and
  Markdown appear in the block's **Output** tab and under each cell in Linear view. Payloads stay in
  `.flowlab/outputs/` (size-capped, oldest evicted); HTML runs in a sandboxed iframe with no access to
  the canvas origin or its token.
- Shortcuts: `Ctrl/⌘+Enter` runs the selected block, `Shift+Enter` runs it and selects the next,
  `Esc` clears the selection.
- Security: listens on 127.0.0.1 only, every API call needs the per-launch token, loopback
  `Host`/`Origin` checks block DNS rebinding and cross-site requests.
- Frontend dev with hot reload: run `flowlab serve` and `npm run dev` in `apps/web`, then open
  the `localhost:5173` link it prints.

### Open code from anywhere, watch data travel (📂 Open)

- **📂 Open** browses this computer: open any folder (it becomes the project) or a single source
  file (its folder opens with that file selected). Recent folders are remembered in
  `~/.flowlab/recent.json`; **Import a file…** copies one file into `imported/` instead.
- The file splits into blocks (`# %%` cells, notebook cells, or statement groups). After a run,
  every edge shows what travelled along it: `DataFrame 4×4`, `list · 4 items`, and for HTTP calls
  made with `requests`/`httpx` the response status, e.g. `200 OK · json`. Click an edge label for the
  full value: JSON body, headers, URL, timing, table samples.
- Double-click a block (or ✎) to edit its code right on the canvas; **Save & run** re-runs it and
  downstream edges turn stale until they run again.

### Build mode: pipelines without code

Switch to **Build** in the toolbar (try it on `examples/ml-lab`, which includes `datasets/churn.csv`).

1. **New pipeline:** pick the dataset and the column to predict.
2. **Create node:** choose what the node is for (import data, explore, clean, engineer features,
   split, preprocess, train a model, evaluate, explain, visualize, save). Then pick a technique:
   114 in total, including every common scaler, encoder and imputer; classifiers, regressors and
   clustering; and a PyTorch neural network. Each shows its description and code.
3. **Wire the nodes** top to bottom by dragging from one card's bottom handle to the next, and set
   each node's settings in the right panel. Checks run as you edit.
4. **Finalize** orders the nodes, adds missing prerequisites and writes `pipelines/<name>.py`.
   With **Connect with AI**, Groq writes short, validated glue cells only where snippets do not
   line up; a clean pipeline costs 0 tokens. **Run** executes it in a kernel, with live state,
   metrics and outputs on each card.
5. **Change anything and run again.** If a step fails, **Fix with AI** sends the error for a glue
   fix. **Open in Code Mode** shows the script as cells.

See `docs/decisions/0013-build-mode.md`.

### Data analysis, ML and deep learning (cells)

Try it: `flowlab serve --root examples/ml-lab`, then run `01_data_processing.py`,
`02_sklearn_training.py` and `03_torch_training.ipynb` in order.

- **What travels on edges.** DataFrames, arrays and fitted estimators as before, plus PyTorch
  tensors (`Tensor 3000×8 · float32`), models (`ChurnNet · 1.4k params`), data loaders
  (`DataLoader · 38 batches × 64`), datasets, optimizers (`AdamW · lr 0.003`) and Keras models.
  The **Data** tab shows layer tables with parameter counts, tensor min/mean/max, loader batch
  details, and the top feature importances of fitted sklearn models.
- **Live training charts, no code changes.** While a cell trains, the printed metrics are charted
  live in the **Training** tab. Supported shapes: `epoch 3 loss=0.41 val_acc=0.87`,
  `step 120 | loss: 0.3`, Keras epoch logs, Hugging Face log dicts and `fold 2 roc_auc=0.9`.
  Lines like `rows 2000` are ignored. For exact control, call `flowlab_log(step=3, loss=0.41)`
  in any FlowLab kernel (no import needed).
- **Progress.** tqdm bars drive a progress bar on the running card, and the console updates the
  bar in place. `tqdm.auto` uses the text bar inside FlowLab, since the canvas does not draw
  Jupyter widgets.
- **On the cards.** The latest headline metric (validation loss first) and a model chip.
  Details: `docs/decisions/0012-ml-dl-lab.md`.

### Any language: structure graphs, cells only for data work

- Every source file in the folder is listed with its language (Python, TypeScript/JavaScript, Go,
  Rust, Java, Kotlin, C#, C/C++, Ruby, PHP, Swift, …). The **Language** picker shows only the
  languages this project uses, most used first.
- Each file opens in the workspace that fits it, and the sidebar shows which one: **cells** for
  notebooks, `# %%` scripts and pandas/sklearn/torch scripts (kernel, run buttons, live values on
  edges), and **graph** for application code (web backends, libraries, other languages). A graph
  shows functions, methods and classes as cards and calls as arrows labelled with the function
  called; click an arrow to see each call site and its arguments. A Python file can switch views
  (**Open as cells** / **Structure view**).
- Drag cards anywhere; positions are saved per file in `.flowlab/layouts/` (in cell graphs too).
  **Reset layout** returns to the automatic layout, and **Fold classes** tucks methods into their
  class.
- Double-click a card to edit just that function or class in an editor that highlights its
  language. Saves that would add a syntax error are refused; **Undo change** restores the file.
  Purple ↗ cards are functions from other files; double-click to open them.
- Parsing uses `tree-sitter-language-pack`. Grammars not yet cached download once on first use.
  See `docs/decisions/0011-any-language-structure-graphs.md`.

### Ask panel (✦ Ask, next to the mode switch)

- Pick a dataset and describe a goal; the Groq model picks reviewed snippets and FlowLab composes
  a script with `# %%` cells. **Save & open in Code Mode** writes it into the project, ready to run
  block by block with charts shown inline.
- Needs `GROQ_API_KEY` in the environment or a `.env` in the project folder. Each ask requires
  consent and sends only the goal and a column summary (names, kinds, % missing, distinct counts);
  **Preview exact prompt** shows it without calling the model.
- Edit the plan (remove steps, change params, add snippets) and **Recompose** for zero tokens.
  Identical asks are served from `.flowlab/llm_cache`. See `docs/decisions/0008-agent-panel.md`.

### Flow Mode (same server, toggle in the toolbar)

- Flows are Flow Spec `.json` files in the folder; datasets are `.csv`/`.parquet`/… files. A
  binding can be a path (`data/churn.csv`) or a unique file stem (`churn`).
- Drag nodes from the palette (or press `Tab` / `Ctrl+K`); a dropped node auto-connects to the
  nearest compatible output. Ports are colour-coded by type and invalid connections are refused
  while you drag, with the reason shown.
- Params forms are generated from each node's JSON Schema (`x-widget`, `x-descriptions`,
  `x-filter`), with column pickers fed by the compiler's type propagation.
- Every edit recompiles (debounced): leakage and rigour errors badge the offending node.
- Run / Cancel streams node states live; the Output tab shows table previews, split partitions,
  metrics, confusion matrices and Vega-Lite charts. Runs live in `.flowlab/runs/`, cached node
  outputs in `.flowlab/cache/`.
- Undo/redo, copy/paste/duplicate, multi-select, auto-layout, save with `Ctrl+S` (conflicts with
  on-disk edits are detected).

### Architecture (same server, toggle in the toolbar)

Decomposes the open project into **components** (one responsibility each) and **units** (functions,
classes, cells). The analysis is static and local; naming with a model is optional and consent-gated.

```bash
flowlab lab architecture --root path/to/your/project          # writes .flowlab/architecture/manifest.json
flowlab lab architecture --root . --json                      # print the manifest
```

- Cards are components; solid arrows are calls, dashed arrows are data flow. Red arrows are
  dependency cycles or layer violations. The dashed-border card is `__unassigned__` (dead or
  uncategorisable code, never forced into a neighbour).
- Leakage findings (a transformer fitted before the train/test split) are errors on the diagram.
- **Name with model…** sends cluster fingerprints only (names, truncated signatures, first
  docstring lines, import names, edge counts — never bodies, tests or data). Needs `GROQ_API_KEY`
  and explicit consent, same as ✦ Ask.
- **Report incorrect segregation…** stores an anonymised fingerprint on this machine.

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
flowlab lab architecture --root ~/projects/churn                           # components + units + findings
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
