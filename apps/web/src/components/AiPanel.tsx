// The AI panel: a conversation docked on the right, like a code editor's assistant. The page on the
// left says what is open (useAiTarget): the query and its last run, or the sheet and its selection.
// The assistant answers, and its changes (a new query, cells written) go straight into that page,
// each with Undo, or wait for Apply when automatic changes are off.
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useApp } from "../context";
import type { AiStatus } from "../types";
import { AiSettings } from "./AiSettings";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { Spinner } from "./ui";

/** A change to a machine learning project, checked by the engine (core/ai_project.py). */
export interface ProjectAction {
  type: "project";
  change: "add_step" | "add_model" | "update" | "remove" | "settings" | "train";
  stage: string;
  op: string;
  item: string;
  params: Record<string, unknown>;
  target: string;
  metric: string;
  label: string;
  dropped: string[];
}
export type AiAction =
  | { type: "sql"; sql: string; run: boolean }
  | { type: "cells"; sheet: string; start: string; values: string[][] }
  | ProjectAction;
export type AiAbility = "sql" | "cells" | "project";

export interface AiTarget {
  /** What the panel says it is working on: "Query on Sales DB", "Sheet1 of Budget". */
  label: string;
  /** The same for the model, with a word on what kind of page it is. */
  view: string;
  can: AiAbility[];
  /** What the assistant sees, read when a question is sent. */
  context: () => {
    text: string;
    dataset_id?: string | null;
    connection_id?: string | null;
    /** The project itself, so the assistant can name its steps and models and change them. */
    project?: unknown;
  };
  /** Make the change; the result can take it back. */
  apply?: (action: AiAction) => AiApplied | Promise<AiApplied>;
  /** Questions to start with on this page. */
  suggestions?: string[];
}
export interface AiApplied {
  undo?: () => void;
  /** What happened, when it is worth saying: "Ran it", "Not run: it changes data". */
  note?: string;
}

/** Fired when Ask AI's provider changes anywhere, so every page shows the new one. */
export const AI_CHANGED = "flowlabs-ai-changed";

type Applied = {
  action: AiAction;
  state: "applied" | "waiting" | "undone" | "failed";
  note?: string;
};
interface Item {
  id: number;
  role: "user" | "assistant" | "error";
  text: string;
  actions?: Applied[];
  model?: string;
}

interface Registry {
  open: boolean;
  setOpen: (open: boolean | ((open: boolean) => boolean)) => void;
  register: (id: string, target: { current: AiTarget | null }) => () => void;
  touch: () => void;
}

const PanelContext = createContext<Registry | null>(null);
const TargetContext = createContext<{ current: AiTarget | null } | null>(null);

const OPEN_KEY = "flowlabs-ai-open";
const WIDTH_KEY = "flowlabs-ai-width";
const AUTO_KEY = "flowlabs-ai-auto";
const CHAT_KEY = "flowlabs-ai-chat";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* not remembered */
  }
}

/** A query that only reads runs by itself; one that changes data waits for the user. */
export function readsOnly(sql: string): boolean {
  const text = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^']|'')*'/g, "''");
  if (!/^\s*(select|with|explain|show|describe|desc|pragma|values|table|from)\b/i.test(text)) return false;
  return !/\b(insert|update|delete|drop|alter|create|truncate|merge|grant|revoke|attach|copy|call|vacuum|set)\b/i.test(text);
}

/** The cells an action covers, as A1:B2. */
export function actionArea(action: Extract<AiAction, { type: "cells" }>): string {
  const match = /^([A-Z]+)(\d+)$/.exec(action.start);
  if (!match) return action.start;
  const colOf = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const nameOf = (n: number) => {
    let s = "";
    for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };
  const rows = action.values.length;
  const cols = Math.max(1, ...action.values.map((r) => r.length));
  const end = `${nameOf(colOf(match[1]!) + cols - 1)}${Number(match[2]) + rows - 1}`;
  return end === action.start ? action.start : `${action.start}:${end}`;
}

