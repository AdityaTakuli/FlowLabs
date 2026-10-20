"""Where data can come from: one definition per kind of source.

Each source declares the fields of its Connect form (the app draws the form from them), the Python
packages it needs (installed on first use, see plugins.py), and how to connect:

* ``sqlalchemy``: databases and warehouses (PostgreSQL, MySQL, SQL Server, Oracle, Redshift,
  Snowflake, BigQuery, Databricks, SQLite, any SQLAlchemy URL). Queries run in the database.
* ``duckdb``: a DuckDB database file.
* ``storage``: files in cloud storage (Amazon S3 and S3-compatible stores, Azure Blob Storage and
  Data Lake, Google Cloud Storage). DuckDB reads Parquet, CSV and JSON there directly, together with
  your datasets: ``select * from 's3://bucket/sales/*.parquet'``.

Secret fields (passwords, keys, tokens) are kept by vault.py, never in connections.json.
"""

from __future__ import annotations

import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from . import plugins
from .util import UserError


@dataclass(frozen=True)
class Field:
    name: str
    label: str
    kind: str = "text"  # text, password, number, path, select, bool, textarea
    required: bool = False
    default: Any = None
    placeholder: str = ""
    help: str = ""
    options: tuple[tuple[str, str], ...] = ()
    secret: bool = False
    #: show only when another field has one of these values: ("auth", ("keys",))
    when: tuple[str, tuple[Any, ...]] | None = None


@dataclass(frozen=True)
class Source:
    id: str
    label: str
    group: str
    engine: str  # sqlalchemy, duckdb, storage
    fields: tuple[Field, ...]
    packages: tuple[str, ...] = ()
    modules: tuple[str, ...] = ()
    #: CodeMirror's SQL dialect for the editor
    editor: str = "standard"
    #: what Ask AI is told the dialect is
    dialect: str = "standard SQL"
    about: str = ""
    docs: str = ""
    size_mb: int = 0
    extra: dict[str, Any] = field(default_factory=dict)


_SSH_ON = ("ssh", (True,))


def _ssh() -> tuple[Field, ...]:
    """Connect through an SSH server (see tunnel.py)."""
    return (
        Field("ssh", "Connect through SSH", "bool", default=False,
              help="For a database that only accepts connections from inside its own network."),
        Field("ssh_host", "SSH server", required=True, placeholder="bastion.example.com", when=_SSH_ON),
        Field("ssh_port", "SSH port", "number", default=22, when=_SSH_ON),
        Field("ssh_user", "SSH user", required=True, when=_SSH_ON),
        Field("ssh_auth", "Sign in to SSH with", "select", default="key", when=_SSH_ON,
              options=(("key", "A key file"), ("password", "A password"), ("agent", "My SSH agent or default keys"))),
        Field("ssh_key", "Key file", "path", placeholder="~/.ssh/id_ed25519", when=("ssh_auth", ("key",))),
        Field("ssh_passphrase", "Key passphrase (if it has one)", "password", secret=True, when=("ssh_auth", ("key",))),
        Field("ssh_password", "SSH password", "password", secret=True, when=("ssh_auth", ("password",))),
        Field("ssh_fingerprint", "Trusted server key", when=_SSH_ON, placeholder="SHA256:…",
              help="Filled in when you trust the server the first time. Servers in ~/.ssh/known_hosts need nothing."),
    )  # fmt: skip


def _host(port: int, *, database: str = "Database name", required_db: bool = False) -> tuple[Field, ...]:
    return (
        Field("host", "Host", required=True, placeholder="db.example.com"),
        Field("port", "Port", "number", default=port),
        Field("database", database, required=required_db),
        Field("user", "User"),
        Field("password", "Password", "password", secret=True),
    )


