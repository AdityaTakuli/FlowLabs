// The Connect dialog, drawn from each source's fields (sources.py): PostgreSQL and MySQL with SSL and
// SSH, warehouses, files and cloud storage. It installs a missing driver, tests, and saves.
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../context";
import type { DbConnection, SourceField, SourceKind } from "../types";
import { Icon } from "./Icon";
import { Modal, Notice, Spinner, Switch } from "./ui";

type Values = Record<string, unknown>;
type Test = { ok: boolean; message: string; ssh_fingerprint?: string };

/** The fields that apply: like sources.visible, a field whose condition field is hidden is hidden too. */
export function visibleFields(kind: SourceKind, values: Values): SourceField[] {
  const shown: SourceField[] = [];
  const names = new Set<string>();
  for (const field of kind.fields) {
    if (field.when) {
      const [other, allowed] = field.when;
      if (!names.has(other)) continue;
      let current = values[other];
      if (current === undefined || current === null || current === "") current = kind.fields.find((f) => f.name === other)?.default;
      if (!allowed.includes(current)) continue;
    }
    shown.push(field);
    names.add(field.name);
  }
  return shown;
}

function startValues(kind: SourceKind, saved?: Values): Values {
  const values: Values = {};
  for (const field of kind.fields) {
    if (field.secret) continue;
    const value = saved?.[field.name];
    values[field.name] = value !== undefined ? value : field.default ?? (field.kind === "bool" ? false : "");
  }
  return values;
}

/** Install a driver (or paramiko for SSH) and follow pip's output. */
function useInstall(onDone: () => void) {
  const { engine, fail } = useApp();
  const [job, setJob] = useState<{ id: string; lines: string[]; code?: number } | null>(null);
  useEffect(() => {
    if (!job || job.code !== undefined) return;
    return engine.subscribe((event) => {
      if (event.type !== "install" || event.job_id !== job.id) return;
      if (event.done) {
        setJob((j) => (j ? { ...j, code: event.code ?? 0 } : j));
        onDone();
      } else if (event.line) {
        setJob((j) => (j ? { ...j, lines: [...j.lines.slice(-5), event.line!] } : j));
      }
    });
  }, [engine, job, onDone]);
  const start = async (kind: string, extra?: "ssh") => {
    try {
      const started = await engine.call<{ job_id: string }>("sources.install", { kind, extra });
      setJob({ id: started.job_id, lines: [] });
    } catch (error) {
      fail(error);
    }
  };
  return { job, start, running: Boolean(job && job.code === undefined) };
}

function FieldInput({ field, value, onChange, savedSecret, id }: { field: SourceField; value: unknown; onChange: (value: unknown) => void; savedSecret: boolean; id: string }) {
  if (field.kind === "bool") return <Switch on={Boolean(value)} onChange={onChange} label={field.label} />;
  if (field.kind === "select")
    return (
      <select id={id} value={String(value ?? field.default ?? "")} onChange={(e) => onChange(e.target.value)}>
        {field.options.map(([option, label]) => (
          <option key={option} value={option}>
            {label}
          </option>
        ))}
      </select>
    );
  if (field.kind === "textarea") return <textarea id={id} rows={4} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} spellCheck={false} />;
  return (
    <input
      id={id}
      type={field.kind === "password" ? "password" : field.kind === "number" ? "number" : "text"}
      value={value === undefined || value === null ? "" : String(value)}
      onChange={(e) => onChange(field.kind === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)}
      placeholder={field.secret && savedSecret ? "Unchanged" : field.placeholder}
      autoComplete={field.secret ? "new-password" : "off"}
      spellCheck={false}
    />
  );
}