/** How an earlier answer reads to the model next time: its message and what it changed. */
function asTurn(item: Item): string {
  const done = (item.actions ?? []).map(({ action, state }) => {
    const verb = state === "undone" ? "(undone) " : state === "waiting" ? "(not applied yet) " : "";
    if (action.type === "sql") return `${verb}Put this query in the editor:\n\`\`\`sql\n${action.sql}\n\`\`\``;
    if (action.type === "project") return `${verb}${action.label}${Object.keys(action.params).length ? ` ${JSON.stringify(action.params).slice(0, 400)}` : ""}`;
    return `${verb}Wrote ${actionArea(action)}${action.sheet ? ` on ${action.sheet}` : ""}: ${JSON.stringify(action.values).slice(0, 1500)}`;
  });
  return [item.text, ...done].filter(Boolean).join("\n\n");
}

/** Pages call this with what they show; the last page to register is the one the panel works on. */
export function useAiTarget(target: AiTarget | null) {
  const registry = useContext(PanelContext);
  const ref = useRef(target);
  ref.current = target;
  const id = useId();
  const active = target !== null;
  useEffect(() => {
    if (!registry || !active) return;
    return registry.register(id, ref);
  }, [registry, id, active]);
  const label = target?.label;
  useEffect(() => {
    registry?.touch();
  }, [registry, label]);
}

export function useAiPanel() {
  return useContext(PanelContext);
}

export function AiPanelProvider({ children }: { children: ReactNode }) {
  const { engine } = useApp();
  const desktop = engine.kind !== "browser";
  const [open, setOpenState] = useState(() => desktop && stored(OPEN_KEY) === "1");
  const targets = useRef<{ id: string; ref: { current: AiTarget | null } }[]>([]);
  const [, setVersion] = useState(0);
  const touch = useCallback(() => setVersion((v) => v + 1), []);
  const setOpen = useCallback(
    (next: boolean | ((open: boolean) => boolean)) =>
      setOpenState((was) => {
        const value = desktop && (typeof next === "function" ? next(was) : next);
        store(OPEN_KEY, value ? "1" : null);
        return value;
      }),
    [desktop],
  );
  const register = useCallback(
    (id: string, ref: { current: AiTarget | null }) => {
      targets.current = [...targets.current.filter((t) => t.id !== id), { id, ref }];
      touch();
      return () => {
        targets.current = targets.current.filter((t) => t.id !== id);
        touch();
      };
    },
    [touch],
  );
  const registry = useMemo(() => ({ open, setOpen, register, touch }), [open, setOpen, register, touch]);

  // Ctrl+L or Ctrl+Alt+I opens the panel and puts the cursor in it, as in code editors
  useEffect(() => {
    if (!desktop) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || !((e.key.toLowerCase() === "l" && !e.altKey && !e.shiftKey) || (e.altKey && e.code === "KeyI"))) return;
      e.preventDefault();
      setOpen(true);
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".ai-composer textarea")?.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [desktop, setOpen]);

  // The newest page that can change things (an editor inside a project page) wins over one that only describes
  const all = targets.current;
  const current = [...all].reverse().find((t) => t.ref.current?.apply)?.ref ?? all[all.length - 1]?.ref ?? null;
  return (
    <PanelContext.Provider value={registry}>
      <TargetContext.Provider value={current}>
        <div className={`app-frame ${open ? "with-ai" : ""}`}>
          {children}
          {open && <AiPanel onClose={() => setOpen(false)} />}
        </div>
      </TargetContext.Provider>
    </PanelContext.Provider>
  );
}

function loadChat(): Item[] {
  try {
    const items = JSON.parse(stored(CHAT_KEY) ?? "[]") as Item[];
    return Array.isArray(items) ? items.slice(-60) : [];
  } catch {
    return [];
  }
}

