import { useCallback, useEffect, useState } from "react";
import { useApp } from "../context";
import { BrowserEngine, parseEngineLink, rememberEngine, RemoteEngine, savedEngine, type Engine } from "../engine/engine";
import type { EngineEvent, Interpreter, KernelState } from "../types";
import { Icon } from "./Icon";
import { Modal, Notice, Spinner } from "./ui";

const WANTED: { module: string; package: string; why: string }[] = [
  { module: "torch", package: "torch", why: "neural networks on the GPU, image models" },
  { module: "torchvision", package: "torchvision", why: "pretrained image networks" },
  { module: "xgboost", package: "xgboost", why: "XGBoost models" },
  { module: "lightgbm", package: "lightgbm", why: "LightGBM models" },
];

function Packages({ packages }: { packages: Record<string, string | null> }) {
  const shown = ["sklearn", "pandas", "torch", "torchvision", "xgboost", "lightgbm"];
  const names: Record<string, string> = { sklearn: "scikit-learn" };
  return (
    <div className="pkgs">
      {shown.map((name) => (
        <span key={name} className={`badge ${packages[name] ? "ok" : ""}`} title={packages[name] ?? "not installed"}>
          {packages[name] ? <Icon name="check" size={10} /> : <Icon name="minus" size={10} />} {names[name] ?? name}
          {packages[name] ? ` ${String(packages[name]).split("+")[0]}` : ""}
        </span>
      ))}
    </div>
  );
}

