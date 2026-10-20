// Server activity (who is connected, what is running, stop it) and users and roles.
import { useCallback, useEffect, useState } from "react";
import { useApp } from "../../context";
import { Icon } from "../../components/Icon";
import { Modal, Notice, Spinner, Switch } from "../../components/ui";
import { bytes } from "../../format";
import type { DbActivity, DbFlavor, DbGrants, DbOverview, DbUser, DbUsers } from "../../types";

export interface AdminTabState {
  kind: "activity" | "users";
  id: string;
  connection_id: string;
  title: string;
}

function uptime(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${Math.floor(seconds / 86400)} days`;
}

export function ActivityTab({ tab }: { tab: AdminTabState }) {
  const { engine, fail, notify } = useApp();
  const [data, setData] = useState<DbActivity | null>(null);
  const [live, setLive] = useState(true);
  const [idle, setIdle] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await engine.call<DbActivity>("db.activity", { connection_id: tab.connection_id }));
    } catch (error) {
      setLive(false);
      fail(error);
    }
  }, [engine, fail, tab.connection_id]);
  useEffect(() => {
    void load();
    if (!live) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load, live]);
  const stop = async (id: number, terminate: boolean) => {
    if (terminate && !window.confirm(`End session ${id}? Its open transaction is rolled back and the client is disconnected.`)) return;
    try {
      await engine.call("db.stop", { connection_id: tab.connection_id, backend_id: id, terminate });
      notify(terminate ? `Ended session ${id}.` : `Asked session ${id} to stop its query.`, "ok");
      void load();
    } catch (error) {
      fail(error);
    }
  };
  if (!data) return <div className="db-pad"><Spinner /></div>;
  const s = data.server;
  const sessions = data.sessions.filter((x) => idle || (x.state !== "idle" && x.state !== "Sleep"));
  return (
    <div className="db-pad db-admin">
      <div className="stat-row">
        <div className="stat"><div className="value">{s.connections}<span className="faint" style={{ fontSize: "0.5em" }}> / {s.max_connections}</span></div><div className="label">connections</div></div>
        <div className="stat"><div className="value">{uptime(s.uptime_s)}</div><div className="label">up for</div></div>
        {s.database_bytes !== undefined && <div className="stat"><div className="value">{bytes(s.database_bytes)}</div><div className="label">this database</div></div>}
        {s.queries !== undefined && <div className="stat"><div className="value">{s.queries.toLocaleString()}</div><div className="label">statements since start</div></div>}
      </div>
      <div className="db-grid-bar">
        <h3>Sessions</h3>
        <span className="dim small">{s.version}</span>
        <span className="spacer" />
        <Switch on={idle} onChange={setIdle} label="Show idle" />
        <Switch on={live} onChange={setLive} label="Refresh every 3 s" />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Session</th>
              <th>User</th>
              <th>Database</th>
              <th>State</th>
              <th className="num">For</th>
              <th>Query</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.map((x) => (
              <tr key={x.id}>
                <td className="num">
                  {x.id} {x.mine && <span className="badge" title="A query tab in FlowLabs">FlowLabs</span>}
                </td>
                <td>{x.user}</td>
                <td>{x.database}</td>
                <td>
                  {x.state}
                  {x.waiting && <span className="warn-text small"> waiting on {x.waiting}</span>}
                </td>
                <td className="num">{x.seconds < 1 ? "<1 s" : `${Math.round(x.seconds).toLocaleString()} s`}</td>
                <td className="wrap-cell mono small db-activity-query" title={x.query ?? ""}>{x.query}</td>
                <td className="actions">
                  <button className="ghost small" onClick={() => void stop(x.id, false)} title="Cancel the query it is running">Stop query</button>
                  {!data.read_only && <button className="ghost small danger" onClick={() => void stop(x.id, true)} title="Disconnect the session">End session</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sessions.length === 0 && <p className="dim sql-no-rows">Nothing is running. Turn on Show idle to see every session.</p>}
      </div>
    </div>
  );
}

type Change = { action: "create" | "password" | "drop" | "grant" | "revoke"; user?: DbUser };

function UserChange({ change, flavor, connectionId, overview, onClose, onDone }: { change: Change; flavor: DbFlavor; connectionId: string; overview: DbOverview | null; onClose: () => void; onDone: () => void }) {
  const { engine, fail, notify } = useApp();
  const mysql = flavor === "mysql";
  const [params, setParams] = useState<Record<string, unknown>>({ name: change.user?.name ?? "", host: change.user?.host ?? "%", login: true, scope: mysql ? "database" : "schema", target: mysql ? (overview?.default ?? "") : "public", privileges: [] as string[] });
  const [scopes, setScopes] = useState<Record<string, string[]>>({});
  const [preview, setPreview] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (change.action === "grant" || change.action === "revoke") engine.call<{ scopes: Record<string, string[]> }>("db.privileges", { connection_id: connectionId }).then((p) => setScopes(p.scopes), fail);
  }, [engine, fail, connectionId, change.action]);
  const set = (key: string, value: unknown) => {
    setParams((p) => ({ ...p, [key]: value }));
    setPreview(null);
  };
  const show = async () => {
    try {
      setPreview((await engine.call<{ sql: string[] }>("db.user_change", { connection_id: connectionId, action: change.action, params, preview: true })).sql);
    } catch (error) {
      fail(error);
    }
  };
  const run = async () => {
    setBusy(true);
    try {
      await engine.call("db.user_change", { connection_id: connectionId, action: change.action, params });
      notify("Done.", "ok");
      onDone();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  const titles = { create: "New user", password: `Change the password of ${change.user?.name}`, drop: `Delete ${change.user?.name}`, grant: `Grant privileges to ${change.user?.name}`, revoke: `Revoke privileges from ${change.user?.name}` };
  const chosen = (params.privileges as string[]) ?? [];
  const available = scopes[String(params.scope)] ?? [];
  return (
    <Modal
      title={titles[change.action]}
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          {preview ? (
            <button className={change.action === "drop" ? "danger" : "primary"} onClick={() => void run()} disabled={busy}>
              {busy ? <Spinner /> : null} {change.action === "drop" ? "Delete the user" : "Run it"}
            </button>
          ) : (
            <button className="primary" onClick={() => void show()}>Review the SQL</button>
          )}
        </>
      }
    >
      {change.action === "create" && (
        <>
          <div className="field">
            <label htmlFor="u-name">Name</label>
            <input id="u-name" value={String(params.name)} onChange={(e) => set("name", e.target.value)} autoFocus spellCheck={false} />
          </div>
          {mysql && (
            <div className="field">
              <label htmlFor="u-host">Connects from</label>
              <input id="u-host" value={String(params.host)} onChange={(e) => set("host", e.target.value)} spellCheck={false} />
              <span className="help">% means anywhere; localhost only from the database's own machine; or an address such as 10.0.%.</span>
            </div>
          )}
        </>
      )}
      {(change.action === "create" || change.action === "password") && (
        <div className="field">
          <label htmlFor="u-pass">{change.action === "create" ? "Password" : "New password"}</label>
          <input id="u-pass" type="password" autoComplete="new-password" value={String(params.password ?? "")} onChange={(e) => set("password", e.target.value)} />
        </div>
      )}
      {change.action === "create" && !mysql && (
        <div className="col" style={{ marginBottom: 16 }}>
          <Switch on={Boolean(params.login)} onChange={(on) => set("login", on)} label="Can sign in (off makes a group role)" />
          <Switch on={Boolean(params.create_db)} onChange={(on) => set("create_db", on)} label="Can create databases" />
          <Switch on={Boolean(params.create_role)} onChange={(on) => set("create_role", on)} label="Can create roles" />
          <Switch on={Boolean(params.superuser)} onChange={(on) => set("superuser", on)} label="Superuser (can do anything)" />
        </div>
      )}
      {(change.action === "grant" || change.action === "revoke") && (
        <>
          <div className="field">
            <label htmlFor="g-scope">On</label>
            <select id="g-scope" value={String(params.scope)} onChange={(e) => { set("scope", e.target.value); set("privileges", []); }}>
              {Object.keys(scopes).map((scope) => (
                <option key={scope} value={scope}>
                  {scope === "database" ? (mysql ? "A whole database" : "A database") : scope === "schema" ? "A schema" : mysql ? "One table" : "Tables in a schema, or one table"}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="g-target">{params.scope === "tables" ? (mysql ? "database.table" : "schema, or schema.table") : params.scope === "schema" ? "Schema" : "Database"}</label>
            <input id="g-target" value={String(params.target)} onChange={(e) => set("target", e.target.value)} spellCheck={false} list="g-targets" />
            <datalist id="g-targets">{overview?.databases.filter((d) => !d.system).map((d) => <option key={d.name} value={d.name} />)}</datalist>
          </div>
          <div className="field">
            <span className="field-label">Privileges</span>
            <div className="chips">
              {available.map((p) => (
                <label key={p} className={`chip db-chip ${chosen.includes(p) ? "token" : ""}`}>
                  <input type="checkbox" checked={chosen.includes(p)} onChange={(e) => set("privileges", e.target.checked ? [...chosen, p] : chosen.filter((x) => x !== p))} /> {p.toLowerCase()}
                </label>
              ))}
            </div>
          </div>
        </>
      )}
      {change.action === "drop" && <Notice level="warning">The user can no longer sign in. Objects it owns may need a new owner first; the database says so if they do.</Notice>}
      {preview && (
        <>
          <p className="dim small">This runs on the server:</p>
          <pre className="code">{preview.join("\n")}</pre>
        </>
      )}
    </Modal>
  );
}

export function UsersTab({ tab, overview }: { tab: AdminTabState; overview: DbOverview | null }) {
  const { engine, fail } = useApp();
  const [data, setData] = useState<DbUsers | null>(null);
  const [chosen, setChosen] = useState<DbUser | null>(null);
  const [grants, setGrants] = useState<DbGrants | null>(null);
  const [change, setChange] = useState<Change | null>(null);
  const load = useCallback(() => {
    engine.call<DbUsers>("db.users", { connection_id: tab.connection_id }).then(setData, fail);
  }, [engine, fail, tab.connection_id]);
  useEffect(load, [load]);
  useEffect(() => {
    setGrants(null);
    if (!chosen) return;
    engine.call<DbGrants>("db.grants", { connection_id: tab.connection_id, user: chosen.name, host: chosen.host }).then(setGrants, fail);
  }, [engine, fail, tab.connection_id, chosen]);
  if (!data) return <div className="db-pad"><Spinner /></div>;
  const key = (u: DbUser) => `${u.name}@${u.host ?? ""}`;
  return (
    <div className="db-users">
      <aside className="db-users-list">
        <div className="db-grid-bar">
          <h3>{data.flavor === "postgresql" ? "Roles" : "Users"}</h3>
          <span className="spacer" />
          {!data.read_only && (
            <button className="ghost small" onClick={() => setChange({ action: "create" })}>
              <Icon name="plus" size={12} /> New
            </button>
          )}
        </div>
        {data.note && <p className="faint small">{data.note}</p>}
        {data.users.map((u) => (
          <button key={key(u)} className={`sql-source ${chosen && key(chosen) === key(u) ? "active" : ""}`} onClick={() => setChosen(u)}>
            <Icon name={u.login ? "users" : "layers"} size={14} />
            <span className="sql-source-text">
              <span>
                {u.name}
                {u.host && <span className="faint">@{u.host}</span>}
              </span>
              <span className="faint tiny">{u.superuser ? "superuser" : u.login ? "can sign in" : "group role"}{data.current.split("@")[0] === u.name ? ", you" : ""}</span>
            </span>
          </button>
        ))}
      </aside>
      <section className="db-pad db-user">
        {!chosen ? (
          <p className="dim">Choose a {data.flavor === "postgresql" ? "role" : "user"} to see what it may do.</p>
        ) : (
          <>
            <div className="db-object-head">
              <Icon name="users" size={16} />
              <h2>
                {chosen.name}
                {chosen.host && <span className="faint">@{chosen.host}</span>}
              </h2>
              <span className="spacer" />
              {!data.read_only && (
                <>
                  <button className="ghost small" onClick={() => setChange({ action: "grant", user: chosen })}>Grant…</button>
                  <button className="ghost small" onClick={() => setChange({ action: "revoke", user: chosen })}>Revoke…</button>
                  <button className="ghost small" onClick={() => setChange({ action: "password", user: chosen })}>Password…</button>
                  <button className="ghost small danger" onClick={() => setChange({ action: "drop", user: chosen })}>Delete…</button>
                </>
              )}
            </div>
            {data.read_only && <p className="faint small">The connection is read-only, so users can be looked at but not changed.</p>}
            {data.flavor === "postgresql" && (
              <div className="chips" style={{ marginBottom: 16 }}>
                {([["login", "Can sign in"], ["superuser", "Superuser"], ["create_db", "Creates databases"], ["create_role", "Creates roles"], ["replication", "Replication"]] as const).map(([k, label]) => (
                  <span key={k} className={`badge ${(chosen as unknown as Record<string, boolean>)[k] ? "ok" : ""}`}>{(chosen as unknown as Record<string, boolean>)[k] ? <Icon name="check" size={10} /> : null} {label}</span>
                ))}
                {chosen.member_of && chosen.member_of.length > 0 && <span className="badge solid">member of {chosen.member_of.join(", ")}</span>}
              </div>
            )}
            {!grants ? (
              <Spinner />
            ) : grants.statements ? (
              <pre className="code">{grants.statements.join(";\n")};</pre>
            ) : (
              <>
                <h3>Databases</h3>
                <div className="table-wrap" style={{ marginBottom: 16 }}>
                  <table>
                    <thead><tr><th>Database</th><th>Connect</th><th>Create schemas</th><th>Temporary tables</th></tr></thead>
                    <tbody>{grants.databases!.map((d) => <tr key={d.name}><td>{d.name}</td><td>{d.connect ? "Yes" : "No"}</td><td>{d.create ? "Yes" : "No"}</td><td>{d.temp ? "Yes" : "No"}</td></tr>)}</tbody>
                  </table>
                </div>
                <h3>Schemas in {overview?.default}</h3>
                <div className="table-wrap" style={{ marginBottom: 16 }}>
                  <table>
                    <thead><tr><th>Schema</th><th>Use</th><th>Create in it</th></tr></thead>
                    <tbody>{grants.schemas!.map((s) => <tr key={s.name}><td>{s.name}</td><td>{s.usage ? "Yes" : "No"}</td><td>{s.create ? "Yes" : "No"}</td></tr>)}</tbody>
                  </table>
                </div>
                <h3>Tables granted directly</h3>
                {grants.tables!.length === 0 ? <p className="dim">None.</p> : (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Table</th><th>Privileges</th></tr></thead>
                      <tbody>{grants.tables!.map((t) => <tr key={`${t.schema}.${t.name}`}><td>{t.schema}.{t.name}</td><td className="small">{t.privileges.toLowerCase()}</td></tr>)}</tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </section>
      {change && (
        <UserChange
          change={change}
          flavor={data.flavor}
          connectionId={tab.connection_id}
          overview={overview}
          onClose={() => setChange(null)}
          onDone={() => {
            setChange(null);
            if (change.action === "drop") setChosen(null);
            load();
            if (chosen && change.action !== "drop") setChosen({ ...chosen });
          }}
        />
      )}
    </div>
  );
}
