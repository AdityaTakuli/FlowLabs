// Databases: connect PostgreSQL, MySQL or MariaDB and browse, query, edit and administer them here,
// instead of in pgAdmin or MySQL Workbench. The engine side is core/databases.py.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useApp } from "../context";
import { ConnectionDialog } from "../components/ConnectionDialog";
import { Icon, type IconName } from "../components/Icon";
import { SectionNav, TopBar } from "../components/TopBar";
import { Spinner } from "../components/ui";
import { uid } from "../format";
import type { DbConnection, DbObject, DbObjects, DbOverview, SourceKind } from "../types";
import { ActivityTab, UsersTab, type AdminTabState } from "./db/AdminTabs";
import { useRemembered } from "./db/common";
import { QueryTab, type QueryTabState } from "./db/QueryTab";
import { DefinitionTab, ImportDialog, TableTab, type DefinitionTabState, type TableTabState } from "./db/TableTab";
import { BackupDialog, RestoreDialog } from "./db/BackupDialogs";
import { DesignTab, type DesignTabState } from "./db/DesignTab";
import { DiagramTab, type DiagramTabState } from "./db/DiagramTab";

type Tab = QueryTabState | TableTabState | DefinitionTabState | AdminTabState | DesignTabState | DiagramTabState;
type Place = { connection_id: string; database: string; schema: string | null };
type Loaded<T> = T | { error: string } | undefined;

const GROUPS: { key: keyof Omit<DbObjects, "database" | "schema">; label: string; icon: IconName }[] = [
  { key: "tables", label: "Tables", icon: "table" },
  { key: "views", label: "Views", icon: "eye" },
  { key: "functions", label: "Functions", icon: "function" },
  { key: "procedures", label: "Procedures", icon: "function" },
  { key: "triggers", label: "Triggers", icon: "bolt" },
  { key: "sequences", label: "Sequences", icon: "hash" },
];

function compact(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
}

function isError<T>(value: Loaded<T>): value is { error: string } {
  return Boolean(value && typeof value === "object" && "error" in (value as object));
}

function Node({ depth, open, onToggle, icon, label, meta, onClick, actions, active, children, title }: {
  depth: number;
  open?: boolean;
  onToggle?: () => void;
  icon: IconName;
  label: ReactNode;
  meta?: ReactNode;
  onClick?: () => void;
  actions?: ReactNode;
  active?: boolean;
  children?: ReactNode;
  title?: string;
}) {
  return (
    <li role="treeitem" aria-expanded={onToggle ? Boolean(open) : undefined} aria-selected={active}>
      <div className={`db-node ${active ? "active" : ""}`} style={{ paddingLeft: 6 + depth * 14 }}>
        {onToggle ? (
          <button className="db-twisty" onClick={onToggle} aria-label={open ? "Collapse" : "Expand"} tabIndex={-1}>
            <Icon name={open ? "chevronDown" : "chevronRight"} size={11} />
          </button>
        ) : (
          <span className="db-twisty" />
        )}
        <button className="db-node-main" onClick={onClick ?? onToggle} title={title}>
          <Icon name={icon} size={13} />
          <span className="db-node-label">{label}</span>
          {meta !== undefined && <span className="db-node-meta">{meta}</span>}
        </button>
        {actions && <span className="db-node-actions">{actions}</span>}
      </div>
      {open && children && <ul role="group">{children}</ul>}
    </li>
  );
}

