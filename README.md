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

FlowLabs runs three ways. Pick one:

| | Good for | Needs |
| --- | --- | --- |
| [**Desktop app**](#desktop-app) (recommended) | Everyday use: every feature, offline, large data, database connections, Ask AI, GPUs | Linux, macOS or Windows (64-bit); about 200 MB to download and 750 MB on disk |
| [**In the browser**](https://adityatakuli.github.io/FlowLabs/) | Trying it, teaching, small and medium tables | A modern browser. Nothing to install; data never leaves your device |
| [**Python package**](#python-package) | People who already work in Python, or a GPU server | Python 3.11 or newer |

4 GB of memory is enough for most tables; large datasets and neural networks are happier with 8 GB
or more. A GPU is optional (NVIDIA with CUDA, or Apple silicon), see [the engine](#the-engine-use-your-own-computers-power-from-the-browser).

### Desktop app

Download the file for your system from the
[latest release](https://github.com/AdityaTakuli/FlowLabs/releases/latest), then:

**Ubuntu and Debian** (Ubuntu 22.04 or newer, Debian 12 or newer, 64-bit Intel/AMD)

Double-click the `.deb` file and click **Install**, or run this in the folder you downloaded it to:

```bash
sudo apt install ./FlowLabs-*-linux-amd64.deb
```

Or download and install the latest release in one go, with the [GitHub CLI](https://cli.github.com):

```bash
gh release download --repo AdityaTakuli/FlowLabs --pattern "*linux-amd64.deb" --dir /tmp/flowlabs --clobber
sudo apt install /tmp/flowlabs/FlowLabs-*-linux-amd64.deb
```

`apt` also installs what the app window needs (GTK and WebKitGTK). Open **FlowLabs** from your
applications menu, or run `flowlabs-app`.

**Other Linux** (64-bit Intel/AMD)

```bash
tar -xzf FlowLabs-*-linux-x86_64.tar.gz
sh FlowLabs/install.sh   # installs to ~/.local/share/flowlabs, adds a menu entry and the flowlabs-app command
```

For the app's own window, install your distribution's WebKitGTK 4.1 package (`webkit2gtk4.1` on
Fedora, `webkit2gtk-4.1` on Arch). Without it, FlowLabs opens in your browser instead.

**macOS** (11 Big Sur or newer)

1. Download `FlowLabs-*-macos-arm64.dmg` for Apple silicon (M1 and later), or
   `FlowLabs-*-macos-x86_64.dmg` for Intel Macs.
2. Open it and drag **FlowLabs** to **Applications**.
3. The first time, right-click FlowLabs in Applications, choose **Open**, then **Open** again. The
   app is not code-signed yet, so macOS asks once.

**Windows** (10 and 11, 64-bit)

1. Download and run `FlowLabs-*-windows-x64-setup.exe`. No administrator rights are needed.
2. If SmartScreen warns about an unrecognised app, click **More info**, then **Run anyway**. The
   app is not code-signed yet.

Prefer not to install? Unzip `FlowLabs-*-windows-x64.zip` and run `FlowLabs.exe`.

**After installing**

- **Your work** (datasets, projects, models, exports) is kept in a `FlowLabs` folder in your home
  folder, so updating or reinstalling keeps it.
- **Updates** install themselves. From 0.4.0 on, an **Update to …** button appears in the top bar
  when a new release is out, and installs it:
  - **Linux:** the new `.deb` (Ubuntu asks for your password);
  - **macOS:** replaces the app;
  - **Windows:** runs the installer silently.

  Each download is checked against the SHA-256 in the release's `latest.json`. Turn checking off
  in the update dialog; the Engine menu has an **Updates** button to check by hand.
- **The first start** after installing takes a little longer while your system loads the app. You
  see the FlowLabs intro while Python starts.
- **Check the version:** open the engine menu (the chip at the top right, "This computer") and look
  under **Updates**.
- **Something went wrong?** The app window opening in your browser, macOS or Windows refusing to
  open it, or "The engine did not start": see
  [Troubleshooting](docs/guide/troubleshooting.md), also in the app under **Guide**.
- **Uninstall:**

  | System | How |
  | --- | --- |
  | Ubuntu, Debian | `sudo apt remove flowlabs` |
  | macOS | Move FlowLabs to the Bin |
  | Windows | Settings → Apps → FlowLabs → Uninstall |

  Your `~/FlowLabs` folder stays; delete it yourself if you no longer need it.

### Python package

```bash
python -m venv flowlabs-env && source flowlabs-env/bin/activate   # Windows: flowlabs-env\Scripts\activate
pip install "flowlabs[deep,sql]"     # [deep]: PyTorch for neural networks and images; [sql]: database drivers
flowlabs app                         # opens the app in your browser
```

For the app's own window instead of a browser tab, install `flowlabs[deep,sql,desktop]`. On Linux
the window also needs PyGObject and WebKitGTK from your distribution. On Ubuntu, run
`sudo apt install python3-gi gir1.2-webkit2-4.1`, and create the environment with
`python -m venv --system-site-packages flowlabs-env` so it can see them.

Leave out `[deep]` for a much smaller install with classic models only.
`pip install -U "flowlabs[deep,sql]"` updates it, and `flowlabs --version` shows the version.

### From source (developers)

```bash
git clone https://github.com/AdityaTakuli/FlowLabs.git && cd FlowLabs
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev,deep,sql,desktop]"
npm install --prefix apps/web && npm run build --prefix apps/web
python scripts/bundle_web.py --no-build   # puts the built web app inside the Python package
flowlabs app
```

To build the installable app for your system (`dist/`):

```bash
pip install -e ".[build,sql]"
python scripts/build_app.py
```

See [Develop](#develop) for tests and the release process.

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

**Analyze.** Each project's Analyze step:

- **Table:** the whole dataset as a grid (sort, search every column, page through every row).
- **SQL:** queries in [DuckDB](https://duckdb.org). `data` is the project's table, your other
  datasets are tables too, and queries never change your files.
- **Your databases:** connect PostgreSQL, MySQL or MariaDB, a SQLite or DuckDB file, or any
  [SQLAlchemy URL](https://docs.sqlalchemy.org/en/20/core/engines.html#database-urls) (Snowflake,
  SQL Server…; install the driver in the engine). Connections are read-only unless you allow changes.
  They are saved in the engine's workspace (`connections.json`, readable only by you). First-class
  forms for Snowflake, BigQuery, Redshift, Databricks, SQL Server, Oracle and cloud storage (S3,
  Azure, Google Cloud Storage), with passwords in your system's keychain, are on the way.
- **Results:** keep any result as a dataset, or as the project's own data, and train on it.
- **Ask AI:** a question in plain English becomes SQL, written by a model on
  [Groq](https://console.groq.com/keys) with your own key (`GROQ_API_KEY`, or saved in the app).
  It sends table and column names, and a few common category values, never rows. **Fix with AI**
  corrects a failed query.

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
- Database connections and Ask AI need the desktop app or an engine: browsers cannot reach database
  servers or Groq.
- Not yet: clustering and other tasks without a target, text and sequence models, ONNX export of
  table pipelines, code-signed desktop builds.

MIT licensed. Earlier work on this repository (the FlowLab graph IDE) is kept under the git tag
`ide-final`.
