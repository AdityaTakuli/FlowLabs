import type { ReactNode } from "react";
import { useApp } from "../context";
import { Icon } from "./Icon";

export function EngineChip() {
  const { engine, info, openEngine } = useApp();
  const gpu = info.gpus?.[0];
  return (
    <button className="engine-chip" onClick={openEngine} title="Engine: where your models train">
      <span className="dot ok" />
      <Icon name={engine.kind === "browser" ? "globe" : engine.kind === "local" ? "laptop" : "link"} size={13} />
      <span>{engine.kind === "browser" ? "Browser engine" : engine.kind === "local" ? "This computer" : engine.label}</span>
      {gpu ? <span className="badge ok">{gpu.kind === "cuda" ? "GPU" : "Apple GPU"}</span> : <span className="badge">{info.cpus} CPU</span>}
    </button>
  );
}

export function TopBar({ children, actions, onHome }: { children?: ReactNode; actions?: ReactNode; onHome?: () => void }) {
  return (
    <div className="topbar">
      <button className="brand" onClick={onHome} disabled={!onHome}>
        <Icon name="logo" size={18} className="logo" /> Synapse
      </button>
      {children}
      <span className="spacer" />
      {actions}
      <EngineChip />
    </div>
  );
}
