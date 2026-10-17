"""Python source for one pipeline step or model, so it can be read and then edited as a code step.

``step_code`` returns the code step that would replace the item: the same behaviour, written as
Python the user can change. Clean steps become pandas, transforms and models become the
scikit-learn objects FlowLabs builds, and training-set steps become a ``rows(X, y)`` function.
"""

from __future__ import annotations

import json
from typing import Any

import pandas as pd

import flowlabs_runtime as rt

from . import catalogue as cat
from . import datasets
from . import project as projects
from .util import UserError
from .workspace import Workspace

INDENT = "    "


def _list(values: list[str]) -> str:
    return "[" + ", ".join(repr(v) for v in values) + "]"


def _frame_before(ws: Workspace, project: dict[str, Any], step_id: str) -> pd.DataFrame:
    """A sample of the table as the step sees it (after the Clean steps before it)."""
    frame = datasets.load_frame(ws, project["dataset_id"]).head(2000)
    for step in projects.enabled(project.get("clean")):
        if step["id"] == step_id:
            break
        frame = rt.apply_clean_op(frame, step["op"], step.get("params") or {}, rows=True)
    return frame


def _function(name: str, args: str, doc: str, body: list[str]) -> str:
    lines = [f"def {name}({args}):", f'{INDENT}"""{doc}"""', *[f"{INDENT}{line}" if line else "" for line in body]]
    return "\n".join(lines) + "\n"


# ------------------------------------------------------------------------------------- clean


def clean_code(op: str, params: dict[str, Any], frame: pd.DataFrame) -> str:
    """pandas code that does what one Clean step does."""
    p = params or {}
    label = cat.OPS[op].label
    doc = f"{label}, written in pandas. df is the whole table; return the cleaned table."
    body: list[str] = []

    def columns(key: str = "columns", default: list[str] | None = None) -> list[str]:
        return rt.select_columns(frame, p.get(key) or default or [])

    if op == "drop_columns":
        body = [f'return df.drop(columns={_list(columns())}, errors="ignore")']
    elif op == "change_type":
        chosen, to = columns(), p.get("to", "numeric")
        body = ["df = df.copy()", f"for column in {_list(chosen)}:"]
        if to == "numeric":
            body += [f'{INDENT}text = df[column].astype(str).str.replace(r"[,$%\\s]", "", regex=True)',
                     f'{INDENT}df[column] = pd.to_numeric(text, errors="coerce")']  # fmt: skip
        elif to == "boolean":
            yes, no = sorted(rt.TRUTHY), sorted(rt.FALSY)
            body += [f"{INDENT}text = df[column].astype(str).str.strip().str.lower()",
                     f"{INDENT}df[column] = text.map({{**dict.fromkeys({yes!r}, True), **dict.fromkeys({no!r}, False)}})"]  # fmt: skip
        elif to == "datetime":
            body += [f'{INDENT}df[column] = pd.to_datetime(df[column], errors="coerce", format="mixed")']
        else:
            body += [f"{INDENT}df[column] = df[column].map(lambda v: v if pd.isna(v) else str(v)).astype(object)"]
        body.append("return df")
    elif op == "clean_text":
        chosen = columns(default=["@categorical"])
        body = ["df = df.copy()", f"for column in {_list(chosen)}:", f"{INDENT}text = df[column].astype(str)"]
        if p.get("strip", True):
            body.append(f'{INDENT}text = text.str.strip().str.replace(r"\\s+", " ", regex=True)')
        case = p.get("case", "lower")
        if case in ("lower", "upper", "title"):
            body.append(f"{INDENT}text = text.str.{case}()")
        body += [f"{INDENT}df[column] = text.where(df[column].notna(), np.nan).astype(object)", "return df"]
    elif op == "replace_values":
        column, find, replace = p.get("column"), p.get("find"), p.get("replace")
        new = "np.nan" if replace in (None, "") else repr(replace)
        body = ["df = df.copy()", f"column = {column!r}",
                f"df[column] = df[column].astype(object).where(df[column].astype(str) != {str(find)!r}, {new})",
                "return df"]  # fmt: skip
    elif op == "extract_datetime":
        parts = p.get("parts") or ["year", "month", "weekday"]
        body = ["df = df.copy()", f"for column in {_list(columns())}:",
                f'{INDENT}dates = pd.to_datetime(df[column], errors="coerce", format="mixed")']  # fmt: skip
        for part in parts:
            if part == "weekday":
                body.append(f'{INDENT}df[f"{{column}}_weekday"] = dates.dt.dayofweek.astype(float)')
            elif part == "is_weekend":
                body.append(
                    f'{INDENT}df[f"{{column}}_is_weekend"] = (dates.dt.dayofweek >= 5).astype(float).where(dates.notna())'
                )
            else:
                body.append(f'{INDENT}df[f"{{column}}_{part}"] = dates.dt.{part}.astype(float)')
        if p.get("drop_original", True):
            body.append(f"{INDENT}df = df.drop(columns=[column])")
        body.append("return df")
    elif op == "combine_columns":
        a, b, operation = p.get("a"), p.get("b"), p.get("operation", "divide")
        name = p.get("name") or f"{a}_{operation}_{b}"
        sign = {"add": "+", "subtract": "-", "multiply": "*"}.get(operation)
        right = "b" if sign else "b.replace(0, np.nan)"
        body = ["df = df.copy()", f'a = pd.to_numeric(df[{a!r}], errors="coerce")',
                f'b = pd.to_numeric(df[{b!r}], errors="coerce")',
                f"df[{name!r}] = a {sign or '/'} {right}", "return df"]  # fmt: skip
    elif op == "drop_duplicates":
        subset = [c for c in p.get("columns") or [] if c in frame.columns]
        body = [f"return df.drop_duplicates(subset={_list(subset) if subset else 'None'})"]
    elif op == "drop_missing_rows":
        how = "all" if p.get("how") == "all" else "any"
        body = [f"return df.dropna(subset={_list(columns(default=['@all']))}, how={how!r})"]
    elif op == "filter_rows":
        body = [f"return df[{_condition(p.get('column'), str(p.get('operator', '==')), p.get('value'), frame)}]"]
    elif op == "sample_rows":
        rows, seed = int(p.get("rows") or 0), int(p.get("seed", 0))
        body = [f"return df.sample(n=min({rows}, len(df)), random_state={seed})"]
    elif op == "custom_clean":
        return str(p.get("code") or cat.CLEAN_CODE)
    else:
        body = ["return df"]
    return _function("clean", "df", doc, body)


