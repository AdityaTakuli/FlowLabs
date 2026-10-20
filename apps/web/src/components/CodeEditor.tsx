// The code editor (CodeMirror 6) for Python code steps and SQL queries, themed with the app's colour tokens.
import { closeCompletion } from "@codemirror/autocomplete";
import { python } from "@codemirror/lang-python";
import { MySQL, PostgreSQL, sql, SQLite, StandardSQL } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { tags as t } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], color: "var(--code-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--code-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--code-number)" },
  { tag: [t.comment, t.lineComment, t.docString], color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: "var(--code-function)" },
  { tag: [t.className, t.definition(t.className), t.typeName], color: "var(--code-class)" },
  { tag: [t.self, t.special(t.variableName)], color: "var(--code-keyword)" },
]);

const theme = EditorView.theme({
  "&": { fontSize: "12.5px", background: "var(--code-bg)", color: "var(--text)", borderRadius: "var(--r-sm)", border: "1px solid var(--rule)" },
  "&.cm-focused": { outline: "none", borderColor: "var(--focus)", boxShadow: "0 0 0 3px var(--focus-soft)" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
  ".cm-content": { padding: "10px 0", caretColor: "var(--text)" },
  ".cm-gutters": { background: "var(--code-bg)", color: "var(--text-faint)", border: "none", borderRight: "1px solid var(--rule)" },
  ".cm-activeLine": { background: "var(--code-active)" },
  ".cm-activeLineGutter": { background: "var(--code-active)", color: "var(--text-dim)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { background: "var(--focus-soft) !important" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
  ".cm-matchingBracket": { background: "var(--focus-soft)", outline: "none" },
  ".cm-tooltip": { background: "var(--sheet)", border: "1px solid var(--rule-strong)", color: "var(--text)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--focus)", color: "var(--on-ink)" },
  ".cm-panels": { background: "var(--sheet)", color: "var(--text)" },
  ".cm-line.cm-error-line": { background: "var(--red-soft)" },
});

/** Highlights one line (the line an error points at). */
function errorLine(view: EditorView, line: number | null) {
  view.dom.querySelectorAll(".cm-error-line").forEach((el) => el.classList.remove("cm-error-line"));
  if (!line || line > view.state.doc.lines) return;
  const { from } = view.state.doc.line(line);
  const dom = view.domAtPos(from).node;
  const element = dom instanceof HTMLElement ? dom : dom.parentElement;
  element?.closest(".cm-line")?.classList.add("cm-error-line");
}

export type SqlDialect = "postgresql" | "mysql" | "sqlite" | "standard";
const DIALECTS = { postgresql: PostgreSQL, mysql: MySQL, sqlite: SQLite, standard: StandardSQL };

function languageOf(language: "python" | "sql", dialect: SqlDialect, schema?: Record<string, string[]>): Extension {
  return language === "sql" ? sql({ dialect: DIALECTS[dialect], schema, upperCaseKeywords: false }) : python();
}

export function CodeEditor({ value, onChange, readOnly = false, minLines = 8, errorAt = null, label, language = "python", dialect = "postgresql", schema, onRun, insert, onPlace }: {
  value: string;
  onChange?: (code: string) => void;
  readOnly?: boolean;
  minLines?: number;
  errorAt?: number | null;
  label: string;
  language?: "python" | "sql";
  dialect?: SqlDialect;
  /** SQL: table name -> column names, for completion. */
  schema?: Record<string, string[]>;
  /** Ctrl+Enter (Cmd+Enter on a Mac) with the editor's text, the selection and where the cursor is;
      Shift+Ctrl+Enter sets ``all`` (run the whole script). */
  onRun?: (code: string, place: { from: number; to: number; head: number }, all: boolean) => void;
  /** Text to put at the cursor; a new `n` inserts it again. */
  insert?: { text: string; n: number };
  /** The selection and cursor whenever they move, for Run buttons outside the editor. */
  onPlace?: (place: { from: number; to: number; head: number }) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  const run = useRef(onRun);
  run.current = onRun;
  const placed = useRef(onPlace);
  placed.current = onPlace;
  const lang = useRef(new Compartment());

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          Prec.highest(
            keymap.of([
              {
                key: "Mod-Enter",
                run: (target) => {
                  if (!run.current) return false;
                  closeCompletion(target);
                  const { from, to, head } = target.state.selection.main;
                  run.current(target.state.doc.toString(), { from, to, head }, false);
                  return true;
                },
              },
              {
                key: "Shift-Mod-Enter",
                run: (target) => {
                  if (!run.current) return false;
                  closeCompletion(target);
                  const { from, to, head } = target.state.selection.main;
                  run.current(target.state.doc.toString(), { from, to, head }, true);
                  return true;
                },
              },
            ]),
          ),
          basicSetup,
          lang.current.of(languageOf(language, dialect, schema)),
          keymap.of([indentWithTab]),
          syntaxHighlighting(highlight),
          theme,
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.theme({ ".cm-content, .cm-gutter": { minHeight: `${minLines * 1.6 * 12.5 + 20}px` } }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changed.current?.(update.state.doc.toString());
            if (update.selectionSet || update.docChanged) {
              const { from, to, head } = update.state.selection.main;
              placed.current?.({ from, to, head });
            }
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // the editor is created once; value changes from outside are applied below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    if (view.current) requestAnimationFrame(() => view.current && errorLine(view.current, errorAt));
  }, [errorAt, value]);

  useEffect(() => {
    view.current?.dispatch({ effects: lang.current.reconfigure(languageOf(language, dialect, schema)) });
  }, [language, dialect, schema]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !insert) return;
    editor.dispatch(editor.state.replaceSelection(insert.text));
    editor.focus();
  }, [insert]);

  return <div className="code-editor" ref={host} />;
}

export default CodeEditor;
