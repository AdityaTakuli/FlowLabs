# FlowLabs

**Data, SQL and machine learning in one place, without writing code.** Bring a table or a folder of
images. Explore it in a grid, query it with SQL (or ask in plain English), clean and prepare it, train
and compare models (from linear regression to neural networks you design layer by layer), see every
result as interactive charts, then export a model that runs anywhere.

```
Data → Analyze → Clean → Split → Training rows → Transform → Models → Evaluate → Export
```

Everything happens on a visual pipeline. Every step shows its effect on the data before you train,
and every technique explains what it does. When you want more control, any step or model can be
opened as Python and edited by hand. A built-in **Guide** explains every page.

## Install

**Linux or macOS:** open a terminal and run:

```bash
curl -fsSL https://raw.githubusercontent.com/AdityaTakuli/FlowLabs/main/install.sh | sh
```

**Windows:** open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/AdityaTakuli/FlowLabs/main/install.ps1 | iex
```

That's it. Open **FlowLabs** from your applications menu, Launchpad or Start menu.

The command downloads the right version for your computer, checks that the download is complete and
unchanged, and installs it. On Ubuntu and Debian it asks for your password once.

**Just want to try it?** [Open FlowLabs in your browser](https://adityatakuli.github.io/FlowLabs/),
with nothing to install. It suits small and medium tables. The desktop app adds database connections,
Ask AI, GPUs and large data.

Works on Windows 10 and 11, macOS 11 or newer, and 64-bit Linux (Ubuntu 22.04 or Debian 12 and
newer). About 200 MB to download.

### After installing

- **Your projects** are kept in a `FlowLabs` folder in your home folder. Updating or reinstalling
  keeps them.
- **Updates are automatic.** When a new version is out, an **Update** button appears at the top of
  the app. Click it, and FlowLabs installs the update and restarts.
- **Help** is built in: open **Guide** at the top of the app. If FlowLabs will not start, see
  [Troubleshooting](docs/guide/troubleshooting.md).

<details>
<summary>Install by hand (download the file yourself)</summary>

Download the file for your system from the
[latest release](https://github.com/AdityaTakuli/FlowLabs/releases/latest):

| System | File | Install |
| --- | --- | --- |
| Ubuntu, Debian | `FlowLabs-*-linux-amd64.deb` | Double-click it, or run `sudo apt install ./FlowLabs-*-linux-amd64.deb` |
| Other Linux | `FlowLabs-*-linux-x86_64.tar.gz` | `tar -xzf FlowLabs-*.tar.gz && sh FlowLabs/install.sh` |
| Mac with Apple silicon (M1 and later) | `FlowLabs-*-macos-arm64.dmg` | Open it and drag FlowLabs to Applications |
| Mac with Intel | `FlowLabs-*-macos-x86_64.dmg` | Open it and drag FlowLabs to Applications |
| Windows | `FlowLabs-*-windows-x64-setup.exe` | Run it |

The apps are not code-signed yet, so a file downloaded in a browser gets a warning the first time:

- **macOS:** right-click FlowLabs in Applications, choose **Open**, then **Open** again.
- **Windows:** when SmartScreen warns you, click **More info**, then **Run anyway**.

On Linux other than Ubuntu and Debian, install your distribution's WebKitGTK 4.1 package for the app
window (`webkit2gtk4.1` on Fedora, `webkit2gtk-4.1` on Arch). Without it, FlowLabs opens in your
browser.

</details>

<details>
<summary>Uninstall</summary>

| System | How |
| --- | --- |
| Ubuntu, Debian | `sudo apt remove flowlabs` |
| Other Linux | `rm -rf ~/.local/share/flowlabs ~/.local/bin/flowlabs-app ~/.local/share/applications/FlowLabs.desktop` |
| macOS | Move FlowLabs from Applications to the Bin |
| Windows | Settings → Apps → FlowLabs → Uninstall |

Your projects in the `FlowLabs` folder stay. Delete the folder yourself if you no longer need them.

</details>

<details>
<summary>Installer options: a particular version, or download only</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/AdityaTakuli/FlowLabs/main/install.sh | FLOWLABS_VERSION=0.5.4 sh
curl -fsSL https://raw.githubusercontent.com/AdityaTakuli/FlowLabs/main/install.sh | FLOWLABS_DRY_RUN=1 sh
```

