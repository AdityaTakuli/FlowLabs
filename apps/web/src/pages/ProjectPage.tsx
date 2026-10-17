import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../context";
import { Icon } from "../components/Icon";
import { TopBar } from "../components/TopBar";
import { CommitInput, Spinner } from "../components/ui";
import { metricValue } from "../format";
import type { Issue, Profile, Project, RunResult, RunSummary } from "../types";
import { DataTab } from "./DataTab";
import { ExportTab } from "./ExportTab";
import { PipelineTab } from "./PipelineTab";
import { PredictTab } from "./PredictTab";
import { ResultsTab } from "./ResultsTab";
import { useTraining } from "./useTraining";

export type Tab = "data" | "pipeline" | "results" | "predict" | "export";

const TABS: { id: Tab; label: string; icon: "database" | "layers" | "trophy" | "target" | "package" }[] = [
  { id: "data", label: "Data", icon: "database" },
  { id: "pipeline", label: "Pipeline", icon: "layers" },
  { id: "results", label: "Results", icon: "trophy" },
  { id: "predict", label: "Predict", icon: "target" },
  { id: "export", label: "Export", icon: "package" },
];

export interface ProjectApi {
  project: Project;
  update: (change: (project: Project) => Project) => void;
  issues: Issue[];
  profile: Profile | null;
  reloadProfile: () => void;
  run: RunResult | null;
  runs: RunSummary[];
  openRun: (runId: string) => Promise<void>;
  setTab: (tab: Tab) => void;
  markExported: () => void;
}

type StepState = "done" | "error" | "todo" | "busy";

function StepDot({ state, index }: { state: StepState; index: number }) {
  if (state === "busy") return <Spinner />;
  return <span className={`step-dot ${state === "done" ? "done" : state === "error" ? "error" : ""}`}>{state === "done" ? <Icon name="check" size={10} /> : state === "error" ? "!" : index + 1}</span>;
}

