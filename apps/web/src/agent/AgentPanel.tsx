import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type Api } from "../api";
import { Icon } from "../components/Icon";

export interface AgentStatus {
  configured: boolean;
  model: string;
  snippets: number;
  categories: string[];
  sends: string;
  local_only: boolean;
  usage: { requests: number; cached: number; tokens: number };
}

export interface AgentPlan {
  target: string | null;
  steps: { use: string; with: Record<string, unknown> }[];
  note: string;
}

export interface AgentProposal {
  proposal_id: string | null;
  ok: boolean;
  error: string | null;
  errors: string[];
  attempts: { errors: string[]; prompt_tokens: number; completion_tokens: number; cached: boolean }[];
  tokens_spent: number;
  model: string | null;
  goal: string;
  dataset: string;
  plan: AgentPlan | null;
  steps: { id: string; title: string; category: string; auto: boolean; params: Record<string, unknown> }[];
  adjustments: string[];
  script: string | null;
  candidates: string[];
  suggested_file: string;
}

export interface AgentPreview {
  messages: { role: string; content: string }[];
  estimated_tokens: number;
  candidates: string[];
}

export interface SnippetInfo {
  id: string;
  title: string;
  category: string;
  description: string;
  signature: string;
}

const CONSENT_KEY = "flowlab-agent-consent";
const DATASET_KEY = "flowlab-agent-dataset";
const EXAMPLES = [
  "What drives the target? Build a model I can explain",
  "Profile this data: missing values, distributions, correlations",
  "Predict the target and show a confusion matrix",
  "Compare a numeric column across groups",
];

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* only a convenience */
  }
}

function message(error: unknown): string {
  return error instanceof ApiError ? error.message : String(error);
}

/**
 * Ask a question about a dataset. The LLM picks reviewed snippets and fills their params; the
 * server composes a runnable script with `# %%` cells, which opens in Code Mode (decision 0004).
 */