SOURCES: dict[str, Source] = {
    s.id: s
    for s in [
        # -------------------------------------------------------------------------- databases
        Source("postgresql", "PostgreSQL", "Databases", "sqlalchemy",
               (*_host(5432),
                Field("sslmode", "Encryption (SSL)", "select", default="prefer",
                      options=(("prefer", "Use when available"), ("require", "Require"),
                               ("verify-ca", "Require and check the certificate"),
                               ("verify-full", "Require and check the certificate and host name"), ("disable", "Off"))),
                Field("sslrootcert", "CA certificate file", "path", when=("sslmode", ("verify-ca", "verify-full")),
                      help="Leave empty to use the certificates trusted by this computer."),
                *_ssh()),
               packages=("psycopg[binary]",), modules=("psycopg",), editor="postgresql", dialect="PostgreSQL",
               about="Also Supabase, Neon, Amazon RDS and Aurora, Azure Database for PostgreSQL, Cloud SQL."),
        Source("mysql", "MySQL or MariaDB", "Databases", "sqlalchemy",
               (*_host(3306),
                Field("ssl_mode", "Encryption (SSL)", "select", default="off",
                      options=(("off", "Off"), ("require", "Require"),
                               ("verify_ca", "Require and check the certificate"),
                               ("verify_identity", "Require and check the certificate and host name"))),
                Field("ssl_ca", "CA certificate file", "path", when=("ssl_mode", ("verify_ca", "verify_identity")),
                      help="Leave empty to use the certificates trusted by this computer."),
                *_ssh()),
               packages=("pymysql",), modules=("pymysql",), editor="mysql", dialect="MySQL",
               about="Also Amazon RDS and Aurora MySQL, Azure Database for MySQL, PlanetScale."),
        Source("sqlserver", "Microsoft SQL Server", "Databases", "sqlalchemy", (*_host(1433), *_ssh()),
               packages=("pymssql",), modules=("pymssql",), editor="mssql", dialect="SQL Server (T-SQL)", size_mb=5,
               about="Also Azure SQL Database and Azure Synapse dedicated pools."),
        Source("oracle", "Oracle", "Databases", "sqlalchemy",
               (Field("host", "Host", required=True), Field("port", "Port", "number", default=1521),
                Field("service", "Service name", required=True, placeholder="ORCLPDB1"),
                Field("user", "User"), Field("password", "Password", "password", secret=True)),
               packages=("oracledb",), modules=("oracledb",), editor="plsql", dialect="Oracle SQL", size_mb=10,
               about="Connects directly, without Oracle Instant Client."),
        Source("sqlite", "SQLite file", "Databases", "sqlalchemy",
               (Field("database", "File", "path", required=True, placeholder="/home/me/data/shop.sqlite"),),
               editor="sqlite", dialect="SQLite"),
        Source("duckdb", "DuckDB file", "Databases", "duckdb",
               (Field("database", "File", "path", required=True, placeholder="/home/me/data/warehouse.duckdb"),),
               editor="postgresql", dialect="DuckDB (like PostgreSQL)"),
        # ------------------------------------------------------------------------- warehouses
        Source("snowflake", "Snowflake", "Warehouses", "sqlalchemy",
               (Field("account", "Account identifier", required=True, placeholder="myorg-myaccount",
                      help="From your Snowflake URL: myorg-myaccount.snowflakecomputing.com"),
                Field("user", "User", required=True),
                Field("auth", "Sign in with", "select", default="password",
                      options=(("password", "Password"), ("externalbrowser", "Single sign-on in the browser"))),
                Field("password", "Password", "password", secret=True, when=("auth", ("password",))),
                Field("warehouse", "Warehouse", placeholder="COMPUTE_WH"),
                Field("database", "Database"), Field("schema", "Schema", placeholder="PUBLIC"), Field("role", "Role")),
               packages=("snowflake-sqlalchemy",), modules=("snowflake.sqlalchemy", "snowflake.connector"),
               editor="standard", dialect="Snowflake SQL", size_mb=60, docs="https://docs.snowflake.com/en/user-guide/admin-account-identifier"),
        Source("bigquery", "Google BigQuery", "Warehouses", "sqlalchemy",
               (Field("project", "Project ID", required=True, placeholder="my-project-123"),
                Field("dataset", "Default dataset", placeholder="analytics"),
                Field("auth", "Sign in with", "select", default="gcloud",
                      options=(("gcloud", "My Google login (gcloud auth application-default login)"), ("keyfile", "A service account key file"))),
                Field("keyfile", "Service account key (JSON file)", "path", when=("auth", ("keyfile",)))),
               packages=("sqlalchemy-bigquery",), modules=("sqlalchemy_bigquery", "google.cloud.bigquery"),
               editor="standard", dialect="BigQuery Standard SQL", size_mb=40),
        Source("redshift", "Amazon Redshift", "Warehouses", "sqlalchemy", (*_host(5439, required_db=True), *_ssh()),
               packages=("psycopg[binary]",), modules=("psycopg",), editor="postgresql", dialect="Amazon Redshift (like PostgreSQL)",
               about="Use the cluster or workgroup endpoint, without the port and database."),
        Source("databricks", "Databricks", "Warehouses", "sqlalchemy",
               (Field("host", "Server hostname", required=True, placeholder="adb-1234567890.12.azuredatabricks.net"),
                Field("http_path", "HTTP path", required=True, placeholder="/sql/1.0/warehouses/abc123"),
                Field("token", "Access token", "password", required=True, secret=True),
                Field("catalog", "Catalog", placeholder="main"), Field("schema", "Schema", placeholder="default")),
               packages=("databricks-sqlalchemy",), modules=("databricks.sqlalchemy",), editor="standard",
               dialect="Databricks SQL", size_mb=60, about="A SQL warehouse's details are under Connection details."),
        # ---------------------------------------------------------------------- cloud storage
        Source("s3", "Amazon S3", "Cloud storage", "storage",
               (Field("bucket", "Bucket", required=True, placeholder="my-data"),
                Field("prefix", "Folder (optional)", placeholder="sales/2026/"),
                Field("region", "Region", placeholder="eu-west-1"),
                Field("auth", "Sign in with", "select", default="keys",
                      options=(("keys", "Access key"), ("chain", "My AWS login (profile, SSO or environment)"), ("public", "Public bucket"))),
                Field("key_id", "Access key ID", when=("auth", ("keys",))),
                Field("secret", "Secret access key", "password", secret=True, when=("auth", ("keys",))),
                Field("endpoint", "Endpoint (S3-compatible only)", placeholder="minio.local:9000",
                      help="Leave empty for AWS. For MinIO, Cloudflare R2, Wasabi and others."),
                Field("ssl", "Use HTTPS", "bool", default=True)),
               editor="postgresql", dialect="DuckDB (like PostgreSQL), reading files with read_parquet, read_csv and read_json",
               about="Parquet, CSV and JSON files, Delta and Iceberg tables.", extra={"scheme": "s3", "extension": "httpfs"}),
        Source("azure", "Azure Blob Storage / Data Lake", "Cloud storage", "storage",
               (Field("account", "Storage account", required=True, placeholder="mystorageaccount"),
                Field("container", "Container", required=True, placeholder="data"),
                Field("prefix", "Folder (optional)", placeholder="sales/"),
                Field("auth", "Sign in with", "select", default="connection",
                      options=(("connection", "Connection string"), ("chain", "My Azure login (az login)"), ("public", "Public container"))),
                Field("connection_string", "Connection string", "password", secret=True, when=("auth", ("connection",)),
                      help="Storage account, Security + networking, Access keys.")),
               editor="postgresql", dialect="DuckDB (like PostgreSQL), reading files with read_parquet, read_csv and read_json",
               about="Blob Storage and Data Lake Storage Gen2.", extra={"scheme": "az", "extension": "azure"}),
        Source("gcs", "Google Cloud Storage", "Cloud storage", "storage",
               (Field("bucket", "Bucket", required=True), Field("prefix", "Folder (optional)"),
                Field("key_id", "HMAC access key", required=True, help="Cloud Storage, Settings, Interoperability."),
                Field("secret", "HMAC secret", "password", required=True, secret=True)),
               editor="postgresql", dialect="DuckDB (like PostgreSQL), reading files with read_parquet, read_csv and read_json",
               extra={"scheme": "gs", "extension": "httpfs"}),
        # ------------------------------------------------------------------------------ other
        Source("url", "Other (SQLAlchemy URL)", "Other", "sqlalchemy",
               (Field("url", "Database URL", "password", required=True, secret=True,
                      placeholder="mssql+pyodbc://user:password@host/db?driver=ODBC+Driver+18+for+SQL+Server",
                      help="Any SQLAlchemy URL. Install the database's Python driver in the engine first."),),
               about="Any database with a SQLAlchemy dialect: ClickHouse, Trino, Exasol, Teradata, SAP HANA..."),
    ]
}  # fmt: skip

