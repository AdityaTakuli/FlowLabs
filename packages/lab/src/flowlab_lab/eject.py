"""Flow → Code eject (PRD II 3.1).

Generates a clean pandas / scikit-learn notebook or ``# %%`` script that reproduces a compiled
Flow Mode graph. Column lists, categories, split sizes and estimator settings are resolved from
the compiled plan with the same helpers the nodes use, so the result matches the engine. This
is a one-way export: the user owns the file and FlowLab never re-imports it as the same flow.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import nbformat
from flowlab_nodes import get_node
from flowlab_nodes.catalogue.clean import _impute_columns
from flowlab_nodes.catalogue.model import build_estimator
from flowlab_nodes.catalogue.prep import _bits, _encode_columns, _positive_class, _scale_columns
from flowspec import ExecutionPlan, FlowSpec, PlanStep, PortType, TableSchema

Format = Literal["py", "ipynb"]

HELPERS = '''

def as_category(series):
    """Category labels the way FlowLab compares them: 'true'/'false' for booleans, '3' for 3.0."""

    def label(value):
        if value is None or (isinstance(value, float) and math.isnan(value)):
            return None
        if isinstance(value, (bool, np.bool_)):
            return "true" if value else "false"
        if isinstance(value, (float, np.floating)) and float(value).is_integer():
            return str(int(value))
        return str(value)

    return series.map(label)


def train_part(value):
    """Learning steps fit on the train partition of a split, or on the whole table."""
    return value["train"] if isinstance(value, dict) else value


def each_part(value, transform):
    if isinstance(value, dict):
        return {name: transform(frame) for name, frame in value.items()}
    return transform(value)


def pick_part(value, partition):
    return value[partition] if isinstance(value, dict) else value
'''


@dataclass
class _Context:
    plan: ExecutionPlan
    dataset_files: Mapping[str, str]
    names: dict[tuple[str, str], str] = field(default_factory=dict)
    imports: set[str] = field(default_factory=set)
    uses_matplotlib: bool = False

    def var(self, node_id: str, port: str) -> str:
        key = (node_id, port)
        if key not in self.names:
            name = re.sub(r"\W", "_", f"{node_id}_{port}")
            self.names[key] = f"n_{name}" if name[0].isdigit() else name
        return self.names[key]

    def source(self, step: PlanStep, port: str) -> str:
        ref = step.inputs[port]
        return self.var(ref.node_id, ref.port)


def _table(step: PlanStep, port: str, *, output: bool = False) -> TableSchema:
    schemas = step.output_schemas if output else step.input_schemas
    return schemas[port].require_table()


def _module_of(obj: Any) -> str:
    parts = type(obj).__module__.split(".")
    public = [p for p in parts if not p.startswith("_")]
    return ".".join(public[: next((i for i, p in enumerate(parts) if p.startswith("_")), len(parts))])


def _seed(step: PlanStep, plan: ExecutionPlan) -> int:
    seed = step.params.get("seed")
    return int(seed) if seed is not None else plan.seed


# ---------------------------------------------------------------------------- generators


def _source(step: PlanStep, ctx: _Context) -> str:
    ref = step.params["dataset_ref"]
    file_name = ctx.dataset_files[ref]
    suffix = Path(file_name).suffix.lower()
    reader = {
        ".parquet": "pd.read_parquet({path})",
        ".jsonl": "pd.read_json({path}, lines=True)",
        ".ndjson": "pd.read_json({path}, lines=True)",
        ".json": "pd.read_json({path})",
        ".feather": "pd.read_feather({path})",
        ".tsv": 'pd.read_csv({path}, sep="\\t")',
    }.get(suffix, "pd.read_csv({path})")
    lines = [f"{ctx.var(step.node_id, 'out')} = " + reader.format(path=f"DATA_DIR / {file_name!r}")]
    if step.params.get("target"):
        lines.insert(0, f"# target column: {step.params['target']!r}")
    return "\n".join(lines)


def _overview(step: PlanStep, ctx: _Context) -> str:
    frame, out = ctx.source(step, "in"), ctx.var(step.node_id, "out")
    rows = int(step.params.get("head_rows", 5))
    return (
        f"print({frame}.shape)\nprint({frame}.dtypes)\nprint({frame}.head({rows}))\n"
        f'{out} = {{"row_count": len({frame}), "column_count": {frame}.shape[1]}}'
    )


def _missingness(step: PlanStep, ctx: _Context) -> str:
    frame = ctx.source(step, "in")
    metrics, chart = ctx.var(step.node_id, "metrics"), ctx.var(step.node_id, "chart")
    return (
        f"{metrics} = {frame}.isna().sum().to_dict()\n"
        f"{chart} = ({frame}.isna().mean() * 100).round(2).sort_values(ascending=False)\n"
        f"print({chart}[{chart} > 0])"
    )


def _drop_columns(step: PlanStep, ctx: _Context) -> str:
    kept = set(_table(step, "out", output=True).names)
    dropped = [c for c in _table(step, "in").names if c not in kept]
    return (
        f"{ctx.var(step.node_id, 'out')} = each_part({ctx.source(step, 'in')}, "
        f"lambda frame: frame.drop(columns={dropped!r}))"
    )


def _impute(step: PlanStep, ctx: _Context) -> str:
    params: Any = get_node(step.node_type).parse_params(step.params)  # type: ignore[union-attr]
    columns = [c.name for c in _impute_columns(params, _table(step, "in"))]
    source, out, node = ctx.source(step, "in"), ctx.var(step.node_id, "out"), step.node_id
    strategy = params.strategy
    if strategy in ("mean", "median"):
        return (
            f"{node}_fills = {{c: train_part({source})[c].astype(float).{strategy}() for c in {columns!r}}}\n"
            f"{out} = each_part({source}, lambda frame: frame.astype({{c: float for c in {columns!r}}})"
            f".fillna({node}_fills))"
        )
    if strategy == "mode":
        return (
            f"{node}_train = train_part({source})\n"
            f"{node}_fills = {{c: {node}_train[c].dropna().mode().sort_values().iloc[0] "
            f"for c in {columns!r} if {node}_train[c].notna().any()}}\n"
            f"{out} = each_part({source}, lambda frame: frame.fillna({node}_fills))"
        )
    if strategy == "constant":
        return f"{out} = each_part({source}, lambda frame: frame.fillna({{c: {params.fill_value!r} for c in {columns!r}}}))"
    if strategy == "ffill":
        return f"{out} = each_part({source}, lambda frame: frame.assign(**{{c: frame[c].ffill() for c in {columns!r}}}))"
    if strategy == "knn":
        ctx.imports.add("from sklearn.impute import KNNImputer")
        imputer = f"KNNImputer(n_neighbors=min({params.knn_neighbors}, len(train_part({source}))))"
    else:
        ctx.imports.update({
            "from sklearn.experimental import enable_iterative_imputer  # noqa: F401",
            "from sklearn.impute import IterativeImputer",
        })  # fmt: skip
        imputer = f"IterativeImputer(random_state={_seed(step, ctx.plan)}, max_iter={params.max_iter})"
    return (
        f"{node}_imputer = {imputer}.fit(train_part({source})[{columns!r}].astype(float))\n"
        f"{out} = each_part({source}, lambda frame: frame.assign("
        f"**dict(zip({columns!r}, {node}_imputer.transform(frame[{columns!r}].astype(float)).T))))"
    )


def _split(step: PlanStep, ctx: _Context) -> str:
    p = step.params
    node, source, out = step.node_id, ctx.source(step, "in"), ctx.var(step.node_id, "out")
    seed = _seed(step, ctx.plan)
    ctx.imports.add("from sklearn.model_selection import GroupShuffleSplit, train_test_split")
    lines = [
        f"{node}_rows = {source}.reset_index(drop=True)",
        f"{node}_index = np.arange(len({node}_rows))",
        f"{node}_test = math.ceil(len({node}_rows) * {p['test_size']})",
        f"{node}_val = math.ceil(len({node}_rows) * {p['val_size']}) if {p['val_size']} else 0",
        f"{node}_train_n = len({node}_rows) - {node}_test - {node}_val",
    ]
    if p.get("time_based"):
        lines += [
            f"{node}_order = {node}_rows.assign(_row=np.arange(len({node}_rows)))"
            f".sort_values([{p['time_column']!r}, '_row'], na_position='last', kind='stable')['_row'].to_numpy()",
            f"train_idx = {node}_order[:{node}_train_n]",
            f"val_idx = {node}_order[{node}_train_n:{node}_train_n + {node}_val]",
            f"test_idx = {node}_order[{node}_train_n + {node}_val:]",
        ]
    elif p.get("group_by"):
        lines += [
            f"{node}_groups = as_category({node}_rows[{p['group_by']!r}]).fillna('__null__').to_numpy()",
            f"rest_idx, test_idx = next(GroupShuffleSplit(n_splits=1, test_size={p['test_size']}, "
            f"random_state={seed}).split({node}_index, groups={node}_groups))",
            "train_idx, val_idx = rest_idx, np.array([], dtype=int)",
            f"if {node}_val:",
            f"    inner = GroupShuffleSplit(n_splits=1, test_size={p['val_size']} / (1 - {p['test_size']}), "
            f"random_state={seed})",
            f"    tr, va = next(inner.split(rest_idx, groups={node}_groups[rest_idx]))",
            "    train_idx, val_idx = rest_idx[tr], rest_idx[va]",
            "train_idx, val_idx, test_idx = np.sort(train_idx), np.sort(val_idx), np.sort(test_idx)",
        ]
    else:
        strata = (
            f"as_category({node}_rows[{p['stratify_by']!r}]).fillna('__null__').to_numpy()"
            if p.get("stratify_by")
            else "None"
        )
        lines += [
            f"{node}_strata = {strata}",
            f"rest_idx, test_idx = train_test_split({node}_index, test_size={node}_test, "
            f"random_state={seed}, stratify={node}_strata)",
            "train_idx, val_idx = rest_idx, np.array([], dtype=int)",
            f"if {node}_val:",
            f"    train_idx, val_idx = train_test_split(rest_idx, test_size={node}_val, random_state={seed}, "
            f"stratify=None if {node}_strata is None else {node}_strata[rest_idx])",
            "train_idx, val_idx, test_idx = np.sort(train_idx), np.sort(val_idx), np.sort(test_idx)",
        ]
    parts = ", ".join(
        f'"{name}": {node}_rows.iloc[{name}_idx].reset_index(drop=True)'
        for name in step.output_schemas["out"].partitions or ["train", "test"]
    )
    lines.append(f"{out} = {{{parts}}}")
    return "\n".join(lines)


def _encode(step: PlanStep, ctx: _Context) -> str:
    params: Any = get_node(step.node_type).parse_params(step.params)  # type: ignore[union-attr]
    schema = _table(step, "in")
    columns = _encode_columns(params, schema)
    node, source, out = step.node_id, ctx.source(step, "in"), ctx.var(step.node_id, "out")
    out_names = _table(step, "out", output=True).names
    names = [c.name for c in columns]
    head = f"{node}_train = train_part({source})\n"
    vocab = f"{node}_vocab = {{c: sorted(set(as_category({node}_train[c]).dropna())) for c in {names!r}}}\n"
    if params.method == "onehot":
        categories = {c.name: c.categories or [] for c in columns}
        body = (
            f"{node}_categories = {categories!r}\n{vocab}\n\n"
            f"def {node}_encode(frame):\n"
            "    encoded = {}\n"
            f"    for column, categories in {node}_categories.items():\n"
            "        labels = as_category(frame[column])\n"
            "        for category in categories:\n"
            f"            seen = category in {node}_vocab[column]\n"
            '            encoded[f"{column}={category}"] = ((labels == category) & seen).astype("int8")\n'
            f"    return frame.assign(**encoded)[{out_names!r}]\n"
        )
    elif params.method in ("ordinal", "binary"):
        offset, unknown = (0, -1) if params.method == "ordinal" else (1, 0)
        order = {c: params.ordinal_order.get(c) for c in names}
        bits = {c.name: _bits(len(c.categories or [])) for c in columns}
        body = (
            f"{vocab}{node}_order = {order!r}\n"
            f"{node}_codes = {{c: {{v: i + {offset} for i, v in enumerate({node}_order[c] or {node}_vocab[c])}} "
            f"for c in {names!r}}}\n\n\n"
            f"def {node}_encode(frame):\n"
            f"    codes = {{c: as_category(frame[c]).map({node}_codes[c]).fillna({unknown}).astype('int64') "
            f"for c in {names!r}}}\n"
        )
        if params.method == "ordinal":
            body += f"    return frame.assign(**codes)[{out_names!r}]\n"
        else:
            body += (
                f"    bits = {{f'{{c}}_bin{{b}}': ((codes[c] // 2**b) % 2).astype('int8') "
                f"for c, count in {bits!r}.items() for b in range(count)}}\n"
                f"    return frame.assign(**bits)[{out_names!r}]\n"
            )
    elif params.method == "frequency":
        body = (
            f"{node}_freq = {{c: as_category({node}_train[c]).value_counts() / max(len({node}_train), 1) "
            f"for c in {names!r}}}\n\n\n"
            f"def {node}_encode(frame):\n"
            f"    return frame.assign(**{{c: as_category(frame[c]).map({node}_freq[c]).fillna(0.0).astype(float) "
            f"for c in {names!r}}})[{out_names!r}]\n"
        )
    else:
        target = schema.targets()[0]
        positive = _positive_class(target)
        y = (
            f"(as_category({node}_train[{target.name!r}]) == {positive!r}).astype(float)"
            if positive is not None
            else f"{node}_train[{target.name!r}].astype(float)"
        )
        body = (
            f"{node}_known = {node}_train[{node}_train[{target.name!r}].notna()]\n"
            f"{node}_y = {y.replace(f'{node}_train[', f'{node}_known[')}\n"
            f"{node}_mean = float({node}_y.mean()) if len({node}_y) else 0.0\n"
            f"{node}_maps = {{}}\n"
            f"for c in {names!r}:\n"
            f"    stats = pd.DataFrame({{'cat': as_category({node}_known[c]), 'y': {node}_y}}).dropna(subset=['cat'])\n"
            "    grouped = stats.groupby('cat')['y'].agg(['sum', 'count'])\n"
            f"    {node}_maps[c] = ((grouped['sum'] + {params.smoothing} * {node}_mean) "
            f"/ (grouped['count'] + {params.smoothing})).to_dict()\n\n\n"
            f"def {node}_encode(frame):\n"
            f"    return frame.assign(**{{c: as_category(frame[c]).map({node}_maps[c]).fillna({node}_mean).astype(float) "
            f"for c in {names!r}}})[{out_names!r}]\n"
        )
    return f"{head}{body}\n\n{out} = each_part({source}, {node}_encode)"


def _scale(step: PlanStep, ctx: _Context) -> str:
    params: Any = get_node(step.node_type).parse_params(step.params)  # type: ignore[union-attr]
    columns = [c.name for c in _scale_columns(params, _table(step, "in"))]
    node, source, out = step.node_id, ctx.source(step, "in"), ctx.var(step.node_id, "out")
    ctx.imports.add(
        "from sklearn.preprocessing import MinMaxScaler, QuantileTransformer, RobustScaler, StandardScaler"
    )
    scaler = {
        "standard": "StandardScaler()",
        "minmax": "MinMaxScaler()",
        "robust": "RobustScaler()",
        "quantile": f"QuantileTransformer(n_quantiles=min(1000, len(train_part({source}))), "
        f"random_state={_seed(step, ctx.plan)})",
    }[params.method]
    return (
        f"{node}_scaler = {scaler}.fit(train_part({source})[{columns!r}].astype(float))\n\n\n"
        f"def {node}_scale(frame):\n"
        "    scaled = frame.copy()\n"
        f"    scaled[{columns!r}] = {node}_scaler.transform(frame[{columns!r}].astype(float))\n"
        "    return scaled\n\n\n"
        f"{out} = each_part({source}, {node}_scale)"
    )


def _fit(step: PlanStep, ctx: _Context) -> str:
    params: Any = get_node(step.node_type).parse_params(step.params)  # type: ignore[union-attr]
    spec = step.output_schemas["model"].model
    assert spec is not None
    estimator = build_estimator(
        spec.algorithm, spec.task, params.hyperparameters, _seed(step, ctx.plan), params.class_weight
    )
    ctx.imports.add(f"from {_module_of(estimator)} import {type(estimator).__name__}")
    node, source = step.node_id, ctx.source(step, "train")
    label = (
        "as_category({frame}[{target!r}])"
        if spec.task == "classification"
        else "{frame}[{target!r}].astype(float)"
    )
    return (
        f"{node}_train = train_part({source}).dropna(subset=[{spec.target!r}])\n"
        f"{node}_features = {spec.features!r}\n"
        f"{ctx.var(node, 'model')} = {estimator!r}.fit(\n"
        f"    {node}_train[{node}_features].astype(float), "
        + label.format(frame=f"{node}_train", target=spec.target)
        + "\n)"
    )


def _evaluate(step: PlanStep, ctx: _Context) -> str:
    spec = step.input_schemas["model"].model
    assert spec is not None
    params = step.params
    node, model = step.node_id, ctx.source(step, "model")
    data = ctx.source(step, "data")
    metrics, predictions = ctx.var(node, "metrics"), ctx.var(node, "predictions")
    chart = ctx.var(node, "chart")
    lines = [
        f"{node}_data = pick_part({data}, {params.get('partition', 'test')!r})",
        f"{node}_X = {node}_data[{spec.features!r}].astype(float)",
        f"{node}_pred = {model}.predict({node}_X)",
        f"{node}_mask = {node}_data[{spec.target!r}].notna().to_numpy()",
    ]
    if spec.task == "classification":
        ctx.imports.add(
            "from sklearn.metrics import accuracy_score, balanced_accuracy_score, f1_score, "
            "precision_score, recall_score, roc_auc_score"
        )
        has_probability = "probability" in step.output_schemas["predictions"].require_table().names
        positive = params.get("positive_class")
        lines += [
            f"{node}_truth = as_category({node}_data[{spec.target!r}]).to_numpy()[{node}_mask]",
            f"{node}_labels = {node}_pred.astype(str)[{node}_mask]",
            f"{node}_binary = len({model}.classes_) == 2",
            f"{node}_positive = {positive!r} or (str({model}.classes_[-1]) if {node}_binary else None)",
            f"{node}_average = dict(pos_label={node}_positive, average='binary') if {node}_binary "
            "else dict(average='macro')",
            f"{metrics} = {{",
            f"    'n_samples': int({node}_mask.sum()),",
            f"    'accuracy': accuracy_score({node}_truth, {node}_labels),",
            f"    'balanced_accuracy': balanced_accuracy_score({node}_truth, {node}_labels),",
            f"    'precision': precision_score({node}_truth, {node}_labels, zero_division=0, **{node}_average),",
            f"    'recall': recall_score({node}_truth, {node}_labels, zero_division=0, **{node}_average),",
            f"    'f1': f1_score({node}_truth, {node}_labels, zero_division=0, **{node}_average),",
            "}",
            f"{predictions} = {node}_data.assign(prediction={node}_pred.astype(str))",
            f"if {node}_binary:",
            f"    {node}_proba = {model}.predict_proba({node}_X)[:, list({model}.classes_).index({node}_positive)]",
            f"    {metrics}['roc_auc'] = roc_auc_score(({node}_truth == {node}_positive).astype(int), "
            f"{node}_proba[{node}_mask])",
        ]
        if has_probability:
            lines.append(f"    {predictions} = {predictions}.assign(probability={node}_proba)")
        lines.append(
            f"{chart} = pd.crosstab(pd.Series({node}_truth, name='actual'), pd.Series({node}_labels, name='predicted'))"
        )
    else:
        ctx.imports.add("from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score")
        lines += [
            f"{node}_truth = {node}_data[{spec.target!r}].astype(float).to_numpy()[{node}_mask]",
            f"{metrics} = {{",
            f"    'n_samples': int({node}_mask.sum()),",
            f"    'r2': r2_score({node}_truth, {node}_pred[{node}_mask]),",
            f"    'mae': mean_absolute_error({node}_truth, {node}_pred[{node}_mask]),",
            f"    'rmse': math.sqrt(mean_squared_error({node}_truth, {node}_pred[{node}_mask])),",
            "}",
            f"{predictions} = {node}_data.assign(prediction={node}_pred.astype(float))",
            f"{chart} = pd.DataFrame({{'actual': {node}_truth, 'predicted': {node}_pred[{node}_mask]}})",
        ]
    lines.append(f"print({metrics})")
    return "\n".join(lines)


def _distribution(step: PlanStep, ctx: _Context) -> str:
    p = step.params
    node, source, chart = step.node_id, ctx.source(step, "in"), ctx.var(step.node_id, "out")
    ctx.uses_matplotlib = True
    column = p["column"]
    numeric = _table(step, "in").column(column)
    is_numeric = numeric is not None and numeric.is_numeric
    kind = p.get("chart", "histogram")
    lines = [
        f"{node}_values = pick_part({source}, {p.get('partition', 'train')!r})[{column!r}]",
        "figure, axis = plt.subplots(figsize=(7, 4))",
    ]
    if not is_numeric:
        lines.append(f"{node}_values.astype(str).value_counts().head(30).plot.barh(ax=axis)")
    elif kind == "box":
        lines.append(f"axis.boxplot({node}_values.dropna())")
    elif kind == "ecdf":
        lines.append(
            f"axis.step(np.sort({node}_values.dropna()), np.arange(1, {node}_values.notna().sum() + 1) "
            f"/ max({node}_values.notna().sum(), 1))"
        )
    else:
        lines.append(f"axis.hist({node}_values.dropna(), bins={p.get('bins', 30)})")
    lines += [
        f"axis.set_title('Distribution of {column}')",
        f"figure.savefig(OUTPUT_DIR / '{node}_{re.sub(r'[^A-Za-z0-9_]', '_', column)}.png', dpi=120)",
        "plt.close(figure)",
        f"{chart} = {node}_values.describe()",
        f"print({chart})",
    ]
    return "\n".join(lines)


def _export(step: PlanStep, ctx: _Context) -> str:
    p = step.params
    source = ctx.source(step, "in")
    stem = re.sub(r"\.(parquet|csv)$", "", p["path"])
    writer = "to_parquet" if p.get("format", "parquet") == "parquet" else "to_csv"
    ext = "parquet" if writer == "to_parquet" else "csv"
    return (
        f"for {step.node_id}_name, {step.node_id}_frame in "
        f"({source}.items() if isinstance({source}, dict) else [(None, {source})]):\n"
        f"    {step.node_id}_path = OUTPUT_DIR / ({stem!r} + (f'_{{{step.node_id}_name}}' "
        f"if {step.node_id}_name else '') + '.{ext}')\n"
        f"    {step.node_id}_path.parent.mkdir(parents=True, exist_ok=True)\n"
        f"    {step.node_id}_frame.{writer}({step.node_id}_path, index=False)\n"
        f"    print('wrote', {step.node_id}_path)"
    )


GENERATORS: dict[str, Callable[[PlanStep, _Context], str]] = {
    "source.dataset": _source,
    "profile.overview": _overview,
    "profile.missingness": _missingness,
    "clean.drop_columns": _drop_columns,
    "clean.impute": _impute,
    "prep.split": _split,
    "prep.encode": _encode,
    "prep.scale": _scale,
    "model.fit": _fit,
    "model.evaluate": _evaluate,
    "viz.distribution": _distribution,
    "sink.export": _export,
}


class EjectError(ValueError):
    pass


def eject_plan(
    plan: ExecutionPlan,
    dataset_paths: Mapping[str, Path],
    *,
    fmt: Format = "ipynb",
    data_dir: Path | None = None,
) -> str:
    unsupported = sorted({s.node_type for s in plan.steps} - set(GENERATORS))
    if unsupported:
        raise EjectError(f"no code template for node types: {', '.join(unsupported)}")
    directory = data_dir or (next(iter(dataset_paths.values())).parent if dataset_paths else Path("."))
    ctx = _Context(plan, {ref: path.name for ref, path in dataset_paths.items()})
    sections = [
        (
            f"{s.node_id} · {s.node_type}" + (f" — {s.label}" if s.label else ""),
            GENERATORS[s.node_type](s, ctx),
        )
        for s in plan.steps
    ]
    imports = ["import math", "from pathlib import Path", "", "import numpy as np", "import pandas as pd"]
    if ctx.uses_matplotlib:
        imports += ["import matplotlib", 'matplotlib.use("Agg")', "import matplotlib.pyplot as plt"]
    imports += sorted(ctx.imports)
    setup = (
        "\n".join(
            [
                *imports,
                "",
                f"DATA_DIR = Path({str(directory.resolve())!r})",
                'OUTPUT_DIR = Path("flowlab_outputs")',
                "OUTPUT_DIR.mkdir(parents=True, exist_ok=True)",
                f"SEED = {plan.seed}",
            ]
        )
        + HELPERS
    )
    intro = (
        f"# {plan.flow_name}\n\nEjected from FlowLab flow `{plan.flow_id}` "
        f"(spec {plan.spec_hash[:19]}…, runner {plan.runner_version}). "
        "This file is yours: FlowLab will not re-import it as the same flow."
    )
    if fmt == "py":
        parts = ["# %% [markdown]\n" + "\n".join(f"# {line}" if line else "#" for line in intro.splitlines())]
        parts.append(f"# %% Setup\n{setup}")
        parts += [f"# %% {title}\n{code}" for title, code in sections]
        return "\n\n\n".join(parts) + "\n"
    notebook = nbformat.v4.new_notebook()
    notebook.metadata["kernelspec"] = {"name": "python3", "display_name": "Python 3", "language": "python"}
    notebook.cells = [nbformat.v4.new_markdown_cell(intro), nbformat.v4.new_code_cell(setup.strip())]
    for title, code in sections:
        notebook.cells.append(nbformat.v4.new_markdown_cell(f"### {title}"))
        notebook.cells.append(nbformat.v4.new_code_cell(code))
    return str(nbformat.writes(notebook))


def eject_flow(spec: FlowSpec, data_dir: Path, *, fmt: Format = "ipynb") -> str:
    """Compile ``spec`` against the datasets in ``data_dir`` and eject it."""
    from flowlab_engine.compiler import compile_flow
    from flowlab_engine.datasets import load_schemas, resolve_dataset_paths

    paths, errors = resolve_dataset_paths(spec, data_dir)
    if errors:
        raise EjectError("; ".join(e.message for e in errors))
    result = compile_flow(spec, load_schemas(paths))
    if not result.ok or result.plan is None:
        raise EjectError(
            "the flow does not compile: " + "; ".join(f"{e.code}: {e.message}" for e in result.errors)
        )
    return eject_plan(result.plan, paths, fmt=fmt, data_dir=data_dir)


def output_ports(plan: ExecutionPlan) -> dict[str, list[str]]:
    """Variable names the ejected code uses for each node's outputs (for docs and tests)."""
    ctx = _Context(plan, {})
    return {
        s.node_id: [
            ctx.var(s.node_id, port)
            for port, schema in s.output_schemas.items()
            if schema.kind != PortType.REPORT
        ]
        for s in plan.steps
    }
