# Sheets

**Sheets** are spreadsheets inside FlowLabs. They work like Excel: the same formulas, number
formats, shortcuts and data tools, and they open and save Excel's `.xlsx` files. Use a sheet to
tidy data, add calculated columns, summarize with a PivotTable or chart, then save the table as a
dataset and train a model on it.

Open the page with **Sheets** in the top bar. Each project also has a sheet: **Analyze → Sheet**
copies the project's data into one.

## Start a workbook

- **New workbook** opens one empty sheet.
- **Open a file** reads an Excel workbook (`.xlsx`) or a CSV file into a new workbook.
- **Open a dataset** copies a dataset into a workbook, with its header row bold and frozen. The
  dataset itself does not change. A sheet holds about two million cells; bigger datasets open with
  their first rows.

Workbooks save themselves a moment after each change. The name at the top left renames the
workbook; the arrow beside it goes back to the list.

## Type and move

Click a cell and type. **Enter** keeps the value and moves down; **Tab** moves right. After a row
typed with Tab, Enter goes back to the column you started in, one row down, as in Excel.

- Numbers can be typed as `1,234.5`, `12%`, `$5` or `1e3`; dates as `1/2/2024`, `2024-01-02` or
  `Jan 2, 2024`; times as `10:30` or `6 PM`. The cell takes a matching format.
- Start with an apostrophe (`'007`) to keep a number as text.
- **F2** edits the cell in place; **Alt+Enter** starts a new line in it.
- **Ctrl+arrow** jumps to the edge of the data; add **Shift** to select up to there.
- Click a column letter or row number to select it; drag across headers to select several.

On a Mac, use **⌘** wherever this page says **Ctrl**.

## Formulas

Start with `=`. FlowLabs calculates about 400 of Excel's functions the way Excel does, including:

| Kind | Examples |
| --- | --- |
| Math | `SUM`, `SUMIFS`, `SUMPRODUCT`, `ROUND`, `MOD`, `SUBTOTAL`, `AGGREGATE` |
| Statistics | `AVERAGE`, `COUNTIFS`, `MEDIAN`, `STDEV.S`, `PERCENTILE.INC`, `RANK.EQ`, `CORREL`, `FORECAST.LINEAR`, `NORM.DIST`, `T.TEST` |
| Lookup | `XLOOKUP`, `VLOOKUP`, `INDEX`, `MATCH`, `XMATCH`, `OFFSET`, `INDIRECT` |
| Logic | `IF`, `IFS`, `IFERROR`, `SWITCH`, `AND`, `OR`, `LET`, `LAMBDA`, `MAP`, `REDUCE` |
| Text | `TEXT`, `LEFT`, `MID`, `TEXTJOIN`, `TEXTSPLIT`, `TEXTBEFORE`, `SUBSTITUTE`, `REGEXEXTRACT` |
| Dates | `DATE`, `TODAY`, `EDATE`, `EOMONTH`, `DATEDIF`, `NETWORKDAYS`, `WORKDAY` |
| Finance | `PMT`, `FV`, `NPV`, `IRR`, `XIRR`, `RATE`, `SLN`, `DDB` |
| Dynamic arrays | `FILTER`, `SORT`, `SORTBY`, `UNIQUE`, `SEQUENCE`, `VSTACK`, `TAKE`, `GROUPBY` |

The full list is under the **fx** button beside the formula bar, by category, with what each one
takes and does.

- While you type, suggestions show matching functions; **Tab** picks one. A hint shows which
  argument you are on.
- Click cells (or use the arrow keys) while typing a formula to put their references in. Each
  reference gets a colour, in the formula and on the grid.
- **F4** cycles a reference through `A1`, `$A$1`, `A$1` and `$A1`.
- A formula that gives several values **spills** into the cells beside it (a dashed edge shows
  the area). If something is in the way it shows `#SPILL!` until you clear it.
- Refer to other sheets as `Sheet2!A1` (quote names with spaces: `'My data'!A1`).
- Name a cell or range: select it, type a name in the box at the left of the formula bar and press
  Enter. Then `=SUM(Sales)` works anywhere. **Insert → Names** lists names; a name holding a
  `LAMBDA` is a function of your own.
- Circular references show 0, as in Excel, and the bar at the bottom names the cell.

Formulas move as Excel's do: copying or filling them shifts their relative references, inserting
rows and columns moves the references that point past them, and deleting cells a formula uses turns
that part into `#REF!`.

## Copy, fill and paste

- **Ctrl+C**, **Ctrl+X**, **Ctrl+V**. Pasting from Excel, Google Sheets or a web page keeps the
  rows and columns. A cut moves the cells when you paste.
- **Ctrl+Alt+V** is Paste Special: values, formulas, formats, transposed, or skipping blanks.
- Drag the small square at the corner of the selection (the fill handle) to continue a series:
  1, 2, 3…; Jan, Feb, Mar…; Mon, Tue…; Q1, Q2…; Item 1, Item 2…; dates by day. Hold **Ctrl** to copy
  instead. Double-click it to fill down as far as the column beside has data.
- **Ctrl+D** and **Ctrl+R** fill down and right.
- **Ctrl+Enter** puts what you typed in every selected cell.

## Format

The toolbar has fonts, sizes, bold, italic, underline, strikethrough, text and fill colours,
borders, alignment, wrap text, merge cells and number formats. **Ctrl+1** opens Format Cells, which
takes any Excel number format code, such as `#,##0.00`, `0.0%`, `"$"#,##0;[Red]-"$"#,##0`,
`yyyy-mm-dd` or `[h]:mm`.