STORAGE_FILES = (
    ".parquet",
    ".pq",
    ".csv",
    ".tsv",
    ".txt",
    ".json",
    ".jsonl",
    ".ndjson",
    ".csv.gz",
    ".json.gz",
    ".parquet.gz",
)


def get(kind: str) -> Source:
    source = SOURCES.get(kind)
    if source is None:
        raise UserError("choose what to connect to")
    return source


def describe() -> list[dict[str, Any]]:
    """Every source for the Connect form, with the drivers it still lacks here."""
    from . import tunnel

    out = []
    ssh_needs = plugins.missing(list(tunnel.MODULES))
    for source in SOURCES.values():
        needs = plugins.missing(list(source.modules)) if source.modules else []
        out.append({**{k: v for k, v in asdict(source).items() if k != "extra"}, "kind_label": source.label,
                    "needs": needs, "installable": bool(needs) and sys.platform != "emscripten",
                    "browser": source.engine == "duckdb" or source.id == "sqlite",
                    "ssh_needs": ssh_needs if any(f.name == "ssh" for f in source.fields) else []})  # fmt: skip
    return out


def visible(source: Source, values: dict[str, Any]) -> list[Field]:
    """The fields that apply, given the choices made in select and on/off fields. A field that
    depends on a hidden one is hidden too (the SSH key file, when SSH is off)."""
    shown: list[Field] = []
    names: set[str] = set()
    for item in source.fields:
        if item.when is not None:
            other, allowed = item.when
            if other not in names:
                continue
            current = values.get(other)
            if current in (None, ""):
                current = next((f.default for f in source.fields if f.name == other), None)
            if current not in allowed:
                continue
        shown.append(item)
        names.add(item.name)
    return shown