export function ProjectPage({ projectId, tab, setTab, goHome }: { projectId: string; tab: Tab; setTab: (tab: Tab) => void; goHome: () => void }) {
  const { engine, fail, notify } = useApp();
  const [project, setProject] = useState<Project | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [run, setRun] = useState<RunResult | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exported, setExported] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<Project | null>(null);

  const openRun = useCallback(
    async (runId: string) => {
      try {
        setRun(await engine.call<RunResult>("runs.get", { project_id: projectId, run_id: runId }));
      } catch (error) {
        fail(error);
      }
    },
    [engine, projectId, fail],
  );

  const reloadRuns = useCallback(async () => {
    try {
      setRuns(await engine.call<RunSummary[]>("runs.list", { project_id: projectId }));
    } catch (error) {
      fail(error);
    }
  }, [engine, projectId, fail]);

  const { training, start, stop } = useTraining(
    engine,
    (runId) => {
      void openRun(runId).then(() => setTab("results"));
      void reloadRuns();
      notify("Training finished.", "ok");
    },
    (message) => notify(message, "error"),
  );

  const check = useCallback(
    (next: Project) => {
      if (checkTimer.current) clearTimeout(checkTimer.current);
      checkTimer.current = setTimeout(() => {
        engine.call<Issue[]>("projects.check", { project: next }).then(setIssues).catch(() => undefined);
      }, 350);
    },
    [engine],
  );

  const loadProfile = useCallback(
    (p: Project) => {
      engine.call<Profile>("datasets.profile", { dataset_id: p.dataset_id, target: p.target }).then(setProfile).catch(fail);
    },
    [engine, fail],
  );

  useEffect(() => {
    let cancelled = false;
    engine
      .call<Project>("projects.get", { project_id: projectId })
      .then((p) => {
        if (cancelled) return;
        setProject(p);
        latest.current = p;
        check(p);
        loadProfile(p);
        if (p.last_run) void openRun(p.last_run);
        void reloadRuns();
      })
      .catch(() => setMissing(true));
    return () => {
      cancelled = true;
    };
  }, [engine, projectId, check, loadProfile, openRun, reloadRuns]);

  const update = useCallback(
    (change: (project: Project) => Project) => {
      setProject((current) => {
        if (!current) return current;
        const next = change(current);
        latest.current = next;
        check(next);
        if (saveTimer.current) clearTimeout(saveTimer.current);
        setSaving(true);
        saveTimer.current = setTimeout(() => {
          engine
            .call("projects.save", { project: latest.current })
            .catch(fail)
            .finally(() => setSaving(false));
        }, 600);
        if (next.target !== current.target) loadProfile(next);
        return next;
      });
    },
    [engine, check, fail, loadProfile],
  );

  const api: ProjectApi | null = useMemo(
    () =>
      project
        ? { project, update, issues, profile, reloadProfile: () => loadProfile(project), run, runs, openRun, setTab, markExported: () => setExported(true) }
        : null,
    [project, update, issues, profile, loadProfile, run, runs, openRun, setTab],
  );

  if (missing)
    return (
      <div className="shell">
        <TopBar onHome={goHome} />
        <div className="page">
          <div className="empty">
            This project is not in this engine. Each engine keeps its own projects.
            <div style={{ marginTop: 12 }}>
              <button onClick={goHome}>Back to projects</button>
            </div>
          </div>
        </div>
      </div>
    );
  if (!api || !project)
    return (
      <div className="shell">
        <TopBar onHome={goHome} />
        <div className="page row">
          <Spinner /> Loading the project…
        </div>
      </div>
    );

  const errors = issues.filter((i) => i.level === "error");
  const trainable = project.models.some((m) => m.enabled) && errors.length === 0;
  const enabledModels = project.models.filter((m) => m.enabled).length;
  const states: Record<Tab, StepState> = {
    data: profile ? "done" : "todo",
    pipeline: errors.length ? "error" : "done",
    results: training?.running ? "busy" : run ? "done" : "todo",
    predict: run ? "done" : "todo",
    export: exported ? "done" : "todo",
  };
  const best = run?.models.find((m) => m.id === run.best_model_id);
  const stepCount = project.clean.length + project.rows.length + project.transform.length;
  const notes: Record<Tab, string> = {
    data: profile ? `${profile.rows.toLocaleString()} ${project.kind === "image" ? "images" : "rows"}` : "Loading",
    pipeline: errors.length ? `${errors.length} to fix` : `${stepCount} ${stepCount === 1 ? "step" : "steps"}, ${enabledModels} ${enabledModels === 1 ? "model" : "models"}`,
    results: training?.running ? "Training now" : best ? `Best ${metricValue(run!.metric, best.metrics?.[run!.metric])} ${run!.metric_label}` : "Not trained yet",
    predict: run ? "Try the best model" : "After training",
    export: exported ? "Exported" : run ? "Ready to export" : "After training",
  };
  const trainButton = training?.running ? (
    <button className="danger" onClick={() => void stop()}>
      <Icon name="stop" /> <span className="label">Stop</span>
    </button>
  ) : (
    <button
      className="accent"
      disabled={!trainable}
      title={errors[0]?.message ?? "Train every model in the pipeline"}
      onClick={() => {
        setTab("results");
        void start(latest.current ?? project);
      }}
    >
      <Icon name="play" /> Train{enabledModels > 1 ? ` ${enabledModels}` : ""}
    </button>
  );
  return (
    <div className="shell">
      <TopBar
        onHome={goHome}
        actions={
          <>
            {saving && <span className="faint tiny">Saving</span>}
            {trainButton}
          </>
        }
      >
        <div className="crumb">
          <button className="ghost small crumb-home" onClick={goHome}>
            Projects
          </button>
          <Icon name="chevronRight" size={12} className="crumb-sep" />
          <CommitInput value={project.name} onCommit={(name) => update((p) => ({ ...p, name: name || p.name }))} aria-label="Project name" />
        </div>
      </TopBar>
      <div className="workspace">
        <nav className="rail" aria-label="Steps">
          {TABS.map((t, i) => (
            <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)} aria-current={tab === t.id ? "page" : undefined} title={t.label}>
              <StepDot state={states[t.id]} index={i} />
              <span className="rail-text">
                <span className="rail-label">{t.label}</span>
                <span className={`rail-note ${states[t.id] === "error" ? "error-text" : ""}`}>{notes[t.id]}</span>
              </span>
            </button>
          ))}
        </nav>
        <div className="content" style={tab === "pipeline" ? { overflow: "hidden" } : undefined}>
          {tab === "data" && <DataTab api={api} />}
          {tab === "pipeline" && <PipelineTab api={api} training={training} />}
          {tab === "results" && <ResultsTab api={api} training={training} onTrain={() => void start(latest.current ?? project)} trainable={trainable} />}
          {tab === "predict" && <PredictTab api={api} />}
          {tab === "export" && <ExportTab api={api} />}
        </div>
      </div>
      <nav className="bottom-nav" aria-label="Steps">
        {TABS.map((t, i) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {states[t.id] === "todo" ? <Icon name={t.icon} size={20} /> : <StepDot state={states[t.id]} index={i} />}
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
