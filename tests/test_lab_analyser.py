"""Code Mode analyser: segmentation, symbol analysis, edges, confidence and patterns (PRD II 5, 14).

Constructs from PRD II 2.1 are tested for the *correct degraded behaviour*, not a perfect graph.
"""

from __future__ import annotations

import json
import random
import time

import pytest
from flowlab_lab import PATTERNS, analyse_block, analyse_text, segment_text
from flowlab_lab import codegraph as codegraph_module
from flowlab_lab import symbols as symbols_module


def notebook(
    *cells: str, counts: list[int | None] | None = None, markdown: dict[int, str] | None = None
) -> str:
    items = []
    for index, source in enumerate(cells):
        if markdown and index in markdown:
            items.append({"cell_type": "markdown", "source": markdown[index], "metadata": {}})
        count = counts[index] if counts else None
        items.append(
            {"cell_type": "code", "source": source, "execution_count": count, "metadata": {}, "outputs": []}
        )
    return json.dumps({"cells": items, "metadata": {}, "nbformat": 4, "nbformat_minor": 5})


def edges(graph) -> set[tuple[str, str, str, str]]:  # type: ignore[no-untyped-def]
    return {(e.from_, e.to, e.variable, e.kind) for e in graph.edges}


def codes(graph) -> set[tuple[str | None, str]]:  # type: ignore[no-untyped-def]
    return {(w.node_id, w.code) for w in graph.warnings}


# --------------------------------------------------------------------------- segmentation


def test_notebook_cells_are_blocks_with_markdown_titles() -> None:
    sf = segment_text("a.ipynb", notebook("x = 1", "y = x", markdown={1: "## Derive y\nmore text"}))
    assert [b.id for b in sf.code_blocks] == ["b1", "b2"]
    assert sf.code_blocks[1].title == "Derive y" and sf.code_blocks[1].cell_index == 2


def test_marker_script_regions() -> None:
    text = "import os\n\n# %% Load\ndf = 1\n\n\n# %% [markdown]\n# notes\n# %%\ny = df\n"
    sf = segment_text("s.py", text)
    assert [(b.id, b.kind, b.title) for b in sf.blocks] == [
        ("b1", "code", None),
        ("b2", "code", "Load"),
        ("m1", "markdown", None),
        ("b3", "code", None),
    ]
    assert sf.block("b2").source == "# %% Load\ndf = 1\n"  # type: ignore[union-attr]
    assert (sf.block("b2").start_line, sf.block("b2").end_line) == (3, 4)  # type: ignore[union-attr]


def test_plain_script_grouping_never_splits_syntax() -> None:
    text = (
        "import pandas as pd\nimport numpy as np\n\n"
        "# load the data\ndf = pd.read_csv('x.csv')\ndf = df.dropna()\n\n"
        "@decorator\ndef f(a):\n    return a\n"
        "for i in range(3):\n    print(i)\n\n    print('still the loop')\n"
    )
    sf = segment_text("p.py", text)
    sources = [b.source for b in sf.code_blocks]
    assert sources[0] == "import pandas as pd\nimport numpy as np\n"
    assert sources[1].startswith("# load the data\ndf = ")
    assert sources[2].startswith("@decorator\ndef f")
    assert sources[3].startswith("for i in range(3)") and sources[3].rstrip().endswith(
        "print('still the loop')"
    )


def test_unparseable_plain_script_is_one_block() -> None:
    sf = segment_text("bad.py", "x = (\ny = 2\n")
    assert len(sf.code_blocks) == 1
    graph = analyse_text("bad.py", "x = (\ny = 2\n")
    assert ("b1", "PARSE_ERROR") in codes(graph) and graph.nodes[0].confidence == "low"


def test_ipython_magics_are_tolerated_and_bash_cells_are_opaque() -> None:
    sym = analyse_block("%matplotlib inline\n!pip list\ndf = load()", notebook=True)
    assert sym.defines == ("df",) and "magic" in sym.side_effects
    opaque = analyse_block("%%bash\necho $HOME", notebook=True)
    assert "opaque" in opaque.flags and opaque.confidence == "low"
    assert analyse_block("%%time\nz = 1", notebook=True).defines == ("z",)


# ----------------------------------------------------------------- symbols (PRD II 2.1)


