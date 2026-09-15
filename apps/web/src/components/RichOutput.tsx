import { useEffect, useRef, useState } from "react";
import { ApiError, type Api } from "../api";
import { VegaChart } from "../flow/OutputView";
import { formatBytes } from "../layout";
import type { ExecutionRecord, RichOutput } from "../types";

/**
 * Rich block outputs. Output HTML is arbitrary user code, so it only ever runs inside an iframe
 * sandboxed *without* allow-same-origin: it gets an opaque origin and cannot read the canvas token
 * or call the local API. Images and SVG render through <img>, which never executes scripts.
 */
export function OutputList({ api, file, record, compact = false }: { api: Api; file: string; record: ExecutionRecord; compact?: boolean }) {
  const outputs = record.rich_outputs ?? [];
  if (!outputs.length) return null;
  return (
    <div className={`rich-outputs ${compact ? "compact" : ""}`}>
      {outputs.map((output) => (
        <OutputItem key={`${record.execution_id}:${output.index}`} api={api} file={file} executionId={record.execution_id} output={output} compact={compact} />
      ))}
    </div>
  );
}

type Loaded = { kind: "url"; url: string } | { kind: "text"; text: string };

function OutputItem({ api, file, executionId, output, compact }: { api: Api; file: string; executionId: string; output: RichOutput; compact: boolean }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const binary = output.kind === "image" || output.kind === "svg";

  useEffect(() => {
    if (!output.stored) return;
    let live = true;
    let url: string | null = null;
    setLoaded(null);
    setError(null);
    api
      .outputBlob(file, executionId, output.index)
      .then(async (blob) => {
        if (!live) return;
        if (binary) {
          url = URL.createObjectURL(blob);
          setLoaded({ kind: "url", url });
        } else {
          setLoaded({ kind: "text", text: await blob.text() });
        }
      })
      .catch((err: unknown) => live && setError(err instanceof ApiError ? err.message : String(err)));
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, file, executionId, output.index, output.stored, binary]);

  if (output.kind === "text") return <pre className="stream result">{output.plain}</pre>;
  if (!output.stored) {
    return (
      <div className="rich-missing dim small">
        {output.truncated ? `${output.mime} output too large to keep (${formatBytes(output.size_bytes)}).` : `${output.mime} output could not be decoded.`}
        {output.plain && <pre className="stream">{output.plain}</pre>}
      </div>
    );
  }
  if (error) return <div className="rich-missing dim small">{error}</div>;
  if (!loaded) return <div className="rich-loading dim small">Loading {output.kind}…</div>;

  if (loaded.kind === "url") {
    return (
      <figure className="rich-figure">
        <img
          className="rich-image"
          src={loaded.url}
          alt={output.plain && !output.plain.startsWith("<Figure") ? output.plain : `${output.kind} output ${output.index + 1}`}
          style={output.width ? { width: Math.min(output.width, compact ? 480 : 2000) } : undefined}
        />
      </figure>
    );
  }
  switch (output.kind) {
    case "html":
      return <SandboxedHtml html={loaded.text} maxHeight={compact ? 360 : 900} />;
    case "vega":
      try {
        return <VegaChart spec={JSON.parse(loaded.text) as Record<string, unknown>} />;
      } catch {
        return <pre className="stream">{loaded.text.slice(0, 4000)}</pre>;
      }
    case "json":
      return <pre className="stream json-output">{prettyJson(loaded.text)}</pre>;
    default:
      return <pre className="stream">{loaded.text.slice(0, 20000)}</pre>;
  }
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2).slice(0, 20000);
  } catch {
    return text.slice(0, 20000);
  }
}

const FRAME_STYLE = `<style>
  html,body{margin:0;background:#0d1117;color:#e6edf3;font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
  body{padding:8px}
  table{border-collapse:collapse;font-size:12px}
  th,td{border:1px solid #2d3540;padding:3px 8px;text-align:right}
  th{background:#1c232d}
  a{color:#58a6ff}
</style>`;

const FRAME_SCRIPT = `<script>
  (function(){
    function post(){ parent.postMessage({ flowlabFrameHeight: document.documentElement.scrollHeight }, "*"); }
    if (window.ResizeObserver) new ResizeObserver(post).observe(document.documentElement);
    window.addEventListener("load", post);
    post();
  })();
</script>`;

export function SandboxedHtml({ html, maxHeight }: { html: string; maxHeight: number }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(60);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const reported = (event.data as { flowlabFrameHeight?: unknown } | null)?.flowlabFrameHeight;
      if (typeof reported === "number" && Number.isFinite(reported)) setHeight(Math.max(40, Math.min(reported + 4, maxHeight)));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [maxHeight]);
  return (
    <iframe
      ref={frame}
      className="rich-frame"
      title="HTML output"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={`<!doctype html><html><head><meta charset="utf-8">${FRAME_STYLE}</head><body>${html}${FRAME_SCRIPT}</body></html>`}
      style={{ height }}
    />
  );
}