Shortcuts: **Ctrl+B/I/U**, **Ctrl+5** (strikethrough), **Ctrl+Shift+$** (currency), **%**
(percent), **!** (number), **#** (date), **@** (time), **^** (scientific), **~** (General),
**Ctrl+Shift+&** (outline border), **Ctrl+Shift+_** (no borders). **F4** repeats the last format.

Rows and columns: drag a header's edge to resize, double-click it to fit the contents. Freeze the
top rows or first columns from the rows-and-columns menu. **Ctrl+9** and **Ctrl+0** hide rows and
columns; **Ctrl+Shift+9** and **Ctrl+Shift+0** show them again.

## Data tools

From the **Data** menu:

- **Sort** by several columns, each A to Z or Z to A, by cell or font colour, or by month and day
  names; left to right too. A header row stays put.
- **Filter** (**Ctrl+Shift+L**) puts a button on each header. Choose values from a list (with
  search), or a condition (greater than, between, contains, begins with…), or the top 10 items or
  percent. `SUBTOTAL` leaves out the rows a filter hides.
- **Format as table** (**Ctrl+T**) bands the rows, adds filter buttons and names the table.
  Formulas can use its columns by name: `=SUM(Table1[Sales])`, and `=[@Units]*[@Price]` in the
  table. A formula typed into an empty column fills the whole column; typing just under or beside
  the table makes it grow.
- **PivotTable** summarizes a table: pick fields for rows, columns, values (sum, count, average,
  max, min, distinct count) and filters in the pane on the right. Refresh it after the data
  changes.
- **Chart** (**Alt+F1**): column, stacked column, bar, line, area, pie, doughnut and scatter,
  floating over the sheet. Drag to move, drag the corner to resize, double-click to edit, Delete to
  remove.
- **Text to columns** splits a column by commas, tabs, spaces or any character, or by fixed widths.
- **Remove duplicates** keeps the first of rows that repeat in the columns you choose.
- **Flash fill** (**Ctrl+E**): type one or two examples next to the data (such as `Lee, Ann` beside
  `Ann Lee`) and FlowLabs fills the rest the same way.
- **Data validation** limits what a cell takes: a list (with a drop-down, **Alt+↓**), whole
  numbers, decimals, dates, times, text length, or a formula. It can show a message when the cell is
  selected and stop, warn about or allow other values. **Circle invalid data** marks cells that
  break their rules.

**Rules** (conditional formatting) colours cells by their values: greater than, between, text that
contains, dates, duplicates, top and bottom items, above average, a formula of your own; or shows
the values themselves with data bars, colour scales and icon sets. **Manage rules** orders them.

## Find, check, print

- **Ctrl+F** finds and **Ctrl+H** replaces, in values or formulas, on one sheet or all.
- **Ctrl+G** (or **F5**) goes to a cell, range or name.
- **Ctrl+`** shows formulas instead of values; **Ctrl+[** jumps to the first cell a formula uses.
- Notes: **Shift+F2**. A red corner marks a cell with a note.
- The bar at the bottom shows the sum, average and count of the selected cells.
- **Ctrl+P** prints the sheet.

## Excel and CSV files

**File → Download as Excel** saves an `.xlsx` that Excel, Google Sheets, Numbers and LibreOffice
open: values, formulas, number formats, fonts, fills, borders, alignment, merged cells, column
widths, row heights, frozen panes, filters, tables, data validation, conditional formatting and
names. **Download this sheet as .csv** saves the values as they show.

**File → Import** adds the sheets of an `.xlsx` or `.csv` file to the workbook you have open.

Not carried over from Excel files: VBA macros (FlowLabs never runs them), pictures and charts
drawn in Excel, sparklines, and slicers.

## From a sheet to a model

Select a table (or a cell inside one) and choose **Save as dataset**. The first row names the
columns; the values are saved as they show, with formulas giving their results and dates kept as
dates. In a project's **Analyze → Sheet**, FlowLabs then offers to use it as the project's data.

## Ask the AI

Open the AI panel with **Ctrl+L** or the **AI** button in the top bar and describe what you want:
*add a total under the numbers*, *a column with each row's share*, *explain the formulas I selected*,
*summarize this sheet on a new sheet*. It writes the values and formulas into the cells and selects
them; **Undo** in the panel (or Ctrl+Z) takes the change back. It sees the sheet's names, its first
rows, its last row and the cells you select. See
[the AI panel](guide:sql#the-ai-panel) for setting up a provider.

## Keyboard shortcuts

| Keys | Does |
| --- | --- |
| Ctrl+Z, Ctrl+Y | Undo, redo |
| Ctrl+Space, Shift+Space | Select the column, the row |
| Ctrl+A | Select the data around the cell, then the whole sheet |
| Ctrl+Home, Ctrl+End | The first cell, the last used cell |
| Ctrl+PageUp, Ctrl+PageDown | The previous and next sheet |
| Shift+F11 | A new sheet |
| Ctrl+- , Ctrl+Shift+= | Delete, insert rows or columns |
| Ctrl+;, Ctrl+Shift+; | Today's date, the time now |
| Alt+= | AutoSum |
| Shift+F3 | Insert a function |
| Ctrl+F3 | Names |
| Shift+F10 | The right-click menu |
| F9 | Calculate everything again |
| Ctrl+O, Ctrl+N | Import a file, a new workbook |
| Ctrl+F1 | Hide or show the toolbar |
| Ctrl+L | Open the AI panel |