def test_inplace_and_method_mutations() -> None:
    sym = analyse_block("df.drop(columns=['a'], inplace=True)\nitems.append(1)\nframe.loc[0, 'x'] = 3")
    assert set(sym.mutates) == {"df", "items", "frame"} and sym.confidence == "medium"
    assert set(sym.uses) >= {"df", "items", "frame"}


def test_local_objects_are_not_external_mutations() -> None:
    assert analyse_block("rows = []\nrows.append(1)").mutates == ()


def test_alias_in_block_mutates_the_source() -> None:
    sym = analyse_block("view = df\nview['x'] = 1")
    assert sym.mutates == ("df",) and sym.aliases == (("view", "df"),)


def test_loops_are_one_block_with_loop_carried_names() -> None:
    sym = analyse_block("total = 0\nfor f in files:\n    total = total + process(f)")
    assert set(sym.uses) == {"files", "process"}
    assert sym.loop_carried == ("total",)
    assert "f" in sym.conditional_defines


def test_conditional_definitions() -> None:
    sym = analyse_block("if config.mode == 'x':\n    threshold = 1")
    assert sym.conditional_defines == ("threshold",) and sym.confidence == "medium"
    assert analyse_block("threshold = 0\nif flag:\n    threshold = 1").conditional_defines == ()


@pytest.mark.parametrize(
    "code", ["exec('a = 1')", "eval('1 + 1')", "globals()[name] = 1", "setattr(obj, key, 1)"]
)
def test_dynamic_code_is_low_confidence(code: str) -> None:
    sym = analyse_block(code)
    assert "dynamic" in sym.flags and sym.confidence == "low"


def test_star_imports_are_low_confidence() -> None:
    graph = analyse_text("s.ipynb", notebook("from mylib import *", "y = helper(1)"))
    assert graph.nodes[0].confidence == "low" and ("b1", "STAR_IMPORT") in codes(graph)
    assert ("b2", "UNDEFINED_NAME") not in codes(graph)


def test_functions_classes_closures_and_decorators() -> None:
    sym = analyse_block(
        "@register\ndef transform(frame, factor=DEFAULT):\n    scale = factor * 2\n    return frame * scale + OFFSET\n"
        "class Model(Base):\n    size = 3\n    def run(self):\n        return self.size\n"
    )
    assert set(sym.defines) == {"transform", "Model"}
    assert set(sym.uses) == {"register", "DEFAULT", "OFFSET", "Base"}
    assert "decorator" in sym.flags and sym.confidence == "medium"
    assert "decorator" not in analyse_block("@property\ndef f(self):\n    return 1").flags


def test_scopes_do_not_leak() -> None:
    sym = analyse_block("squares = [i * i for i in nums]\nfn = lambda k: k + base\nprint(i)")
    assert set(sym.uses) == {"nums", "base", "i"}
    assert set(sym.defines) == {"squares", "fn"}


def test_binding_forms() -> None:
    sym = analyse_block(
        "count += 1\nwith open(p) as handle:\n    text = handle.read()\n"
        "if (n := len(text)) > 3:\n    pass\ntry:\n    risky()\nexcept ValueError as err:\n    log(err)\ndel temp"
    )
    assert {"count", "handle", "text", "n", "err"} <= set(sym.defines)
    assert {"count", "p", "risky", "log", "temp"} <= set(sym.uses)
    assert "temp" in sym.deletes


def test_global_writes_from_functions() -> None:
    sym = analyse_block("def bump():\n    global counter\n    counter = counter + 1")
    assert "counter" in sym.defines and "global_write" in sym.flags
    assert "counter" in sym.uses


def test_qualified_calls_and_side_effects() -> None:
    sym = analyse_block(
        "import numpy as np\nimport matplotlib.pyplot as plt\nfrom sklearn.ensemble import RandomForestClassifier as RF\n"
        "model = RF()\nmodel.fit(X, y)\nnoise = np.random.rand(3)\nplt.plot(noise)\nprint(1)\n"
        "df.to_csv('out.csv')\nimport requests\nrequests.get(url)\nimport os\nkey = os.environ['K']"
    )
    assert "sklearn.ensemble.RandomForestClassifier.fit" in sym.calls
    assert "numpy.random.rand" in sym.calls and "matplotlib.pyplot.plot" in sym.calls
    assert set(sym.side_effects) >= {
        "print",
        "file_io",
        "network",
        "plotting",
        "random_unseeded",
        "environment",
    }
    assert (
        "random_unseeded"
        not in analyse_block("import numpy as np\nnp.random.seed(0)\nnp.random.rand(2)").side_effects
    )


