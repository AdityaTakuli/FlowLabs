// Ask AI's settings: which provider writes the SQL (Groq, OpenAI, Anthropic, GitHub Models or any
// OpenAI-compatible endpoint), its key, model and, for a custom endpoint, its address.
import { useEffect, useState } from "react";
import { useApp } from "../context";
import type { AiProvider, AiStatus } from "../types";
import { Icon } from "./Icon";
import { Modal, Notice, Spinner } from "./ui";

/** Install Anthropic's SDK and follow pip's output (the same events as a database driver). */
function useSdkInstall(onDone: () => void) {
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
  const start = async () => {
    try {
      const started = await engine.call<{ job_id: string }>("ai.install");
      setJob({ id: started.job_id, lines: [] });
    } catch (error) {
      fail(error);
    }
  };
  return { job, start, running: Boolean(job && job.code === undefined) };
}

export function AiSettings({ status, onClose, onSaved }: { status: AiStatus; onClose: () => void; onSaved: (status: AiStatus) => void }) {
  const { engine, fail } = useApp();
  const [current, setCurrent] = useState(status);
  const [providerId, setProviderId] = useState(status.provider);
  const provider: AiProvider = current.providers.find((p) => p.id === providerId) ?? current.providers[0]!;
  const [key, setKey] = useState("");
  const [model, setModel] = useState(provider.model);
  const [baseUrl, setBaseUrl] = useState(provider.base_url);
  const [listed, setListed] = useState<Record<string, string[]>>({});
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [local, setLocal] = useState<Record<string, { running: boolean; needs_key: boolean; url: string }> | null>(null);
  useEffect(() => {
    engine.call<Record<string, { running: boolean; needs_key: boolean; url: string }>>("ai.detect").then(setLocal, () => setLocal({}));
  }, [engine]);
  const loadModels = async () => {
    setListing(true);
    setListError(null);
    try {
      const names = await engine.call<string[]>("ai.models", { provider: provider.id, base_url: provider.needs_url ? baseUrl : null, key: key || null });
      setListed((all) => ({ ...all, [provider.id]: names }));
      if (names.length && !model) setModel(names[0]!);
    } catch (error) {
      setListError((error as Error).message);
    } finally {
      setListing(false);
    }
  };
  const suggestions = listed[provider.id] ?? provider.models;
  const [busy, setBusy] = useState(false);
  const install = useSdkInstall(() => {
    engine.call<AiStatus>("ai.status").then(setCurrent, fail);
  });

  const pick = (id: string) => {
    const next = current.providers.find((p) => p.id === id);
    setProviderId(id);
    setKey("");
    setModel(next?.model ?? "");
    setBaseUrl(next?.base_url ?? "");
    setListError(null);
  };

  const save = async (remove = false) => {
    setBusy(true);
    try {
      const params: Record<string, unknown> = { provider: provider.id, key: remove ? "" : key || null, model };
      if (provider.needs_url) params.base_url = baseUrl;
      onSaved(await engine.call<AiStatus>("ai.configure", params));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const ready = provider.needs_url ? Boolean(baseUrl.trim() && model.trim()) : Boolean(key || provider.source);
  return (
    <Modal
      title="Ask AI"
      onClose={onClose}
      footer={
        <>
          {provider.source === "saved" && (
            <button className="danger" onClick={() => void save(true)} disabled={busy}>
              Remove the key
            </button>
          )}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void save()} disabled={busy || !ready || install.running}>
            {busy ? <Spinner /> : null} Use {provider.label}
          </button>
        </>
      }
    >
      <p className="dim" style={{ marginBottom: 14 }}>
        Ask AI turns questions in plain English into SQL. Pick who writes it: a provider with your own key, or a gateway on this computer that holds many keys.
      </p>
      <div className="ai-providers" role="radiogroup" aria-label="AI provider">
        {current.providers.map((p) => (
          <button key={p.id} role="radio" aria-checked={p.id === providerId} className={`ai-provider ${p.id === providerId ? "active" : ""}`} onClick={() => pick(p.id)}>
            <b>{p.label}</b>
            <span className="faint tiny">
              {p.local && local && !local[p.id]?.running
                ? "Not running"
                : p.configured
                  ? p.id === current.provider
                    ? "In use"
                    : p.local
                      ? "Running"
                      : "Ready"
                  : p.source === "environment"
                    ? "Key from environment"
                    : "Not set up"}
            </span>
          </button>
        ))}
      </div>

      <p className="dim small ai-help">{provider.key_help}</p>
      {provider.local && local && (
        <p className={`small ai-local ${local[provider.id]?.running ? "ok-text" : "faint"}`}>
          <span className={`dot ${local[provider.id]?.running ? "ok" : ""}`} />{" "}
          {local[provider.id]?.running
            ? `Running on this computer${local[provider.id]?.needs_key ? ", and it wants a key" : ""}.`
            : `Not running on this computer yet (FlowLabs looked at ${local[provider.id]?.url ?? provider.base_url}).`}
        </p>
      )}
      <details className="ai-steps" key={provider.id} open={!provider.configured || (provider.local && local !== null && !local[provider.id]?.running)}>
        <summary>{provider.local ? "How to set it up" : provider.id === "custom" ? "What you need" : "How to get a key"}</summary>
        <ol>
          {provider.steps.map((step, i) => (
            <li key={i}>{step.split("`").map((part, j) => (j % 2 ? <code key={j}>{part}</code> : part))}</li>
          ))}
        </ol>
        {provider.key_url && (
          <a href={provider.key_url} target="_blank" rel="noreferrer" className="small">
            Open {provider.key_url.replace(/^https?:\/\//, "")} <Icon name="external" size={10} />
          </a>
        )}
      </details>

      {provider.needs_url && (
        <div className="field">
          <label htmlFor="ai-url">Endpoint address</label>
          <input id="ai-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={provider.local ? provider.base_url : "https://llm.example.com/v1"} spellCheck={false} autoComplete="off" />
          <span className="help">The address before /chat/completions. FlowLabs adds the rest.</span>
        </div>
      )}

      {provider.source === "environment" ? (
        <Notice level="ok">The key comes from the {provider.env} environment variable.</Notice>
      ) : (
        <div className="field">
          <label htmlFor="ai-key">
            {provider.label} API key{provider.key_optional ? " (if the server needs one)" : ""}
          </label>
          <input id="ai-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={provider.source === "saved" ? "Saved. Paste a new one to replace it." : ""} autoComplete="off" />
        </div>
      )}

      <div className="field">
        <label htmlFor="ai-model">Model</label>
        <div className="row">
          <input id="ai-model" list="ai-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder={provider.needs_url ? "The model's name on that server" : ""} spellCheck={false} style={{ flex: 1 }} />
          {provider.id !== "github" && (
            <button className="small" onClick={() => void loadModels()} disabled={listing || (provider.needs_url && !baseUrl.trim())} title="Ask the endpoint which models it offers">
              {listing ? <Spinner /> : <Icon name="refresh" size={12} />} Load models
            </button>
          )}
        </div>
        <datalist id="ai-models">
          {suggestions.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {listError ? (
          <span className="help error-text">{listError}</span>
        ) : listed[provider.id] ? (
          <span className="help">{listed[provider.id]!.length} models. Type to search them.</span>
        ) : null}
      </div>

      {provider.needs_package && (
        <Notice level="warning">
          <div className="row wrap" style={{ justifyContent: "space-between" }}>
            <span>Claude needs Anthropic's Python package (about 5 MB), installed once.</span>
            <button className="small" onClick={() => void install.start()} disabled={install.running}>
              {install.running ? <Spinner /> : <Icon name="download" size={12} />} Install it
            </button>
          </div>
        </Notice>
      )}
      {install.job && (
        <pre className="log" aria-live="polite">
          {install.job.lines.join("\n") || "Starting pip…"}
          {install.job.code !== undefined && (install.job.code === 0 ? "\nInstalled." : `\npip stopped with code ${install.job.code}.`)}
        </pre>
      )}

      <p className="faint small">
        Sent to {provider.label}: your question, table and column names with their types, and a few common values of category columns. Rows of data are never sent. Keys are kept in your
        system's keychain. A ChatGPT, Claude or Copilot chat plan is not an API key: these services only let other apps in through their APIs.
      </p>
    </Modal>
  );
}
