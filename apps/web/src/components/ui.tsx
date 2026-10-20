import { motion } from "motion/react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";

/** A dialog. It is drawn at the top of the page (a portal): opened from inside the top bar, whose
    blur makes it the box that "fixed" elements fill, it would otherwise be squeezed into the bar. */
export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <motion.div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
      <motion.div
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        initial={{ opacity: 0, scale: 0.96, y: 14 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 32 }}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <span className="spacer" />
          <button className="ghost icon-only" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </motion.div>
    </motion.div>,
    document.body,
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`switch ${on ? "on" : ""}`} style={disabled ? { opacity: 0.5 } : undefined}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ display: "none" }} />
      <span className="track" />
      {label && <span>{label}</span>}
    </label>
  );
}

/** An Apple-style segmented control: the white thumb slides to the chosen option. */
export function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (value: T) => void }) {
  const id = useId();
  return (
    <div className="segmented" role="tablist">
      {options.map((option) => (
        <button key={String(option.value)} role="tab" aria-selected={option.value === value} className={option.value === value ? "active" : ""} onClick={() => onChange(option.value)}>
          {option.value === value && <motion.span layoutId={`seg-${id}`} className="seg-thumb" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Notice({ level = "info", children, icon }: { level?: "info" | "warning" | "error" | "ok"; children: ReactNode; icon?: IconName }) {
  const name: IconName = icon ?? (level === "error" ? "error" : level === "warning" ? "warning" : level === "ok" ? "check" : "info");
  const colour = level === "error" ? "error-text" : level === "warning" ? "warn-text" : level === "ok" ? "ok-text" : "accent-text";
  return (
    <div className={`notice ${level}`}>
      <span className={colour}>
        <Icon name={name} className="icon" />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>{children}</div>
    </div>
  );
}

export function Spinner({ big }: { big?: boolean }) {
  return <span className={`spinner ${big ? "big" : ""}`} aria-label="working" />;
}

export function Bar({ value, tone }: { value: number; tone?: "red" | "orange" | "green" }) {
  return (
    <div className={`bar ${tone ?? ""}`}>
      <span style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

/** A text input that commits on blur / Enter, so typing does not re-run checks on every key. */
export function CommitInput({ value, onCommit, ...rest }: { value: string; onCommit: (value: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [text, setText] = useState(value);
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      setText(value);
      last.current = value;
    }
  }, [value]);
  const commit = () => {
    if (text !== last.current) {
      last.current = text;
      onCommit(text);
    }
  };
  return (
    <input
      {...rest}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
      }}
    />
  );
}

export function KindBadge({ kind }: { kind: string }) {
  const labels: Record<string, string> = { numeric: "number", categorical: "category", boolean: "yes/no", datetime: "date", text: "text" };
  return <span className={`badge ${kind}`}>{labels[kind] ?? kind}</span>;
}
