// Updates for the desktop app: a pill in the top bar when a new version is out, and a sheet that
// installs it and restarts FlowLabs.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { useApp } from "../context";
import type { Engine } from "../engine/engine";
import type { EngineEvent, UpdateInfo } from "../types";
import { Markdown } from "../pages/ExportTab";
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

export function UpdateButton() {
  const { engine } = useApp();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    check(engine)?.then((next) => live && setInfo(next), () => undefined);
    return () => {
      live = false;
    };
  }, [engine]);
  return (
    <>
      <AnimatePresence>
        {info?.available && (
          <motion.button
            className="update-pill"
            onClick={() => setOpen(true)}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            title={`FlowLabs ${info.latest} is available`}
          >
            <Icon name="download" size={13} /> <span className="engine-label">Update to {info.latest}</span>
          </motion.button>
        )}
      </AnimatePresence>
      {open && info && <UpdateDialog initial={info} onClose={() => setOpen(false)} onChange={setInfo} />}
    </>
  );
}

type Progress = { stage: string; progress?: number | null; message?: string } | null;

export function UpdateDialog({ initial, onClose, onChange }: { initial: UpdateInfo; onClose: () => void; onChange?: (info: UpdateInfo) => void }) {
  const { engine, fail } = useApp();
  const [info, setInfo] = useState(initial);
  const [progress, setProgress] = useState<Progress>(null);
  const [checkingNow, setCheckingNow] = useState(false);

  useEffect(
    () =>
      engine.subscribe((event: EngineEvent) => {
        if (event.type === "update") setProgress({ stage: event.stage, progress: event.progress, message: event.message });
      }),
    [engine],
  );

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
    pip: "This FlowLabs is a Python package. Update it with: pip install -U flowlabs",
  };
  return (
    <Modal
      title={info.available ? `FlowLabs ${info.latest} is available` : "FlowLabs is up to date"}
      onClose={working ? () => undefined : onClose}
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
        {info.available ? `. ${how[info.method]}` : info.checked ? "." : `. ${info.error ?? "Checking is turned off."}`}
      </p>
      {progress && (
        <div style={{ marginBottom: 16 }}>
          {progress.stage === "error" ? (
            <Notice level="error">{progress.message}</Notice>
          ) : (
            <>
              <div className="row small" style={{ marginBottom: 6 }}>
                <Spinner /> {progress.message}
              </div>
              <Bar value={progress.stage === "download" ? (progress.progress ?? 0) : 1} />
            </>
          )}
        </div>
      )}
      {info.available && info.notes && (
        <div className="update-notes">
          <Markdown text={info.notes} />
        </div>
      )}
    </Modal>
  );
}
