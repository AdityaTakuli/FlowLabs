# FlowLab PRD — Part II: Code Mode

**Companion to:** `PRD-flowlab.md` (Part I)
**Version:** 0.1 (draft for implementation)
**Status:** Specification; builds on Part I Phases 0–5
**Primary reader:** Claude Code and the founding developer
**Last updated:** 2026-09-14

---

## 0. Relationship to Part I

Part I specifies **Flow Mode**: a declarative node canvas where the Flow Spec is the source of truth, an agent can generate it, and a compiler validates it before execution.

Part II specifies **Code Mode**: the user brings their own Python — a notebook, a script, or an existing repo — runs it on their own machine with their own data, and FlowLab renders it as a live node graph they can inspect, reorder, edit and debug.

These are two modes of the same product, sharing the canvas, the runner, the artifact store and the debugging UI. They are **not** the same data model, and Section 3 explains why conflating them would be a mistake.

Everything in Part I remains normative. This document adds to it and, where noted, extends the Flow Spec.

---

## 1. Problem and summary

### 1.1 The problem

Jupyter won the data-science workflow because it gives you three things at once: your own machine's resources, your own data staying local, and immediate feedback on every step. It loses on everything after that.

A notebook has no structure. Cell 12 might depend on cell 3, or on cell 40 that you ran an hour ago and then edited. There is no way to see the dependency graph, because there isn't one — there's an execution order in your head and a pile of hidden kernel state. When a dataframe comes out wrong, you find the bug by scattering `df.head()` and `df.dtypes` calls through your cells and scrolling.

