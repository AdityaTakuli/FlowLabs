# Synapse

**Machine learning without writing code.** Bring a table or a folder of images, clean and prepare
it, train and compare models (from linear regression to neural networks you design layer by layer),
then export a model that runs anywhere.

```
Data → Clean → Split → Training rows → Transform → Models → Evaluate → Export
```

Everything happens on a visual pipeline. Every step shows its effect on the data before you train,
and every technique explains what it does.

## Three ways to run it

| | How | Good for |
| --- | --- | --- |
| **In the browser** | Open the hosted app (GitHub Pages). Python runs inside the tab via [Pyodide](https://pyodide.org). | Trying it, teaching, small and medium tables. Nothing to install, and data never leaves your device. |
| **Desktop app** | Download for Linux, macOS or Windows from Releases. | Larger data and every feature, offline. |
| **pip** | `pip install "synapse-studio[deep]"`, then `synapse app` | People who already have Python, a GPU, or a server. |

### The engine: use your own computer's power from the browser

Like a Jupyter kernel, Synapse trains in an **engine**: a Python process on whichever computer you
choose, with that machine's packages, CPU cores and GPU (CUDA or Apple Metal).

```bash
pip install "synapse-studio[deep]"   # scikit-learn + PyTorch + torchvision
synapse engine                       # prints a link that opens the web app connected to this machine
```

- **Engine menu → Python environments.** Run the kernel in any virtualenv or conda environment on
  the machine. Synapse probes each one for pandas, scikit-learn, PyTorch, XGBoost and LightGBM, and
  can install what is missing.
- **Another machine** (a GPU server): `synapse engine --host 0.0.0.0` and open the address it
  prints. Every request needs the engine's token.
- Each engine keeps its own datasets, projects and models (in `~/Synapse` by default; the browser
  engine uses the browser's storage).

## What you can do

**Data.** CSV, TSV, Excel, Parquet, JSON, or a zip of image folders (one folder per class). Eight
sample datasets are included. A profile shows types, gaps, distributions, correlations and class
balance, plus **one-click fixes**: drop ID columns, convert numbers stored as text, tidy messy
spelling, extract date parts, remove duplicates, balance classes, and drop columns that leak the
answer.

**Clean** (whole table): drop columns, change types, tidy text, replace values, date parts,
combine columns, remove duplicates or rows with gaps, filter rows, sample rows.

**Split:** random, stratified or time-ordered train/test split, plus optional k-fold
cross-validation.

**Training rows** (never touch test rows): remove outliers (IQR, z-score, isolation forest), and
balance classes (oversample, undersample, SMOTE, class weights).

**Transform** (learned from training rows only, so scores stay honest):
- fill missing values (median, mean, mode, constant, KNN);
- encode categories (one-hot, ordinal, frequency, target);
- scale, fix skew (Yeo-Johnson, Box-Cox, log, quantile), cap outliers, bin;
- add interactions, turn text into features (TF-IDF);
- select features (k best, variance, drop correlated), PCA.

**Auto-prep** finishes any table for the model: numbers only, no gaps.

**Models:**
- *tables:* baseline, logistic/linear (ridge, lasso, elastic net), decision tree, random forest,
  extra trees, gradient boosting (classic and histogram), XGBoost, LightGBM, SVM, k-NN, naive Bayes,
  AdaBoost;
- *neural networks:* designed layer by layer (dense, dropout, batch norm). They train on the GPU
  with PyTorch, or with NumPy in the browser;
- *images:* a custom CNN (convolution, pooling, batch norm, dropout, dense), or transfer learning
  from ResNet-18/50, MobileNet V3 or EfficientNet-B0, with augmentation.

Optional automatic tuning on any model. Training is live: per-epoch loss curves, tuning trials,
progress.

**Evaluate.** A leaderboard against a baseline, and for each model:
- test and training scores (overfitting warnings), cross-validation spread;
- confusion matrix, ROC and precision-recall curves, calibration;
- predicted-vs-actual and residual plots;
- feature importance, both permutation and the model's own;
- per-class scores, and a gallery of misclassified images.

**Predict.** A form generated from the model's inputs that updates as you type; score a whole file;
classify uploaded images.

**Export.** A folder that runs without Synapse:

| File | What |
| --- | --- |
| `model.joblib` + `synapse_runtime.py` | the whole pipeline, raw rows in, predictions out |
| `predict.py` | `python predict.py new.csv` → `predictions.csv` |
| `serve.py` | a standard-library HTTP prediction server |
| `train.py` | the same training as an editable script |
| `schema.json`, `example.csv`, `requirements.txt` (pinned), `MODEL_CARD.md` | inputs, sample rows, packages, model card |
| `model.pt` (TorchScript), `model.onnx`, `labels.json` | image networks |

## How it is built

```
apps/web/            React + TypeScript app (Vite, React Flow, hand-made SVG charts)
  src/engine/        one Engine interface: BrowserEngine (Pyodide worker) and RemoteEngine (HTTP)
src/synapse_runtime.py   what exported models need: transformers, auto-prep, NumPy networks
src/synapse_studio/
  core/              the engine (pure Python: pandas, scikit-learn, PyTorch when present)
    catalogue.py     every step and model, with the parameter forms the UI draws
    datasets.py      import, samples, profiling, suggested fixes
    project.py       pipeline spec, checks, step previews
    training.py      split → training rows → pipelines → tuning/CV → evaluation
    images.py        CNNs and transfer learning
    export.py        export folders, train.py code generation, model cards
    rpc.py           Engine.call(method, params): the single API every frontend uses
  worker.py          the kernel process (JSON lines over stdin/stdout)
  browser.py         the same API inside Pyodide
  server/            FastAPI server, kernel manager, Python discovery, desktop window
```

The same `core` code runs in the desktop kernel, in `synapse engine`, and in the browser.
`scripts/pack-core.mjs` zips it for Pyodide at web build time.

## Develop

```bash
pip install -e ".[dev,deep]"
make test lint typecheck              # pytest, ruff, mypy
cd apps/web && npm install && npm test && npm run build

synapse engine --port 8899            # terminal 1: a local engine
cd apps/web && npm run dev            # terminal 2: http://localhost:5173 (browser engine), or
                                      #   open the link the engine prints to use it
python scripts/bundle_web.py          # put the built app inside the Python package
python scripts/build_app.py           # desktop app for this OS (dist/)
```

**Add a technique:** add an entry to `core/catalogue.py` (parameters plus a builder that returns a
scikit-learn transformer or estimator). The app shows it with no frontend change. Add a test in
`tests/test_training.py`.

## Limits and next steps

- The browser engine has no PyTorch, so image models and GPU training need an engine. Its first
  start downloads about 40 MB; browsers cache it afterwards.
- From the hosted page, browsers allow an engine on the same computer (`127.0.0.1`). For an engine
  on another machine, open the page that engine serves itself.
- Not yet: clustering and other tasks without a target, text and sequence models, ONNX export of
  table pipelines, code-signed desktop builds.

MIT licensed. Earlier work on this repository (the FlowLab graph IDE) is kept under the git tag
`ide-final`.
