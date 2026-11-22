# Pipeline

The Pipeline page draws everything that happens between your raw data and a trained model, left to
right:

```text
Data → Clean → Split → Training rows → Transform → Models → Results
```

Click any box to change it in the panel on the right. The coloured chips along the top jump to a
stage. On a phone, the panel opens as a sheet from the bottom.

## The stages

| Stage | Runs on | What it is for |
| --- | --- | --- |
| **Clean** | the whole table, and new data when predicting | Fix the table: drop columns, change types, tidy text, filter rows. |
| **Split** | the whole table | Keep some rows aside to test the models honestly. |
| **Training rows** | training rows only | Change which rows the models learn from: balance classes, remove outliers. |
| **Transform** | learned from training rows, applied to every row | Prepare the numbers: fill gaps, encode categories, scale, select features. |
| **Models** | the prepared training rows | The models to train and compare. |

The difference between **Clean** and **Transform** matters. Anything that *learns* from the data,
such as the median used to fill gaps or the scale of each column, belongs in Transform. There it
learns from training rows only, so the test rows stay unseen. FlowLabs places each step in the
right stage for you.

## Add, change and order steps

- **Add a step:** click **Add a clean step**, **Add a training-set step** or **Add a transform** at
  the end of a stage, and pick from the list. Search finds a step by name or description.
- **Change it:** select the step. Its settings are on the right. Hover over a setting for help.
- **Switch it off:** use the **On / Off** switch to compare with and without it, without losing
  your settings.
- **Order:** the arrows run a step earlier or later. Steps run top to bottom.
- **Remove it:** the bin icon.

**Preview**, at the bottom, shows the table after the selected step: changed columns in orange,
new ones in green, and how many rows remain.

Every step is listed with its settings in the [Steps and models reference](guide:reference).

## Split

How rows are divided between training and testing:

- **Test share.** The share of rows kept for testing, 20% by default (5% to 60% allowed).
- **Order.**
  - *Random* suits most data.
  - *By time (test = latest)* is for forecasting: the models are tested on the future, not the
    past. Choose the date column that orders the rows.
- **Keep class shares equal (stratify).** Each part gets the same mix of classes. On by default
  for classification.
- **Cross-validation on training rows.** Off by default, or 3, 5 or 10 folds. Each model is also trained
  and scored that many times on parts of the training rows. You see how steady it is, not just one
  number.
- **Random seed.** The same seed gives the same split, so runs stay comparable.

## Auto-prep

**Auto-prep** (on by default) makes the table model-ready after your transforms:

- numbers only, with no gaps;
- categories become one column per value, or frequencies when there are many values;
- yes/no becomes 1/0;
- dates become year, month and weekday;
- IDs are dropped.

Models that need scaled inputs (linear models, SVM, k-NN, neural networks) are also standardised
when you have not added a Scale step. Select it to see exactly what it will do to each column. Turn
it off only when your own transforms already produce numbers.

## Models

Four models are set up for you. Click **Add a model** to choose more, grouped by family: linear,
trees, boosting, kernel, instance-based, probabilistic, deep learning, and your own Python. A model
that needs a package your engine lacks (such as XGBoost) says so. See
[Engines](guide:engines#python-environments).

For each model you can:

- **Change its settings.** Every setting has a short explanation.
- **Tune it automatically.** *Quick* tries 8 combinations of settings, *Thorough* tries 25. Each
  try is scored with cross-validation on the training rows, and the best is used.
- **Duplicate it** to compare two settings side by side.
- **Skip it** with the switch, to keep it without training it.

**Neural network** lets you build the layers yourself (dense, dropout, batch norm), with a diagram
that updates as you edit. It trains on the GPU when the engine has one.

## Image projects

Image projects have a **Resize & augment** step instead of Clean and Transform:

- image size;
- grayscale;
- normalisation (ImageNet statistics, or 0 to 1);
- augmentations for training only: mirror, flip, rotate, colour jitter, random crop.

The models are a **Custom CNN** you can shape, or a **Pretrained network** (transfer learning),
which learns well from a few hundred images. Image models need PyTorch, so use the desktop app or an
engine.

## Problems

When something stops the pipeline from training, such as a step that uses a column you dropped, or
a test share that leaves too few rows, it is listed at the top left of the canvas. The step is
outlined in red. Warnings (orange) still let you train.

## Edit any step as Python

Every step and model has a **Python** view next to **Settings**: the code it runs, with your
settings. **Edit as code** turns it into a code step you can change line by line. See
[Code steps](guide:code).

## The AI panel in a project

Open the **AI panel** (the **AI** button in the top bar, or **Ctrl+L**) and describe a change. It
sees the target, the metric, each step and model with its settings, and the last results, and it
uses the same steps and models as the **Add** menus:

- *drop the ID column*, *fill missing ages with the median*: adds a step at the end of its stage;
- *try extra trees with 400 trees*, *add the models that suit my data*: adds models;
- *turn off the baseline*, *tune the random forest*: changes a model or a step;
- *predict price instead*, *rank models by accuracy*: sets the target or the metric;
- *… and train*: starts training once the other changes are made.

Each change appears in the panel with what it set, and with **Undo**, which takes back that change
only: steps you added by hand afterwards stay. Settings a step does not have are left out and named
in the panel, and anything the AI names that does not exist (a step, a model, a column ID) is not
applied. Code steps are not changed from the panel: edit them in their **Python** view.
