import type { ReactNode } from "react";
import { useApp } from "../context";
import { androidBridge } from "../engine/engine";
import { Icon } from "./Icon";

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <span className="logo-mark" style={{ width: size, height: size }} aria-hidden>
      <svg width={size * 0.64} height={size * 0.64} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <circle cx="6" cy="7" r="3" />
        <circle cx="18" cy="7" r="3" />
        <circle cx="12" cy="18" r="3" />
        <path d="M9 7h6M7.4 9.6l3.2 5.8M16.6 9.6l-3.2 5.8" />
      </svg>
    </span>
  );
}

export function EngineChip() {
  const { engine, info, openEngine } = useApp();
  const gpu = info.gpus?.[0];
  const label = engine.kind === "browser" ? (androidBridge() ? "This phone" : "Browser") : engine.kind === "local" ? "This computer" : engine.label;
  return (
    <button className="engine-chip" onClick={openEngine} title="Engine: where your models train. Click to change.">
      <span className="dot ok" />
      <Icon name={engine.kind === "browser" ? "globe" : engine.kind === "local" ? "laptop" : "link"} size={14} />
      <span className="engine-label">{label}</span>
      {gpu ? <span className="badge ok">GPU</span> : <span className="badge">{info.cpus} CPU</span>}
    </button>
  );
}

export function TopBar({ children, actions, onHome }: { children?: ReactNode; actions?: ReactNode; onHome?: () => void }) {
  return (
    <header className="topbar">
      <button className="brand" onClick={onHome} disabled={!onHome} aria-label="FlowLabs home">
        <LogoMark />
        <span className="brand-name">FlowLabs</span>
      </button>
      {children}
      <span className="spacer" />
      {actions}
      <EngineChip />
    </header>
  );
}