function KernelPanel({ engine }: { engine: Engine }) {
  const { fail, refreshInfo, notify } = useApp();
  const [state, setState] = useState<KernelState | null>(null);
  const [interpreters, setInterpreters] = useState<Interpreter[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const kernel = engine.kernel!;

  const reload = useCallback(async () => {
    try {
      setState(await kernel.state());
      setInterpreters(await kernel.interpreters());
    } catch (error) {
      fail(error);
    }
  }, [kernel, fail]);

  useEffect(() => {
    void reload();
    return engine.subscribe((event: EngineEvent) => {
      if (event.type === "install") {
        if (event.line) setLog((lines) => [...lines.slice(-200), event.line!]);
        if (event.done) {
          setBusy(null);
          notify(event.code === 0 ? "Packages installed; the engine restarted." : "The install failed; see the log.", event.code === 0 ? "ok" : "error");
          void reload();
        }
      }
      if (event.type === "kernel" && event.status === "ready") {
        void reload();
        void refreshInfo();
      }
    });
  }, [engine, reload, notify, refreshInfo]);

  const choose = async (python: string | null) => {
    setBusy("select");
    try {
      setState(await kernel.select(python));
      await refreshInfo();
      notify("The engine now runs in that Python environment.", "ok");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
      void reload();
    }
  };

  const install = async (packages: string[]) => {
    setBusy("install");
    setLog([]);
    try {
      await kernel.install(packages);
    } catch (error) {
      setBusy(null);
      fail(error);
    }
  };

  const current = interpreters?.find((i) => (i.path ?? null) === (state?.python ?? null));
  const missing = current ? WANTED.filter((w) => !current.packages[w.module]) : [];
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="card tight">
        <div className="row">
          <span className={`dot ${state?.status === "ready" ? "ok" : state?.status === "starting" ? "busy" : "bad"}`} />
          <b>Kernel {state?.status ?? "…"}</b>
          <span className="dim small ellipsis">{state?.info && "executable" in state.info ? state.info.executable : ""}</span>
          <span className="spacer" />
          <button className="small" disabled={busy !== null} onClick={() => { setBusy("restart"); void kernel.restart().then(setState).catch(fail).finally(() => { setBusy(null); void reload(); }); }}>
            <Icon name="refresh" size={12} /> Restart
          </button>
        </div>
        {state?.error && <p className="error-text small" style={{ marginTop: 6 }}>{state.error}</p>}
        <p className="dim small" style={{ marginTop: 6 }}>
          Like a Jupyter kernel, training runs in a Python environment you choose, with that environment's packages, CPU cores and GPU.
        </p>
      </div>
      {missing.length > 0 && current?.source !== "builtin" && (
        <Notice level="info" icon="package">
          <div className="col" style={{ gap: 6 }}>
            <span>Optional packages for this environment:</span>
            {missing.map((m) => (
              <div className="row" key={m.module}>
                <code>{m.package}</code>
                <span className="dim small">{m.why}</span>
                <span className="spacer" />
                <button className="small" disabled={busy !== null} onClick={() => void install(m.module === "torchvision" ? ["torch", "torchvision"] : [m.package])}>
                  Install
                </button>
              </div>
            ))}
          </div>
        </Notice>
      )}
      {log.length > 0 && <div className="log">{log.join("\n")}</div>}
      <div>
        <h3 className="section-title">Python environments on this computer</h3>
        {!interpreters && <Spinner />}
        {interpreters?.map((interpreter) => {
          const active = (interpreter.path ?? null) === (state?.python ?? null);
          return (
            <div className="interp" key={interpreter.path ?? "builtin"}>
              <div style={{ minWidth: 0 }}>
                <div className="row">
                  <b>{interpreter.label}</b>
                  {interpreter.version && <span className="badge">Python {interpreter.version}</span>}
                  {active && <span className="badge ok">in use</span>}
                </div>
                {interpreter.path && <div className="faint tiny mono ellipsis">{interpreter.path}</div>}
                <Packages packages={interpreter.packages} />
                {!interpreter.ready && interpreter.missing.length > 0 && <div className="warn-text tiny">Needs {interpreter.missing.join(", ")}</div>}
              </div>
              <div className="col" style={{ gap: 4, alignItems: "flex-end" }}>
                {!active && (
                  <button className="small" disabled={busy !== null || !interpreter.version} onClick={() => void choose(interpreter.path)}>
                    Use this
                  </button>
                )}
                {active && !interpreter.ready && interpreter.path && (
                  <button className="small" disabled={busy !== null} onClick={() => void install(["numpy", "pandas", "scikit-learn", "scipy", "joblib", "pillow"])}>
                    Install requirements
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <div className="row" style={{ marginTop: 10 }}>
          <input placeholder="/path/to/python" value={custom} onChange={(e) => setCustom(e.target.value)} style={{ flex: 1 }} className="mono" />
          <button disabled={!custom || busy !== null} onClick={() => void choose(custom)}>
            Use path
          </button>
        </div>
      </div>
    </div>
  );
}

export function EngineDialog({ onClose, onSwitch }: { onClose: () => void; onSwitch: (engine: Engine) => void }) {
  const { engine, info, fail } = useApp();
  const saved = savedEngine();
  const [link, setLink] = useState(saved?.url ?? "http://127.0.0.1:8899");
  const [token, setToken] = useState(saved?.token ?? "");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const servedLocally = engine.kind === "local";

  const connect = async () => {
    const parsed = parseEngineLink(link, token);
    if (!parsed) {
      setError("Paste the link `flowlabs engine` printed, or its URL.");
      return;
    }
    setConnecting(true);
    setError(null);
    const next = new RemoteEngine(parsed.url, parsed.token, "remote");
    try {
      await next.hello();
      rememberEngine(parsed);
      onSwitch(next);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      next.close();
    } finally {
      setConnecting(false);
    }
  };

  const memory = info.memory ? `${info.memory.total_gb} GB RAM` : "";
  return (
    <Modal title="Engine" onClose={onClose} wide>
      <p className="dim" style={{ marginBottom: 14 }}>
        The engine is where your data is processed and models train. Each engine keeps its own datasets and projects.
      </p>
      <div className="engine-options">
        <button
          className={`engine-option ${engine.kind === "browser" ? "active" : ""}`}
          onClick={() => {
            if (engine.kind !== "browser") {
              rememberEngine(null);
              onSwitch(new BrowserEngine());
              onClose();
            }
          }}
        >
          <div className="row">
            <Icon name="globe" /> <b>In this browser</b>
          </div>
          <span className="dim small">Nothing to install. Data never leaves this device. Classic ML and small neural networks (NumPy).</span>
        </button>
        <button className={`engine-option ${engine.kind === "local" ? "active" : ""}`} disabled={!servedLocally}>
          <div className="row">
            <Icon name="laptop" /> <b>This computer</b>
          </div>
          <span className="dim small">{servedLocally ? "The desktop app's engine." : "Available in the desktop app, or by opening the link `flowlabs engine` prints."}</span>
        </button>
        <button className={`engine-option ${engine.kind === "remote" ? "active" : ""}`} onClick={() => document.getElementById("engine-link")?.focus()}>
          <div className="row">
            <Icon name="link" /> <b>Connect to an engine</b>
          </div>
          <span className="dim small">Use the CPU cores, RAM and GPU (CUDA or Apple) of a computer running <code>flowlabs engine</code>.</span>
        </button>
      </div>

      <div className="grid2" style={{ alignItems: "start" }}>
        <div className="col" style={{ gap: 14 }}>
          <div className="card tight">
            <h3 className="section-title">Current engine</h3>
            <div className="col" style={{ gap: 4 }}>
              <div className="row">
                <Icon name="cpu" /> {info.platform} · Python {info.python} · {info.cpus} CPU cores {memory && `· ${memory}`}
              </div>
              {info.gpus?.length ? (
                info.gpus.map((gpu) => (
                  <div className="row ok-text" key={gpu.name}>
                    <Icon name="gpu" /> {gpu.name} {gpu.memory_gb ? `· ${gpu.memory_gb} GB` : ""}
                  </div>
                ))
              ) : (
                <div className="row dim">
                  <Icon name="gpu" /> No GPU {engine.kind === "browser" ? "(browsers cannot use it for Python)" : "found by PyTorch"}
                </div>
              )}
              <Packages packages={info.packages} />
            </div>
          </div>
          <div className="card tight">
            <h3 className="section-title">Connect to an engine</h3>
            <ol className="small dim" style={{ margin: "0 0 10px", paddingLeft: 18 }}>
              <li>
                On the computer to use: <code>pip install "flowlabs[deep]"</code>
              </li>
              <li>
                Run <code>flowlabs engine</code>. It prints a link: open it, or paste it here.
              </li>
            </ol>
            <div className="field">
              <label>Link or engine URL</label>
              <input id="engine-link" className="mono" value={link} onChange={(e) => setLink(e.target.value)} placeholder="http://127.0.0.1:8899" />
            </div>
            <div className="field">
              <label>Token (if not in the link)</label>
              <input className="mono" value={token} onChange={(e) => setToken(e.target.value)} />
            </div>
            {error && <p className="error-text small" style={{ marginBottom: 8 }}>{error}</p>}
            <div className="row">
              <button className="primary" disabled={connecting} onClick={() => void connect().catch(fail)}>
                {connecting ? <Spinner /> : <Icon name="link" />} Connect
              </button>
              {engine.kind === "remote" && (
                <button
                  onClick={() => {
                    rememberEngine(null);
                    onSwitch(new BrowserEngine());
                    onClose();
                  }}
                >
                  Disconnect
                </button>
              )}
            </div>
            <p className="faint tiny" style={{ marginTop: 8 }}>
              From this hosted page, browsers allow engines on this computer (127.0.0.1). For an engine on another machine, open the address it prints instead.
            </p>
          </div>
        </div>
        {engine.kernel ? <KernelPanel engine={engine} /> : <Notice>The browser engine runs Python in this tab. To use a GPU, or PyTorch, XGBoost and LightGBM, connect an engine.</Notice>}
      </div>
    </Modal>
  );
}