On Windows, set `$env:FLOWLABS_VERSION = "0.5.4"` or `$env:FLOWLABS_DRY_RUN = "1"` before the
command. The scripts are short: [install.sh](install.sh), [install.ps1](install.ps1).

</details>

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

**Analyze.** Each project's Analyze step:

- **Table:** the whole dataset as a grid (sort, search every column, page through every row).
- **SQL:** queries in [DuckDB](https://duckdb.org). `data` is the project's table, your other
  datasets are tables too, and queries never change your files.
- **Your databases:** query a connected database from the project too (see **Databases** below).
- **Results:** keep any result as a dataset, or as the project's own data, and train on it.
- **Ask AI:** a question in plain English becomes SQL, written by a model on
  [Groq](https://console.groq.com/keys) with your own key (`GROQ_API_KEY`, or saved in the app).
  It sends table and column names, and a few common category values, never rows. **Fix with AI**
  corrects a failed query.

**Databases.** A page for working in PostgreSQL, MySQL and MariaDB (and SQLite) the way pgAdmin and
MySQL Workbench do:

- **Connect** with SSL (certificates checked if you ask) and SSH tunnels (the server's key is
  checked). Snowflake, BigQuery, Redshift, Databricks, SQL Server, Oracle and cloud storage (S3,
  Azure, Google Cloud Storage) connect too, for querying from a project. Drivers install on first
  use; passwords go in your system's keychain. Connections are read-only unless you allow changes,
  and a read-only session is read-only on the server itself.
- **Browse** databases, schemas, tables, views, functions, procedures, triggers and sequences, with
  sizes, columns, keys, indexes and each object's CREATE script.
- **Query** in tabs that keep their own session (transactions, `SET`, `USE`, temporary tables).
  Run the statement under the cursor, stop a running query on the server, read plans as a tree
  (EXPLAIN and EXPLAIN ANALYZE), keep a history, export to CSV, Excel, JSON or Parquet, or keep a
  result as a dataset to train on.
- **Edit** rows in place (reviewed as SQL, saved in one transaction), and import a dataset as a table.
- **Design tables** in a form (columns, keys, indexes, foreign keys, checks), reviewed as the exact
  ALTER statements before anything runs; see the schema as an **ER diagram**.
- **Back up and restore** to and from `.sql` files, built in or with pg_dump and mysqldump; restore
  reads pg_dump and mysqldump files too.
- **Administer:** server activity with Stop query and End session, users and roles with grants.

**Evaluate.** A leaderboard against a baseline, a score-and-training-time chart, and box plots of
cross-validation folds. Every chart expands to full screen (zoom and pan) or opens in its own window.
The Charts step shows them all on one grid, with tabs for Overview, Data, Model and Compare. For each
model:
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
    sql.py           SQL on datasets (DuckDB) and on connected databases
    sources.py       every kind of connection: its form fields, drivers and URL
    databases.py     the Databases page: browse, sessions, edit, export, plans, admin
    backup.py        database backups and restores (.sql, pg_dump and mysqldump files)
    design.py        the table designer: a form's design as CREATE and ALTER statements
    tunnel.py        SSH tunnels to databases behind a firewall
    vault.py         passwords and keys in the system keychain
    ai.py            Ask AI: plain English to SQL with Groq
    rpc.py           Engine.call(method, params): the single API every frontend uses
  worker.py          the kernel process (JSON lines over stdin/stdout)
  browser.py         the same API inside Pyodide
  server/            FastAPI server, kernel manager, Python discovery, desktop window, updates
docs/guide/          the user guide, shown in the app's Guide page
docs/releases/       release notes, one file per version
```

The same `core` code runs in the desktop kernel, in `flowlabs engine`, and in the browser.
`scripts/pack-core.mjs` zips it for Pyodide at web build time.

## For developers

### Run from source

```bash
git clone https://github.com/AdityaTakuli/FlowLabs.git && cd FlowLabs
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -e ".[dev,deep,sql,desktop]"
npm install --prefix apps/web && npm run build --prefix apps/web
python scripts/bundle_web.py --no-build               # puts the built web app inside the Python package
flowlabs app
```

On Linux, the app's own window needs PyGObject and WebKitGTK from your distribution (on Ubuntu,
`sudo apt install python3-gi gir1.2-webkit2-4.1`), and a virtualenv made with
`python -m venv --system-site-packages .venv` to see them. Without them, `flowlabs app` opens your
browser.

### Use FlowLabs as a Python package

FlowLabs is not on PyPI yet. Each release has the package attached; install it with pip:

```bash
VERSION=0.5.4   # the latest release
pip install "flowlabs[deep,sql] @ https://github.com/AdityaTakuli/FlowLabs/releases/download/v$VERSION/flowlabs-$VERSION-py3-none-any.whl"
flowlabs app    # opens FlowLabs in your browser
```

`[deep]` adds PyTorch for neural networks and image models. Leave it out for a much smaller install.
`[sql]` adds the PostgreSQL and MySQL drivers.

### Train on another computer's GPU

FlowLabs trains in an **engine**: a Python process, like a Jupyter kernel. The desktop app has its
own. To use a more powerful computer, such as a GPU server, install the Python package there
(above), then run:

```bash
flowlabs engine --host 0.0.0.0
```

Open the link it prints from your own computer. Every request needs the token in that link, so share
it only with people you trust. In the app, **Engine → Python environments** runs the engine in any
virtualenv or conda environment on that computer, and installs PyTorch, XGBoost or LightGBM where
they are missing.

### Tests and development servers

```bash
make test lint typecheck              # pytest, ruff, mypy
cd apps/web && npm test               # web app tests

flowlabs engine --port 8899            # terminal 1: a local engine
cd apps/web && npm run dev            # terminal 2: http://localhost:5173, or open the link the engine prints
python scripts/build_app.py           # the installable desktop app for this system, in dist/
```

### Release a version

Set `__version__` in `src/flowlabs/__init__.py` (the only place it is set), write the notes in
`docs/releases/v<version>.md`, commit, then tag and push it
(`git tag v<version> && git push origin v<version>`). The Desktop app workflow:

1. checks the tag matches the version;
2. creates the release with those notes;
3. builds and uploads every app, retrying uploads that time out;
4. writes `latest.json`, which installed apps and the install commands read.

### The user guide

The guide is in `docs/guide/*.md`, shown on the app's **Guide** page
(`apps/web/src/guide/topics.ts` lists the pages). Links between pages are written
`[text](guide:topic#section)`, and `npm test` checks that every one resolves. The step and model
reference is generated from the catalogue, so it needs no editing.

### Add a technique

Add an entry to `core/catalogue.py` (parameters plus a builder that returns a scikit-learn
transformer or estimator). The app shows it with no frontend change. Add a test in
`tests/test_training.py`.

## Limits and next steps

- The browser engine has no PyTorch, so image models and GPU training need an engine. Its first
  start downloads about 40 MB; browsers cache it afterwards.
- From the hosted page, browsers allow an engine on the same computer (`127.0.0.1`). For an engine
  on another machine, open the page that engine serves itself.
- Database connections and Ask AI need the desktop app or an engine: browsers cannot reach database
  servers or Groq.
- Not yet: clustering and other tasks without a target, text and sequence models, ONNX export of
  table pipelines, code-signed desktop builds.

MIT licensed. Earlier work on this repository (the FlowLab graph IDE) is kept under the git tag
`ide-final`.
