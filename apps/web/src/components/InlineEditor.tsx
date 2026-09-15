import { useEffect, useState } from "react";
import type { CodeNode } from "../types";
import { CodeEditor } from "./CodeEditor";

/** Edit a block right on the canvas. Saving rewrites only this block; downstream blocks turn stale. */
export interface SourceProblem {
  message: string;
  line: number | null;
}

export function InlineEditor({
  node,
  kernelReady,
  onCheck,
  onSave,
  onRun,
  onClose,
}: {
  node: CodeNode;
  kernelReady: boolean;
  /** Parse the draft first: code that does not parse would break the whole file's graph. */
  onCheck: (source: string) => Promise<SourceProblem | null>;
  onSave: (source: string) => Promise<boolean>;
  onRun: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(node.source);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<SourceProblem | null>(null);

  useEffect(() => {
    setDraft(node.source); // the block changed on disk or was saved
    setProblem(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.source_hash]);

  const dirty = draft !== node.source;
  async function save(run: boolean) {
    if (saving) return;
    if (dirty) {
      setSaving(true);
      try {
        const issue = await onCheck(draft);
        if (issue) {
          setProblem(issue);
          return;
        }
        if (!(await onSave(draft))) return;
      } finally {
        setSaving(false);
      }
    }
    if (run) onRun();
  }

  return (
    <div
      className="inline-editor nodrag nowheel nopan nokey"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      role="dialog"
      aria-label={`Edit ${node.id}`}
    >
      <div className="inline-editor-head">
        <span className="code-node-id">{node.id}</span>
        <span className="cell-label">{node.label}</span>
        {dirty && <span className="unsaved small">unsaved</span>}
        <div className="spacer" />
        <button className="link-button" onClick={onClose} aria-label="Close editor">
          ✕
        </button>
      </div>
      <div className="inline-editor-frame">
        <CodeEditor
          value={draft}
          onChange={(next) => {
            setDraft(next);
            setProblem(null);
          }}
          onSave={() => void save(false)}
          onBlur={() => undefined}
          onCursor={() => undefined}
          errorLine={problem?.line ?? null}
        />
      </div>
      <div className="inline-editor-bar">
        {problem ? (
          <span className="error-text small" role="alert">
            Not saved: syntax error{problem.line ? ` on line ${problem.line}` : ""}: {problem.message}
          </span>
        ) : (
          <span className="dim small">Ctrl/⌘+S saves · Esc closes</span>
        )}
        <div className="spacer" />
        <button disabled={!dirty || saving} onClick={() => setDraft(node.source)}>
          Discard
        </button>
        <button disabled={!dirty || saving} onClick={() => void save(false)}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="primary" disabled={saving || !kernelReady} onClick={() => void save(true)} title={kernelReady ? "Save, then run this block" : "Start a kernel first"}>
          Save & run
        </button>
      </div>
    </div>
  );
}
