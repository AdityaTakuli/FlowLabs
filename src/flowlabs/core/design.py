"""The table designer: create a table, or change one, from a form instead of writing DDL.

A *design* is the table as the form shows it::

    {"name": "orders", "comment": "...",
     "columns": [{"was": "id", "name": "id", "type": "integer", "nullable": False, "default": None,
                  "primary": True, "auto": True, "comment": None}, ...],
     "indexes": [{"was": "orders_total", "name": "orders_total", "columns": ["total"], "unique": False}],
     "foreign_keys": [{"was": None, "name": "orders_customer_fk", "columns": ["customer_id"],
                       "references": "customers", "referred_columns": ["id"], "on_delete": "CASCADE"}],
     "checks": [{"was": None, "name": "orders_total_positive", "sql": "total >= 0"}]}

``was`` is the name a column, index or key had when the form opened (None for new ones), so a
rename is a rename and not a drop and an add. ``design_sql`` compares the design with the table as
it is now and writes only the statements needed, in the database's own dialect; you review them,
then ``design_apply`` runs them (in one transaction on PostgreSQL, where DDL is transactional).

Types come from the database itself (``format_type`` on PostgreSQL, ``COLUMN_TYPE`` on MySQL), so
``numeric(10,2)``, ``varchar(80)``, ``enum('a','b')`` and your own types show as they are.
"""

from __future__ import annotations

import re
from typing import Any

from . import databases, sql
from .util import UserError
from .workspace import Workspace

ACTIONS = ("NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT")


def _norm(text: Any) -> str:
    return re.sub(r"\s+", " ", re.sub(r"\s*,\s*", ",", str(text or "").strip())).lower()


def design_of(ws: Workspace, connection_id: str, database: str, schema: str | None, name: str) -> dict[str, Any]:
    """The table as a design, for the form."""
    from sqlalchemy import inspect

    item = databases.link(ws, connection_id, database)
    schema = databases._schema_for(item, database, schema)
    with databases._reading(item) as live:
        inspector = inspect(live)
        columns = inspector.get_columns(name, schema=schema)
        primary = inspector.get_pk_constraint(name, schema=schema) or {}
        native = _native_columns(item, live, schema, name)

        def safely(read: Any) -> list[dict[str, Any]]:
            try:
                return list(read(name, schema=schema))
            except Exception:  # noqa: BLE001 - not every database reports every kind
                return []

        indexes = safely(inspector.get_indexes)
        uniques = safely(inspector.get_unique_constraints)
        foreign = safely(inspector.get_foreign_keys)
        checks = safely(inspector.get_check_constraints)
        try:
            comment = (inspector.get_table_comment(name, schema=schema) or {}).get("text")
        except Exception:  # noqa: BLE001
            comment = None
    keys = list(primary.get("constrained_columns") or [])
    out_columns = []
    for column in columns:
        extra = native.get(column["name"], {})
        out_columns.append({
            "was": column["name"], "name": column["name"],
            "type": extra.get("type") or str(column["type"]).lower(),
            "nullable": bool(column.get("nullable", True)),
            "default": extra["default"] if "default" in extra else (None if column.get("default") is None else str(column["default"])),
            "primary": column["name"] in keys,
            "auto": bool(extra.get("auto")),
            "generated": bool(extra.get("generated")),
            "comment": column.get("comment"),
        })  # fmt: skip
    out_indexes = []
    for ix in indexes:
        if ix.get("duplicates_constraint"):
            continue
        expression = any(c is None for c in ix.get("column_names") or [])
        out_indexes.append({"was": ix.get("name"), "name": ix.get("name"), "columns": [c for c in ix.get("column_names") or [] if c],
                            "unique": bool(ix.get("unique")), "expression": expression,
                            "definition": (ix.get("dialect_options") or {}).get("postgresql_using")})  # fmt: skip
    for unique in uniques:
        if item.flavor == "mysql":
            continue  # MySQL reports each unique key as an index as well
        out_indexes.append({"was": unique.get("name"), "name": unique.get("name"), "columns": unique.get("column_names") or [],
                            "unique": True, "constraint": True})  # fmt: skip
    return {
        "name": name, "schema": schema, "database": database, "flavor": item.flavor, "mariadb": item.mariadb,
        "comment": comment, "primary_name": primary.get("name"),
        "columns": out_columns, "indexes": out_indexes,
        "foreign_keys": [{"was": fk.get("name"), "name": fk.get("name"), "columns": fk.get("constrained_columns") or [],
                          "references": _reference(item, schema, fk), "referred_columns": fk.get("referred_columns") or [],
                          "on_delete": ((fk.get("options") or {}).get("ondelete") or "").upper() or None,
                          "on_update": ((fk.get("options") or {}).get("onupdate") or "").upper() or None} for fk in foreign],
        "checks": [{"was": ch.get("name"), "name": ch.get("name"), "sql": _strip_check(ch.get("sqltext") or "")}
                   for ch in checks if ch.get("name")],
        "read_only": item.read_only,
    }  # fmt: skip


