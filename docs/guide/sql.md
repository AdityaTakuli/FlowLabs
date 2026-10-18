# SQL

The **SQL** page, next to Projects in the top bar, lets you explore and reshape data with SQL. You
can query your own datasets, or a database you already have, and keep any result as a dataset to
train on.

## Query your datasets

Every table dataset is a SQL table. Its name is the dataset's name in lower case, with spaces as
underscores: **Customer churn** is `customer_churn`, and **Iris flowers** is `iris_flowers`. The
list on the left shows every table, with its row count. Click the arrow to see the columns and their
types. Click a table or column name to insert it into the query.

Write a query and press **Run** (or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>; <kbd>⌘</kbd>+<kbd>Enter</kbd>
on a Mac). The first 500 rows of the result are shown, with the total row count and the time taken.

```sql
-- churn rate by plan and contract
select plan_type, contract,
       count(*)                              as customers,
       round(avg(churned::int) * 100, 1)     as churn_pct
from customer_churn
group by all
order by churn_pct desc
```

Queries on your datasets run in [DuckDB](https://duckdb.org/docs/sql/introduction), so you get the
full SQL dialect:

- joins between datasets;
- window functions;
- `group by all`;
- `qualify`;
- date functions;
- `pivot`.

Several statements separated by `;` run in order, and the last one's result is shown. You can
create temporary tables along the way.

> **Your files never change.** Queries run on copies of your datasets, in memory. To keep a result,
> save it as a dataset.

The editor completes table names, column names and SQL keywords as you type. When a query fails,
the message says why, and the line is highlighted when the database says where.

## Keep a result as a dataset

After a query, click **Save as dataset** and give it a name. The query runs again in full, so every
row is saved, not only the 500 shown. Then **Start a project with it** opens a new project on that
data.

This is the quickest way to prepare training data that needs joins or aggregation. Examples:

- one row per customer from an orders table;
- features computed with window functions;
- a sample of a large table.

## Connect a database

Click **Connect a database** and choose its type:

| Database | You enter |
| --- | --- |
| PostgreSQL | host, port (5432), database name, user, password |
| MySQL or MariaDB | host, port (3306), database name, user, password |
| SQLite file | the path of the file |
| DuckDB file | the path of the file |
| Other | any [SQLAlchemy URL](https://docs.sqlalchemy.org/en/20/core/engines.html#database-urls), such as SQL Server or Oracle. Install the database's Python driver in the engine first. |

**Test** checks the connection and shows the server's version. **Save connection** adds it to the
list. Select a connection to see its tables, and query it the same way. Results can be saved as
datasets too, which is how you bring data from a database into a project.

### Read-only or changes allowed

A new connection is **read-only**:

- statements that change the database (`insert`, `update`, `delete`, `create`, `drop`…) are
  refused;
- anything a query did is rolled back.

To change data, edit the connection and switch on **Allow changes to this database**. Statements
then run and are committed.

### Where connections are kept

Connections, passwords included, are saved in the engine's workspace, in `connections.json`.
Only your user account can read that file. Passwords are never sent back to the page. Leave the
password blank when editing a connection to keep the current one.

Queries run on the computer the engine runs on. With an [engine](guide:engines) on another
machine, "localhost" means that machine.

## In the browser version

The browser version queries your datasets the same way, and loads DuckDB the first time. It cannot
reach database servers, because browsers do not allow it. Use the desktop app, or connect the page
to a `flowlabs engine`.
