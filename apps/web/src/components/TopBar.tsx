import { motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { useApp } from "../context";
import { androidBridge } from "../engine/engine";
import { Icon } from "./Icon";
import { UpdateButton } from "./Updates";

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
      <span className="faint engine-spec">{gpu ? "GPU" : `${info.cpus} CPU`}</span>
    </button>
  );
}

type Theme = "light" | "dark";
const THEME_KEY = "flowlabs-theme";

/** The chosen theme, or none to follow the system. Applied before the first paint (see main.tsx). */
export function applyStoredTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") document.documentElement.dataset.theme = stored;
  } catch {
    /* storage blocked: follow the system */
  }
}

function currentTheme(): Theme {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function ThemeButton() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      className="ghost icon-only"
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem(THEME_KEY, next);
        } catch {
          /* not remembered, still switched */
        }
        setTheme(next);
      }}
      title={`Switch to the ${next} theme`}
      aria-label={`Switch to the ${next} theme`}
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} />
    </button>
  );
}

/** Opens the guide at the topic for the page you are on. */
function HelpButton({ topic }: { topic: string }) {
  const { openGuide } = useApp();
  return (
    <button className="ghost icon-only" onClick={() => openGuide(topic)} title="Guide for this page" aria-label="Guide for this page">
      <Icon name="help" />
    </button>
  );
}

export function TopBar({ children, actions, onHome, help }: { children?: ReactNode; actions?: ReactNode; onHome?: () => void; help?: string }) {
  return (
    <header className="topbar">
      <button className="brand" onClick={onHome} disabled={!onHome} aria-label="FlowLabs home">
        <LogoMark />
        <span className="brand-name">FlowLabs</span>
      </button>
      {children}
      <span className="spacer" />
      {actions}
      <UpdateButton />
      <EngineChip />
      {help && <HelpButton topic={help} />}
      <ThemeButton />
    </header>
  );
}

/** Projects | Guide, as a pill switch whose thumb slides between the two pages. */
export function SectionNav({ current, onProjects, onGuide }: { current: "projects" | "guide"; onProjects: () => void; onGuide?: () => void }) {
  const { openGuide } = useApp();
  const item = (id: "projects" | "guide", label: ReactNode, go: () => void) => (
    <button className={`ghost small ${current === id ? "active" : ""}`} aria-current={current === id ? "page" : undefined} onClick={current === id ? undefined : go}>
      {current === id && <motion.span layoutId="section-thumb" className="nav-thumb" transition={{ type: "spring", stiffness: 480, damping: 38 }} />}
      {label}
    </button>
  );
  return (
    <nav className="top-nav" aria-label="Sections">
      {item("projects", "Projects", onProjects)}
      {item("guide", <><Icon name="book" size={13} /> Guide</>, onGuide ?? (() => openGuide("getting-started")))}
    </nav>
  );
}