def _strip_check(text: str) -> str:
    text = str(text).strip()
    while text.startswith("(") and text.endswith(")") and _balanced(text[1:-1]):
        text = text[1:-1].strip()
    return text


def _balanced(text: str) -> bool:
    depth = 0
    for char in text:
        depth += {"(": 1, ")": -1}.get(char, 0)
        if depth < 0:
            return False
    return depth == 0


def _reference(item: databases.Link, schema: str | None, fk: dict[str, Any]) -> str:
    referred = fk.get("referred_schema")
    table = str(fk.get("referred_table"))
    return f"{referred}.{table}" if referred and referred != schema else table


def _native_columns(item: databases.Link, live: Any, schema: str | None, name: str) -> dict[str, dict[str, Any]]:
    """Each column's type, default and auto-numbering as the database writes them."""
    rows = databases._rows
    found: dict[str, dict[str, Any]] = {}
    if item.flavor == "postgresql":
        for column, kind, default, identity, generated in rows(live, """
                select a.attname, format_type(a.atttypid, a.atttypmod), pg_get_expr(d.adbin, d.adrelid),
                       a.attidentity::text, a.attgenerated::text
                from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                where a.attrelid = (:t)::regclass and a.attnum > 0 and not a.attisdropped""",
                                                             {"t": databases._qualified(item, schema or "public", name)}):  # fmt: skip
            found[column] = {"type": kind, "default": None if generated else default, "auto": bool(identity),
                             "generated": bool(generated)}  # fmt: skip
    elif item.flavor == "mysql":
        for column, kind, extra in rows(live, """
                select COLUMN_NAME, COLUMN_TYPE, EXTRA from information_schema.COLUMNS
                where TABLE_SCHEMA = :s and TABLE_NAME = :t""", {"s": schema, "t": name}):
            extra = str(extra or "").lower()
            found[column] = {"type": kind, "auto": "auto_increment" in extra, "generated": "generated" in extra}
    return found


# ------------------------------------------------------------------------------- checking


def _check(design: dict[str, Any]) -> None:
    if not str(design.get("name") or "").strip():
        raise UserError("name the table")
    columns = design.get("columns") or []
    if not columns:
        raise UserError("a table needs at least one column")
    names = [str(c.get("name") or "").strip() for c in columns]
    if any(not n for n in names):
        raise UserError("every column needs a name")
    seen: set[str] = set()
    for column in columns:
        lowered = str(column["name"]).strip().lower()
        if lowered in seen:
            raise UserError(f"two columns are named {column['name']}")
        seen.add(lowered)
        if not str(column.get("type") or "").strip():
            raise UserError(f"choose a type for {column['name']}")
    known = set(names)
    for ix in design.get("indexes") or []:
        if not ix.get("expression") and not ix.get("columns"):
            raise UserError(f"choose the columns of the index {ix.get('name') or ''}".strip())
        missing = [c for c in ix.get("columns") or [] if c not in known]
        if missing:
            raise UserError(f"the index {ix.get('name')} uses {', '.join(missing)}, which is not a column")
    for fk in design.get("foreign_keys") or []:
        if not fk.get("columns") or not fk.get("references") or not fk.get("referred_columns"):
            raise UserError("a foreign key needs its columns, the table it refers to, and that table's columns")
        if len(fk["columns"]) != len(fk["referred_columns"]):
            raise UserError(f"the foreign key {fk.get('name') or ''} pairs {len(fk['columns'])} columns with "
                            f"{len(fk['referred_columns'])}")  # fmt: skip
        missing = [c for c in fk["columns"] if c not in known]
        if missing:
            raise UserError(f"the foreign key uses {', '.join(missing)}, which is not a column")
        for action in (fk.get("on_delete"), fk.get("on_update")):
            if action and str(action).upper() not in ACTIONS:
                raise UserError(f"{action} is not a foreign key action")
    for check in design.get("checks") or []:
        if not str(check.get("sql") or "").strip():
            raise UserError("a check needs its condition")
        if ";" in sql._strip_comments(str(check["sql"])):
            raise UserError("a check is one condition, without semicolons")
    for column in columns:
        for field in ("type", "default"):
            if column.get(field) and ";" in sql._strip_comments(str(column[field])):
                raise UserError(f"{column['name']}: the {field} cannot hold a semicolon")


