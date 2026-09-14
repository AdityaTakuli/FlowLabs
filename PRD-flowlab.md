# FlowLab — Product Requirements Document

**Working codename:** FlowLab (rename before public work)
**Version:** 0.1 (draft for implementation)
**Status:** Ready for phased build
**Primary reader:** Claude Code (implementation agent) and the founding developer
**Last updated:** 2026-09-14

---

## 0. How to use this document

This PRD is written to be handed directly to a coding agent. It is organised so that each section maps to something buildable:

- Sections 1–4 are context and constraints. Read once, do not skip Section 4 — it changes the architecture.
- Section 5–9 are the system contracts. These are normative. Do not deviate without updating this doc.
- Section 10–14 are feature specs.
- Section 15–20 are quality, security and delivery.
- Section 21 is the phased build plan. **Start at Phase 0.** Each phase has a Definition of Done that must pass before moving on.

Where this document says **MUST**, it is a hard contract. **SHOULD** is a strong default that can be traded away with a written reason in the repo's `docs/decisions/` folder.

---

## 1. Problem and product summary

### 1.1 The problem

Roboflow made computer-vision data work tractable by putting dataset management, preprocessing, augmentation, training and deployment into one visual product. Nothing equivalent exists for **tabular, statistical and classical-ML data work**, which is the majority of real-world data problems.

Today a person doing tabular ML or statistical analysis has to:

- move data between storage, notebooks and BI tools by hand
- rewrite the same cleaning code (nulls, outliers, encoding, scaling) every project
- make judgement calls (which imputation? which test? is this leakage?) with no guardrails
- lose all of it the moment the notebook is closed — no lineage, no reproducibility, no shareable artifact

Notebooks are flexible but unstructured. BI tools are structured but can't model or transform. AutoML tools are opaque black boxes that produce a model but no understanding.

### 1.2 The product

FlowLab is a **visual, node-graph workspace for tabular data**, where a user connects a dataset to preprocessing, statistical analysis, modelling and visualisation nodes, runs the graph, and gets back charts, statistics, trained models and a narrated explanation of what happened and why.

Two ways to build a graph:

1. **Manually** — drag nodes onto a canvas, wire them, set parameters.
2. **By prompt** — describe the goal in natural language ("find what drives churn in this table and build me a model I can explain to a non-technical manager"). An agent inspects the dataset's real schema and statistics, and emits a complete graph. The user can then edit any node before running.

The graph is the product. It is inspectable, editable, versioned, re-runnable and shareable. The LLM is an accelerator on top of it, never a replacement for it.

### 1.3 One-line positioning

> Roboflow for structured data — a visual pipeline builder for cleaning, analysing, testing and modelling tabular datasets, with an agent that can build the pipeline for you and explain every decision.

---

## 2. Goals and non-goals

### 2.1 Goals (v1)

| # | Goal | Measured by |
|---|---|---|
| G1 | A user can go from a raw CSV to a cleaned dataset, a set of charts with written insights, and a trained evaluated model, without writing code | End-to-end demo flow completes in under 10 minutes |
| G2 | Every run is reproducible and inspectable — same graph + same data = same result, with full lineage | Re-run of a saved graph produces byte-identical artifact hashes |
| G3 | An agent can produce a valid, runnable graph from a prompt plus a dataset | ≥80% of eval prompts produce a graph that validates and runs without manual edits |
| G4 | The system runs real workloads without FlowLab owning GPUs or heavy compute | A run executes on a user-attached runtime (local machine or Colab session) |
| G5 | Statistical rigour is enforced, not optional | Leakage detection, assumption checks on tests, and train/test discipline are enforced by the compiler, not by the user remembering |

### 2.2 Non-goals (v1)

- **Deep learning / computer vision / NLP training.** Explicitly out. The whole point is the neglected tabular/statistical half. A `CustomScript` escape hatch may exist later, but no CV/NLP node catalogue in v1.
- **Real-time / streaming data.** Batch only.
- **Model serving / deployment endpoints.** v1 exports an artifact (joblib/ONNX) and stops there.
- **Data warehouse replacement.** FlowLab reads from storage; it is not a database.
- **Multi-user real-time collaborative editing** (Figma-style cursors). Sharing and cloning yes, live co-editing no.
- **FlowLab-owned GPU compute.** See Section 4.

### 2.3 Explicit anti-goals

- Do not build an AutoML black box. If the agent picks random forest over logistic regression, the graph must *show* that choice as an editable node and the narration must say why.
- Do not let the LLM emit raw Python that gets executed. See Section 10.4.

---

## 3. Users and use cases

### 3.1 Personas

**P1 — The applied ML student / early engineer (primary).**
Comfortable with pandas and sklearn, tired of rewriting the same 200 lines. Wants structure, speed and something portfolio-worthy. Will notice and care if the statistics are sloppy.

**P2 — The analyst who doesn't write much code (secondary).**
Lives in Excel and BI dashboards. Can reason about data but not implement. Wants charts, tests and a defensible answer to "is this difference real?"

**P3 — The domain researcher (secondary).**
Has a dataset from an experiment or survey. Needs correct statistical tests with assumptions checked, and publishable figures. Does not want a black-box model.

### 3.2 Core user journeys

**J1 — Manual pipeline build**
Connect storage → pick dataset → drag `Source → Profile → Clean → Split → Encode → Model → Evaluate` → run → inspect metrics and charts → tweak a node → re-run → compare runs side by side.

**J2 — Prompt-to-graph**
Pick dataset → type goal → agent profiles the data and proposes a graph with a written plan → user reviews/edits → run → narrated results.

**J3 — Pure analysis, no modelling**
Pick dataset → "show me what's interesting in here" → agent produces a profiling + distribution + correlation + hypothesis-test graph → user gets a chart gallery, each chart with a written finding.

**J4 — Reuse**
Save a graph as a template → apply it to a different dataset with compatible schema → the compiler reports which columns don't match and what needs remapping.

---

## 4. Key decisions, constraints and risks

**Read this section before designing anything.** Three constraints from the product concept need honest treatment.

### 4.1 Google Colab as a compute backend

The stated plan: users link their Google account, and Colab acts as the runtime because FlowLab can't afford cloud servers.

**What is actually true:**

- Colab has **no official API for programmatic job submission.** There is no supported "send this job to a Colab session" endpoint. Anything that works does so by having the user open a notebook and run a cell that connects *outbound* to your backend.
- Colab's terms restrict using sessions for remote control, for running services, and for chaining sessions as general-purpose compute for a third-party product. **A SaaS that uses users' free Colab sessions as its execution fleet is, at minimum, in a grey area and plausibly a ToS violation.** Google can and does kill sessions for this pattern.
- Free Colab sessions have hard limits: ~12h maximum lifetime, ~90 min idle timeout, variable RAM (~12 GB standard), and GPU quota that disappears without warning.

**Design decision (MUST):**

The system MUST NOT be built assuming Colab. It MUST be built against a **`RuntimeAdapter` interface** (Section 8) with multiple implementations. Colab is one *optional, user-initiated, bring-your-own* adapter, clearly labelled as best-effort.

**Recommended runtime priority:**

