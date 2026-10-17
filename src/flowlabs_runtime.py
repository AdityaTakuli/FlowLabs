"""FlowLabs runtime: everything a model exported from FlowLabs needs to make predictions.

This one file depends only on numpy, pandas, scipy and scikit-learn. Every export copies it next to
``model.joblib``, so this works on any machine without installing FlowLabs::

    import joblib, pandas as pd
    model = joblib.load("model.joblib")
    model.predict(pd.read_csv("new_rows.csv"))

What lives here:

* ``CleanOps``: the column steps from the Clean stage (drop, retype, extract date parts, combine,
  tidy text). Row steps such as removing duplicates only ever run on training data.
* ``ColumnStep``: runs any scikit-learn transformer on a selection of columns and keeps a DataFrame
  with readable column names, so steps can be chained in any order.
* Small transformers scikit-learn lacks: frequency encoding, outlier clipping, signed log, dropping
  correlated columns, text vectorizing.
* ``AutoPrep``: the final step that makes any table model-ready (numbers only, no gaps).
* ``NeuralNetClassifier`` / ``NeuralNetRegressor``: tabular networks built from a layer list. They
  train with PyTorch when it is installed (CPU, CUDA or Apple MPS) and with NumPy otherwise, and
  always predict with NumPy, so an exported network needs no PyTorch.
* ``FlowLabsModel``: the exported object; takes raw rows, returns labels, probabilities or values.
"""

from __future__ import annotations

import math
import re
import warnings
from collections.abc import Callable, Iterable, Sequence
from typing import Any

import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator, ClassifierMixin, RegressorMixin, TransformerMixin, clone

RUNTIME_VERSION = 1

# --------------------------------------------------------------------------------------- columns

TOKENS = ("@all", "@numeric", "@categorical", "@datetime", "@boolean", "@text")
_DATE_NAME = re.compile(r"(date|time|_at$|_on$|timestamp|day$)", re.IGNORECASE)


def _frame(X: Any) -> pd.DataFrame:
    if isinstance(X, pd.DataFrame):
        return X
    array = np.asarray(X)
    if array.ndim == 1:
        array = array.reshape(-1, 1)
    return pd.DataFrame(array, columns=[f"x{i}" for i in range(array.shape[1])])


def is_bool_series(series: pd.Series) -> bool:
    if pd.api.types.is_bool_dtype(series):
        return True
    if series.dtype == object:
        values = series.dropna()
        return len(values) > 0 and all(isinstance(v, bool | np.bool_) for v in values.iloc[:200])
    return False


def is_numeric_series(series: pd.Series) -> bool:
    return pd.api.types.is_numeric_dtype(series) and not pd.api.types.is_bool_dtype(series)


def looks_like_datetime(series: pd.Series) -> bool:
    """True for datetime columns and for text columns whose values parse as dates."""
    if pd.api.types.is_datetime64_any_dtype(series):
        return True
    if is_numeric_series(series) or is_bool_series(series):
        return False
    sample = series.dropna().astype(str).head(60)
    if len(sample) < 3:
        return False
    if not _DATE_NAME.search(str(series.name or "")) and not sample.str.match(r"^\d{1,4}[-/.]\d{1,2}").mean() > 0.8:
        return False
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        parsed = pd.to_datetime(sample, errors="coerce", format="mixed")
    return bool(parsed.notna().mean() >= 0.9)


def column_kind(series: pd.Series) -> str:
    """numeric, boolean, datetime, categorical or text."""
    if is_bool_series(series):
        return "boolean"
    if is_numeric_series(series):
        return "numeric"
    if looks_like_datetime(series):
        return "datetime"
    values = series.dropna()
    if len(values):
        text = values.astype(str).head(300)
        if text.str.len().mean() > 30 and text.str.contains(" ").mean() > 0.5:
            return "text"
    return "categorical"


def select_columns(frame: pd.DataFrame, spec: str | Sequence[str] | None) -> list[str]:
    """Resolve a column selection: names and/or tokens such as ``@numeric``."""
    if spec is None:
        return []
    items = [spec] if isinstance(spec, str) else list(spec)
    chosen: list[str] = []
    for item in items:
        if item in TOKENS:
            kind = item[1:]
            for name in frame.columns:
                if kind == "all" or column_kind(frame[name]) == kind:
                    chosen.append(str(name))
        elif item in frame.columns:
            chosen.append(item)
    return list(dict.fromkeys(chosen))


def _to_frame(out: Any, transformer: Any, columns: list[str], index: pd.Index, prefix: str) -> pd.DataFrame:
    if hasattr(out, "toarray"):
        out = out.toarray()
    if isinstance(out, pd.DataFrame):
        result = out.copy()
        result.index = index
        result.columns = [str(c) for c in result.columns]
        return result
    array = np.asarray(out)
    if array.ndim == 1:
        array = array.reshape(-1, 1)
    names: list[str] | None = None
    if hasattr(transformer, "get_feature_names_out"):
        try:
            names = [str(n) for n in transformer.get_feature_names_out(columns)]
        except Exception:  # noqa: BLE001 - some transformers cannot name their outputs
            names = None
    if names is None or len(names) != array.shape[1]:
        names = columns if array.shape[1] == len(columns) else [f"{prefix}_{i}" for i in range(array.shape[1])]
    return pd.DataFrame(array, columns=names, index=index)


# --------------------------------------------------------------------------------- your own code

CODE_FILE = "<your code>"
_CODE_CACHE: dict[str, dict[str, Any]] = {}


class CodeError(ValueError):
    """A code step failed. The message says which line and why."""


def code_line(error: BaseException) -> int | None:
    """The line of a code step where ``error`` was raised, if it came from one."""
    line = None
    trace = error.__traceback__
    while trace is not None:
        if trace.tb_frame.f_code.co_filename == CODE_FILE:
            line = trace.tb_lineno
        trace = trace.tb_next
    return line


def _code_error(error: BaseException) -> CodeError:
    line = code_line(error)
    where = f"line {line}: " if line else ""
    return CodeError(f"{where}{type(error).__name__}: {error}")


def run_code(code: str) -> dict[str, Any]:
    """Run a code step's source once and return what it defines. pandas (pd), NumPy (np) and math are ready."""
    found = _CODE_CACHE.get(code)
    if found is not None:
        return found
    namespace: dict[str, Any] = {"__name__": "flowlabs_code", "pd": pd, "np": np, "math": math}
    try:
        exec(compile(code or "", CODE_FILE, "exec"), namespace)  # noqa: S102 - the user's own code, by design
    except SyntaxError as error:
        raise CodeError(f"line {error.lineno}: {error.msg}") from None
    except Exception as error:  # noqa: BLE001 - reported with its line number
        raise _code_error(error) from error
    if len(_CODE_CACHE) > 64:
        _CODE_CACHE.clear()
    _CODE_CACHE[code] = namespace
    return namespace


def check_code(code: str, needs: Sequence[str]) -> str | None:
    """None when the code runs and defines one of ``needs``; otherwise what is wrong."""
    try:
        namespace = run_code(code)
    except CodeError as error:
        return str(error)
    if not any(namespace.get(name) is not None for name in needs):
        names = " or ".join(f"{n}(...)" if n in ("clean", "rows", "transform") else f"{n} = ..." for n in needs)
        return f"define {names}"
    return None


def call_code(code: str, function: str, *args: Any, **extra: Any) -> Any:
    """Call ``function`` from a code step, with ``extra`` names available to it."""
    namespace = run_code(code)
    target = namespace.get(function)
    if not callable(target):
        raise CodeError(f"define a function called {function}(...)")
    namespace.update(extra)
    try:
        return target(*args)
    except CodeError:
        raise
    except Exception as error:  # noqa: BLE001 - reported with its line number
        raise _code_error(error) from error