# ------------------------------------------------------------------------------- SQL


class _Sql:
    """Quoting and the bits of DDL that differ between databases."""

    def __init__(self, item: databases.Link, schema: str | None) -> None:
        self.item, self.schema, self.flavor = item, schema, item.flavor

    def q(self, name: str) -> str:
        return databases._q(self.item, name)

    def table(self, name: str) -> str:
        if self.flavor == "sqlite" or not self.schema:
            return self.q(name)
        return f"{self.q(self.schema)}.{self.q(name)}"

    def ref(self, reference: str) -> str:
        if "." in reference and self.flavor != "sqlite":
            schema, _, table = reference.partition(".")
            return f"{self.q(schema)}.{self.q(table)}"
        return self.table(reference)

    def text(self, value: str | None) -> str:
        if value is None or value == "":
            return "NULL"
        return databases._literal_text(self.item, value)

    def columns(self, names: list[str]) -> str:
        return ", ".join(self.q(n) for n in names)

    def column(self, column: dict[str, Any], *, inline_key: bool = False) -> str:
        """A column definition, as in CREATE TABLE and ADD COLUMN (and MySQL's CHANGE COLUMN)."""
        parts = [self.q(column["name"]), str(column["type"]).strip()]
        auto = bool(column.get("auto"))
        if self.flavor == "postgresql" and auto:
            parts.append("GENERATED BY DEFAULT AS IDENTITY")
        if not column.get("nullable", True) or (auto and self.flavor == "postgresql"):
            parts.append("NOT NULL")
        elif self.flavor == "mysql":
            parts.append("NULL")
        default = column.get("default")
        if default not in (None, "") and not (auto and self.flavor == "postgresql"):
            parts.append(f"DEFAULT {default}")
        if self.flavor == "mysql" and auto:
            parts.append("AUTO_INCREMENT")
        if self.flavor == "sqlite" and inline_key:
            parts.append("PRIMARY KEY" + (" AUTOINCREMENT" if auto else ""))
        if self.flavor == "mysql" and column.get("comment"):
            parts.append(f"COMMENT {self.text(column['comment'])}")
        return " ".join(parts)

    def foreign_key(self, fk: dict[str, Any]) -> str:
        name = f"CONSTRAINT {self.q(fk['name'])} " if fk.get("name") else ""
        text = (f"{name}FOREIGN KEY ({self.columns(fk['columns'])}) REFERENCES {self.ref(fk['references'])} "
                f"({self.columns(fk['referred_columns'])})")  # fmt: skip
        if fk.get("on_delete") and str(fk["on_delete"]).upper() != "NO ACTION":
            text += f" ON DELETE {str(fk['on_delete']).upper()}"
        if fk.get("on_update") and str(fk["on_update"]).upper() != "NO ACTION":
            text += f" ON UPDATE {str(fk['on_update']).upper()}"
        return text

    def check(self, check: dict[str, Any]) -> str:
        name = f"CONSTRAINT {self.q(check['name'])} " if check.get("name") else ""
        return f"{name}CHECK ({check['sql']})"