def _condition(column: Any, operator: str, value: Any, frame: pd.DataFrame) -> str:
    series = f"df[{column!r}]"
    if operator == "is missing":
        return f"{series}.isna()"
    if operator == "is not missing":
        return f"{series}.notna()"
    if operator in ("contains", "not contains"):
        test = f"{series}.astype(str).str.contains({str(value)!r}, case=False, regex=False, na=False)"
        return test if operator == "contains" else f"~{test}"
    numeric = column in frame.columns and rt.is_numeric_series(frame[column])
    try:
        number = float(value) if numeric else None
    except (TypeError, ValueError):
        number = None
    if number is not None:
        shown = int(number) if number.is_integer() else number
        return f"{series} {operator} {shown!r}"
    if operator in ("==", "!="):
        return f"{series}.astype(str) {operator} {str(value)!r}"
    return f"{series}.notna()"


# ------------------------------------------------------------------------------- training set


def rows_code(op: str, params: dict[str, Any], task: str, seed: int) -> str:
    p = params or {}
    label = cat.OPS[op].label
    doc = f"{label}. Only training rows pass through here; return X, y."
    if op == "custom_rows":
        return str(p.get("code") or cat.ROWS_CODE)
    method = p.get("method")
    if op == "remove_outliers" and method in ("iqr", "zscore"):
        threshold = float(p.get("threshold", 3.0))
        spec = p.get("columns") or ["@numeric"]
        body = ["prepared = clean(X)  # X after the Clean steps",
                f"columns = [c for c in select_columns(prepared, {spec!r}) if is_numeric_series(prepared[c])]",
                'numbers = prepared[columns].apply(pd.to_numeric, errors="coerce")']  # fmt: skip
        if method == "zscore":
            body += ["z = (numbers - numbers.mean()) / numbers.std(ddof=0).replace(0, np.nan)",
                     f"outlier = (z.abs() > {threshold!r}).any(axis=1)"]  # fmt: skip
        else:
            body += ["q1, q3 = numbers.quantile(0.25), numbers.quantile(0.75)", "iqr = q3 - q1",
                     f"outlier = ((numbers < q1 - {threshold!r} * iqr) | (numbers > q3 + {threshold!r} * iqr)).any(axis=1)"]  # fmt: skip
        body += ["return X[~outlier], y[~outlier]"]
        source = _function("rows", "X, y", doc, body)
        return "from flowlabs_runtime import is_numeric_series, select_columns\n\n\n" + source
    if op == "balance_classes" and method in ("oversample", "undersample"):
        body = [f"rng = np.random.default_rng({seed})", "counts = y.value_counts()",
                "X, y = X.reset_index(drop=True), y.reset_index(drop=True)", "picked = []"]  # fmt: skip
        if method == "undersample":
            body += ["size = int(counts.min())", "for label in counts.index:",
                     f"{INDENT}members = np.flatnonzero(y == label)",
                     f"{INDENT}picked.append(rng.choice(members, size, replace=False))"]  # fmt: skip
        else:
            body += ["size = int(counts.max())", "for label, n in counts.items():",
                     f"{INDENT}members = np.flatnonzero(y == label)",
                     f"{INDENT}picked += [members, rng.choice(members, size - n, replace=True)]"]  # fmt: skip
        body += ["index = rng.permutation(np.concatenate(picked))",
                 "return X.iloc[index].reset_index(drop=True), y.iloc[index].reset_index(drop=True)"]  # fmt: skip
        return _function("rows", "X, y", doc, body)
    # other methods: call FlowLabs' own implementation, which you can replace
    steps = json.dumps([{"op": op, "params": p}])
    body = [f"steps = {steps}", f"X, y, note = training_rows(steps, X, y, {task!r}, {seed})", "return X, y"]
    return "from flowlabs_runtime import training_rows\n\n\n" + _function("rows", "X, y", doc, body)