class CodeTransformer(TransformerMixin, BaseEstimator):
    """A transform written in Python. The code either sets ``transformer = <a scikit-learn transformer>``
    or defines ``fit(X, y)`` (learns from training rows, returns a state) and ``transform(X, state)``."""

    def __init__(self, code: str = "") -> None:
        self.code = code

    def fit(self, X: Any, y: Any = None) -> CodeTransformer:
        frame = _frame(X)
        namespace = run_code(self.code)
        self.transformer_, self.state_ = None, None
        if callable(namespace.get("transform")):
            if callable(namespace.get("fit")):
                self.state_ = call_code(self.code, "fit", frame.copy(), y)
        elif namespace.get("transformer") is not None:
            transformer = clone(namespace["transformer"])
            if hasattr(transformer, "set_output"):
                try:
                    transformer.set_output(transform="pandas")
                except Exception:  # noqa: BLE001 - sparse outputs; converted below
                    pass
            transformer.fit(frame, y)
            self.transformer_ = transformer
        else:
            raise CodeError("define transform(X, state), or set transformer = ...")
        return self

    def transform(self, X: Any) -> pd.DataFrame:
        frame = _frame(X)
        if self.transformer_ is not None:
            out = self.transformer_.transform(frame)
            return _to_frame(out, self.transformer_, [str(c) for c in frame.columns], frame.index, "code")
        out = call_code(self.code, "transform", frame.copy(), self.state_)
        if out is None:
            raise CodeError("transform(X, state) must return the new table")
        if len(out) != len(frame):
            raise CodeError("transform(X, state) must keep every row; remove rows in a Training-set code step")
        return _to_frame(out, None, [str(c) for c in frame.columns], frame.index, "code")


def code_model(code: str) -> Any:
    """The ``model`` a model code step defines, as a fresh unfitted copy."""
    namespace = run_code(code)
    model = namespace.get("model")
    if model is None:
        raise CodeError("set model = ... (any model with fit and predict)")
    if not (hasattr(model, "fit") and hasattr(model, "predict")):
        raise CodeError(f"model is a {type(model).__name__}, which has no fit and predict")
    try:
        return clone(model)
    except Exception:  # noqa: BLE001 - not a scikit-learn estimator; a deep copy works the same
        import copy

        return copy.deepcopy(model)


# ------------------------------------------------------------------------------------ clean ops

TRUTHY = {"true", "yes", "y", "1", "t", "on"}
FALSY = {"false", "no", "n", "0", "f", "off"}
ROW_OPS = {"drop_duplicates", "drop_missing_rows", "filter_rows", "sample_rows"}
DATE_PARTS = ("year", "month", "day", "weekday", "hour", "dayofyear", "quarter", "is_weekend")


def _to_bool(series: pd.Series) -> pd.Series:
    def convert(value: Any) -> Any:
        if value is None or (isinstance(value, float) and math.isnan(value)):
            return np.nan
        if isinstance(value, bool | np.bool_):
            return bool(value)
        text = str(value).strip().lower()
        if text in TRUTHY:
            return True
        if text in FALSY:
            return False
        return np.nan

    return series.map(convert)


def date_parts(series: pd.Series, parts: Iterable[str], name: str) -> pd.DataFrame:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        values = pd.to_datetime(series, errors="coerce", format="mixed")
    out: dict[str, Any] = {}
    for part in parts:
        if part == "weekday":
            out[f"{name}_weekday"] = values.dt.dayofweek
        elif part == "is_weekend":
            out[f"{name}_is_weekend"] = (values.dt.dayofweek >= 5).astype(float).where(values.notna())
        elif part in DATE_PARTS:
            out[f"{name}_{part}"] = getattr(values.dt, part)
    return pd.DataFrame(out, index=series.index).astype(float)


def apply_clean_op(frame: pd.DataFrame, op: str, params: dict[str, Any], *, rows: bool) -> pd.DataFrame:
    """Apply one Clean step. Row steps run only when ``rows`` is true (training data)."""
    p = params or {}
    if op == "custom_clean":
        if p.get("training_only") and not rows:
            return frame
        out = call_code(p.get("code") or "", "clean", frame.copy())
        if not isinstance(out, pd.DataFrame):
            raise CodeError("clean(df) must return a table (a pandas DataFrame)")
        return out
    if op in ROW_OPS:
        if not rows:
            return frame
        if op == "drop_duplicates":
            subset = [c for c in p.get("columns") or [] if c in frame.columns] or None
            return frame.drop_duplicates(subset=subset)
        if op == "drop_missing_rows":
            columns = select_columns(frame, p.get("columns") or ["@all"])
            if not columns:
                return frame
            return frame.dropna(subset=columns, how="all" if p.get("how") == "all" else "any")
        if op == "filter_rows":
            column = p.get("column")
            if column not in frame.columns:
                return frame
            return frame[_condition(frame[column], str(p.get("operator", "==")), p.get("value"))]
        if op == "sample_rows":
            n = int(p.get("rows") or 0)
            if 0 < n < len(frame):
                return frame.sample(n=n, random_state=int(p.get("seed", 0)))
            return frame
    out = frame.copy()
    if op == "drop_columns":
        return out.drop(columns=[c for c in p.get("columns") or [] if c in out.columns])
    if op == "change_type":
        for column in [c for c in p.get("columns") or [] if c in out.columns]:
            to = p.get("to", "numeric")
            if to == "numeric":
                cleaned = out[column]
                if not is_numeric_series(cleaned):
                    cleaned = cleaned.astype(str).str.replace(r"[,$%\s]", "", regex=True)
                out[column] = pd.to_numeric(cleaned, errors="coerce")
            elif to == "boolean":
                out[column] = _to_bool(out[column])
            elif to == "datetime":
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    out[column] = pd.to_datetime(out[column], errors="coerce", format="mixed")
            else:  # category / text
                out[column] = out[column].map(lambda v: v if pd.isna(v) else str(v)).astype(object)
        return out
    if op == "extract_datetime":
        for column in [c for c in p.get("columns") or [] if c in out.columns]:
            parts = date_parts(out[column], p.get("parts") or ["year", "month", "weekday"], column)
            out = pd.concat([out, parts], axis=1)
            if p.get("drop_original", True):
                out = out.drop(columns=[column])
        return out
    if op == "combine_columns":
        a, b = p.get("a"), p.get("b")
        if a not in out.columns or b not in out.columns:
            return out
        left = pd.to_numeric(out[a], errors="coerce")
        right = pd.to_numeric(out[b], errors="coerce")
        operation = p.get("operation", "divide")
        name = p.get("name") or f"{a}_{operation}_{b}"
        if operation == "add":
            out[name] = left + right
        elif operation == "subtract":
            out[name] = left - right
        elif operation == "multiply":
            out[name] = left * right
        else:
            out[name] = (left / right.replace(0, np.nan)).astype(float)
        return out
    if op == "replace_values":
        column = p.get("column")
        if column in out.columns:
            find, replace = p.get("find"), p.get("replace")
            if find is not None:
                as_text = out[column].astype(str)
                mask = as_text == str(find)
                new = np.nan if replace in (None, "") else replace
                out[column] = out[column].astype(object).where(~mask, new)
        return out
    if op == "clean_text":
        for column in select_columns(out, p.get("columns") or ["@categorical"]):
            series = out[column]
            values = series.astype(str)
            if p.get("strip", True):
                values = values.str.strip().str.replace(r"\s+", " ", regex=True)
            case = p.get("case", "lower")
            if case == "lower":
                values = values.str.lower()
            elif case == "upper":
                values = values.str.upper()
            elif case == "title":
                values = values.str.title()
            out[column] = values.where(series.notna(), np.nan).astype(object)
        return out
    return out