def clean(source: Source, given: dict[str, Any], secrets_now: dict[str, str]) -> tuple[dict[str, Any], dict[str, str]]:
    """Checked values and secrets from a Connect form. A blank secret keeps the saved one."""
    values: dict[str, Any] = {}
    secrets: dict[str, str] = {}
    for item in visible(source, given):
        raw = given.get(item.name)
        if item.secret:
            text = "" if raw is None else str(raw)
            if text and "***" not in text:
                secrets[item.name] = text
            elif secrets_now.get(item.name):
                secrets[item.name] = secrets_now[item.name]
            if item.required and not secrets.get(item.name):
                raise UserError(f"enter the {item.label.lower()}")
            continue
        if item.kind == "bool":
            values[item.name] = bool(item.default if raw is None else raw)
            continue
        text = str(raw).strip() if raw not in (None, "") else ""
        if not text and item.default not in (None, ""):
            text = str(item.default)
        if item.required and not text:
            raise UserError(f"enter the {item.label.lower()}")
        if item.kind == "number" and text:
            try:
                values[item.name] = int(text)
            except ValueError as error:
                raise UserError(f"the {item.label.lower()} must be a number") from error
            continue
        if item.kind == "path" and text:
            text = str(Path(text).expanduser())
        if text:
            values[item.name] = text
    if source.id == "url" and secrets.get("url") and "://" not in secrets["url"]:
        raise UserError("enter a database URL, e.g. mssql+pyodbc://user:password@host/db")
    return values, secrets


