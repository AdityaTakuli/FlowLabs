# Data

Every project starts from a dataset: a table, or a folder of images. This page covers bringing data
in and reading the Data page.

## Bring a table

Drop a file onto the spreadsheet on the home page, or click **Choose a file**. FlowLabs reads:

- **CSV, TSV and text files** (it detects the separator);
- **Excel** (`.xlsx`, `.xls`; the first sheet);
- **Parquet**;
- **JSON** and **JSON Lines**;
- a **zip** holding one of those.

A table needs at least two columns and one row. Column names are tidied: blanks get names such as
`column_3`, and repeated names get a number (`price_2`).

You can also make a dataset from a SQL query, on your data or on a database you already have. See
[SQL](guide:sql#keep-a-result-as-a-dataset).

## Bring images

For image classification, make a zip with **one folder per class**:

```text
pets.zip
├── cats/   001.jpg, 002.jpg, …
└── dogs/   001.png, 002.png, …
```

JPEG, PNG, BMP, GIF, WebP and TIFF all work. You need at least two classes. The sample
**Handwritten digits** shows the layout.

## Samples and stored datasets

The home page lists eight **samples**: small datasets that open as a project ready to train.
**Messy orders** is useful for practising cleaning, and **Card fraud** for practising class
balancing.

Every file you import is kept under **Stored datasets**, so you can start more projects from it
without importing it again. Deleting a dataset breaks the projects that use it.

## What to predict

At the top of the Data page:

- **Target column.** The column the model learns to predict.
- **Kind of problem.**
  - *Classification*: pick a category, such as yes or no, or a species.
  - *Regression*: predict a number, such as a price or a temperature.

  FlowLabs guesses this. Change it if it guessed wrong. Switching it swaps in models that can do
  the new kind.
- **Rank models by.** The score used to pick the best model. *Automatic* uses F1 (macro) for
  classification, which is fair when classes are uneven, and R² for regression. See
  [Metrics](guide:results#metrics).

Under it you see how many rows each class has (classification), or how the target is spread
(regression).

## Suggested fixes

FlowLabs reads every column and suggests fixes. Click a fix to add it to the pipeline as a step you
can still change or switch off. Fixes it applied for you are marked *in pipeline*. Typical
suggestions:

| Suggestion | Why it matters |
| --- | --- |
| A column looks like an ID | IDs carry no pattern. A model memorises them and fails on new rows. |
| A column is a date | Year, month and weekday are easier for a model to use than a raw date. |
| Numbers stored as text | `"1,200"` and `"$5"` become numbers. |
| Inconsistent spelling | `"Yes"`, `"yes "` and `"Y"` become one value. |
| Numeric columns have gaps | Gaps are filled from training rows only (the median, unless you choose). |
| Classes are unbalanced | A model can score 98% by always guessing the common class. |
| A column leaks the answer | A column that only exists after the fact (such as `refund_issued`) makes a model look perfect in tests and fail in use. |

## Distribution

Pick any number column to see how its values are spread, as **dots** (each dot is a group of rows)
or as smooth **curves**. When you predict a category with two to six classes, the chart is split by
class, in colour. Columns whose classes sit apart are the ones a model can learn from.

## Columns

One row per column:

| Column | What it tells you |
| --- | --- |
| Type | Number, category, yes/no, date or text. |
| Missing | The share of empty cells. Over 30% is shown in red. |
| Unique | How many different values. |
| Distribution | A small histogram, or the most common values. |
| Summary | The range and mean, or the top values. |
| Notes | *Looks like an ID*, *never changes*, *skewed*, *has outliers*, *many categories*, *mostly empty*… |

Click **Drop** to remove a column in the Clean stage.

Below the table, **How numbers move together** shows correlations from −1 to 1. Two columns near 1
carry the same information. **Strongest links** ranks columns by their correlation with the target.
It is only a first hint: models also find patterns a correlation cannot see.

**Rows** at the bottom pages through the raw data.
