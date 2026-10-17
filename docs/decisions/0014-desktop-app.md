# 0014 — FlowLab as a desktop app for Linux, macOS and Windows

**Status:** accepted · 2026-10-17

## Context
FlowLab was a developer checkout: clone, `npm run build`, `flowlab serve`, open a browser with a
token in the URL. To be usable by people who are not setting up a repository it has to install
like an application and open like one.

The hard part is Python. FlowLab's own runtime (server, analysers, snippet library, canvas) can be
frozen and shipped, but the code a user runs must execute in *their* environment, with their
pandas, scikit-learn or torch. A frozen app that tried to run user code inside itself would ship
the wrong packages and could not install new ones.

## Decision
- **Two Pythons, named clearly.** The app ships its own runtime for FlowLab itself. Kernels start
  from an interpreter the user picks (`flowlab_lab.interpreters`):
  - discovery finds the project's `.venv`/`venv`, `$CONDA_PREFIX` and `$VIRTUAL_ENV`, conda
    environments under the home directory, and `python3`/`py` on PATH;
  - each candidate is probed once (cached by path and mtime) for its version and whether
    `ipykernel` is importable, so unusable ones are visibly disabled rather than failing later;
  - a venv is never merged with its base interpreter, even though its `python` is a symlink;
  - the choice is stored per project in `.flowlab/lab.json`;
  - kernels start through a generated kernelspec in `~/.flowlab/kernels/flowlab-<hash>/`, whose
    `argv` names the chosen interpreter. A frozen app therefore never execs itself as a kernel.
  - A packaged build with no choice made picks the first discovered interpreter that has
    ipykernel; if there is none, the Kernel panel asks for one instead of failing obscurely.
- **One window, one local server.** `flowlab app` (also the app's launcher) starts the server on a
  free port with a per-launch token, then opens a native window through pywebview — WebKitGTK on
  Linux, WKWebView on macOS, WebView2 on Windows. With no webview available it opens the default
  browser, so the app still works. Closing the window stops the server.
- **First run.** With no folder given, the app reopens the last workspace; on a first run it
  creates `~/FlowLab` and copies the `ml-lab` example project into it, so there is something to
  open.
- **The canvas ships inside the wheel.** `scripts/bundle_web.py` builds `apps/web` and copies the
  result into `flowlab_api/web/` (plus the example project), which the package data includes.
  `pip install flowlab` therefore needs no Node, and the same bundle feeds PyInstaller.
- **Packaging per platform** (`scripts/build_app.py` + `packaging/flowlab.spec`):
  - Linux: `tar.gz` with `install.sh` that installs to `~/.local/share/flowlab`, adds a desktop
    entry and a `flowlab-app` command;
  - macOS: `FlowLab.app` and a `.dmg`;
  - Windows: a zip, and an Inno Setup installer when `iscc` is available.
  `.github/workflows/app.yml` builds all four targets (Linux x86-64, macOS arm64 and x86-64,
  Windows x64), smoke-tests each build (`scripts/smoke_app.py` runs the binary with `--check`,
  which starts the server and asserts the canvas is served) and attaches them to a `v*` tag.
- **Installing with pip stays first-class.** `pipx install flowlab` then `flowlab app` works on all
  three systems and reuses the user's Python, which is the best experience for people who already
  have an environment.

## Consequences / not yet
- The builds are unsigned: macOS needs right-click → Open (or notarization later), and Windows
  shows a SmartScreen warning. Signing needs certificates the project does not have yet.
- The bundle is large (hundreds of MB) because FlowLab's own analysis uses pandas, scikit-learn,
  polars and pyarrow. Splitting the analysers out of the app process would shrink it.
- On Linux the native window needs a WebKitGTK runtime; without it the app opens the browser.
- Automatic updates, a signed Homebrew cask and a winget manifest are not in place.