def default_name(source: Source, values: dict[str, Any]) -> str:
    for key in ("database", "bucket", "container", "project", "account", "host"):
        if values.get(key):
            text = str(values[key])
            return Path(text).name if key == "database" and source.id in ("sqlite", "duckdb") else text
    return source.label


# ----------------------------------------------------------------------------- SQLAlchemy


def sqlalchemy_url(source: Source, values: dict[str, Any], secrets: dict[str, str]) -> Any:
    """The database's URL. Call it with ``connect_values`` (an SSH tunnel's local port)."""
    from sqlalchemy.engine import URL, make_url

    v, password = values, secrets.get("password") or None
    if source.id == "url":
        return make_url(secrets["url"])
    if source.id == "sqlite":
        return URL.create("sqlite", database=v["database"])
    if source.id in ("postgresql", "redshift"):
        mode = v.get("sslmode") or ("require" if source.id == "redshift" else None)
        query = {"sslmode": mode} if mode else {}
        if mode in ("verify-ca", "verify-full"):
            query["sslrootcert"] = v.get("sslrootcert") or "system"
        return URL.create("postgresql+psycopg", username=v.get("user"), password=password, host=v["host"], port=v.get("port"),
                          database=v.get("database"), query=query)  # fmt: skip
    if source.id == "mysql":
        return URL.create("mysql+pymysql", username=v.get("user"), password=password, host=v["host"], port=v.get("port"),
                          database=v.get("database"))  # fmt: skip
    if source.id == "sqlserver":
        return URL.create("mssql+pymssql", username=v.get("user"), password=password, host=v["host"], port=v.get("port"),
                          database=v.get("database"))  # fmt: skip
    if source.id == "oracle":
        return URL.create("oracle+oracledb", username=v.get("user"), password=password, host=v["host"], port=v.get("port"),
                          query={"service_name": v["service"]})  # fmt: skip
    if source.id == "snowflake":
        path = "/".join(p for p in (v.get("database"), v.get("schema")) if p) or None
        query = {k: v[k] for k in ("warehouse", "role") if v.get(k)}
        if v.get("auth") == "externalbrowser":
            query["authenticator"] = "externalbrowser"
        return URL.create("snowflake", username=v["user"], password=password if v.get("auth") != "externalbrowser" else None,
                          host=v["account"], database=path, query=query)  # fmt: skip
    if source.id == "bigquery":
        return URL.create("bigquery", host=v["project"], database=v.get("dataset"))
    if source.id == "databricks":
        query = {"http_path": v["http_path"], **{k: v[k] for k in ("catalog", "schema") if v.get(k)}}
        return URL.create("databricks", username="token", password=secrets.get("token"), host=v["host"], query=query)
    raise UserError(f"{source.label} is not a SQL database connection")


DEFAULT_PORTS = {"postgresql": 5432, "redshift": 5439, "mysql": 3306, "sqlserver": 1433, "oracle": 1521}


def connect_values(source: Source, values: dict[str, Any], secrets: dict[str, str]) -> dict[str, Any]:
    """The values to connect with: through an SSH tunnel when the connection asks for one."""
    from . import tunnel

    if not tunnel.wanted(values):
        return values
    return tunnel.through(values, secrets, DEFAULT_PORTS.get(source.id, 0))


def _mysql_tls(values: dict[str, Any]) -> Any:
    import ssl

    mode = values.get("ssl_mode") or "off"
    if mode == "off":
        return None
    if mode == "require":  # encrypted, certificate not checked (like the mysql client's REQUIRED)
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        return context
    ca = values.get("ssl_ca")
    if ca and not Path(ca).is_file():
        raise UserError(f"there is no CA certificate file at {ca}")
    context = ssl.create_default_context(cafile=ca or None)
    context.check_hostname = mode == "verify_identity"
    return context


