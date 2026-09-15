// Bundle Monaco locally instead of loading it from a CDN: the canvas must work offline and
// must not leak which files you open to a third party.
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { loader } from "@monaco-editor/react";

(self as unknown as { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

loader.config({ monaco });