def _condition(series: pd.Series, operator: str, value: Any) -> pd.Series:
    if operator in ("is missing", "is not missing"):
        missing = series.isna()
        return missing if operator == "is missing" else ~missing
    if operator in ("contains", "not contains"):
        found = series.astype(str).str.contains(str(value), case=False, regex=False, na=False)
        return found if operator == "contains" else ~found
    numeric = is_numeric_series(series)
    target: Any = value
    if numeric:
        try:
            target = float(value)
        except (TypeError, ValueError):
            numeric = False
    left = series if numeric else series.astype(str)
    if not numeric:
        target = str(value)
    if operator == "==":
        return left == target
    if operator == "!=":
        return left != target
    if not numeric:
        return pd.Series(True, index=series.index)
    return {">": left > target, ">=": left >= target, "<": left < target, "<=": left <= target}.get(
        operator, pd.Series(True, index=series.index)
    )


class CleanOps(TransformerMixin, BaseEstimator):
    """The Clean stage as a transformer. At prediction time only column steps run."""

    def __init__(self, ops: list[dict[str, Any]] | None = None) -> None:
        self.ops = ops

    def fit(self, X: Any, y: Any = None) -> CleanOps:
        return self

    def apply(self, X: pd.DataFrame, *, rows: bool) -> pd.DataFrame:
        frame = _frame(X)
        for step in self.ops or []:
            if step.get("enabled", True):
                frame = apply_clean_op(frame, step["op"], step.get("params") or {}, rows=rows)
        return frame

    def transform(self, X: Any) -> pd.DataFrame:
        return self.apply(_frame(X), rows=False)


# ------------------------------------------------------------------------- training-set steps


def _numeric_view(cleaner: CleanOps, X: pd.DataFrame, columns: Any) -> pd.DataFrame:
    prepared = cleaner.transform(X)
    chosen = [c for c in select_columns(prepared, columns or ["@numeric"]) if is_numeric_series(prepared[c])]
    return prepared[chosen].apply(pd.to_numeric, errors="coerce")


def training_rows(steps: list[dict[str, Any]], X: pd.DataFrame, y: pd.Series, task: str, seed: int,
                  cleaner: CleanOps | None = None) -> tuple[pd.DataFrame, pd.Series, str]:  # fmt: skip
    """Training-set steps (outlier removal, class balancing). They never touch test rows.

    Returns the new X and y and a sentence describing what changed.
    """
    cleaner = cleaner or CleanOps([])
    messages: list[str] = []
    rng = np.random.default_rng(seed)
    for step in steps:
        params = step.get("params") or {}
        if step["op"] == "remove_outliers":
            numbers = _numeric_view(cleaner, X, params.get("columns"))
            if numbers.empty:
                messages.append("No numeric columns to check for outliers.")
                continue
            method, threshold = params.get("method", "iqr"), float(params.get("threshold", 3.0))
            if method == "isolation_forest":
                from sklearn.ensemble import IsolationForest

                filled = numbers.fillna(numbers.median())
                share = float(params.get("contamination", 0.02))
                flags = IsolationForest(contamination=share, random_state=seed).fit_predict(filled) == -1
                outlier = pd.Series(flags, index=numbers.index)
            elif method == "zscore":
                z = (numbers - numbers.mean()) / numbers.std(ddof=0).replace(0, np.nan)
                outlier = (z.abs() > threshold).any(axis=1)
            else:
                q1, q3 = numbers.quantile(0.25), numbers.quantile(0.75)
                iqr = q3 - q1
                outlier = ((numbers < q1 - threshold * iqr) | (numbers > q3 + threshold * iqr)).any(axis=1)
            keep = ~outlier
            if keep.sum() < 2:
                messages.append("Outlier removal would drop almost every row, so it was skipped.")
                continue
            messages.append(f"Removed {int(outlier.sum())} outlier rows of {len(X)} training rows.")
            X, y = X.loc[keep[keep].index], y.loc[keep[keep].index]
        elif step["op"] == "custom_rows":
            out = call_code(params.get("code") or "", "rows", X.copy(), y.copy(), clean=cleaner.transform)
            if not (isinstance(out, tuple) and len(out) == 2):
                raise CodeError("rows(X, y) must return X, y")
            new_X, new_y = _frame(out[0]), out[1]
            new_y = new_y if isinstance(new_y, pd.Series) else pd.Series(np.asarray(new_y), index=new_X.index)
            if len(new_X) != len(new_y) or len(new_X) < 2:
                raise CodeError("rows(X, y) must return as many targets as rows, and at least two rows")
            messages.append(f"Your code: {len(X)} → {len(new_X)} training rows.")
            X, y = new_X, new_y
        elif step["op"] == "balance_classes":
            if task != "classification":
                continue
            counts = y.value_counts()
            method = params.get("method", "oversample")
            X, y = X.reset_index(drop=True), y.reset_index(drop=True)
            if method == "class_weight":
                messages.append("Rare classes count more during training (no rows added).")
                continue
            if method == "smote":
                numbers = cleaner.transform(X)
                if all(is_numeric_series(numbers[c]) for c in numbers.columns) and len(cleaner.ops or []) == 0:
                    X, y = _smote(X, y, rng)
                    messages.append(f"SMOTE added synthetic rows: classes now {dict(y.value_counts().sort_index())}.")
                    continue
                messages.append("SMOTE needs numeric columns and no Clean column steps; repeated rare rows instead.")
                method = "oversample"
            if method == "undersample":
                size = int(counts.min())
                index = np.concatenate([rng.choice(np.flatnonzero(y == c), size, replace=False) for c in counts.index])
            else:
                size = int(counts.max())
                index = np.concatenate([
                    np.concatenate([np.flatnonzero(y == c), rng.choice(np.flatnonzero(y == c), size - n, replace=True)])
                    for c, n in counts.items()
                ])  # fmt: skip
            index = rng.permutation(index)
            X, y = X.iloc[index].reset_index(drop=True), y.iloc[index].reset_index(drop=True)
            verb = "Trimmed" if method == "undersample" else "Balanced"
            messages.append(f"{verb} classes to {size} training rows each.")
    return X, y, " ".join(messages)


def _smote(X: pd.DataFrame, y: pd.Series, rng: np.random.Generator, k: int = 5) -> tuple[pd.DataFrame, pd.Series]:
    from sklearn.neighbors import NearestNeighbors

    numbers = X.apply(pd.to_numeric, errors="coerce")
    filled = numbers.fillna(numbers.median()).to_numpy(float)
    scale = filled.std(axis=0)
    scaled = filled / np.where(scale > 0, scale, 1)
    counts = y.value_counts()
    target = int(counts.max())
    new_rows, new_labels = [], []
    for label, n in counts.items():
        need = target - int(n)
        members = np.flatnonzero(y.to_numpy() == label)
        if need <= 0 or len(members) < 2:
            continue
        neighbours = NearestNeighbors(n_neighbors=min(k + 1, len(members))).fit(scaled[members])
        _, index = neighbours.kneighbors(scaled[members])
        for _ in range(need):
            i = rng.integers(len(members))
            j = index[i][rng.integers(1, index.shape[1])]
            gap = rng.random()
            new_rows.append(filled[members[i]] + gap * (filled[members[j]] - filled[members[i]]))
            new_labels.append(label)
    if not new_rows:
        return X, y
    extra = pd.DataFrame(new_rows, columns=X.columns)
    return pd.concat([X, extra], ignore_index=True), pd.concat([y, pd.Series(new_labels)], ignore_index=True)


