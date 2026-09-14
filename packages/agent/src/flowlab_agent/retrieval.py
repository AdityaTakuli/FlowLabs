"""Local BM25 retrieval over the snippet library.

Only the top-k snippet *signatures* for a goal are put into the prompt, so prompt size stays
flat as the library grows. No embeddings API, no network.
"""

from __future__ import annotations

import math
import re
from collections import Counter

from .digest import DatasetDigest
from .snippets import Snippet, SnippetLibrary

_WORD = re.compile(r"[a-z0-9]+")
# fmt: off
STOPWORDS = frozenset([
    "a", "an", "and", "are", "as", "be", "by", "can", "do", "does", "for", "from", "get",
    "how", "i", "in", "into", "is", "it", "me", "my", "of", "on", "or", "show", "should",
    "that", "the", "this", "to", "use", "using", "want", "what", "which", "with", "find",
    "make", "build", "data", "dataset", "column", "columns", "please", "give", "tell", "about",
])
# fmt: on
SUFFIXES = ("ly", "ing", "ies", "es", "ed", "s")

# goal word -> related vocabulary used in snippet titles and tags
SYNONYMS: dict[str, list[str]] = {
    "missing": ["impute", "null", "fill", "nan"],
    "null": ["missing", "impute"],
    "nan": ["missing", "impute"],
    "empty": ["missing"],
    "predict": ["model", "classification", "regression", "evaluate"],
    "prediction": ["model", "evaluate"],
    "forecast": ["model", "regression", "trend"],
    "classify": ["classification", "model", "evaluate"],
    "model": ["evaluate", "train"],
    "accuracy": ["evaluate", "classification", "report"],
    "performance": ["evaluate", "metrics"],
    "outlier": ["clip", "zscore", "iqr"],
    "anomaly": ["outlier", "zscore"],
    "compare": ["ttest", "anova", "group", "difference"],
    "difference": ["ttest", "mannwhitney", "anova"],
    "different": ["ttest", "mannwhitney", "anova", "compare"],
    "differ": ["ttest", "mannwhitney", "anova", "compare"],
    "between": ["compare", "group", "difference"],
    "significant": ["ttest", "chi", "test", "pvalue"],
    "relationship": ["correlation", "scatter"],
    "related": ["correlation", "scatter"],
    "association": ["chi", "correlation"],
    "correlation": ["heatmap", "scatter"],
    "distribution": ["histogram", "boxplot", "normality"],
    "normal": ["normality", "shapiro"],
    "chart": ["plot", "viz"],
    "plot": ["viz", "chart"],
    "graph": ["plot", "viz"],
    "visualize": ["viz", "plot"],
    "visualise": ["viz", "plot"],
    "important": ["importance", "explain"],
    "driver": ["importance", "explain", "correlation"],
    "why": ["explain", "importance"],
    "explain": ["importance", "permutation"],
    "clean": ["duplicate", "missing", "strip", "outlier"],
    "tidy": ["clean", "strip", "duplicate"],
    "tune": ["grid", "search", "hyperparameter"],
    "optimize": ["tune", "grid"],
    "save": ["export"],
    "export": ["save"],
    "download": ["export", "save"],
    "category": ["encode", "onehot", "categorical"],
    "categorical": ["encode", "onehot", "chi"],
    "date": ["datetime", "parse", "time"],
    "time": ["datetime", "trend", "line"],
    "trend": ["line", "time"],
    "cluster": ["kmeans", "segment"],
    "segment": ["kmeans", "cluster"],
    "summary": ["overview", "describe"],
    "summarize": ["overview", "describe"],
    "overview": ["describe", "missing"],
    "explore": ["overview", "describe", "histogram", "correlation"],
    "eda": ["overview", "describe", "missing", "histogram", "correlation"],
    "interesting": ["overview", "correlation", "histogram"],
    "count": ["value", "bar", "frequency"],
    "frequency": ["value", "bar", "count"],
    "scale": ["normalize", "standardize"],
    "normalize": ["scale"],
    "feature": ["importance", "derive", "select"],
}

