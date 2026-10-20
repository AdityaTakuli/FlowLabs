// Updates for the desktop app: a pill in the top bar when a new version is out, and a sheet that
// installs it and restarts FlowLabs.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { useApp } from "../context";
import type { Engine } from "../engine/engine";
import type { EngineEvent, UpdateInfo } from "../types";
import { Markdown } from "./Markdown";
import { Icon } from "./Icon";
import { Bar, Modal, Notice, Spinner, Switch } from "./ui";

// one check per app session, shared by every page's top bar
let checking: Promise<UpdateInfo> | null = null;
let checkedEngine: Engine | null = null;

function check(engine: Engine, force = false): Promise<UpdateInfo> | null {
  if (!engine.updates) return null;
  if (force || !checking || checkedEngine !== engine) {
    checkedEngine = engine;
    checking = engine.updates.check(force);
    checking.catch(() => (checking = null));
  }
  return checking;
}

type Progress = { stage: string; progress?: number | null; message?: string } | null;

// the update's progress, shared by the top bar's button and the update window, so it keeps showing
// after the window is closed and on every page
let lastProgress: Progress = null;
const watchers = new Set<(next: Progress) => void>();

function shareProgress(next: Progress) {
  lastProgress = next;
  watchers.forEach((watch) => watch(next));
}

function useUpdateProgress(): [Progress, (next: Progress) => void] {
  const { engine } = useApp();
  const [progress, setProgress] = useState<Progress>(lastProgress);
  useEffect(() => {
    watchers.add(setProgress);
    const stop = engine.subscribe((event: EngineEvent) => {
      if (event.type === "update") shareProgress({ stage: event.stage, progress: event.progress, message: event.message });
    });
    return () => {
      watchers.delete(setProgress);
      stop();
    };
  }, [engine]);
  return [progress, shareProgress];
}

function percent(progress: Progress): number | null {
  return progress?.stage === "download" && typeof progress.progress === "number" ? Math.round(progress.progress * 100) : null;
}

export function UpdateButton() {
  const { engine } = useApp();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [progress] = useUpdateProgress();
  useEffect(() => {
    let live = true;
    check(engine)?.then((next) => live && setInfo(next), () => undefined);
    return () => {
      live = false;
    };
  }, [engine]);
  const working = progress !== null && progress.stage !== "error";
  const share = percent(progress);
  return (
    <>
      <AnimatePresence>
        {info?.available && (
          <motion.button
            className={`update-pill ${working ? "working" : ""}`}
            onClick={() => setOpen(true)}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            title={working ? progress?.message ?? "Updating" : `FlowLabs ${info.latest} is available`}
            aria-label={working ? `Updating to ${info.latest}${share !== null ? `, ${share}%` : ""}` : `Update to ${info.latest}`}
          >
            {working && <span className="update-pill-fill" style={{ width: `${share ?? 100}%` }} aria-hidden />}
            {working ? <Spinner /> : <Icon name="download" size={13} />}
            <span className="engine-label">
              {!working ? `Update to ${info.latest}` : progress?.stage === "download" ? `Downloading ${share ?? 0}%` : progress?.stage === "restarting" ? "Restarting…" : "Installing…"}
            </span>
          </motion.button>
        )}
      </AnimatePresence>
      {open && info && <UpdateDialog initial={info} onClose={() => setOpen(false)} onChange={setInfo} />}
    </>
  );
}

/** The update's progress: a bar with the share downloaded (and how many MB), then a moving bar while
    the new version installs. */
