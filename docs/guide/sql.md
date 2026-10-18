# Analyze: table, SQL and Ask AI

Every project has an **Analyze** tab, between Data and Pipeline, for working with the data
directly. It has two views, switched with the tabs at its top: **Table** and **SQL**.

## Table

The whole dataset as a grid, 100 rows at a time:

- **Sort:** click a column's name for smallest first, again for largest first, and a third time to
  stop sorting.
- **Search:** type in **Search every column**. Rows that contain the text in any column are kept.
- **Page:** the arrows move through the rows. The count says how many rows there are, and how many
  match a search.

The column you predict is tinted orange. **Open in SQL** opens the current view (search and sort
included) as a SQL query you can build on.

## SQL

Write a query and press **Run** (or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>; <kbd>⌘</kbd>+<kbd>Enter</kbd>
on a Mac). The first 500 rows of the result are shown, with the total row count and the time taken.

Inside a project, **`data` is this project's table**. Your other datasets are tables too: each
one's name is the dataset's name in lower case with spaces as underscores, so **Iris flowers** is
`iris_flowers`. The list on the left shows every table and its row count. Click the arrow to see the
columns, and click a name to insert it into the query.

```sql
-- churn rate by plan and contract
select plan_type, contract,
       count(*)                              as customers,
       round(avg(churned::int) * 100, 1)     as churn_pct
from data
group by all
order by churn_pct desc
```

Queries run in [DuckDB](https://duckdb.org/docs/sql/introduction), so the full SQL dialect is
there:

- joins with your other datasets;
- window functions;
- `group by all`;
- `qualify`;
- date functions;
- `pivot`.

Several statements separated by `;` run in order, and the last one's result is shown. The editor
completes table names, column names and SQL keywords.

> **Your files never change.** Queries run on copies of your data, in memory. To keep a result,
> save it as a dataset.

## Ask AI

Type a question in plain English above the editor, such as *churn rate by contract type*, and press
**Write SQL**. A model on [Groq](https://groq.com) writes the query, FlowLabs puts it in the editor
and runs it, and a sentence explains what it returns. Check the query, and change it as you like.

When a query fails, **Fix with AI** sends the query and the error message, and gets back a
corrected query.

**Set up:** the first time, click **Set up Ask AI**, and paste a Groq API key. You can get one free
at [console.groq.com/keys](https://console.groq.com/keys). Choose the model in the same dialog. The
key is saved on the engine, in a file only your user account can read. If the `GROQ_API_KEY`
environment variable is set, FlowLabs uses it instead.

**What is sent to Groq:**

- your question;
- the names of the tables and columns, with their types;
- up to three common values of each category column, so the model spells categories right.

Columns where almost every value is different (IDs, names, emails) send no examples. Rows of data
are never sent.

Ask AI needs the desktop app or an engine. The browser version cannot reach Groq.

## Keep a result as a dataset

After a query, click **Save as dataset** and give it a name. The query runs again in full, so every
row is saved, not only the 500 shown. Then:

- **Use as this project's data** makes the project train on the result. The old dataset is kept.
  Steps that use columns the result lacks are marked on the Pipeline page.
- The dataset is also listed on the home page, under **Stored datasets**, for other projects.

This is the quickest way to prepare training data that needs joins or aggregation. Examples:

- one row per customer from an orders table;
- features computed with window functions;
- a filtered or sampled table.

## Connect a database

Click **Connect a database** and choose its type:

| Database | You enter |
| --- | --- |
| PostgreSQL | host, port (5432), database name, user, password |
| MySQL or MariaDB | host, port (3306), database name, user, password |
| SQLite file | the path of the file |
| DuckDB file | the path of the file |
| Other | any [SQLAlchemy URL](https://docs.sqlalchemy.org/en/20/core/engines.html#database-urls), such as Snowflake, SQL Server or Oracle. Install the database's Python driver in the engine first. |

**Test** checks the connection and shows the server's version. **Save connection** adds it to the
list on the left, in every project. Select it to see its tables and query it the same way, with Ask
AI too. Save a result as a dataset to bring that data into the project.

### Read-only or changes allowed

A new connection is **read-only**:

- statements that change the database (`insert`, `update`, `delete`, `create`, `drop`…) are
  refused;
- anything a query did is rolled back.

To change data, edit the connection and switch on **Allow changes to this database**. Statements
then run and are committed.

### Scripts, triggers and procedures

Run several statements at once, separated by semicolons. They run in order, on the same
connection, so `USE other_database;` changes where the next ones run.

`CREATE TRIGGER`, `PROCEDURE`, `FUNCTION` and `EVENT` bodies can hold semicolons between `BEGIN`
and `END`. Scripts copied from MySQL Workbench or the mysql client work as they are,
`DELIMITER $$` lines included:

```sql
DELIMITER $$
create trigger employee_insert after insert on employee_salary for each row
begin
    insert into employee_demographics(employee_id, first_name, last_name)
    values (new.employee_id, new.first_name, new.last_name);
end $$
DELIMITER ;
```

Creating one changes the database, so it needs **Allow changes to this database**.

### Where connections are kept

Connections, passwords included, are saved in the engine's workspace, in `connections.json`, which
only your user account can read. Passwords are never sent back to the page. Leave the password blank
when editing a connection to keep the current one.

Queries run on the computer the engine runs on. With an [engine](guide:engines) on another
machine, "localhost" means that machine.

## In the browser version

The browser version has the Table and SQL views on your datasets, and loads DuckDB the first time.
It cannot reach database servers or Groq, because browsers do not allow it. Use the desktop app, or
connect the page to a `flowlabs engine`.