export function Databases({ goHome, openProjects }: { goHome: () => void; openProjects: () => void }) {
  const { engine, fail, notify, openGuide } = useApp();
  const [kinds, setKinds] = useState<SourceKind[] | null>(null);
  const [connections, setConnections] = useState<DbConnection[] | null>(null);
  const [overviews, setOverviews] = useState<Record<string, Loaded<DbOverview>>>({});
  const [schemas, setSchemas] = useState<Record<string, Loaded<{ name: string; system: boolean }[]>>>({});
  const [objects, setObjects] = useState<Record<string, Loaded<DbObjects>>>({});
  const [expanded, setExpanded] = useRemembered<string[]>("flowlabs-db-open", []);
  const [showSystem, setShowSystem] = useRemembered<boolean>("flowlabs-db-system", false);
  const [tabs, setTabs] = useRemembered<Tab[]>("flowlabs-db-tabs", []);
  const [activeId, setActiveId] = useRemembered<string | null>("flowlabs-db-active", null);
  const [dialog, setDialog] = useState<{ edit: DbConnection | null } | null>(null);
  const [importing, setImporting] = useState<Place | null>(null);
  // the dialogs keep the overview they opened with: reloading it (after a restore) must not close them
  const [backingUp, setBackingUp] = useState<(Place & { overview: DbOverview }) | null>(null);
  const [restoring, setRestoring] = useState<(Place & { overview: DbOverview }) | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sideOpen, setSideOpen] = useState(true);
  const inBrowser = engine.kind === "browser";

  const loadKinds = useCallback(() => {
    engine.call<SourceKind[]>("sql.kinds").then(setKinds, fail);
  }, [engine, fail]);
  const loadConnections = useCallback(() => {
    engine.call<DbConnection[]>("sql.connections").then(setConnections, fail);
  }, [engine, fail]);
  useEffect(() => {
    loadKinds();
    loadConnections();
  }, [loadKinds, loadConnections]);

  const servers = useMemo(() => {
    if (!connections || !kinds) return null;
    const engines = new Map(kinds.map((k) => [k.id, k.engine]));
    return connections.filter((c) => engines.get(c.kind) === "sqlalchemy");
  }, [connections, kinds]);

  const loadOverview = useCallback(
    (id: string, force = false) => {
      if (!force && overviews[id] && !isError(overviews[id])) return;
      setOverviews((o) => ({ ...o, [id]: undefined }));
      engine.call<DbOverview>("db.overview", { connection_id: id }).then(
        (found) => setOverviews((o) => ({ ...o, [id]: found })),
        (error: Error) => setOverviews((o) => ({ ...o, [id]: { error: error.message } })),
      );
    },
    [engine, overviews],
  );
  const loadSchemas = useCallback(
    (id: string, database: string) => {
      const key = `${id}/${database}`;
      engine.call<{ name: string; system: boolean }[]>("db.schemas", { connection_id: id, database }).then(
        (found) => setSchemas((s) => ({ ...s, [key]: found })),
        (error: Error) => setSchemas((s) => ({ ...s, [key]: { error: error.message } })),
      );
    },
    [engine],
  );
  const loadObjects = useCallback(
    (id: string, database: string, schema: string | null) => {
      const key = `${id}/${database}/${schema ?? ""}`;
      setObjects((o) => ({ ...o, [key]: undefined }));
      engine.call<DbObjects>("db.objects", { connection_id: id, database, schema }).then(
        (found) => setObjects((o) => ({ ...o, [key]: found })),
        (error: Error) => setObjects((o) => ({ ...o, [key]: { error: error.message } })),
      );
    },
    [engine],
  );

  // what was open last time loads again
  useEffect(() => {
    if (!servers) return;
    for (const key of expanded) {
      const [id = "", database, schema] = key.split("/");
      if (!servers.some((c) => c.id === id)) continue;
      if (database === undefined) loadOverview(id);
      else if (schema === undefined && overviews[id] && !isError(overviews[id]) && (overviews[id] as DbOverview).schemas && !schemas[`${id}/${database}`]) loadSchemas(id, database);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers, overviews]);
  useEffect(() => {
    const active = tabs.find((t) => t.id === activeId);
    if (active) loadOverview(active.connection_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const isOpen = (key: string) => expanded.includes(key);
  const toggle = (key: string, onOpen?: () => void) => {
    if (isOpen(key)) setExpanded((all) => all.filter((k) => k !== key && !k.startsWith(`${key}/`)));
    else {
      setExpanded((all) => [...all, key]);
      onOpen?.();
    }
  };

  const openTab = (tab: Tab) => {
    setTabs((all) => {
      const same = all.find((t) => t.kind === tab.kind && t.kind !== "query" && JSON.stringify({ ...t, id: "", title: "" }) === JSON.stringify({ ...tab, id: "", title: "" }));
      if (same) {
        setActiveId(same.id);
        return all;
      }
      setActiveId(tab.id);
      return [...all, tab];
    });
  };
  const newQuery = (connectionId: string, database: string | null, text?: string) => {
    const id = uid("q");
    if (text !== undefined) {
      try {
        localStorage.setItem(`flowlabs-db-sql:${id}`, JSON.stringify(text));
      } catch {
        /* the tab starts empty */
      }
    }
    const count = tabs.filter((t) => t.kind === "query" && t.connection_id === connectionId).length + 1;
    const name = servers?.find((c) => c.id === connectionId)?.name ?? "Query";
    openTab({ kind: "query", id, connection_id: connectionId, database, title: `${name} ${count}` });
  };
  const closeTab = (id: string) => {
    setTabs((all) => {
      const index = all.findIndex((t) => t.id === id);
      const next = all.filter((t) => t.id !== id);
      if (activeId === id) setActiveId(next[Math.max(0, index - 1)]?.id ?? null);
      return next;
    });
    try {
      localStorage.removeItem(`flowlabs-db-sql:${id}`);
    } catch {
      /* nothing to clean */
    }
  };

  const removeConnection = async (connection: DbConnection) => {
    setMenu(null);
    if (!window.confirm(`Remove the connection “${connection.name}”? The database itself is not touched.`)) return;
    try {
      await engine.call("sql.connection_delete", { connection_id: connection.id });
      setTabs((all) => all.filter((t) => t.connection_id !== connection.id));
      loadConnections();
    } catch (error) {
      fail(error);
    }
  };

  const active = tabs.find((t) => t.id === activeId) ?? null;
  const activeOverview = active ? overviews[active.connection_id] : undefined;
  const overviewOf = (id: string): DbOverview | null => {
    const found = overviews[id];
    return found && !isError(found) ? found : null;
  };
  const needle = filter.trim().toLowerCase();

  const objectNodes = (connection: DbConnection, database: string, schema: string | null, depth: number) => {
    const key = `${connection.id}/${database}/${schema ?? ""}`;
    const found = objects[key];
    if (found === undefined) return <li className="db-node-note" style={{ paddingLeft: 26 + depth * 14 }}><Spinner /></li>;
    if (isError(found)) return <li className="db-node-note error-text small" style={{ paddingLeft: 26 + depth * 14 }}>{found.error}</li>;
    const groups = GROUPS.map((g) => ({ ...g, items: (found[g.key] as DbObject[]).filter((o) => !needle || o.name.toLowerCase().includes(needle)) })).filter((g) => g.items.length > 0);
    if (groups.length === 0) return <li className="db-node-note faint small" style={{ paddingLeft: 26 + depth * 14 }}>{needle ? "Nothing matches." : "Empty."}</li>;
    return groups.map((g) => {
      const groupKey = `${key}/${g.key}`;
      return (
        <Node key={g.key} depth={depth} icon={g.icon} label={g.label} meta={g.items.length} open={isOpen(groupKey) || Boolean(needle)} onToggle={() => toggle(groupKey)}>
          {g.items.map((item) => {
            const isTable = g.key === "tables" || g.key === "views";
            const tabFor = (): Tab =>
              isTable
                ? { kind: "table", id: uid("t"), connection_id: connection.id, database, schema: found.schema, name: item.name, title: item.name }
                : { kind: "definition", id: uid("d"), connection_id: connection.id, database, schema: found.schema, name: item.name, object: item.kind, signature: item.signature, table: item.table, title: item.name };
            const open = active && active.kind !== "query" && "name" in active && active.name === item.name && active.connection_id === connection.id;
            return (
              <Node
                key={`${item.name}(${item.signature ?? ""})${item.table ?? ""}`}
                depth={depth + 1}
                icon={g.icon}
                label={item.signature !== undefined ? <>{item.name}<span className="faint">({item.signature})</span></> : item.name}
                meta={isTable ? compact(item.rows) : item.table}
                active={Boolean(open)}
                title={[item.kind, item.rows != null ? `about ${item.rows.toLocaleString()} rows` : "", item.comment ?? ""].filter(Boolean).join(" · ")}
                onClick={() => openTab(tabFor())}
              />
            );
          })}
        </Node>
      );
    });
  };

  /** The menu of a database (MySQL) or schema (PostgreSQL): what to do there. On PostgreSQL a
      database's own menu only restores; its schemas hold the tables. */
  const placeMenu = (connection: DbConnection, overview: DbOverview, database: string, schema: string | null) => {
    const key = `${connection.id}/${database}/${schema ?? ""}`;
    const where: Place = { connection_id: connection.id, database, schema };
    const holdsTables = !overview.schemas || schema !== null;
    const writes = connection.allow_changes;
    const run = (action: () => void) => () => {
      setMenu(null);
      action();
    };
    const label = schema ?? database;
    return (
      <span className="db-menu-anchor">
        <button className="ghost icon-only small" onClick={() => setMenu(menu === key ? null : key)} aria-label={`More for ${label}`} aria-expanded={menu === key}>
          <Icon name="sliders" size={12} />
        </button>
        {menu === key && (
          <div className="db-menu" role="menu">
            <button role="menuitem" onClick={run(() => newQuery(connection.id, database))}>New query</button>
            {holdsTables && writes && (
              <button role="menuitem" onClick={run(() => openTab({ kind: "design", id: uid("n"), connection_id: connection.id, database, schema, name: null, title: "New table" }))}>New table…</button>
            )}
            {holdsTables && (
              <button role="menuitem" onClick={run(() => openTab({ kind: "diagram", id: uid("e"), connection_id: connection.id, database, schema, title: `${label}: diagram` }))}>Diagram</button>
            )}
            <div className="db-menu-sep" />
            {holdsTables && <button role="menuitem" onClick={run(() => setBackingUp({ ...where, overview }))}>Back up…</button>}
            {writes && <button role="menuitem" onClick={run(() => setRestoring({ ...where, overview }))}>Restore…</button>}
            {holdsTables && writes && <button role="menuitem" onClick={run(() => setImporting(where))}>Import a dataset as a table…</button>}
          </div>
        )}
      </span>
    );
  };
  const refreshPlace = (where: Place) => loadObjects(where.connection_id, where.database, where.schema);

  const tree = (connection: DbConnection) => {
    const overview = overviews[connection.id];
    const open = isOpen(connection.id);
    const kind = kinds?.find((k) => k.id === connection.kind);
    return (
      <Node
        key={connection.id}
        depth={0}
        icon="server"
        label={connection.name}
        meta={!connection.allow_changes ? <Icon name="lock" size={11} title="Read-only" /> : undefined}
        title={`${kind?.label ?? connection.kind_label}${overviewOf(connection.id) ? `, ${overviewOf(connection.id)!.server}` : ""}${connection.allow_changes ? "" : ", read-only"}`}
        open={open}
        onToggle={() => toggle(connection.id, () => loadOverview(connection.id))}
        actions={
          <>
            <button className="ghost icon-only small" onClick={() => newQuery(connection.id, overviewOf(connection.id)?.default ?? null)} aria-label={`New query on ${connection.name}`} title="New query">
              <Icon name="plus" size={12} />
            </button>
            <span className="db-menu-anchor">
              <button className="ghost icon-only small" onClick={() => setMenu(menu === connection.id ? null : connection.id)} aria-label={`More for ${connection.name}`} aria-expanded={menu === connection.id}>
                <Icon name="sliders" size={12} />
              </button>
              {menu === connection.id && (
                <div className="db-menu" role="menu">
                  <button role="menuitem" onClick={() => { setMenu(null); newQuery(connection.id, overviewOf(connection.id)?.default ?? null); }}>New query</button>
                  <button role="menuitem" onClick={() => { setMenu(null); openTab({ kind: "activity", id: uid("a"), connection_id: connection.id, title: `${connection.name}: activity` }); }}>Server activity</button>
                  <button role="menuitem" onClick={() => { setMenu(null); openTab({ kind: "users", id: uid("u"), connection_id: connection.id, title: `${connection.name}: users` }); }}>Users and roles</button>
                  <button role="menuitem" onClick={() => { setMenu(null); loadOverview(connection.id, true); setObjects({}); setSchemas({}); }}>Refresh</button>
                  <div className="db-menu-sep" />
                  <button role="menuitem" onClick={() => { setMenu(null); setDialog({ edit: connection }); }}>Edit connection…</button>
                  <button role="menuitem" className="danger" onClick={() => void removeConnection(connection)}>Remove connection…</button>
                </div>
              )}
            </span>
          </>
        }
      >
        {overview === undefined ? (
          <li className="db-node-note" style={{ paddingLeft: 26 }}><Spinner /></li>
        ) : isError(overview) ? (
          <li className="db-node-note error-text small" style={{ paddingLeft: 26 }}>
            {overview.error}{" "}
            <button className="link small" onClick={() => loadOverview(connection.id, true)}>Try again</button>
          </li>
        ) : (
          overview.databases
            .filter((d) => showSystem || !d.system || d.name === overview.default)
            .map((d) => {
              const dbKey = `${connection.id}/${d.name}`;
              const dbOpen = isOpen(dbKey) || Boolean(needle && objects[`${dbKey}/${overview.schemas ? "public" : d.name}`]);
              return (
                <Node
                  key={d.name}
                  depth={1}
                  icon="database"
                  label={d.name}
                  meta={d.name === overview.default ? "default" : d.system ? "system" : undefined}
                  open={dbOpen}
                  onToggle={() => toggle(dbKey, () => (overview.schemas ? loadSchemas(connection.id, d.name) : loadObjects(connection.id, d.name, null)))}
                  actions={
                    <>
                      <button className="ghost icon-only small" onClick={() => newQuery(connection.id, d.name)} aria-label={`New query in ${d.name}`} title="New query in this database">
                        <Icon name="plus" size={12} />
                      </button>
                      {placeMenu(connection, overview, d.name, null)}
                    </>
                  }
                >
                  {overview.schemas
                    ? (() => {
                        const list = schemas[dbKey];
                        if (list === undefined) return <li className="db-node-note" style={{ paddingLeft: 40 }}><Spinner /></li>;
                        if (isError(list)) return <li className="db-node-note error-text small" style={{ paddingLeft: 40 }}>{list.error}</li>;
                        return list
                          .filter((s) => showSystem || !s.system)
                          .map((s) => {
                            const schemaKey = `${dbKey}/${s.name}`;
                            return (
                              <Node
                                key={s.name}
                                depth={2}
                                icon="folder"
                                label={s.name}
                                open={isOpen(schemaKey)}
                                onToggle={() => toggle(schemaKey, () => loadObjects(connection.id, d.name, s.name))}
                                actions={placeMenu(connection, overview, d.name, s.name)}
                              >
                                {objectNodes(connection, d.name, s.name, 3)}
                              </Node>
                            );
                          });
                      })()
                    : objectNodes(connection, d.name, null, 2)}
                </Node>
              );
            })
        )}
      </Node>
    );
  };

  // objects whose tree is open load when the page opens
  useEffect(() => {
    for (const key of expanded) {
      const parts = key.split("/");
      const [id = "", database = "", schema = ""] = parts;
      const overview = overviews[id];
      if (!overview || isError(overview)) continue;
      if (parts.length === 2 && !overview.schemas && objects[`${id}/${database}/`] === undefined) loadObjects(id, database, null);
      if (parts.length === 3 && overview.schemas && objects[`${key}`] === undefined && !GROUPS.some((g) => g.key === schema)) loadObjects(id, database, schema);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overviews]);

  return (
    <div className="shell">
      <TopBar onHome={goHome} help="databases">
        <SectionNav current="databases" onProjects={openProjects} onDatabases={() => undefined} />
      </TopBar>
      <div className={`db-layout ${sideOpen ? "" : "side-closed"}`}>
        <aside className="db-side" aria-label="Connections">
          <div className="db-side-head">
            <h3>Connections</h3>
            <span className="spacer" />
            <button className="ghost icon-only small" onClick={() => { loadConnections(); setOverviews({}); setSchemas({}); setObjects({}); }} aria-label="Refresh everything" title="Refresh">
              <Icon name="refresh" size={12} />
            </button>
            <button className="ghost small" onClick={() => setDialog({ edit: null })} disabled={inBrowser}>
              <Icon name="plus" size={12} /> Connect
            </button>
          </div>
          {servers && servers.length > 0 && (
            <div className="db-side-tools">
              <span className="db-search">
                <Icon name="search" size={12} />
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a table" aria-label="Find a table, view or function in what is open" />
              </span>
              <label className="db-system" title="Show system databases and schemas">
                <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} /> System
              </label>
            </div>
          )}
          {servers === null ? (
            <Spinner />
          ) : servers.length === 0 ? (
            <p className="faint small db-side-empty">No database connections yet.</p>
          ) : (
            <ul className="db-tree" role="tree">
              {servers.map(tree)}
            </ul>
          )}
        </aside>

        <section className="db-main">
          {tabs.length > 0 && (
            <div className="tabstrip db-tabs" role="tablist">
              <button className="ghost icon-only small db-side-toggle" onClick={() => setSideOpen(!sideOpen)} aria-label={sideOpen ? "Hide the connections" : "Show the connections"} title={sideOpen ? "Hide the connections" : "Show the connections"}>
                <Icon name={sideOpen ? "arrowLeft" : "arrowRight"} size={12} />
              </button>
              {tabs.map((t) => (
                <div key={t.id} className={`tab db-tab ${t.id === activeId ? "active" : ""}`} role="tab" aria-selected={t.id === activeId}>
                  {t.id === activeId && <span className="tab-surface" />}
                  <button className="db-tab-main" onClick={() => setActiveId(t.id)} title={t.title}>
                    <Icon name={t.kind === "query" ? "code" : t.kind === "table" ? "table" : t.kind === "activity" ? "pulse" : t.kind === "users" ? "users" : t.kind === "design" ? "edit" : t.kind === "diagram" ? "tree" : "function"} size={12} />
                    <span className="ellipsis">{t.title}</span>
                  </button>
                  <button className="ghost icon-only small db-tab-close" onClick={() => closeTab(t.id)} aria-label={`Close ${t.title}`}>
                    <Icon name="close" size={10} />
                  </button>
                </div>
              ))}
              <span className="tabstrip-fill" />
            </div>
          )}
          <div className="db-body">
            {!active ? (
              <div className="db-welcome">
                {inBrowser ? (
                  <div className="empty">
                    <div className="icon-ring"><Icon name="server" size={22} /></div>
                    <h2>Databases need the desktop app or an engine</h2>
                    <p className="dim">A browser tab cannot reach a database server. Open FlowLabs on your computer, or connect this page to <code>flowlabs engine</code>.</p>
                  </div>
                ) : servers && servers.length === 0 ? (
                  <div className="db-start">
                    <h1>Work in your databases here</h1>
                    <p className="lead dim">Connect PostgreSQL, MySQL or MariaDB to browse tables, run queries, edit rows, read query plans and manage users, without pgAdmin or MySQL Workbench.</p>
                    <div className="row wrap">
                      <button className="primary" onClick={() => setDialog({ edit: null })}>
                        <Icon name="plus" /> Connect a database
                      </button>
                      <button className="ghost" onClick={() => openGuide("databases")}>
                        <Icon name="book" /> How it works
                      </button>
                    </div>
                    <ul className="db-start-list">
                      <li><Icon name="tree" /> Every database, schema, table, view, function and trigger, with sizes and CREATE scripts.</li>
                      <li><Icon name="code" /> Query tabs with their own sessions, history, Stop, transactions and export to CSV or Excel.</li>
                      <li><Icon name="edit" /> Edit rows in place, reviewed as SQL before anything is saved.</li>
                      <li><Icon name="lock" /> SSL and SSH tunnels; read-only connections the server itself enforces.</li>
                    </ul>
                  </div>
                ) : (
                  <div className="db-start">
                    <h2>Open a table, or start a query</h2>
                    <p className="dim">Choose a table on the left, or a connection's <Icon name="plus" size={12} /> for a new query tab.</p>
                    <div className="row wrap">
                      {servers?.map((c) => (
                        <button key={c.id} onClick={() => newQuery(c.id, null)}>
                          <Icon name="code" size={13} /> New query on {c.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : active.kind === "query" ? (
              <QueryTab
                key={active.id}
                tab={active}
                overview={overviewOf(active.connection_id)}
                onChange={(next) => setTabs((all) => all.map((t) => (t.id === next.id ? next : t)))}
              />
            ) : activeOverview === undefined ? (
              <div className="db-pad"><Spinner /></div>
            ) : isError(activeOverview) ? (
              <div className="db-pad error-text">{activeOverview.error}</div>
            ) : active.kind === "table" ? (
              <TableTab
                key={active.id}
                tab={active}
                flavor={activeOverview.flavor}
                onQuery={(text) => newQuery(active.connection_id, active.database, text)}
                onDesign={() => openTab({ kind: "design", id: uid("n"), connection_id: active.connection_id, database: active.database, schema: active.schema, name: active.name, title: `${active.name}: design` })}
              />
            ) : active.kind === "design" ? (
              <DesignTab
                key={active.id}
                tab={active}
                flavor={activeOverview.flavor}
                readOnly={activeOverview.read_only}
                onSaved={(name, created) => {
                  refreshPlace(active);
                  if (created) {
                    closeTab(active.id);
                    openTab({ kind: "table", id: uid("t"), connection_id: active.connection_id, database: active.database, schema: active.schema, name, title: name });
                  } else if (name !== active.name) {
                    setTabs((all) => all.map((t) => (t.id === active.id ? { ...active, name, title: `${name}: design` } : t)));
                  }
                }}
              />
            ) : active.kind === "diagram" ? (
              <DiagramTab
                key={active.id}
                tab={active}
                onOpen={(name) => openTab({ kind: "table", id: uid("t"), connection_id: active.connection_id, database: active.database, schema: active.schema, name, title: name })}
              />
            ) : active.kind === "definition" ? (
              <DefinitionTab key={active.id} tab={active} flavor={activeOverview.flavor} onQuery={(text) => newQuery(active.connection_id, active.database, text)} />
            ) : active.kind === "activity" ? (
              <ActivityTab key={active.id} tab={active} />
            ) : (
              <UsersTab key={active.id} tab={active} overview={activeOverview} />
            )}
          </div>
        </section>
      </div>

      {dialog && kinds && (
        <ConnectionDialog
          kinds={kinds}
          initial={dialog.edit}
          only={(k) => k.engine === "sqlalchemy"}
          onClose={() => setDialog(null)}
          onKindsChanged={loadKinds}
          onSaved={(saved) => {
            setDialog(null);
            notify(`Saved ${saved.name}.`, "ok");
            loadConnections();
            setOverviews((o) => ({ ...o, [saved.id]: undefined }));
            setExpanded((all) => (all.includes(saved.id) ? all : [...all, saved.id]));
            loadOverview(saved.id, true);
          }}
        />
      )}
      {backingUp && (
        <BackupDialog connectionId={backingUp.connection_id} overview={backingUp.overview} database={backingUp.database} schema={backingUp.schema} onClose={() => setBackingUp(null)} />
      )}
      {restoring && (
        <RestoreDialog
          connectionId={restoring.connection_id}
          overview={restoring.overview}
          database={restoring.database}
          onClose={() => setRestoring(null)}
          onDone={() => {
            setObjects({});
            setSchemas({});
            loadOverview(restoring.connection_id, true);
          }}
        />
      )}
      {importing && (
        <ImportDialog
          connectionId={importing.connection_id}
          database={importing.database}
          schema={importing.schema}
          onClose={() => setImporting(null)}
          onDone={() => {
            const target = importing;
            setImporting(null);
            loadObjects(target.connection_id, target.database, target.schema);
          }}
        />
      )}
    </div>
  );
}
