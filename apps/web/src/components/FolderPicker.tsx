import { useEffect, useRef, useState } from "react";
import { ApiError, type Api } from "../api";
import type { FolderListing } from "../types";
import { Icon } from "./Icon";

const LAST_FILE_KEY = "flowlab-last-file";

function remember(file: string): void {
  try {
    localStorage.setItem(LAST_FILE_KEY, file);
  } catch {
    /* only a convenience */
  }
}

function message(error: unknown): string {
  return error instanceof ApiError ? error.message : String(error);
}

/** Open any folder or .py/.ipynb file on this computer, like an editor's "Open Folder". */
export function FolderPicker({ api, onClose }: { api: Api; onClose: () => void }) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [typed, setTyped] = useState("");
  const [hidden, setHidden] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = (path: string | null, showHidden = hidden) => {
    setError(null);
    api
      .fsBrowse(path, showHidden)
      .then((next) => {
        setListing(next);
        setTyped(next.path);
      })
      .catch((e: unknown) => setError(message(e)));
  };

  useEffect(() => {
    load(null);
    api.fsRecent().then(setRecents).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function open(path: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.openProject(path);
      if (result.file) remember(result.file);
      window.location.reload();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.importFile(file.name, await file.text());
      remember(result.file);
      window.location.reload();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }

  const current = listing?.path ?? "";
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal folder-picker" role="dialog" aria-label="Open a folder or file" onMouseDown={(e) => e.stopPropagation()}>
        <header className="picker-head">
          <h2>Open folder or file</h2>
          <div className="spacer" />
          <button className="link-button" onClick={onClose} aria-label="Close">
            <Icon name="close" size={12} />
          </button>
        </header>
        <p className="dim small">
          Pick any folder on this computer. Its <code>.py</code> and <code>.ipynb</code> files open as graphs of blocks you can edit and run, and FlowLab
          keeps its run history in a <code>.flowlab/</code> folder there. Open now: <code>{listing?.root}</code>
        </p>
        <form
          className="picker-path"
          onSubmit={(e) => {
            e.preventDefault();
            load(typed.trim() || null);
          }}
        >
          <input className="mono" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Folder path" placeholder="/home/you/projects" />
          <button type="submit">Go</button>
        </form>
        <div className="button-row">
          <button disabled={!listing?.parent} onClick={() => listing?.parent && load(listing.parent)}>
            Up
          </button>
          <button disabled={!listing} onClick={() => listing && load(listing.home)}>
            ⌂ Home
          </button>
          <label className="toggle">
            <input
              type="checkbox"
              checked={hidden}
              onChange={(e) => {
                setHidden(e.target.checked);
                load(current || null, e.target.checked);
              }}
            />{" "}
            Show hidden
          </label>
        </div>
        {recents.length > 0 && (
          <div className="picker-recents">
            <span className="dim small">Recent</span>
            {recents.map((path) => (
              <button key={path} className="chip link mono" title={path} onClick={() => load(path)}>
                {path.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || path}
              </button>
            ))}
          </div>
        )}
        {error && <div className="error-box">{error}</div>}
        <ul className="picker-list" aria-label={`Contents of ${current}`}>
          {listing?.entries.map((entry) => (
            <li key={entry.path}>
              <button
                disabled={busy}
                onClick={() => (entry.kind === "dir" ? load(entry.path) : void open(entry.path))}
                title={entry.kind === "dir" ? "Show this folder" : "Open this file (its folder becomes the project)"}
              >
                <Icon name={entry.kind === "dir" ? "folder" : entry.name.endsWith(".ipynb") ? "notebook" : "file"} />
                <span className="file-name">{entry.name}</span>
                {entry.is_project && <span className="chip">project</span>}
              </button>
            </li>
          ))}
          {listing && listing.entries.length === 0 && <li className="dim small">No folders or Python/notebook files here.</li>}
          {listing?.truncated && <li className="dim small">Showing the first entries only.</li>}
        </ul>
        <footer className="picker-foot">
          <input
            ref={fileInput}
            type="file"
            accept=".py,.ipynb"
            hidden
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (picked) void importFile(picked);
            }}
          />
          <button disabled={busy} onClick={() => fileInput.current?.click()} title="Copy one .py or .ipynb file into this project's imported/ folder">
            <Icon name="file" /> Import a file…
          </button>
          <div className="spacer" />
          <span className="mono small dim picker-current" title={current}>
            {current}
          </span>
          <button className="primary" disabled={!listing || busy} onClick={() => void open(current)}>
            {busy ? "Opening…" : "Open this folder"}
          </button>
        </footer>
      </div>
    </div>
  );
}
