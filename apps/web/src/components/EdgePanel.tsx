import { useEffect, useState } from "react";
import { ApiError, type Api } from "../api";
import type { InspectPayload } from "../types";
import type { EdgeTarget } from "./GraphCanvas";
import { VariableCard } from "./Inspector";

/** What travels along an edge: the variables the upstream block produced, as captured at its last run. */
export function EdgePanel({
  api,
  file,
  edge,
  executionId,
  stale,
  onClose,
  onSelect,
}: {
  api: Api;
  file: string;
  edge: EdgeTarget;
  executionId: string | null;
  stale: boolean;
  onClose: () => void;
  onSelect: (nodeId: string) => void;
}) {
  const [data, setData] = useState<InspectPayload | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    api
      .inspect(file, edge.from)
      .then((result) => live && setData(result))
      .catch((e: unknown) => live && setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e))));
    return () => {
      live = false;
    };
  }, [api, file, edge.from, executionId]);

  return (
    <section className="edge-panel" role="dialog" aria-label={`Data from ${edge.from} to ${edge.to}`}>
      <header className="edge-panel-head">
        <span className="small dim">Data on edge</span>
        <button className="chip link" onClick={() => onSelect(edge.from)}>
          {edge.from}
        </button>
        <span aria-hidden>→</span>
        <button className="chip link" onClick={() => onSelect(edge.to)}>
          {edge.to}
        </button>
        <span className="mono small edge-panel-vars">{edge.variables.join(", ")}</span>
        <div className="spacer" />
        {data && <span className="dim small">captured {new Date(data.started_at).toLocaleTimeString()}</span>}
        <button className="link-button" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="edge-panel-body">
        {stale && data && <div className="banner-inline">{edge.from} changed since this value was captured. Run it again to refresh.</div>}
        {error?.code === "NO_SNAPSHOT" && (
          <div className="dim">
            Run <strong>{edge.from}</strong> to see what flows along this edge.
          </div>
        )}
        {error && error.code !== "NO_SNAPSHOT" && <div className="error-text">{error.message}</div>}
        {!data && !error && <div className="dim">Loading…</div>}
        {data &&
          edge.variables.map((name) => {
            const summary = data.after[name];
            return summary ? (
              <VariableCard key={name} summary={summary} open />
            ) : (
              <div key={name} className="dim small">
                <code>{name}</code> was not captured after {edge.from} ran (for example it is only defined in some branches).
              </div>
            );
          })}
      </div>
    </section>
  );
}
