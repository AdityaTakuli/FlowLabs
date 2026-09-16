# %% Load raw customer data
from pathlib import Path

import numpy as np
import pandas as pd

DATA = Path("data")
DATA.mkdir(exist_ok=True)
rng = np.random.default_rng(7)
n = 2000
raw = pd.DataFrame(
    {
        "customer_id": np.arange(n),
        "age": rng.integers(18, 80, n).astype(float),
        "income": rng.normal(52_000, 18_000, n).round(0),
        "plan": rng.choice(["basic", "plus", "pro"], n, p=[0.5, 0.3, 0.2]),
        "tenure_months": rng.integers(1, 72, n),
        "support_calls": rng.poisson(1.5, n),
        "monthly_spend": rng.gamma(2.0, 30.0, n).round(2),
    }
)
raw.loc[rng.choice(n, 120, replace=False), "age"] = np.nan
raw.loc[rng.choice(n, 80, replace=False), "income"] = np.nan
risk = 0.9 * raw["support_calls"] - 0.04 * raw["tenure_months"] + (raw["plan"] == "basic") * 0.8
raw["churned"] = (risk + rng.normal(0, 1, n) > 0.6).astype(int)
raw.to_csv(DATA / "customers_raw.csv", index=False)
print("raw rows", len(raw))

# %% Clean
customers = raw.drop_duplicates("customer_id")
customers = customers[customers["income"].isna() | (customers["income"] > 0)]
customers["age"] = customers["age"].fillna(customers["age"].median())
customers["income"] = customers["income"].fillna(customers.groupby("plan")["income"].transform("median"))
print("clean rows", len(customers), "missing", int(customers.isna().sum().sum()))

# %% Feature engineering
features = customers.assign(
    spend_per_month_of_tenure=customers["monthly_spend"] / customers["tenure_months"],
    calls_per_year=customers["support_calls"] / (customers["tenure_months"] / 12),
    high_value=(customers["monthly_spend"] > customers["monthly_spend"].quantile(0.8)).astype(int),
)
features = pd.get_dummies(features, columns=["plan"], prefix="plan", dtype=int)

# %% Summary by segment
segments = features.groupby("high_value").agg(
    customers=("customer_id", "count"), churn_rate=("churned", "mean"), avg_spend=("monthly_spend", "mean")
)
segments

# %% Save features for training
features.to_csv(DATA / "features.csv", index=False)
print("saved", DATA / "features.csv", features.shape)
