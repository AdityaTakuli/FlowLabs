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

    def looks_like_response(obj):
        # requests.Response, httpx.Response and look-alikes; properties may raise, hence safe()
        return safe(lambda: not isinstance(obj, type) and hasattr(obj, "status_code")
                    and hasattr(obj, "headers") and (hasattr(obj, "text") or hasattr(obj, "content")), False)

    def summary(name, obj, sample_rows):
        info = {"name": name, "type": f"{type(obj).__module__}.{type(obj).__qualname__}"}
        pd = sys.modules.get("pandas")
        np = sys.modules.get("numpy")
        pl = sys.modules.get("polars")
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
            elif hasattr(obj, "get_params") and hasattr(obj, "fit"):
                fitted = any(k.endswith("_") and not k.startswith("_") for k in vars(obj))
                params = list(obj.get_params(deep=False).items())[:30]
                info.update(kind="estimator", fitted=fitted, params={k: repr(v)[:80] for k, v in params})
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

    def evaluate(expression):
        return repr(eval(expression, get_ipython().user_ns))[:2000]

    return {
        "summarize": summarize, "variables": variables, "local_modules": local_modules,
        "environment": environment, "delete": delete, "evaluate": evaluate,
    }


_flowlab = _flowlab_setup()
del _flowlab_setup
"""