# ----------------------------------------------------------------------------- column transforms


class ColumnStep(TransformerMixin, BaseEstimator):
    """Fit ``transformer`` on the selected columns only; other columns pass through untouched."""

    def __init__(self, transformer: Any = None, columns: Any = ("@numeric",), name: str = "step") -> None:
        self.transformer = transformer
        self.columns = columns
        self.name = name

    def fit(self, X: Any, y: Any = None) -> ColumnStep:
        frame = _frame(X)
        self.columns_ = select_columns(frame, self.columns)
        self.numeric_ = {c: bool(is_numeric_series(frame[c])) for c in self.columns_}
        self.transformer_ = None
        if self.columns_ and self.transformer is not None:
            transformer = clone(self.transformer)
            if hasattr(transformer, "set_output"):
                try:
                    transformer.set_output(transform="pandas")
                except Exception:  # noqa: BLE001 - sparse outputs cannot be pandas; handled below
                    pass
            transformer.fit(frame[self.columns_], y)
            self.transformer_ = transformer
        return self

    def transform(self, X: Any) -> pd.DataFrame:
        frame = _frame(X)
        if self.transformer_ is None:
            return frame
        missing = [c for c in self.columns_ if c not in frame.columns]
        for column in missing:  # a column absent at prediction time is treated as all-missing
            empty = np.nan if getattr(self, "numeric_", {}).get(column, True) else None
            frame = frame.assign(
                **{column: pd.Series([empty] * len(frame), index=frame.index, dtype=object if empty is None else float)}
            )
        out = _to_frame(
            self.transformer_.transform(frame[self.columns_]), self.transformer_, self.columns_, frame.index, self.name
        )
        if list(out.columns) == self.columns_:
            result = frame.copy()
            for column in self.columns_:
                result[column] = out[column].to_numpy()
            return result
        rest = frame.drop(columns=self.columns_)
        out.columns = [c if c not in rest.columns else f"{self.name}_{c}" for c in out.columns]
        return pd.concat([rest, out], axis=1)


class FrequencyEncoder(TransformerMixin, BaseEstimator):
    """Replace each category with how often it appears in the training rows (0 for unseen)."""

    def fit(self, X: Any, y: Any = None) -> FrequencyEncoder:
        frame = _frame(X)
        self.maps_ = {c: frame[c].astype(str).value_counts(normalize=True).to_dict() for c in frame.columns}
        return self

    def transform(self, X: Any) -> pd.DataFrame:
        frame = _frame(X)
        return pd.DataFrame(
            {c: frame[c].astype(str).map(self.maps_.get(c, {})).fillna(0.0).astype(float) for c in frame.columns},
            index=frame.index,
        )

    def get_feature_names_out(self, input_features: Any = None) -> np.ndarray:
        return np.asarray(list(self.maps_), dtype=object)


class OutlierClipper(TransformerMixin, BaseEstimator):
    """Cap extreme values at limits learned from training rows (IQR fences or percentiles)."""

    def __init__(self, method: str = "iqr", factor: float = 1.5, lower: float = 1.0, upper: float = 99.0) -> None:
        self.method = method
        self.factor = factor
        self.lower = lower
        self.upper = upper

    def fit(self, X: Any, y: Any = None) -> OutlierClipper:
        frame = _frame(X).apply(pd.to_numeric, errors="coerce")
        if self.method == "percentile":
            low, high = frame.quantile(self.lower / 100), frame.quantile(self.upper / 100)
        else:
            q1, q3 = frame.quantile(0.25), frame.quantile(0.75)
            iqr = q3 - q1
            low, high = q1 - self.factor * iqr, q3 + self.factor * iqr
        self.low_, self.high_ = low.to_dict(), high.to_dict()
        return self

    def transform(self, X: Any) -> pd.DataFrame:
        frame = _frame(X).apply(pd.to_numeric, errors="coerce")
        return frame.clip(lower=pd.Series(self.low_), upper=pd.Series(self.high_), axis=1)

    def get_feature_names_out(self, input_features: Any = None) -> np.ndarray:
        return np.asarray(list(self.low_), dtype=object)


class SignedLog(TransformerMixin, BaseEstimator):
    """sign(x) * log(1 + |x|): tames skewed values and works for negatives and zero."""

    def fit(self, X: Any, y: Any = None) -> SignedLog:
        self.columns_ = [str(c) for c in _frame(X).columns]
        return self

    def transform(self, X: Any) -> pd.DataFrame:
        frame = _frame(X).apply(pd.to_numeric, errors="coerce")
        return np.sign(frame) * np.log1p(frame.abs())

    def get_feature_names_out(self, input_features: Any = None) -> np.ndarray:
        return np.asarray(self.columns_, dtype=object)


class DropCorrelated(TransformerMixin, BaseEstimator):
    """Drop one of every pair of columns whose correlation in the training rows exceeds ``threshold``."""

    def __init__(self, threshold: float = 0.95) -> None:
        self.threshold = threshold

    def fit(self, X: Any, y: Any = None) -> DropCorrelated:
        frame = _frame(X).apply(pd.to_numeric, errors="coerce")
        corr = frame.corr().abs()
        dropped: set[str] = set()
        columns = list(corr.columns)
        for i, a in enumerate(columns):
            if a in dropped:
                continue
            for b in columns[i + 1 :]:
                if b not in dropped and corr.loc[a, b] > self.threshold:
                    dropped.add(b)
        self.keep_ = [str(c) for c in frame.columns if c not in dropped]
        self.dropped_ = sorted(str(c) for c in dropped)
        return self

    def transform(self, X: Any) -> pd.DataFrame:
        return _frame(X)[self.keep_]

    def get_feature_names_out(self, input_features: Any = None) -> np.ndarray:
        return np.asarray(self.keep_, dtype=object)


class TextVectorizer(TransformerMixin, BaseEstimator):
    """TF-IDF of one or more text columns (joined with spaces)."""

    def __init__(self, max_features: int = 300, ngram_max: int = 1, min_df: int = 2) -> None:
        self.max_features = max_features
        self.ngram_max = ngram_max
        self.min_df = min_df

    def _text(self, X: Any) -> pd.Series:
        frame = _frame(X).astype(object).where(_frame(X).notna(), "")
        return frame.astype(str).agg(" ".join, axis=1)

    def fit(self, X: Any, y: Any = None) -> TextVectorizer:
        from sklearn.feature_extraction.text import TfidfVectorizer

        text = self._text(X)
        self.vectorizer_ = TfidfVectorizer(
            max_features=self.max_features, ngram_range=(1, self.ngram_max), min_df=min(self.min_df, len(text))
        )
        self.vectorizer_.fit(text)
        return self

    def transform(self, X: Any) -> np.ndarray:
        return np.asarray(self.vectorizer_.transform(self._text(X)).toarray())

    def get_feature_names_out(self, input_features: Any = None) -> np.ndarray:
        return np.asarray([f"word_{w}" for w in self.vectorizer_.get_feature_names_out()], dtype=object)


class ToArray(TransformerMixin, BaseEstimator):
    """Hand plain float arrays to models that dislike DataFrame column names (XGBoost, LightGBM)."""

    def fit(self, X: Any, y: Any = None) -> ToArray:
        self.columns_ = [str(c) for c in _frame(X).columns]
        return self

    def transform(self, X: Any) -> np.ndarray:
        return np.asarray(_frame(X), dtype=np.float32)

    def get_feature_names_out(self, input_features: Any = None) -> np.ndarray:
        return np.asarray(self.columns_, dtype=object)


