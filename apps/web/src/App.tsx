import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppContext, type AppState, type Toast } from "./context";
import { androidBridge, BrowserEngine, chooseEngine, EngineError, type Engine } from "./engine/engine";
import { EngineDialog } from "./components/EngineDialog";
import { Intro } from "./components/Intro";
import { LogoMark } from "./components/TopBar";
import { Icon } from "./components/Icon";
import { Home } from "./pages/Home";
import { ProjectPage, type Tab } from "./pages/ProjectPage";
import { ChartWindow } from "./pages/ChartWindow";
import { GuidePage } from "./pages/GuidePage";
import { Databases } from "./pages/Databases";
import type { Catalogue, EngineEvent, EngineInfo } from "./types";

type Route =
  | { page: "home" }
  | { page: "sql" }
  | { page: "databases" }
  | { page: "guide"; topic: string }
  | { page: "chart"; project: string; chart: string; run?: string; model?: string }
  | { page: "project"; id: string; tab: Tab };

function readRoute(): Route {
  const query = new URLSearchParams(location.search);
  const id = query.get("project");
  if (query.get("page") === "sql") return { page: "sql" };
  if (query.get("page") === "databases") return { page: "databases" };
  if (query.get("page") === "guide") return { page: "guide", topic: query.get("topic") || "getting-started" };
  if (query.get("page") === "chart" && query.get("project") && query.get("chart"))
    return { page: "chart", project: query.get("project")!, chart: query.get("chart")!, run: query.get("run") ?? undefined, model: query.get("model") ?? undefined };
  return id ? { page: "project", id, tab: (query.get("tab") as Tab) || "pipeline" } : { page: "home" };
}

function writeRoute(route: Route, replace = false) {
  const query = new URLSearchParams();
  if (route.page === "sql") query.set("page", "sql");
  if (route.page === "databases") query.set("page", "databases");
  if (route.page === "chart") {
    query.set("page", "chart");
    query.set("project", route.project);
    query.set("chart", route.chart);
    if (route.run) query.set("run", route.run);
    if (route.model) query.set("model", route.model);
  }
  if (route.page === "guide") {
    query.set("page", "guide");
    query.set("topic", route.topic);
  }
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
  // the intro stays long enough for its title to settle, even when the engine is ready at once
  const [introShown, setIntroShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setIntroShown(true), 1300);
    return () => clearTimeout(timer);
  }, []);

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

  const openGuide = useCallback(
    (target: string) => {
      const [topic, anchor] = target.split("#");
      setEngineOpen(false);
      navigate({ page: "guide", topic: topic || "getting-started" });
      if (anchor) setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" }), 450);
    },
    [navigate],
  );

  const state: AppState | null = useMemo(
    () =>
      engine && catalogue && info
        ? { engine, catalogue, info, notify, fail, openEngine: () => setEngineOpen(true), openGuide, refreshInfo }
        : null,
    [engine, catalogue, info, notify, fail, openGuide, refreshInfo],
  );

  return (
    <>
      {state ? (
        <AppContext.Provider value={state}>
          {route.page === "home" ? (
            <Home open={(id) => navigate({ page: "project", id, tab: "data" })} />
          ) : route.page === "chart" ? (
            <ChartWindow projectId={route.project} chartId={route.chart} runId={route.run} modelId={route.model} />
          ) : route.page === "guide" ? (
            <GuidePage
              topic={route.topic}
              goHome={() => navigate({ page: "home" })}
              openTopic={(topic) => navigate({ page: "guide", topic })}
            />
          ) : route.page === "databases" ? (
            <Databases goHome={() => navigate({ page: "home" })} openProjects={() => navigate({ page: "home" })} />
          ) : route.page === "sql" ? (
            <Home open={(id) => navigate({ page: "project", id, tab: "analyze" })} />
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
      <AnimatePresence>
        {(boot || bootError || !introShown) && (
          <Intro
            key="intro"
            message={bootError ? "The engine did not start" : (boot?.message ?? "Ready")}
            progress={boot?.progress}
            note={
              engine?.kind === "browser"
                ? androidBridge()
                  ? "FlowLabs runs Python on this phone. Everything it needs is inside the app, and your data stays on the device."
                  : "FlowLabs runs Python inside this tab. The first visit downloads about 40 MB; later visits load from the cache. Your data stays on this device."
                : undefined
            }
            error={
              bootError ? (
                <div className="splash-error">
                  <p className="error-text">
                    <Icon name="error" /> The engine did not start
                  </p>
                  <p className="dim small">{bootError}</p>
                  <div className="row wrap" style={{ justifyContent: "center" }}>
                    <button onClick={() => engine && void load(engine)}>
                      <Icon name="refresh" /> Try again
                    </button>
                    {engine?.kernel && (
                      <button className="primary" onClick={() => void switchToBuiltIn()}>
                        Use the built-in engine
                      </button>
                    )}
                    {engine?.kind !== "browser" && <button onClick={() => void switchEngine(new BrowserEngine())}>Use this browser instead</button>}
                  </div>
                </div>
              ) : undefined
            }
          />
        )}
      </AnimatePresence>
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
