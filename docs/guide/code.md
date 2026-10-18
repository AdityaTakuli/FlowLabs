# Code steps

When the built-in steps are not enough, write the step in Python. Code steps sit in the pipeline
like any other step. FlowLabs runs them with the right rows, and exported models run them too.

## See the code of any step

Select a step or model and switch from **Settings** to **Python**. You see pandas or scikit-learn
code that does exactly what the step does, with your settings. It is a good way to learn what a step
does, or to start your own.

**Edit as code** adds that code as a new code step right after the original. It also switches the
original off, so the pipeline does the same thing as before and you can go back at any time. Then
change the code as you like.

## Write a code step

In **Add a step**, choose **Python code** (or **Python model** in Add a model). Each kind has a
template to fill in:

| Where | You write | It runs on |
| --- | --- | --- |
| Clean | `def clean(df):` returning the table | the whole table, and new data when predicting |
| Training rows | `def rows(X, y):` returning `X, y` | training rows only |
| Transform | `def fit(X, y):` and `def transform(X, state):`, or `transformer = <any scikit-learn transformer>` | learned from training rows, applied to every row |
| Models | `model = <anything with fit and predict>` | the prepared training rows |

`pd` (pandas), `np` (NumPy) and `math` are ready to use. Import anything else installed in the
engine's Python.

```python
# Clean: a ratio column, and no test accounts
def clean(df):
    df = df[~df["email"].str.endswith("@test.com", na=False)]
    df["charge_per_month"] = df["total_charges"] / df["tenure_months"].clip(lower=1)
    return df
```

```python
# Transform: learn the per-plan mean charge from training rows, use it everywhere
def fit(X, y):
    return X.groupby("plan_type")["monthly_charges"].mean().to_dict()

def transform(X, state):
    X = X.copy()
    X["plan_mean_charge"] = X["plan_type"].map(state)
    return X
```

```python
# Models: any estimator with fit and predict (and predict_proba for probabilities)
from sklearn.ensemble import HistGradientBoostingClassifier
model = HistGradientBoostingClassifier(max_iter=400, learning_rate=0.05)
```

A training-rows step also gets `clean`: a function that cleans new rows the same way your Clean
stage does. Use it when you generate extra rows.

## Mistakes

If the code fails, the editor highlights the line, and the step shows the error in plain words. The
pipeline will not train until it is fixed. **Preview** runs the step, so you can try a change
before training.

## Exports run your code

A code step is part of the model. `predict.py`, `serve.py` and `train.py` in the export run it
too, through `flowlabs_runtime.py`, so you do not need FlowLabs installed. List any extra packages
your code imports in `requirements.txt`.

> **Safety.** Code steps run on the engine with your permissions, like any Python script. Only open
> projects from people you trust. Only connect to engines you trust, and share an engine's token
> only with people you trust.
