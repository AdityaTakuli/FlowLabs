import { useEffect, useRef } from "react";
import { Icon } from "./Icon";

export interface ConsoleLine {
  id: number;
  ts: string;
  kind: "stdout" | "stderr" | "info" | "error";
  node: string | null;
  text: string;
  /** The line has not ended yet (no newline): the next chunk continues or, after a carriage return, replaces it. */
  open?: boolean;
}

interface ConsoleProps {
  lines: ConsoleLine[];
  open: boolean;
  badge: string;
  onToggle: () => void;
  onClear: () => void;
  onSelect: (nodeId: string) => void;
}

export function Console({ lines, open, badge, onToggle, onClear, onSelect }: ConsoleProps) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = body.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 80) element.scrollTop = element.scrollHeight;
  }, [lines]);
  return (
    <footer className="console">
      <div className="console-head">
        <button className="link-button" onClick={onToggle} aria-expanded={open}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={11} /> Console
        </button>
        <span className="dim small">{lines.length} lines</span>
        <div className="spacer" />
        <span className="transmission" title="What this project would send to FlowLab's servers">
          {badge}
        </span>
        <button className="link-button" onClick={onClear}>
          Clear
        </button>
      </div>
      {open && (
        <div className="console-body" ref={body}>
          {lines.length === 0 && <div className="dim">Output from running blocks appears here.</div>}
          {lines.map((line) => (
            <div key={line.id} className={`console-line ${line.kind}`}>
              <span className="ts">{line.ts}</span>
              {line.node ? (
                <button className="node-ref" onClick={() => onSelect(line.node as string)}>
                  {line.node}
                </button>
              ) : (
                <span className="node-ref empty" />
              )}
              <span className="text">{line.text.replace(/\n$/, "")}</span>
            </div>
          ))}
        </div>
      )}
    </footer>
  );
}