# ---------------------------------------------------------------------------------- edges


def test_redefinition_uses_the_most_recent_definer() -> None:
    graph = analyse_text("r.ipynb", notebook("df = a()", "x = 1", "df = b()", "y = df.sum()"))
    assert ("b3", "b4", "df", "dataflow") in edges(graph)
    assert not any(e.from_ == "b1" and e.to == "b4" for e in graph.edges)


def test_mutation_edges_and_shared_object_warning() -> None:
    graph = analyse_text(
        "m.ipynb",
        notebook(
            "df = load()", "report = df.describe()", "df.drop(columns=['a'], inplace=True)", "model = fit(df)"
        ),
    )
    assert ("b3", "b4", "df", "mutation") in edges(graph)
    edge = next(e for e in graph.edges if e.to == "b4")
    assert edge.confidence == "medium"
    assert ("b3", "MUTATION_SHARED_OBJECT") in codes(graph)


def test_alias_mutation_downgrades_both_names() -> None:
    graph = analyse_text("a.ipynb", notebook("df1 = load()", "df2 = df1", "df2['x'] = 0", "out = df1.sum()"))
    assert ("b1", "b2", "df1", "alias") in edges(graph)
    assert ("b2", "ALIAS_MUTATION") in codes(graph)
    assert all(e.confidence == "low" for e in graph.edges if e.variable in {"df1", "df2"})


def test_conditional_edges_are_medium_with_badge() -> None:
    graph = analyse_text("c.ipynb", notebook("if flag:\n    col = 'a'", "use(col)"))
    edge = next(e for e in graph.edges if e.variable == "col")
    assert edge.confidence == "medium" and ("b2", "CONDITIONAL_DEFINITION") in codes(graph)


def test_undefined_names_become_error_nodes() -> None:
    graph = analyse_text("u.ipynb", notebook("x = config['a']"))
    node = graph.node("undefined:config")
    assert node is not None and node.kind == "undefined" and "never defined" in node.label
    assert ("undefined:config", "b1", "config", "dataflow") in edges(graph)
    assert ("undefined:config", "UNDEFINED_NAME") in codes(graph)


def test_builtin_names_link_only_when_shadowed() -> None:
    assert analyse_text("b.ipynb", notebook("n = len([1])")).edges == []
    shadowed = analyse_text("s.ipynb", notebook("list = [1, 2]", "total = sum(list)"))
    assert ("b1", "b2", "list", "dataflow") in edges(shadowed)


def test_out_of_order_notebooks_are_flagged() -> None:
    graph = analyse_text("o.ipynb", notebook("y = x + 1", "x = 1", counts=[2, 1]))
    assert ("b1", "USE_BEFORE_DEFINITION") in codes(graph)
    assert (None, "OUT_OF_ORDER_EXECUTION") in codes(graph)


def test_parse_errors_are_isolated_to_their_block() -> None:
    graph = analyse_text("p.ipynb", notebook("a = 1", "b = (", "c = a + 1"))
    assert ("b2", "PARSE_ERROR") in codes(graph)
    assert ("b1", "b3", "a", "dataflow") in edges(graph)


def test_import_edges_and_labels() -> None:
    graph = analyse_text(
        "l.ipynb",
        notebook(
            "import pandas as pd\nfrom sklearn.model_selection import train_test_split",
            "# Load raw customers\nraw = pd.read_csv('c.csv')",
            "train, test = train_test_split(raw)",
            "def helper(frame):\n    return frame.dropna()",
        ),
    )
    assert ("b1", "b2", "pd", "import") in edges(graph)
    labels = {n.id: n.label for n in graph.nodes}
    # PRD II 9.3 order: pattern match, then leading comment, then first assignment target
    assert labels == {"b1": "Imports", "b2": "Load data", "b3": "Train/test split", "b4": "def helper"}
    unmatched = analyse_text("k.ipynb", notebook("# Build the lookup table\nlookup = {}"))
    assert unmatched.nodes[0].label == "Build the lookup table"
    assert graph.node("b3").matched_pattern == "prep.split"  # type: ignore[union-attr]
    assert graph.node("b4").matched_pattern is None  # type: ignore[union-attr]


