# 0013 — Build mode: no-code pipelines of snippet nodes, connected by the model only where needed

**Status:** accepted · 2026-09-16

## Context
People want to assemble an analysis or model without writing code:
1. create a node and say what it is for;
2. pick a technique from every option that exists for that purpose, with its code shown;
3. wire the nodes and set parameters;
4. let an LLM connect the snippets;
5. run the result, and still change anything afterwards.

The snippet library and composer (decision 0004) already turn reviewed snippets into scripts,
and Code Mode already runs `# %%` cells in a kernel.

## Decision
- **Purposes.** Eleven purposes map onto snippet categories: Import data, Explore, Clean, Engineer
  features, Split, Preprocess, Train a model, Evaluate, Explain, Visualize, Save. Within a purpose,
  techniques are grouped:
  - *Models:* Classification, Regression, Clustering, Deep learning (PyTorch), Tuning and automatic.
  - *Preprocessing:* Imputation, Encoding, Scaling and normalization, Transforms, Outliers,
    Selection and reduction, Class balancing.
- **Library growth (74 → 114 snippets).** Every new snippet runs on a fixture in CI, like the
  existing ones.
  - *Preprocessing:* Yeo-Johnson, quantile transform, max-abs scaling, row normalization, KNN and
    iterative imputation, frequency and target encoding, polynomial features, PCA, variance
    threshold, random oversampling, TF-IDF.
  - *Feature engineering:* cyclical encoding, lags, rolling means, and a clean-up step that removes
    constant columns.
  - *Classifiers:* SVM, k-NN, naive Bayes, extra trees, AdaBoost, histogram gradient boosting,
    sklearn MLP, SGD, LDA.
  - *Regressors:* lasso, elastic net, Bayesian ridge, SVR, k-NN, extra trees, histogram gradient
    boosting, MLP.
  - *Clustering:* DBSCAN, agglomerative, Gaussian mixture.
  - *Evaluation:* precision-recall and learning curves.
  - *PyTorch MLP* (`model.torch_mlp`): classification or regression, dropout, early stopping, and
    epoch lines that FlowLab charts live. It is a real scikit-learn estimator, so every evaluation
    and explanation step works on it. Cross-validation, learning curves and permutation importance
    run in one process for models defined in the notebook, which worker processes cannot import.
- **Pipeline file.** `pipelines/<name>.pipeline.json` holds the name, dataset, target, nodes
  (`snippet`, `params`, position) and edges. It is saved automatically while editing and checked
  on every change:
  - unknown params or columns;
  - a model whose task does not match the target;
  - loops;
  - prerequisites that will be added automatically.
- **Finalize** (`flowlab_agent.builder.finalize`), deterministic first:
  1. Order nodes topologically along the edges; ties go by pipeline stage, then canvas position.
  2. Compose with the snippet composer. It validates parameters against the dataset digest and
     inserts missing prerequisites: loader, split, model-ready features. Each cell title carries
     `{node:<id>}`, so run states map back onto the canvas.
  3. Check names in source order and scope: does every cell read only names that earlier cells
     define?

  The generated script is written to `pipelines/<name>.py` and also opens in Code Mode.
- **The model only connects.** With "Connect with AI", Groq is called only when step 3 finds gaps,
  or when a run failed ("Fix with AI" sends the error). The model returns glue cells, never
  replacements for snippets. Glue is accepted only if it passes all of these checks:
  - it parses and is at most 20 lines, with at most 8 glue cells;
  - it imports only numpy, pandas, sklearn, torch, scipy or math;
  - it avoids `open`, `exec`, `eval`, `__import__`, dunder access and file-writing methods.

  Rejected glue is reported, and the gap check runs again afterwards. A clean pipeline costs zero
  tokens. Consent is required, as with Ask: the model receives the generated snippet code, the
  target and the column digest, never data rows.
- **Run.** Start (or reuse) the kernel for the generated script and run every cell. Cards show
  each node's state, the headline metric and a Training chart. Outputs, plots and errors appear in
  the node inspector.

## Consequences / not yet
- Nodes are techniques, not arbitrary code. To customise beyond the parameters, open the generated
  script in Code Mode (the pipeline file stays the source for Build mode).
- Deep learning covers tabular MLPs. CNNs and sequence models need image or sequence data loaders
  first.
- XGBoost, LightGBM and imbalanced-learn are not installed here, so their techniques are not in the
  library. Histogram gradient boosting and random oversampling cover the same ground.