export function ConnectionDialog({ kinds, initial, only, onClose, onSaved, onKindsChanged }: {
  kinds: SourceKind[];
  initial: DbConnection | null;
  /** Which sources to offer; all when left out. */
  only?: (kind: SourceKind) => boolean;
  onClose: () => void;
  onSaved: (connection: DbConnection) => void;
  /** A driver was installed: read the sources again. */
  onKindsChanged?: () => void;
}) {
  const { engine, fail, openGuide } = useApp();
  const offered = useMemo(() => kinds.filter((k) => (only ? only(k) : true) || k.id === initial?.kind), [kinds, only, initial]);
  const [kindId, setKindId] = useState(initial?.kind ?? offered[0]?.id ?? "postgresql");
  const kind = offered.find((k) => k.id === kindId) ?? offered[0];
  const [values, setValues] = useState<Values>(() => (kind ? startValues(kind, initial?.values) : {}));
  const [name, setName] = useState(initial?.name ?? "");
  const [allowChanges, setAllowChanges] = useState(Boolean(initial?.allow_changes));
  const [test, setTest] = useState<Test | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const install = useInstall(() => onKindsChanged?.());
  const saved = new Set(initial?.kind === kindId ? initial.secrets_set : []);

  if (!kind) return null;
  const fields = visibleFields(kind, values);
  const set = (field: string, value: unknown) => {
    setValues((v) => ({ ...v, [field]: value }));
    setTest(null);
  };
  const payload = (extra: Values = {}) => ({ id: initial?.id, kind: kind.id, name, allow_changes: allowChanges, values: { ...values, ...extra } });

  const check = async (extra: Values = {}) => {
    setBusy("test");
    try {
      setTest(await engine.call<Test>("sql.connection_test", { connection: payload(extra) }));
    } catch (error) {
      setTest({ ok: false, message: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy("save");
    try {
      onSaved(await engine.call<DbConnection>("sql.connection_save", { connection: payload() }));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };
  const trust = (fingerprint: string) => {
    set("ssh_fingerprint", fingerprint);
    void check({ ssh_fingerprint: fingerprint });
  };
  const groups = [...new Set(offered.map((k) => k.group))];
  const needsSsh = Boolean(values.ssh) && kind.ssh_needs.length > 0;
  const writes = kind.engine !== "storage";

  return (
    <Modal
      title={initial ? `Edit ${initial.name}` : "Connect a database"}
      onClose={onClose}
      footer={
        <>
          {test && (
            <span className={`small ${test.ok ? "ok-text" : "error-text"} sql-test`} role="status">
              <Icon name={test.ok ? "check" : "error"} size={13} /> {test.ok ? test.message : test.ssh_fingerprint ? "The SSH server is not trusted yet." : test.message}
            </span>
          )}
          <span className="spacer" />
          <button onClick={() => void check()} disabled={busy !== null || install.running}>
            {busy === "test" ? <Spinner /> : <Icon name="bolt" size={13} />} Test
          </button>
          <button className="primary" onClick={() => void save()} disabled={busy !== null || install.running}>
            {busy === "save" ? <Spinner /> : null} {initial ? "Save changes" : "Save connection"}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="conn-kind">Connect to</label>
        <select
          id="conn-kind"
          value={kind.id}
          disabled={Boolean(initial)}
          onChange={(e) => {
            const next = offered.find((k) => k.id === e.target.value);
            if (!next) return;
            setKindId(next.id);
            setValues(startValues(next));
            setTest(null);
          }}
        >
          {groups.map((group) => (
            <optgroup key={group} label={group}>
              {offered.filter((k) => k.group === group).map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {kind.about && <span className="help">{kind.about}</span>}
      </div>

      {kind.needs.length > 0 && (
        <Notice level="warning" icon="download">
          <p>
            {kind.label} needs its Python driver ({kind.packages.join(", ")}{kind.size_mb ? `, about ${kind.size_mb} MB` : ""}).
          </p>
          {kind.installable ? (
            <button className="small" style={{ marginTop: 8 }} onClick={() => void install.start(kind.id)} disabled={install.running}>
              {install.running ? <Spinner /> : <Icon name="download" size={12} />} Install the driver
            </button>
          ) : (
            <p className="small dim">Install it in the engine's Python with pip.</p>
          )}
        </Notice>
      )}

      {fields.map((field) => {
        const id = `conn-${field.name}`;
        if (field.kind === "bool")
          return (
            <div className="field" key={field.name}>
              <FieldInput field={field} value={values[field.name]} onChange={(v) => set(field.name, v)} savedSecret={saved.has(field.name)} id={id} />
              {field.help && <span className="help">{field.help}</span>}
            </div>
          );
        return (
          <div className={`field ${field.name.startsWith("ssh_") ? "conn-indent" : ""}`} key={field.name}>
            <label htmlFor={id}>
              {field.label}
              {field.required && <span className="faint"> (required)</span>}
            </label>
            <FieldInput field={field} value={values[field.name]} onChange={(v) => set(field.name, v)} savedSecret={saved.has(field.name)} id={id} />
            {field.help && <span className="help">{field.help}</span>}
          </div>
        );
      })}

      {needsSsh && (
        <Notice level="warning" icon="download">
          <p>Connecting through SSH needs paramiko (about 6 MB).</p>
          <button className="small" style={{ marginTop: 8 }} onClick={() => void install.start(kind.id, "ssh")} disabled={install.running}>
            {install.running ? <Spinner /> : <Icon name="download" size={12} />} Install paramiko
          </button>
        </Notice>
      )}

      {install.job && (
        <pre className="log" aria-live="polite">
          {install.job.lines.join("\n") || "Starting pip…"}
          {install.job.code !== undefined && (install.job.code === 0 ? "\nInstalled." : `\npip stopped with code ${install.job.code}.`)}
        </pre>
      )}

      {test?.ssh_fingerprint && (
        <Notice level="warning" icon="lock">
          <p>{test.message}</p>
          <button className="small" style={{ marginTop: 8 }} onClick={() => trust(test.ssh_fingerprint!)}>
            <Icon name="check" size={12} /> Trust this server
          </button>
        </Notice>
      )}

      <div className="field">
        <label htmlFor="conn-name">Name in FlowLabs</label>
        <input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the database name" />
      </div>
      {writes && (
        <div className="field">
          <Switch on={allowChanges} onChange={(on) => { setAllowChanges(on); setTest(null); }} label="Allow changes to this database" />
          <span className="help">
            {allowChanges
              ? "Statements that write (INSERT, UPDATE, CREATE…) run, and you can edit rows and manage users."
              : "Read-only: statements that write are refused, and the server session itself is read-only."}
          </span>
        </div>
      )}
      <p className="faint small">
        Passwords and keys go in this computer's keychain (or, where there is none, a file only you can read), never in the connection file. Queries run on the computer the engine runs on.{" "}
        <button className="link" onClick={() => openGuide("databases#connect")}>
          About connections
        </button>
      </p>
    </Modal>
  );
}