def engine_options(source: Source, values: dict[str, Any], timeout_s: int) -> dict[str, Any]:
    connect_args: dict[str, Any] = {}
    options: dict[str, Any] = {}
    if source.id == "mysql":
        tls = _mysql_tls(values)
        if tls is not None:
            connect_args["ssl"] = tls
    if source.id in ("postgresql", "redshift", "mysql"):
        connect_args["connect_timeout"] = timeout_s
    if source.id == "sqlserver":
        connect_args["login_timeout"] = timeout_s
    if source.id == "bigquery" and values.get("auth") == "keyfile" and values.get("keyfile"):
        options["credentials_path"] = values["keyfile"]
    return {"connect_args": connect_args, **options}


# ---------------------------------------------------------------------------------- storage


def _quote(value: Any) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def storage_root(source: Source, values: dict[str, Any]) -> str:
    scheme = source.extra["scheme"]
    place = values.get("bucket") or values.get("container")
    prefix = str(values.get("prefix") or "").strip("/")
    return f"{scheme}://{place}/" + (f"{prefix}/" if prefix else "")


def extension_directory() -> str | None:
    """DuckDB extensions shipped inside the desktop app, so cloud storage works offline."""
    if getattr(sys, "frozen", False):
        bundled = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "duckdb_extensions"
        if bundled.is_dir():
            return str(bundled)
    return None


def prepare_storage(connection: Any, source: Source, values: dict[str, Any], secrets: dict[str, str]) -> None:
    """Load the storage extension into a DuckDB connection and give it the credentials."""
    folder = extension_directory()
    if folder:
        connection.execute(f"SET extension_directory = {_quote(folder)}")
    for extension in [
        source.extra["extension"],
        *(["aws"] if source.id == "s3" and values.get("auth") == "chain" else []),
    ]:
        connection.execute(f"INSTALL {extension}")
        connection.execute(f"LOAD {extension}")
    auth = values.get("auth")
    parts: list[str] = []
    if source.id == "s3":
        parts.append("TYPE s3")
        if auth == "chain":
            parts.append("PROVIDER credential_chain")
        elif auth == "keys":
            parts += [f"KEY_ID {_quote(values.get('key_id', ''))}", f"SECRET {_quote(secrets.get('secret', ''))}"]
        if values.get("region"):
            parts.append(f"REGION {_quote(values['region'])}")
        if values.get("endpoint"):
            parts += [f"ENDPOINT {_quote(values['endpoint'])}", "URL_STYLE 'path'"]
        parts.append(f"USE_SSL {'true' if values.get('ssl', True) else 'false'}")
    elif source.id == "azure":
        parts.append("TYPE azure")
        if auth == "connection":
            parts.append(f"CONNECTION_STRING {_quote(secrets.get('connection_string', ''))}")
        else:
            if auth == "chain":
                parts.append("PROVIDER credential_chain")
            parts.append(f"ACCOUNT_NAME {_quote(values['account'])}")
    elif source.id == "gcs":
        parts += [
            "TYPE gcs",
            f"KEY_ID {_quote(values.get('key_id', ''))}",
            f"SECRET {_quote(secrets.get('secret', ''))}",
        ]
    connection.execute(f"CREATE OR REPLACE SECRET flowlabs_storage ({', '.join(parts)})")


def list_files(connection: Any, source: Source, values: dict[str, Any], limit: int = 500) -> list[dict[str, Any]]:
    root = storage_root(source, values)
    rows = connection.execute(f"select file from glob({_quote(root + '**')}) limit {int(limit) * 4}").fetchall()
    files = [str(r[0]) for r in rows if str(r[0]).lower().endswith(STORAGE_FILES)][:limit]
    return [{"name": f, "path": f, "label": f[len(root) :] or f, "columns": []} for f in files]


def reader(path: str) -> str:
    """The SQL that reads one file: read_parquet('s3://...') and friends."""
    lower = path.lower()
    if ".parquet" in lower or lower.endswith(".pq"):
        return f"read_parquet({_quote(path)})"
    if ".json" in lower:
        return f"read_json_auto({_quote(path)})"
    return f"read_csv_auto({_quote(path)})"