function UpdateProgress({ progress, info }: { progress: NonNullable<Progress>; info: UpdateInfo }) {
  if (progress.stage === "error") return <Notice level="error">{progress.message}</Notice>;
  const share = percent(progress);
  const total = info.asset?.size ?? null;
  const step = progress.stage === "download" ? "Downloading" : progress.stage === "restarting" ? "Restarting FlowLabs" : "Installing";
  return (
    <div className="update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share ?? undefined} aria-label={step}>
      <div className="row small">
        <strong>{step}</strong>
        <span className="dim">{progress.stage === "download" && share !== null && total ? `${((total * share) / 100 / 1024 ** 2).toFixed(1)} of ${(total / 1024 ** 2).toFixed(1)} MB` : progress.message}</span>
        <span className="spacer" />
        {share !== null && <span className="num">{share}%</span>}
      </div>
      {share !== null ? <Bar value={share / 100} /> : <div className="bar indeterminate"><span /></div>}
      <div className="update-steps small" aria-hidden>
        {["Download", "Install", "Restart"].map((label, i) => {
          const at = progress.stage === "download" ? 0 : progress.stage === "restarting" ? 2 : 1;
          return (
            <span key={label} className={i < at ? "done" : i === at ? "now" : ""}>
              {i < at ? <Icon name="check" size={11} /> : <span className="update-step-dot" />} {label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function UpdateDialog({ initial, onClose, onChange }: { initial: UpdateInfo; onClose: () => void; onChange?: (info: UpdateInfo) => void }) {
  const { engine, fail } = useApp();
  const [info, setInfo] = useState(initial);
  const [progress, setProgress] = useUpdateProgress();
  const [checkingNow, setCheckingNow] = useState(false);

  const recheck = async () => {
    setCheckingNow(true);
    try {
      const next = await check(engine, true)!;
      setInfo(next);
      onChange?.(next);
    } catch (error) {
      fail(error);
    } finally {
      setCheckingNow(false);
    }
  };
  const install = async () => {
    setProgress({ stage: "download", progress: 0, message: "Starting the download…" });
    try {
      await engine.updates!.install();
    } catch (error) {
      setProgress({ stage: "error", message: (error as Error).message });
    }
  };
  const automatic = async (on: boolean) => {
    try {
      await engine.updates!.setAutomatic(on);
      setInfo((i) => ({ ...i, enabled: on }));
    } catch (error) {
      fail(error);
    }
  };

  const working = progress !== null && progress.stage !== "error";
  const how: Record<UpdateInfo["method"], string> = {
    deb: "FlowLabs downloads the new .deb and installs it. Ubuntu asks for your password, then FlowLabs starts again.",
    macos: "FlowLabs downloads the new version, replaces itself and opens again.",
    windows: "FlowLabs downloads the new installer, which updates it and starts it again.",
    manual: "This copy of FlowLabs cannot replace itself. Download the new version from the release page.",
    pip: "This FlowLabs runs from its Python package. Install the new release's package the way you installed this one (Guide, Engines).",
  };
  return (
    <Modal
      title={working ? `Updating to FlowLabs ${info.latest}` : info.available ? `FlowLabs ${info.latest} is available` : "FlowLabs is up to date"}
      onClose={onClose}
      footer={
        <>
          <Switch on={info.enabled} onChange={(on) => void automatic(on)} label="Check for updates automatically" />
          <span className="spacer" />
          {!working && (
            <button onClick={() => void recheck()} disabled={checkingNow}>
              {checkingNow ? <Spinner /> : <Icon name="refresh" size={13} />} Check again
            </button>
          )}
          {info.available && info.can_install && (
            <button className="accent" onClick={() => void install()} disabled={working}>
              {working ? <Spinner /> : <Icon name="download" size={13} />} Install and restart
            </button>
          )}
          {info.available && !info.can_install && info.page && (
            <a className="button-link" href={info.page} target="_blank" rel="noreferrer">
              <button className="primary">
                <Icon name="external" size={13} /> Open the release page
              </button>
            </a>
          )}
        </>
      }
    >
      <p className="dim" style={{ marginBottom: 14 }}>
        You have {info.current}
        {info.available
          ? `. ${how[info.method]}`
          : info.pending
            ? `. FlowLabs ${info.latest} is being prepared for your system; check again in a few minutes.`
            : info.checked
              ? "."
              : `. ${info.error ?? "Checking is turned off."}`}
      </p>
      {progress && <UpdateProgress progress={progress} info={info} />}
      {working && <p className="faint small" style={{ marginBottom: 14 }}>You can close this window; the update button in the top bar shows how far it is.</p>}
      {info.available && info.notes && (
        <div className="update-notes">
          <Markdown text={info.notes} />
        </div>
      )}
    </Modal>
  );
}
