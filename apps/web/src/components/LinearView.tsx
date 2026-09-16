import { useState } from "react";
import type { Api } from "../api";
import { OutputList } from "./RichOutput";
import { formatCount, formatDuration } from "../layout";
import type { CodeGraph, RunMode, SessionState } from "../types";
import { STATE_LABEL } from "./GraphCanvas";
import { Icon } from "./Icon";

interface LinearViewProps {
  api: Api;
  file: string;
  graph: CodeGraph;
  session: SessionState | null;
  selectedId: string | null;
  kernelReady: boolean;
  onSelect: (nodeId: string) => void;
  onRun: (nodeId: string, mode: RunMode) => void;
  onReorder: (moving: string, anchor: string, before: boolean) => void;
}

/** The classic notebook: cells in source order. Drag a cell to move it (unsafe moves are refused). */
export function LinearView({ api, file, graph, session, selectedId, kernelReady, onSelect, onRun, onReorder }: LinearViewProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; before: boolean } | null>(null);
  const cells = graph.nodes.filter((n) => n.kind !== "undefined");

  return (
    <div className="linear-view" role="list">
      {cells.map((node) => {
        const entry = session?.nodes[node.id];
        const state = entry?.state ?? "idle";
        const record = entry?.last_run;
        const indicator = drop?.id === node.id ? (drop.before ? "drop-before" : "drop-after") : "";
        return (
          <div
            key={node.id}
            role="listitem"
            className={`cell state-${state} ${node.id === selectedId ? "selected" : ""} ${indicator} ${dragging === node.id ? "dragging" : ""}`}
            onClick={() => onSelect(node.id)}
            onDragOver={(e) => {
              if (!dragging || dragging === node.id) return;
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              setDrop({ id: node.id, before: e.clientY < rect.top + rect.height / 2 });
            }}
            onDragLeave={() => setDrop((d) => (d?.id === node.id ? null : d))}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging && drop && dragging !== drop.id) onReorder(dragging, drop.id, drop.before);
              setDragging(null);
              setDrop(null);
            }}
          >
            <div className="cell-head">
              <span
                className="drag-handle"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", node.id);
                  setDragging(node.id);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setDrop(null);
                }}
                title="Drag to move this block"
                aria-label={`Move ${node.id}`}
              >
                ⋮⋮
              </span>
              <span className="code-node-id">{node.id}</span>
              <span className="cell-label">{node.label}</span>
              <span className={`state-pill state-${state}`}>
                <span aria-hidden>{STATE_LABEL[state].icon}</span> {STATE_LABEL[state].text}
              </span>
              <div className="spacer" />
              {record && (
                <span className="dim small">
                  {record.rows_out !== null ? `${formatCount(record.rows_out)} rows · ` : ""}
                  {formatDuration(record.duration_ms)}
                </span>
              )}
              <button disabled={!kernelReady} onClick={(e) => (e.stopPropagation(), onRun(node.id, "node"))} title="Run this block">
                <Icon name="play" size={12} />
              </button>
              <button disabled={!kernelReady} onClick={(e) => (e.stopPropagation(), onRun(node.id, "to"))} title="Run to here">
                <Icon name="runTo" size={12} />
              </button>
            </div>
            <pre className="cell-code">{node.source}</pre>
            {record?.error && (
              <div className="cell-error">
                {record.error.ename}: {record.error.evalue}
              </div>
            )}
            {record?.stdout && <pre className="cell-output">{record.stdout.slice(-2000)}</pre>}
            {record && (record.rich_outputs?.length ?? 0) > 0 && (
              <div className="cell-rich" onClick={(e) => e.stopPropagation()}>
                <OutputList api={api} file={file} record={record} compact />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
