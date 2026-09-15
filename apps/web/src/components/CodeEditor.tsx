import { useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onBlur: () => void;
  onCursor: (line: number) => void;
  errorLine: number | null;
}

export function CodeEditor({ value, onChange, onSave, onBlur, onCursor, errorLine }: CodeEditorProps) {
  const handlers = useRef({ onSave, onBlur, onCursor });
  handlers.current = { onSave, onBlur, onCursor };
  const decorations = useRef<{ clear: () => void; set: (d: unknown[]) => void } | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);

  const mount: OnMount = (editor, monaco) => {
    monacoRef.current = monaco;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => handlers.current.onSave());
    editor.onDidBlurEditorText(() => handlers.current.onBlur());
    editor.onDidChangeCursorPosition((event) => handlers.current.onCursor(event.position.lineNumber));
    const collection = editor.createDecorationsCollection();
    decorations.current = { clear: () => collection.clear(), set: (d) => collection.set(d as never) };
  };

  if (decorations.current && monacoRef.current) {
    if (errorLine) {
      decorations.current.set([
        {
          range: new monacoRef.current.Range(errorLine, 1, errorLine, 1),
          options: { isWholeLine: true, className: "editor-error-line", glyphMarginClassName: "editor-error-glyph" },
        },
      ]);
    } else {
      decorations.current.clear();
    }
  }

  return (
    <Editor
      height="100%"
      language="python"
      theme="vs-dark"
      value={value}
      onChange={(next) => onChange(next ?? "")}
      onMount={mount}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbersMinChars: 3,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 4,
        wordWrap: "on",
        renderLineHighlight: "line",
        glyphMargin: true,
      }}
    />
  );
}
