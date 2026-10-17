"""Everything you can add to a pipeline: clean steps, transforms, training-set steps and models.

Each entry carries the parameter definitions the UI turns into forms, so adding a technique here
makes it appear in the app with no frontend change. Parameter types:

``int`` / ``float`` (with ``min``/``max``/``step``), ``select`` (``options``), ``bool``, ``text``,
``columns`` (several columns or tokens such as ``@numeric``), ``column`` (one), ``parts`` (date
parts), ``layers`` (a neural network layer list).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import flowlabs_runtime as rt

Param = dict[str, Any]


def p_int(name: str, label: str, default: int, lo: int, hi: int, help: str = "", **extra: Any) -> Param:
    return {"name": name, "label": label, "type": "int", "default": default, "min": lo, "max": hi,
            "help": help, **extra}  # fmt: skip


def p_float(name: str, label: str, default: float, lo: float, hi: float, help: str = "", **extra: Any) -> Param:
    return {"name": name, "label": label, "type": "float", "default": default, "min": lo, "max": hi,
            "help": help, **extra}  # fmt: skip


def p_select(name: str, label: str, default: Any, options: list[tuple[Any, str]], help: str = "") -> Param:
    return {"name": name, "label": label, "type": "select", "default": default,
            "options": [{"value": v, "label": lab} for v, lab in options], "help": help}  # fmt: skip


def p_bool(name: str, label: str, default: bool, help: str = "") -> Param:
    return {"name": name, "label": label, "type": "bool", "default": default, "help": help}


def p_columns(name: str, label: str, default: list[str], help: str = "", kinds: list[str] | None = None) -> Param:
    return {"name": name, "label": label, "type": "columns", "default": default, "help": help, "kinds": kinds or []}


def p_column(name: str, label: str, help: str = "", kinds: list[str] | None = None) -> Param:
    return {"name": name, "label": label, "type": "column", "default": None, "help": help, "kinds": kinds or []}


def p_text(name: str, label: str, default: str = "", help: str = "") -> Param:
    return {"name": name, "label": label, "type": "text", "default": default, "help": help}


def p_code(name: str, label: str, default: str, help: str = "", needs: tuple[str, ...] = ()) -> Param:
    """Python source edited in a code editor. ``needs``: names the code must define."""
    return {"name": name, "label": label, "type": "code", "default": default, "help": help, "needs": list(needs)}


CLEAN_CODE = '''def clean(df):
    """df is the whole table as a pandas DataFrame. Return the cleaned table.

    pd (pandas), np (NumPy) and math are ready to use.
    """
    df = df.copy()
    # for example: df["price"] = df["price"].clip(lower=0)
    return df
'''

ROWS_CODE = '''def rows(X, y):
    """Change the training rows only. Test rows never pass through here, so scores stay honest.

    X holds the input columns, y the target (class numbers for classification).
    clean(X) gives X after the Clean steps. Return X, y.
    """
    return X, y
'''

TRANSFORM_CODE = '''# Either use any scikit-learn transformer:
#     from sklearn.preprocessing import StandardScaler
#     transformer = StandardScaler()
# or write fit and transform yourself:


def fit(X, y):
    """Learn from the training rows. Whatever you return is passed to transform."""
    return X.median(numeric_only=True)


def transform(X, state):
    """Runs on training rows, test rows and new data. Return the new table, with every row."""
    return X.fillna(state)
'''

MODEL_CODE = {
    "classification": """# Any model with fit() and predict(): scikit-learn, XGBoost, LightGBM,
# or the neural networks in flowlabs_runtime.
from sklearn.ensemble import RandomForestClassifier

model = RandomForestClassifier(n_estimators=300, min_samples_leaf=2, random_state=0)
""",
    "regression": """# Any model with fit() and predict(): scikit-learn, XGBoost, LightGBM,
# or the neural networks in flowlabs_runtime.
from sklearn.ensemble import RandomForestRegressor