SIGNAL_HINTS: dict[str, dict[str, float]] = {
    "has_nulls": {"missing": 0.2},
    "has_categorical": {"encode": 0.15},
    "has_datetime": {"datetime": 0.15},
}


def stem(word: str) -> str:
    for suffix in SUFFIXES:
        if word.endswith(suffix) and len(word) - len(suffix) >= 4:
            return word[: -len(suffix)]
    return word


def tokenize(text: str) -> list[str]:
    return [stem(w) for w in _WORD.findall(text.lower()) if w not in STOPWORDS]


def _document(snippet: Snippet) -> list[str]:
    id_words = tokenize(snippet.id.replace(".", " ").replace("_", " "))
    tags = tokenize(" ".join(snippet.tags))
    return id_words * 2 + tokenize(snippet.title) + tags * 2 + tokenize(snippet.description)


class SnippetIndex:
    def __init__(self, library: SnippetLibrary, k1: float = 1.4, b: float = 0.75) -> None:
        self.library = library
        self.k1, self.b = k1, b
        self.docs = {s.id: Counter(_document(s)) for s in library}
        self.lengths = {sid: sum(doc.values()) for sid, doc in self.docs.items()}
        self.avg_length = sum(self.lengths.values()) / max(len(self.docs), 1)
        doc_freq: Counter[str] = Counter()
        for doc in self.docs.values():
            doc_freq.update(doc.keys())
        n = len(self.docs)
        self.idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in doc_freq.items()}

    def query_weights(self, query: str, digest: DatasetDigest | None) -> dict[str, float]:
        # Words that name a column describe the data, not the intent: don't expand them.
        column_words = {
            t for name in (digest.names if digest else []) for t in tokenize(name.replace("_", " "))
        }
        weights: dict[str, float] = {}
        for raw in _WORD.findall(query.lower()):
            if raw in STOPWORDS:
                continue
            token = stem(raw)
            weights[token] = weights.get(token, 0.0) + 1.0
            if token in column_words:
                continue
            for related in SYNONYMS.get(raw, SYNONYMS.get(token, [])):
                rel = stem(related)
                weights[rel] = max(weights.get(rel, 0.0), 0.6)
        if digest is not None and any(token in self.idf for token in weights):
            for signal in digest.signals:
                for token, bonus in SIGNAL_HINTS.get(signal, {}).items():
                    key = stem(token)
                    weights[key] = weights.get(key, 0.0) + bonus
        return weights

    def score(self, snippet_id: str, weights: dict[str, float]) -> float:
        doc = self.docs[snippet_id]
        norm = self.k1 * (1 - self.b + self.b * self.lengths[snippet_id] / self.avg_length)
        total = 0.0
        for token, weight in weights.items():
            tf = doc.get(token, 0)
            if tf:
                total += weight * self.idf[token] * tf * (self.k1 + 1) / (tf + norm)
        return total

    def search(
        self,
        query: str,
        *,
        digest: DatasetDigest | None = None,
        k: int = 12,
        per_category: int = 4,
        include_auto: bool = False,
    ) -> list[tuple[Snippet, float]]:
        weights = self.query_weights(query, digest)
        ranked = sorted(
            ((s, self.score(s.id, weights)) for s in self.library if include_auto or not s.auto),
            key=lambda pair: (-pair[1], pair[0].id),
        )
        picked: list[tuple[Snippet, float]] = []
        per: Counter[str] = Counter()
        for snippet, score in ranked:
            if score <= 0 or len(picked) >= k:
                break
            if per[snippet.category] >= per_category or snippet.category == "load":
                continue
            per[snippet.category] += 1
            picked.append((snippet, score))
        if not picked:  # nothing matched: offer a small exploratory starter set
            starters = ["inspect.overview", "inspect.missing", "inspect.describe", "viz.histogram"]
            picked = [(s, 0.0) for sid in starters if (s := self.library.get(sid)) is not None]
        return picked
