# Predict and export

## Try the model

**Predict** shows a form with one field per input column. Lists offer the values seen in training,
and numbers show their typical range. The prediction updates as you type: the predicted class with
each class's probability, or the predicted number. Use it to check that the model behaves sensibly,
for example that a longer contract lowers the chance of churn.

Choose the model at the top. The best one is picked for you.

## Score a whole file

Under **Score a whole file**, choose a stored dataset with the same columns, without the target, or
with it, which is ignored. FlowLabs runs every row through the whole pipeline (Clean, Transform and
the model) and gives you a CSV with the predictions added:

- `predicted_<target>`;
- for classification, one probability column per class.

Columns the model needs but the file lacks are listed. They are treated as missing.

For image projects, drop an image to classify it.

## Export

**Export** builds a folder (and a zip) that runs on any computer with Python, with no FlowLabs
needed. Choose the model, then **Export**.

| File | What it is |
| --- | --- |
| `model.joblib` | The whole pipeline in one file: raw rows in, predictions out. |
| `flowlabs_runtime.py` | The small module the pipeline needs (numpy, pandas and scikit-learn only). |
| `predict.py` | `python predict.py new.csv` writes `predictions.csv`. |
| `serve.py` | A small HTTP server: POST rows as JSON, get predictions back. |
| `train.py` | The same training as a readable script you can edit and run again. |
| `schema.json` | Input columns, their types and allowed values, and the output classes. |
| `example.csv` | Five rows in the expected input format. |
| `requirements.txt` | The packages, pinned to the versions that trained the model. |
| `MODEL_CARD.md` | What the model is, how it was trained and how well it did. |

**Include the training data** puts the dataset in the export too, so `train.py` runs as it is.
Leave it off when the data is private.

Image models export `model.pt` (TorchScript, needs only PyTorch), `model.onnx` when possible (for
ONNX Runtime, C++, C#, JavaScript and mobile), `labels.json` and `preprocess.json`.

### Use it from a terminal

```bash
pip install -r requirements.txt
python predict.py example.csv -o predictions.csv
python serve.py --port 8000
curl -X POST localhost:8000/predict -d '{"rows": [{"tenure_months": 14, "plan_type": "plus"}]}'
```

### Use it from Python

```python
import joblib, pandas as pd

model = joblib.load("model.joblib")   # keep flowlabs_runtime.py next to it
rows = pd.read_csv("new_rows.csv")
model.predict(rows)
model.predict_proba(rows)             # classification: one column per class
```

Exports are also kept in the **exports** folder inside your FlowLabs folder.
