import { useCallback, useEffect, useRef, useState } from "react";
import type { NodeChange } from "@xyflow/react";
import type { Api } from "../api";

export type Positions = Record<string, { x: number; y: number }>;

/**
 * Node positions the user dragged, per file and view, stored in the project's .flowlab/layouts.
 * Nodes the user never moved keep their automatic layout; "reset" forgets every moved node.
 */
export function useSavedLayout(api: Api, file: string | null, view: string) {
  const [moved, setMoved] = useState<Positions>({});
  const movedRef = useRef<Positions>({});
  movedRef.current = moved;
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setMoved({});
    if (!file) return;
    let cancelled = false;
    api
      .layout(file, view)
      .then((payload) => {
        if (!cancelled) setMoved(payload.positions ?? {});
      })
      .catch(() => undefined); // an unsaved layout is only a convenience
    return () => {
      cancelled = true;
    };
  }, [api, file, view]);

  const persist = useCallback(
    (positions: Positions) => {
      if (!file) return;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        api.saveLayout(file, view, positions).catch(() => undefined);
      }, 250);
    },
    [api, file, view],
  );

  /** Feed React Flow's position changes here (controlled nodes need it to be draggable). */
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      let next: Positions | null = null;
      let finished = false;
      for (const change of changes) {
        if (change.type !== "position") continue;
        if (change.position) {
          next = next ?? { ...movedRef.current };
          next[change.id] = { x: Math.round(change.position.x), y: Math.round(change.position.y) };
        }
        if (change.dragging === false) finished = true;
      }
      if (next) setMoved(next);
      if (finished) persist(next ?? movedRef.current);
    },
    [persist],
  );

  const reset = useCallback(() => {
    setMoved({});
    persist({});
  }, [persist]);

  return { moved, onNodesChange, reset, hasMoved: Object.keys(moved).length > 0 };
}

/** Automatic positions overridden by the ones the user dragged. */
export function withMoved(auto: Positions, moved: Positions): Positions {
  const merged: Positions = { ...auto };
  for (const [id, point] of Object.entries(moved)) if (id in merged) merged[id] = point;
  return merged;
}
