import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppContext, type AppState, type Toast } from "./context";
import { androidBridge, BrowserEngine, chooseEngine, EngineError, type Engine } from "./engine/engine";
import { EngineDialog } from "./components/EngineDialog";
import { LogoMark } from "./components/TopBar";
import { Icon } from "./components/Icon";
import { Bar } from "./components/ui";
import { Home } from "./pages/Home";
import { ProjectPage, type Tab } from "./pages/ProjectPage";
import { SqlPage } from "./pages/SqlPage";
import type { Catalogue, EngineEvent, EngineInfo } from "./types";

type Route = { page: "home" } | { page: "sql" } | { page: "project"; id: string; tab: Tab };

function readRoute(): Route {
  const query = new URLSearchParams(location.search);
  const id = query.get("project");
  if (query.get("page") === "sql") return { page: "sql" };
  return id ? { page: "project", id, tab: (query.get("tab") as Tab) || "pipeline" } : { page: "home" };
}

function writeRoute(route: Route, replace = false) {
  const query = new URLSearchParams();
  if (route.page === "sql") query.set("page", "sql");
  if (route.page === "project") {
    query.set("project", route.id);
    query.set("tab", route.tab);
  }
  const url = `${location.pathname}${query.size ? `?${query}` : ""}`;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
}

