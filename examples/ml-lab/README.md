# ML lab examples

Open this folder with `flowlab serve --root examples/ml-lab` and run the files in order:

1. `01_data_processing.py`: generate, clean and engineer features for a churn dataset (`# %%` cells).
2. `02_sklearn_training.py`: cross-validated baseline, gradient boosting, test metrics and plots.
3. `03_torch_training.ipynb`: PyTorch dataset, data loaders, a small network and a training loop.
   FlowLab charts the printed `loss`/`val_acc` per epoch live and shows the tqdm progress.

`data/` is created by the first file.
