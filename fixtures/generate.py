"""Generate the committed fixture datasets (PRD Section 18). Deterministic: re-running is a no-op.

python fixtures/generate.py
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import numpy as np
import polars as pl

OUT = Path(__file__).parent


def _with_nulls(rng: np.random.Generator, values: list[object], frac: float) -> list[object]:
    mask = rng.random(len(values)) < frac
    return [None if m else v for v, m in zip(values, mask, strict=True)]


def churn(rng: np.random.Generator, n: int = 2000) -> pl.DataFrame:
    tenure = rng.integers(0, 73, n)
    plan = rng.choice(["basic", "plus", "pro", "enterprise"], n, p=[0.4, 0.3, 0.2, 0.1])
    contract = rng.choice(["month_to_month", "one_year", "two_year"], n, p=[0.55, 0.25, 0.2])
    base = {"basic": 25.0, "plus": 55.0, "pro": 85.0, "enterprise": 120.0}
    monthly = np.round([max(5.0, base[p] + rng.normal(0, 8)) for p in plan], 2)
    calls = np.clip(rng.poisson(1.5, n), 0, 10)
    partner = rng.random(n) < 0.45
    logit = (
        -1.2
        - 0.045 * tenure
        + 0.45 * calls
        + 1.3 * (contract == "month_to_month")
        - 0.6 * partner
        + 0.01 * (monthly - 60)
    )
    churned = rng.random(n) < 1 / (1 + np.exp(-logit))
    signup = [dt.date(2026, 8, 1) - dt.timedelta(days=int(t * 30 + rng.integers(0, 30))) for t in tenure]
    return pl.DataFrame(
        {
            "customer_id": [f"C{i:05d}" for i in range(n)],
            "tenure_months": _with_nulls(rng, tenure.tolist(), 0.03),
            "monthly_charges": _with_nulls(rng, monthly.tolist(), 0.02),
            "plan_type": plan.tolist(),
            "contract": contract.tolist(),
            "support_calls": calls.tolist(),
            "has_partner": partner.tolist(),
            "signup_date": signup,
            "churned": churned.tolist(),
        },
        schema_overrides={"tenure_months": pl.Int64, "monthly_charges": pl.Float64},
    )


def clean_numeric(rng: np.random.Generator, n: int = 500) -> pl.DataFrame:
    x = rng.normal(0, 1, (n, 4))
    x5 = rng.uniform(0, 10, n)
    y = 3 * x[:, 0] - 2 * x[:, 1] + 0.5 * x5 + rng.normal(0, 1, n)
    return pl.DataFrame(
        {**{f"x{i + 1}": np.round(x[:, i], 4) for i in range(4)}, "x5": np.round(x5, 4), "y": np.round(y, 4)}
    )


def missing_20pct(rng: np.random.Generator, n: int = 400) -> pl.DataFrame:
    a, b, c = rng.normal(50, 10, n), rng.exponential(3, n), rng.integers(0, 100, n)
    cat = rng.choice(["red", "green", "blue"], n)
    target = (a + 5 * b + rng.normal(0, 10, n)) > 65
    return pl.DataFrame(
        {
            "a": _with_nulls(rng, np.round(a, 3).tolist(), 0.2),
            "b": _with_nulls(rng, np.round(b, 3).tolist(), 0.2),
            "c": _with_nulls(rng, c.tolist(), 0.2),
            "colour": _with_nulls(rng, cat.tolist(), 0.2),
            "target": target.tolist(),
        },
        schema_overrides={"a": pl.Float64, "b": pl.Float64, "c": pl.Int64, "colour": pl.String},
    )


def imbalanced_2pct(rng: np.random.Generator, n: int = 3000) -> pl.DataFrame:
    x = rng.normal(0, 1, (n, 5))
    fraud = rng.random(n) < 0.02
    x[fraud, 0] += 2.5
    return pl.DataFrame({**{f"f{i + 1}": np.round(x[:, i], 4) for i in range(5)}, "is_fraud": fraud.tolist()})


def mixed_messy(rng: np.random.Generator, n: int = 300) -> pl.DataFrame:
    cities = ["New York", " new york", "NEW YORK ", "Boston", "boston", "Chicago  ", "chicago"]
    amounts = [f"{v:,.2f}" for v in rng.uniform(10, 5000, n)]
    amounts = [a if rng.random() > 0.1 else "N/A" for a in amounts]
    dates = [
        (dt.date(2025, 1, 1) + dt.timedelta(days=int(d))).strftime("%Y-%m-%d" if i % 3 else "%d/%m/%Y")
        for i, d in enumerate(rng.integers(0, 365, n))
    ]
    return pl.DataFrame(
        {
            "order_ref": [f"ord-{i:04d}" for i in range(n)],
            "city": rng.choice(cities, n).tolist(),
            "amount": amounts,
            "ordered_on": dates,
            "channel": rng.choice(["web", "Web", "store", "phone", ""], n).tolist(),
            "rating": _with_nulls(rng, rng.integers(1, 6, n).tolist(), 0.15),
        },
        schema_overrides={"rating": pl.Int64},
    )


def timeseries(rng: np.random.Generator, n: int = 730) -> pl.DataFrame:
    days = [dt.date(2024, 1, 1) + dt.timedelta(days=i) for i in range(n)]
    t = np.arange(n)
    promo = rng.random(n) < 0.1
    sales = (
        200
        + 0.15 * t
        + 30 * np.sin(2 * np.pi * t / 7)
        + 60 * np.sin(2 * np.pi * t / 365)
        + 40 * promo
        + rng.normal(0, 12, n)
    )
    return pl.DataFrame({"date": days, "sales": np.round(sales, 2), "promo": promo.tolist()})


def wide_500(rng: np.random.Generator, n: int = 120) -> pl.DataFrame:
    x = rng.normal(0, 1, (n, 500))
    label = (x[:, 0] + x[:, 1] + rng.normal(0, 0.5, n)) > 0
    return pl.DataFrame(
        {**{f"f{i:03d}": np.round(x[:, i], 3) for i in range(500)}, "label": label.astype(int).tolist()}
    )


def tiny_30(rng: np.random.Generator) -> pl.DataFrame:
    group = ["A"] * 15 + ["B"] * 15
    score = np.round(np.concatenate([rng.normal(70, 8, 15), rng.normal(76, 8, 15)]), 1)
    return pl.DataFrame({"subject": list(range(1, 31)), "group": group, "score": score})


def leakage_trap(rng: np.random.Generator, n: int = 1000) -> pl.DataFrame:
    usage = rng.gamma(2, 10, n)
    tickets = rng.poisson(1, n)
    churned = rng.random(n) < 1 / (1 + np.exp(-(-1 - 0.05 * usage + 0.6 * tickets)))
    refund = np.where(rng.random(n) < 0.97, churned, ~churned)  # recorded after the outcome
    return pl.DataFrame(
        {
            "account_id": [f"A{i:05d}" for i in range(n)],
            "monthly_usage_hours": np.round(usage, 2),
            "support_tickets": tickets,
            "refund_issued": refund.tolist(),
            "churned": churned.tolist(),
        }
    )


def main() -> None:
    builders = {
        "churn": churn,
        "clean_numeric": clean_numeric,
        "missing_20pct": missing_20pct,
        "imbalanced_2pct": imbalanced_2pct,
        "mixed_messy": mixed_messy,
        "timeseries": timeseries,
        "wide_500": wide_500,
        "tiny_30": tiny_30,
        "leakage_trap": leakage_trap,
    }
    for seed, (name, build) in enumerate(builders.items()):
        df = build(np.random.default_rng(1000 + seed))
        df.write_csv(OUT / f"{name}.csv")
        print(f"{name:16} {df.height:>5} rows x {df.width:>3} cols")


if __name__ == "__main__":
    main()