def test_patterns_are_cosmetic_only() -> None:
    text = notebook("import pandas as pd", "df = pd.read_csv('a')", "df = df.fillna(0)", "df.to_csv('b')")
    with_patterns = analyse_text("x.ipynb", text)
    without = analyse_text("x.ipynb", text, use_patterns=False)
    assert edges(with_patterns) == edges(without) and codes(with_patterns) == codes(without)
    assert [n.defines for n in with_patterns.nodes] == [n.defines for n in without.nodes]
    assert any(n.matched_pattern for n in with_patterns.nodes) and not any(
        n.matched_pattern for n in without.nodes
    )
    assert len(PATTERNS) >= 40


def test_graph_navigation_and_serialisation() -> None:
    graph = analyse_text("n.ipynb", notebook("a = 1", "b = a", "c = b", "d = 5", "e = c + d"))
    assert graph.ancestors("b5") == {"b1", "b2", "b3", "b4"}
    assert graph.descendants("b2") == {"b3", "b5"}
    assert graph.in_source_order({"b5", "b1", "b3"}) == ["b1", "b3", "b5"]
    payload = json.loads(graph.to_json())
    assert payload["edges"][0]["from"] == "b1" and payload["source"]["kind"] == "notebook"
    assert "flowchart TD" in graph.to_mermaid() and "b1 -->|a| b2" in graph.to_mermaid()


# ------------------------------------------------------------------ performance & corpus


def test_hundred_cell_notebook_under_500ms() -> None:
    cells = ["import pandas as pd\nimport numpy as np\nframe0 = pd.DataFrame({'a': [1]})"]
    for i in range(1, 100):
        cells.append(
            f"# step {i}\nframe{i} = frame{i - 1}.assign(v{i}=np.arange(len(frame{i - 1})))\n"
            f"for k in range(3):\n    frame{i}[f'c{{k}}'] = k\nstats{i} = frame{i}.describe()"
        )
    text = notebook(*cells)
    symbols_module._analyse_cached.cache_clear()
    codegraph_module._GRAPH_CACHE.clear()
    started = time.perf_counter()
    graph = analyse_text("big.ipynb", text)
    elapsed_ms = (time.perf_counter() - started) * 1000
    assert elapsed_ms < 500, elapsed_ms
    assert len(graph.code_nodes()) == 100 and len(graph.edges) >= 99
    assert analyse_text("big.ipynb", text) is graph  # cached by content hash


def _random_notebook(rng: random.Random, index: int) -> str:
    snippets = [
        "import pandas as pd\nimport numpy as np",
        "df = pd.read_csv('data_{i}.csv')",
        "df = df.dropna()\ndf['ratio'] = df['a'] / df['b']",
        "df.drop(columns=['id'], inplace=True)",
        "summary = df.groupby('g').agg({{'a': 'mean'}})",
        "from sklearn.model_selection import train_test_split\nX_train, X_test, y_train, y_test = train_test_split(df.drop(columns=['y']), df['y'])",
        "from sklearn.linear_model import LogisticRegression\nmodel = LogisticRegression().fit(X_train, y_train)",
        "score = model.score(X_test, y_test)\nprint(score)",
        "import matplotlib.pyplot as plt\nplt.hist(df['a'])\nplt.show()",
        "%matplotlib inline",
        "for col in df.columns:\n    if df[col].dtype == object:\n        df[col] = df[col].str.strip()",
        "def clean(frame):\n    return frame.fillna(0)\n\ndf = clean(df)",
        "result = undefined_thing + 1",
        "exec('x = 1')",
        "if len(df) > 100:\n    sample = df.sample(100)",
        "class Holder:\n    pass",
        "values = [v * 2 for v in range(10)]",
        "broken = (",
        "!pip install something",
        "with open('notes.txt') as fh:\n    notes = fh.read()",
    ]
    cells = [snippet.format(i=index) for snippet in rng.sample(snippets, rng.randint(6, len(snippets)))]
    return notebook(*cells, counts=[rng.choice([None, *range(1, 30)]) for _ in cells])


def test_generated_notebook_corpus_never_crashes_or_comes_back_empty() -> None:
    rng = random.Random(7)
    for index in range(50):
        text = _random_notebook(rng, index)
        graph = analyse_text(f"corpus_{index}.ipynb", text)
        cells = [c for c in json.loads(text)["cells"] if c["cell_type"] == "code"]
        assert len(graph.code_nodes()) == len(cells)
        assert graph.nodes and all(n.label for n in graph.nodes)