# ------------------------------------------------------------------------------------- auto prep


class AutoPrep(TransformerMixin, BaseEstimator):
    """Make any table model-ready: numbers only and no gaps, learned from the training rows.

    * numbers: missing values become the training median;
    * yes/no columns: 1 / 0;
    * dates: year, month, weekday (and hour when present);
    * categories with at most ``max_onehot`` values: one column per value;
    * categories with more values: how often each value appears;
    * text that is unique on almost every row (an ID): dropped.
    """

    def __init__(self, max_onehot: int = 20, drop_id_like: bool = True) -> None:
        self.max_onehot = max_onehot
        self.drop_id_like = drop_id_like

    def fit(self, X: Any, y: Any = None) -> AutoPrep:
        frame = _frame(X)
        self.plan_: list[tuple[str, str, Any]] = []
        self.report_: list[dict[str, str]] = []
        for name in frame.columns:
            column = str(name)
            series = frame[name]
            kind = column_kind(series)
            if kind == "numeric":
                values = pd.to_numeric(series, errors="coerce").replace([np.inf, -np.inf], np.nan)
                median = float(values.median()) if values.notna().any() else 0.0
                self.plan_.append((column, "number", median))
                if values.isna().any():
                    self.report_.append(
                        {"column": column, "action": "fill", "detail": f"missing → median {median:.4g}"}
                    )
            elif kind == "boolean":
                self.plan_.append((column, "bool", None))
                self.report_.append({"column": column, "action": "bool", "detail": "yes/no → 1/0"})
            elif kind == "datetime":
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    parsed = pd.to_datetime(series, errors="coerce", format="mixed")
                parts = ["year", "month", "weekday"]
                if parsed.dt.hour.fillna(0).ne(0).any():
                    parts.append("hour")
                self.plan_.append((column, "date", parts))
                self.report_.append({"column": column, "action": "date", "detail": "date → " + ", ".join(parts)})
            else:
                text = series.dropna().astype(str)
                unique = text.nunique()
                if self.drop_id_like and len(text) >= 20 and unique >= 0.9 * len(text) and kind != "text":
                    self.plan_.append((column, "drop", None))
                    self.report_.append(
                        {"column": column, "action": "drop", "detail": "unique on almost every row (an ID)"}
                    )
                elif kind == "text":
                    self.plan_.append((column, "length", None))
                    self.report_.append(
                        {"column": column, "action": "text", "detail": "free text → length and word count"}
                    )
                elif unique <= self.max_onehot:
                    categories = sorted(text.unique().tolist())
                    has_missing = bool(series.isna().any())
                    self.plan_.append((column, "onehot", (categories, has_missing)))
                    self.report_.append(
                        {
                            "column": column,
                            "action": "onehot",
                            "detail": f"{len(categories)} categories → one column each",
                        }
                    )
                else:
                    shares = text.value_counts(normalize=True).to_dict()
                    self.plan_.append((column, "frequency", shares))
                    self.report_.append(
                        {"column": column, "action": "frequency", "detail": f"{unique} categories → frequency"}
                    )
        self.feature_names_out_ = list(self.transform(frame.head(1)).columns)
        return self

    def transform(self, X: Any) -> pd.DataFrame:
        frame = _frame(X)
        out: dict[str, Any] = {}
        n = len(frame)
        for column, action, info in self.plan_:
            series = frame[column] if column in frame.columns else pd.Series([np.nan] * n, index=frame.index)
            if action == "number":
                values = pd.to_numeric(series, errors="coerce").replace([np.inf, -np.inf], np.nan)
                out[column] = values.fillna(info).astype(float)
            elif action == "bool":
                out[column] = _to_bool(series).astype(float).fillna(0.0)
            elif action == "date":
                parts = date_parts(series, info, column)
                for name in parts.columns:
                    out[name] = parts[name].fillna(parts[name].median() if parts[name].notna().any() else 0.0)
            elif action == "onehot":
                categories, has_missing = info
                text = series.astype(str).where(series.notna(), None)
                for category in categories:
                    out[f"{column}={category}"] = (text == category).astype(float)
                if has_missing:
                    out[f"{column}=(missing)"] = series.isna().astype(float)
            elif action == "frequency":
                out[column] = series.astype(str).map(info).fillna(0.0).astype(float)
            elif action == "length":
                text = series.fillna("").astype(str)
                out[f"{column}_length"] = text.str.len().astype(float)
                out[f"{column}_words"] = text.str.split().str.len().fillna(0).astype(float)
        return pd.DataFrame(out, index=frame.index)

    def get_feature_names_out(self, input_features: Any = None) -> np.ndarray:
        return np.asarray(self.feature_names_out_, dtype=object)


# --------------------------------------------------------------------------------- neural networks

ACTIVATIONS = ("relu", "leaky_relu", "gelu", "tanh", "sigmoid", "elu", "linear")


def _act(z: np.ndarray, name: str) -> np.ndarray:
    if name == "relu":
        return np.maximum(z, 0)
    if name == "leaky_relu":
        return np.where(z > 0, z, 0.01 * z)
    if name == "tanh":
        return np.tanh(z)
    if name == "sigmoid":
        return 1.0 / (1.0 + np.exp(-np.clip(z, -60, 60)))
    if name == "elu":
        return np.where(z > 0, z, np.expm1(np.minimum(z, 0)))
    if name == "gelu":
        from scipy.special import erf

        return 0.5 * z * (1.0 + erf(z / math.sqrt(2.0)))
    return z


def _act_grad(z: np.ndarray, name: str) -> np.ndarray:
    if name == "relu":
        return (z > 0).astype(z.dtype)
    if name == "leaky_relu":
        return np.where(z > 0, 1.0, 0.01).astype(z.dtype)
    if name == "tanh":
        return 1.0 - np.tanh(z) ** 2
    if name == "sigmoid":
        s = _act(z, "sigmoid")
        return s * (1 - s)
    if name == "elu":
        return np.where(z > 0, 1.0, np.exp(np.minimum(z, 0))).astype(z.dtype)
    if name == "gelu":
        from scipy.special import erf

        cdf = 0.5 * (1.0 + erf(z / math.sqrt(2.0)))
        pdf = np.exp(-0.5 * z**2) / math.sqrt(2 * math.pi)
        return cdf + z * pdf
    return np.ones_like(z)


