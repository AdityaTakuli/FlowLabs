# Engines and GPUs

The **engine** is where your data is processed and models train, like a Jupyter kernel. The chip
on the right of the top bar shows the current engine and whether it has a GPU. Click it to change
engines.

## Three ways to run FlowLabs

| | Engine | Good for |
| --- | --- | --- |
| **Desktop app** | This computer, with Python built in | Everything, offline: large data, SQL connections, GPUs, image models. |
| **Browser** | Python inside the browser tab ([Pyodide](https://pyodide.org)) | Trying FlowLabs, teaching, small to medium tables. Nothing to install, and data never leaves the device. |
| **Browser + engine** | `flowlabs engine` on any computer | Using a powerful computer or a GPU server from a browser. |

Each engine keeps its own datasets, projects and models: the desktop app in `~/FlowLabs`, and the
browser in its storage.

## Use your GPU

The desktop app's built-in Python trains classic models on the CPU. For neural networks on a GPU
(NVIDIA CUDA, or Apple Metal on M-series Macs), and for image models, point the engine at a Python
that has PyTorch. See below. The engine chip shows **GPU** when one is found, and the Results page
says where each network trained.

FlowLabs falls back to the CPU when the GPU fails mid-training, for example on Apple's Metal
backend, rather than failing.

## Python environments

Open the engine menu, then **Python environments on this computer**. FlowLabs lists:

- its built-in Python;
- virtualenvs (`.venv`, `venv`, `env`) in your workspace;
- conda environments;
- the Python on your PATH.

For each one it shows which packages it has: pandas, scikit-learn, PyTorch, torchvision, XGBoost,
LightGBM and DuckDB.

Choose one, and the engine restarts in it. A Python that lacks something FlowLabs needs offers to
**install** it (with pip), for example PyTorch for GPUs, or XGBoost and LightGBM for those models.

> If the chosen Python later loses numpy or pandas, FlowLabs starts its built-in engine instead and
> tells you, rather than failing to start. The "engine did not start" screen also offers **Use the
> built-in engine**.

## Connect the browser to an engine

On the computer to use, with Python 3.11 or newer:

```bash
pip install "flowlabs[deep,sql]"     # scikit-learn, PyTorch, SQL drivers
flowlabs engine                      # prints a link
```

Open the link it prints. It opens FlowLabs connected to that computer. From the hosted web app, you
can also paste the link into the engine menu, under **Connect to an engine**.

For another machine on your network, such as a GPU server:

```bash
flowlabs engine --host 0.0.0.0 --port 8899
```

Then open the address it prints from your computer. Every request needs the engine's **token**,
which is in the link. Treat it like a password: anyone with it can run code on that machine.

Options:

- `--workspace DIR` keeps that engine's data somewhere else;
- `--python PATH` runs the kernel in another Python;
- `--token` fixes the token instead of making a new one each time.

## The desktop app from a terminal

```bash
flowlabs app                         # the window (installed with pip)
flowlabs app --browser               # in your browser instead
flowlabs app --workspace ~/work/ml   # another folder for datasets and projects
```
