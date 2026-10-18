import { createContext, useContext } from "react";
import type { Engine } from "./engine/engine";
import type { Catalogue, EngineInfo } from "./types";

export interface Toast {
  id: number;
  level: "info" | "error" | "ok";
  message: string;
}

export interface AppState {
  engine: Engine;
  catalogue: Catalogue;
  info: EngineInfo;
  notify: (message: string, level?: Toast["level"]) => void;
  fail: (error: unknown) => void;
  openEngine: () => void;
  /** Open the guide at a topic, optionally at a section: "sql" or "sql#connect-a-database". */
  openGuide: (topic: string) => void;
  refreshInfo: () => Promise<void>;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp outside the app");
  return value;
}