# ---------------------------------------------------------------------------- transform, model


def _object_code(obj: Any, variable: str, comment: str) -> str:
    from .export import _Emitter

    emitter = _Emitter()
    value = emitter.value(obj)
    imports = emitter.import_lines()
    head = "\n".join(imports) + ("\n\n" if imports else "")
    return f"# {comment}\n{head}{variable} = {value}\n"


def transform_code(op: str, params: dict[str, Any]) -> str:
    p = params or {}
    if op == "custom_transform":
        return str(p.get("code") or cat.TRANSFORM_CODE)
    definition = cat.OPS[op]
    assert definition.build is not None
    comment = (f"{definition.label}: fitted on the training rows of the chosen columns, then applied to "
               "test rows and new data.\n# Change its settings here, or swap in any scikit-learn transformer.")  # fmt: skip
    return _object_code(definition.build(p), "transformer", comment)


def model_code(project: dict[str, Any], entry: dict[str, Any]) -> str:
    params = entry.get("params") or {}
    if entry["algo"] == "custom_model":
        return str(params.get("code") or cat.MODEL_CODE.get(project.get("task", ""), ""))
    algo = cat.ALGO_BY_ID[entry["algo"]]
    weighted = any(s["op"] == "balance_classes" and (s.get("params") or {}).get("method") == "class_weight"
                   for s in projects.enabled(project.get("rows")))  # fmt: skip
    model = algo.build(project["task"], params, {"n_jobs": -1, "class_weight": weighted, "device": "cpu"})
    comment = (f"{entry.get('label') or algo.label}. Any model with fit() and predict() works here.\n"
               "# Auto-prep (when on) still turns the table into numbers before the model sees it.")  # fmt: skip
    return _object_code(model, "model", comment)


# ------------------------------------------------------------------------------------- entry


def step_code(ws: Workspace, project: dict[str, Any], stage: str, item_id: str) -> dict[str, Any]:
    """``{"code", "replacement"}``: the Python for one item and the code step that would replace it."""
    if project.get("kind") == "image":
        raise UserError("code steps are for table projects")
    if stage == "models":
        entry = next((m for m in project.get("models", []) if m["id"] == item_id), None)
        if entry is None:
            raise UserError("that model is not in the project any more")
        code = model_code(project, entry)
        return {"code": code, "replacement": {"algo": "custom_model", "params": {"code": code},
                                              "label": f"{entry.get('label') or entry['algo']} (code)"}}  # fmt: skip
    step = next((s for s in project.get(stage) or [] if s["id"] == item_id), None)
    if step is None:
        raise UserError("that step is not in the pipeline any more")
    params = step.get("params") or {}
    if stage == "clean":
        code = clean_code(step["op"], params, _frame_before(ws, project, item_id))
        replacement = {"op": "custom_clean", "params": {"code": code, "training_only": step["op"] in rt.ROW_OPS}}
    elif stage == "rows":
        seed = int((project.get("split") or {}).get("seed", 42))
        code = rows_code(step["op"], params, project.get("task", "classification"), seed)
        replacement = {"op": "custom_rows", "params": {"code": code}}
    elif stage == "transform":
        code = transform_code(step["op"], params)
        replacement = {"op": "custom_transform", "params": {"columns": params.get("columns") or ["@all"], "code": code}}
    else:
        raise UserError(f"no code for the {stage} stage")
    if step["op"].startswith("custom_"):
        replacement = {"op": step["op"], "params": params}
    return {"code": code, "replacement": replacement}