Meanwhile the visual pipeline tools (Part I's Flow Mode, KNIME, Alteryx) give you structure but take away the code. The moment you need something the node catalogue doesn't have, you're stuck.

### 1.2 The product

Code Mode makes the structure of existing Python **visible and manipulable without taking the code away**.

- Point FlowLab at a notebook, a script, or a repo on your machine.
- It analyses the code and renders a dependency graph: which block produces which variable, which block consumes it.
- Every node shows the actual data flowing through it — shape, dtypes, nulls, a preview — at that exact point in the pipeline.
- Click a node, see and edit its real code in place. The graph updates as you type.
- Drag to reorder blocks. FlowLab rewrites the code and refuses reorderings that break dependencies.
- Everything runs on your machine, on your CPU, against your files. Nothing uploads.

### 1.3 Positioning

> Your notebook, as a graph you can actually see. Same machine, same data, same code — but you can finally tell what depends on what, and look at the dataframe between any two steps.

### 1.4 Why this matters for the overall product

Three strategic effects:

1. **It removes the on-ramp problem.** Flow Mode asks a user to abandon their existing work. Code Mode meets them with the notebook they already have.
2. **It is the honest answer to compute.** Part I Section 4.1 concluded the local runner should be the default. Code Mode makes local execution the headline feature rather than a fallback.
3. **It closes the escape hatch gap.** Part I deferred a `CustomScript` node because arbitrary code in a declarative pipeline is dangerous. Code Mode gives users arbitrary code in a context where it's expected, so Flow Mode can stay clean.

---

## 2. Scoping: what is achievable and what is not

**Read this before writing any analyser code.** The feature as casually described — "turn any code into nodes and back" — is not fully achievable, and building toward it produces a tool that corrupts users' work. This section defines the buildable subset.

### 2.1 Why lossless round-tripping fails

Python is a general-purpose imperative language with mutable objects, dynamic attribute access, closures, decorators, side effects and runtime-determined control flow. A node graph is a static DAG of pure-ish transformations. The mapping is lossy in both directions:

| Python construct | Why it breaks graph representation |
|---|---|
| `df.drop(col, inplace=True)` | Mutates in place. Two nodes now share a mutated object; the edge no longer describes the data |
| `for f in files: process(f)` | Loop body isn't a node; iteration count is runtime-determined |
| `if config.mode == "x": ...` | Branch taken depends on runtime state |
| `exec()`, `eval()`, `globals()[name]` | Undecidable statically |
| `from lib import *` | Names appear from nowhere |
| Class definitions, decorators, closures | Not dataflow at all |
| `df2 = df1` then modify `df2` | Aliasing — same object, two names |

Any tool that claims to round-trip all of this is either restricting the language (which users experience as "my code doesn't work here") or guessing (which users experience as silent corruption).

### 2.2 The decision: code is the source of truth

**MUST:** In Code Mode, the user's code files are authoritative. The graph is a **projection** — a derived, regenerable view. FlowLab never stores a graph that can disagree with the code.

Consequences that follow from this and are all non-negotiable:

- Editing code regenerates the graph. Always.
- Graph manipulations (reorder, split, merge) are implemented as **source transformations** applied to the code, after which the graph is regenerated from the new code. There is no separate graph state to drift.
- Anything the analyser can't understand still appears as a node — an opaque one — rather than being dropped or silently rewritten.
- If FlowLab can't safely perform a requested graph edit, it refuses and says why. It never approximates.

### 2.3 The four tiers

Build in this order. Each tier is independently useful.

| Tier | Input | Output | Confidence |
|---|---|---|---|
| **A — Cell dataflow** | `.ipynb` or a script with cell markers | DAG of cells, edges = variable def→use | High. Static analysis of variable binding is well understood |
| **B — Pattern recognition** | Any Python | Recognised calls mapped to Part I node types (`pd.read_csv` → `source.dataset`, `train_test_split` → `prep.split`) | Medium. Good coverage of common idioms, never complete |
| **C — Opaque code nodes** | Anything unrecognised | A `code.block` node with inferred input/output variables | High, because it makes no claims about internals |
| **D — Repo tracing** | A multi-file repo | Graph built from an instrumented run, not static analysis | Medium. Reflects one actual execution, which is honest but path-dependent |

Tier C is what makes the product work. **The graph is always complete** because everything the analyser can't classify becomes an honest black box that is still wired, still runnable, still inspectable. Coverage is never the blocker; precision degrades gracefully.

### 2.4 Explicit non-goals

- **No round-trip guarantee for arbitrary code.** Documented, stated in the UI.
- **No graph-only editing of Code Mode projects.** You can always drop into code.
- **No automatic refactoring of loops or conditionals into nodes.** They stay inside a single node.
- **No support for notebooks that depend on out-of-order execution.** FlowLab analyses the code as written, not as historically executed. Detect and warn.
- **No language beyond Python in v1.** R and SQL are plausible later; the analyser is per-language.

---

## 3. Modes

| | **Flow Mode** (Part I) | **Code Mode** (Part II) |
|---|---|---|
| Source of truth | Flow Spec (JSON) | User's `.py` / `.ipynb` files |
| Node contents | Declarative params | Real Python |
| Who authors | User via UI, or agent | User in code, assisted by agent |
| Execution | Compiled plan → runner | Kernel executes cells in dependency order |
| Validation | Full compiler, leakage checks enforced | Advisory — warnings only, never blocking |
| Data location | Storage (MinIO/Drive/S3) | User's local filesystem |
| Reproducibility | Guaranteed by content-hash caching | Best-effort; kernel state is inherently less pure |

### 3.1 Where they meet (MUST)

Two bridges, both valuable, both one-way at first:

**Flow → Code (Phase 9).** "Eject to code" on any Flow Mode graph generates a clean, readable `.ipynb` or `.py` that reproduces it. This is a one-way export: the user owns the result, and FlowLab makes no claim to re-import it as the same flow. Removes lock-in, which is worth a great deal of user trust.

**Code → Flow (Phase 11).** When Tier B recognises a contiguous run of blocks as a known pattern, offer "convert this section to Flow nodes." The user confirms per-section. Never automatic.

### 3.2 Hybrid projects (post-v1)

A single graph containing both declarative nodes and code nodes is the eventual destination, but it requires the compiler to reason about opaque nodes' schemas, which it cannot do statically. Defer until Tier B pattern coverage and runtime schema capture are both mature. Do not attempt in v1.

---

## 4. Local execution: the Lab Agent

Code Mode extends the `flowlab-runner` from Part I Section 8.3 with a **kernel mode**.

### 4.1 Two execution models

| | **Batch mode** (Part I) | **Kernel mode** (Code Mode) |
|---|---|---|
| State | Stateless; artifacts on disk between nodes | Live Python process; variables persist in memory |
| Node output | Parquet file | In-memory object + a captured summary |
| Re-run a node | Reads upstream artifacts | Re-executes with current kernel bindings |
| Analogy | Airflow task | Jupyter cell |

Kernel mode is what makes Code Mode feel like a notebook rather than a build system.

### 4.2 The agent

```bash
pip install flowlab-lab
flowlab lab ~/projects/churn-analysis
```

This:

1. Starts a local process bound to `127.0.0.1` only.
2. Starts a Jupyter kernel (via `jupyter_client`) in the project directory, using the project's own environment — the venv/conda env already active, so the user's installed packages are what runs.
3. Indexes `.py` and `.ipynb` files in the directory.
4. Opens an outbound WebSocket to the FlowLab API using an attach token, exactly as the Part I runner does.
5. Watches the filesystem; file changes trigger re-analysis.

**MUST:** the agent binds to localhost only and never opens an inbound port. All communication is outbound. This is the same pattern as Part I and it means no firewall configuration, no NAT traversal, and no listening surface on the user's machine.

### 4.3 What crosses the network

| Stays local | Sent to FlowLab |
|---|---|
| Dataset files | Code text (for rendering in the editor) |
| Dataframe contents | Structural analysis: nodes, edges, variable names |
| Variable values | **Summaries**: shape, dtypes, null counts, memory, min/max |
| Model objects | Preview rows — **only when the user clicks a node**, capped at 100 rows |
| Credentials in the code | Execution events, stdout/stderr, exceptions |

**MUST:** a project-level **Local-only mode** toggle that blocks preview rows from leaving the machine entirely. Some users will have data that legally cannot transit a third party, and this toggle is what makes FlowLab usable for them.

**MUST:** show a persistent, honest indicator in the UI stating exactly what is being transmitted. Not a settings page buried three levels down — a visible badge.

### 4.4 Environment capture

Record per session and attach to every run: Python version, platform, installed package versions (from `importlib.metadata`), CPU count, total/available RAM, GPU presence. Surfaced in the UI and used to explain discrepancies when the same code behaves differently on two machines.

### 4.5 Resource awareness

The agent reports live CPU, RAM and disk. The UI shows a memory gauge, and warns before executing a node whose historical peak memory exceeded current available RAM. This is a small feature that saves users from the single most common local-execution failure: the kernel dying silently on a large join.

---

## 5. Code → graph: the analyser

### 5.1 Pipeline

```
Source file
   ↓ parse (ast module, or nbformat for .ipynb)
Block segmentation
   ↓
Per-block symbol analysis  (defs, uses, mutations, imports, side effects)
   ↓
Dependency edge construction
   ↓
Pattern matching (Tier B)
   ↓
Confidence annotation
   ↓
CodeGraph
```

### 5.2 Block segmentation

A **block** is the unit that becomes a node.

| Source | Block boundary |
|---|---|
| `.ipynb` | One notebook cell = one block. Non-negotiable — it's what the user already sees |
| `.py` with `# %%` markers | Marker-delimited regions (VS Code / Spyder convention) |
| Plain `.py` | Top-level statements grouped by blank-line runs and a heuristic; function and class definitions each become one block |

**MUST:** never split a block across a syntactic boundary. A `for` loop is one block even if it's 80 lines. Never merge blocks the user separated.

Users can manually split a block at a line (inserts a `# %%` marker) or merge adjacent blocks (removes one). Both are source edits.

### 5.3 Symbol analysis

Per block, walk the AST and produce:

```jsonc
{
  "block_id": "b4",
  "lines": [45, 61],
  "defines": ["X_train", "X_test", "y_train", "y_test"],
  "uses": ["df", "target_col"],
  "mutates": [],
  "imports": [],
  "calls": ["sklearn.model_selection.train_test_split"],
  "side_effects": [],
  "confidence": "high"
}
```

Detection rules:

- **defines** — assignment targets, `with ... as`, `for ... in` targets, function/class defs, walrus, augmented assignment (both define and use)
- **uses** — `ast.Name` in `Load` context, minus locally-bound names in comprehensions and function scopes
- **mutates** — calls to known mutating methods (`append`, `update`, `sort_values(inplace=True)`, `iloc[...] = `), subscript assignment on an outer-scope name, any call with `inplace=True`
- **imports** — tracked separately; import blocks are pinned to the top of the graph and are dependencies of everything that uses the name
- **side_effects** — file I/O, network calls, `print`, plotting, `random` without a seed, environment access

### 5.4 Edge construction

An edge `A → B` exists when B `uses` a name that A `defines`, and A is the **most recent preceding** definer of that name in source order.

Cases requiring care:

| Case | Handling |
|---|---|
| **Redefinition** | `df` defined in b2 and again in b5; b7 uses `df` → edge from b5. Shadowed edge b2→b7 is not drawn |
| **Mutation** | b4 mutates `df` defined in b2; b6 uses `df` → edge b4→b6, rendered as a **dashed mutation edge** with a warning badge |
| **Aliasing** | `df2 = df1` → alias edge; any mutation of either flags both, `confidence: low` |
| **Conditional definition** | Name defined inside `if` → edge drawn, `confidence: medium`, badge "may not be defined at runtime" |
| **Loop-carried** | Name both defined and used in the same block → self-loop, rendered as an iteration badge, not an edge |
| **Undefined name** | Used but never defined in the graph → **error node** on the canvas: "`config` is used but never defined here" |

### 5.5 Pattern matching (Tier B)

A rules table mapping call signatures to Part I node semantics:

```python
PATTERNS = [
  Pattern(call="pandas.read_csv",              node_type="source.dataset"),
  Pattern(call="pandas.DataFrame.fillna",      node_type="clean.impute"),
  Pattern(call="pandas.DataFrame.drop_duplicates", node_type="clean.dedupe"),
  Pattern(call="sklearn.model_selection.train_test_split", node_type="prep.split"),
  Pattern(call="sklearn.preprocessing.StandardScaler", node_type="prep.scale"),
  Pattern(call="sklearn.*.fit",                node_type="model.fit"),
  Pattern(call="sklearn.metrics.*",            node_type="model.evaluate"),
  Pattern(call="scipy.stats.ttest_ind",        node_type="stat.ttest"),
  Pattern(call="matplotlib|seaborn|plotly.*",  node_type="viz.*"),
]
```

A match affects **only** the node's icon, colour, label and the availability of the "convert to Flow node" action. It **MUST NOT** change execution, rewrite the code, or alter the graph structure. Pattern matching is cosmetic and navigational; getting it wrong must be harmless.

### 5.6 Confidence

Every node and edge carries `high | medium | low`, rendered visually (solid / dashed / dotted). Downgrade on: mutation, aliasing, conditional definition, `*` imports, dynamic attribute access, `exec`/`eval`, decorators that wrap dataflow.

**MUST:** a low-confidence graph is shown as low-confidence. The failure mode that destroys trust is a confidently wrong graph. A visibly uncertain one is merely a limitation.

### 5.7 Performance

Analysis MUST complete in under 500 ms for a 100-cell notebook. Cache per block keyed by source hash; on file change, re-analyse only the changed block and recompute edges. Edge recomputation is O(blocks) and cheap.

---

## 6. Graph → code: manipulation

Every canvas manipulation is a **source transformation**, applied to the file, after which the graph regenerates.

### 6.1 Supported operations

| Operation | Implementation | Safety |
|---|---|---|
| **Reorder blocks** | Move source region | Refused if it would place a use before its def. UI shows the blocking dependency |
| **Split block** | Insert `# %%` at the cursor line | Always safe |
| **Merge blocks** | Remove the separator | Safe if adjacent |
| **Delete block** | Remove source region | Warns and lists downstream nodes that would break; requires confirm |
| **Duplicate block** | Copy region, rename defined variables with a suffix | Safe |
| **Extract to function** | Wrap in `def`, params = uses, returns = defines | Refused when the block mutates outer-scope names |
| **Insert node** | Insert a new block at a graph position | Safe |

### 6.2 Rules (MUST)

- **Formatting is preserved.** Use a CST (`libcst`) rather than `ast` for anything that writes back, so comments, blank lines and quote style survive. A tool that reformats a user's file on every drag will be uninstalled that day.
- **Every transformation is a single undo step** in both the canvas and the file.
- **The file on disk is written atomically**, and the agent suppresses its own file-watch event to avoid a re-analysis loop.
- **If the file changed on disk since the graph was rendered** (the user edited it in VS Code), re-analyse before applying, and show a conflict prompt if the target region moved.

### 6.3 Code editing in the node

Clicking a node opens a Monaco editor with that block's source. On edit:

1. Debounce 300 ms
2. Re-parse just this block
3. If `defines`/`uses` changed, recompute edges and animate the graph change
4. Mark the node **stale** — its last output no longer matches its code
5. Write to disk on blur or Cmd+S

Full LSP features (completion, go-to-definition, type hints) via `pylsp` running inside the local agent, where the real environment lives. **MUST** run in the agent, not the browser — only the agent knows what's actually installed.

---

## 7. Repo import (Tier D)

Existing repos are a different problem from notebooks and need a different technique.

### 7.1 Why static analysis is insufficient

A repo's dataflow crosses function and module boundaries, through call chains that static analysis can only approximate in Python. Interprocedural analysis of a dynamically typed language with duck typing produces either a graph so conservative it's useless, or one so optimistic it's wrong.

### 7.2 Trace-based construction (MUST)

Instead of guessing, **watch it run**.

1. User selects an entry point: `python train.py --config dev.yaml`
2. The agent runs it under instrumentation — `sys.settrace` plus targeted monkey-patching of pandas/numpy/sklearn constructors and returns
3. Record every point where a **tracked object** (DataFrame, ndarray, sklearn estimator) is created, transformed or consumed, with the source location
4. Build the graph from the recorded trace: nodes are source locations that produced tracked objects, edges are object identity flowing between them
5. Render it with the function/module structure as **groups** on the canvas

### 7.3 Honest framing

This graph reflects **one execution with one configuration**. Different flags produce a different graph. The UI MUST state this — label it "Traced from: `python train.py --config dev.yaml` at 14:32" and offer to re-trace with different arguments. Multiple traces of the same repo can be compared, which is itself a useful debugging feature ("why does the prod config produce a different pipeline?").

### 7.4 Overhead and scope

`sys.settrace` is slow — expect 2–10× on tracing-heavy code. Mitigations: trace only files under the project root (skip site-packages), sample rather than trace inside hot loops, offer a "trace with a sampled dataset" option. Cap at a configurable wall-clock limit with partial results retained.

Repo import is read-only in v1. No graph→code editing for traced repos — the mapping from trace back to source is many-to-one and unsafe to invert.

---

## 8. Debugging

This is the feature that justifies the whole mode. Everything above is infrastructure for this section.

### 8.1 Data inspection at every edge

Clicking an edge shows what flowed through it at the last run: shape, dtypes, memory, null counts per column, head/tail preview, per-column summary stats.

In a notebook, answering "what did `df` look like between cell 4 and cell 5" requires editing the notebook. Here it's a click. That difference is the product.

### 8.2 Diff between nodes

Select two nodes, get a structural diff of the data at each:

```
Rows:     74,112 → 71,205   (-2,907, -3.9%)
Columns:  18 → 24           (+6)
  added:    plan_type_basic, plan_type_plus, plan_type_pro, tenure_bucket, …
  removed:  customer_id, signup_date
  retyped:  churned: object → bool
Nulls:    1,203 → 0
Memory:   42.1 MB → 38.7 MB
```

Answers "which step dropped my rows" instantly. This is the single most common tabular debugging question and no notebook answers it without manual work.

### 8.3 Selective re-execution

| Action | Behaviour |
|---|---|
| **Run node** | Execute this block only, with current kernel state |
| **Run to here** | Execute all ancestors in dependency order, then this node |
| **Run from here** | This node and all descendants |
| **Run stale only** | Only nodes whose code changed or whose upstream changed |

**Staleness propagation (MUST):** editing a node marks it and all descendants stale. This is the single biggest correctness win over Jupyter, where nothing tells you that cell 12 is now invalid because you edited cell 3.

### 8.4 Snapshots

Before each node executes, capture a lightweight snapshot of tracked variables: shape, dtypes, hash, plus a configurable N-row sample. Stored locally in the project's `.flowlab/` directory, capped by size with LRU eviction.

Enables: scrub back to any node's state, compare the same node across two runs, and "this worked an hour ago" recovery.

Full object serialisation is **not** attempted. Snapshots are metadata plus samples. Pickling arbitrary user objects is slow, fragile and a security problem.

### 8.5 Exception handling

On failure: the node turns red, the traceback renders inline with frames mapped to graph nodes where possible, the kernel state is preserved, and a **Debug here** action opens a REPL bound to the failing node's scope so the user can poke at the actual variables.

### 8.6 Hidden-state detection

The notebook's worst failure mode, made visible:

- **Out-of-order execution warning** — node executed before an ancestor
- **Orphan variables** — names in the kernel not defined by any current block (left over from deleted code). Listed with a "clean kernel" action
- **Mutation warnings** — a node mutated an object another node depends on
- **Stale imports** — a module was edited on disk after import; offer `importlib.reload` or a kernel restart

### 8.7 Profiling

Per node: wall time, peak memory delta, rows in/out. Canvas heat-map view colours nodes by time or memory, so the bottleneck is visible without instrumenting anything.

---

## 9. UI additions

### 9.1 Layout

```
┌────────┬──────────────────────────────────┬──────────────┐
│ Files  │  Canvas (graph projection)       │  Inspector   │
│ tree   │                                  │  ├ Code      │
│        │  [import]──[load]──[clean]       │  ├ Data      │
│ Kernel │              │        │          │  ├ Diff      │
│ status │              └──[split]──[model] │  └ Profile   │
│        │                                  │              │
│ RAM ▓▓░│  ⚠ 2 mutation warnings           │              │
├────────┴──────────────────────────────────┴──────────────┤
│ Console — stdout, stderr, execution log                   │
└───────────────────────────────────────────────────────────┘
```

### 9.2 Views

- **Graph view** — default; nodes and edges
- **Linear view** — classic notebook, cells in source order, for users who want familiarity
- **Split view** — graph and linear side by side, synchronised selection

**MUST** ship linear view. Forcing a graph on someone who wants a notebook loses the user in the first minute.

### 9.3 Node rendering

Each node shows: label (from the pattern match, a leading comment, or the first assignment target), state (idle/running/success/error/stale), confidence border, output summary (`74,112 × 18`), execution time, and warning badges.

### 9.4 Canvas requirements specific to this mode

- **Auto-layout** on load (dagre, top-to-bottom), because imported graphs have no stored positions
- **Collapse groups** — fold a function or module into a single node
- **Focus mode** — dim everything not connected to the selected node. Essential above 50 nodes
- **Search** by variable name, highlighting the defining node and all consumers

---

## 10. Data model additions

### 10.1 CodeGraph

Distinct from Flow Spec — it is derived, not authored:

```jsonc
{
  "graph_version": "1.0",
  "project_id": "prj_01H...",
  "source": {
    "kind": "notebook" | "script" | "repo_trace",
    "files": [{ "path": "analysis.ipynb", "hash": "sha256:…" }],
    "trace_command": "python train.py --config dev.yaml",
    "traced_at": "2026-09-14T14:32:00Z"
  },
  "nodes": [
    {
      "id": "b4",
      "file": "analysis.ipynb",
      "cell_index": 4,
      "lines": [45, 61],
      "source": "X_train, X_test, y_train, y_test = train_test_split(...)",
      "label": "Train/test split",
      "defines": ["X_train", "X_test", "y_train", "y_test"],
      "uses": ["df", "target_col"],
      "mutates": [],
      "side_effects": [],
      "matched_pattern": "prep.split",
      "confidence": "high"
    }
  ],
  "edges": [
    { "from": "b2", "to": "b4", "variable": "df",
      "kind": "dataflow" | "mutation" | "alias" | "import",
      "confidence": "high" }
  ],
  "warnings": [
    { "node_id": "b6", "code": "MUTATION_SHARED_OBJECT",
      "message": "This block mutates `df`, which b8 also reads",
      "severity": "warning" }
  ],
  "environment": { "python": "3.11.8", "packages": { "pandas": "2.2.0" } }
}
```

**MUST:** CodeGraph is cached, never authoritative. If the source hash doesn't match, discard and re-analyse.

### 10.2 Database additions

```sql
code_projects(id, workspace_id, name, local_path, agent_id,
              source_kind, created_by, created_at, last_opened_at)

code_graphs(id, project_id, source_hash, graph JSONB, analysed_at)

code_sessions(id, project_id, agent_id, kernel_id, status,
              environment JSONB, started_at, ended_at)

code_executions(id, session_id, node_id, source_hash, status,
                started_at, duration_ms, peak_memory_mb,
                stdout_ref, stderr_ref, exception JSONB)

code_snapshots(id, execution_id, variable_name, shape, dtypes JSONB,
               null_counts JSONB, sample_ref, content_hash, created_at)
```

**MUST:** `local_path` is a reference, not a copy. FlowLab never stores the user's files server-side in Code Mode. `sample_ref` points at local storage under `.flowlab/` unless the user has explicitly enabled preview upload.

---

## 11. API additions

```
POST   /v1/code-projects                  { agent_id, local_path, name }
GET    /v1/code-projects
GET    /v1/code-projects/{id}
DELETE /v1/code-projects/{id}

GET    /v1/code-projects/{id}/files       Tree from the agent
GET    /v1/code-projects/{id}/graph       ?file= | ?trace_id=
POST   /v1/code-projects/{id}/analyse     Force re-analysis
POST   /v1/code-projects/{id}/trace       { command, timeout_s }

POST   /v1/code-projects/{id}/transform   { op, node_ids, params }
                                          reorder|split|merge|delete|duplicate|extract
POST   /v1/code-projects/{id}/blocks/{node_id}/source   Save edited code

POST   /v1/code-sessions                  Start kernel
DELETE /v1/code-sessions/{id}             Shut down kernel
POST   /v1/code-sessions/{id}/restart
POST   /v1/code-sessions/{id}/interrupt
GET    /v1/code-sessions/{id}/variables   Kernel namespace summary

POST   /v1/code-sessions/{id}/execute     { node_ids, mode: node|to|from|stale }
POST   /v1/code-sessions/{id}/cancel

GET    /v1/code-executions/{id}/snapshot  ?variable=
POST   /v1/code-executions/diff           { execution_a, execution_b }

POST   /v1/code-projects/{id}/to-flow     { node_ids } → Flow Spec (Phase 11)
POST   /v1/flows/{id}/eject               ?format=ipynb|py (Phase 9)

WS     /v1/ws/code-sessions/{id}          Execution events, stdout, kernel status
```

---

## 12. Security

Code Mode executes the user's own code on the user's own machine, which is a fundamentally different trust model from Part I.

| Concern | Position |
|---|---|
| **Arbitrary code execution** | The user's own code, on their own machine, at their own initiative. FlowLab is not a sandbox and MUST NOT claim to be. Say so plainly in the docs |
| **Agent binding** | `127.0.0.1` only. Never `0.0.0.0`. No inbound ports |
| **Agent authentication** | Attach token, short-lived, single-use, workspace-scoped, same as Part I |
| **Path traversal** | The agent serves files only under the project root. Symlinks resolved and checked against the root |
| **Code transmission** | Source text is sent to render in the editor. This includes any hardcoded secrets in the user's code. **MUST** warn on first project open, and scan for obvious credential patterns and mask them in transit |
| **Preview data** | Off by default in Local-only mode; capped at 100 rows otherwise; never logged server-side |
| **Snapshots** | Stored under the project's `.flowlab/`. **MUST** add `.flowlab/` to `.gitignore` automatically on project init |
| **Transformations** | Every source transformation writes a backup to `.flowlab/backups/` before applying. Users must be able to recover from a bad drag |

---

## 13. Failure modes

Named explicitly so they can be tested and so the UI can handle them well rather than silently.

| Failure | Handling |
|---|---|
| Analyser can't parse a file (syntax error) | Show the parse error at the line; render other files normally |
| Graph is wrong because of dynamic code | Confidence badges; a "report incorrect graph" action that ships the anonymised AST for improving the ruleset |
| Reorder breaks the code despite validation | `.flowlab/backups/` and one-click revert |
| Kernel dies (OOM) | Detect, show last memory reading, offer restart with a note on which node exceeded RAM |
| File edited externally mid-session | File-watch triggers re-analysis; if a node was mid-edit, show a conflict prompt |
| Repo trace times out | Keep partial graph, label it partial, offer a longer timeout or a sampled dataset |
| Notebook relies on out-of-order execution | Warn on open: "This notebook's saved outputs don't match its source order" |
| Agent version older than the API | Version negotiation on attach; prompt to upgrade with the exact pip command |

---

## 14. Testing

| Level | Coverage |
|---|---|
| **Analyser unit** | A corpus of Python snippets with hand-labelled expected graphs. Every construct in Section 2.1 has a test asserting the *correct degraded behaviour*, not a correct graph |
| **Real-notebook corpus** | 50 public Kaggle notebooks. Assert: no crashes, no empty graphs, and manual spot-check of graph correctness on 10 |
| **Transformation round-trip** | For each op: apply, assert the file still parses, assert AST equivalence where the op should be semantics-preserving, assert formatting preserved byte-for-byte outside the touched region |
| **Reorder safety** | Property test: random reorderings either are refused or produce code whose execution yields identical results |
| **Kernel integration** | Execute, interrupt, restart, OOM recovery, stale propagation |
| **Trace** | Fixture repos with known dataflow; assert the traced graph matches |
| **Privacy** | Assert that with Local-only mode on, no dataframe content appears in any outbound payload. This is an automated test, not a policy |

---

## 15. Build plan

Slots in after Part I Phase 5. Part I Phases 6–7 can proceed in parallel or after.

### Phase 8 — Local agent and kernel (3 weeks)

- `flowlab-lab` package: kernel mode via `jupyter_client`, file indexing, file watching
- Localhost binding, attach-token auth, outbound WS
- Environment and resource capture
- Execute a block, stream stdout/stderr, capture variable summaries
- `code_projects`, `code_sessions`, `code_executions` tables and API

**DoD:** attach to a local directory, start a kernel, execute a notebook cell from the API, see output stream to the client, see live RAM.

### Phase 9 — Tier A + C analyser and canvas (4 weeks)

- AST-based block segmentation for `.ipynb` and `# %%` scripts
- Symbol analysis: defines/uses/mutates/imports/side-effects
- Edge construction with redefinition, mutation and alias handling
- Confidence annotation
- Canvas rendering with graph / linear / split views
- Monaco node editor with save-to-disk
- Staleness propagation, run node / to / from / stale
- Flow → Code eject

**DoD:** open a real 40-cell Kaggle notebook, get a correct dependency graph in under 500 ms, edit a cell and watch edges change, run-to-here executes only ancestors, editing an upstream cell marks descendants stale.

### Phase 10 — Debugging (3 weeks)

- Edge data inspection, per-column summaries, previews
- Node-to-node structural diff
- Snapshots in `.flowlab/` with LRU eviction
- Inline tracebacks with frame→node mapping, Debug-here REPL
- Hidden-state detection: out-of-order, orphans, mutations, stale imports
- Profiling and the heat-map view

**DoD:** with a notebook that silently drops rows, a user locates the offending step via the diff view in under a minute without editing any code.

### Phase 11 — Transformations, Tier B, repo tracing (4 weeks)

- `libcst`-based transformations: reorder, split, merge, delete, duplicate, extract
- Dependency-safety validation with clear refusal messages
- Backups and undo
- Tier B pattern ruleset (~40 patterns covering pandas/sklearn/scipy/plotting)
- Code → Flow conversion for recognised contiguous sections
- Repo tracing: `sys.settrace` instrumentation, trace→graph, group rendering

**DoD:** drag a cell to a new position and the file is rewritten with formatting intact; a dependency-violating drag is refused with the blocking edge named; a fixture repo traces to a correct graph.

---

## 16. Success metrics

| Metric | Target |
|---|---|
| Analyser: notebooks parsed without crash (50-notebook corpus) | 100% |
| Analyser: graphs rated correct on manual review | ≥85% |
| Time to render graph, 100-cell notebook | <500 ms p95 |
| Transformation: file still parses after op | 100% |
| Transformation: formatting preserved outside touched region | 100% |
| Users who import a notebook and run at least one node | ≥60% |
| Users who use diff or snapshot view in their first session | ≥30% |
| Kernel crash rate per session | <2% |

The two that actually matter: **graph correctness on real notebooks**, because a wrong graph is worse than no graph; and **transformation safety**, because corrupting someone's file once loses them permanently.

---

## 17. Open questions

1. **Does the graph earn its place for short notebooks?** A 15-cell linear notebook has a boring graph. The value appears somewhere around 30+ cells with branching. Should Code Mode default to linear view below a complexity threshold?
2. **VS Code extension instead of a web canvas?** The users most likely to want this already live in an editor. A web UI asks them to leave it. An extension is more work but meets them where they are. Worth prototyping both cheaply before committing to Phase 9's UI.
3. **Marimo overlap.** Marimo already does reactive dependency-DAG Python notebooks and does it well. Is FlowLab's differentiator the debugging layer (Section 8) and the bridge to Flow Mode, or is it competing head-on? Decide before Phase 9, because it changes what to build.
4. **Should Tier B convert automatically?** Auto-converting recognised code into declarative Flow nodes is magical when right and infuriating when wrong. Current spec says never automatic. Revisit after measuring pattern precision.
5. **Repo tracing overhead** — is 2–10× acceptable, or is a sampling profiler approach (lower fidelity, near-zero overhead) the better default?
6. **Multi-file notebooks and `%run`** — does the analyser follow across files in Tier A, or is that strictly Tier D?
7. **Does Local-only mode break the agent?** Part I's LLM features need to see *something*. Profile digests contain column names and statistics. Is that acceptable under Local-only, or does Local-only also mean no agent?