def design_sql(ws: Workspace, connection_id: str, database: str, schema: str | None, original: str | None,
               design: dict[str, Any]) -> dict[str, Any]:  # fmt: skip
    """The statements that turn the table into ``design`` (or create it, when ``original`` is None)."""
    item = databases.link(ws, connection_id, database)
    schema = databases._schema_for(item, database, schema)
    if item.flavor not in ("postgresql", "mysql", "sqlite"):
        raise UserError("The table designer works with PostgreSQL, MySQL, MariaDB and SQLite.")
    _check(design)
    s = _Sql(item, schema)
    if original is None:
        return {"sql": _create(s, design), "notes": []}
    before = design_of(ws, connection_id, database, schema, original)
    statements, notes = _alter(s, before, design)
    return {"sql": statements, "notes": notes}


def _create(s: _Sql, design: dict[str, Any]) -> list[str]:
    name = design["name"].strip()
    columns = design["columns"]
    keys = [c["name"] for c in columns if c.get("primary")]
    single_sqlite_key = s.flavor == "sqlite" and len(keys) == 1
    lines = [s.column(c, inline_key=single_sqlite_key and c["name"] in keys) for c in columns]
    if keys and not single_sqlite_key:
        lines.append(f"PRIMARY KEY ({s.columns(keys)})")
    if s.flavor == "mysql":
        lines += [f"{'UNIQUE ' if ix.get('unique') else ''}KEY {s.q(ix['name'])} ({s.columns(ix['columns'])})"
                  for ix in design.get("indexes") or [] if not ix.get("expression")]  # fmt: skip
    lines += [s.foreign_key(fk) for fk in design.get("foreign_keys") or []]
    lines += [s.check(ch) for ch in design.get("checks") or []]
    tail = f" COMMENT={s.text(design['comment'])}" if s.flavor == "mysql" and design.get("comment") else ""
    statements = [f"CREATE TABLE {s.table(name)} (\n    " + ",\n    ".join(lines) + f"\n){tail};"]
    if s.flavor != "mysql":
        for ix in design.get("indexes") or []:
            if ix.get("expression"):
                continue
            statements.append(f"CREATE {'UNIQUE ' if ix.get('unique') else ''}INDEX {s.q(ix['name'])} ON {s.table(name)} "
                              f"({s.columns(ix['columns'])});")  # fmt: skip
    if s.flavor == "postgresql":
        if design.get("comment"):
            statements.append(f"COMMENT ON TABLE {s.table(name)} IS {s.text(design['comment'])};")
        for column in columns:
            if column.get("comment"):
                statements.append(f"COMMENT ON COLUMN {s.table(name)}.{s.q(column['name'])} IS {s.text(column['comment'])};")
    return statements


def _same(a: Any, b: Any) -> bool:
    return _norm(a) == _norm(b)


