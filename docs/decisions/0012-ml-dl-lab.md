# 0012 — Data analysis, ML and DL training in Code Mode

**Status:** accepted · 2026-09-16

## Context
Cells and kernels are the part of FlowLab built for data work. They already showed DataFrames,
arrays, sklearn estimators and HTTP responses on edges. Deep learning was missing: tensors, models,
data loaders and optimizers showed as bare objects, training progress was only raw console text,
and tqdm bars scrolled the console line by line. Backend-code features are parked for now.

## Decision
- **Summaries** (kernel helper, no pickling, nothing leaves the kernel except metadata):
  - *Tensors:* shape, dtype, device, grad flag, and min/mean/max when there are at most 20M
    elements.
  - *`nn.Module`:* total and trainable parameters, top-level layers with their parameter counts,
    device, train/eval mode.
  - *`DataLoader` / `Dataset`:* batch size, batches, dataset length, shuffle, the shape of one item.
  - *Optimizers:* type, learning rate, hyperparameters.
  - *Keras models:* parameter count and layers.
  - *Fitted sklearn estimators:* also report feature count, classes and the top feature importances.

  Edges and cards use short labels, e.g. `ChurnNet · 1.4k params`,
  `DataLoader · 38 batches × 64` or `Tensor 3000×8 · float32`.
- **Training metrics without code changes** (`flowlab_lab.metrics.MetricParser`):
  - Streamed output is parsed line by line, reassembling lines that arrive split.
  - Recognised shapes: `epoch 3 loss=0.41 val_acc=0.87`, `step 120 | loss: 0.3`, Keras
    `Epoch 3/10` plus `- loss: … - accuracy: …`, Hugging Face log dicts, `[3/5] train_loss 0.2`, and
    `fold 2 roc_auc=0.9`.
  - Only metric-like names count (loss, acc, f1, auc, rmse, lr, …), so lines like `rows 2000` or
    shapes are ignored.
  - `flowlab_log(step=…, **metrics)` is available in every FlowLab kernel for exact logging. It
    sends a private display message, is hidden from the variable list, and never prints.
- **Progress:** tqdm's `\r` updates become node progress events. `tqdm.auto`/`tqdm.notebook`
  resolve to the text bar inside FlowLab kernels, because the canvas does not render Jupyter
  widgets. The console rewrites the open line in place instead of appending one line per update.
- **Events and storage:** `metric` and `progress` events stream per node. The execution record
  keeps up to 5,000 metric points. `/api/state` returns the last 1,000 per node, separately from
  the run record.
- **UI:**
  - The **Training** tab shows the latest value of each metric and live SVG charts grouped by
    family (loss and error, scores, learning rate), each with a hover readout.
  - Cards show a progress bar while running, a headline metric (validation loss first) and a
    model chip.
  - The Data tab shows layer tables, tensor stats, loader details and feature importances.
- **Look:** black theme on a graph-paper grid, with fine lines every 20px and heavier every 100px.
  The grid scales with zoom on canvases and is fixed on page backgrounds. Emoji and pictographic
  glyphs were replaced by one inline SVG icon set (`components/Icon.tsx`).

## Verification
`tests/test_lab_ml.py` runs the three `examples/ml-lab` files in real kernels:
- **Data processing:** tracks row counts through cleaning and the engineered columns.
- **sklearn:** five fold scores, test metrics, feature importances and an inline plot.
- **PyTorch:** summaries for tensors, the model, loaders, dataset and optimizer; six epochs of
  metrics with decreasing loss; and progress events from the text bar.

It also covers the parser formats and `flowlab_log`.

## Not yet
- GPU memory and utilisation (no GPU on the development machine; device strings are reported).
- Stopping training early from a metric threshold.
- Checkpoint tracking, and comparing metric curves across runs.
