# %% Load features
import matplotlib.pyplot as plt
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score, roc_auc_score
from sklearn.model_selection import StratifiedKFold, cross_val_score, train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

features = pd.read_csv("data/features.csv")
target = "churned"
X = features.drop(columns=[target, "customer_id"])
y = features[target]

# %% Split before any fitting
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, stratify=y, random_state=0)

# %% Baseline: scaled logistic regression, cross-validated
baseline = make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000))
folds = StratifiedKFold(n_splits=5, shuffle=True, random_state=0)
for fold, score in enumerate(cross_val_score(baseline, X_train, y_train, cv=folds, scoring="roc_auc"), start=1):
    print(f"fold {fold} roc_auc={score:.4f}")

# %% Gradient boosting
model = GradientBoostingClassifier(n_estimators=120, max_depth=3, random_state=0)
model.fit(X_train, y_train)

# %% Evaluate on the held-out test set
probabilities = model.predict_proba(X_test)[:, 1]
predictions = (probabilities >= 0.5).astype(int)
test_metrics = {
    "accuracy": accuracy_score(y_test, predictions),
    "f1": f1_score(y_test, predictions),
    "roc_auc": roc_auc_score(y_test, probabilities),
}
print(" ".join(f"{name}={value:.4f}" for name, value in test_metrics.items()))

# %% Confusion matrix and feature importance
matrix = confusion_matrix(y_test, predictions)
importance = pd.Series(model.feature_importances_, index=X.columns).sort_values()
figure, (left, right) = plt.subplots(1, 2, figsize=(10, 4))
left.imshow(matrix, cmap="Greys")
left.set_title("Confusion matrix")
importance.tail(8).plot.barh(ax=right, color="black", title="Top features")
figure.tight_layout()
plt.show()