export function AgentPanel({ api, onClose, onOpenScript }: { api: Api; onClose: () => void; onOpenScript: (file: string) => void }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [datasets, setDatasets] = useState<string[]>([]);
  const [dataset, setDataset] = useState<string>(() => stored(DATASET_KEY) ?? "");
  const [goal, setGoal] = useState("");
  const [k, setK] = useState(12);
  const [useCache, setUseCache] = useState(true);
  const [consent, setConsent] = useState(() => stored(CONSENT_KEY) === "yes");
  const [preview, setPreview] = useState<AgentPreview | null>(null);
  const [busy, setBusy] = useState<"ask" | "compose" | "save" | "preview" | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<AgentProposal | null>(null);
  const [draft, setDraft] = useState<AgentPlan | null>(null);
  const [edited, setEdited] = useState(false);
  const [file, setFile] = useState("");
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const goalRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.agentStatus().then(setStatus).catch((e: unknown) => setError(message(e)));
    api
      .flows()
      .then((index) => {
        setDatasets(index.datasets);
        setDataset((current) => (current && index.datasets.includes(current) ? current : (index.datasets[0] ?? "")));
      })
      .catch((e: unknown) => setError(message(e)));
    goalRef.current?.focus();
  }, [api]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!busy || busy === "preview") return;
    setElapsed(0);
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => window.clearInterval(timer);
  }, [busy]);

  const accept = useCallback((next: AgentProposal) => {
    setProposal(next);
    setDraft(next.plan ? structuredClone(next.plan) : null);
    setEdited(false);
    setFile((current) => current || next.suggested_file);
    setConfirmOverwrite(false);
  }, []);

  const canAsk = Boolean(status?.configured && dataset && goal.trim() && consent && !busy);

  async function ask() {
    if (!canAsk) return;
    setBusy("ask");
    setError(null);
    try {
      const next = await api.agentAsk({ goal, dataset, k, use_cache: useCache, confirm_external: true });
      setFile(""); // a new question gets a new suggested file name; accept() fills it in
      accept(next);
      api.agentStatus().then(setStatus).catch(() => undefined);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  }

  async function showPreview() {
    if (preview) {
      setPreview(null);
      return;
    }
    if (!dataset || !goal.trim()) {
      setError("Pick a dataset and write a question to preview what would be sent.");
      return;
    }
    setBusy("preview");
    setError(null);
    try {
      setPreview(await api.agentPreview({ goal, dataset, k }));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  }

  async function recompose() {
    if (!proposal || !draft) return;
    setBusy("compose");
    setError(null);
    try {
      const next = await api.agentCompose({ goal: proposal.goal, dataset: proposal.dataset, plan: draft });
      accept({ ...next, attempts: proposal.attempts, tokens_spent: proposal.tokens_spent, model: proposal.model });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  }

  async function save(overwrite = false) {
    if (!proposal?.proposal_id || !file.trim()) return;
    setBusy("save");
    setError(null);
    try {
      const saved = await api.agentSave({ proposal_id: proposal.proposal_id, file: file.trim(), overwrite });
      onOpenScript(saved.file);
    } catch (e) {
      if (e instanceof ApiError && e.code === "FILE_EXISTS") setConfirmOverwrite(true);
      else setError(message(e));
    } finally {
      setBusy(null);
    }
  }

  const updateDraft = (next: AgentPlan) => {
    setDraft(next);
    setEdited(true);
  };

  return (
    <aside className="agent-panel" role="dialog" aria-label="Ask FlowLab">
      <header className="agent-head">
        <span className="agent-title"><Icon name="spark" /> Ask FlowLab</span>
        {status && <span className="chip mono" title="Groq model (set FLOWLAB_LLM_MODEL to change)">{status.model}</span>}
        <div className="spacer" />
        <button className="link-button" onClick={onClose} aria-label="Close">
          <Icon name="close" size={12} />
        </button>
      </header>

      <div className="agent-body">
        {status && !status.configured && (
          <div className="banner-inline">
            <strong>No Groq API key.</strong> Add <code>GROQ_API_KEY=…</code> to a <code>.env</code> file in the project folder (see{" "}
            <code>.env.example</code>) or export it before <code>flowlab serve</code>. Preview still works without a key.
          </div>
        )}

        <div className="field">
          <label htmlFor="agent-dataset">Dataset</label>
          <select
            id="agent-dataset"
            value={dataset}
            onChange={(e) => {
              setDataset(e.target.value);
              store(DATASET_KEY, e.target.value);
              setPreview(null);
            }}
          >
            {datasets.length === 0 && <option value="">No .csv / .parquet files in this folder</option>}
            {datasets.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="agent-goal">What do you want to find out?</label>
          <textarea
            id="agent-goal"
            ref={goalRef}
            rows={3}
            value={goal}
            maxLength={1000}
            placeholder="e.g. What drives churn? Build a model I can explain"
            onChange={(e) => {
              setGoal(e.target.value);
              setPreview(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void ask();
              }
            }}
          />
          <div className="chip-row">
            {EXAMPLES.map((example) => (
              <button key={example} className="chip link" onClick={() => setGoal(example)}>
                {example}
              </button>
            ))}
          </div>
        </div>

        <div className="agent-options">
          <label className="toggle" title="How many candidate snippets the model may choose from (fewer = fewer tokens)">
            Snippets offered{" "}
            <input type="number" min={4} max={30} value={k} onChange={(e) => setK(Math.max(4, Math.min(30, Number(e.target.value) || 12)))} />
          </label>
          <label className="toggle" title="Identical questions are answered from .flowlab/llm_cache for zero tokens">
            <input type="checkbox" checked={useCache} onChange={(e) => setUseCache(e.target.checked)} /> Reuse cached answers
          </label>
        </div>

        <div className="privacy-box">
          <div className="small">
            <strong>Sent to Groq:</strong> {status?.sends ?? "your question and a column summary"}. Never data rows or your code.
          </div>
          <div className="button-row">
            <button className="link-button" onClick={() => void showPreview()} disabled={busy === "preview"}>
              {preview ? "Hide prompt" : busy === "preview" ? "Building…" : "Preview exact prompt"}
            </button>
          </div>
          {preview && (
            <div className="prompt-preview">
              <div className="dim small">
                ~{preview.estimated_tokens} prompt tokens · {preview.candidates.length} snippets offered
              </div>
              {preview.messages.map((m, i) => (
                <details key={i} open={m.role === "user"}>
                  <summary className="mono small">{m.role}</summary>
                  <pre className="stream">{m.content}</pre>
                </details>
              ))}
            </div>
          )}
          <label className="toggle consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => {
                setConsent(e.target.checked);
                store(CONSENT_KEY, e.target.checked ? "yes" : "no");
              }}
            />
            Allow sending this summary to Groq
            {status?.local_only && <span className="dim small"> (Local-only mode is on; this is the only thing the canvas sends out)</span>}
          </label>
        </div>

        <div className="button-row">
          <button className="primary" disabled={!canAsk} onClick={() => void ask()} title="Ctrl/⌘+Enter">
            {busy === "ask" ? `Planning… ${elapsed}s` : "Ask"}
          </button>
          {status && (
            <span className="dim small">
              {status.usage.requests} request(s) so far · {status.usage.tokens.toLocaleString()} tokens · {status.usage.cached} from cache
            </span>
          )}
        </div>

        {error && <div className="error-box">{error}</div>}

        {proposal && (
          <ProposalView
            api={api}
            proposal={proposal}
            draft={draft}
            edited={edited}
            busy={busy}
            file={file}
            confirmOverwrite={confirmOverwrite}
            onDraft={updateDraft}
            onRecompose={() => void recompose()}
            onFile={(value) => {
              setFile(value);
              setConfirmOverwrite(false);
            }}
            onSave={(overwrite) => void save(overwrite)}
          />
        )}
      </div>
    </aside>
  );
}

function ProposalView(props: {
  api: Api;
  proposal: AgentProposal;
  draft: AgentPlan | null;
  edited: boolean;
  busy: string | null;
  file: string;
  confirmOverwrite: boolean;
  onDraft: (plan: AgentPlan) => void;
  onRecompose: () => void;
  onFile: (file: string) => void;
  onSave: (overwrite: boolean) => void;
}) {
  const { proposal, draft } = props;
  return (
    <section className="proposal">
      <h3>Result</h3>
      <div className="chip-row">
        {proposal.attempts.map((attempt, i) => (
          <span key={i} className={`chip ${attempt.errors.length ? "warn" : ""}`} title={attempt.errors.join("\n")}>
            {i === 0 ? "plan" : `repair ${i}`} · {attempt.cached ? "from cache" : `${attempt.prompt_tokens}+${attempt.completion_tokens} tokens`}
            {attempt.errors.length ? ` · ${attempt.errors.length} problem(s)` : ""}
          </span>
        ))}
        {proposal.attempts.length === 0 && <span className="chip">recomposed locally · 0 tokens</span>}
      </div>
      {!proposal.ok && (
        <div className="error-box">
          {proposal.error}
          {proposal.errors.length > 1 && (
            <ul className="small">
              {proposal.errors.slice(1).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {proposal.plan?.note && <p className="narration">{proposal.plan.note}</p>}

      {draft && <PlanEditor api={props.api} dataset={proposal.dataset} plan={draft} onChange={props.onDraft} />}
      {draft && (
        <div className="button-row">
          <button disabled={!props.edited || props.busy !== null} onClick={props.onRecompose} title="Assemble the edited plan locally; no LLM call">
            {props.busy === "compose" ? "Recomposing…" : "Recompose (0 tokens)"}
          </button>
          {props.edited && <span className="dim small">Plan edited; recompose to update the script.</span>}
        </div>
      )}

      {proposal.steps.length > 0 && (
        <>
          <h3>Script outline</h3>
          <ol className="outline">
            {proposal.steps.map((step, i) => (
              <li key={i}>
                <span className="mono">{step.id}</span> {step.title}
                {step.auto && (
                  <span className="chip" title="Added automatically because a later step needs it">
                    auto
                  </span>
                )}
                {Object.keys(step.params).length > 0 && <span className="dim small mono"> {JSON.stringify(step.params)}</span>}
              </li>
            ))}
          </ol>
          {proposal.adjustments.map((note, i) => (
            <div key={i} className="small warn-text">
              ~ {note}
            </div>
          ))}
        </>
      )}

      {proposal.script && (
        <details className="script-details" open>
          <summary>Script ({proposal.script.split("\n").length} lines, reviewed snippets only)</summary>
          <pre className="script-preview">{proposal.script}</pre>
        </details>
      )}

      {proposal.ok && (
        <div className="save-row">
          <input value={props.file} onChange={(e) => props.onFile(e.target.value)} aria-label="Save as" className="mono" />
          {props.confirmOverwrite ? (
            <button className="danger" onClick={() => props.onSave(true)} disabled={props.busy !== null}>
              Overwrite
            </button>
          ) : (
            <button className="primary" onClick={() => props.onSave(false)} disabled={props.busy !== null || props.edited || !props.file.trim()}>
              {props.busy === "save" ? "Saving…" : "Save & open in Code Mode"}
            </button>
          )}
        </div>
      )}
      {props.confirmOverwrite && <div className="small warn-text">{props.file} already exists. Overwrite it?</div>}
    </section>
  );
}

function PlanEditor({ api, dataset, plan, onChange }: { api: Api; dataset: string; plan: AgentPlan; onChange: (plan: AgentPlan) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SnippetInfo[]>([]);
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      api.agentSnippets(query, dataset).then((found) => setResults(found.slice(0, 8))).catch(() => setResults([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [api, query, dataset]);

  return (
    <div className="plan-editor">
      <h3>Plan</h3>
      <div className="field">
        <label htmlFor="plan-target">Target column</label>
        <input id="plan-target" className="mono" value={plan.target ?? ""} placeholder="none" onChange={(e) => onChange({ ...plan, target: e.target.value || null })} />
      </div>
      {plan.steps.map((step, i) => (
        <PlanStepRow
          key={`${i}:${step.use}`}
          step={step}
          onChange={(next) => onChange({ ...plan, steps: plan.steps.map((s, j) => (j === i ? next : s)) })}
          onRemove={() => onChange({ ...plan, steps: plan.steps.filter((_, j) => j !== i) })}
        />
      ))}
      <input className="snippet-search" placeholder="Add a step: search snippets…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search snippets" />
      {results.length > 0 && (
        <div className="snippet-results">
          {results.map((snippet) => (
            <button
              key={snippet.id}
              onClick={() => {
                onChange({ ...plan, steps: [...plan.steps, { use: snippet.id, with: {} }] });
                setQuery("");
              }}
              title={snippet.description}
            >
              <span>{snippet.title}</span>
              <span className="dim small mono">{snippet.signature}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PlanStepRow({ step, onChange, onRemove }: { step: AgentPlan["steps"][number]; onChange: (step: AgentPlan["steps"][number]) => void; onRemove: () => void }) {
  const [text, setText] = useState(() => JSON.stringify(step.with));
  const [bad, setBad] = useState(false);
  return (
    <div className="plan-step">
      <span className="mono plan-step-id">{step.use}</span>
      <input
        className={`mono ${bad ? "bad" : ""}`}
        value={text}
        aria-label={`Params for ${step.use}`}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          try {
            const parsed: unknown = JSON.parse(text || "{}");
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
            setBad(false);
            if (JSON.stringify(parsed) !== JSON.stringify(step.with)) onChange({ ...step, with: parsed as Record<string, unknown> });
          } catch {
            setBad(true);
          }
        }}
      />
      <button className="link-button" onClick={onRemove} aria-label={`Remove ${step.use}`}>
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