def normalize_layers(layers: Sequence[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Validated hidden layers; a sensible default network when none are given."""
    if not layers:
        layers = [
            {"type": "dense", "units": 64, "activation": "relu"},
            {"type": "dropout", "rate": 0.1},
            {"type": "dense", "units": 32, "activation": "relu"},
        ]
    clean: list[dict[str, Any]] = []
    for layer in layers:
        kind = layer.get("type", "dense")
        if kind == "dense":
            activation = layer.get("activation", "relu")
            clean.append(
                {
                    "type": "dense",
                    "units": max(1, min(4096, int(layer.get("units", 32)))),
                    "activation": activation if activation in ACTIVATIONS else "relu",
                }
            )
        elif kind == "dropout":
            clean.append({"type": "dropout", "rate": float(min(0.9, max(0.0, layer.get("rate", 0.2))))})
        elif kind == "batchnorm":
            clean.append({"type": "batchnorm"})
    return clean


def _forward_numpy(params: list[dict[str, Any]], X: np.ndarray) -> np.ndarray:
    out = X
    for layer in params:
        if layer["type"] == "dense":
            out = _act(out @ layer["W"] + layer["b"], layer["activation"])
        elif layer["type"] == "batchnorm":
            out = (out - layer["mean"]) / np.sqrt(layer["var"] + layer["eps"]) * layer["gamma"] + layer["beta"]
    return out


def _softmax(z: np.ndarray) -> np.ndarray:
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def pick_device(requested: str = "auto") -> str:
    try:
        import torch
    except ImportError:
        return "cpu"
    if requested not in ("auto", ""):
        return requested
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


def torch_available() -> bool:
    try:
        import torch  # noqa: F401
    except ImportError:
        return False
    return True


EpochCallback = Callable[[int, dict[str, float]], bool]


class _NeuralNet(BaseEstimator):
    """Shared training code for the tabular networks."""

    _task = "regression"

    def __init__(
        self,
        layers: list[dict[str, Any]] | None = None,
        epochs: int = 50,
        batch_size: int = 64,
        learning_rate: float = 0.001,
        optimizer: str = "adam",
        weight_decay: float = 0.0,
        patience: int = 8,
        val_fraction: float = 0.1,
        class_weight: str | None = None,
        backend: str = "auto",
        device: str = "auto",
        random_state: int = 0,
    ) -> None:
        self.layers = layers
        self.epochs = epochs
        self.batch_size = batch_size
        self.learning_rate = learning_rate
        self.optimizer = optimizer
        self.weight_decay = weight_decay
        self.patience = patience
        self.val_fraction = val_fraction
        self.class_weight = class_weight
        self.backend = backend
        self.device = device
        self.random_state = random_state

    # the trainer sets this to stream epochs; it is never pickled
    _on_epoch: EpochCallback | None = None

    def __getstate__(self) -> dict[str, Any]:
        state = dict(self.__dict__)
        state.pop("_on_epoch", None)
        return state

    def _backend(self) -> str:
        if self.backend == "numpy":
            return "numpy"
        if self.backend == "torch" or (self.backend == "auto" and torch_available()):
            if not torch_available():
                raise RuntimeError("PyTorch is not installed in this engine; choose the NumPy backend")
            return "torch"
        return "numpy"

    # targets -------------------------------------------------------------------------------
    def _targets(self, y: Any) -> tuple[np.ndarray, int]:
        raise NotImplementedError

    def fit(self, X: Any, y: Any) -> _NeuralNet:
        features = np.asarray(X, dtype=np.float32)
        if not np.isfinite(features).all():
            raise ValueError("the network needs numbers without gaps: keep Auto-prep on or fill missing values")
        target, outputs = self._targets(y)
        rng = np.random.default_rng(self.random_state)
        n = len(features)
        order = rng.permutation(n)
        n_val = int(n * self.val_fraction) if self.val_fraction and n >= 40 else 0
        val_idx, train_idx = order[:n_val], order[n_val:]
        self.n_features_in_ = features.shape[1]
        self.hidden_ = normalize_layers(self.layers)
        self.history_: list[dict[str, float]] = []
        weights = self._sample_weights(target)
        backend = self._backend()
        self.backend_ = backend
        fit = self._fit_torch if backend == "torch" else self._fit_numpy
        self._force_cpu = False
        try:
            self.params_ = fit(features, target, weights, outputs, train_idx, val_idx, rng)
        except RuntimeError:
            # a GPU that reports itself available can still fail (e.g. Apple's MPS in a virtual machine)
            if backend != "torch" or getattr(self, "device_", "cpu") == "cpu":
                raise
            self._force_cpu, self.history_ = True, []
            self.params_ = fit(
                features, target, weights, outputs, train_idx, val_idx, np.random.default_rng(self.random_state)
            )
        return self

    def _sample_weights(self, target: np.ndarray) -> np.ndarray | None:
        return None

    def _report(self, epoch: int, metrics: dict[str, float]) -> bool:
        record = {"epoch": float(epoch), **{k: float(v) for k, v in metrics.items()}}
        self.history_.append(record)
        callback = getattr(self, "_on_epoch", None)
        return callback(epoch, metrics) if callback else True

    def _loss_and_grad(self, out: np.ndarray, target: np.ndarray, w: np.ndarray | None) -> tuple[float, np.ndarray]:
        raise NotImplementedError

    def _val_metrics(self, out: np.ndarray, target: np.ndarray) -> dict[str, float]:
        raise NotImplementedError

    # numpy ---------------------------------------------------------------------------------
    def _init_params(self, n_in: int, outputs: int, rng: np.random.Generator) -> list[dict[str, Any]]:
        params: list[dict[str, Any]] = []
        width = n_in
        for layer in self.hidden_:
            if layer["type"] == "dense":
                gain = 2.0 if layer["activation"] in ("relu", "leaky_relu", "elu", "gelu") else 1.0
                W = rng.normal(0, math.sqrt(gain / width), (width, layer["units"])).astype(np.float32)
                params.append({"type": "dense", "W": W, "b": np.zeros(layer["units"], np.float32),
                               "activation": layer["activation"]})  # fmt: skip
                width = layer["units"]
            elif layer["type"] == "dropout":
                params.append({"type": "dropout", "rate": layer["rate"]})
            elif layer["type"] == "batchnorm":
                params.append({"type": "batchnorm", "gamma": np.ones(width, np.float32), "beta": np.zeros(width, np.float32),
                               "mean": np.zeros(width, np.float32), "var": np.ones(width, np.float32), "eps": 1e-5})  # fmt: skip
        W = rng.normal(0, math.sqrt(1.0 / width), (width, outputs)).astype(np.float32)
        params.append({"type": "dense", "W": W, "b": np.zeros(outputs, np.float32), "activation": "linear"})
        return params

    def _fit_numpy(self, X, target, weights, outputs, train_idx, val_idx, rng):  # type: ignore[no-untyped-def]
        params = self._init_params(X.shape[1], outputs, rng)
        trainable = [(i, key) for i, p in enumerate(params) for key in ("W", "b", "gamma", "beta") if key in p]
        m = {k: np.zeros_like(params[k[0]][k[1]]) for k in trainable}
        v = {k: np.zeros_like(params[k[0]][k[1]]) for k in trainable}
        lr, step = float(self.learning_rate), 0
        best, best_params, waited = math.inf, None, 0
        batch = max(1, int(self.batch_size))
        for epoch in range(1, int(self.epochs) + 1):
            order = rng.permutation(train_idx)
            total, count = 0.0, 0
            for start in range(0, len(order), batch):
                idx = order[start : start + batch]
                if len(idx) < 2 and any(p["type"] == "batchnorm" for p in params):
                    continue
                xb, yb = X[idx], target[idx]
                wb = weights[idx] if weights is not None else None
                caches, out = [], xb
                for p in params:
                    if p["type"] == "dense":
                        z = out @ p["W"] + p["b"]
                        caches.append((out, z))
                        out = _act(z, p["activation"])
                    elif p["type"] == "dropout":
                        mask = (rng.random(out.shape) >= p["rate"]).astype(np.float32) / max(1e-6, 1 - p["rate"])
                        caches.append(mask)
                        out = out * mask
                    else:
                        mu, var = out.mean(axis=0), out.var(axis=0)
                        inv = 1.0 / np.sqrt(var + p["eps"])
                        xhat = (out - mu) * inv
                        caches.append((xhat, inv))
                        unbiased = var * len(out) / max(1, len(out) - 1)
                        p["mean"] = 0.9 * p["mean"] + 0.1 * mu
                        p["var"] = 0.9 * p["var"] + 0.1 * unbiased
                        out = xhat * p["gamma"] + p["beta"]
                loss, grad = self._loss_and_grad(out, yb, wb)
                total += loss * len(idx)
                count += len(idx)
                grads: dict[tuple[int, str], np.ndarray] = {}
                for i in range(len(params) - 1, -1, -1):
                    p, cache = params[i], caches[i]
                    if p["type"] == "dense":
                        x_in, z = cache
                        dz = grad * _act_grad(z, p["activation"])
                        grads[(i, "W")] = x_in.T @ dz
                        grads[(i, "b")] = dz.sum(axis=0)
                        grad = dz @ p["W"].T
                    elif p["type"] == "dropout":
                        grad = grad * cache
                    else:
                        xhat, inv = cache
                        grads[(i, "gamma")] = (grad * xhat).sum(axis=0)
                        grads[(i, "beta")] = grad.sum(axis=0)
                        dxhat = grad * p["gamma"]
                        nb = len(dxhat)
                        grad = inv / nb * (nb * dxhat - dxhat.sum(axis=0) - xhat * (dxhat * xhat).sum(axis=0))
                step += 1
                for key in trainable:
                    g = grads[key].astype(np.float32)
                    value = params[key[0]][key[1]]
                    if self.optimizer == "sgd":
                        m[key] = 0.9 * m[key] + g
                        value -= lr * (m[key] + self.weight_decay * value)
                    else:
                        if self.optimizer == "adam" and self.weight_decay:
                            g = g + self.weight_decay * value
                        m[key] = 0.9 * m[key] + 0.1 * g
                        v[key] = 0.999 * v[key] + 0.001 * g * g
                        m_hat = m[key] / (1 - 0.9**step)
                        v_hat = v[key] / (1 - 0.999**step)
                        value -= lr * m_hat / (np.sqrt(v_hat) + 1e-8)
                        if self.optimizer == "adamw" and self.weight_decay:
                            value -= lr * self.weight_decay * value
            metrics = {"loss": total / max(1, count)}
            monitor = metrics["loss"]
            if len(val_idx):
                out = _forward_numpy(params, X[val_idx])
                val_loss, _ = self._loss_and_grad(out, target[val_idx], None)
                metrics["val_loss"] = val_loss
                metrics.update(self._val_metrics(out, target[val_idx]))
                monitor = val_loss
            if not math.isfinite(monitor):
                raise ValueError("training diverged (loss is not a number): lower the learning rate")
            keep_going = self._report(epoch, metrics)
            if monitor < best - 1e-6:
                best, waited = monitor, 0
                best_params = [
                    {k: (v.copy() if isinstance(v, np.ndarray) else v) for k, v in p.items()} for p in params
                ]
            else:
                waited += 1
            if not keep_going or (self.patience and len(val_idx) and waited >= self.patience):
                break
        return best_params or params

    # torch ---------------------------------------------------------------------------------
    def _fit_torch(self, X, target, weights, outputs, train_idx, val_idx, rng):  # type: ignore[no-untyped-def]
        import torch
        from torch import nn

        torch.manual_seed(self.random_state)
        device = torch.device("cpu" if getattr(self, "_force_cpu", False) else pick_device(self.device))
        self.device_ = str(device)
        modules: list[Any] = []
        width = X.shape[1]
        acts = {"relu": nn.ReLU, "leaky_relu": nn.LeakyReLU, "gelu": nn.GELU, "tanh": nn.Tanh,
                "sigmoid": nn.Sigmoid, "elu": nn.ELU}  # fmt: skip
        for layer in self.hidden_:
            if layer["type"] == "dense":
                modules.append(nn.Linear(width, layer["units"]))
                if layer["activation"] in acts:
                    modules.append(acts[layer["activation"]]())
                width = layer["units"]
            elif layer["type"] == "dropout":
                modules.append(nn.Dropout(layer["rate"]))
            else:
                modules.append(nn.BatchNorm1d(width))
        modules.append(nn.Linear(width, outputs))
        net = nn.Sequential(*modules).to(device)
        optimizers = {"sgd": lambda p: torch.optim.SGD(p, lr=self.learning_rate, momentum=0.9, weight_decay=self.weight_decay),
                      "adamw": lambda p: torch.optim.AdamW(p, lr=self.learning_rate, weight_decay=self.weight_decay),
                      "rmsprop": lambda p: torch.optim.RMSprop(p, lr=self.learning_rate, weight_decay=self.weight_decay)}  # fmt: skip
        make = optimizers.get(
            self.optimizer, lambda p: torch.optim.Adam(p, lr=self.learning_rate, weight_decay=self.weight_decay)
        )
        opt = make(net.parameters())
        Xt = torch.as_tensor(X, device=device)
        yt = torch.as_tensor(target, device=device)
        wt = torch.as_tensor(weights, device=device) if weights is not None else None
        tr = torch.as_tensor(train_idx, device=device)
        va = torch.as_tensor(val_idx, device=device)
        best, best_state, waited = math.inf, None, 0
        batch = max(1, int(self.batch_size))
        generator = torch.Generator(device="cpu").manual_seed(self.random_state)
        for epoch in range(1, int(self.epochs) + 1):
            net.train()
            perm = tr[torch.randperm(len(tr), generator=generator).to(device)]
            total, count = 0.0, 0
            for start in range(0, len(perm), batch):
                idx = perm[start : start + batch]
                if len(idx) < 2 and any(isinstance(mod, nn.BatchNorm1d) for mod in modules):
                    continue
                opt.zero_grad()
                loss = self._torch_loss(net(Xt[idx]), yt[idx], wt[idx] if wt is not None else None)
                loss.backward()
                opt.step()
                total += float(loss.detach()) * len(idx)
                count += len(idx)
            metrics = {"loss": total / max(1, count)}
            monitor = metrics["loss"]
            if len(va):
                net.eval()
                with torch.no_grad():
                    out = net(Xt[va])
                    metrics["val_loss"] = float(self._torch_loss(out, yt[va], None))
                metrics.update(self._val_metrics(out.cpu().numpy(), target[val_idx]))
                monitor = metrics["val_loss"]
            if not math.isfinite(monitor):
                raise ValueError("training diverged (loss is not a number): lower the learning rate")
            keep_going = self._report(epoch, metrics)
            if monitor < best - 1e-6:
                best, waited = monitor, 0
                best_state = {k: t.detach().cpu().clone() for k, t in net.state_dict().items()}
            else:
                waited += 1
            if not keep_going or (self.patience and len(va) and waited >= self.patience):
                break
        if best_state is not None:
            net.load_state_dict(best_state)
        return self._params_from_torch(net.cpu())

    def _params_from_torch(self, net: Any) -> list[dict[str, Any]]:
        from torch import nn

        params: list[dict[str, Any]] = []
        mods = list(net)
        i = 0
        while i < len(mods):
            mod = mods[i]
            if isinstance(mod, nn.Linear):
                activation = "linear"
                if i + 1 < len(mods) and not isinstance(mods[i + 1], nn.Linear | nn.Dropout | nn.BatchNorm1d):
                    activation = {"ReLU": "relu", "LeakyReLU": "leaky_relu", "GELU": "gelu", "Tanh": "tanh",
                                  "Sigmoid": "sigmoid", "ELU": "elu"}[type(mods[i + 1]).__name__]  # fmt: skip
                    i += 1
                params.append({"type": "dense", "W": mod.weight.detach().numpy().T.copy(),
                               "b": mod.bias.detach().numpy().copy(), "activation": activation})  # fmt: skip
            elif isinstance(mod, nn.Dropout):
                params.append({"type": "dropout", "rate": float(mod.p)})
            elif isinstance(mod, nn.BatchNorm1d):
                stats: Any = mod  # running stats are always set on BatchNorm layers
                params.append({"type": "batchnorm", "gamma": mod.weight.detach().numpy().copy(),
                               "beta": mod.bias.detach().numpy().copy(), "mean": stats.running_mean.numpy().copy(),
                               "var": stats.running_var.numpy().copy(), "eps": float(mod.eps)})  # fmt: skip
            i += 1
        return params

    def _torch_loss(self, out: Any, target: Any, weights: Any) -> Any:
        raise NotImplementedError

    def _raw(self, X: Any) -> np.ndarray:
        return _forward_numpy(self.params_, np.asarray(X, dtype=np.float32))

    def to_torch(self) -> Any:
        """Rebuild the trained network as a torch ``nn.Sequential`` (for ONNX / TorchScript export)."""
        import torch
        from torch import nn

        acts = {"relu": nn.ReLU, "leaky_relu": nn.LeakyReLU, "gelu": nn.GELU, "tanh": nn.Tanh,
                "sigmoid": nn.Sigmoid, "elu": nn.ELU}  # fmt: skip
        modules: list[Any] = []
        for p in self.params_:
            if p["type"] == "dense":
                linear = nn.Linear(*p["W"].shape)
                linear.weight.data = torch.as_tensor(p["W"].T.copy())
                linear.bias.data = torch.as_tensor(p["b"].copy())
                modules.append(linear)
                if p["activation"] in acts:
                    modules.append(acts[p["activation"]]())
            elif p["type"] == "dropout":
                modules.append(nn.Dropout(p["rate"]))
            else:
                norm = nn.BatchNorm1d(len(p["gamma"]), eps=p["eps"])
                norm.weight.data = torch.as_tensor(p["gamma"].copy())
                norm.bias.data = torch.as_tensor(p["beta"].copy())
                norm.running_mean = torch.as_tensor(p["mean"].copy())
                norm.running_var = torch.as_tensor(p["var"].copy())
                modules.append(norm)
        return nn.Sequential(*modules).eval()

    def parameter_count(self) -> int:
        return int(sum(v.size for p in self.params_ for k, v in p.items() if k in ("W", "b", "gamma", "beta")))


class NeuralNetClassifier(ClassifierMixin, _NeuralNet):
    """Tabular classifier network. Labels must be 0..k-1 (``FlowLabsModel`` maps names)."""

    _task = "classification"

    def _targets(self, y: Any) -> tuple[np.ndarray, int]:
        labels = np.asarray(y)
        self.classes_ = np.unique(labels)
        index = np.searchsorted(self.classes_, labels).astype(np.int64)
        return index, max(2, len(self.classes_))

    def _sample_weights(self, target: np.ndarray) -> np.ndarray | None:
        if self.class_weight != "balanced":
            return None
        counts = np.bincount(target, minlength=len(self.classes_)).astype(np.float32)
        per_class = len(target) / (len(counts) * np.maximum(counts, 1))
        return per_class[target].astype(np.float32)

    def _loss_and_grad(self, out: np.ndarray, target: np.ndarray, w: np.ndarray | None) -> tuple[float, np.ndarray]:
        probs = _softmax(out)
        n = len(target)
        picked = np.clip(probs[np.arange(n), target], 1e-12, 1.0)
        weight = w if w is not None else np.ones(n, np.float32)
        loss = float((-np.log(picked) * weight).sum() / weight.sum())
        grad = probs.copy()
        grad[np.arange(n), target] -= 1
        grad *= (weight / weight.sum())[:, None]
        return loss, grad.astype(np.float32)

    def _torch_loss(self, out: Any, target: Any, weights: Any) -> Any:
        import torch.nn.functional as F

        if weights is None:
            return F.cross_entropy(out, target)
        losses = F.cross_entropy(out, target, reduction="none")
        return (losses * weights).sum() / weights.sum()

    def _val_metrics(self, out: np.ndarray, target: np.ndarray) -> dict[str, float]:
        return {"val_accuracy": float((out.argmax(axis=1) == target).mean())}

    def predict_proba(self, X: Any) -> np.ndarray:
        return _softmax(self._raw(X))[:, : len(self.classes_)]

    def predict(self, X: Any) -> np.ndarray:
        return self.classes_[self.predict_proba(X).argmax(axis=1)]


class NeuralNetRegressor(RegressorMixin, _NeuralNet):
    """Tabular regression network; the target is standardised for training and restored after."""

    def _targets(self, y: Any) -> tuple[np.ndarray, int]:
        values = np.asarray(y, dtype=np.float32).reshape(-1)
        self.y_mean_ = float(values.mean())
        self.y_std_ = float(values.std()) or 1.0
        return ((values - self.y_mean_) / self.y_std_).reshape(-1, 1).astype(np.float32), 1

    def _loss_and_grad(self, out: np.ndarray, target: np.ndarray, w: np.ndarray | None) -> tuple[float, np.ndarray]:
        diff = out - target
        return float((diff**2).mean()), (2 * diff / len(diff)).astype(np.float32)

    def _torch_loss(self, out: Any, target: Any, weights: Any) -> Any:
        import torch.nn.functional as F

        return F.mse_loss(out, target)

    def _val_metrics(self, out: np.ndarray, target: np.ndarray) -> dict[str, float]:
        total = float(((target - target.mean()) ** 2).sum()) or 1.0
        return {"val_r2": 1.0 - float(((target - out) ** 2).sum()) / total}

    def predict(self, X: Any) -> np.ndarray:
        return self._raw(X).reshape(-1) * self.y_std_ + self.y_mean_


# --------------------------------------------------------------------------------- exported model


def _native(value: Any) -> Any:
    if isinstance(value, np.generic):
        return value.item()
    return value


class FlowLabsModel:
    """A trained FlowLabs pipeline: raw rows in, predictions out.

    ``predict`` returns the original labels (e.g. ``"yes"``/``"no"``) or numbers; ``predict_proba``
    returns a DataFrame with one column per class.
    """

    def __init__(
        self,
        pipeline: Any,
        task: str,
        target: str,
        input_columns: list[str],
        classes: list[Any] | None = None,
        schema: dict[str, Any] | None = None,
        meta: dict[str, Any] | None = None,
    ) -> None:
        self.pipeline = pipeline
        self.task = task
        self.target = target
        self.input_columns = input_columns
        self.classes = classes
        self.schema = schema or {}
        self.meta = meta or {}
        self.runtime_version = RUNTIME_VERSION

    def _prepare(self, X: Any) -> pd.DataFrame:
        if isinstance(X, dict):
            X = [X]
        frame = X if isinstance(X, pd.DataFrame) else pd.DataFrame(list(X))
        frame = frame.copy()
        for column in self.input_columns:
            if column not in frame.columns:
                frame[column] = np.nan
        return frame[self.input_columns]

    def predict(self, X: Any) -> np.ndarray:
        raw = self.pipeline.predict(self._prepare(X))
        if self.task == "classification" and self.classes is not None:
            return np.asarray([_native(self.classes[int(i)]) for i in raw], dtype=object)
        return np.asarray(raw, dtype=float)

    def predict_proba(self, X: Any) -> pd.DataFrame:
        if self.task != "classification":
            raise AttributeError("predict_proba is only available for classification models")
        probs = self.pipeline.predict_proba(self._prepare(X))
        return pd.DataFrame(probs, columns=[str(c) for c in self.classes or range(probs.shape[1])])

    def __repr__(self) -> str:
        name = self.meta.get("model_label", type(self.pipeline).__name__)
        return f"FlowLabsModel({name}, task={self.task}, target={self.target!r}, inputs={len(self.input_columns)})"
