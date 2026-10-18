# FlowLabs

**Machine learning without writing code.** Bring a table or a folder of images, clean and prepare
it, train and compare models (from linear regression to neural networks you design layer by layer),
then export a model that runs anywhere.

```
Data → Clean → Split → Training rows → Transform → Models → Evaluate → Export
```

Everything happens on a visual pipeline. Every step shows its effect on the data before you train,
and every technique explains what it does. When you want more control, any step or model can be
opened as Python and edited by hand.

## Three ways to run it

| | How | Good for |
| --- | --- | --- |
| **In the browser** | Open the hosted app (GitHub Pages). Python runs inside the tab via [Pyodide](https://pyodide.org). | Trying it, teaching, small and medium tables. Nothing to install, and data never leaves your device. |
| **Desktop app** | From Releases: `.deb` for Ubuntu/Debian (double-click, or `sudo apt install ./FlowLabs-*.deb`), `.tar.gz` for other Linux (`sh FlowLabs/install.sh`), `.dmg` for macOS, `setup.exe`/`.zip` for Windows. | Larger data and every feature, offline. |
| **pip** | `pip install "flowlabs[deep,sql]"`, then `flowlabs app` | People who already have Python, a GPU, or a server. |

The desktop app updates itself. When a new release is out, an **Update** button appears in the top
bar and installs it:
- **Linux:** the new `.deb` (Ubuntu asks for your password);
- **macOS:** replaces the app;
- **Windows:** runs the installer silently.

Each download is checked against the SHA-256 in the release's `latest.json`. Turn checking off in
the update dialog; the Engine menu has an **Updates** button to check by hand.

### The engine: use your own computer's power from the browser

Like a Jupyter kernel, FlowLabs trains in an **engine**: a Python process on whichever computer you
choose, with that machine's packages, CPU cores and GPU (CUDA or Apple Metal).

```bash
pip install "flowlabs[deep]"   # scikit-learn + PyTorch + torchvision
flowlabs engine                       # prints a link that opens the web app connected to this machine
```

- **Engine menu → Python environments.** Run the kernel in any virtualenv or conda environment on
  the machine. FlowLabs probes each one for pandas, scikit-learn, PyTorch, XGBoost and LightGBM, and
  can install what is missing.
- **Another machine** (a GPU server): `flowlabs engine --host 0.0.0.0` and open the address it
  prints. Every request needs the engine's token.
- Each engine keeps its own datasets, projects and models (in `~/FlowLabs` by default; the browser
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

**Your own code.** Select any step or model and switch to **Python** to see the code it runs
with your current settings. **Edit as code** turns it into a code step you can change line by line
(the original is kept, switched off, so you can go back). You can also add code steps directly:

| Where | You write | Runs on |
| --- | --- | --- |
| Clean | `clean(df)` returning the table | the whole table, and new data when predicting |
| Training rows | `rows(X, y)` returning `X, y` | training rows only |
| Transform | `fit(X, y)` and `transform(X, state)`, or `transformer = <any scikit-learn transformer>` | learned from training rows, applied everywhere |
| Models | `model = <anything with fit and predict>` | the prepared training rows |

`pd`, `np` and `math` are ready to use. Errors point at the line that failed. Code steps travel with
the export, so `predict.py` and `train.py` run them too. They run on the engine you are connected
to, so only connect to engines you trust and share engine tokens only with people you trust.

Optional automatic tuning on any model. Training is live: per-epoch loss curves, tuning trials,
progress.

**SQL.** The SQL page, next to Projects, queries your data with SQL:

- **Your datasets:** every dataset is a table (`Customer churn` is `customer_churn`), queried with
  [DuckDB](https://duckdb.org), joins and window functions included. Queries run on copies of your
  data, so the files never change. Save any result as a new dataset and start a project from it.
- **Your databases:** connect PostgreSQL, MySQL or MariaDB, a SQLite or DuckDB file, or any
  [SQLAlchemy URL](https://docs.sqlalchemy.org/en/20/core/engines.html#database-urls) (install its
  driver in the engine first). Browse the tables, query them, and import a result as a dataset.
  Connections are read-only unless you allow changes. A read-only connection refuses statements
  that write and rolls back whatever a query ran.

The editor completes table and column names, and Ctrl+Enter runs the query. Connections, passwords
included, are saved in the engine's workspace (`connections.json`, readable only by you). Queries
run on the computer the engine runs on. The browser version queries your datasets but cannot reach
database servers.

**Evaluate.** A leaderboard against a baseline, a score-and-training-time chart, and box plots of
cross-validation folds. For each model:
- test and training scores (overfitting warnings), cross-validation spread;
- confusion matrix, ROC and precision-recall curves, calibration, and how well the classes separate;
- predicted-vs-actual and residual plots;
- feature importance, both permutation and the model's own;
- per-class scores, and a gallery of misclassified images.

**Predict.** A form generated from the model's inputs that updates as you type; score a whole file;
classify uploaded images.

**Export.** A folder that runs without FlowLabs:

| File | What |
| --- | --- |
| `model.joblib` + `flowlabs_runtime.py` | the whole pipeline, raw rows in, predictions out |
| `predict.py` | `python predict.py new.csv` → `predictions.csv` |
| `serve.py` | a standard-library HTTP prediction server |
| `train.py` | the same training as an editable script |
| `schema.json`, `example.csv`, `requirements.txt` (pinned), `MODEL_CARD.md` | inputs, sample rows, packages, model card |
| `model.pt` (TorchScript), `model.onnx`, `labels.json` | image networks |

## How it is built

```
apps/android/        an experimental Android shell (not released yet)
apps/web/            React + TypeScript app (Vite, React Flow, hand-made SVG charts)
  src/engine/        one Engine interface: BrowserEngine (Pyodide worker) and RemoteEngine (HTTP)
src/flowlabs_runtime.py   what exported models need: transformers, auto-prep, NumPy networks
src/flowlabs/
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

The same `core` code runs in the desktop kernel, in `flowlabs engine`, and in the browser.
`scripts/pack-core.mjs` zips it for Pyodide at web build time.

## Develop

```bash
pip install -e ".[dev,deep,sql]"
make test lint typecheck              # pytest, ruff, mypy
cd apps/web && npm install && npm test && npm run build

flowlabs engine --port 8899            # terminal 1: a local engine
cd apps/web && npm run dev            # terminal 2: http://localhost:5173 (browser engine), or
                                      #   open the link the engine prints to use it
python scripts/bundle_web.py          # put the built app inside the Python package
python scripts/build_app.py           # desktop app for this OS (dist/)
python scripts/build_apk.py           # Android APK (experimental, not released yet; needs a JDK and the Android SDK)
```

**Release a version:** set `__version__` in `src/flowlabs/__init__.py` (the only place it is set),
write the notes in `docs/releases/v<version>.md`, commit, then tag and push it
(`git tag v<version> && git push origin v<version>`). The Desktop app workflow:
1. checks the tag matches the version;
2. creates the release with those notes;
3. builds and uploads every app, retrying uploads that time out;
4. writes `latest.json`, which installed apps read to update themselves.

**The user guide** is in `docs/guide/*.md`. The app shows it on its **Guide** page (`apps/web/src/guide/topics.ts`
lists the pages), and the same files can feed a website. Links between pages are written
`[text](guide:topic#section)`, and `npm test` checks that every one resolves. The step and model
reference is generated from the catalogue, so it needs no editing.

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
