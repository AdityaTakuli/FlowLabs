"""Tier B pattern recognition (PRD II 5.5).

A match only changes a node's label, icon category and the availability of "convert to Flow
node". It never changes execution, code or graph structure, so a wrong match is harmless.
Patterns are ordered by priority: the first pattern matching any call in a block wins.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from fnmatch import fnmatchcase


@dataclass(frozen=True)
class Pattern:
    call: str  # fnmatch glob over qualified call names, e.g. "sklearn.*.fit"
    node_type: str  # Part I node type
    label: str


PATTERNS: tuple[Pattern, ...] = (
    # splitting and validation
    Pattern("sklearn.model_selection.train_test_split", "prep.split", "Train/test split"),
    Pattern("sklearn.model_selection.GroupShuffleSplit*", "prep.split", "Group split"),
    Pattern("sklearn.model_selection.TimeSeriesSplit*", "model.cross_validate", "Time-series CV"),
    Pattern("sklearn.model_selection.GridSearchCV*", "model.tune", "Grid search"),
    Pattern("sklearn.model_selection.RandomizedSearchCV*", "model.tune", "Random search"),
    Pattern("optuna.*", "model.tune", "Optuna tuning"),
    Pattern("sklearn.model_selection.cross_val*", "model.cross_validate", "Cross-validation"),
    # evaluation and explanation
    Pattern("sklearn.metrics.*", "model.evaluate", "Evaluate model"),
    Pattern("sklearn.inspection.*", "model.explain", "Explain model"),
    Pattern("shap.*", "model.explain", "SHAP explanation"),
    # statistics
    Pattern("scipy.stats.ttest_*", "stat.ttest", "t-test"),
    Pattern("scipy.stats.mannwhitneyu", "stat.mannwhitney", "Mann-Whitney U"),
    Pattern("scipy.stats.f_oneway", "stat.anova", "ANOVA"),
    Pattern("scipy.stats.kruskal", "stat.kruskal", "Kruskal-Wallis"),
    Pattern("scipy.stats.chi2_contingency", "stat.chisquare", "Chi-square test"),
    Pattern("scipy.stats.[psk][ep]*r*", "stat.correlation", "Correlation test"),
    Pattern("scipy.stats.shapiro", "stat.normality", "Normality test"),
    Pattern("scipy.stats.normaltest", "stat.normality", "Normality test"),
    Pattern("statsmodels.*", "stat.regression", "Statistical model"),
    # modelling
    Pattern("sklearn.*.fit", "model.fit", "Fit model"),
    Pattern("xgboost.*.fit", "model.fit", "Fit XGBoost"),
    Pattern("lightgbm.*.fit", "model.fit", "Fit LightGBM"),
    Pattern("*.fit", "model.fit", "Fit model"),
    Pattern("*.predict", "model.predict", "Predict"),
    Pattern("*.predict_proba", "model.predict", "Predict probabilities"),
    Pattern("joblib.dump", "model.export", "Save model"),
    Pattern("pickle.dump", "model.export", "Save object"),
    # preprocessing
    Pattern("sklearn.preprocessing.*Scaler", "prep.scale", "Scale features"),
    Pattern("sklearn.preprocessing.QuantileTransformer", "prep.scale", "Quantile transform"),
    Pattern("sklearn.preprocessing.*Encoder", "prep.encode", "Encode categories"),
    Pattern("pandas.get_dummies", "prep.encode", "One-hot encode"),
    Pattern("imblearn.*", "prep.balance", "Resample classes"),
    Pattern("sklearn.impute.*", "clean.impute", "Impute missing"),
    Pattern("sklearn.feature_selection.*", "feature.select", "Select features"),
    Pattern("sklearn.decomposition.*", "feature.reduce", "Reduce dimensions"),
    Pattern("sklearn.manifold.*", "feature.reduce", "Embed for visualisation"),
    # sources and sinks
    Pattern("pandas.read_sql*", "source.sql", "Query database"),
    Pattern("pandas.read_*", "source.dataset", "Load data"),
    Pattern("polars.read_*", "source.dataset", "Load data"),
    Pattern("pandas.merge", "source.join", "Join tables"),
    Pattern("*.merge", "source.join", "Join tables"),
    Pattern("*.to_csv", "sink.export", "Export CSV"),
    Pattern("*.to_parquet", "sink.export", "Export Parquet"),
    Pattern("*.to_excel", "sink.export", "Export Excel"),
    # cleaning
    Pattern("*.fillna", "clean.impute", "Fill missing values"),
    Pattern("*.dropna", "clean.drop_rows", "Drop missing rows"),
    Pattern("*.drop_duplicates", "clean.dedupe", "Remove duplicates"),
    Pattern("*.drop", "clean.drop_columns", "Drop columns"),
    Pattern("pandas.to_datetime", "clean.datetime_parse", "Parse dates"),
    Pattern("pandas.to_numeric", "clean.cast", "Convert to numbers"),
    Pattern("*.astype", "clean.cast", "Cast types"),
    Pattern("*.str.*", "clean.text_normalize", "Clean text"),
    # reshaping
    Pattern("*.groupby", "util.aggregate", "Group and aggregate"),
    Pattern("*.pivot_table", "util.pivot", "Pivot"),
    Pattern("*.melt", "util.melt", "Melt"),
    Pattern("*.query", "util.filter", "Filter rows"),
    Pattern("*.sample", "util.sample", "Sample rows"),
    # profiling
    Pattern("*.describe", "profile.overview", "Describe data"),
    Pattern("*.info", "profile.overview", "Inspect data"),
    Pattern("*.isna", "profile.missingness", "Check missing values"),
    Pattern("*.isnull", "profile.missingness", "Check missing values"),
    Pattern("*.value_counts", "profile.cardinality", "Value counts"),
    # visualisation
    Pattern("seaborn.*", "viz.custom", "Seaborn chart"),
    Pattern("plotly.*", "viz.custom", "Plotly chart"),
    Pattern("*.hist", "viz.distribution", "Histogram"),
    Pattern("matplotlib.*", "viz.custom", "Chart"),
    Pattern("*.plot", "viz.custom", "Chart"),
)


def match_calls(calls: Iterable[str]) -> Pattern | None:
    names = list(calls)
    for pattern in PATTERNS:
        if any(fnmatchcase(name, pattern.call) for name in names):
            return pattern
    return None
