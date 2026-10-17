# 0015 — Synapse: from a graph IDE to a visual, no-code ML studio

**Status:** accepted · 2026-10-17

## Context
FlowLab was a graph IDE: code as draggable graphs, kernels, structure views for any language. The
goal changed to a product that takes a dataset through preprocessing, training and export
visually, without code, for classic ML and deep learning. It should ship as an app and in the
browser, stay open source, and still let people use their own machine's compute.

## Decision
- **Rename and rebuild.** The product is **Synapse** (`synapse-studio` on PyPI, `synapse` CLI). The
  IDE packages (`flowspec`, `nodes`, `engine`, `lab`, `agent`) and their UI are removed. They stay
  in history under the tag `ide-final`.
- **One engine core, three hosts.** `synapse_studio.core` is pure Python (pandas, scikit-learn,
  PyTorch when installed). Every frontend calls it through one RPC surface
  (`Engine.call(method, params)`):
  - *browser:* Pyodide 314.0.7 in a Web Worker, files in IndexedDB;
  - *desktop / `synapse engine`:* a kernel process speaking JSON lines, started from a Python
    environment the user chooses, like a Jupyter kernel. The packaged app can be its own kernel
    (`--worker`) for classic ML without any Python installed.
- **A browser can borrow a computer's power.** `synapse engine` serves the API with a per-launch
  token, a loopback-only default, `Host` checks, an origin allow-list (the hosted app and local dev)
  and Private Network Access preflights. It prints a link that opens the hosted app connected to it.
- **A structured pipeline, not free wiring.** Stages are fixed:
  Clean → Split → Training rows → Transform → Auto-prep → Models.
  - Steps are chosen from a catalogue whose parameter schemas drive the UI.
  - Learned steps are fitted inside a scikit-learn `Pipeline` on training rows only, so
    preprocessing leakage is impossible by construction.
  - Training-set steps (outliers, balancing) never touch test rows.
  - The canvas shows stages as columns and models as parallel branches, so comparing models is
    natural.
- **Exports run without Synapse.** Fitted pipelines are wrapped in `SynapseModel` and use only
  classes in the single-file `synapse_runtime.py`, which is copied into every export.
  - Tabular neural networks always predict with NumPy (weights are copied out of PyTorch after
    training), so exports need no torch.
  - `train.py` is generated from the estimator objects themselves, and is tested by running it.
- **Deep learning scope.** Tabular MLPs: PyTorch with CUDA or MPS, or NumPy everywhere. Images:
  custom CNNs and transfer learning (ResNet, MobileNet, EfficientNet), with augmentation. Text and
  sequence models are not in scope yet.
- **Distribution:**
  - GitHub Pages for the browser app (`pages.yml`);
  - PyInstaller builds for Linux, macOS and Windows, smoke-tested in CI (`app.yml`);
  - a wheel that carries the built web app;
  - MIT license.

## Consequences
- Pyodide has no PyTorch: image models and GPU training need an engine. The UI says so where it
  matters.
- Pretrained weights are downloaded by Synapse (timeout, retries, progress) instead of torch's
  downloader, which can hang without feedback.
- The browser engine runs jobs synchronously; Stop restarts its worker. Kernel jobs stop between
  steps, and a long single fit can be ended by restarting the kernel.
