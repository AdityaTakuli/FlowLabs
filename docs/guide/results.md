# Training and results

## Train

Click **Train** in the top bar. The number on the button is how many models will train. FlowLabs
splits the rows and runs your steps. It then trains every model that is switched on and scores each
one on the test rows, which no model has seen.

While it trains, the Results page shows each model's progress:

- tuning tries, when tuning is on;
- epochs, with live loss curves for neural networks;
- a log.

**Stop** cancels the run. Every run is kept: the menu next to **Results** switches between runs,
newest first.

## The best model

The card at the top names the model with the best score on the test rows, by the metric you chose
on the Data page. The ring shows that score. For error metrics such as RMSE, it shows R² instead.
**Try it** opens Predict, and **Export** downloads it.

## Comparing models

- **Score and training time.** One bar per model for its score (the best in orange), and a line
  for the seconds it took to train. A slightly worse model that trains 50 times faster can be the
  better choice.
- **Cross-validation folds** (when cross-validation is on). Each dot is the model's score on one
  fold of the training rows, and the box holds the middle half. A narrow box means a steady model.
  A wide box means the score depends on luck.
- **Leaderboard.** Every metric for every model.
  - The **Train score** column is the score on the rows the model learned from. When it is much
    higher than the test score, the model is **overfitting**: it memorised the training rows.
    Simplify it (for trees, lower *Max depth*), add regularisation, or get more data.
  - Click a row to see that model in detail.

## Metrics

**Classification**

| Metric | What it means | Good |
| --- | --- | --- |
| Accuracy | Share of test rows predicted correctly. Misleading when one class is rare. | higher |
| Balanced accuracy | Accuracy averaged over classes, so rare classes count as much as common ones. | higher |
| F1 (macro) | The balance of precision and recall, averaged over classes. Robust when classes are uneven. | higher |
| Precision (macro) | Of the rows predicted as a class, how many really are. | higher |
| Recall (macro) | Of the rows that are a class, how many were found. | higher |
| ROC AUC | How well the model ranks positives above negatives: 0.5 is guessing, 1 is perfect. | higher |
| Log loss | Penalises confident wrong answers. | lower |

**Regression**

| Metric | What it means | Good |
| --- | --- | --- |
| R² | Share of the target's variation explained: 0 is guessing the average, 1 is perfect. | higher |
| RMSE | Typical error, in the target's units. Large errors count extra. | lower |
| MAE | Average absolute error, in the target's units. | lower |
| MAPE | Average error as a percentage of the true value. | lower |

Always compare with **Baseline (guess)**. It predicts the most common class, or the average. A
model that does not clearly beat it has not learned anything useful.

## One model in detail

The figures under the model's name (accuracy, F1 and so on) count up from zero when they appear.
*Training rows* under each figure is the same metric on the rows the model learned from. The charts
below them:

| Chart | How to read it |
| --- | --- |
| **Confusion matrix** | Rows are the true class, columns the predicted one. The diagonal (orange) is correct; red cells are mistakes. **Row %** shows each true class as shares. |
| **How well the classes separate** | One curve per true class, along the model's predicted probability. Curves far apart mean confident, correct predictions. Overlap is where mistakes happen. |
| **ROC curve** | How many positives the model finds (up) for each false alarm (right). The higher the curve, the better; the diagonal is guessing. |
| **Precision vs recall** | The trade-off when you move the decision threshold: finding more positives costs precision. |
| **Are probabilities honest?** | Predicted probability against how often it came true. On the diagonal, "70%" really means 70%. |
| **Predicted vs actual** (regression) | One dot per test row. On the orange line is perfect. |
| **Errors** (regression) | Actual minus predicted, as dots. Centred on zero and narrow is best. A long tail means some rows are badly off. |
| **What drives predictions** | **Inputs**: how much the score drops when a column is shuffled (permutation importance). **Model's own**: the model's weights or split importance. The top input is in orange. |
| **Training curves** (neural networks) | Loss per epoch. When validation loss rises while training loss falls, the network is overfitting. |
| **Per class** | Precision, recall and F1 for each class, with its number of test rows. |
| **Mistakes on test images** | Wrongly classified images, with the prediction and its confidence. |
| **Tuning trials** | Every combination tried when tuning was on, and its score. The best is marked. |

**Settings used** lists the exact settings, including the ones tuning chose.
