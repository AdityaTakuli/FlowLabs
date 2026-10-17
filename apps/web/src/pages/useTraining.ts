import { useCallback, useEffect, useRef, useState } from "react";
import type { Engine } from "../engine/engine";
import { uid } from "../format";
import type { EpochPoint, JobEvent, Project } from "../types";

export interface LiveModel {
  id: string;
  label: string;
  status: string;
  metrics?: Record<string, number>;
  error?: string;
  epochs: EpochPoint[];
  totalEpochs?: number;
  progress?: number;
  trial?: { trial: number; of: number; score?: number };
}

export interface Training {
  jobId: string;
  running: boolean;
  stage: string;
  models: LiveModel[];
  log: string[];
  startedAt: number;
  runId?: string;
  error?: string;
  cancelled?: boolean;
}

/** Start a training job and follow its events. */
export function useTraining(engine: Engine, onDone: (runId: string) => void, onError: (message: string) => void) {
  const [training, setTraining] = useState<Training | null>(null);
  const job = useRef<string | null>(null);
  const callbacks = useRef({ onDone, onError });
  callbacks.current = { onDone, onError };

  useEffect(
    () =>
      engine.subscribe((event) => {
        if (event.type === "log" && job.current) {
          setTraining((t) => (t ? { ...t, log: [...t.log.slice(-300), event.text] } : t));
          return;
        }
        if (event.type !== "job" || event.job_id !== job.current) return;
        const e = event as JobEvent;
        setTraining((t) => {
          if (!t) return t;
          const next: Training = { ...t, models: t.models.map((m) => ({ ...m })) };
          const model = e.model_id ? next.models.find((m) => m.id === e.model_id) : undefined;
          switch (e.kind) {
            case "started":
              next.models = (e.models ?? []).map((m) => ({ id: m.id, label: m.label, status: "waiting", epochs: [] }));
              next.runId = e.run_id;
              break;
            case "stage":
              next.stage = e.message ?? e.stage ?? "";
              break;
            case "model":
              if (model) {
                model.status = e.status ?? model.status;
                if (e.metrics) model.metrics = e.metrics;
                if (e.error) model.error = e.error;
              }
              if (e.status === "running") next.stage = `Training ${e.label} (${(e.index ?? 0) + 1} of ${e.total})`;
              if (e.status === "explaining") next.stage = `Measuring which inputs matter for ${e.label}`;
              break;
            case "epoch":
              if (model && e.metrics) {
                model.epochs = [...model.epochs, { epoch: e.epoch ?? model.epochs.length + 1, ...e.metrics }];
                model.totalEpochs = e.epochs;
                model.progress = (e.epoch ?? 0) / (e.epochs ?? 1);
              }
              break;
            case "progress":
              if (model) model.progress = e.fraction;
              break;
            case "trial":
              if (model) model.trial = { trial: e.trial ?? 0, of: e.of ?? 0, score: e.score };
              next.stage = `Tuning: trial ${e.trial} of ${e.of}`;
              break;
            case "log":
              next.log = [...next.log.slice(-300), e.message ?? ""];
              break;
            case "done":
              next.running = false;
              next.stage = "Finished";
              next.runId = e.run_id;
              break;
            case "error":
              next.running = false;
              next.error = e.message;
              next.stage = "Failed";
              break;
            case "cancelled":
              next.running = false;
              next.cancelled = true;
              next.stage = "Stopped";
              break;
          }
          return next;
        });
        if (e.kind === "done" && e.run_id) {
          job.current = null;
          callbacks.current.onDone(e.run_id);
        }
        if (e.kind === "error") {
          job.current = null;
          callbacks.current.onError(e.message ?? "training failed");
        }
        if (e.kind === "cancelled") job.current = null;
      }),
    [engine],
  );

  const start = useCallback(
    async (project: Project) => {
      const jobId = uid("job");
      job.current = jobId;
      setTraining({
        jobId,
        running: true,
        stage: "Starting",
        log: [],
        startedAt: Date.now(),
        models: project.models.filter((m) => m.enabled).map((m) => ({ id: m.id, label: m.label, status: "waiting", epochs: [] })),
      });
      try {
        await engine.call("train.start", { project, job_id: jobId });
      } catch (error) {
        if ((error as Error).message === "stopped") return;
        job.current = null;
        setTraining((t) => (t ? { ...t, running: false, error: (error as Error).message, stage: "Failed" } : t));
        callbacks.current.onError((error as Error).message);
      }
    },
    [engine],
  );

  const stop = useCallback(async () => {
    if (!training?.jobId) return;
    setTraining((t) => (t ? { ...t, stage: "Stopping after the current step…" } : t));
    await engine.cancel(training.jobId);
  }, [engine, training?.jobId]);

  return { training, start, stop, clear: () => setTraining(null) };
}