export function App() {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [boot, setBoot] = useState<{ message: string; progress?: number } | null>({ message: "Starting…" });
  const [bootError, setBootError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [route, setRoute] = useState<Route>(readRoute);
  const [engineOpen, setEngineOpen] = useState(false);
  const toastId = useRef(0);

  const notify = useCallback((message: string, level: Toast["level"] = "info") => {
    const id = ++toastId.current;
    setToasts((list) => [...list.slice(-3), { id, level, message }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), level === "error" ? 9000 : 4500);
  }, []);
  const fail = useCallback(
    (error: unknown) => {
      const message = error instanceof EngineError || error instanceof Error ? error.message : String(error);
      if (message !== "stopped") notify(message, "error");
    },
    [notify],
  );

  const load = useCallback(async (next: Engine) => {
    setBootError(null);
    setBoot({ message: next.kind === "browser" ? "Starting Python in your browser…" : "Connecting to the engine…" });
    try {
      const [loadedInfo, loadedCatalogue] = await Promise.all([
        next.call<EngineInfo>("engine.info", { probe_gpu: next.kind !== "browser" }),
        next.call<Catalogue>("catalogue.get"),
      ]);
      setInfo(loadedInfo);
      setCatalogue(loadedCatalogue);
      setBoot(null);
      const state = await next.kernel?.state().catch(() => null);
      if (state?.notice) notify(state.notice, "error");
    } catch (error) {
      setBootError((error as Error).message);
    }
  }, [notify]);

  const switchToBuiltIn = useCallback(async () => {
    if (!engine?.kernel) return;
    setBootError(null);
    setBoot({ message: "Starting the built-in engine…" });
    try {
      await engine.kernel.select(null);
    } catch (error) {
      setBootError((error as Error).message);
      return;
    }
    await load(engine);
  }, [engine, load]);

  const switchEngine = useCallback(
    async (next: Engine) => {
      setEngine((previous) => {
        if (previous && previous !== next) previous.close();
        return next;
      });
      setCatalogue(null);
      await load(next);
    },
    [load],
  );

  useEffect(() => {
    let cancelled = false;
    chooseEngine().then(({ engine: chosen, notice }) => {
      if (cancelled) return;
      if (notice) notify(notice, "error");
      void switchEngine(chosen);
    });
    const onPop = () => setRoute(readRoute());
    window.addEventListener("popstate", onPop);
    return () => {
      cancelled = true;
      window.removeEventListener("popstate", onPop);
    };
  }, [notify, switchEngine]);

  useEffect(() => {
    if (!engine) return;
    return engine.subscribe((event: EngineEvent) => {
      if (event.type === "boot" && event.stage !== "ready") setBoot((b) => (b ? { message: event.message, progress: event.progress } : b));
      if (event.type === "kernel" && event.status === "dead") notify(`The engine stopped: ${event.message ?? ""}`, "error");
      if (event.type === "kernel" && event.status === "ready" && event.info) setInfo((old) => ({ ...(old ?? ({} as EngineInfo)), ...event.info! }));
      if (event.type === "connection") notify(event.status === "offline" ? "Lost the connection to the engine. Retrying…" : "Reconnected to the engine.", event.status === "offline" ? "error" : "ok");
    });
  }, [engine, notify]);

  const navigate = useCallback((next: Route, replace = false) => {
    writeRoute(next, replace);
    setRoute(next);
  }, []);

  const refreshInfo = useCallback(async () => {
    if (!engine) return;
    const [nextInfo, nextCatalogue] = await Promise.all([
      engine.call<EngineInfo>("engine.info", { probe_gpu: engine.kind !== "browser" }),
      engine.call<Catalogue>("catalogue.get"),
    ]);
    setInfo(nextInfo);
    setCatalogue(nextCatalogue);
  }, [engine]);

  const state: AppState | null = useMemo(
    () => (engine && catalogue && info ? { engine, catalogue, info, notify, fail, openEngine: () => setEngineOpen(true), refreshInfo } : null),
    [engine, catalogue, info, notify, fail, refreshInfo],
  );

  return (
    <>
      {state ? (
        <AppContext.Provider value={state}>
          {route.page === "home" ? (
            <Home open={(id) => navigate({ page: "project", id, tab: "data" })} openSql={() => navigate({ page: "sql" })} />
          ) : route.page === "sql" ? (
            <SqlPage goHome={() => navigate({ page: "home" })} openProject={(id) => navigate({ page: "project", id, tab: "data" })} />
          ) : (
            <ProjectPage
              key={route.id}
              projectId={route.id}
              tab={route.tab}
              setTab={(tab) => navigate({ page: "project", id: route.id, tab }, true)}
              goHome={() => navigate({ page: "home" })}
            />
          )}
          {engineOpen && <EngineDialog onClose={() => setEngineOpen(false)} onSwitch={(next) => void switchEngine(next).then(() => navigate({ page: "home" }))} />}
        </AppContext.Provider>
      ) : (
        <div className="shell">
          <div className="topbar">
            <span className="brand">
              <LogoMark /> <span className="brand-name">FlowLabs</span>
            </span>
          </div>
          <div />
        </div>
      )}
      {(boot || bootError) && (
        <div className="boot">
          <div className="boot-card">
            {bootError ? (
              <>
                <Icon name="error" size={28} className="error-text" />
                <h2>The engine did not start</h2>
                <p className="dim">{bootError}</p>
                <div className="row">
                  <button onClick={() => engine && void load(engine)}>
                    <Icon name="refresh" /> Try again
                  </button>
                  {engine?.kernel && <button className="primary" onClick={() => void switchToBuiltIn()}>Use the built-in engine</button>}
                  {engine?.kind !== "browser" && <button onClick={() => void switchEngine(new BrowserEngine())}>Use this browser instead</button>}
                </div>
              </>
            ) : (
              <>
                <LogoMark size={44} />
                <h2>{boot?.message}</h2>
                {boot?.progress !== undefined && (
                  <div style={{ width: "100%" }}>
                    <Bar value={boot.progress} />
                  </div>
                )}
                {engine?.kind === "browser" && (
                  <p className="dim small">
                    {androidBridge()
                      ? "FlowLabs runs Python on this phone. Everything it needs is inside the app, and your data stays on the device."
                      : "FlowLabs runs Python inside this tab. The first visit downloads about 40 MB; later visits load from the cache. Your data stays on this device."}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}
      <div className="toasts" aria-live="polite">
        <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout
            className={`toast ${toast.level}`}
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.18 } }}
            transition={{ type: "spring", stiffness: 420, damping: 30 }}
          >
            <Icon name={toast.level === "error" ? "error" : toast.level === "ok" ? "check" : "info"} className={toast.level === "error" ? "error-text" : toast.level === "ok" ? "ok-text" : "accent-text"} />
            <span style={{ flex: 1 }}>{toast.message}</span>
            <button className="ghost icon-only" onClick={() => setToasts((list) => list.filter((t) => t.id !== toast.id))} aria-label="Dismiss">
              <Icon name="close" size={12} />
            </button>
          </motion.div>
        ))}
        </AnimatePresence>
      </div>
    </>
  );
}
