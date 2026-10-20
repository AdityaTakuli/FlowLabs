# Databases

The **Databases** page works with PostgreSQL, MySQL and MariaDB servers (and SQLite files) the way
pgAdmin and MySQL Workbench do. You can browse tables, run queries, edit rows, read query plans and
manage users, then bring any result into a project to train models on it.

Open it with **Databases** in the top bar. Connections are listed on the left; tables, queries and
admin views open as tabs on the right.

## Connect

Choose **Connect**, pick the kind of database, and fill in its host, port, database, user and
password. **Test** checks the connection before you save it. If the database's Python driver is
missing, the dialog offers to install it.

- **Allow changes to this database.** Off by default. A read-only connection refuses statements
  that write, and its session on the server is read-only too (`SET SESSION ... READ ONLY`). A
  function that writes cannot slip through either. Turn it on to run INSERT, UPDATE and CREATE, edit
  rows, import data and manage users.
- **Encryption (SSL).** PostgreSQL connects with SSL when the server offers it. MySQL and MariaDB
  need it switched on. Choose **Require and check the certificate** to verify the server, with your
  provider's CA certificate file, or leave the file empty to use the certificates this computer
  trusts.
- **Connect through SSH.** For a database that only accepts connections from inside its own
  network. FlowLabs signs in to the SSH server (with a key file, a password or your SSH agent) and
  reaches the database through it, as `ssh -L` would. The first time, it shows the SSH server's key
  fingerprint. If it matches the one your administrator gives you, choose **Trust this server**.
  If that key ever changes, FlowLabs refuses to connect until you check it.

Passwords and keys are kept in this computer's keychain (macOS Keychain, Windows Credential
Manager, or the Secret Service on Linux), never in the connection file. On a system without one
they go in a file in the workspace that only your user account can read. Connections are shared
with each project's [SQL view](guide:sql#sql).

## Browse

Open a connection to see its databases. On PostgreSQL each database holds schemas; on MySQL and
MariaDB a database is the schema. Each schema lists its **tables, views, functions, procedures,
triggers and sequences**, with an estimate of each table's rows.

- **Find a table** filters what is open.
- **System** shows the system databases and schemas (`mysql`, `pg_catalog`...).
- The **+** next to a connection or database opens a query tab there.

Click a table or view to open it. It has four parts:

| Part | What it shows |
| --- | --- |
| **Data** | The rows, 200 at a time. Click a column to sort; type a condition after **WHERE** and press <kbd>Enter</kbd> to filter. |
| **Columns** | Each column's type, whether it may be empty, its default and comment. |
| **Keys and indexes** | The primary key, indexes, foreign keys, unique constraints and checks. |
| **SQL** | The table's CREATE statement, to copy or open in a query tab. |

Functions, procedures, triggers and sequences open as their CREATE statement.

## Query

A query tab is an editor with its own connection to the server, so `SET`, `USE`, temporary tables
and transactions last from one run to the next, as in a database console.

- <kbd>Ctrl</kbd>+<kbd>Enter</kbd> (<kbd>⌘</kbd>+<kbd>Enter</kbd> on a Mac) runs the statement
  under the cursor, or the selection.
- <kbd>Shift</kbd>+<kbd>Ctrl</kbd>+<kbd>Enter</kbd> (**Run all**) runs every statement in order.
- **Stop** asks the server to cancel the running query (`pg_cancel_backend`, `KILL QUERY`).
- Each statement that returns rows gets a **Result** tab. **Messages** lists every statement with
  its time and how many rows it changed. An error says which line, and the line is marked in the
  editor. Nothing after an error runs.
- **Rows** sets how many rows each result shows (500 at first). Only those rows leave the server,
  so a query over a huge table stays fast. **Export** gets them all.
- Scripts may use `DELIMITER $$` (as in the mysql client), and procedure and trigger bodies with
  semicolons in them run whole.
- The clock button lists the queries you ran on this connection. Click one to put it back in the
  editor.

### Transactions

With **Auto-commit** on (the default), every statement is saved as it runs. Turn it off, and the
first statement starts a transaction: **Transaction open** appears, and nothing is saved until you
choose **Commit**. **Roll back** undoes everything since. You can also write `BEGIN`, `COMMIT` and
`ROLLBACK` yourself.

### Export and keep a result

**Export** runs the statement under the cursor in full and downloads the result as **CSV**,
**Excel**, **JSON** or **Parquet**.

**Save as a dataset for a project** keeps the whole result as a FlowLabs dataset. Start a project
from it on the Projects page to clean it, train models on it and predict.

### Query plans

**Explain** shows how the database plans to run the statement under the cursor, as a tree: each
step, the rows it expects, and a bar comparing the steps. **Explain and run** runs the statement and
shows what really happened, with times and actual row counts. A statement that writes is rolled
back afterwards. Steps that read a whole large table are marked, with a hint about indexes. **Show
the database's output** shows the plan exactly as the server printed it.

## Edit rows

On a connection that allows changes, a table with a primary key can be edited in its **Data** part:

- Double-click a cell to change it. <kbd>Enter</kbd> keeps the change, <kbd>Esc</kbd> drops it, and
  **NULL** empties the cell.
- **Add row** adds a row at the top. Cells you leave blank get the column's default.
- The bin at the start of a row marks it for deletion; click again to keep it.

Changed cells are tinted until you save. **Review and save** shows the exact SQL first. Everything
then runs in one transaction. If someone else changed or deleted one of the rows since you loaded
it, nothing is saved, and you are asked to reload.

Tables without a primary key, and views, are read-only here: write the UPDATE yourself in a query
tab.

### Import a dataset as a table

The upload button next to a database (MySQL) or schema (PostgreSQL), or **Import** on a table,
copies one of your FlowLabs datasets into the database. Choose to stop if the table exists, add the
rows, or replace the table.

## Server activity and users

The menu next to a connection has two admin views.

**Server activity** shows how many connections are open, how long the server has been up, the
database's size, and every session with what it is running. **Stop query** cancels a session's
query. **End session** disconnects it, and its open transaction is rolled back. It refreshes every
3 seconds; **Show idle** includes sessions that are doing nothing.

**Users and roles** lists the server's users (MySQL, MariaDB) or roles (PostgreSQL). Choose one to
see what it may do: its grants on MySQL; its attributes, memberships and database, schema and
table privileges on PostgreSQL. On a connection that allows changes you can create users, change
passwords, **Grant** and **Revoke** privileges, and delete users. Every change shows its SQL before
it runs, with passwords hidden.

> **Tip.** Connect FlowLabs with a user that has only the rights you need. A read-only database
> user, plus a read-only connection, means nothing can change by accident.

## Good to know

- Queries run on the computer the FlowLabs engine runs on, so that computer must be able to reach
  the database (or its SSH server).
- The browser version cannot reach a database server. Use the desktop app, or connect the browser
  page to [`flowlabs engine`](guide:engines).
- Results and plans stay on your computer. Ask AI (in a project's SQL view) sends only table and
  column names.