def _alter(s: _Sql, before: dict[str, Any], design: dict[str, Any]) -> tuple[list[str], list[str]]:
    notes: list[str] = []
    old_name, new_name = before["name"], design["name"].strip()
    old_columns = {c["name"]: c for c in before["columns"]}
    renamed = {c["was"]: c["name"] for c in design["columns"] if c.get("was")}
    kept = {c["was"] for c in design["columns"] if c.get("was")}
    dropped = [name for name in old_columns if name not in kept]
    added = [c for c in design["columns"] if not c.get("was")]
    changed = [(old_columns[c["was"]], c) for c in design["columns"] if c.get("was") in old_columns]

    def by_was(entries: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        return {e["was"]: e for e in entries if e.get("was")}

    def differs_index(a: dict[str, Any], b: dict[str, Any]) -> bool:
        return [renamed.get(c, c) for c in a["columns"]] != list(b["columns"]) or bool(a.get("unique")) != bool(b.get("unique"))

    old_ix, new_ix = {i["was"]: i for i in before["indexes"]}, by_was(design.get("indexes") or [])
    drop_ix = [i for w, i in old_ix.items() if w not in new_ix or differs_index(i, new_ix[w])]
    add_ix = [i for i in design.get("indexes") or [] if not i.get("was") or (i["was"] in old_ix and differs_index(old_ix[i["was"]], i))]
    rename_ix = [(w, i["name"]) for w, i in new_ix.items() if w in old_ix and i not in add_ix and i["name"] != w]

    def differs_fk(a: dict[str, Any], b: dict[str, Any]) -> bool:
        return ([renamed.get(c, c) for c in a["columns"]] != list(b["columns"]) or not _same(a["references"], b["references"])
                or list(a["referred_columns"]) != list(b["referred_columns"])
                or _norm(a.get("on_delete") or "no action") != _norm(b.get("on_delete") or "no action")
                or _norm(a.get("on_update") or "no action") != _norm(b.get("on_update") or "no action")
                or a.get("name") != b.get("name"))  # fmt: skip

    old_fk, new_fk = {f["was"]: f for f in before["foreign_keys"]}, by_was(design.get("foreign_keys") or [])
    drop_fk = [f for w, f in old_fk.items() if w not in new_fk or differs_fk(f, new_fk[w])]
    add_fk = [f for f in design.get("foreign_keys") or [] if not f.get("was") or (f["was"] in old_fk and differs_fk(old_fk[f["was"]], f))]
    old_ck, new_ck = {c["was"]: c for c in before["checks"]}, by_was(design.get("checks") or [])
    drop_ck = [c for w, c in old_ck.items() if w not in new_ck or not _same(c["sql"], new_ck[w]["sql"]) or c["name"] != new_ck[w]["name"]]
    add_ck = [c for c in design.get("checks") or [] if not c.get("was") or c in [new_ck.get(d["was"]) for d in drop_ck]]

    old_keys = [renamed.get(c["name"], c["name"]) for c in before["columns"] if c["primary"] and c["name"] in kept]
    new_keys = [c["name"] for c in design["columns"] if c.get("primary")]
    key_changed = old_keys != new_keys or any(c["primary"] for c in before["columns"] if c["name"] in dropped)
    had_key = any(c["primary"] for c in before["columns"])

    out: list[str] = []
    if s.flavor == "sqlite":
        return _alter_sqlite(s, before, design, dropped, added, changed, drop_ix, add_ix, rename_ix, drop_fk, add_fk,
                             drop_ck, add_ck, key_changed)  # fmt: skip
    if s.flavor == "postgresql":
        if new_name != old_name:
            out.append(f"ALTER TABLE {s.table(old_name)} RENAME TO {s.q(new_name)};")
        t = s.table(new_name)
        out += [f"ALTER TABLE {t} DROP CONSTRAINT {s.q(f['was'])};" for f in drop_fk]
        for ix in drop_ix:
            out.append(f"ALTER TABLE {t} DROP CONSTRAINT {s.q(ix['was'])};" if ix.get("constraint")
                       else f"DROP INDEX {s.table(ix['was'])};")  # fmt: skip
        out += [f"ALTER TABLE {t} DROP CONSTRAINT {s.q(c['was'])};" for c in drop_ck]
        if key_changed and had_key and before.get("primary_name"):
            out.append(f"ALTER TABLE {t} DROP CONSTRAINT {s.q(before['primary_name'])};")
        out += [f"ALTER TABLE {t} DROP COLUMN {s.q(name)};" for name in dropped]
        for old, new in changed:
            if new["name"] != old["name"]:
                out.append(f"ALTER TABLE {t} RENAME COLUMN {s.q(old['name'])} TO {s.q(new['name'])};")
            col = s.q(new["name"])
            if old.get("generated"):
                if not _same(old["type"], new["type"]) or not _same(old.get("default"), new.get("default")):
                    notes.append(f"{new['name']} is a generated column; change it with SQL.")
                continue
            if not _same(old["type"], new["type"]):
                out.append(f"ALTER TABLE {t} ALTER COLUMN {col} TYPE {new['type']} USING {col}::{new['type']};")
            if bool(old.get("auto")) != bool(new.get("auto")):
                if new.get("auto"):
                    if old.get("default"):
                        out.append(f"ALTER TABLE {t} ALTER COLUMN {col} DROP DEFAULT;")
                    out.append(f"ALTER TABLE {t} ALTER COLUMN {col} SET NOT NULL;")
                    out.append(f"ALTER TABLE {t} ALTER COLUMN {col} ADD GENERATED BY DEFAULT AS IDENTITY;")
                else:
                    out.append(f"ALTER TABLE {t} ALTER COLUMN {col} DROP IDENTITY IF EXISTS;")
            if not new.get("auto") and not _same(old.get("default"), new.get("default")):
                out.append(f"ALTER TABLE {t} ALTER COLUMN {col} SET DEFAULT {new['default']};" if new.get("default")
                           else f"ALTER TABLE {t} ALTER COLUMN {col} DROP DEFAULT;")  # fmt: skip
            if bool(old["nullable"]) != bool(new.get("nullable", True)) and not (new.get("auto") and not old.get("auto")):
                out.append(f"ALTER TABLE {t} ALTER COLUMN {col} {'DROP' if new.get('nullable', True) else 'SET'} NOT NULL;")
            if (old.get("comment") or "") != (new.get("comment") or ""):
                out.append(f"COMMENT ON COLUMN {t}.{col} IS {s.text(new.get('comment'))};")
        for column in added:
            out.append(f"ALTER TABLE {t} ADD COLUMN {s.column(column)};")
            if column.get("comment"):
                out.append(f"COMMENT ON COLUMN {t}.{s.q(column['name'])} IS {s.text(column['comment'])};")
        if key_changed and new_keys:
            out.append(f"ALTER TABLE {t} ADD PRIMARY KEY ({s.columns(new_keys)});")
        out += [f"ALTER INDEX {s.table(old)} RENAME TO {s.q(new)};" for old, new in rename_ix]
        out += [f"ALTER TABLE {t} ADD {s.check(c)};" for c in add_ck]
        out += [f"CREATE {'UNIQUE ' if ix.get('unique') else ''}INDEX {s.q(ix['name'])} ON {t} ({s.columns(ix['columns'])});"
                for ix in add_ix]  # fmt: skip
        out += [f"ALTER TABLE {t} ADD {s.foreign_key(f)};" for f in add_fk]
        if (before.get("comment") or "") != (design.get("comment") or ""):
            out.append(f"COMMENT ON TABLE {t} IS {s.text(design.get('comment'))};")
        return out, notes
    # MySQL and MariaDB: foreign keys off first, one ALTER TABLE for the rest, foreign keys back on
    t = s.table(old_name)
    if drop_fk:
        out.append(f"ALTER TABLE {t} " + ", ".join(f"DROP FOREIGN KEY {s.q(f['was'])}" for f in drop_fk) + ";")
    clauses: list[str] = []
    clauses += [f"DROP INDEX {s.q(ix['was'])}" for ix in drop_ix]
    clauses += [f"DROP {'CONSTRAINT' if s.item.mariadb else 'CHECK'} {s.q(c['was'])}" for c in drop_ck]
    if key_changed and had_key:
        clauses.append("DROP PRIMARY KEY")
    clauses += [f"DROP COLUMN {s.q(name)}" for name in dropped]
    for old, new in changed:
        if old.get("generated"):
            if not _same(old["type"], new["type"]):
                notes.append(f"{new['name']} is a generated column; change it with SQL.")
            continue
        same = (new["name"] == old["name"] and _same(old["type"], new["type"])
                and bool(old["nullable"]) == bool(new.get("nullable", True)) and _same(old.get("default"), new.get("default"))
                and bool(old.get("auto")) == bool(new.get("auto")) and (old.get("comment") or "") == (new.get("comment") or ""))  # fmt: skip
        if not same:
            clauses.append(f"CHANGE COLUMN {s.q(old['name'])} {s.column(new)}")
    clauses += [f"ADD COLUMN {s.column(c)}" for c in added]
    if key_changed and new_keys:
        clauses.append(f"ADD PRIMARY KEY ({s.columns(new_keys)})")
    clauses += [f"RENAME INDEX {s.q(old)} TO {s.q(new)}" for old, new in rename_ix]
    clauses += [f"ADD {'UNIQUE ' if ix.get('unique') else ''}INDEX {s.q(ix['name'])} ({s.columns(ix['columns'])})" for ix in add_ix]
    clauses += [f"ADD {s.check(c)}" for c in add_ck]
    if (before.get("comment") or "") != (design.get("comment") or ""):
        clauses.append(f"COMMENT = {s.text(design.get('comment') or '')}")
    if clauses:
        out.append(f"ALTER TABLE {t}\n    " + ",\n    ".join(clauses) + ";")
    if add_fk:
        out.append(f"ALTER TABLE {t} " + ", ".join(f"ADD {s.foreign_key(f)}" for f in add_fk) + ";")
    if new_name != old_name:
        out.append(f"RENAME TABLE {t} TO {s.table(new_name)};")
    return out, notes


def _alter_sqlite(s: _Sql, before: dict[str, Any], design: dict[str, Any], dropped: list[str], added: list[dict[str, Any]],
                  changed: list[tuple[dict[str, Any], dict[str, Any]]], drop_ix: list[dict[str, Any]],
                  add_ix: list[dict[str, Any]], rename_ix: list[tuple[str, str]], drop_fk: list[dict[str, Any]],
                  add_fk: list[dict[str, Any]], drop_ck: list[dict[str, Any]], add_ck: list[dict[str, Any]],
                  key_changed: bool) -> tuple[list[str], list[str]]:  # fmt: skip
    """SQLite changes little in place: renames, new and dropped columns, indexes."""
    unsupported = []
    for old, new in changed:
        if not _same(old["type"], new["type"]) or bool(old["nullable"]) != bool(new.get("nullable", True)) \
                or not _same(old.get("default"), new.get("default")):
            unsupported.append(f"the type, empty values or default of {new['name']}")
    if key_changed:
        unsupported.append("the primary key")
    if drop_fk or add_fk or drop_ck or add_ck:
        unsupported.append("foreign keys and checks")
    if unsupported:
        raise UserError("SQLite cannot change " + ", ".join(unsupported) + " in place. Create a new table with the "
                        "design you want, copy the rows over, and drop the old one.")  # fmt: skip
    out: list[str] = []
    old_name, new_name = before["name"], design["name"].strip()
    if new_name != old_name:
        out.append(f"ALTER TABLE {s.q(old_name)} RENAME TO {s.q(new_name)};")
    t = s.q(new_name)
    out += [f"DROP INDEX {s.q(ix['was'])};" for ix in drop_ix]
    out += [f"ALTER TABLE {t} DROP COLUMN {s.q(name)};" for name in dropped]
    out += [f"ALTER TABLE {t} RENAME COLUMN {s.q(old['name'])} TO {s.q(new['name'])};" for old, new in changed if old["name"] != new["name"]]
    out += [f"ALTER TABLE {t} ADD COLUMN {s.column(c)};" for c in added]
    for old_index, new_index in rename_ix:  # SQLite has no RENAME INDEX: build it again under the new name
        index = next(i for i in design["indexes"] if i["name"] == new_index)
        out += [f"DROP INDEX {s.q(old_index)};",
                f"CREATE {'UNIQUE ' if index.get('unique') else ''}INDEX {s.q(new_index)} ON {t} ({s.columns(index['columns'])});"]
    out += [f"CREATE {'UNIQUE ' if ix.get('unique') else ''}INDEX {s.q(ix['name'])} ON {t} ({s.columns(ix['columns'])});" for ix in add_ix]
    return out, []


def design_apply(ws: Workspace, connection_id: str, database: str, schema: str | None, original: str | None,
                 design: dict[str, Any]) -> dict[str, Any]:  # fmt: skip
    """Run the design's statements: all or nothing on PostgreSQL and SQLite; on MySQL each DDL
    statement commits by itself, so they run in order and stop at the first error."""
    item = databases.link(ws, connection_id, database)
    databases._need_changes(item)
    planned = design_sql(ws, connection_id, database, schema, original, design)
    statements = planned["sql"]
    if not statements:
        return {"sql": [], "name": design["name"], "done": 0}
    done = 0
    with item.engine.connect() as live:
        transaction = live.begin()
        try:
            for statement in statements:
                live.exec_driver_sql(statement)
                done += 1
            transaction.commit()
        except Exception as error:  # noqa: BLE001 - the database's own words
            transaction.rollback()
            ran = f" {done} of {len(statements)} statements had run (MySQL keeps them)." if item.flavor == "mysql" and done else ""
            raise UserError(f"{sql._friendly_connection_error(error)}{ran}") from error
    return {"sql": statements, "name": design["name"].strip(), "done": done}
