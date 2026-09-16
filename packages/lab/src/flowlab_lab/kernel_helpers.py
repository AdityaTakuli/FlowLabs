"""Code injected once into the user's kernel to produce summaries (PRD II 8.1, 8.4).

Everything lives under a single underscore-prefixed name so it never shows up as a user
variable. Summaries are metadata plus an optional small sample; objects are never pickled.
"""

from __future__ import annotations

HELPER_NAME = "_flowlab"

HELPER_CODE = r"""
def _flowlab_setup():
    import hashlib
    import importlib.metadata
    import json
    import math
    import os
    import platform
    import sys

    # tqdm.auto picks Jupyter widgets inside a kernel; the canvas cannot draw widgets, so FlowLab
    # kernels get the text bar, whose carriage-return updates become node progress.
    import importlib.abc
    import importlib.util

    class TextTqdmLoader(importlib.abc.Loader):
        def create_module(self, spec):
            return None

        def exec_module(self, module):
            import tqdm.std

            module.tqdm = tqdm.std.tqdm
            module.trange = tqdm.std.trange
            module.__all__ = ["tqdm", "trange"]

    class TextTqdmFinder(importlib.abc.MetaPathFinder):
        def find_spec(self, name, path, target=None):
            if name in ("tqdm.auto", "tqdm.autonotebook", "tqdm.notebook"):
                return importlib.util.spec_from_loader(name, TextTqdmLoader())
            return None

    if not any(type(f).__name__ == "TextTqdmFinder" for f in sys.meta_path):
        sys.meta_path.insert(0, TextTqdmFinder())

    def number(value):
        try:
            result = float(value)
        except Exception:
            return None
        return result if math.isfinite(result) else None

    def digest(raw):
        return hashlib.sha256(raw).hexdigest()[:16]

    def preview_json(obj, limit=4000):
        try:
            text = json.dumps(obj, indent=1, default=str, ensure_ascii=False)
        except Exception:
            text = repr(obj)
        return text[:limit], len(text) > limit

    def safe(getter, default=None):
        try:
            return getter()
        except Exception:
            return default

    def describe(item, depth=0):
        # short shape description of one dataset item, e.g. (Tensor[8] float32, Tensor[] int64)
        torch = sys.modules.get("torch")
        np = sys.modules.get("numpy")
        if depth < 2 and isinstance(item, (tuple, list)):
            return "(" + ", ".join(describe(i, depth + 1) for i in list(item)[:6]) + ")"
        if depth < 2 and isinstance(item, dict):
            return "{" + ", ".join(f"{k}: {describe(v, depth + 1)}" for k, v in list(item.items())[:6]) + "}"
        if torch is not None and isinstance(item, torch.Tensor):
            return f"Tensor{list(item.shape)} {str(item.dtype).replace('torch.', '')}"
        if np is not None and isinstance(item, np.ndarray):
            return f"ndarray{list(item.shape)} {item.dtype}"
        return type(item).__name__

    def tensor_sample(values, rows):
        head = values[:rows]
        if head.ndim > 1:
            head = head.reshape(head.shape[0], -1)[:, :20]
        return head.tolist()

    def looks_like_response(obj):
        # requests.Response, httpx.Response and look-alikes; properties may raise, hence safe()
        return safe(lambda: not isinstance(obj, type) and hasattr(obj, "status_code")
                    and hasattr(obj, "headers") and (hasattr(obj, "text") or hasattr(obj, "content")), False)

    def summary(name, obj, sample_rows):
        info = {"name": name, "type": f"{type(obj).__module__}.{type(obj).__qualname__}"}
        pd = sys.modules.get("pandas")
        np = sys.modules.get("numpy")
        pl = sys.modules.get("polars")
        torch = sys.modules.get("torch")
        data = getattr(getattr(torch, "utils", None), "data", None) if torch is not None else None
        optim = getattr(torch, "optim", None) if torch is not None else None
        try:
            if pd is not None and isinstance(obj, pd.DataFrame):
                numeric = obj.select_dtypes(include="number")
                info.update(
                    kind="dataframe",
                    rows=int(obj.shape[0]),
                    columns=[str(c) for c in obj.columns],
                    dtypes={str(c): str(t) for c, t in obj.dtypes.items()},
                    null_counts={str(c): int(v) for c, v in obj.isna().sum().items()},
                    memory_bytes=int(obj.memory_usage(deep=True).sum()),
                    stats={
                        str(c): {"min": number(numeric[c].min()), "max": number(numeric[c].max()),
                                 "mean": number(numeric[c].mean())}
                        for c in list(numeric.columns)[:50]
                    },
                )
                try:
                    info["hash"] = digest(pd.util.hash_pandas_object(obj, index=True).values.tobytes())
                except Exception:
                    info["hash"] = None
                if sample_rows:
                    info["sample"] = json.loads(
                        obj.head(sample_rows).to_json(orient="split", date_format="iso", default_handler=str)
                    )
            elif pd is not None and isinstance(obj, pd.Series):
                info.update(kind="series", rows=int(obj.shape[0]), dtype=str(obj.dtype),
                            null_count=int(obj.isna().sum()), memory_bytes=int(obj.memory_usage(deep=True)))
                try:
                    info["hash"] = digest(pd.util.hash_pandas_object(obj, index=True).values.tobytes())
                except Exception:
                    info["hash"] = None
                if sample_rows:
                    info["sample"] = json.loads(obj.head(sample_rows).to_json(orient="split", default_handler=str))
            elif np is not None and isinstance(obj, np.ndarray):
                info.update(kind="ndarray", shape=list(obj.shape), dtype=str(obj.dtype), memory_bytes=int(obj.nbytes))
                if obj.ndim:
                    info["rows"] = int(obj.shape[0])
                if obj.dtype.kind == "f":
                    info["null_count"] = int(np.isnan(obj).sum())
                if obj.nbytes <= 50_000_000:
                    info["hash"] = digest(np.ascontiguousarray(obj).tobytes())
                if sample_rows and obj.ndim:
                    info["sample"] = obj[:sample_rows].tolist()
            elif pl is not None and isinstance(obj, pl.DataFrame):
                info.update(kind="dataframe", rows=obj.height, columns=list(obj.columns),
                            dtypes={c: str(t) for c, t in obj.schema.items()},
                            null_counts={c: int(v) for c, v in zip(obj.columns, obj.null_count().row(0))},
                            memory_bytes=int(obj.estimated_size()))
                info["hash"] = digest(obj.hash_rows(seed=0).to_numpy().tobytes())
                if sample_rows:
                    info["sample"] = {"columns": list(obj.columns), "data": obj.head(sample_rows).rows()}
            elif torch is not None and isinstance(obj, torch.Tensor):
                numel = int(obj.numel())
                info.update(kind="tensor", shape=list(obj.shape), dtype=str(obj.dtype).replace("torch.", ""),
                            device=str(obj.device), requires_grad=bool(obj.requires_grad), numel=numel,
                            memory_bytes=int(obj.element_size() * numel))
                if obj.ndim:
                    info["rows"] = int(obj.shape[0])
                if 0 < numel <= 20_000_000 and obj.dtype != torch.bool and not obj.is_complex():
                    flat = obj.detach().float()
                    info["stats"] = {"value": {"min": number(flat.min()), "max": number(flat.max()),
                                               "mean": number(flat.mean())}}
                    if obj.is_floating_point():
                        info["null_count"] = int(torch.isnan(flat).sum())
                if sample_rows and obj.ndim and numel <= 20_000_000:
                    info["sample"] = tensor_sample(obj.detach().cpu(), min(sample_rows, 10))
            elif torch is not None and isinstance(obj, torch.nn.Module):
                params = list(obj.parameters())
                layers = []
                for layer_name, layer in list(obj.named_children())[:40]:
                    layers.append({"name": layer_name, "type": type(layer).__name__,
                                   "params": int(sum(p.numel() for p in layer.parameters()))})
                info.update(kind="model", framework="torch",
                            params_total=int(sum(p.numel() for p in params)),
                            params_trainable=int(sum(p.numel() for p in params if p.requires_grad)),
                            layers=layers, device=str(params[0].device) if params else "cpu",
                            training=bool(obj.training),
                            memory_bytes=int(sum(p.numel() * p.element_size() for p in params)),
                            repr=repr(obj)[:4000])
            elif data is not None and isinstance(obj, data.DataLoader):
                dataset = obj.dataset
                info.update(kind="dataloader", batch_size=obj.batch_size, batches=safe(lambda: len(obj)),
                            dataset_length=safe(lambda: len(dataset)), dataset_type=type(dataset).__name__,
                            num_workers=int(obj.num_workers), drop_last=bool(obj.drop_last),
                            shuffle=type(obj.sampler).__name__ == "RandomSampler",
                            item=safe(lambda: describe(dataset[0])))
                if isinstance(info.get("dataset_length"), int):
                    info["rows"] = info["dataset_length"]
            elif data is not None and isinstance(obj, data.Dataset):
                info.update(kind="dataset", length=safe(lambda: len(obj)), item=safe(lambda: describe(obj[0])))
                if isinstance(info.get("length"), int):
                    info["rows"] = info["length"]
            elif optim is not None and isinstance(obj, optim.Optimizer):
                group = obj.param_groups[0] if obj.param_groups else {}
                info.update(kind="optimizer", lr=number(group.get("lr")), groups=len(obj.param_groups),
                            params={k: repr(v)[:60] for k, v in group.items() if k != "params"})
            elif hasattr(obj, "count_params") and hasattr(obj, "layers") and hasattr(obj, "fit"):
                layers = [{"name": getattr(l, "name", ""), "type": type(l).__name__,
                           "params": safe(lambda l=l: int(l.count_params()), 0)} for l in list(obj.layers)[:40]]
                info.update(kind="model", framework="keras", params_total=safe(lambda: int(obj.count_params())),
                            layers=layers, repr=str(safe(lambda: obj.name, "")))
            elif hasattr(obj, "get_params") and hasattr(obj, "fit"):
                fitted = any(k.endswith("_") and not k.startswith("_") for k in vars(obj))
                params = list(obj.get_params(deep=False).items())[:30]
                info.update(kind="estimator", fitted=fitted, params={k: repr(v)[:80] for k, v in params})
                if fitted:
                    n_features = safe(lambda: int(obj.n_features_in_))
                    if n_features is not None:
                        info["n_features"] = n_features
                    classes = safe(lambda: [str(c) for c in list(obj.classes_)[:20]])
                    if classes:
                        info["classes"] = classes
                    importances = safe(lambda: [float(v) for v in obj.feature_importances_])
                    if importances:
                        names = safe(lambda: [str(n) for n in obj.feature_names_in_]) or [
                            f"x{i}" for i in range(len(importances))]
                        ranked = sorted(zip(names, importances), key=lambda pair: -pair[1])[:20]
                        info["importances"] = [[n, number(v)] for n, v in ranked]
            elif looks_like_response(obj):
                headers = safe(lambda: dict(obj.headers.items()), {}) or {}
                content_type = str(next((v for k, v in headers.items() if str(k).lower() == "content-type"), ""))
                elapsed = safe(lambda: obj.elapsed.total_seconds())
                info.update(
                    kind="response",
                    status=safe(lambda: int(obj.status_code)),
                    reason=str(safe(lambda: obj.reason) or safe(lambda: obj.reason_phrase) or ""),
                    url=str(safe(lambda: obj.url, ""))[:500],
                    method=str(safe(lambda: obj.request.method, "") or ""),
                    content_type=content_type[:120],
                    elapsed_ms=round(elapsed * 1000) if isinstance(elapsed, (int, float)) else None,
                    headers={str(k): str(v)[:200] for k, v in list(headers.items())[:40]},
                    size_bytes=safe(lambda: len(obj.content)),
                )
                if sample_rows:
                    parsed = safe(lambda: obj.json()) if "json" in content_type.lower() else None
                    if parsed is not None:
                        info["body"], info["body_truncated"] = preview_json(parsed)
                        info["body_format"] = "json"
                    else:
                        text = safe(lambda: obj.text)
                        if isinstance(text, str):
                            info["body"], info["body_truncated"] = text[:4000], len(text) > 4000
                            info["body_format"] = "text"
            elif obj is None or isinstance(obj, (bool, int, float, complex, str)):
                info.update(kind="scalar", repr=repr(obj)[:120])
                if sample_rows and isinstance(obj, str) and len(obj) > 120:
                    info["preview"], info["preview_truncated"] = obj[:4000], len(obj) > 4000
            elif isinstance(obj, (list, tuple, set, frozenset, dict)):
                info.update(kind="collection", length=len(obj), container=type(obj).__name__)
                if isinstance(obj, dict):
                    info["keys"] = [str(k) for k in list(obj.keys())[:30]]
                if sample_rows:
                    if isinstance(obj, dict):
                        head = dict(list(obj.items())[:50])
                    elif isinstance(obj, (set, frozenset)):
                        head = sorted((repr(v) for v in obj))[:50]
                    else:
                        head = list(obj[:50])
                    text, cut = preview_json(head)
                    info["preview"], info["preview_truncated"] = text, cut or len(obj) > 50
            elif callable(obj):
                info.update(kind="callable")
            else:
                info.update(kind="object", repr=repr(obj)[:120])
        except Exception as exc:
            info["error"] = f"{type(exc).__name__}: {exc}"[:200]
        return info

    def summarize(names, sample_rows=0):
        namespace = get_ipython().user_ns
        return json.dumps(
            {n: summary(n, namespace[n], sample_rows) for n in names if n in namespace}, default=str
        )

    def variables():
        shell = get_ipython()
        hidden = set(shell.user_ns_hidden)
        found = {}
        for key, value in shell.user_ns.items():
            if key.startswith("_") or key in hidden or key in ("In", "Out", "exit", "quit", "get_ipython"):
                continue
            if type(value).__name__ == "module":
                continue
            found[key] = f"{type(value).__module__}.{type(value).__qualname__}"
        return json.dumps(found)

    def local_modules(root):
        root = os.path.realpath(root)
        found = {}
        for name, module in list(sys.modules.items()):
            path = getattr(module, "__file__", None)
            if path and os.path.realpath(path).startswith(root + os.sep):
                found[name] = os.path.realpath(path)
        return json.dumps(found)

    def environment():
        packages = {}
        for dist in importlib.metadata.distributions():
            name = dist.metadata.get("Name")
            if name:
                packages[name] = dist.version
        return json.dumps({
            "python": platform.python_version(),
            "implementation": platform.python_implementation(),
            "executable": sys.executable,
            "cwd": os.getcwd(),
            "pid": os.getpid(),
            "packages": packages,
        })

    def delete(names):
        namespace = get_ipython().user_ns
        removed = [n for n in names if n in namespace]
        for n in removed:
            del namespace[n]
        return json.dumps(removed)

    def log(**values):
        # flowlab_log(step=3, loss=0.41): chart training metrics live in FlowLab
        from IPython.display import display

        clean = {str(k): number(v) for k, v in values.items()}
        display({"application/vnd.flowlab.metric+json": {k: v for k, v in clean.items() if v is not None},
                 "text/plain": ""}, raw=True)

    def evaluate(expression):
        return repr(eval(expression, get_ipython().user_ns))[:2000]

    return {
        "summarize": summarize, "variables": variables, "local_modules": local_modules,
        "environment": environment, "delete": delete, "evaluate": evaluate, "log": log,
    }


_flowlab = _flowlab_setup()
del _flowlab_setup
flowlab_log = _flowlab["log"]
get_ipython().user_ns_hidden["flowlab_log"] = flowlab_log
"""