| Priority | Runtime | Why |
|---|---|---|
| 1 | **Local runner** (user's own machine, one `pip install` + one command) | No ToS risk, no session limits, no cost to you, and for tabular data a laptop beats a free Colab CPU session. This should be the default. |
| 2 | **In-browser** (DuckDB-WASM + Pyodide) for datasets under ~50 MB | Zero infrastructure, instant feedback, no attachment step at all. Covers a huge fraction of real tabular work. |
| 3 | **Colab adapter** | Offered for users who want it, with the limits stated in the UI. |
| 4 | **Managed compute** (Modal / Fly / a small VPS) | Add when there's revenue. |

A blunt observation worth internalising: **tabular ML almost never needs a GPU.** Gradient boosting on a 500k-row dataset runs fine on a laptop CPU. The compute constraint that made Colab feel necessary largely doesn't apply to this product. Treat GPU access as a nice-to-have, not a foundation.

### 4.2 "Code is not shown or downloaded"

The stated plan: the user's Colab runs the training, but the code is hidden from them.

**What is actually true:** code that executes inside a runtime the user controls is code the user can read. A Python package can be inspected, a process can be traced, a notebook's memory can be dumped. Obfuscation raises effort; it does not create a boundary. Any design that depends on client-side secrecy will fail.

**Design decision (MUST):** treat the runner as **untrusted and fully visible.** Put the defensible value server-side:

- **Server-side (proprietary, never shipped):** the agent's planning logic, prompts, the node-selection heuristics, the validator/leakage rules, the insight-narration layer, the run history and lineage graph.
- **Client-side (shipped as an open-ish pip package):** node implementations, which are thin wrappers over pandas/polars/sklearn/statsmodels. There is nothing secret in `StandardScaler().fit_transform()`.

Practical mitigations that are worth doing anyway: ship wheels rather than source, Cython-compile any genuinely novel numeric routine, require a per-job license token validated server-side, and state the restriction in the ToS. But do not architect around the assumption that it holds.

### 4.3 LLM-generated pipelines

Letting an LLM write and execute arbitrary Python is the fast path to a demo and the fast path to arbitrary code execution, silent data leakage, and unreproducible results.

**Design decision (MUST):** the agent emits a **Flow Spec** (Section 6) — structured JSON constrained to a registered node catalogue with typed parameters. It never emits executable code. The spec is validated and type-checked against the real dataset schema before anything runs. Invalid specs go back to the agent with structured errors for repair, up to N attempts, then surface to the user.

### 4.4 Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Colab ToS enforcement kills the runtime | High | Runtime abstraction; local runner is default (4.1) |
| Agent produces plausible-but-wrong statistics | High | Compiler-enforced assumption checks and leakage detection (Sections 7.5, 8.5); narration must cite which check passed |
| Scope sprawl into deep learning | High | Non-goals are binding; `CustomScript` node deferred to post-v1 |
| OAuth token compromise (Drive/Dropbox) | High | Encrypted at rest with per-tenant keys, minimum scopes, short-lived, revocable (Section 15) |
| Large datasets exceed runner memory | Medium | Polars/DuckDB streaming backend; size tiers with explicit limits per runtime |
| LLM cost per prompt-to-graph | Medium | Profile summaries not raw data in the prompt; cache profiles by content hash; BYO API key option |
| Reproducibility drift from library versions | Medium | Runner pins its dependency set; version recorded in every run record |

---

## 5. System architecture

### 5.1 Components

```
┌─────────────────────────────────────────────────────────┐
│  Web app (React + TypeScript)                           │
│  Canvas (React Flow) · Param forms · Chart & run viewer  │
└───────────────┬─────────────────────────────────────────┘
                │ REST + WebSocket
┌───────────────▼─────────────────────────────────────────┐
│  API (FastAPI, Python 3.11+)                            │
│  ├─ Auth & tenancy                                       │
│  ├─ Dataset & connector service                          │
│  ├─ Flow service (CRUD, versioning)                      │
│  ├─ Compiler  (spec → validated execution plan)          │
│  ├─ Orchestrator (job queue, scheduling, streaming)      │
│  ├─ Agent service (planner / validator / narrator)       │
│  └─ Artifact & run registry                              │
└───┬────────────────┬──────────────────┬─────────────────┘
    │                │                  │
┌───▼─────┐   ┌──────▼──────┐   ┌───────▼────────┐
│Postgres │   │ Redis       │   │ Object storage │
│metadata │   │ queue+cache │   │ artifacts      │
└─────────┘   └──────┬──────┘   └────────────────┘
                     │ job protocol (WS, outbound from runner)
       ┌─────────────┼─────────────┬──────────────┐
┌──────▼─────┐ ┌─────▼──────┐ ┌────▼─────┐ ┌──────▼──────┐
│Local runner│ │Colab runner│ │ Browser  │ │ Managed     │
│(default)   │ │(BYO)       │ │(WASM)    │ │ (later)     │
└────────────┘ └────────────┘ └──────────┘ └─────────────┘
```

### 5.2 Technology choices

| Layer | Choice | Reason |
|---|---|---|
| Frontend | React 18 + TypeScript + Vite | Ecosystem for graph editors |
| Canvas | **React Flow (xyflow)** | Purpose-built node editor; custom node types, handles, minimap out of the box |
| State | Zustand + TanStack Query | Canvas state is local-heavy; server state cached separately |
| Forms | React Hook Form + **JSON-Schema-driven rendering** | Node param forms are generated from the node catalogue, never hand-written per node |
| Charts | **Vega-Lite** | Charts are specs, not images — portable, themeable, small over the wire, agent-generatable |
| Styling | Tailwind + shadcn/ui | Fast, consistent |
| API | FastAPI + Pydantic v2 | Pydantic models are the single source of truth for the Flow Spec |
| DB | PostgreSQL 15 + SQLAlchemy + Alembic | Relational metadata, JSONB for specs |
| Queue | Redis + RQ (or Celery if it grows) | Simple, sufficient |
| Dataframe | **Polars** primary, pandas for interop | Larger-than-memory streaming, fast, strict typing |
| SQL/analytics | **DuckDB** | Profiling, aggregation, joins over Parquet without loading into RAM |
| ML | scikit-learn, XGBoost, LightGBM, statsmodels, scipy, pingouin | Covers classical ML + proper statistics |
| Explainability | SHAP | Feature attribution |
| Artifacts | Parquet (tabular), JSON (metrics/specs), joblib + ONNX (models) | Columnar, portable |
| LLM | Provider-abstracted (`LLMClient` interface); Claude as default | Swappable, BYO-key supported |
| Auth | OAuth2 (Google, GitHub) + email magic link; JWT sessions | Standard |

### 5.3 Key architectural principles

1. **The Flow Spec is the contract.** UI, agent and executor all read and write the same JSON. Nothing bypasses it.
2. **The compiler is the safety layer.** Type-checking, leakage detection and assumption validation happen before execution, on the server, where the rules can't be edited by the client.
3. **Runtimes are pluggable and untrusted.** They receive a step plan and artifact URIs; they return artifacts and metrics. They never receive credentials to anything but a scoped upload path.
4. **Everything is content-addressed.** Node outputs are cached by hash of `(node_type, params, input_hashes, runner_version)`. Re-running an unchanged upstream node is free.
5. **Server-side value, client-side execution.** See 4.2.

---

## 6. The Flow Spec (normative)

The central data structure. A Flow Spec is a DAG describing a complete analysis.

### 6.1 Schema

```jsonc
{
  "spec_version": "1.0",
  "flow_id": "flw_01H...",
  "name": "Churn drivers + baseline model",
  "description": "Agent-generated from prompt on 2026-09-14",
  "created_by": "agent" | "user",
  "dataset_bindings": {
    "primary": "ds_01H..."          // logical name → dataset id
  },
  "nodes": [
    {
      "id": "n1",
      "type": "source.dataset",
      "label": "Customers",
      "params": { "dataset_ref": "primary" },
      "position": { "x": 40, "y": 120 }
    },
    {
      "id": "n2",
      "type": "clean.impute",
      "label": "Impute missing",
      "params": {
        "columns": ["tenure_months", "monthly_charges"],
        "strategy": "median"
      },
      "position": { "x": 300, "y": 120 }
    },
    {
      "id": "n3",
      "type": "prep.split",
      "params": { "test_size": 0.2, "stratify_by": "churned", "seed": 42 },
      "position": { "x": 560, "y": 120 }
    }
  ],
  "edges": [
    { "id": "e1", "source": "n1", "source_port": "out",
      "target": "n2", "target_port": "in" },
    { "id": "e2", "source": "n2", "source_port": "out",
      "target": "n3", "target_port": "in" }
  ],
  "meta": {
    "seed": 42,
    "generated_from_prompt": "what drives churn here?",
    "agent_plan": "1. Profile … 2. Impute … 3. …"
  }
}
```

### 6.2 Rules (MUST)

- Node `id` is unique within a flow. Node `type` MUST exist in the node catalogue.
- The graph MUST be acyclic. Cycles are a compile error.
- `params` MUST validate against the node type's JSON Schema.
- Every non-source node MUST have all required input ports connected.
- Ports are typed. An edge MUST connect compatible port types (Section 6.3).
- `position` is UI-only and MUST NOT affect execution or the cache key.
- Flow Specs are **versioned and immutable once run.** Editing a run flow creates a new version.

### 6.3 Port types

| Port type | Payload | Artifact format |
|---|---|---|
| `table` | Tabular data + schema | Parquet |
| `table_split` | Named tables (train/test/val) | Parquet set |
| `model` | Fitted estimator + fit metadata | joblib / ONNX |
| `transformer` | Fitted preprocessing object | joblib |
| `metrics` | Scalar metrics dict | JSON |
| `chart` | Vega-Lite spec + narration | JSON |
| `report` | Ordered collection of charts/metrics/text | JSON |

### 6.4 The dataset schema contract

Every `table` artifact carries an inferred schema that the compiler type-checks against:

```jsonc
{
  "columns": [
    { "name": "tenure_months", "dtype": "int64", "role": "feature",
      "semantic": "numeric_continuous", "nullable": true, "null_frac": 0.03,
      "cardinality": 72, "stats": { "min": 0, "max": 72, "mean": 32.4, "std": 24.1 } },
    { "name": "plan_type", "dtype": "string", "role": "feature",
      "semantic": "categorical_nominal", "cardinality": 4 },
    { "name": "churned", "dtype": "bool", "role": "target",
      "semantic": "binary", "class_balance": { "true": 0.26, "false": 0.74 } }
  ],
  "row_count": 74112,
  "content_hash": "sha256:…"
}
```

`semantic` is inferred (numeric_continuous, numeric_discrete, categorical_nominal, categorical_ordinal, binary, datetime, text_free, identifier, geo) and is what the agent reasons over. It MUST be user-overridable in the UI — inference will sometimes be wrong, and the user must be able to say "this integer is actually a category."

---

## 7. Node catalogue

Each node MUST ship with: a JSON Schema for params, typed input/output ports, a pure `execute()` implementation, a docstring explaining the technique and when it's appropriate, and unit tests with fixture data.

### 7.1 Source & sink

| Type | Purpose | Key params |
|---|---|---|
| `source.dataset` | Load a registered dataset | `dataset_ref` |
| `source.sql` | Query a connected DB/DuckDB over files | `query`, `connection_ref` |
| `source.join` | Join two tables | `how`, `left_on`, `right_on` |
| `sink.export` | Write result to storage | `format`, `destination`, `path` |
| `sink.report` | Assemble a shareable report | `title`, `sections` |

### 7.2 Profiling & quality

| Type | Purpose |
|---|---|
| `profile.overview` | Row/col counts, dtypes, memory, head sample |
| `profile.missingness` | Null counts, patterns, missingness correlation matrix |
| `profile.distributions` | Per-column histograms/KDE, skew, kurtosis |
| `profile.cardinality` | Unique counts, constant and near-constant column detection |
| `profile.duplicates` | Exact and fuzzy duplicate detection |
| `quality.assert` | User-defined data assertions; fails the run when violated |

### 7.3 Cleaning

| Type | Key params |
|---|---|
| `clean.drop_columns` | `columns`, or rule-based (`null_frac >`, `cardinality ==`) |
| `clean.drop_rows` | `condition` |
| `clean.impute` | `columns`, `strategy` (mean/median/mode/constant/ffill/knn/iterative) |
| `clean.outliers` | `method` (iqr/zscore/isolation_forest/lof), `action` (flag/clip/remove) |
| `clean.dedupe` | `subset`, `keep` |
| `clean.cast` | `column`, `to_dtype`, `on_error` |
| `clean.text_normalize` | `columns`, `lowercase`, `strip`, `collapse_whitespace` |
| `clean.datetime_parse` | `column`, `format`, `timezone` |

### 7.4 Transform & feature engineering

| Type | Notes |
|---|---|
| `prep.split` | train/test/val; `stratify_by`, `group_by`, `time_based`, `seed` |
| `prep.encode` | onehot / ordinal / target / frequency / binary. **Fit on train only.** |
| `prep.scale` | standard / minmax / robust / quantile. **Fit on train only.** |
| `prep.balance` | SMOTE / random over / random under. **Train split only — compiler enforces.** |
| `feature.derive` | Expression-based new columns (safe expression parser, not `eval`) |
| `feature.datetime_parts` | year/month/dow/hour/is_weekend extraction |
| `feature.binning` | equal-width / equal-freq / custom edges |
| `feature.interactions` | Polynomial / pairwise products |
| `feature.select` | variance threshold / correlation filter / mutual info / RFE / L1 |
| `feature.reduce` | PCA / t-SNE / UMAP (t-SNE and UMAP for visualisation only, never as model input) |

### 7.5 Statistical analysis

This section is the product's differentiator. Every test node MUST run and report its **assumption checks** alongside the result, and MUST report an **effect size**, not just a p-value.

| Type | Assumptions checked | Effect size |
|---|---|---|
| `stat.descriptive` | — | — |
| `stat.normality` (Shapiro–Wilk, K–S, Anderson–Darling) | — | — |
| `stat.ttest` (one/two-sample, paired, Welch) | normality, equal variance (Levene) | Cohen's d |
| `stat.mannwhitney` | independence | rank-biserial r |
| `stat.anova` (one/two-way) | normality of residuals, homoscedasticity | η², ω² |
| `stat.kruskal` | independence | ε² |
| `stat.posthoc` (Tukey, Dunn, Bonferroni) | follows ANOVA/Kruskal | — |
| `stat.chisquare` (independence, goodness-of-fit) | expected cell counts ≥5 | Cramér's V |
| `stat.correlation` (Pearson/Spearman/Kendall) | linearity, monotonicity | r with CI |
| `stat.regression` (OLS/logit) | linearity, independence, homoscedasticity, normality of residuals, VIF multicollinearity | R², adj-R², pseudo-R² |
| `stat.timeseries` (ADF stationarity, ACF/PACF, seasonal decompose) | — | — |
| `stat.power` | — | required n / achieved power |

**MUST:** when an assumption fails, the node emits a warning in its output *and* the narration layer states the failure plainly and names the appropriate alternative test. Never silently report a parametric p-value on data that violated its assumptions.

### 7.6 Modelling

| Type | Notes |
|---|---|
| `model.fit` | Family + algorithm + hyperparameters. Families: linear, tree, ensemble, boosting, svm, knn, naive_bayes, clustering |
| `model.tune` | grid / random / bayesian (optuna); `cv_folds`, `scoring`, `n_trials`, `timeout` |
| `model.cross_validate` | k-fold / stratified / group / time-series split |
| `model.predict` | Apply fitted model to a table |
| `model.evaluate` | Task-appropriate metrics + confusion matrix / residual plots / ROC / PR / calibration |
| `model.explain` | SHAP global + local, permutation importance, partial dependence |
| `model.compare` | Side-by-side metrics across multiple model nodes |
| `model.export` | joblib / ONNX / PMML |

Supported algorithms v1: LinearRegression, Ridge, Lasso, ElasticNet, LogisticRegression, DecisionTree, RandomForest, ExtraTrees, GradientBoosting, XGBoost, LightGBM, SVM (SVC/SVR), KNN, GaussianNB, KMeans, DBSCAN, HierarchicalClustering, IsolationForest, ARIMA/SARIMAX, Prophet (optional dependency).

### 7.7 Visualisation

All visualisation nodes emit a **Vega-Lite spec plus a narration string**. This satisfies "every graph tells something" — no chart is emitted without a written finding.

| Type | Charts |
|---|---|
| `viz.distribution` | histogram, KDE, box, violin, ECDF, Q-Q |
| `viz.comparison` | bar, grouped bar, stacked bar, dot plot, lollipop |
| `viz.relationship` | scatter (+ trendline, + confidence band), hexbin, pair plot, bubble |
| `viz.composition` | pie, donut, treemap, stacked area, sunburst |
| `viz.trend` | line, multi-series line, area, candlestick, seasonal decomposition plot |
| `viz.matrix` | correlation heatmap, confusion matrix, missingness matrix |
| `viz.model` | ROC, PR curve, calibration curve, residual plot, learning curve, SHAP beeswarm/waterfall |
| `viz.geo` | choropleth, point map (if geo semantic detected) |
| `viz.custom` | Direct Vega-Lite spec passthrough for power users |

**Narration contract (MUST):** every chart artifact carries `{ "spec": {...}, "narration": "...", "narration_basis": {...} }` where `narration_basis` holds the computed values the narration is derived from. The narration layer MUST only reference numbers present in `narration_basis`. This prevents the LLM from inventing findings.

### 7.8 Control & utility

| Type | Purpose |
|---|---|
| `util.sample` | Row sampling for fast iteration on large data |
| `util.filter` | Row filtering by condition |
| `util.aggregate` | Group-by aggregations |
| `util.pivot` / `util.melt` | Reshape |
| `util.note` | Canvas annotation, no execution |
| `util.branch` | Conditional path on a metric threshold (post-v1) |

---

## 8. Execution engine

### 8.1 The compiler

`compile(flow_spec, dataset_schemas) -> ExecutionPlan | CompileErrors`

Stages, in order:

1. **Structural validation** — schema conformance, unique ids, acyclicity, required ports connected.
2. **Param validation** — each node's params against its JSON Schema.
3. **Type propagation** — walk the DAG in topological order, computing the output schema of each node from its input schema and params. Catches "you're scaling a string column" before execution.
4. **Semantic checks** — see 8.5.
5. **Cache resolution** — compute content hash per node; mark cached nodes as skippable.
6. **Plan emission** — a linear list of steps with resolved input artifact URIs and output targets.

Compile errors MUST be structured and node-attributed so the UI can highlight the offending node and the agent can repair it:

```jsonc
{
  "errors": [
    { "node_id": "n4", "code": "SCHEMA_MISMATCH", "severity": "error",
      "message": "prep.scale expects numeric columns; 'plan_type' is categorical_nominal",
      "suggestion": "Insert prep.encode before prep.scale, or remove 'plan_type' from columns" }
  ],
  "warnings": [
    { "node_id": "n7", "code": "SMALL_TEST_SET",
      "message": "Test split has 41 rows; metric estimates will be unstable" }
  ]
}
```

### 8.2 The `RuntimeAdapter` interface

```python
class RuntimeAdapter(Protocol):
    async def capabilities(self) -> Capabilities: ...
        # cpu_count, ram_mb, gpu, python_version, installed_packages, max_runtime_s
    async def health(self) -> HealthStatus: ...
    async def submit(self, plan: ExecutionPlan) -> JobHandle: ...
    async def stream_events(self, job: JobHandle) -> AsyncIterator[RunEvent]: ...
    async def cancel(self, job: JobHandle) -> None: ...
    async def teardown(self) -> None: ...
```

Implementations: `LocalRuntime` (Phase 0–1), `BrowserRuntime` (Phase 5), `ColabRuntime` (Phase 4), `ManagedRuntime` (post-v1).

### 8.3 The runner protocol

The runner is a pip package (`flowlab-runner`) that connects **outbound** to the API — no inbound ports, no NAT problems, works identically from a laptop and a Colab VM.

1. User generates an attach token in the UI (short-lived, single-use, workspace-scoped).
2. Runner starts: `flowlab-runner attach --token=...` (local) or `connect("TOKEN")` (Colab cell).
3. Runner opens a WebSocket to `wss://api.flowlab.app/v1/runtime/ws`, authenticates, and registers its capabilities.
4. Runner heartbeats every 15s. Missing 3 heartbeats marks it offline.
5. Orchestrator pushes an `ExecutionPlan`. The runner executes steps sequentially, streaming `RunEvent`s.
6. Artifacts are written to storage via **pre-signed upload URLs issued per step** — the runner never holds long-lived storage credentials.
7. On completion the runner posts final metrics and artifact manifests.

`RunEvent` types: `run_started`, `node_started`, `node_progress`, `node_log`, `node_warning`, `node_completed`, `node_failed`, `artifact_written`, `run_completed`, `run_failed`, `run_cancelled`.

### 8.4 Colab adapter specifics

- The attach notebook is generated server-side and opened in a new tab, containing exactly two cells: install, and connect-with-token.
- The UI MUST display, before attaching: session lifetime limits, idle disconnect behaviour, that FlowLab cannot restart a dead session, and that this is best-effort.
- The adapter MUST checkpoint after each node so a killed session resumes from the last completed node rather than the start.
- Long-running jobs MUST warn at 10h elapsed.
- **MUST NOT** implement keep-alive tricks, synthetic interaction, or session chaining. Those are exactly what gets accounts banned.

### 8.5 Semantic checks (the rigour layer)

The compiler MUST enforce:

| Check | Rule |
|---|---|
| **Leakage: fit-after-split** | Any fitting transformer (`prep.encode`, `prep.scale`, `feature.select`, `clean.impute` with learned params) reachable from the data path MUST be downstream of `prep.split`, and MUST be fit on the train partition only. Violation = error. |
| **Leakage: target in features** | The target column MUST NOT appear in the feature set of `model.fit`. Error. |
| **Leakage: resampling** | `prep.balance` MUST apply to the train split only. Error. |
| **Leakage: duplicate rows across splits** | Warn when duplicate rows appear in both train and test. |
| **Temporal leakage** | When a datetime column is present and used, warn if the split is random rather than time-based. |
| **Target definition** | `model.fit` requires exactly one column with `role: target`. |
| **Class imbalance** | Warn when minority class < 10% and no balancing or class weighting is configured. |
| **Small-n** | Warn when any split or group has fewer than 30 rows. |
| **Assumption violation** | Statistical test nodes emit warnings when preconditions fail (Section 7.5). |
| **Multiple comparisons** | Warn when >5 hypothesis tests run in one flow with no correction node. |

These checks are the reason a user would trust FlowLab over a hand-rolled notebook. They MUST live server-side in the compiler where they cannot be bypassed.

---

## 9. Storage and connectors

### 9.1 Storage abstraction

```python
class StorageProvider(Protocol):
    async def list(self, path: str) -> list[FileEntry]: ...
    async def stat(self, path: str) -> FileEntry: ...
    async def read_stream(self, path: str) -> AsyncIterator[bytes]: ...
    async def write_stream(self, path: str, data: AsyncIterator[bytes]) -> str: ...
    async def presign_read(self, path: str, ttl_s: int) -> str: ...
    async def presign_write(self, path: str, ttl_s: int) -> str: ...
    async def delete(self, path: str) -> None: ...
```

### 9.2 Providers

| Provider | Phase | Notes |
|---|---|---|
| **Local / MinIO (S3-compatible)** | Phase 1 | Default. MinIO is the open-source, self-hostable backing store — use this as the reference implementation. |
| **Direct upload** | Phase 1 | Browser → pre-signed URL → MinIO |
| **Google Drive** | Phase 6 | OAuth, `drive.file` scope only (files the app creates or the user explicitly picks — not full Drive access) |
| **Dropbox** | Phase 6 | OAuth, scoped app folder |
| **AWS S3 / GCS / Azure Blob** | Phase 6 | BYO credentials |
| **HTTP(S) URL** | Phase 2 | Fetch a public CSV/Parquet by URL |

**MUST:** request the narrowest OAuth scope that works. `drive.file` over `drive.readonly` over `drive`. Users are rightly suspicious of an app that asks for their whole Drive.

### 9.3 Dataset ingestion pipeline

On registration of a new dataset:

1. Detect format (csv, tsv, xlsx, parquet, json, jsonl, feather) and, for text formats, encoding and delimiter.
2. Convert to **Parquet** as the canonical internal format. Original is retained unmodified.
3. Run schema inference → dtypes and `semantic` roles (Section 6.4).
4. Compute profile statistics via DuckDB (no full load into RAM).
5. Compute `content_hash` (sha256 of canonical Parquet).
6. Store `DatasetVersion` row; the profile is cached by content hash and reused across flows.

Supported sizes v1: up to 2 GB compressed Parquet. Above that, the UI MUST require a sampling node or reject with a clear message.

---

## 10. The agent layer

### 10.1 Agent roles

| Agent | Job | Output |
|---|---|---|
| **Profiler** | Summarise the dataset for the planner. Deterministic code, not an LLM. | Compact schema + stats digest |
| **Planner** | Turn goal + profile into a plan and a Flow Spec | `{ plan_text, flow_spec }` |
| **Validator** | Compile the spec; on failure, return structured errors to the Planner for repair | Valid spec or user-facing error |
| **Narrator** | Turn computed results into plain-language findings | Narration strings bound to `narration_basis` |
| **Advisor** | Answer follow-up questions about an existing run | Chat responses with node references |

### 10.2 What the LLM sees

**MUST NOT** send raw dataset rows to the LLM by default. Send the profile digest:

```jsonc
{
  "row_count": 74112,
  "columns": [
    { "name": "tenure_months", "semantic": "numeric_continuous",
      "null_frac": 0.03, "min": 0, "max": 72, "mean": 32.4, "skew": 0.21 },
    { "name": "plan_type", "semantic": "categorical_nominal",
      "cardinality": 4, "top_values": ["basic", "plus", "pro", "enterprise"] },
    { "name": "churned", "semantic": "binary", "class_balance": [0.74, 0.26] }
  ],
  "quality_flags": ["3 near-duplicate rows", "customer_id looks like an identifier"],
  "detected_task_candidates": ["binary_classification on churned"]
}
```

A "share sample rows with the agent" toggle MAY exist, defaulting **off**, with a clear explanation.

### 10.3 Planner output

```jsonc
{
  "understanding": "You want to know which factors predict churn and get an interpretable model.",
  "plan": [
    { "step": 1, "action": "Profile distributions and missingness",
      "why": "3% nulls in tenure_months need handling before modelling" },
    { "step": 2, "action": "Impute tenure_months with the median",
      "why": "Distribution is mildly right-skewed, so the median is more robust than the mean" },
    { "step": 3, "action": "Split 80/20 stratified on churned",
      "why": "26% minority class — stratifying keeps both splits representative" }
  ],
  "flow_spec": { /* full spec */ },
  "assumptions": ["Treated customer_id as an identifier and excluded it from features"],
  "questions_for_user": ["Is 'churned' measured at 30 or 90 days? It affects how I'd frame the target."]
}
```

The `why` field is mandatory per step. A plan without reasons is an AutoML black box, which is an explicit anti-goal.

### 10.4 Guardrails (MUST)

- The Planner uses **constrained tool-calling** against the node catalogue. It cannot invent node types or parameters.
- Generated specs go through the full compiler before being shown as runnable. Failures trigger a repair loop (max 3 attempts) with structured errors.
- The agent **never emits executable code** in v1.
- The Narrator may only reference values present in `narration_basis`. Post-generation, assert that every number appearing in the narration exists in the basis; on failure, regenerate once, then fall back to a templated narration.
- All agent outputs are drafts. The user reviews the graph on the canvas before running. Nothing runs automatically from a prompt without a visible confirm step.
- Token and cost per request are logged per workspace; a configurable monthly cap applies.

### 10.5 Prompt-to-graph UX

```
User types goal
   ↓
Profiler runs (fast, deterministic, cached)
   ↓
Planner streams the plan text first  ← user sees reasoning immediately
   ↓
Flow Spec arrives → canvas animates nodes into place
   ↓
Compile → inline warnings shown on nodes
   ↓
User edits anything → "Run"
```

Streaming the plan before the graph matters: it gives the user something to read during generation and lets them cancel early if the agent misunderstood.

---

## 11. Frontend specification

### 11.1 Screens

| Screen | Contents |
|---|---|
| **Workspace home** | Recent flows, datasets, runs; "New flow" and "Ask a question" entry points |
| **Datasets** | List, upload, connector browser, per-dataset profile view with charts and schema editing |
| **Flow canvas** | Node palette (left), canvas (centre), node inspector (right), run bar (bottom) |
| **Run view** | Node-by-node execution timeline, live logs, artifacts, metrics, charts |
| **Report view** | Assembled narrative report; export to PDF / shareable link |
| **Run comparison** | Two or more runs side by side: param diffs and metric deltas |
| **Settings** | Connectors, runtimes, API keys, members, usage |

### 11.2 Canvas requirements

- Drag from palette, drop on canvas; auto-connect to the nearest compatible upstream port.
- Ports are colour-coded by type; incompatible connections are refused during drag with a tooltip reason.
- Node states rendered visually: `idle`, `queued`, `running` (animated), `cached` (dimmed with a cache badge), `success`, `warning`, `error`.
- Click a node → inspector shows params (JSON-Schema-generated form), input schema preview, output preview, and docs for the technique.
- Inline warnings appear as badges on nodes immediately after each compile (debounced, on every edit).
- Auto-layout button (dagre/elk) for agent-generated graphs.
- Undo/redo, multi-select, copy/paste, group into subflow (post-v1).
- Keyboard: `Space` pan, `Del` remove, `Cmd+Z` undo, `Cmd+K` command palette, `Tab` add node.

### 11.3 Node inspector — param forms

Forms MUST be generated from each node's JSON Schema. Adding a node to the catalogue MUST NOT require writing frontend code. Schema extensions drive the widgets:

```jsonc
{
  "properties": {
    "columns": {
      "type": "array", "items": { "type": "string" },
      "x-widget": "column-multiselect",
      "x-filter": { "semantic": ["numeric_continuous", "numeric_discrete"] },
      "title": "Columns to scale"
    },
    "method": {
      "enum": ["standard", "minmax", "robust", "quantile"],
      "x-widget": "radio-cards",
      "x-descriptions": {
        "standard": "Mean 0, SD 1. Default choice for most models.",
        "robust": "Uses median and IQR — better when outliers are present."
      }
    }
  }
}
```

The `x-descriptions` field is how the product teaches. Users should learn what robust scaling is *from the interface*, at the moment they need it.

### 11.4 Accessibility & responsiveness

- WCAG 2.1 AA: contrast, focus indicators, full keyboard navigation of the canvas, screen-reader labels on nodes and ports.
- Never rely on colour alone for node state — pair with icon and text.
- Canvas is desktop-first. Mobile/tablet get read-only run and report views (which is fine — nobody builds a DAG on a phone).

---

## 12. API specification

Base: `/v1`. Auth: `Authorization: Bearer <jwt>`.

### 12.1 REST endpoints

```
POST   /auth/login                       Email magic link / OAuth callback
GET    /auth/me

GET    /workspaces
POST   /workspaces
GET    /workspaces/{id}/members
POST   /workspaces/{id}/members

GET    /datasets                         ?workspace_id, ?search
POST   /datasets                         Register from upload or connector path
GET    /datasets/{id}
GET    /datasets/{id}/profile            Cached profile + inferred schema
PATCH  /datasets/{id}/schema             Override inferred semantics / roles
GET    /datasets/{id}/preview            ?rows=100&offset=0
DELETE /datasets/{id}

GET    /connectors                       Available providers + connection status
POST   /connectors/{provider}/connect    Begin OAuth
DELETE /connectors/{id}
GET    /connectors/{id}/browse           ?path

GET    /flows
POST   /flows
GET    /flows/{id}
PUT    /flows/{id}                       Creates a new version
GET    /flows/{id}/versions
POST   /flows/{id}/compile               → ExecutionPlan | CompileErrors
POST   /flows/{id}/duplicate
DELETE /flows/{id}

POST   /runs                             { flow_id, flow_version, runtime_id }
GET    /runs                             ?flow_id, ?status
GET    /runs/{id}
POST   /runs/{id}/cancel
GET    /runs/{id}/events                 Replay of the event log
GET    /runs/{id}/artifacts
GET    /runs/{id}/nodes/{node_id}/output ?format=preview|full
POST   /runs/compare                     { run_ids: [...] }

GET    /runtimes                         Attached runtimes + capabilities + health
POST   /runtimes/attach-token            → { token, expires_at, colab_url? }
DELETE /runtimes/{id}

POST   /agent/plan                       { dataset_id, prompt } → streams plan then spec
POST   /agent/repair                     { flow_spec, compile_errors } → repaired spec
POST   /agent/narrate                    { run_id, node_id } → narration
POST   /agent/ask                        { run_id, question } → answer with node refs

GET    /nodes/catalogue                  All node types + JSON Schemas + docs
GET    /nodes/{type}/schema
```

### 12.2 WebSocket channels

```
/v1/ws/runs/{run_id}       Client ← server: RunEvent stream
/v1/runtime/ws             Runner ↔ server: job protocol (Section 8.3)
/v1/ws/agent/{session_id}  Client ← server: streamed planning tokens
```

### 12.3 Conventions

- Idempotency keys on all POSTs that create resources.
- Cursor pagination (`?cursor=&limit=`), default 50, max 200.
- Errors: RFC 7807 problem+json with a stable `code` field.
- Rate limits per workspace: 100 req/min general, 10/min on `/agent/*`.

---

## 13. Data model

```sql
users(id, email, name, avatar_url, created_at)
workspaces(id, name, owner_id, plan, created_at)
workspace_members(workspace_id, user_id, role, created_at)  -- owner|editor|viewer

connectors(id, workspace_id, provider, display_name,
           credentials_encrypted, scopes, status, created_at, last_used_at)

datasets(id, workspace_id, name, description, source_connector_id,
         source_path, created_by, created_at)
dataset_versions(id, dataset_id, version, content_hash, row_count, col_count,
                 byte_size, canonical_path, original_path, created_at)
dataset_profiles(content_hash PK, profile_json JSONB, computed_at)
dataset_schema_overrides(dataset_id, column_name, semantic, role, updated_by, updated_at)

flows(id, workspace_id, name, description, current_version,
      created_by, created_at, updated_at)
flow_versions(id, flow_id, version, spec JSONB, spec_hash,
              created_by, created_at, change_note)

runtimes(id, workspace_id, kind, display_name, capabilities JSONB,
         status, last_heartbeat_at, attached_at)

runs(id, flow_id, flow_version, workspace_id, runtime_id, status,
     triggered_by, started_at, finished_at, duration_ms,
     error_code, error_message, runner_version, seed)
run_nodes(run_id, node_id, node_type, status, started_at, finished_at,
          cache_hit, params_hash, output_hash, metrics JSONB, warnings JSONB)
run_events(id, run_id, seq, type, node_id, payload JSONB, created_at)

artifacts(id, run_id, node_id, port, kind, format, storage_path,
          byte_size, content_hash, schema_json JSONB, created_at)

agent_sessions(id, workspace_id, dataset_id, prompt, plan JSONB,
               generated_spec JSONB, repair_attempts, model, 
               input_tokens, output_tokens, cost_cents, created_at)

audit_log(id, workspace_id, actor_id, action, resource_type,
          resource_id, metadata JSONB, ip, created_at)
```

Indexes: `runs(flow_id, started_at DESC)`, `run_events(run_id, seq)`, `artifacts(run_id, node_id)`, `dataset_versions(dataset_id, version DESC)`, GIN on `flow_versions.spec`.

---

## 14. Reproducibility and caching

### 14.1 Cache key

```
node_cache_key = sha256(
    node_type + "|" +
    canonical_json(params) + "|" +
    sorted(input_artifact_content_hashes) + "|" +
    runner_version + "|" +
    global_seed
)
```

`position`, `label` and `id` MUST NOT enter the key.

### 14.2 Determinism requirements

- Every stochastic node MUST accept a `seed`; the flow carries a `meta.seed` default.
- The runner pins its dependency versions; `runner_version` encodes the lockfile hash.
- Row ordering MUST be stable — sort by a deterministic key before any operation where order affects output.
- A re-run of an unchanged flow on unchanged data MUST produce identical `output_hash` for every node. This is an automated test, not an aspiration.

---

## 15. Security and privacy

| Area | Requirement |
|---|---|
| **Credential storage** | OAuth tokens and API keys encrypted at rest (AES-256-GCM) with per-workspace data keys wrapped by a KMS master key. Never logged, never returned by any API. |
| **OAuth scopes** | Minimum viable. `drive.file` not `drive`. Scope list shown to the user before consent. |
| **Runner trust** | Runner is untrusted. It receives step plans and pre-signed URLs scoped to a single run. Never long-lived credentials. Tokens are single-use and expire in 10 minutes. |
| **Runner code safety** | v1 has no arbitrary-code node. `feature.derive` uses a restricted expression parser (whitelisted functions, no attribute access, no imports) — never `eval`/`exec`. |
| **Tenant isolation** | Every query filtered by `workspace_id` at the repository layer. Row-level tests that assert cross-tenant access returns 404. |
| **Data residency** | Datasets stay in the user's chosen storage where possible; FlowLab stores derived artifacts and metadata. Document clearly what is stored server-side. |
| **PII** | Profiler flags likely PII columns (email, phone, name, ID patterns). Warn before sending any column names or samples to an LLM. Provide a per-dataset "never send to LLM" column list. |
| **LLM data handling** | Profile digests only by default (10.2). Document exactly what leaves the system. Support BYO API key so that data goes to the user's own LLM account. |
| **Audit** | All auth events, connector changes, run triggers and data exports logged. |
| **Transport** | TLS everywhere; HSTS; WSS only. |
| **Deletion** | Deleting a workspace purges artifacts and metadata within 30 days; document the window. |

---

## 16. Non-functional requirements

| Requirement | Target |
|---|---|
| Canvas interaction latency | <16 ms per frame at 100 nodes |
| Compile round-trip (typical 15-node flow) | <300 ms p95 |
| Dataset profile (100 MB Parquet) | <10 s |
| Prompt-to-graph, first plan token | <3 s |
| Prompt-to-graph, complete spec | <25 s p95 |
| Run event latency (runner → UI) | <500 ms p95 |
| API availability | 99.5% |
| Max dataset (v1) | 2 GB compressed Parquet |
| Max nodes per flow | 200 (soft warn at 100) |
| Concurrent runs per workspace | 3 |
| Browser support | Last 2 versions of Chrome, Edge, Firefox, Safari |

---

## 17. Observability

- **Structured logging** (JSON) with `trace_id` propagated from API through orchestrator to runner events.
- **Metrics**: run success/failure rate by node type, cache hit rate, compile error frequency by code, agent spec-validity rate, repair-attempt distribution, LLM cost per workspace, runtime attach/disconnect rate.
- **Error tracking**: Sentry on frontend and backend.
- **Node-type telemetry**: which nodes get used, which get deleted immediately after agent generation (a strong signal the agent chose wrong).

---

## 18. Testing strategy

| Level | Coverage |
|---|---|
| **Unit — nodes** | Every node: happy path, edge cases (empty table, all-null column, single row, single class), param validation, schema propagation correctness |
| **Unit — compiler** | Every semantic check in 8.5 has a positive and negative test. Leakage tests are the highest-value tests in the codebase. |
| **Property tests** | Round-trip Flow Spec serialisation; cache-key stability under `position`/`label` changes |
| **Golden flows** | 10 reference flows × fixture datasets; assert exact output hashes. These catch reproducibility regressions. |
| **Agent evals** | 40 prompt+dataset pairs with rubrics. Track: spec validity rate, compile-pass rate, repair attempts, human-rated plan quality. Run on every prompt change. |
| **Narration safety tests** | Assert no number in a narration is absent from `narration_basis` |
| **Integration** | API + DB + queue + local runner, full run lifecycle |
| **E2E (Playwright)** | Upload → build flow → run → view results; prompt → graph → run |
| **Load** | 50 concurrent runs, 10k-node-event streaming |

**Fixture datasets** (commit these): a clean numeric dataset, one with 20% missingness, one heavily imbalanced (2% positive), one with mixed types and messy strings, one time series, one wide (500 columns), one tiny (30 rows), one with an obvious leakage trap (a column that is a proxy for the target).

---

## 19. Success metrics

**Activation**
- % of new users who complete one successful run within 24h of signup — target 40%
- Median time from signup to first chart — target <10 min

**Agent quality**
- % of agent-generated flows that compile without repair — target 80%
- % that run to completion unedited — target 65%
- % of agent-chosen nodes deleted by the user before running — target <15%

**Retention & depth**
- Week-4 retention — target 25%
- Median runs per active user per week — target 5
- % of flows that are re-run (a proxy for real iterative work) — target 50%

**Reliability**
- Run success rate excluding user-caused errors — target 97%
- Cache hit rate on re-runs — target 60%

---

## 20. Open questions

These need answers before the phases they affect. Record decisions in `docs/decisions/`.

1. **Deployment model** — hosted SaaS, self-hosted open source, or open-core? This drives tenancy, billing and the storage defaults. *(Affects Phase 1.)*
2. **LLM key model** — FlowLab-provided (you absorb cost) or BYO-key (user pastes theirs)? BYO-key removes cost risk and simplifies the privacy story; FlowLab-provided is a better onboarding experience. Possibly both, BYO on free tier. *(Affects Phase 6.)*
3. **Is Colab actually needed?** Given 4.1, is there a concrete user need that the local runner and browser runtime don't cover? If not, defer Colab past v1 entirely and save several weeks.
4. **Dataset size ceiling** — is 2 GB right for the target user, or is the real ceiling 50 MB (in which case the browser runtime alone might cover v1)?
5. **Monetisation** — free/paid boundary. Candidate paid gates: agent generations per month, dataset size, concurrent runs, sharing/collaboration.
6. **Sharing model** — public read-only run links? Embedded reports? This affects the report data model.
7. **Custom code node** — a `CustomScript` node would be immediately requested and immediately dangerous. Ship it never, or ship it only on the local runner where the user is executing on their own machine with their own risk?

---

## 21. Phased build plan

Each phase has a Definition of Done. **Do not begin a phase until the previous DoD passes.** The ordering deliberately front-loads the contracts (spec, compiler, nodes) and defers the UI, because the UI is cheap to build against a solid contract and expensive to rebuild against a bad one.

---

### Phase 0 — Contracts and core engine (no UI, no API)

**Build**
- Monorepo scaffold (Section 22)
- `packages/flowspec`: Pydantic models for the Flow Spec, JSON Schema export, validation
- `packages/nodes`: node base class, registry, param-schema decorator, and 12 nodes —
  `source.dataset`, `profile.overview`, `profile.missingness`, `clean.impute`, `clean.drop_columns`, `prep.split`, `prep.encode`, `prep.scale`, `model.fit`, `model.evaluate`, `viz.distribution`, `sink.export`
- Compiler: structural validation, param validation, type propagation, acyclicity, the leakage checks from 8.5
- Local executor: run an `ExecutionPlan` against local Parquet files
- CLI: `flowlab run flow.json --data ./data/` prints node-by-node progress and writes artifacts
- Fixture datasets (Section 18)

**Definition of Done**
- `flowlab run` executes a 7-node churn flow end to end and writes a Parquet, a metrics JSON and a Vega-Lite chart spec
- A flow with `prep.scale` before `prep.split` fails compilation with a leakage error naming the node
- Re-running an unchanged flow produces identical output hashes
- Node unit tests pass; compiler leakage tests pass

---

### Phase 1 — API, persistence, storage

**Build**
- FastAPI app, Postgres schema + Alembic migrations, Redis
- Auth (magic link + Google OAuth), workspaces, membership roles
- MinIO storage provider, direct upload with pre-signed URLs
- Dataset registration pipeline: format detection → Parquet conversion → schema inference → DuckDB profiling → content hash
- Flow CRUD + versioning; `/flows/{id}/compile`
- Run orchestration against an in-process local runtime; run/run_node/run_event/artifact persistence
- WebSocket run event stream

**DoD**
- Upload a CSV via API → profile returned with correct inferred semantics
- Create a flow, compile it, run it, stream events over WS, fetch artifacts
- Tenant isolation test: workspace B gets 404 on workspace A's resources

---

### Phase 2 — Canvas and run UI

**Build**
- React app shell, auth, workspace nav
- React Flow canvas: palette, drag-drop, typed ports, connection validation, node states
- JSON-Schema-driven inspector forms with `x-widget` support
- Debounced compile-on-edit with inline node warnings
- Run bar: runtime selector, run/cancel, live progress
- Run view: timeline, logs, per-node output preview, metrics, Vega-Lite chart rendering
- Dataset screens: upload, list, profile view with schema override editing

**DoD**
- A user builds the churn flow entirely in the browser, runs it, and sees charts and metrics
- Attempting an invalid connection is refused with a readable reason
- Leakage error highlights the offending node on the canvas

---

### Phase 3 — Full node catalogue

**Build**
- Remaining nodes from Section 7, prioritised: statistical tests (7.5) → visualisation (7.7) → feature engineering (7.4) → remaining model nodes (7.6)
- Assumption checking and effect sizes for every test node
- SHAP explainability node
- Run comparison view

**DoD**
- Every node in Section 7 is registered, schema-validated, documented and tested
- A t-test on non-normal data reports the violation and names the Mann–Whitney alternative
- Two runs of the same flow with different hyperparameters render a metric diff

---

### Phase 4 — Detached runners

**Build**
- `packages/runner`: pip-installable, WebSocket job protocol, heartbeats, per-step checkpointing, pre-signed artifact upload
- `LocalRuntime` adapter + `flowlab-runner attach --token=...`
- Attach-token issuance and runtime management UI
- Resume-from-checkpoint on reconnect
- **Then** `ColabRuntime`: generated attach notebook, limits clearly surfaced in UI, session-death handling

**DoD**
- A run executes on a runner process on a different machine and streams events to the UI
- Killing the runner mid-run and reattaching resumes from the last completed node
- Colab attach works end to end, and the UI states the session limits before the user attaches

---

### Phase 5 — Agent layer

**Build**
- `LLMClient` abstraction; Claude as default provider; BYO-key support
- Profiler digest builder (deterministic)
- Planner with constrained tool-calling over the node catalogue
- Compile-repair loop (max 3 attempts) with structured error feedback
- Streaming plan UI → animated graph materialisation on canvas
- Narrator with `narration_basis` binding and the no-invented-numbers assertion
- Advisor chat over a completed run
- Agent eval harness (40 prompt/dataset pairs) wired into CI

**DoD**
- ≥80% of eval prompts produce a spec that compiles (after ≤1 repair)
- Narration safety test passes: no number appears that isn't in the basis
- A user can go from prompt → reviewed graph → run → narrated report without touching a node

---

### Phase 6 — Connectors, reports, sharing

**Build**
- Google Drive and Dropbox providers with narrow OAuth scopes and a file browser
- S3/GCS/Azure with BYO credentials
- Report builder: assemble charts, metrics and narration into an ordered document
- PDF export and read-only share links
- Flow templates: save a flow as a template, apply to a new dataset with a column-mapping step
- Usage dashboard, LLM cost caps

**DoD**
- A dataset is imported from Drive, used in a flow, and the result exported back to Drive
- A report is shared via link and renders correctly for a logged-out viewer
- A template applied to a schema-mismatched dataset reports exactly which columns need remapping

---

### Phase 7 — Hardening

- Browser runtime (DuckDB-WASM + Pyodide) for small datasets
- Performance: canvas virtualisation, artifact streaming, profile caching
- Accessibility audit to WCAG 2.1 AA
- Load testing, error budget review
- Documentation: node reference, technique guides, API docs

---

## 22. Repository structure

```
flowlab/
├── apps/
│   ├── web/                      React + Vite frontend
│   │   ├── src/
│   │   │   ├── canvas/           React Flow nodes, edges, palette, layout
│   │   │   ├── inspector/        JSON-Schema form renderer + x-widgets
│   │   │   ├── runs/             Timeline, logs, artifact viewers
│   │   │   ├── charts/           Vega-Lite renderer + theme
│   │   │   ├── datasets/
│   │   │   ├── agent/            Prompt panel, streaming plan view
│   │   │   └── lib/              api client, ws client, stores
│   │   └── tests/                vitest + playwright
│   └── api/                      FastAPI backend
│       ├── app/
│       │   ├── routers/
│       │   ├── services/         datasets, flows, runs, connectors, agent
│       │   ├── compiler/         validation, type propagation, semantic checks
│       │   ├── orchestrator/     queue, runtime adapters, event fan-out
│       │   ├── agent/            planner, narrator, prompts, evals
│       │   ├── storage/          StorageProvider implementations
│       │   ├── models/           SQLAlchemy
│       │   └── core/             config, auth, crypto, logging
│       ├── migrations/
│       └── tests/
├── packages/
│   ├── flowspec/                 Pydantic models + JSON Schema (shared truth)
│   ├── nodes/                    Node implementations + registry + docs
│   └── runner/                   Detachable runner (pip-installable)
├── fixtures/                     Test datasets
├── docs/
│   ├── PRD.md                    This document
│   ├── decisions/                ADRs
│   └── nodes/                    Generated node reference
├── infra/
│   ├── docker-compose.yml        postgres, redis, minio, api, web
│   └── Dockerfile.*
└── Makefile                      dev, test, lint, migrate, seed
```

**Shared-truth rule (MUST):** the node catalogue's JSON Schemas are generated from `packages/nodes` at build time and consumed by both the API and the frontend. There MUST be exactly one definition of any node's parameters. A generated `nodes.schema.json` artifact is committed and CI fails if it drifts from the source.

---

## 23. Engineering conventions

- Python 3.11+, `ruff` + `black` + `mypy --strict` on `packages/`
- TypeScript strict mode; ESLint + Prettier
- Conventional Commits; PRs require passing tests and type checks
- Every new node requires: implementation, JSON Schema, docstring explaining the technique and when to use it, unit tests, and an entry in the generated node reference
- Every compiler rule requires a positive and a negative test
- ADRs in `docs/decisions/` for anything that contradicts this PRD

---

## 24. Glossary

| Term | Meaning |
|---|---|
| **Flow** | A saved, versioned analysis pipeline (the DAG) |
| **Flow Spec** | The JSON representation of a flow (Section 6) |
| **Node** | A single operation in a flow |
| **Port** | A typed input or output connection point on a node |
| **Compile** | Validate and type-check a spec into an executable plan |
| **Execution Plan** | The compiled, ordered, resolved step list sent to a runtime |
| **Run** | One execution of a specific flow version |
| **Runtime / Runner** | The compute environment executing a plan |
| **Artifact** | A persisted node output (table, model, chart, metrics) |
| **Profile** | Deterministic statistical summary of a dataset |
| **Narration** | Generated plain-language finding bound to computed values |
| **Leakage** | Information from the test set influencing training |