model = RandomForestRegressor(n_estimators=300, min_samples_leaf=2, random_state=0)
""",
}


@dataclass(frozen=True)
class Op:
    """A step in the Clean, Training-set or Transform stage."""

    id: str
    stage: str  # clean | rows | transform
    group: str
    label: str
    description: str
    params: list[Param] = field(default_factory=list)
    rows: bool = False  # removes or adds rows (training data only)
    build: Callable[[dict[str, Any]], Any] | None = None  # transform stage: params -> transformer

    def as_dict(self) -> dict[str, Any]:
        return {"id": self.id, "stage": self.stage, "group": self.group, "label": self.label,
                "description": self.description, "params": self.params, "rows": self.rows}  # fmt: skip


# ------------------------------------------------------------------------------------- clean
COMPARE = [("==", "equals"), ("!=", "does not equal"), (">", "greater than"), (">=", "at least"),
           ("<", "less than"), ("<=", "at most"), ("contains", "contains"), ("not contains", "does not contain"),
           ("is missing", "is missing"), ("is not missing", "is not missing")]  # fmt: skip

CLEAN_OPS = [
    Op("drop_columns", "clean", "Columns", "Drop columns",
       "Remove columns the model should not see: IDs, free-text notes, or anything that leaks the answer.",
       [p_columns("columns", "Columns to drop", [])]),
    Op("change_type", "clean", "Columns", "Change type",
       "Treat columns as numbers, categories, dates or yes/no. Text such as \"$1,200\" becomes 1200.",
       [p_columns("columns", "Columns", []),
        p_select("to", "Treat as", "numeric", [("numeric", "Number"), ("category", "Category"),
                                               ("datetime", "Date"), ("boolean", "Yes / no")])]),
    Op("clean_text", "clean", "Columns", "Tidy text",
       "Trim spaces and make capitalisation consistent, so \"New York \" and \"new york\" are one category.",
       [p_columns("columns", "Columns", ["@categorical"], kinds=["categorical", "text"]),
        p_select("case", "Letter case", "lower", [("lower", "lower case"), ("upper", "UPPER CASE"),
                                                  ("title", "Title Case"), ("keep", "keep as is")]),
        p_bool("strip", "Trim extra spaces", True)]),
    Op("replace_values", "clean", "Columns", "Replace a value",
       "Swap one value for another in a column, e.g. \"N/A\" for a missing value (leave Replace with empty).",
       [p_column("column", "Column"), p_text("find", "Find"), p_text("replace", "Replace with")]),
    Op("extract_datetime", "clean", "Features", "Date parts",
       "Turn a date column into year, month, weekday, hour and more. Models cannot read raw dates.",
       [p_columns("columns", "Date columns", [], kinds=["datetime"]),
        {"name": "parts", "label": "Parts", "type": "parts", "default": ["year", "month", "weekday"],
         "options": [{"value": v, "label": v.replace("_", " ")} for v in rt.DATE_PARTS], "help": ""},
        p_bool("drop_original", "Drop the original column", True)]),
    Op("combine_columns", "clean", "Features", "Combine two columns",
       "Create a new feature from two numbers: ratio, difference, sum or product.",
       [p_column("a", "First column", kinds=["numeric"]),
        p_select("operation", "Operation", "divide", [("divide", "A ÷ B"), ("subtract", "A − B"),
                                                       ("add", "A + B"), ("multiply", "A × B")]),
        p_column("b", "Second column", kinds=["numeric"]), p_text("name", "New column name")]),
    Op("drop_duplicates", "clean", "Rows", "Remove duplicate rows",
       "Drop rows that repeat exactly (or repeat in the chosen columns).",
       [p_columns("columns", "Compare only these columns (empty = all)", [])], rows=True),
    Op("drop_missing_rows", "clean", "Rows", "Remove rows with gaps",
       "Drop rows that have missing values in the chosen columns.",
       [p_columns("columns", "Columns", ["@all"]),
        p_select("how", "Drop when", "any", [("any", "any of them is missing"), ("all", "all of them are missing")])],
       rows=True),
    Op("filter_rows", "clean", "Rows", "Filter rows",
       "Keep only rows that match a condition, e.g. country equals \"DE\".",
       [p_column("column", "Column"), p_select("operator", "Keep rows where", "==", COMPARE), p_text("value", "Value")],
       rows=True),
    Op("sample_rows", "clean", "Rows", "Use a sample",
       "Train on a random subset of rows. Handy for a quick first look at a very large file.",
       [p_int("rows", "Rows to keep", 10000, 10, 10_000_000), p_int("seed", "Random seed", 0, 0, 99999)], rows=True),
    Op("custom_clean", "clean", "Code", "Python code",
       "Write your own cleaning in pandas. It runs on the whole table, and on new data when predicting.",
       [p_code("code", "Code", CLEAN_CODE, needs=("clean",)),
        p_bool("training_only", "Only while training (for code that removes rows)", False)]),
]  # fmt: skip

# ------------------------------------------------------------------------- training-set steps
ROW_OPS = [
    Op("remove_outliers", "rows", "Outliers", "Remove outlier rows",
       "Drop training rows with extreme numbers. Test rows are never removed, so scores stay honest.",
       [p_columns("columns", "Columns", ["@numeric"], kinds=["numeric"]),
        p_select("method", "Method", "iqr", [("iqr", "IQR fences"), ("zscore", "Z-score"),
                                             ("isolation_forest", "Isolation forest")]),
        p_float("threshold", "Strictness (IQR factor or z)", 3.0, 1.0, 10.0, step=0.5),
        p_float("contamination", "Share to drop (isolation forest)", 0.02, 0.001, 0.3, step=0.005)],
       rows=True),
    Op("balance_classes", "rows", "Class balance", "Balance classes",
       "Even out rare classes in the training rows by repeating them or trimming common ones.",
       [p_select("method", "Method", "oversample", [("oversample", "Repeat rare classes"),
                                                    ("undersample", "Trim common classes"),
                                                    ("class_weight", "Weight rare classes (no new rows)"),
                                                    ("smote", "SMOTE (synthetic rows, numbers only)")])],
       rows=True),
    Op("custom_rows", "rows", "Code", "Python code",
       "Add, remove or reweight training rows with your own code.",
       [p_code("code", "Code", ROWS_CODE, needs=("rows",))], rows=True),
]  # fmt: skip


# --------------------------------------------------------------------------------- transforms
def _imputer(p: dict[str, Any]) -> Any:
    from sklearn.impute import KNNImputer, SimpleImputer

    if p.get("strategy") == "knn":
        return KNNImputer(n_neighbors=int(p.get("neighbors", 5)), add_indicator=bool(p.get("indicator")))
    if p.get("strategy") == "constant":
        value: Any = p.get("fill_value", "0")
        try:
            value = float(value)
        except (TypeError, ValueError):
            pass
        return SimpleImputer(strategy="constant", fill_value=value, add_indicator=bool(p.get("indicator")))
    return SimpleImputer(strategy=p.get("strategy", "median"), add_indicator=bool(p.get("indicator")))


def _encoder(p: dict[str, Any]) -> Any:
    from sklearn.preprocessing import OneHotEncoder, OrdinalEncoder, TargetEncoder

    method = p.get("method", "onehot")
    if method == "ordinal":
        return OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1, encoded_missing_value=-1)
    if method == "frequency":
        return rt.FrequencyEncoder()
    if method == "target":
        return TargetEncoder(random_state=0)
    return OneHotEncoder(
        handle_unknown="infrequent_if_exist",
        sparse_output=False,
        max_categories=int(p.get("max_categories", 20)) or None,
        drop="if_binary" if p.get("drop_binary", True) else None,
    )


def _scaler(p: dict[str, Any]) -> Any:
    from sklearn.preprocessing import MaxAbsScaler, MinMaxScaler, RobustScaler, StandardScaler

    return {"minmax": MinMaxScaler, "robust": RobustScaler, "maxabs": MaxAbsScaler}.get(
        p.get("method", "standard"), StandardScaler
    )()


def _power(p: dict[str, Any]) -> Any:
    from sklearn.preprocessing import PowerTransformer, QuantileTransformer

    method = p.get("method", "yeo-johnson")
    if method == "log":
        return rt.SignedLog()
    if method in ("quantile-normal", "quantile-uniform"):
        return QuantileTransformer(output_distribution=method.split("-")[1], n_quantiles=200, random_state=0)
    return PowerTransformer(method=method)


def _discretize(p: dict[str, Any]) -> Any:
    from sklearn.preprocessing import KBinsDiscretizer

    return KBinsDiscretizer(n_bins=int(p.get("bins", 5)), encode="ordinal", strategy=p.get("strategy", "quantile"))


def _poly(p: dict[str, Any]) -> Any:
    from sklearn.preprocessing import PolynomialFeatures

    return PolynomialFeatures(degree=int(p.get("degree", 2)), interaction_only=bool(p.get("interaction_only")),
                              include_bias=False)  # fmt: skip


def _select_k(p: dict[str, Any]) -> Any:
    from sklearn.feature_selection import SelectKBest, f_classif, f_regression, mutual_info_classif

    scores = {"f_classif": f_classif, "f_regression": f_regression, "mutual_info": mutual_info_classif}
    return SelectKBest(scores.get(p.get("score", "f_classif"), f_classif), k=int(p.get("k", 10)))


def _variance(p: dict[str, Any]) -> Any:
    from sklearn.feature_selection import VarianceThreshold

    return VarianceThreshold(threshold=float(p.get("threshold", 0.0)))


def _pca(p: dict[str, Any]) -> Any:
    from sklearn.decomposition import PCA

    keep = float(p.get("components", 0.95))
    return PCA(n_components=int(keep) if keep >= 1 else keep, random_state=0)


TRANSFORM_OPS = [
    Op("impute", "transform", "Missing values", "Fill missing values",
       "Fill gaps with the median, mean, most common value, a constant, or similar rows (KNN). Learned "
       "from training rows only.",
       [p_columns("columns", "Columns", ["@numeric"]),
        p_select("strategy", "Fill with", "median", [("median", "Median"), ("mean", "Mean"),
                                                     ("most_frequent", "Most common value"),
                                                     ("constant", "A constant"), ("knn", "Similar rows (KNN)")]),
        p_text("fill_value", "Constant (when Fill with = constant)", "0"),
        p_int("neighbors", "Neighbours (KNN)", 5, 1, 50),
        p_bool("indicator", "Add a \"was missing\" column", False)], build=_imputer),
    Op("encode", "transform", "Categories", "Encode categories",
       "Turn categories into numbers: one column per value, a number per value, how common each value is, "
       "or the average target per value.",
       [p_columns("columns", "Columns", ["@categorical"], kinds=["categorical", "boolean"]),
        p_select("method", "Method", "onehot", [("onehot", "One-hot"), ("ordinal", "Ordinal"),
                                               ("frequency", "Frequency"), ("target", "Target encoding")]),
        p_int("max_categories", "Max columns per feature (one-hot)", 20, 2, 200),
        p_bool("drop_binary", "One column for two-value features", True)], build=_encoder),
    Op("scale", "transform", "Scaling", "Scale numbers",
       "Put numbers on a similar range. Linear models, SVMs, k-NN and neural networks need it; trees do not.",
       [p_columns("columns", "Columns", ["@numeric"], kinds=["numeric"]),
        p_select("method", "Method", "standard", [("standard", "Standard (mean 0, sd 1)"), ("minmax", "Min-max (0 to 1)"),
                                                  ("robust", "Robust (median / IQR)"), ("maxabs", "Max-abs (−1 to 1)")])],
       build=_scaler),
    Op("power", "transform", "Distribution", "Fix skewed numbers",
       "Make long-tailed numbers (income, prices, counts) more bell-shaped.",
       [p_columns("columns", "Columns", ["@numeric"], kinds=["numeric"]),
        p_select("method", "Method", "yeo-johnson", [("yeo-johnson", "Yeo-Johnson"), ("box-cox", "Box-Cox (positive only)"),
                                                     ("log", "Log"), ("quantile-normal", "Quantile → normal"),
                                                     ("quantile-uniform", "Quantile → uniform")])],
       build=_power),
    Op("clip_outliers", "transform", "Distribution", "Cap outliers",
       "Limit extreme values to fences learned from training rows. Keeps every row, unlike removing outliers.",
       [p_columns("columns", "Columns", ["@numeric"], kinds=["numeric"]),
        p_select("method", "Limits", "iqr", [("iqr", "IQR fences"), ("percentile", "Percentiles")]),
        p_float("factor", "IQR factor", 1.5, 0.5, 10, step=0.5),
        p_float("lower", "Lower percentile", 1, 0, 49), p_float("upper", "Upper percentile", 99, 51, 100)],
       build=lambda p: rt.OutlierClipper(p.get("method", "iqr"), float(p.get("factor", 1.5)),
                                         float(p.get("lower", 1)), float(p.get("upper", 99)))),
    Op("discretize", "transform", "Distribution", "Bin numbers",
       "Group a number into bins (e.g. age bands).",
       [p_columns("columns", "Columns", [], kinds=["numeric"]), p_int("bins", "Bins", 5, 2, 50),
        p_select("strategy", "Bin edges", "quantile", [("quantile", "Equal counts"), ("uniform", "Equal width"),
                                                       ("kmeans", "Clusters")])], build=_discretize),
    Op("polynomial", "transform", "Feature engineering", "Interactions",
       "Add products of numeric features (x·y, x²) so simple models can learn curves and interactions.",
       [p_columns("columns", "Columns", ["@numeric"], kinds=["numeric"]), p_int("degree", "Degree", 2, 2, 3),
        p_bool("interaction_only", "Products only (no squares)", False)], build=_poly),
    Op("text_vectorize", "transform", "Feature engineering", "Text to features",
       "Turn free text into word-importance features (TF-IDF).",
       [p_columns("columns", "Text columns", ["@text"], kinds=["text", "categorical"]),
        p_int("max_features", "Max words", 300, 10, 5000), p_int("ngram_max", "Word groups up to", 1, 1, 3)],
       build=lambda p: rt.TextVectorizer(int(p.get("max_features", 300)), int(p.get("ngram_max", 1)))),
    Op("select_k_best", "transform", "Selection", "Keep the best features",
       "Keep the k features most related to the target.",
       [p_columns("columns", "Columns", ["@numeric"], kinds=["numeric"]), p_int("k", "Features to keep", 10, 1, 500),
        p_select("score", "Score", "f_classif", [("f_classif", "ANOVA F (classification)"),
                                                 ("f_regression", "F (regression)"), ("mutual_info", "Mutual information")])],
       build=_select_k),
    Op("variance_filter", "transform", "Selection", "Drop near-constant",
       "Remove numeric columns that barely change.",
       [p_columns("columns", "Columns", ["@numeric"], kinds=["numeric"]), p_float("threshold", "Min variance", 0.0, 0, 100)],
       build=_variance),
    Op("drop_correlated", "transform", "Selection", "Drop correlated",
       "Remove one column of every highly correlated pair.",
       [p_columns("columns", "Columns", ["@numeric"], kinds=["numeric"]),
        p_float("threshold", "Correlation above", 0.95, 0.5, 1.0, step=0.01)],
       build=lambda p: rt.DropCorrelated(float(p.get("threshold", 0.95)))),
    Op("pca", "transform", "Selection", "PCA",
       "Compress many numeric columns into fewer components. Below 1 keeps that share of variance.",
       [p_columns("columns", "Columns", ["@numeric"], kinds=["numeric"]),
        p_float("components", "Components (or variance share)", 0.95, 0.5, 500, step=0.05)], build=_pca),
    Op("custom_transform", "transform", "Code", "Python code",
       "Your own transform, learned from training rows only: a scikit-learn transformer or fit and transform "
       "functions.",
       [p_columns("columns", "Columns", ["@all"]),
        p_code("code", "Code", TRANSFORM_CODE, needs=("transform", "transformer"))],
       build=lambda p: rt.CodeTransformer(p.get("code") or "")),
]  # fmt: skip

OPS: dict[str, Op] = {op.id: op for op in [*CLEAN_OPS, *ROW_OPS, *TRANSFORM_OPS]}


# ------------------------------------------------------------------------------------- models
@dataclass(frozen=True)
class Algo:
    id: str
    label: str
    tasks: tuple[str, ...]
    family: str
    description: str
    params: list[Param]
    build: Callable[[str, dict[str, Any], dict[str, Any]], Any]
    search: dict[str, Any] = field(default_factory=dict)  # parameter -> list of values to try
    needs: str | None = None  # optional package
    needs_scaling: bool = False
    deep: bool = False

    def as_dict(self, available: bool) -> dict[str, Any]:
        return {"id": self.id, "label": self.label, "tasks": list(self.tasks), "family": self.family,
                "description": self.description, "params": self.params, "needs": self.needs,
                "available": available, "needs_scaling": self.needs_scaling, "deep": self.deep,
                "tunable": bool(self.search)}  # fmt: skip


def _depth(p: dict[str, Any], key: str = "max_depth") -> int | None:
    value = int(p.get(key) or 0)
    return value or None


def _cw(ctx: dict[str, Any]) -> str | None:
    return "balanced" if ctx.get("class_weight") else None


def _logistic(task: str, p: dict[str, Any], ctx: dict[str, Any]) -> Any:
    from sklearn.linear_model import LogisticRegression

    return LogisticRegression(C=float(p.get("C", 1.0)), max_iter=int(p.get("max_iter", 1000)), class_weight=_cw(ctx))


def _linear(task: str, p: dict[str, Any], ctx: dict[str, Any]) -> Any:
    from sklearn.linear_model import ElasticNet, Lasso, LinearRegression, Ridge

    kind = p.get("penalty", "ridge")
    alpha = float(p.get("alpha", 1.0))
    if kind == "none":
        return LinearRegression()
    if kind == "lasso":
        return Lasso(alpha=alpha, max_iter=5000)
    if kind == "elasticnet":
        return ElasticNet(alpha=alpha, l1_ratio=float(p.get("l1_ratio", 0.5)), max_iter=5000)
    return Ridge(alpha=alpha)


def _tree(task: str, p: dict[str, Any], ctx: dict[str, Any]) -> Any:
    from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor

    common = {"max_depth": _depth(p), "min_samples_leaf": int(p.get("min_samples_leaf", 1)), "random_state": 0}
    if task == "classification":
        return DecisionTreeClassifier(class_weight=_cw(ctx), **common)
    return DecisionTreeRegressor(**common)


def _forest(kind: str) -> Callable[[str, dict[str, Any], dict[str, Any]], Any]:
    def build(task: str, p: dict[str, Any], ctx: dict[str, Any]) -> Any:
        from sklearn import ensemble

        name = ("RandomForest" if kind == "rf" else "ExtraTrees") + (
            "Classifier" if task == "classification" else "Regressor"
        )
        cls = getattr(ensemble, name)
        features = p.get("max_features", "sqrt")
        common = {"n_estimators": int(p.get("n_estimators", 200)), "max_depth": _depth(p),
                  "min_samples_leaf": int(p.get("min_samples_leaf", 1)), "n_jobs": ctx.get("n_jobs", -1),
                  "random_state": 0, "max_features": None if features == "all" else features}  # fmt: skip
        if task == "classification":
            common["class_weight"] = _cw(ctx)
        return cls(**common)

    return build


def _hgb(task: str, p: dict[str, Any], ctx: dict[str, Any]) -> Any:
    from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor

    common = {"max_iter": int(p.get("max_iter", 200)), "learning_rate": float(p.get("learning_rate", 0.1)),
              "max_leaf_nodes": int(p.get("max_leaf_nodes", 31)), "l2_regularization": float(p.get("l2", 0.0)),
              "early_stopping": "auto", "random_state": 0}  # fmt: skip
    if task == "classification":
        return HistGradientBoostingClassifier(class_weight=_cw(ctx), **common)
    return HistGradientBoostingRegressor(**common)


def _gb(task: str, p: dict[str, Any], ctx: dict[str, Any]) -> Any:
    from sklearn.ensemble import GradientBoostingClassifier, GradientBoostingRegressor

    common = {
        "n_estimators": int(p.get("n_estimators", 150)),
        "learning_rate": float(p.get("learning_rate", 0.1)),
        "max_depth": int(p.get("max_depth", 3)),
        "subsample": float(p.get("subsample", 1.0)),
        "random_state": 0,
    }
    return (GradientBoostingClassifier if task == "classification" else GradientBoostingRegressor)(**common)


def _svm(task: str, p: dict[str, Any], ctx: dict[str, Any]) -> Any:
    from sklearn.svm import SVC, SVR

    kernel, C = p.get("kernel", "rbf"), float(p.get("C", 1.0))
    if task == "classification":
        return SVC(C=C, kernel=kernel, gamma="scale", probability=True, class_weight=_cw(ctx), random_state=0)
    return SVR(C=C, kernel=kernel, gamma="scale")


def _knn(task: str, p: dict[str, Any], ctx: dict[str, Any]) -> Any:
    from sklearn.neighbors import KNeighborsClassifier, KNeighborsRegressor

    cls = KNeighborsClassifier if task == "classification" else KNeighborsRegressor
    return cls(n_neighbors=int(p.get("n_neighbors", 5)), weights=p.get("weights", "uniform"))


def _nb(task: str, p: dict[str, Any], ctx: dict[str, Any]) -> Any:
    from sklearn.naive_bayes import GaussianNB

    return GaussianNB(var_smoothing=float(p.get("var_smoothing", 1e-9)))


def _adaboost(task: str, p: dict[str, Any], ctx: dict[str, Any]) -> Any:
    from sklearn.ensemble import AdaBoostClassifier, AdaBoostRegressor

    cls = AdaBoostClassifier if task == "classification" else AdaBoostRegressor
    return cls(n_estimators=int(p.get("n_estimators", 100)), learning_rate=float(p.get("learning_rate", 0.5)),
               random_state=0)  # fmt: skip


def _xgb(task: str, p: dict[str, Any], ctx: dict[str, Any]) -> Any:
    import xgboost

    common = {
        "n_estimators": int(p.get("n_estimators", 300)),
        "learning_rate": float(p.get("learning_rate", 0.1)),
        "max_depth": int(p.get("max_depth", 6)),
        "subsample": float(p.get("subsample", 1.0)),
        "colsample_bytree": float(p.get("colsample", 1.0)),
        "random_state": 0,
        "n_jobs": ctx.get("n_jobs", -1),
    }
    if ctx.get("device") == "cuda":
        common["device"] = "cuda"
    return (xgboost.XGBClassifier if task == "classification" else xgboost.XGBRegressor)(**common)


def _lgbm(task: str, p: dict[str, Any], ctx: dict[str, Any]) -> Any:
    import lightgbm

    common = {"n_estimators": int(p.get("n_estimators", 300)), "learning_rate": float(p.get("learning_rate", 0.1)),
              "num_leaves": int(p.get("num_leaves", 31)), "subsample": float(p.get("subsample", 1.0)),
              "random_state": 0, "verbose": -1, "n_jobs": ctx.get("n_jobs", -1)}  # fmt: skip
    if task == "classification":
        return lightgbm.LGBMClassifier(class_weight=_cw(ctx), **common)
    return lightgbm.LGBMRegressor(**common)


def _nn(task: str, p: dict[str, Any], ctx: dict[str, Any]) -> Any:
    cls = rt.NeuralNetClassifier if task == "classification" else rt.NeuralNetRegressor
    return cls(
        layers=p.get("layers"),
        epochs=int(p.get("epochs", 60)),
        batch_size=int(p.get("batch_size", 64)),
        learning_rate=float(p.get("learning_rate", 0.001)),
        optimizer=p.get("optimizer", "adam"),
        weight_decay=float(p.get("weight_decay", 0.0)),
        patience=int(p.get("patience", 8)),
        val_fraction=float(p.get("val_fraction", 0.1)),
        class_weight="balanced" if ctx.get("class_weight") else None,
        backend=p.get("backend", "auto"),
        device=p.get("device", "auto"),
    )


def _custom_model(task: str, p: dict[str, Any], ctx: dict[str, Any]) -> Any:
    return rt.code_model(p.get("code") or "")


def _baseline(task: str, p: dict[str, Any], ctx: dict[str, Any]) -> Any:
    from sklearn.dummy import DummyClassifier, DummyRegressor

    if task == "classification":
        return DummyClassifier(strategy="prior")
    return DummyRegressor(strategy="mean")


N_EST = p_int("n_estimators", "Trees", 200, 10, 3000, "More trees: steadier, slower.")
DEPTH = p_int("max_depth", "Max depth (0 = no limit)", 0, 0, 100, "Shallower trees overfit less.")
LEAF = p_int("min_samples_leaf", "Min rows per leaf", 1, 1, 500, "Higher values smooth the model.")
LR = p_float(
    "learning_rate", "Learning rate", 0.1, 0.001, 1.0, "Smaller is slower but often better.", step=0.01, log=True
)

NN_LAYERS: Param = {
    "name": "layers", "label": "Layers", "type": "layers", "help": "Hidden layers, input to output. The output "
    "layer is added for you.",
    "default": [{"type": "dense", "units": 64, "activation": "relu"}, {"type": "dropout", "rate": 0.1},
                {"type": "dense", "units": 32, "activation": "relu"}],
    "layer_types": ["dense", "dropout", "batchnorm"], "activations": list(rt.ACTIVATIONS),
}  # fmt: skip

NN_TRAINING: list[Param] = [
    p_int("epochs", "Epochs", 60, 1, 2000, "Full passes over the training rows."),
    p_int("batch_size", "Batch size", 64, 1, 8192),
    p_float("learning_rate", "Learning rate", 0.001, 0.00001, 1.0, step=0.0001, log=True),
    p_select("optimizer", "Optimizer", "adam", [("adam", "Adam"), ("adamw", "AdamW"), ("sgd", "SGD + momentum"),
                                                ("rmsprop", "RMSprop (PyTorch)")]),
    p_float("weight_decay", "Weight decay", 0.0, 0.0, 0.1, step=0.0001),
    p_int("patience", "Early stopping patience (0 = off)", 8, 0, 200, "Stop when validation loss stops improving."),
    p_float("val_fraction", "Validation share of training rows", 0.1, 0.0, 0.4, step=0.05),
    p_select("backend", "Train with", "auto", [("auto", "PyTorch if installed, else NumPy"),
                                               ("torch", "PyTorch"), ("numpy", "NumPy (works everywhere)")]),
    p_select("device", "Device", "auto", [("auto", "Best available (GPU first)"), ("cpu", "CPU"),
                                          ("cuda", "NVIDIA GPU (CUDA)"), ("mps", "Apple GPU (MPS)")]),
]  # fmt: skip

ALGOS = [
    Algo("baseline", "Baseline (guess)", ("classification", "regression"), "Reference",
         "Always predicts the most common class or the average. Any useful model must beat it.", [], _baseline),
    Algo("logistic_regression", "Logistic regression", ("classification",), "Linear",
         "Fast, explainable linear classifier. A strong first model.",
         [p_float("C", "Inverse regularization (C)", 1.0, 0.0001, 1000, "Smaller = simpler model.", log=True),
          p_int("max_iter", "Max iterations", 1000, 50, 20000)], _logistic,
         search={"C": [0.01, 0.1, 0.3, 1, 3, 10, 30]}, needs_scaling=True),
    Algo("linear_regression", "Linear regression", ("regression",), "Linear",
         "Fits a straight-line relationship. Choose a penalty to keep weights small.",
         [p_select("penalty", "Penalty", "ridge", [("none", "None (ordinary least squares)"), ("ridge", "Ridge (L2)"),
                                                   ("lasso", "Lasso (L1)"), ("elasticnet", "Elastic net")]),
          p_float("alpha", "Penalty strength", 1.0, 0.0001, 1000, log=True),
          p_float("l1_ratio", "L1 share (elastic net)", 0.5, 0.0, 1.0, step=0.05)], _linear,
         search={"alpha": [0.001, 0.01, 0.1, 1, 10, 100]}, needs_scaling=True),
    Algo("decision_tree", "Decision tree", ("classification", "regression"), "Trees",
         "A flowchart of yes/no questions. Easy to read, prone to overfitting.", [DEPTH, LEAF], _tree,
         search={"max_depth": [3, 5, 8, 12, 0], "min_samples_leaf": [1, 5, 20]}),
    Algo("random_forest", "Random forest", ("classification", "regression"), "Trees",
         "Many trees voting together. Robust and accurate with little tuning.",
         [N_EST, DEPTH, LEAF, p_select("max_features", "Features per split", "sqrt",
                                       [("sqrt", "√ of features"), ("log2", "log₂ of features"), ("all", "All")])],
         _forest("rf"), search={"n_estimators": [100, 300, 600], "max_depth": [0, 8, 16], "min_samples_leaf": [1, 3, 10]}),
    Algo("extra_trees", "Extra trees", ("classification", "regression"), "Trees",
         "Like a random forest with more randomness: often faster and just as good.",
         [N_EST, DEPTH, LEAF, p_select("max_features", "Features per split", "sqrt",
                                       [("sqrt", "√ of features"), ("log2", "log₂ of features"), ("all", "All")])],
         _forest("et"), search={"n_estimators": [100, 300, 600], "max_depth": [0, 8, 16], "min_samples_leaf": [1, 3, 10]}),
    Algo("hist_gradient_boosting", "Gradient boosting (fast)", ("classification", "regression"), "Boosting",
         "Histogram gradient boosting: excellent on tables, handles large data quickly.",
         [p_int("max_iter", "Boosting rounds", 200, 10, 5000), LR, p_int("max_leaf_nodes", "Leaves per tree", 31, 2, 512),
          p_float("l2", "L2 regularization", 0.0, 0.0, 100.0, step=0.1)], _hgb,
         search={"learning_rate": [0.03, 0.1, 0.2], "max_leaf_nodes": [15, 31, 63], "l2": [0, 0.1, 1]}),
    Algo("gradient_boosting", "Gradient boosting", ("classification", "regression"), "Boosting",
         "Classic gradient boosted trees. Accurate on small and medium tables.",
         [p_int("n_estimators", "Boosting rounds", 150, 10, 3000), LR, p_int("max_depth", "Tree depth", 3, 1, 12),
          p_float("subsample", "Row share per tree", 1.0, 0.3, 1.0, step=0.05)], _gb,
         search={"n_estimators": [100, 300], "learning_rate": [0.05, 0.1, 0.2], "max_depth": [2, 3, 5]}),
    Algo("xgboost", "XGBoost", ("classification", "regression"), "Boosting",
         "Popular competition-winning gradient boosting. Uses the GPU when one is available.",
         [p_int("n_estimators", "Boosting rounds", 300, 10, 5000), LR, p_int("max_depth", "Tree depth", 6, 1, 16),
          p_float("subsample", "Row share per tree", 1.0, 0.3, 1.0, step=0.05),
          p_float("colsample", "Column share per tree", 1.0, 0.3, 1.0, step=0.05)], _xgb,
         search={"learning_rate": [0.03, 0.1, 0.2], "max_depth": [3, 6, 9], "subsample": [0.7, 1.0]}, needs="xgboost"),
    Algo("lightgbm", "LightGBM", ("classification", "regression"), "Boosting",
         "Very fast gradient boosting for large tables.",
         [p_int("n_estimators", "Boosting rounds", 300, 10, 5000), LR, p_int("num_leaves", "Leaves per tree", 31, 2, 512),
          p_float("subsample", "Row share per tree", 1.0, 0.3, 1.0, step=0.05)], _lgbm,
         search={"learning_rate": [0.03, 0.1, 0.2], "num_leaves": [15, 31, 63]}, needs="lightgbm"),
    Algo("svm", "Support vector machine", ("classification", "regression"), "Kernel",
         "Finds the widest margin between classes. Great on small, scaled data; slow on big data.",
         [p_float("C", "C", 1.0, 0.001, 1000, log=True),
          p_select("kernel", "Kernel", "rbf", [("rbf", "RBF"), ("linear", "Linear"), ("poly", "Polynomial")])], _svm,
         search={"C": [0.1, 1, 10, 100], "kernel": ["rbf", "linear"]}, needs_scaling=True),
    Algo("knn", "k-nearest neighbours", ("classification", "regression"), "Instance",
         "Predicts from the most similar training rows.",
         [p_int("n_neighbors", "Neighbours", 5, 1, 200),
          p_select("weights", "Weighting", "uniform", [("uniform", "Equal"), ("distance", "Closer counts more")])], _knn,
         search={"n_neighbors": [3, 5, 9, 15, 25], "weights": ["uniform", "distance"]}, needs_scaling=True),
    Algo("naive_bayes", "Naive Bayes", ("classification",), "Probabilistic",
         "Very fast probabilistic classifier; a quick baseline.",
         [p_float("var_smoothing", "Smoothing", 1e-9, 1e-12, 1.0, log=True)], _nb),
    Algo("adaboost", "AdaBoost", ("classification", "regression"), "Boosting",
         "Boosts many small trees, each fixing the last one's mistakes.",
         [p_int("n_estimators", "Rounds", 100, 10, 2000), p_float("learning_rate", "Learning rate", 0.5, 0.01, 2.0, step=0.05)],
         _adaboost, search={"n_estimators": [50, 100, 300], "learning_rate": [0.1, 0.5, 1.0]}),
    Algo("neural_network", "Neural network", ("classification", "regression"), "Deep learning",
         "A network you design layer by layer. Trains on the GPU with PyTorch when available, NumPy otherwise.",
         [NN_LAYERS, *NN_TRAINING], _nn, needs_scaling=True, deep=True),
    Algo("custom_model", "Python model", ("classification", "regression"), "Code",
         "Write the model yourself: any model with fit and predict, with your own settings.",
         [p_code("code", "Code", MODEL_CODE["classification"], needs=("model",))], _custom_model),
]  # fmt: skip

ALGO_BY_ID: dict[str, Algo] = {a.id: a for a in ALGOS}

# --------------------------------------------------------------------------------- image models
IMAGE_LAYERS: Param = {
    "name": "layers", "label": "Layers", "type": "layers", "help": "Convolution blocks first, then dense layers. "
    "The flatten and output layers are added for you.",
    "default": [{"type": "conv", "filters": 32, "kernel": 3, "activation": "relu"}, {"type": "maxpool", "size": 2},
                {"type": "conv", "filters": 64, "kernel": 3, "activation": "relu"}, {"type": "maxpool", "size": 2},
                {"type": "dropout", "rate": 0.25}, {"type": "dense", "units": 128, "activation": "relu"}],
    "layer_types": ["conv", "maxpool", "avgpool", "batchnorm", "dropout", "dense"], "activations": list(rt.ACTIVATIONS),
}  # fmt: skip

IMAGE_TRAINING: list[Param] = [
    p_int("epochs", "Epochs", 15, 1, 500),
    p_int("batch_size", "Batch size", 32, 1, 1024),
    p_float("learning_rate", "Learning rate", 0.001, 0.00001, 1.0, step=0.0001, log=True),
    p_select("optimizer", "Optimizer", "adam", [("adam", "Adam"), ("adamw", "AdamW"), ("sgd", "SGD + momentum")]),
    p_float("weight_decay", "Weight decay", 0.0001, 0.0, 0.1, step=0.0001),
    p_int("patience", "Early stopping patience (0 = off)", 5, 0, 100),
    p_select("device", "Device", "auto", [("auto", "Best available (GPU first)"), ("cpu", "CPU"),
                                          ("cuda", "NVIDIA GPU (CUDA)"), ("mps", "Apple GPU (MPS)")]),
]  # fmt: skip

IMAGE_ALGOS: list[dict[str, Any]] = [
    {"id": "cnn", "label": "Custom CNN", "family": "Deep learning", "tasks": ["classification"], "needs": "torch",
     "description": "Design a convolutional network layer by layer. Trains from scratch.", "deep": True,
     "params": [IMAGE_LAYERS, *IMAGE_TRAINING]},
    {"id": "pretrained", "label": "Pretrained network (transfer learning)", "family": "Deep learning",
     "tasks": ["classification"], "needs": "torchvision", "deep": True,
     "description": "Start from a network trained on ImageNet and adapt it to your classes. Best accuracy with few "
                    "images. Downloads the weights once.",
     "params": [p_select("arch", "Network", "resnet18", [("resnet18", "ResNet-18 (balanced)"),
                                                         ("mobilenet_v3_small", "MobileNet V3 small (fast, light)"),
                                                         ("efficientnet_b0", "EfficientNet-B0 (accurate)"),
                                                         ("resnet50", "ResNet-50 (large)")]),
                p_bool("freeze", "Train only the last layer (faster)", True),
                p_bool("pretrained", "Use ImageNet weights", True), *IMAGE_TRAINING]},
]  # fmt: skip

IMAGE_PREP: list[Param] = [
    p_int("size", "Image size (pixels)", 64, 8, 512, "Images are resized to a square of this size."),
    p_bool("grayscale", "Grayscale", False),
    p_select("normalize", "Normalize", "imagenet", [("imagenet", "ImageNet statistics"), ("unit", "0 to 1 only")]),
    p_bool("hflip", "Augment: mirror left-right", True),
    p_bool("vflip", "Augment: flip upside down", False),
    p_int("rotation", "Augment: rotate up to (degrees)", 10, 0, 180),
    p_float("color_jitter", "Augment: colour jitter", 0.1, 0.0, 1.0, step=0.05),
    p_float("crop_scale", "Augment: random crop (min share kept, 1 = off)", 1.0, 0.3, 1.0, step=0.05),
]  # fmt: skip


def defaults(params: list[Param]) -> dict[str, Any]:
    return {p["name"]: p.get("default") for p in params}


def algo_available(algo: Algo, packages: dict[str, Any]) -> bool:
    return algo.needs is None or bool(packages.get(algo.needs))


def catalogue(packages: dict[str, Any]) -> dict[str, Any]:
    """The whole catalogue for the UI, with model availability for this engine."""
    return {
        "clean": [op.as_dict() for op in CLEAN_OPS],
        "rows": [op.as_dict() for op in ROW_OPS],
        "transform": [op.as_dict() for op in TRANSFORM_OPS],
        "models": [a.as_dict(algo_available(a, packages)) for a in ALGOS],
        "image_models": [{**m, "available": bool(packages.get(m["needs"]))} for m in IMAGE_ALGOS],
        "image_prep": IMAGE_PREP,
    }