function AiPanel({ onClose }: { onClose: () => void }) {
  const { engine } = useApp();
  const targetRef = useContext(TargetContext);
  const target = targetRef?.current ?? null;
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [settings, setSettings] = useState(false);
  const [items, setItems] = useState<Item[]>(loadChat);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(() => stored(AUTO_KEY) !== "0");
  const [width, setWidth] = useState(() => Math.min(720, Math.max(300, Number(stored(WIDTH_KEY)) || 400)));
  const undos = useRef(new Map<string, () => void>());
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const nextId = useRef(Date.now());

  useEffect(() => {
    const load = () => engine.call<AiStatus>("ai.status").then(setStatus, () => setStatus(null));
    void load();
    window.addEventListener(AI_CHANGED, load);
    return () => window.removeEventListener(AI_CHANGED, load);
  }, [engine]);
  // messages that pop up in the corner move left of the panel, off the message box
  useEffect(() => {
    document.documentElement.style.setProperty("--ai-open-width", `${width}px`);
    return () => {
      document.documentElement.style.removeProperty("--ai-open-width");
    };
  }, [width]);
  useEffect(() => {
    store(CHAT_KEY, items.length ? JSON.stringify(items.slice(-60)) : null);
    list.current?.scrollTo({
      top: list.current.scrollHeight,
      behavior: "smooth",
    });
  }, [items]);
  useEffect(() => {
    if (status?.configured) input.current?.focus();
  }, [status?.configured]);

  const setAction = (itemId: number, index: number, patch: Partial<Applied>) =>
    setItems((all) =>
      all.map((it) =>
        it.id === itemId && it.actions
          ? {
              ...it,
              actions: it.actions.map((a, i) => (i === index ? { ...a, ...patch } : a)),
            }
          : it,
      ),
    );

  const apply = async (itemId: number, index: number, action: AiAction, run: boolean) => {
    const page = targetRef?.current;
    if (!page?.apply || !page.can.includes(action.type)) return;
    try {
      const done = await page.apply(action.type === "sql" ? { ...action, run } : action);
      if (done.undo) undos.current.set(`${itemId}:${index}`, done.undo);
      setAction(itemId, index, { state: "applied", note: done.note });
    } catch (error) {
      setAction(itemId, index, {
        state: "failed",
        note: (error as Error).message,
      });
    }
  };

  const undo = (itemId: number, index: number) => {
    const fn = undos.current.get(`${itemId}:${index}`);
    if (!fn) return;
    fn();
    undos.current.delete(`${itemId}:${index}`);
    setAction(itemId, index, { state: "undone", note: undefined });
  };

  const send = async (text: string = draft) => {
    const question = text.trim();
    if (!question || busy) return;
    const page = targetRef?.current ?? null;
    const asked: Item = { id: nextId.current++, role: "user", text: question };
    const history = [...items.filter((i) => i.role !== "error"), asked];
    setItems((all) => [...all, asked]);
    setDraft("");
    setBusy(true);
    try {
      const seen = page?.context() ?? { text: "" };
      const answer = await engine.call<{
        message: string;
        actions: AiAction[];
        model: string;
      }>("ai.chat", {
        messages: history.map((i) => ({
          role: i.role,
          content: i.role === "assistant" ? asTurn(i) : i.text,
        })),
        view: page?.view ?? "the home page",
        context: seen.text,
        can: page?.apply ? page.can : [],
        dataset_id: seen.dataset_id ?? null,
        connection_id: seen.connection_id ?? null,
        project: page?.apply && page.can.includes("project") ? (seen.project ?? null) : null,
      });
      const id = nextId.current++;
      const actions: Applied[] = answer.actions.map((action) => ({
        action,
        state: "waiting",
      }));
      setItems((all) => [
        ...all,
        {
          id,
          role: "assistant",
          text: answer.message,
          actions,
          model: answer.model,
        },
      ]);
      if (auto && page?.apply) {
        for (const [index, action] of answer.actions.entries()) {
          const run = action.type === "sql" && action.run && readsOnly(action.sql);
          await apply(id, index, action, run);
          if (action.type === "sql" && action.run && !run)
            setAction(id, index, {
              state: "applied",
              note: "Not run: it changes data. Check it, then run it in the editor.",
            });
        }
      }
    } catch (error) {
      setItems((all) => [...all, { id: nextId.current++, role: "error", text: (error as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  const resize = (event: React.PointerEvent) => {
    const startX = event.clientX;
    const startWidth = width;
    let last = width;
    const move = (e: PointerEvent) => {
      last = Math.min(Math.max(300, window.innerWidth * 0.6), Math.max(300, startWidth + startX - e.clientX));
      setWidth(last);
    };
    const up = () => {
      store(WIDTH_KEY, String(Math.round(last)));
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const ready = Boolean(status?.configured);
  const suggestions = target?.suggestions ?? ["What can you do here?", "How do I import my own data?", "Which model should I use to predict churn?"];
  return (
    <aside className="ai-panel" style={{ "--ai-width": `${width}px` } as React.CSSProperties} aria-label="AI assistant">
      <div className="ai-resize" onPointerDown={resize} role="separator" aria-orientation="vertical" aria-label="Resize the AI panel" />
      <header className="ai-head">
        <Icon name="sparkles" size={14} className="accent-text" />
        <b>AI</b>
        {status && (
          <button className="ghost small ai-model" onClick={() => setSettings(true)} title="Change the provider, key or model">
            {ready ? `${status.provider_label} · ${status.model}` : "Not connected"}
          </button>
        )}
        <span className="spacer" />
        <button
          className="ghost icon-only small"
          onClick={() => {
            setItems([]);
            undos.current.clear();
          }}
          disabled={!items.length || busy}
          title="New chat"
          aria-label="New chat"
        >
          <Icon name="plus" size={14} />
        </button>
        <button className="ghost icon-only small" onClick={onClose} title="Close (Ctrl+L opens it again)" aria-label="Close the AI panel">
          <Icon name="close" size={14} />
        </button>
      </header>

      <div className="ai-thread" ref={list} aria-live="polite">
        {status && !ready ? (
          <div className="ai-empty">
            <p>
              <b>Connect an AI</b>
            </p>
            <p className="dim small">Use your own key from Claude, OpenAI, Gemini, Groq or GitHub, or a gateway on this computer. Each one has steps to get a key.</p>
            <button className="primary" onClick={() => setSettings(true)}>
              Connect
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="ai-empty">
            <p className="dim small">
              {target ? (
                <>
                  Ask about <b>{target.label}</b>, or ask for a change and it happens on the left. Every change can be undone.
                </>
              ) : (
                "Ask anything about your data, SQL, spreadsheets or models."
              )}
            </p>
            <div className="ai-suggestions">
              {suggestions.map((s) => (
                <button key={s} className="small" onClick={() => void send(s)} disabled={busy || !ready}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          items.map((item) => (
            <div key={item.id} className={`ai-msg ${item.role}`}>
              {item.role === "user" ? (
                <p>{item.text}</p>
              ) : item.role === "error" ? (
                <p className="error-text small">
                  <Icon name="warning" size={12} /> {item.text}
                </p>
              ) : (
                <>
                  {item.text && <Markdown text={item.text} className="ai-text" />}
                  {item.actions?.map((applied, index) => (
                    <ActionCard
                      key={index}
                      applied={applied}
                      canApply={Boolean(target?.apply && target.can.includes(applied.action.type))}
                      canUndo={undos.current.has(`${item.id}:${index}`)}
                      onApply={(run) => void apply(item.id, index, applied.action, run)}
                      onUndo={() => undo(item.id, index)}
                    />
                  ))}
                </>
              )}
            </div>
          ))
        )}
        {busy && (
          <div className="ai-msg assistant faint small">
            <Spinner /> {status?.model ?? "The AI"} is thinking…
          </div>
        )}
      </div>

      <form
        className="ai-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {target && (
          <span className="ai-sees faint tiny" title="What the AI can see and change">
            <Icon name="eye" size={11} /> {target.label}
          </span>
        )}
        <textarea
          ref={input}
          value={draft}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={ready ? (target?.apply ? "Ask, or describe a change…" : "Ask anything…") : "Connect an AI first"}
          disabled={!ready}
          aria-label="Message to the AI"
        />
        <div className="ai-composer-bar">
          <label className="ai-auto tiny faint" title="Changes go into the page at once, each with Undo. Off: they wait for Apply.">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => {
                setAuto(e.target.checked);
                store(AUTO_KEY, e.target.checked ? null : "0");
              }}
            />
            Apply changes automatically
          </label>
          <span className="spacer" />
          <button type="submit" className="primary small" disabled={busy || !ready || !draft.trim()} aria-label="Send">
            {busy ? <Spinner /> : <Icon name="arrowUp" size={13} />}
          </button>
        </div>
        <p className="faint tiny ai-privacy">
          Sent to {status?.provider_label ?? "the provider"}: your messages and what the page shows: table and column names with a few common values, the query and its errors, in Sheets the first rows
          and the cells you select, and in a project its steps, models, settings and last scores.
        </p>
      </form>
      {settings && status && (
        <AiSettings
          status={status}
          onClose={() => setSettings(false)}
          onSaved={(next) => {
            setStatus(next);
            setSettings(false);
            window.dispatchEvent(new Event(AI_CHANGED));
          }}
        />
      )}
    </aside>
  );
}

function ActionCard({
  applied,
  canApply,
  canUndo,
  onApply,
  onUndo,
}: {
  applied: Applied;
  canApply: boolean;
  canUndo: boolean;
  onApply: (run: boolean) => void;
  onUndo: () => void;
}) {
  const { action, state, note } = applied;
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text =
      action.type === "sql"
        ? action.sql
        : action.type === "project"
          ? `${action.label}${Object.keys(action.params).length ? `\n${JSON.stringify(action.params, null, 2)}` : ""}`
          : action.values.map((r) => r.join("\t")).join("\n");
    void navigator.clipboard?.writeText(text).then(() => setCopied(true));
  };
  return (
    <div className={`ai-action ${state}`}>
      <div className="ai-action-head tiny">
        <Icon name={action.type === "sql" ? "code" : action.type === "project" ? "layers" : "table"} size={12} />
        <span>
          {action.type === "sql" ? "Query" : action.type === "project" ? action.label : `${actionArea(action)}${action.sheet ? ` on ${action.sheet}` : ""}`}
        </span>
        <span className="faint">{state === "applied" ? "· applied" : state === "undone" ? "· undone" : state === "failed" ? "· not applied" : ""}</span>
        <span className="spacer" />
        <button className="ghost icon-only small" onClick={copy} title={copied ? "Copied" : "Copy"} aria-label="Copy">
          <Icon name={copied ? "check" : "copy"} size={11} />
        </button>
      </div>
      {action.type === "sql" ? (
        <pre className="ai-code">{action.sql}</pre>
      ) : action.type === "project" ? (
        <ProjectChange action={action} />
      ) : (
        <div className="ai-cells">
          <table>
            <tbody>
              {action.values.slice(0, 8).map((row, r) => (
                <tr key={r}>
                  {row.slice(0, 6).map((value, c) => (
                    <td key={c} className={value.startsWith("=") ? "mono" : ""}>
                      {value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {(action.values.length > 8 || action.values.some((r) => r.length > 6)) && <span className="faint tiny">and more</span>}
        </div>
      )}
      {note && <p className={`tiny ${state === "failed" ? "error-text" : "faint"}`}>{note}</p>}
      <div className="ai-action-bar">
        {state === "applied" && canUndo && (
          <button className="small" onClick={onUndo}>
            Undo
          </button>
        )}
        {(state === "waiting" || state === "undone" || state === "failed") &&
          (canApply ? (
            <>
              <button className="small primary" onClick={() => onApply(false)}>
                {action.type === "sql" ? "Put in editor" : "Apply"}
              </button>
              {action.type === "sql" && (
                <button className="small" onClick={() => onApply(true)}>
                  <Icon name="play" size={11} /> Put in and run
                </button>
              )}
            </>
          ) : (
            <span className="faint tiny">
              {action.type === "sql" ? "Open a SQL editor to use it." : action.type === "project" ? "Open the project to apply it." : "Open the workbook to apply it."}
            </span>
          ))}
      </div>
    </div>
  );
}

/** A project change in words: its settings, and the ones that were left out because they do not exist. */
function ProjectChange({ action }: { action: ProjectAction }) {
  const settings = Object.entries(action.params);
  if (!settings.length && !action.dropped.length) return null;
  return (
    <div className="ai-project">
      {settings.length > 0 && (
        <dl>
          {settings.map(([name, value]) => (
            <div key={name}>
              <dt>{name.replace(/_/g, " ")}</dt>
              <dd className="mono">{typeof value === "string" ? value : JSON.stringify(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {action.dropped.length > 0 && <p className="faint tiny">Left out (not a setting of this step): {action.dropped.join(", ")}</p>}
    </div>
  );
}
